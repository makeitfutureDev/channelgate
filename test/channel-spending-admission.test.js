// Exercise the common run admission path rather than only the arithmetic helper. A budget
// refusal must not provision a runtime or reach an engine, regardless of who launched the work.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { defaultChannelMeta, upsertChannelEntry, saveChannelMeta, setUser } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage, setRuntimeResolver } = await import("../src/gateway/run.js");
const { runMemoryReview } = await import("../src/gateway/memory-review.js");
const { ensureChannelFolder } = await import("../src/gateway/folders.js");
const { isDiagnosableRunError } = await import("../src/gateway/diagnosis.js");
const { createFakeRuntimeBackend, fakeTarget } = await import("./runtime-fake.js");
const { API_PRINCIPAL } = await import("../src/config/api-principal.js");
const db = getDb();
let sequence = 0;
function spend(channelId, cost = 5) {
  db.prepare(`INSERT INTO usage(ts, channel_id, slug, author_id, engine, model,
    task_kind, tokens_in, tokens_out, cost_usd, cost_estimated, duration_ms)
    VALUES(?, ?, 'budget-admission', 'U_BUDGET_ADMISSION', 'claude', 'sonnet', 'interactive', 1, 1, ?, 0, 1)`)
    .run(new Date().toISOString(), channelId, cost);
}
async function channel(engine = "claude") {
  const id = `C_BUDGET_ADMISSION_${++sequence}`;
  const entry = await upsertChannelEntry(id, { name: `budget-admission-${sequence}`, type: "channel" });
  const meta = { ...defaultChannelMeta({ channelId: id, name: entry.name, type: "channel", isDM: false }),
    template: "custom", engine, model: engine === "claude" ? "sonnet" : "gpt-6.1-sol",
    allowedMcps: [], allowedCodexMcps: [], monthlySpendingLimitUSD: 5 };
  await saveChannelMeta(entry.slug, meta);
  return { channelId: id, entry, meta };
}
function backend() {
  const runtime = createFakeRuntimeBackend();
  let spawns = 0, resolutions = 0;
  runtime.spawn = () => { spawns++; assert.fail("a refused budget must never spawn an engine"); };
  const resolve = (slug, meta, options) => { resolutions++; return fakeTarget(runtime, slug, meta, options); };
  setRuntimeResolver(resolve);
  return { runtime, resolve, get spawns() { return spawns; }, get resolutions() { return resolutions; } };
}
const args = (c, origin) => ({ channelId: c.channelId, authorId: origin === "api_foreground" ? API_PRINCIPAL : "U_BUDGET_ADMISSION",
  text: "A substantive test request", threadKey: `budget-${sequence}-${origin}`, origin, preferCold: true });
test.before(async () => {
  saveSettings({ memoryReviewEvery: 0, composioMode: "personal", engineFallback: true, codexEnabled: true });
  await setUser("U_BUDGET_ADMISSION", { name: "Budget tester", approved: true });
});
test.afterEach(() => setRuntimeResolver(null));

test("foreground Claude and Codex reject an exhausted channel before runtime provisioning", async () => {
  for (const engine of ["claude", "codex"]) {
    const c = await channel(engine), b = backend();
    spend(c.channelId);
    const result = await runMessage(args(c, "slack_foreground"));
    assert.equal(result.spendingRefused, true);
    assert.match(result.content, /reached.*spending limit/);
    assert.equal(result.sessionId, null);
    assert.equal(result.costUSD, 0);
    assert.equal(b.resolutions, 0);
    assert.equal(b.runtime.calls.ensureUp.length, 0);
    assert.equal(b.spawns, 0);
  }
});

test("schedule, background-agent and authenticated API origins share the no-spawn budget gate", async () => {
  for (const origin of ["schedule", "background_agent", "api_foreground"]) {
    const c = await channel(), b = backend();
    spend(c.channelId);
    const result = await runMessage(args(c, origin));
    assert.equal(result.spendingRefused, true, origin);
    assert.equal(b.resolutions, 0, origin);
    assert.equal(b.runtime.calls.ensureUp.length, 0, origin);
    assert.equal(b.spawns, 0, origin);
  }
});

test("unpriced channel usage refuses new runs instead of silently spending an unknown remainder", async () => {
  const c = await channel(), b = backend();
  spend(c.channelId, null);
  const result = await runMessage(args(c, "background_agent"));
  assert.equal(result.spendingRefused, true);
  assert.match(result.content, /no price/);
  assert.equal(b.resolutions, 0);
  assert.equal(b.spawns, 0);
});

test("a budget exhausted during runtime warmup is rechecked before spawn and is not a diagnosable defect", async () => {
  const c = await channel(), b = backend();
  const ensure = b.runtime.ensureUp.bind(b.runtime);
  b.runtime.ensureUp = async (...parameters) => {
    const result = await ensure(...parameters);
    spend(c.channelId);
    return result;
  };
  const result = await runMessage(args(c, "slack_foreground"));
  assert.equal(result.spendingRefused, true);
  assert.match(result.content, /reached.*spending limit/);
  assert.equal(isDiagnosableRunError({ code: "channel_spending_limit" }), false);
  assert.equal(b.runtime.calls.ensureUp.length, 1, "the turn passed initial admission");
  assert.equal(b.spawns, 0, "the engine and any failover remain unstarted");
  assert.ok(b.runtime.calls.leases.every(lease => lease.released), "refusal releases the runtime lease");
});

test("memory reviewer skips exhausted channels before transcript fetch and rechecks after warmup", async () => {
  const exhausted = await channel(), blocked = backend();
  spend(exhausted.channelId);
  const common = c => ({ channelId: c.channelId, slug: c.entry.slug, meta: c.meta,
    authorId: "U_BUDGET_ADMISSION", threadKey: "budget-review" });
  const skipped = await runMemoryReview({ ...common(exhausted), resolveTarget: blocked.resolve,
    fetchTranscript: () => assert.fail("refused review must not fetch a transcript"),
    run: () => assert.fail("refused review must not launch an engine") });
  assert.equal(skipped.skipped, "channel-spending-limit");
  assert.equal(blocked.resolutions, 0);

  const warming = await channel(), b = backend();
  const target = b.resolve(warming.entry.slug, warming.meta);
  await ensureChannelFolder(warming.entry.slug, warming.meta, { target });
  const ensure = b.runtime.ensureUp.bind(b.runtime);
  b.runtime.ensureUp = async (...parameters) => { const result = await ensure(...parameters); spend(warming.channelId); return result; };
  const rechecked = await runMemoryReview({ ...common(warming), resolveTarget: b.resolve,
    fetchTranscript: async () => "A user asked to remember a stable preference.",
    run: () => assert.fail("budget reached during preparation must skip the reviewer engine") });
  assert.equal(rechecked.skipped, "channel-spending-limit");
  assert.equal(b.runtime.calls.ensureUp.length, 1);
  assert.equal(b.spawns, 0);
  assert.ok(b.runtime.calls.leases.every(lease => lease.released));
});
