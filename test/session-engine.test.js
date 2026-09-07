// Guards the mid-thread harness rules (src/gateway/run.js + src/gateway/sessions.js). A thread's
// session id is engine-specific — Claude mints a UUID, Codex mints its own thread_id, and neither
// can resume the other's — so a cross-engine resume is never attempted. The contract: an existing
// thread STICKS to the engine that owns its session even when the channel/global harness changes;
// only an explicit per-thread/per-run ask switches it (fresh session under the new engine). We
// can't drive runMessage end-to-end without spawning an engine, so we lock in the pieces the
// behavior depends on: decideThreadEngine (the sticky-vs-switch decision), sessions.js recording +
// returning the owning engine (so the mismatch is detectable), and isSessionNotFound recognizing
// Claude's non-UUID resume rejection (the safety net for legacy rows).
// ensureTestEnv() runs before importing src so the lazy DB opens the scratch file, never the real dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { resolveSession, resetSession, saveSession, getSessionMap } = await import("../src/gateway/sessions.js");
const { isSessionNotFound, decideThreadEngine } = await import("../src/gateway/run.js");

test("a channel/global harness change does NOT switch an existing thread — it sticks", () => {
  // Thread born on codex; the channel later flips to claude. The turn keeps running on codex.
  const picked = decideThreadEngine({ requested: "claude", sessionEngine: "codex", isNew: false, explicit: false });
  assert.deepEqual(picked, { engine: "codex", switch: false });
  // And the mirror image (claude-born thread, channel flipped to codex).
  assert.deepEqual(decideThreadEngine({ requested: "codex", sessionEngine: "claude", isNew: false, explicit: false }), { engine: "claude", switch: false });
});

test("an explicit per-thread/per-run ask DOES switch an existing thread (fresh session)", () => {
  const picked = decideThreadEngine({ requested: "claude", sessionEngine: "codex", isNew: false, explicit: true });
  assert.deepEqual(picked, { engine: "claude", switch: true });
});

test("new, unlabeled, and matching sessions never trigger a switch", () => {
  // Brand-new thread: nothing to stick to — the requested engine wins.
  assert.deepEqual(decideThreadEngine({ requested: "claude", sessionEngine: "claude", isNew: true, explicit: false }), { engine: "claude", switch: false });
  // Pre-v4 row (no engine stamp): treated as a match, left to the resume-not-found safety net.
  assert.deepEqual(decideThreadEngine({ requested: "codex", sessionEngine: "", isNew: false, explicit: false }), { engine: "codex", switch: false });
  // Owning engine already matches — explicit or not, nothing changes.
  assert.deepEqual(decideThreadEngine({ requested: "codex", sessionEngine: "codex", isNew: false, explicit: true }), { engine: "codex", switch: false });
});

test("resolveSession stamps the engine on a new thread and echoes it back", async () => {
  const slug = "eng-new";
  const first = await resolveSession(slug, "t1", "codex");
  assert.equal(first.isNew, true);
  assert.equal(first.engine, "codex");
  // A reply resolves the SAME session and reports the owning engine (codex), not a re-mint.
  const reply = await resolveSession(slug, "t1", "codex");
  assert.equal(reply.isNew, false);
  assert.equal(reply.sessionId, first.sessionId);
  assert.equal(reply.engine, "codex");
});

test("resolveSession surfaces a DIFFERENT owning engine when the effective engine flips", async () => {
  const slug = "eng-switch";
  const started = await resolveSession(slug, "t1", "claude"); // thread born on Claude
  // Later turn requests codex — the row still reports claude, so the caller (runMessage) can
  // detect the mismatch and either stick to claude (default) or reset (explicit ask).
  const afterSwitch = await resolveSession(slug, "t1", "codex");
  assert.equal(afterSwitch.isNew, false);
  assert.equal(afterSwitch.engine, "claude");
  assert.notEqual(afterSwitch.engine, "codex");
  // resetSession mints a fresh id stamped with the NEW engine; the next resolve reports codex.
  const freshId = await resetSession(slug, "t1", "codex");
  assert.notEqual(freshId, started.sessionId);
  const resumed = await resolveSession(slug, "t1", "codex");
  assert.equal(resumed.sessionId, freshId);
  assert.equal(resumed.engine, "codex");
});

test("a pre-v4/legacy row (no engine stamp) reports '' and is back-fillable", async () => {
  const slug = "eng-legacy";
  // Simulate a row written before the engine column existed: resolve with no engine, then confirm
  // it reads back as unlabeled — this is the "" the run.js back-fill keys on.
  await resolveSession(slug, "t1", ""); // engine unknown
  const seen = await resolveSession(slug, "t1", "");
  assert.equal(seen.engine, "");
  // saveSession back-fills the owning engine (the run.js post-success stamp).
  const map = await getSessionMap(slug);
  await saveSession(slug, "t1", map.t1, "claude");
  const labeled = await resolveSession(slug, "t1", "claude");
  assert.equal(labeled.engine, "claude");
});

test("isSessionNotFound matches Claude's non-UUID resume rejection (Codex id → claude -r)", () => {
  // A Codex thread_id fed to `claude -r` after a harness switch: Claude exits 1 with this on stderr.
  const err = {
    message: "Claude failed because it reported a general error.",
    details: { stderr: 'Error: --resume requires a valid session ID or session title when used with --print. Provided value "0199abcd-not-a-real-codex-thread" is not a UUID and does not match any session title.' },
  };
  assert.equal(isSessionNotFound(err), true);
});

test("isSessionNotFound still matches the classic missing-session + codex-rollout wordings", () => {
  assert.equal(isSessionNotFound({ details: { stderr: "No conversation found with session ID: abc" } }), true);
  assert.equal(isSessionNotFound({ message: "no rollout found for thread id xyz" }), true);
  // A plain unrelated failure must NOT trigger a reset.
  assert.equal(isSessionNotFound({ message: "network error", details: { stderr: "ECONNRESET" } }), false);
});

test("isSessionNotFound heals Codex 0.147's missing lexical rollout path", () => {
  const err = {
    message: "Codex failed because it reported a general error: Error: thread/resume failed",
    details: {
      stderr: "failed to resolve rollout path `/gateway/run-tmp/grants-old/codex-user-home/.codex/sessions/rollout.jsonl`: file does not exist (code -32600)",
    },
  };
  assert.equal(isSessionNotFound(err), true);
  assert.equal(isSessionNotFound({ message: "failed to resolve config path: file does not exist" }), false);
});

test("a self-minted session id is stamped with ITS OWN engine, and the thread then sticks to it", async () => {
  // Regression for the run.js post-success stamp: it used to hardcode "codex", so an OpenCode
  // thread's minted id was saved as a codex session and turn 2 silently migrated the thread onto
  // Codex (fresh context + the un-restricted MCP surface). The stamp must carry the run's engine.
  const slug = "session-engine-selfmint";
  await saveSession(slug, "t-oc", "oc-minted-thread-id", "opencode");
  const row = await resolveSession(slug, "t-oc", "opencode");
  assert.equal(row.engine, "opencode");
  assert.equal(row.sessionId, "oc-minted-thread-id");
  // Turn 2 in an opencode channel: the sticky decision must keep opencode, not switch engines.
  assert.deepEqual(
    decideThreadEngine({ requested: "opencode", sessionEngine: row.engine, isNew: false, explicit: false }),
    { engine: "opencode", switch: false },
  );
});

test("unsupported list_turns heals only an explicit failed thread resume", () => {
  assert.equal(isSessionNotFound({ message: "thread/resume failed: list_turns is not supported yet" }), true);
  assert.equal(isSessionNotFound({ details: { stderr: "thread/resume failed: list_turns is not supported yet" } }), true);
  assert.equal(isSessionNotFound({ message: "list_turns is not supported yet" }), false);
  assert.equal(isSessionNotFound({ details: { stdout: "thread/resume failed: list_turns is not supported yet" } }), false);
});
