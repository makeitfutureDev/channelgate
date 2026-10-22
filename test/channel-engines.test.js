import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, testLicenseEnv, clearTestLicense } from "./helpers.js";

ensureTestEnv();
const root = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(root, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
const { useFakeRuntime, fakeTarget } = await import("./runtime-fake.js");
const backend = await useFakeRuntime();
const policy = await import("../src/gateway/channel-engines.js");
const { ENGINE_IDS } = await import("../src/engines/registry.js");
const { setUser, upsertChannelEntry, saveChannelMeta, patchChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { getDb } = await import("../src/db/index.js");
const { runMessage, resetEngineCooldowns } = await import("../src/gateway/run.js");
const { setThreadEngine, setThreadRuntimeOverrides } = await import("../src/gateway/thread-engine.js");
const { saveSession, getSession } = await import("../src/gateway/sessions.js");
const { runMemoryReview } = await import("../src/gateway/memory-review.js");
const { modelWizardEngineBlocks } = await import("../src/slack/model-wizard.js");
const { startApiRun } = await import("../src/gateway/api-runs.js");

let counter = 0;
async function channel(engine = "claude", approvedEngines = [engine]) {
  testLicenseEnv({ tier: "enterprise" });
  saveSettings({ licenseKey: "", engine: "claude", engineFallback: true, engineEnabled: Object.fromEntries(ENGINE_IDS.map(id => [id, true])), composioMode: "personal" });
  resetEngineCooldowns();
  await setUser("U_APPROVAL", { name: "Harness policy test", approved: true });
  const channelId = `D_APPROVAL_${++counter}`;
  const entry = await upsertChannelEntry(channelId, { name: `approval-${counter}`, type: "im", isDM: true });
  await saveChannelMeta(entry.slug, { channelId, name: entry.name, type: "im", isDM: true, template: "custom", engine, approvedEngines, cleanMode: true, allowNetwork: false });
  return { channelId, entry };
}
const run = (f, extra = {}) => runMessage({ channelId: f.channelId, authorId: "U_APPROVAL", threadKey: "thread", text: "hello", origin: "slack_foreground", preferCold: true, ...extra });

test("policy accepts registry harnesses, rejects invalid/empty lists, and preserves restrictions after downgrade", () => {
  assert.deepEqual(policy.normalizeApprovedEngines([...ENGINE_IDS, ENGINE_IDS[0]]), ENGINE_IDS);
  assert.equal(policy.normalizeApprovedEngines(null), null);
  for (const invalid of [[], ["missing"], "claude", [null], ["Claude"]]) assert.throws(() => policy.normalizeApprovedEngines(invalid), /nonempty list/);
  assert.throws(() => policy.assertApprovedEnginesUpdate({}, ["claude"], { enterprise: false }), { statusCode: 403 });
  assert.deepEqual(policy.assertApprovedEnginesUpdate({ approvedEngines: ["claude"] }, ["claude"], { enterprise: false }), ["claude"]);
  assert.throws(() => policy.assertApprovedEnginesUpdate({ approvedEngines: ["claude"] }, null, { enterprise: false }), /Enterprise/);
  assert.equal(policy.isChannelEngineApproved({ approvedEngines: [] }, "claude"), false);
  assert.equal(policy.isChannelEngineApproved({ approvedEngines: ["claude", "removed"] }, "claude"), false);
  assert.equal(policy.isChannelEngineApproved({}, "missing"), false);
});

test("thread selection refuses an unapproved harness and preserves the existing runtime triple", async () => {
  const f = await channel();
  await assert.rejects(setThreadEngine(f.entry.slug, "thread", "codex"), /not an approved harness/);
  assert.throws(() => setThreadRuntimeOverrides(f.entry.slug, "thread", { engine: "codex", model: "gpt-6-sol" }), /not an approved harness/);
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM thread_overrides WHERE slug = ?").get(f.entry.slug).n, 0);
  const buttons = JSON.stringify(modelWizardEngineBlocks({ meta: await getChannelMeta(f.entry.slug), scope: "thread", threadTs: "thread" }));
  assert.match(buttons, /cg_mw_engine_claude/);
  assert.doesNotMatch(buttons, /cg_mw_engine_codex/);
});

test("explicit API overrides and stale sessions/pins are refused before any managed harness starts", async () => {
  const f = await channel();
  const before = backend.calls.spawn.length;
  for (const origin of ["slack_foreground", "schedule", "background_agent", "api_foreground"]) {
    const out = await run(f, { origin, overrides: { engine: "codex" } });
    assert.equal(out.channelEngineRefused, true, origin);
    assert.equal(out.cwd, "");
    assert.equal(out.costUSD, 0);
  }
  await saveSession(f.entry.slug, "thread", "old-unapproved-session", "codex");
  assert.equal((await run(f)).channelEngineRefused, true);
  getDb().prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES (?, 'stale', 'engine', 'codex')").run(f.entry.slug);
  assert.equal((await run(f, { threadKey: "stale" })).channelEngineRefused, true);
  assert.equal(backend.calls.spawn.length, before);
  const response = await startApiRun({ channel: f.channelId, message: "hello", engine: "codex" });
  assert.equal(response.code, 403);
  assert.match(response.error, /not an approved harness/);
});

test("automatic failover runs only when the other harness is approved, in either direction", async () => {
  for (const [engine, other, trigger] of [["claude", "codex", "CLAUDE_STUB_LIMIT_FAIL_SAFE"], ["codex", "claude", "CODEX_STUB_LIMIT_FAIL_SAFE"]]) {
    const f = await channel(engine);
    const before = backend.calls.spawn.length;
    await assert.rejects(run(f, { text: trigger }), /limit|usage/i);
    assert.equal(backend.calls.spawn.slice(before).some(call => call.cmd === other), false);
    await patchChannelMeta(f.entry.slug, { approvedEngines: [engine, other] });
    resetEngineCooldowns();
    const allowed = await run(f, { threadKey: "allowed", text: trigger });
    assert.equal(allowed.engine, other);
  }
});

test("policy is re-read after runtime preparation and before the adapter can launch", async () => {
  const f = await channel();
  const original = backend.ensureUp;
  const before = backend.calls.spawn.length;
  backend.ensureUp = async (...args) => {
    const result = await original(...args);
    await patchChannelMeta(f.entry.slug, { approvedEngines: ["codex"], engine: "codex" });
    return result;
  };
  try { await assert.rejects(run(f), /not an approved harness/); }
  finally { backend.ensureUp = original; }
  assert.equal(backend.calls.spawn.length, before);
  assert.equal(await getSession(f.entry.slug, "thread"), null, "refused queued turn leaves no minted session");
});

test("a channel's approved harnesses remain enforced when Enterprise is lost", async () => {
  const f = await channel();
  clearTestLicense();
  assert.equal((await run(f, { overrides: { engine: "codex" } })).channelEngineRefused, true);
  await assert.rejects(patchChannelMeta(f.entry.slug, { approvedEngines: null }), /Enterprise/);
  await patchChannelMeta(f.entry.slug, { name: "renamed" });
  assert.deepEqual((await getChannelMeta(f.entry.slug)).approvedEngines, ["claude"]);
});

test("memory reviews obey current policy, including revocation during runtime preparation", async () => {
  const f = await channel("codex");
  const args = { channelId: f.channelId, slug: f.entry.slug, authorId: "U_APPROVAL", threadKey: "review-thread", meta: { approvedEngines: null }, fetchTranscript: async () => "Remember this preference", resolveTarget: (slug, meta) => fakeTarget(backend, slug, meta), run: async () => { throw new Error("unapproved reviewer ran"); } };
  assert.deepEqual(await runMemoryReview(args), { skipped: "harness-not-approved", saved: 0 });
  await patchChannelMeta(f.entry.slug, { approvedEngines: ["claude", "codex"] });
  const original = backend.ensureUp;
  backend.ensureUp = async (...params) => {
    const result = await original(...params);
    await patchChannelMeta(f.entry.slug, { approvedEngines: ["codex"] });
    return result;
  };
  try { assert.deepEqual(await runMemoryReview(args), { skipped: "harness-not-approved", saved: 0 }); }
  finally { backend.ensureUp = original; }
});


test("a disabled but explicitly requested unapproved harness is refused, never substituted", async () => {
  const f = await channel();
  saveSettings({ engineEnabled: { claude: true, codex: false } });
  const before = backend.calls.spawn.length;
  const out = await run(f, { overrides: { engine: "codex" } });
  assert.equal(out.channelEngineRefused, true);
  assert.equal(out.engine, "codex");
  assert.equal(backend.calls.spawn.length, before);
});

test("fallback approval revoked while its context is prepared prevents the fallback launch", async () => {
  const f = await channel("claude", ["claude", "codex"]);
  const before = backend.calls.spawn.length;
  await assert.rejects(run(f, {
    text: "CLAUDE_STUB_LIMIT_FAIL_SAFE",
    getFallbackContext: async () => {
      await patchChannelMeta(f.entry.slug, { approvedEngines: ["claude"] });
      return "Previous conversation";
    },
  }));
  assert.equal(backend.calls.spawn.slice(before).some(call => call.cmd === "codex"), false);
});

test("metadata writes cannot bypass entitlement, remove a saved restriction, or select a disallowed engine", async () => {
  const f = await channel();
  await assert.rejects(patchChannelMeta(f.entry.slug, { engine: "codex" }), /not an approved harness/);
  await assert.rejects(patchChannelMeta(f.entry.slug, { codexAuthSource: "channel" }), /not an approved harness/);
  clearTestLicense();
  await assert.rejects(saveChannelMeta(f.entry.slug, { approvedEngines: ["claude", "codex"] }), /Enterprise/);
  await saveChannelMeta(f.entry.slug, { name: "saved without policy" });
  assert.deepEqual((await getChannelMeta(f.entry.slug)).approvedEngines, ["claude"]);
});


test("a cooldown fallback that starts and fails is not treated as a turn with no engine launch", async () => {
  const f = await channel("claude", ["claude", "codex"]);
  const first = await run(f, { text: "CLAUDE_STUB_LIMIT_FAIL_SAFE" });
  assert.equal(first.engine, "codex");
  const before = backend.calls.spawn.length;
  await assert.rejects(run(f, { threadKey: "cooldown-failure", text: "CODEX_STUB_LIMIT_FAIL_SAFE" }), /limit|usage/i);
  const spawned = backend.calls.spawn.slice(before);
  assert.equal(spawned.some(call => call.cmd === "claude"), false, "cooldown bypassed the primary");
  assert.equal(spawned.some(call => call.cmd === "codex"), true, "the approved fallback actually started");
  assert.ok(await getSession(f.entry.slug, "cooldown-failure"), "a launched turn is not swept as an unused session");
});
