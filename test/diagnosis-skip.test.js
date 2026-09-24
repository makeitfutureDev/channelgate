// Self-diagnosis admission: a provider's usage limit (or expired sign-in, rejected model, outage)
// is the state of an ACCOUNT, not a defect in this repository — it must never open a 🩺 thread in
// the dev channel, spend the quota that was just exhausted, or eat the half-hour cooldown that a
// real crash may need. Failures that could plausibly be our bug still do.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { upsertChannelEntry } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { isDiagnosableRunError, maybeDiagnoseRunError } = await import("../src/gateway/diagnosis.js");

const err = (message, details) => Object.assign(new Error(message), details ? { details } : {});

test("provider account state is not diagnosable; a source-side failure is", () => {
  // The exact shape the orchestrator throws for the Claude session limit.
  assert.equal(isDiagnosableRunError(err(
    "Claude usage limit reached: You've hit your session limit · resets 7pm (Europe/Bucharest)",
    { engine: "claude", providerError: true, providerKind: "usage_limit" },
  )), false);
  for (const kind of ["usage_limit", "authentication", "billing", "model_rejected", "availability", "connection"]) {
    assert.equal(isDiagnosableRunError(err("boom", { providerError: true, providerKind: kind })), false, kind);
  }
  // Classified-as-ours provider kinds stay diagnosable: a request WE built wrong is a source bug.
  for (const kind of ["invalid_request", "permission", "provider"]) {
    assert.equal(isDiagnosableRunError(err("boom", { providerError: true, providerKind: kind })), true, kind);
  }
  // Unclassified wording alone is enough — a runner that only says it in prose must not spawn one.
  assert.equal(isDiagnosableRunError(err("Codex: you've hit your weekly limit, purchase more credits")), false);
  // The user ending their own turn is not a failure to investigate.
  assert.equal(isDiagnosableRunError(err("Claude run was stopped before it finished.", { explicitStop: true })), false);
  assert.equal(isDiagnosableRunError(Object.assign(new Error("aborted"), { name: "AbortError" })), false);
  // Crashes, stalls and anything unclassified remain worth a thread.
  assert.equal(isDiagnosableRunError(err("Claude produced no output for 15m — giving up")), true);
  assert.equal(isDiagnosableRunError(err("Claude exited with code 1", { processEnded: true })), true);
});

test("a usage-limited run posts nothing in the diagnosis channel; a crash posts the card", async () => {
  await saveSettings({ errorDiagnosisChannel: "gateway-dev" });
  await upsertChannelEntry("C_DEV", { name: "gateway-dev", type: "channel", isDM: false });

  const posts = [];
  // No `ts` in the reply: postNotice returns an empty messageId, so the module bails right after
  // the announcement — the card is observable without ever spawning an engine for the diagnosis.
  const client = { chat: { postMessage: async (p) => { posts.push(p); return { ok: true }; }, getPermalink: async () => ({}) } };

  // Runs FIRST, while the global cooldown is untouched — so "nothing posted" can only be the skip.
  await maybeDiagnoseRunError({
    client,
    err: err("Claude usage limit reached: You've hit your session limit · resets 7pm", { engine: "claude", providerError: true, providerKind: "usage_limit" }),
    channelId: "C_FAIL", slug: "gateway-slack", threadKey: "1790061060.061129", authorId: "U1",
  });
  assert.deepEqual(posts, [], "a usage limit must not notify the dev channel");

  await maybeDiagnoseRunError({
    client,
    err: err("Claude exited with code 1", { engine: "claude", processEnded: true }),
    channelId: "C_FAIL", slug: "gateway-slack", threadKey: "1790061060.061130", authorId: "U1",
  });
  assert.equal(posts.length, 1, "a crash still opens the diagnosis card");
  assert.equal(posts[0].channel, "C_DEV");
  assert.match(posts[0].text, /Run error in <#C_FAIL>/);
});
