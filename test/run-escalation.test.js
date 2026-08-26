import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { applyRunOverrides, adminUnattendedTier, mayEscalate, runMessage, RUN_ORIGINS } = await import("../src/gateway/run.js");

// The privilege boundary of the HTTP run API. Its key is explicitly NOT an admin credential
// (src/web/auth.js), and the `author` it passes is a caller-supplied string — Slack user ids are
// public, so anyone holding the key could name a known admin. Two independent guards keep that
// from becoming an unsandboxed run: a per-request `mode` may never INTRODUCE adminMode, and an
// untrusted principal never escalates even if both other conditions hold.

test("a per-run mode override cannot introduce adminMode", () => {
  const channel = { adminMode: false, allowBash: false };
  const merged = applyRunOverrides(channel, { mode: "full" });
  assert.equal(merged.adminMode, false, "mode:full must not grant adminMode to a non-admin channel");
  assert.equal(merged.profile, "full", "the requested profile is still recorded");
});

test("a channel that is already adminMode keeps it through an override", () => {
  const merged = applyRunOverrides({ adminMode: true }, { mode: "full" });
  assert.equal(merged.adminMode, true);
});

test("capability-reducing overrides still apply in full", () => {
  const channel = { adminMode: true, allowBash: true, autoMode: true, cleanMode: false };
  const merged = applyRunOverrides(channel, { mode: "read" });
  assert.equal(merged.adminMode, false);
  assert.equal(merged.allowBash, false);
  assert.equal(merged.autoMode, false);

  const lean = applyRunOverrides(channel, { mode: "lean" });
  assert.equal(lean.cleanMode, true);
  assert.equal(lean.adminMode, false);
});

test("model/effort/engine overrides pass through; unknown engines are ignored", () => {
  const merged = applyRunOverrides({}, { model: "claude-sonnet-5", effort: "high", engine: "codex" });
  assert.equal(merged.model, "claude-sonnet-5");
  assert.equal(merged.effort, "high");
  assert.equal(merged.engine, "codex");
  assert.equal(applyRunOverrides({}, { engine: "definitely-not-an-engine" }).engine, undefined);
});

test("no overrides returns the meta untouched", () => {
  const meta = { adminMode: true };
  assert.equal(applyRunOverrides(meta, null), meta);
});

// ── Origin → escalation matrix (the 2026-08 update plan (internal repo) A2) ────────────────────────
// Escalation is derived from principal + origin, never from an optional boolean a call site can
// forget. Exactly one origin is escalatable: a live, watched, Slack-authenticated turn.
test("exhaustive origin matrix: only slack_foreground escalates, and only fully-privileged", () => {
  for (const origin of RUN_ORIGINS) {
    const expected = origin === "slack_foreground";
    assert.equal(
      mayEscalate({ meta: { adminMode: true }, isAdminAuthor: true, origin }),
      expected,
      `origin ${origin}: admin author in adminMode channel → ${expected ? "escalate" : "never escalate"}`,
    );
    // No origin escalates a partial privilege set.
    assert.equal(mayEscalate({ meta: { adminMode: false }, isAdminAuthor: true, origin }), false, `${origin}: no adminMode`);
    assert.equal(mayEscalate({ meta: { adminMode: true }, isAdminAuthor: false, origin }), false, `${origin}: not an admin`);
    assert.equal(mayEscalate({ meta: { adminMode: true }, isAdminAuthor: true, origin, untrustedPrincipal: true }), false, `${origin}: untrusted principal`);
  }
});

test("an unknown or missing origin fails closed, even fully privileged", () => {
  for (const origin of [undefined, "", "slack-foreground", "SLACK_FOREGROUND", "interactive", 42]) {
    assert.equal(mayEscalate({ meta: { adminMode: true }, isAdminAuthor: true, origin }), false, `origin ${JSON.stringify(origin)}`);
  }
});

test("mayEscalate fails closed on an empty call", () => {
  assert.equal(mayEscalate(), false);
});

test("runMessage refuses to run at all without a valid origin", async () => {
  // Fail closed before channel lookup: a caller that forgot its origin is a programming error,
  // not a default-to-interactive run.
  await assert.rejects(() => runMessage({ channelId: "C-any", text: "hi", threadKey: "t" }), /requires a valid origin/);
  await assert.rejects(() => runMessage({ channelId: "C-any", text: "hi", threadKey: "t", origin: "nope" }), /requires a valid origin/);
});

test("every runMessage call site in src/ declares an inline origin", async () => {
  // Architecture tripwire: the compile-time guarantee A2 wants (a required parameter) doesn't
  // exist in JS, so pin it here. The old version scanned a fixed six-file list and passed if a
  // file contained ANY origin literal anywhere — a caller in an unlisted file, or a second
  // origin-less call in a listed one, sailed through. Now: sweep ALL of src/, and require an
  // origin literal (or the recovery ternary) within each runMessage call expression itself.
  const { readFile, readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = new URL("../src/", import.meta.url);
  const files = [];
  async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir.pathname ? dir.pathname : dir, item.name);
      if (item.isDirectory()) await walk(child);
      else if (item.name.endsWith(".js")) files.push(child);
    }
  }
  await walk(root.pathname);
  const originRe = /origin(?::| =)\s*(?:"(?:slack_foreground|api_foreground|schedule|background_agent|continuation|recovery|diagnosis)"|[a-zA-Z_$][\w$]*\s*\?\s*"(?:recovery|continuation)")/;
  let callSites = 0;
  for (const f of files) {
    const src = await readFile(f, "utf8");
    let idx = 0;
    for (;;) {
      const at = src.indexOf("runMessage({", idx);
      if (at === -1) break;
      // Skip the function DEFINITION (and any re-export of it) — only call sites carry origins.
      if (/function\s$/.test(src.slice(Math.max(0, at - 20), at))) {
        idx = at + 1;
        continue;
      }
      callSites += 1;
      // The origin must appear inside THIS call's argument window (the next ~2500 chars is
      // generous for the biggest call site while never reaching a sibling call's origin). A call
      // that reuses a prior call's FULL argument object (`runMessage({ ...runArgs`) inherits the
      // origin that object already declared — its construction site is checked on its own.
      const windowText = src.slice(at, Math.min(src.length, at + 2500));
      if (/^runMessage\(\{\s*\.\.\.(runArgs|args)\b/.test(windowText)) {
        idx = at + 1;
        continue;
      }
      assert.match(windowText, originRe, `${f}: runMessage call at index ${at} must declare its origin inline`);
      idx = at + 1;
    }
  }
  assert.ok(callSites >= 5, `expected to find the known runMessage call sites, found ${callSites}`);
});

// ── Admin outranks auto (owner decision, 2026-08-08) ────────────────────────────
// A daemon-origin run launched by an admin in an adminMode channel is upgraded to the AUTO tier
// (writable sandbox + auto-approved prompts) instead of the read floor — it is a tier, never an
// escalation: the bypass stays foreground-only, and every distrust signal disqualifies.
test("adminUnattendedTier: admin author in an adminMode channel qualifies; every distrust signal disqualifies", () => {
  const qualifying = { meta: { adminMode: true }, isAdminAuthor: true, untrustedPrincipal: false, dangerouslySkip: false };
  assert.equal(adminUnattendedTier(qualifying), true);

  // An escalated run is already above the tier — the flag must not double-fire.
  assert.equal(adminUnattendedTier({ ...qualifying, dangerouslySkip: true }), false);
  // Non-admin author in the same admin channel stays at the read floor.
  assert.equal(adminUnattendedTier({ ...qualifying, isAdminAuthor: false }), false);
  // The HTTP run API's caller-supplied author never inherits the tier.
  assert.equal(adminUnattendedTier({ ...qualifying, untrustedPrincipal: true }), false);
  // Non-admin channels are governed by their own flags, not this tier.
  assert.equal(adminUnattendedTier({ ...qualifying, meta: { adminMode: false } }), false);
  assert.equal(adminUnattendedTier(), false);
});
