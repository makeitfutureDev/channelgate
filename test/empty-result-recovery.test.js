// Guards the primitives the empty-resume auto-recovery in run.js relies on (src/gateway/run.js:
// when a RESUME returns an empty 0-token result — a session broken by a mid-write stop/kill — it
// resets the session and re-runs once fresh, evicting the warm pool entry first). We can't drive
// runMessage end-to-end without spawning an engine, so we lock in the two things the recovery
// branch depends on: isEmptyResult correctly identifies the incident shape, and abortPooled is a
// harmless no-op for a thread with no warm session (the Codex / cold-run case the branch must not
// throw on). ensureTestEnv() runs before importing src so the lazy DB never touches the real dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { isEmptyResult, buildHealedPrompt } = await import("../src/gateway/run.js");
const { abortPooled } = await import("../src/engines/session-pool.js");

test("isEmptyResult: the incident shape (empty content + 0/0 tokens) is an empty result", () => {
  assert.equal(isEmptyResult({ content: "", usage: { input_tokens: 0, output_tokens: 0 } }), true);
  assert.equal(isEmptyResult({ content: "   ", usage: {} }), true); // whitespace-only content, no tokens
  assert.equal(isEmptyResult({}), true);
});

test("isEmptyResult: any real content OR any token counted is NOT empty", () => {
  assert.equal(isEmptyResult({ content: "hi", usage: { input_tokens: 0, output_tokens: 0 } }), false);
  assert.equal(isEmptyResult({ content: "", usage: { output_tokens: 3 } }), false);
  assert.equal(isEmptyResult({ content: "", usage: { input_tokens: 12 } }), false);
  // cache tokens count toward input — a cache-only resume did work and must not reset.
  assert.equal(isEmptyResult({ content: "", usage: { cache_read_input_tokens: 100 } }), false);
  assert.equal(isEmptyResult({ content: "", usage: { completion_tokens: 4 } }), false);
});

test("buildHealedPrompt: transcript first, session-was-lost note, then the original turn text", () => {
  const ctx = "[Thread context]\nAlice: please review the diff\n\n";
  const turnText = "check again";
  const prompt = buildHealedPrompt(ctx, turnText);
  assert.ok(prompt.startsWith(ctx)); // transcript leads so the note can say "above"
  assert.ok(prompt.endsWith("\n\n" + turnText)); // the actual request comes last
  assert.match(prompt, /previous session for this thread was lost/);
});

test("buildHealedPrompt: no transcript → null, so the heal retries with the bare turn text", () => {
  assert.equal(buildHealedPrompt("", "check again"), null);
  assert.equal(buildHealedPrompt(null, "check again"), null);
});

test("abortPooled on a thread with no warm session returns false (harmless no-op)", () => {
  // The recovery branch calls abortPooled unconditionally before the fresh retry; for a Codex run
  // or a cold Claude run there's no pool entry, and it must simply return false, never throw.
  assert.equal(abortPooled("no-such-slug::no-such-thread"), false);
});
