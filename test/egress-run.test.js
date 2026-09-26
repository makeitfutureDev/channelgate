// A turn in a proxy-mode container (src/gateway/run.js + src/gateway/egress/grants.js): the engine
// receives PLACEHOLDERS for every ruled secret and for the relayed Claude login, the raw value only
// for an unruled secret, the prompt says which is which, the turn is live work while it runs, and
// the output redactor still covers every REAL value.
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.CG_WORKSPACE_DIR = path.join(scratch, "egress-run-workspaces");
const { createFakeRuntimeBackend, useFakeRuntime } = await import("./runtime-fake.js");
const backend = await useFakeRuntime(createFakeRuntimeBackend({
  egress: { mode: "proxy", active: true, network: "none", rawNetwork: false, socketDir: "/gw/eg/x", caBundle: "/gw/run/egress-ca.pem", caSpki: "c3BraQ==" },
}));
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage } = await import("../src/gateway/run.js");
const { lookupGrant } = await import("../src/gateway/egress/grants.js");
const { liveSnapshot } = await import("../src/gateway/egress/liveness.js");
const { corePlaceholder } = await import("../src/gateway/egress/placeholders.js");
const { getDb } = await import("../src/db/index.js");

const REAL_GH = "ghp_real_github_value_for_egress_run_0001";
const REAL_RAW = "raw-unruled-value-for-egress-run-0001";
// Built at runtime so the source never carries a string shaped like a real Anthropic token.
const SETUP_TOKEN = `${["sk", "ant", "oat01"].join("-")}-REAL-SETUP-TOKEN-egress-run`;
const promptOf = (call) => call.args.find((arg) => String(arg).includes("[Gateway runtime for THIS attempt:"));

for (const engine of ["claude", "codex"]) {
  test(`${engine}: a proxy-mode turn gets placeholders, the prompt names them, and the run_config says enforced`, async () => {
    // An install that predates the strict default (pinned off at boot): an unruled secret is raw
    // and flagged. The strict default is the next test.
    saveSettings({ engine, defaultClaudeModel: "sonnet", defaultCodexModel: "gpt-5.6-sol", engineFallback: false,
      engineEnabled: { claude: true, codex: true }, agentMemory: false, memoryReviewEvery: 0, composioMode: "personal",
      containerClaudeOauthToken: SETUP_TOKEN, containerEgressSecretsStrict: false });
    const channelId = `C_EGRUN_${engine}`;
    const authorId = `U_EGRUN_${engine}`;
    await setUser(authorId, { name: "Egress run", approved: true });
    const channel = await upsertChannelEntry(channelId, { name: `egrun-${engine}`, type: "channel" });
    await saveChannelMeta(channel.slug, { channelId, type: "channel", engine, memory: false, cleanMode: false, allowNetwork: false,
      env: { GITHUB_TOKEN: { provider: "local", value: REAL_GH }, RAW_THING: { provider: "local", value: REAL_RAW } } });
    const start = backend.calls.spawn.length;
    let liveDuring = false;
    const spawn = backend.spawn;
    backend.spawn = (target, spec) => {
      liveDuring ||= liveSnapshot().some((e) => e.channelId === channelId && e.kind === "turn" && e.ownerId === authorId);
      return spawn(target, spec);
    };
    try {
      await runMessage({ channelId, authorId, threadKey: `egrun-${engine}.1`, origin: "slack_foreground", preferCold: true, text: "status?" });
    } finally {
      backend.spawn = spawn;
    }
    const call = backend.calls.spawn.slice(start).find(promptOf);
    assert.ok(call, "the engine was spawned");
    assert.match(call.env.GITHUB_TOKEN, /^cgph_c[a-z2-7]{32}$/);
    assert.equal(lookupGrant(call.env.GITHUB_TOKEN).secretName, "GITHUB_TOKEN");
    assert.equal(call.env.RAW_THING, REAL_RAW, "no rule → the raw value, flagged");
    assert.ok(!JSON.stringify(call.env).includes(REAL_GH), "the real GitHub token never reaches the container env");
    if (engine === "claude") {
      assert.match(call.env.CLAUDE_CODE_OAUTH_TOKEN, /^sk-ant-oat01-cgph_r[a-z2-7]{32}$/);
      assert.equal(lookupGrant(corePlaceholder(call.env.CLAUDE_CODE_OAUTH_TOKEN)).scope, "relay");
      assert.ok(!JSON.stringify(call.env).includes("REAL-SETUP-TOKEN"), "nor the Claude login");
    }
    const prompt = promptOf(call);
    assert.match(prompt, /GITHUB_TOKEN is proxy-protected: [^\n]*on: api\.github\.com, github\.com, uploads\.github\.com, \*\.githubusercontent\.com\./);
    assert.match(prompt, /Unprotected \(the RAW value[^\n]*\["RAW_THING"\]/);
    assert.ok(!prompt.includes(REAL_GH) && !prompt.includes(REAL_RAW));
    assert.equal(liveDuring, true, "the turn is live work while it runs");
    assert.equal(liveSnapshot().some((e) => e.channelId === channelId), false, "and released when it ends");

    const config = getDb().prepare("SELECT data FROM events WHERE event = 'run_config' AND channel = ? ORDER BY id DESC").get(channelId);
    const data = JSON.parse(config.data);
    assert.equal(data.networkEnforced, true);
    assert.equal(data.egress, "proxy");
    assert.deepEqual(data.egressUnprotected, ["RAW_THING"]);
  });
}

test("strict (the new-install default): an unruled secret is withheld from the container and the prompt says so", async () => {
  saveSettings({ engine: "claude", defaultClaudeModel: "sonnet", engineFallback: false,
    engineEnabled: { claude: true, codex: true }, agentMemory: false, memoryReviewEvery: 0, composioMode: "personal",
    containerClaudeOauthToken: SETUP_TOKEN, containerEgressSecretsStrict: true });
  const channelId = "C_EGRUN_STRICT";
  const authorId = "U_EGRUN_STRICT";
  await setUser(authorId, { name: "Egress strict", approved: true });
  const channel = await upsertChannelEntry(channelId, { name: "egrun-strict", type: "channel" });
  await saveChannelMeta(channel.slug, { channelId, type: "channel", engine: "claude", memory: false, cleanMode: false, allowNetwork: false,
    env: { GITHUB_TOKEN: { provider: "local", value: REAL_GH }, RAW_THING: { provider: "local", value: REAL_RAW } } });
  const start = backend.calls.spawn.length;
  await runMessage({ channelId, authorId, threadKey: "egrun-strict.1", origin: "slack_foreground", preferCold: true, text: "status?" });
  const call = backend.calls.spawn.slice(start).find(promptOf);
  assert.ok(call, "the engine was spawned");
  assert.match(call.env.GITHUB_TOKEN, /^cgph_c[a-z2-7]{32}$/, "a ruled secret is still its placeholder");
  assert.equal(call.env.RAW_THING, undefined, "the unruled secret is withheld, not raw");
  assert.ok(!JSON.stringify(call.env).includes(REAL_RAW));
  assert.match(promptOf(call), /Withheld by the gateway's strict egress setting[^\n]*\["RAW_THING"\]/);
});
