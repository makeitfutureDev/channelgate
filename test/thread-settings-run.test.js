// A turn and the background work it launches, with a thread's own settings
// (src/gateway/thread-settings.js), in a proxy-mode container (the fake runtime below).
//
// What must hold for Claude and Codex alike: the thread's variable reaches its own thread's engine
// only as a `thread` placeholder; a sibling thread gets the channel's; no real value reaches an
// environment, a prompt or an answer; a background agent or job resolves exactly the signed thread
// that launched it, at its own spawn — and a removal before that spawn is honoured.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.CG_WORKSPACE_DIR = path.join(scratch, "thread-settings-workspaces");
process.env.CG_APPROVAL_SECRET ||= "thread-settings-capability-secret";
const { createFakeRuntimeBackend, useFakeRuntime, fakeTarget } = await import("./runtime-fake.js");
const EGRESS = { mode: "proxy", active: true, network: "none", rawNetwork: false, socketDir: "/gw/eg/x", caBundle: "/gw/run/egress-ca.pem", caSpki: "c3BraQ==" };
const backend = await useFakeRuntime(createFakeRuntimeBackend({ egress: EGRESS }));
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage } = await import("../src/gateway/run.js");
const { lookupGrant } = await import("../src/gateway/egress/grants.js");
const { liveSnapshot } = await import("../src/gateway/egress/liveness.js");
const { setThreadSettings } = await import("../src/gateway/thread-settings.js");
const { mintGatewayCapability, verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const { ctxFromClaims } = await import("../src/mcp/gateway-server.js");
const { BackgroundJobs } = await import("../src/gateway/background.js");
const { getDb } = await import("../src/db/index.js");

const GH_CHANNEL = "ghp_channel_value_thread_run_00000001";
const GH_THREAD = "ghp_thread_value_thread_run_000000002";
const COMPOSIO_THREAD = "thread-composio-token-run-0003";
const SETUP_TOKEN = `${["sk", "ant", "oat01"].join("-")}-REAL-SETUP-TOKEN-thread-run`;
const promptOf = (call) => call?.args.find((arg) => String(arg).includes("[Gateway runtime for THIS attempt:"));
const local = (value) => ({ provider: "local", value, setBy: "U1", setAt: 1 });

async function fixture(engine, suffix) {
  saveSettings({ engine, defaultClaudeModel: "sonnet", defaultCodexModel: "gpt-5.6-sol", engineFallback: false,
    engineEnabled: { claude: true, codex: true }, agentMemory: false, memoryReviewEvery: 0, composioMode: "personal",
    containerClaudeOauthToken: SETUP_TOKEN, containerEgressSecretsStrict: true });
  const channelId = `C_THREADRUN_${suffix}`, authorId = `U_THREADRUN_${suffix}`;
  await setUser(authorId, { name: "Thread run", approved: true });
  const entry = await upsertChannelEntry(channelId, { name: `threadrun-${suffix}`, type: "channel" });
  await saveChannelMeta(entry.slug, { channelId, type: "channel", engine, memory: false, cleanMode: false, allowNetwork: false, autoMode: true,
    env: { GITHUB_TOKEN: local(GH_CHANNEL) } });
  setThreadSettings(entry.slug, "T-own", "secrets", { env: { GITHUB_TOKEN: local(GH_THREAD) } });
  setThreadSettings(entry.slug, "T-own", "mcp", { composioToken: COMPOSIO_THREAD });
  return { channelId, authorId, slug: entry.slug };
}

async function spawnFor(run) {
  const start = backend.calls.spawn.length;
  await run();
  return backend.calls.spawn.slice(start).find(promptOf);
}

for (const engine of ["claude", "codex"]) {
  test(`${engine}: a thread's variable reaches its own thread only, as a thread placeholder`, async () => {
    const f = await fixture(engine, engine);
    let live = [];
    const spawn = backend.spawn;
    backend.spawn = (target, spec) => { live = liveSnapshot().filter((entry) => entry.channelId === f.channelId); return spawn(target, spec); };
    try {
      const own = await spawnFor(() => runMessage({ channelId: f.channelId, authorId: f.authorId, threadKey: "T-own", origin: "slack_foreground", preferCold: true, text: "status?" }));
      assert.ok(own, "the engine was spawned");
      const row = lookupGrant(own.env.GITHUB_TOKEN);
      assert.deepEqual([row.scope, row.ownerId, row.channelId], ["thread", "T-own", f.channelId]);
      assert.ok(live.some((entry) => entry.kind === "turn" && entry.threadKey === "T-own"), "the turn is this thread's live work");
      const everything = JSON.stringify({ env: own.env, args: own.args });
      for (const secret of [GH_THREAD, GH_CHANNEL, COMPOSIO_THREAD]) assert.ok(!everything.includes(secret), "no real value reaches the engine's environment or argv");
      assert.match(promptOf(own), /This thread's own variables[^\n]*\["GITHUB_TOKEN"\]/);

      const sibling = await spawnFor(() => runMessage({ channelId: f.channelId, authorId: f.authorId, threadKey: "T-sibling", origin: "slack_foreground", preferCold: true, text: "status?" }));
      assert.equal(lookupGrant(sibling.env.GITHUB_TOKEN).scope, "channel", "a sibling thread keeps the channel's own variable");
      assert.doesNotMatch(promptOf(sibling), /This thread's own variables/);
    } finally { backend.spawn = spawn; }
  });

  test(`${engine}: a background agent resolves exactly the signed thread that launched it`, async () => {
    const f = await fixture(engine, `${engine}_agent`);
    const agent = await spawnFor(() => runMessage({ channelId: f.channelId, authorId: f.authorId, threadKey: "T-own::agent-1234abcd", settingsThreadKey: "T-own",
      sudoSourceThreadKey: "T-own", origin: "background_agent", preferCold: true, text: "task" }));
    assert.equal(lookupGrant(agent.env.GITHUB_TOKEN).ownerId, "T-own");
    // A synthetic key resolves nothing on its own, and an unrelated settings thread is refused.
    const bare = await spawnFor(() => runMessage({ channelId: f.channelId, authorId: f.authorId, threadKey: "T-own::agent-5678abcd", origin: "background_agent", preferCold: true, text: "task" }));
    assert.equal(lookupGrant(bare.env.GITHUB_TOKEN).scope, "channel");
    await assert.rejects(runMessage({ channelId: f.channelId, authorId: f.authorId, threadKey: "T-sibling", settingsThreadKey: "T-own", origin: "background_agent", preferCold: true, text: "task" }),
      /settings thread must be its own thread or the thread that launched it/);
  });
}

test("thread values never appear in an answer, streamed or final", async () => {
  const f = await fixture("claude", "redact");
  const text = `leak ${GH_THREAD} and ${COMPOSIO_THREAD}`;
  const events = [
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { type: "result", subtype: "success", result: text, session_id: "thread-redact", usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  const spawn = backend.spawn;
  backend.spawn = (target, spec) => spawn(target, { ...spec, cmd: process.execPath, args: ["-e", `for(const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event))`] });
  let streamed = "";
  try {
    const result = await runMessage({ channelId: f.channelId, authorId: f.authorId, threadKey: "T-own", origin: "slack_foreground", preferCold: true, text: "x", onDelta: (chunk) => { streamed += chunk; } });
    for (const secret of [GH_THREAD, COMPOSIO_THREAD]) {
      assert.ok(!result.content.includes(secret), "final answer is redacted");
      assert.ok(!streamed.includes(secret), "streamed answer is redacted");
    }
  } finally { backend.spawn = spawn; }
  const events_ = JSON.stringify(getDb().prepare("SELECT data FROM events").all());
  assert.ok(!events_.includes(GH_THREAD) && !events_.includes(COMPOSIO_THREAD), "no value in the event log");
});

test("the settings-thread claim is signed, bound to the run's own key, and forced onto background launches", () => {
  const secret = process.env.CG_APPROVAL_SECRET;
  const base = { secret, channelId: "C1", slug: "c1", authorId: "U1", origin: "background_agent", engine: "claude" };
  assert.throws(() => mintGatewayCapability({ ...base, threadKey: "T-sibling", settingsThreadKey: "T-own" }), /settings thread claim/);
  const token = mintGatewayCapability({ ...base, threadKey: "T-own::agent-1", settingsThreadKey: "T-own" });
  const verified = verifyGatewayCapability(token, { secret });
  assert.equal(verified.claims.settingsThreadKey, "T-own");
  // An own-thread run carries no claim at all.
  assert.equal(verifyGatewayCapability(mintGatewayCapability({ ...base, threadKey: "T-own", settingsThreadKey: "T-own" }), { secret }).claims.settingsThreadKey, undefined);
  // A forged payload fails the signature; a claim naming an unrelated thread fails verification.
  const [payload, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...verified.claims, settingsThreadKey: "T-sibling" })).toString("base64url");
  assert.equal(verifyGatewayCapability(`${forged}.${signature}`, { secret }).ok, false);
  assert.ok(payload);
  // Background launches carry the claim, never a body-supplied thread.
  const calls = [];
  const ctx = ctxFromClaims(verified.claims, { daemon: { available: () => true, call: async (kind, body) => { calls.push(body); return { ok: true }; } } });
  ctx.daemon.call("background", { channelId: "C1", threadKey: "T-own::agent-1", settingsThreadKey: "T-sibling", command: "true" });
  assert.equal(calls[0].settingsThreadKey, "T-own");
  const plain = ctxFromClaims({ ...verified.claims, threadKey: "T-plain", settingsThreadKey: undefined }, { daemon: { available: () => true, call: async (kind, body) => { calls.push(body); return { ok: true }; } } });
  plain.daemon.call("background", { channelId: "C1", threadKey: "T-plain", settingsThreadKey: "T-own", command: "true" });
  assert.equal(calls[1].settingsThreadKey, "T-plain");
});

test("a background shell job resolves its source thread's variables at its own spawn, and only that thread's", async () => {
  const f = await fixture("claude", "job");
  mkdirSync(path.join(process.env.CG_WORKSPACE_DIR, "slack", f.slug), { recursive: true });
  const jobs = new BackgroundJobs({ resolveTarget: (slug, meta) => fakeTarget(backend, slug, meta) });
  const wait = async () => { const deadline = Date.now() + 15_000; while (jobs.count() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25)); };
  const jobSpawn = async (args) => {
    const start = backend.calls.spawn.length;
    const started = await jobs.start({ channelId: f.channelId, authorId: f.authorId, command: "true", ...args });
    await wait();
    return { started, call: backend.calls.spawn.slice(start).find((call) => call.kind === "job") };
  };
  // A mismatched settings thread is refused before anything runs.
  const refused = await jobs.start({ channelId: f.channelId, authorId: f.authorId, threadKey: "T-sibling", settingsThreadKey: "T-own", command: "true" });
  assert.match(refused.error, /does not belong to that thread/);

  const own = await jobSpawn({ threadKey: "T-own" });
  assert.equal(own.started.ok, true, own.started.error);
  assert.equal(lookupGrant(own.call.env.GITHUB_TOKEN).ownerId, "T-own");
  assert.ok(!JSON.stringify(own.call.env).includes(GH_THREAD));
  // A job launched by the thread's background agent inherits the same thread.
  const nested = await jobSpawn({ threadKey: "T-own::agent-1234abcd", settingsThreadKey: "T-own" });
  assert.equal(lookupGrant(nested.call.env.GITHUB_TOKEN).ownerId, "T-own");
  const sibling = await jobSpawn({ threadKey: "T-sibling" });
  assert.equal(lookupGrant(sibling.call.env.GITHUB_TOKEN).scope, "channel");
  const persisted = getDb().prepare("SELECT data FROM bg_jobs").all().map((row) => JSON.parse(row.data));
  assert.ok(persisted.every((row) => !JSON.stringify(row).includes(GH_THREAD)), "a persisted job never carries a value");
  // Removed before the next job's spawn: that job no longer receives it (nor the channel's value).
  setThreadSettings(f.slug, "T-own", "secrets", { removed: ["GITHUB_TOKEN"] });
  const after = await jobSpawn({ threadKey: "T-own" });
  assert.equal(after.call.env.GITHUB_TOKEN, undefined);
});
