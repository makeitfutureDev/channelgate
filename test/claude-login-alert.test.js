// The Claude login expiry has to reach an admin WITHOUT a restart (src/gateway/login-watch.js).
//
// The property that matters: an hourly watch that DMs every admin once per UTC day per message
// class, remembered in `_meta` so a restarted daemon cannot turn the reminder into a spam loop —
// and that never carries token material into a Slack DM.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const watch = await import("../src/gateway/login-watch.js");
const {
  decideLoginAlert,
  formatAlertMark,
  utcDayKey,
  classifyLogin,
  loginAlertText,
  claudeLoginWatchTick,
  startClaudeLoginWatch,
  CLAUDE_LOGIN_ALERT_META_KEY,
} = watch;
const { setUser } = await import("../src/config/store.js");
const { metaGet, metaSet } = await import("../src/db/index.js");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0); // 2026-09-02T12:00:00Z
const DAY_KEY = "2026-09-02";

// A resolved login record shaped exactly like resolveClaudeLogin's, carrying a fingerprint that
// must never appear in anything the watch says out loud.
const FINGERPRINT = "deadbeefcafebabe";
function operatorLogin(expiresAt) {
  return {
    kind: "operator",
    file: "/home/op/.claude/.credentials.json",
    configDir: "/home/op/.claude",
    home: "/home/op",
    accessExpiresAt: NOW + 4 * HOUR,
    expiresAt,
    fingerprint: FINGERPRINT,
    detail: "the host user's own Claude Code login (/home/op/.claude/.credentials.json)",
    reason: "",
  };
}
const MISSING_REASON =
  "the gateway has no usable Claude login — sign in with `claude` on the gateway host as op " +
  "(its ~/.claude login is what the gateway uses), or paste a `claude setup-token` value in " +
  "Settings → Container runtime, or set ANTHROPIC_API_KEY for the daemon " +
  "(checked /home/op/.claude/.credentials.json (absent))";
const missingLogin = () => ({
  kind: "none", file: "", configDir: "", home: "", accessExpiresAt: 0, expiresAt: 0,
  fingerprint: "", detail: MISSING_REASON, reason: MISSING_REASON,
});

// An in-memory stand-in for the `_meta` marker (the durable one is exercised separately below).
function markStore(initial = "") {
  let value = initial;
  return { readMark: () => value, writeMark: (v) => { value = v; }, get: () => value };
}

function recorder() {
  const calls = [];
  const log = { warn: (m) => calls.push(["warn", m]), error: (m) => calls.push(["error", m]), log: (m) => calls.push(["log", m]) };
  return { log, calls, warnings: () => calls.filter(([k]) => k === "warn").map(([, m]) => m) };
}

// ── The per-day decision (pure) ───────────────────────────────────────────────────────────────

test("the same class on the same UTC day is not a second DM", () => {
  const mark = formatAlertMark("expiring", DAY_KEY);
  assert.deepEqual(decideLoginAlert({ mark, alertClass: "expiring", day: DAY_KEY }), { send: false, mark });
});

test("the next UTC day notifies again", () => {
  const mark = formatAlertMark("expiring", DAY_KEY);
  assert.deepEqual(decideLoginAlert({ mark, alertClass: "expiring", day: "2026-09-03" }), {
    send: true,
    mark: "expiring:2026-09-03",
  });
});

test("a class change notifies even on a day already marked", () => {
  const mark = formatAlertMark("expiring", DAY_KEY);
  assert.deepEqual(decideLoginAlert({ mark, alertClass: "missing", day: DAY_KEY }), {
    send: true,
    mark: `missing:${DAY_KEY}`,
  });
});

test("a healthy login sends nothing and clears the stored class", () => {
  assert.deepEqual(decideLoginAlert({ mark: `expiring:${DAY_KEY}`, alertClass: "", day: DAY_KEY }), { send: false, mark: "" });
  assert.equal(utcDayKey(NOW), DAY_KEY);
  assert.equal(formatAlertMark("", DAY_KEY), "");
});

test("classifyLogin: inside the window is expiring, kind none is missing, healthy is neither", () => {
  assert.equal(classifyLogin(operatorLogin(NOW + 2 * DAY), { now: NOW }).alertClass, "expiring");
  assert.equal(classifyLogin(operatorLogin(NOW - HOUR), { now: NOW }).alertClass, "expiring"); // already dead on disk
  assert.equal(classifyLogin(missingLogin(), { now: NOW }).alertClass, "missing");
  assert.equal(classifyLogin(missingLogin(), { now: NOW }).warning, MISSING_REASON);
  assert.equal(classifyLogin(operatorLogin(NOW + 20 * DAY), { now: NOW }).alertClass, "");
  // A setup-token / API-key login has no expiry at all and must never raise an alert.
  assert.equal(classifyLogin({ kind: "api-key", expiresAt: 0 }, { now: NOW }).alertClass, "");
});

// ── The DM body ───────────────────────────────────────────────────────────────────────────────

test("the DM names the login, the UTC expiry and the remedy — and no token material", () => {
  const login = operatorLogin(NOW + 2 * DAY);
  const text = loginAlertText({ login, alertClass: "expiring", now: NOW });
  assert.match(text, /operator/);
  assert.match(text, /\/home\/op\/\.claude/);
  assert.match(text, /2026-09-04 12:00 UTC/);
  assert.match(text, /sign in with `claude` on the gateway host/);
  assert.match(text, /no restart needed/i);
  assert.doesNotMatch(text, new RegExp(FINGERPRINT));
  assert.doesNotMatch(text, /accessToken|refreshToken|sk-ant/);
});

test("an already-expired login says so, and a missing one carries the resolver's remedy", () => {
  assert.match(loginAlertText({ login: operatorLogin(NOW - HOUR), alertClass: "expiring", now: NOW }), /EXPIRED/);
  const missing = loginAlertText({ login: missingLogin(), alertClass: "missing", warning: MISSING_REASON, now: NOW });
  assert.match(missing, /no usable Claude login/);
  assert.match(missing, /ANTHROPIC_API_KEY/); // the resolver's own remedy list, verbatim
  assert.doesNotMatch(missing, /undefined/);
});

// ── The watcher (injected clock / resolver / notify / marker) ─────────────────────────────────

test("an expiring login DMs every admin once, then stays quiet until the next UTC day", async () => {
  const store = markStore();
  const rec = recorder();
  const sent = [];
  let clock = NOW;
  const opts = {
    now: () => clock,
    log: rec.log,
    resolve: () => operatorLogin(NOW + 2 * DAY),
    admins: async () => ["UADMIN1", "UADMIN2"],
    notify: async ({ userId, text }) => { sent.push({ userId, text }); },
    ...store,
  };

  const first = await claudeLoginWatchTick(opts);
  assert.equal(first.alertClass, "expiring");
  assert.equal(first.notified, true);
  assert.deepEqual(sent.map((s) => s.userId), ["UADMIN1", "UADMIN2"]);
  assert.match(sent[0].text, /expires in 48h/);
  assert.equal(sent[0].text, sent[1].text);
  assert.equal(store.get(), `expiring:${DAY_KEY}`);
  assert.ok(rec.warnings().some((m) => /\[claude-login\] WARNING: .*expires in 48h/.test(m)));

  // Same day, an hour later: the log line repeats, the DM does not.
  clock = NOW + HOUR;
  const second = await claudeLoginWatchTick(opts);
  assert.equal(second.notified, false);
  assert.equal(sent.length, 2);
  assert.equal(rec.warnings().filter((m) => /WARNING/.test(m)).length, 2);

  // Next UTC day: news again.
  clock = NOW + DAY;
  const third = await claudeLoginWatchTick(opts);
  assert.equal(third.notified, true);
  assert.deepEqual(sent.slice(2).map((s) => s.userId), ["UADMIN1", "UADMIN2"]);
  assert.equal(store.get(), "expiring:2026-09-03");
});

test("a missing login uses the resolver's reason, and a healthy one resets the class", async () => {
  const store = markStore();
  const rec = recorder();
  const sent = [];
  let login = missingLogin();
  const opts = {
    now: () => NOW,
    log: rec.log,
    resolve: () => login,
    admins: async () => ["UADMIN1"],
    notify: async (r) => { sent.push(r); },
    ...store,
  };

  await claudeLoginWatchTick(opts);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /no usable Claude login/);
  assert.match(sent[0].text, /Settings → Container runtime/); // straight from resolveClaudeLogin's reason
  assert.equal(store.get(), `missing:${DAY_KEY}`);

  // The class CHANGES on the same day (a stale login file appears, three days out) → news.
  login = operatorLogin(NOW + 2 * DAY);
  await claudeLoginWatchTick(opts);
  assert.equal(sent.length, 2);
  assert.equal(store.get(), `expiring:${DAY_KEY}`);

  // Signed in again: nothing said, and the marker is cleared so a later expiry notifies afresh.
  login = operatorLogin(NOW + 25 * DAY);
  const healthy = await claudeLoginWatchTick(opts);
  assert.equal(healthy.alertClass, "");
  assert.equal(healthy.reset, true);
  assert.equal(sent.length, 2);
  assert.equal(store.get(), "");

  login = operatorLogin(NOW + 2 * DAY);
  await claudeLoginWatchTick(opts);
  assert.equal(sent.length, 3);
});

test("a notify failure for one admin does not stop the others", async () => {
  const store = markStore();
  const rec = recorder();
  const sent = [];
  const opts = {
    now: () => NOW,
    log: rec.log,
    resolve: () => operatorLogin(NOW + 2 * DAY),
    admins: async () => ["UBROKEN", "UOK1", "UOK2"],
    notify: async ({ userId }) => {
      if (userId === "UBROKEN") throw new Error("channel_not_found");
      sent.push(userId);
    },
    ...store,
  };
  const result = await claudeLoginWatchTick(opts);
  assert.deepEqual(sent, ["UOK1", "UOK2"]);
  assert.equal(result.sent, 2);
  assert.equal(result.recipients, 3);
  assert.ok(rec.warnings().some((m) => /could not DM admin UBROKEN — channel_not_found/.test(m)));
  assert.equal(store.get(), `expiring:${DAY_KEY}`); // the two who heard it are not re-spammed
});

test("a tick that reaches nobody stays due and retries", async () => {
  const store = markStore();
  const rec = recorder();
  let connected = false;
  const sent = [];
  const opts = {
    now: () => NOW,
    log: rec.log,
    resolve: () => operatorLogin(NOW + 2 * DAY),
    admins: async () => ["UADMIN1"],
    notify: async ({ userId }) => {
      if (!connected) throw new Error("Slack is not connected");
      sent.push(userId);
    },
    ...store,
  };
  const down = await claudeLoginWatchTick(opts);
  assert.equal(down.notified, false);
  assert.equal(store.get(), ""); // nothing marked — the day is still owed an alert
  connected = true;
  const up = await claudeLoginWatchTick(opts);
  assert.equal(up.notified, true);
  assert.deepEqual(sent, ["UADMIN1"]);
  assert.equal(store.get(), `expiring:${DAY_KEY}`);
});

test("a resolver that throws is logged, never thrown out of the tick", async () => {
  const rec = recorder();
  const result = await claudeLoginWatchTick({
    now: () => NOW,
    log: rec.log,
    resolve: () => { throw new Error("disk on fire"); },
    admins: async () => ["UADMIN1"],
    notify: async () => { throw new Error("should not be reached"); },
    ...markStore(),
  });
  assert.equal(result.alertClass, "");
  assert.ok(rec.warnings().some((m) => /could not resolve the login: disk on fire/.test(m)));
});

// ── Durable `_meta` marker: a restart must not re-spam ────────────────────────────────────────

test("the marker survives a simulated restart, and admins come from the store", async () => {
  metaSet(CLAUDE_LOGIN_ALERT_META_KEY, ""); // clean slate for the shared scratch DB
  await setUser("UADMIN_DB", { name: "Ops", isAdmin: true, approved: true });
  await setUser("UPLAIN_DB", { name: "Member", isAdmin: false, approved: true });

  const sent = [];
  // No readMark/writeMark and no admins: the real `_meta` helpers and the real user store.
  const opts = {
    now: () => NOW,
    log: recorder().log,
    resolve: () => operatorLogin(NOW + 2 * DAY),
    notify: async ({ userId }) => { sent.push(userId); },
  };

  await claudeLoginWatchTick(opts);
  assert.deepEqual(sent, ["UADMIN_DB"]); // the non-admin is not DM'd
  assert.equal(metaGet(CLAUDE_LOGIN_ALERT_META_KEY), `expiring:${DAY_KEY}`);

  // "Restart": a brand-new watcher with no process memory reads the same durable marker.
  const restarted = startClaudeLoginWatch({ ...opts, firstDelayMs: 60_000 });
  const after = await restarted.tick();
  restarted.stop();
  assert.equal(after.notified, false);
  assert.deepEqual(sent, ["UADMIN_DB"]);
  assert.equal(metaGet(CLAUDE_LOGIN_ALERT_META_KEY), `expiring:${DAY_KEY}`);
});

test("startClaudeLoginWatch defers the first pass and stop() cancels it", async () => {
  const rec = recorder();
  let ticks = 0;
  const handle = startClaudeLoginWatch({
    firstDelayMs: 5,
    intervalMs: 5,
    log: rec.log,
    now: () => NOW,
    resolve: () => { ticks += 1; return operatorLogin(NOW + 25 * DAY); },
    admins: async () => [],
    notify: async () => {},
    ...markStore(),
  });
  assert.equal(ticks, 0); // nothing runs at boot — Slack has not connected yet
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(ticks >= 1);
  handle.stop();
  const settled = ticks;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ticks, settled); // stopped means stopped
});
