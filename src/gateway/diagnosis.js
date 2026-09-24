// Self-diagnosis loop: when an interactive run fails unexpectedly, open a NEW thread in the
// configured dev channel (Settings → errorDiagnosisChannel, e.g. "gateway-slack" — whose work
// folder IS this repo) and run Claude there with the error context, asking it to find the root
// cause in the source and PROPOSE a fix (never apply one). Guardrails: off unless configured; a
// global cooldown so an error storm can't become a run storm; a failed diagnosis run is never
// itself diagnosed (the diagnosis thread's own key is remembered and skipped — no recursion); and
// failures that are provider STATE rather than a source defect are skipped entirely.
import { runMessage } from "./run.js";
import { listChannels } from "../config/store.js";
import { getErrorDiagnosisChannel } from "../config/settings.js";
import { logEvent, readEvents } from "../util/logger.js";
import { recordUsage } from "./usage.js";
import { deliverResult } from "../slack/deliver.js";
import { postNotice } from "../platforms/notify.js";

// Not every failed run is a DEFECT in this source. A provider quota, a missing or expired sign-in,
// a model the account will not serve, a provider outage and a dropped connection are states of the
// world OUTSIDE this repository: the failing thread already told the user and named the remedy, and
// a diagnosis could only ever report "wait for the limit to reset". Diagnosing them spends the very
// quota that was exhausted, burns the half-hour cooldown a real bug may need, and trains the dev
// channel to ignore the 🩺 card. Only failures whose root cause could plausibly live in the source
// — crashes, stalls, requests we built wrong, denials, unclassified errors — are worth a thread.
const PROVIDER_STATE_KINDS = new Set(["usage_limit", "authentication", "billing", "model_rejected", "availability", "connection"]);
// Belt and braces for the same class arriving unclassified: the orchestrator's own limit throw
// (run.js) and any runner that only reports the limit in prose still must not open a thread.
const PROVIDER_LIMIT_TEXT = /\busage limit\b|\bspend limit\b|hit (?:your|its) (?:session|usage|weekly|account|spend|monthly|credit)\s+limit|purchase more credits|out of credits/i;

// Is this failure something a reader of THIS repository could fix? Exported for the tests and for
// any future caller that wants the same judgement before spending a run on a diagnosis.
export function isDiagnosableRunError(err) {
  const details = err?.details || {};
  if (details.explicitStop === true || err?.name === "AbortError") return false; // the user ended it
  if (details.providerError === true && PROVIDER_STATE_KINDS.has(String(details.providerKind || ""))) return false;
  return !PROVIDER_LIMIT_TEXT.test(String(err?.message || ""));
}

const COOLDOWN_MS = 30 * 60_000; // at most one diagnosis per half hour, across all channels
let lastAt = 0;
const ownThreads = new Set(); // threadKeys of diagnosis threads — their failures are never re-diagnosed

// Fire-and-forget from the run-error path (never awaited into it, never throws consequences
// there). Posts the announcement, runs the diagnosis as the failing turn's author (their tokens/
// mode apply in the dev channel), and threads the findings under the announcement — the root ts
// is the threadKey, so the user can keep talking to the diagnosis in its own thread.
export async function maybeDiagnoseRunError({ client, err, channelId, slug, threadKey, authorId }) {
  const targetSlug = getErrorDiagnosisChannel();
  if (!targetSlug || !client) return;
  if (ownThreads.has(threadKey)) return; // the diagnoser failed — do not diagnose the diagnosis
  if (!isDiagnosableRunError(err)) return; // provider quota/credential/outage state — nothing here to fix
  if (Date.now() - lastAt < COOLDOWN_MS) return;
  const target = (await listChannels()).find((c) => c.slug === targetSlug && !c.meta?.isDM);
  if (!target) return;
  lastAt = Date.now();

  // Link back to the failed thread (best-effort — the diagnosis is useful without it).
  let permalink = "";
  try {
    const p = await client.chat.getPermalink({ channel: channelId, message_ts: threadKey });
    permalink = p?.permalink || "";
  } catch { /* optional */ }

  // Recent gateway events for the failing channel — cheap context the diagnosis can't reach from
  // inside its sandbox (the DB lives outside the channel folder).
  const recent = readEvents({ limit: 200 })
    .filter((e) => e.channel === channelId)
    .slice(0, 12)
    .map((e) => `- ${e.ts} ${e.event}${e.error ? ` — ${e.error}` : ""}${e.durationMs ? ` (${e.durationMs}ms)` : ""}`)
    .join("\n");

  const root = await postNotice(client, {
    conversationId: target.channelId,
    text: `🩺 *Run error in <#${channelId}>* — \`${err.message}\`${permalink ? ` (<${permalink}|failed thread>)` : ""}. Diagnosing…`,
  });
  // No posted root means no thread to diagnose INTO. Bail rather than minting a session keyed on
  // an empty id — a diagnosis nobody can see is worse than none.
  if (!root?.messageId) return;
  const diagKey = root.messageId; // real thread id → replies in the thread resume the SAME session
  ownThreads.add(diagKey);
  await logEvent("diagnosis_run", { channel: channelId, author: authorId, slug, error: err.message });

  const prompt = [
    "SELF-DIAGNOSIS TASK (auto-generated by the gateway daemon — no human wrote this).",
    "",
    `An interactive run just FAILED in Slack channel <#${channelId}> (slug "${slug}"${permalink ? `, thread: ${permalink}` : ""}).`,
    "",
    `Error: ${err.message}`,
    err.stderr ? `Stderr tail:\n\`\`\`\n${String(err.stderr).slice(-1500)}\n\`\`\`` : "",
    recent ? `Recent gateway events for that channel:\n${recent}` : "",
    "",
    "Your working folder is the gateway's own repository. Investigate the ROOT CAUSE in the",
    "source — start from the error string (src/engines/, src/gateway/run.js, src/slack/app.js) —",
    "and check the roadmap (TASKS.md, if present) for related known work. Reply concisely with:",
    "1. Root cause (file:line and the mechanism)",
    "2. A proposed fix — as a diff or a precise description. Do NOT apply any change.",
    "3. Whether the roadmap already tracks it (quote the item) or a new roadmap entry to add.",
  ].filter(Boolean).join("\n");

  try {
    const result = await runMessage({ channelId: target.channelId, authorId, text: prompt, threadKey: diagKey, origin: "diagnosis" });
    await deliverResult(client, { channel: target.channelId, threadKey: diagKey, result });
    await recordUsage({ channelId: target.channelId, slug: targetSlug, authorId, engine: result.engine, taskKind: "diagnosis", result });
  } catch (e) {
    await logEvent("diagnosis_error", { channel: channelId, slug, error: e.message });
    await postNotice(client, { conversationId: target.channelId, threadKey: diagKey, text: `🩺 Diagnosis run failed: ${e.message}` }).catch(() => {});
  }
}

// Is this threadKey one of our own diagnosis threads? (Exported for the run-error path so an
// interactive follow-up failing INSIDE a diagnosis thread doesn't trigger another diagnosis.)
export function isDiagnosisThread(threadKey) {
  return ownThreads.has(threadKey);
}
