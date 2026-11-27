// A sign-in license an administrator ADDED lapses like the gateway's own Claude login, and has to
// reach an admin the same way (src/gateway/login-watch.js, `licenseLoginWatchTick`).
//
// The properties that matter: every admin is told ONCE per license per problem (a gateway can hold
// dozens of seats — no daily repeat), a recovered license is news again when it next lapses, a
// tick nobody heard stays due, and nothing but names, dates and the sign-in command is ever said.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { classifyLicenseLogin, licenseAlertText, licenseLoginWatchTick, startClaudeLoginWatch, LICENSE_LOGIN_ALERT_META_KEY } = await import("../src/gateway/login-watch.js");
const { saveSettings } = await import("../src/config/settings.js");
const store = await import("../src/config/engine-licenses.js");
const { licenseLoginHome } = await import("../src/engines/license-state.js");
const { metaGet, metaSet } = await import("../src/db/index.js");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);

const CODEX = { id: "codex-lic-0000aaaa", kind: "codex-login", label: "Seat A", createdAt: new Date(NOW - 30 * DAY).toISOString() };
const CLAUDE = { id: "claude-lic-0000bbbb", kind: "claude-login", label: "Work Claude", createdAt: new Date(NOW - 30 * DAY).toISOString() };
const SERVER = { id: "claude-api-0000cccc", kind: "claude-api", label: "Team server", createdAt: new Date(NOW - 30 * DAY).toISOString() };

// One tick over injected records and states; the mark lives in the returned box.
function harness({ records = [CODEX, CLAUDE, SERVER], states = {}, enabled = () => true, admins = ["UADMIN1", "UADMIN2"], deliver = null } = {}) {
  const box = { mark: "", sent: [], warnings: [], states, records, clock: NOW };
  box.tick = (extra = {}) => licenseLoginWatchTick({
    now: () => box.clock,
    log: { warn: (line) => box.warnings.push(line) },
    admins: async () => admins,
    notify: deliver || (async (message) => { box.sent.push(message); }),
    licenseRecords: () => box.records,
    licenseStatus: async (id) => {
      const state = box.states[id];
      if (state instanceof Error) throw state;
      return state || { ready: true, signedIn: true };
    },
    licenseEnabled: enabled,
    readLicenseMarks: () => box.mark,
    writeLicenseMarks: (value) => { box.mark = value; },
    ...extra,
  });
  return box;
}

test("a sign-in is missing when it is not signed in, and expiring only inside the warning window", () => {
  assert.equal(classifyLicenseLogin({ signedIn: false }, { now: NOW }), "missing");
  assert.equal(classifyLicenseLogin(null, { now: NOW }), "missing");
  assert.equal(classifyLicenseLogin({ signedIn: true }, { now: NOW }), "", "a ChatGPT sign-in carries no expiry");
  assert.equal(classifyLicenseLogin({ signedIn: true, expiresAt: NOW + 20 * DAY }, { now: NOW }), "");
  assert.equal(classifyLicenseLogin({ signedIn: true, expiresAt: NOW + 2 * DAY }, { now: NOW }), "expiring");
  assert.equal(classifyLicenseLogin({ signedIn: true, expiresAt: NOW - HOUR }, { now: NOW }), "missing");
});

test("every admin is told once per license per problem, in one message", async () => {
  const box = harness({ states: { [CODEX.id]: { signedIn: false }, [CLAUDE.id]: { signedIn: true, expiresAt: NOW + 40 * HOUR } } });
  const first = await box.tick();
  assert.equal(first.notified, true);
  assert.equal(first.fresh, 2);
  assert.deepEqual(box.sent.map((message) => message.userId), ["UADMIN1", "UADMIN2"], "one message per admin, not one per license");
  assert.match(box.sent[0].text, /2 sign-in licenses need a new sign-in/);
  assert.match(box.sent[0].text, /Seat A\* — not signed in/);
  assert.match(box.sent[0].text, /Work Claude\* — its sign-in expires in 40h \(`2026-11-24 04:00 UTC`/);
  assert.match(box.sent[0].text, /CODEX_HOME='[^']+' codex .* login --device-auth/, "the sign-in command for that license");
  assert.match(box.sent[0].text, /CLAUDE_CONFIG_DIR='[^']+' claude/);
  assert.ok(!box.sent[0].text.includes("Team server"), "a license with a key has no sign-in to lapse");
  assert.deepEqual(JSON.parse(box.mark), { [CODEX.id]: "missing", [CLAUDE.id]: "expiring" });

  // The next hours — and the next days — say nothing new.
  for (const later of [HOUR, 5 * HOUR, 30 * HOUR]) {
    box.clock = NOW + later;
    const again = await box.tick();
    assert.equal(again.notified, false);
    assert.equal(again.problems.length, 2, "the state is still reported to the caller");
  }
  assert.equal(box.sent.length, 2, "no daily repeat");
  assert.ok(box.warnings.filter((line) => /\[license-login\] WARNING/.test(line)).length >= 8, "the log line is written on every tick");

  // The expiring sign-in lapses: that is a new problem for that license only.
  box.clock = NOW + 41 * HOUR;
  box.states[CLAUDE.id] = { signedIn: false };
  const lapsed = await box.tick();
  assert.equal(lapsed.fresh, 1);
  assert.equal(box.sent.length, 4);
  assert.match(box.sent[3].text, /2 sign-in licenses need a new sign-in/, "the message still lists everything in trouble");
  assert.ok(box.sent[3].text.indexOf("Work Claude") < box.sent[3].text.indexOf("Seat A"), "the newly reported license first");
  assert.deepEqual(box.sent[3].licenses, [CLAUDE.id]);
});

test("a recovered, switched-off or deleted license is forgotten, so its next lapse is news", async () => {
  const off = new Set();
  const box = harness({ states: { [CODEX.id]: { signedIn: false }, [CLAUDE.id]: { signedIn: false } }, enabled: (id) => !off.has(id) });
  await box.tick();
  assert.equal(box.sent.length, 2);
  box.states[CODEX.id] = { signedIn: true };
  off.add(CLAUDE.id);
  const healthy = await box.tick();
  assert.deepEqual(healthy.problems, []);
  assert.equal(box.mark, "", "nothing left to remember");
  box.states[CODEX.id] = { signedIn: false };
  const again = await box.tick();
  assert.equal(again.fresh, 1);
  assert.equal(box.sent.length, 4);
  assert.match(box.sent[3].text, /a sign-in license needs a new sign-in/);
  box.records = [CLAUDE];
  await box.tick();
  assert.equal(box.mark, "", "a deleted license leaves the marker");
});

test("a license somebody just added is not reported before they had the chance to sign in", async () => {
  const fresh = { ...CODEX, createdAt: new Date(NOW - 10 * 60_000).toISOString() };
  const box = harness({ records: [fresh], states: { [CODEX.id]: { signedIn: false } } });
  assert.equal((await box.tick()).notified, false);
  assert.equal(box.sent.length, 0);
  box.clock = NOW + 2 * HOUR;
  assert.equal((await box.tick()).notified, true, "still unsigned an hour on: now it is worth a message");
});

test("a tick nobody heard stays due, and an unreadable license keeps what was already said", async () => {
  let reachable = false;
  const sent = [];
  const box = harness({
    records: [CODEX, CLAUDE],
    states: { [CODEX.id]: { signedIn: false } },
    deliver: async (message) => { if (!reachable) throw new Error("Slack is not connected"); sent.push(message); },
  });
  const silent = await box.tick();
  assert.equal(silent.notified, false);
  assert.equal(box.mark, "", "not marked as told");
  reachable = true;
  assert.equal((await box.tick()).notified, true);
  assert.equal(sent.length, 2);
  // The check itself failing is not a recovery: no second message when it reads again.
  box.states[CODEX.id] = new Error("EIO");
  assert.equal((await box.tick()).notified, false);
  assert.deepEqual(JSON.parse(box.mark), { [CODEX.id]: "missing" });
  box.states[CODEX.id] = { signedIn: false };
  assert.equal((await box.tick()).notified, false);
  assert.equal(sent.length, 2);
});

test("the message carries names, dates and commands only", () => {
  const text = licenseAlertText({ now: NOW, problems: [{ id: CLAUDE.id, name: "Claude Code · Work Claude", alertClass: "expiring", expiresAt: NOW + 5 * HOUR, command: "CLAUDE_CONFIG_DIR='/x' claude" }] });
  assert.match(text, /a sign-in license needs a new sign-in/);
  assert.match(text, /expires in 5h/);
  assert.match(text, /no restart needed/);
  assert.ok(!/token|fingerprint/i.test(text));
});

test("the real store: an added ChatGPT seat and an added Claude seat are watched through their own directories", async () => {
  saveSettings({ engineLicenses: [], engine: "claude", enginePool: "", engineEnabled: { claude: true, codex: true } });
  metaSet(LICENSE_LOGIN_ALERT_META_KEY, "");
  const seat = store.createLicense({ kind: "codex-login", label: "Watch seat", type: "business" });
  const work = store.createLicense({ kind: "claude-login", label: "Watch Claude", type: "subscription" });
  const server = store.createLicense({ kind: "claude-api", label: "Watch server", type: "api", baseUrl: "https://llm.example.com/v1", apiKey: "fixture-license-watch-key", authScheme: "bearer", models: ["team-large"] });
  saveSettings({ engineEnabled: { claude: true, codex: true, [seat.id]: true, [work.id]: true, [server.id]: true } });
  const sent = [];
  const opts = { now: () => Date.now(), log: { warn() {} }, admins: async () => ["UADMIN_DB"], notify: async (message) => { sent.push(message); }, graceMs: 0 };
  try {
    // The Claude seat is signed in and lapses in two days; the ChatGPT seat was never signed in.
    mkdirSync(licenseLoginHome(work.id), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(licenseLoginHome(work.id), ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-access", expiresAt: Date.now() + 4 * HOUR, refreshTokenExpiresAt: Date.now() + 2 * DAY, subscriptionType: "pro" } }), { mode: 0o600 });
    const status = await store.licenseStatusFor(work.id);
    assert.equal(status.signedIn, true);
    assert.ok(status.expiresAt > Date.now(), "a Claude sign-in license reports when its sign-in lapses");
    assert.equal(status.fingerprint, undefined);

    const first = await licenseLoginWatchTick(opts);
    assert.deepEqual(first.problems.map((problem) => problem.alertClass).sort(), ["expiring", "missing"]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Codex · Watch seat\* — not signed in/);
    assert.match(sent[0].text, /Claude Code · Watch Claude\* — its sign-in expires in 48h/);
    assert.ok(sent[0].text.includes(licenseLoginHome(seat.id)), "the command names that license's own directory");
    assert.ok(!sent[0].text.includes("fixture-access"), "never token material");
    assert.ok(!sent[0].text.includes("Watch server"));
    assert.deepEqual(JSON.parse(metaGet(LICENSE_LOGIN_ALERT_META_KEY)), { [seat.id]: "missing", [work.id]: "expiring" }, "remembered in the database, so a restart does not repeat it");

    assert.equal((await licenseLoginWatchTick(opts)).notified, false);
    // The whole watch runs both halves and survives a restart without repeating itself.
    const handle = startClaudeLoginWatch({ ...opts, resolve: () => ({ kind: "operator", expiresAt: Date.now() + 20 * DAY }), readMark: () => "", writeMark() {}, firstDelayMs: 60_000, log: { warn() {}, log() {} } });
    try {
      const both = await handle.tick();
      assert.equal(both.alertClass, "", "the gateway's own login is healthy");
      assert.equal(both.licenses.problems.length, 2);
      assert.equal(both.licenses.notified, false);
    } finally { handle.stop(); }
    assert.equal(sent.length, 1);

    // Signing in again clears it.
    writeFileSync(path.join(licenseLoginHome(work.id), ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-access", expiresAt: Date.now() + 4 * HOUR, refreshTokenExpiresAt: Date.now() + 25 * DAY, subscriptionType: "pro" } }), { mode: 0o600 });
    const after = await licenseLoginWatchTick(opts);
    assert.deepEqual(after.problems.map((problem) => problem.id), [seat.id]);
    assert.deepEqual(JSON.parse(metaGet(LICENSE_LOGIN_ALERT_META_KEY)), { [seat.id]: "missing" });
  } finally {
    rmSync(licenseLoginHome(work.id), { recursive: true, force: true });
    for (const record of [seat, work, server]) await store.deleteLicense(record.id).catch(() => {});
    metaSet(LICENSE_LOGIN_ALERT_META_KEY, "");
  }
});
