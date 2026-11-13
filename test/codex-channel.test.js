import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { requireAdapter, fallbackTargets, engineStateDir, engineUiManifest } = await import("../src/engines/registry.js");
const { makeChannelCodexAdapter } = await import("../src/engines/codex-channel.js");
const { channelCodexHome, codexLoginCandidatesFor } = await import("../src/gateway/channel-codex-auth.js");
const { buildCodexEnv } = await import("../src/engines/codex.js");
const { buildResumeCommand } = await import("../src/slack/footer.js");
const { migrations } = await import("../src/db/migrations.js");
const grants = await import("../src/gateway/egress/grants.js");
const { containerBackend } = await import("../src/runtimes/container/index.js");
const { containerRunEnv } = await import("../src/runtimes/container/exec.js");
const channelId = "C_CHANNEL_HARNESS";
const home = channelCodexHome(channelId);
const file = path.join(home, "auth.json");
function connected() { mkdirSync(home, { recursive: true }); writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: "fixture-channel-key" }), { mode: 0o600 }); }
function target(engine = "codex-channel") { return { backend: "container", meta: { channelId, engine, codexAuthSource: "channel" },
  runtime: { capabilities: { isolated: true }, spawn() {} }, container: { home: "/home/agent", codexHome: "/home/agent/.codex", codexChannelHome: "/home/agent/.codex-channel", egress: { active: true, mode: "proxy" } } }; }

test("channel Codex is a separate harness with account-scoped readiness and no fallback", async () => {
  const adapter = requireAdapter("codex-channel");
  assert.equal(adapter.channelScoped, true);
  assert.equal(adapter.supports.usageLimitFallback, false);
  assert.deepEqual(fallbackTargets(adapter.id), []);
  assert.equal(engineUiManifest().find(a => a.id === adapter.id).channelScoped, true);
  connected();
  assert.equal((await adapter.selectionReadiness({ channelId, meta: { channelId, codexAuthSource: "channel" } })).ready, true);
  assert.equal((await adapter.selectionReadiness()).ready, false);
  assert.equal((await adapter.selectionReadiness({ channelId: "C_OTHER" })).ready, false);
  assert.deepEqual(codexLoginCandidatesFor({ engine: "codex-channel", channelId }), [file]);
  assert.equal(codexLoginCandidatesFor({ engine: "codex", channelId, codexAuthSource: "channel" }), null, "explicit shared harness ignores the attachment marker");
});

test("the dedicated adapter uses an isolated HOME without mutating the shared target and refuses a disconnected account", async () => {
  connected();
  let actual;
  const adapter = makeChannelCodexAdapter({ ...requireAdapter("codex"), run: async ctx => { actual = ctx; return { text: "done" }; } });
  const original = target();
  const managed = [{ name: "managed" }];
  await adapter.run({ target: original, runtime: { managedMcpServers: managed } });
  assert.equal(actual.target.container.codexHome, "/home/agent/.codex-channel");
  assert.equal(original.container.codexHome, "/home/agent/.codex");
  assert.equal(actual.runtime.managedMcpServers, managed);
  assert.equal(engineStateDir(adapter.id, { backend: "host", meta: { channelId } }), home);
  const source = { OPENAI_API_KEY: "gateway", CODEX_API_KEY: "gateway", OPENAI_BASE_URL: "https://other.invalid" };
  const env = buildCodexEnv({ target: actual.target }, source);
  assert.equal(env.CODEX_HOME, "/home/agent/.codex-channel");
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.match(buildResumeCommand("/work", "fixture-id", adapter.id, actual.target), /CODEX_HOME='\/home\/agent\/\.codex-channel'/);
  rmSync(file);
  await assert.rejects(adapter.run({ target: original, runtime: {} }), /not connected/);
});

test("prepared target and actual exec environment use the selected harness state before runner and usage inspection", () => {
  const base = { slug: "channel-harness", channelId, cwd: "/work", meta: { channelId, engine: "codex-channel", codexAuthSource: "channel" }, settings: {} };
  const prepared = containerBackend.prepareTarget(base);
  assert.equal(prepared.container.codexHome, "/home/agent/.codex-channel");
  assert.equal(containerRunEnv(prepared, { CODEX_HOME: "/wrong" }).CODEX_HOME, prepared.container.codexHome);
  const normal = containerBackend.prepareTarget({ ...base, meta: { ...base.meta, engine: "codex" } });
  assert.equal(normal.container.codexHome, "/home/agent/.codex");
});

test("concurrent shared and channel account relays remain bound after default changes", async () => {
  grants.__resetGrantCaches();
  const shared = grants.codexApiRelayPlaceholderFor({ channelId });
  const dedicated = grants.codexApiRelayPlaceholderFor({ channelId, channel: true });
  assert.notEqual(shared, dedicated);
  let defaultEngine = "codex-channel";
  const deps = { metaFor: async () => ({ channelId, codexAuthSource: "channel", engine: defaultEngine }),
    codexRelayToken: async ({ candidates }) => ({ token: candidates ? "channel-value" : "gateway-value", source: "api-key" }) };
  const [a, b] = await Promise.all([grants.resolveGrantValue(grants.lookupGrant(shared), deps), grants.resolveGrantValue(grants.lookupGrant(dedicated), deps)]);
  assert.equal(a, "gateway-value"); assert.equal(b, "channel-value");
  defaultEngine = "claude";
  assert.equal(await grants.resolveGrantValue(grants.lookupGrant(shared), deps), "gateway-value");
  assert.equal(await grants.resolveGrantValue(grants.lookupGrant(dedicated), deps), "channel-value");
  assert.equal(await grants.resolveGrantValue(grants.lookupGrant(dedicated), { ...deps, metaFor: async () => ({ codexAuthSource: "gateway" }) }), "", "disconnect pauses even cached channel relay");
});

test("upgrade preserves dedicated-account defaults, policies, MCPs, sessions and pins", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations.filter(m => m.version < 53)) migration.up(db);
    const meta = { channelId, engine: "codex", codexAuthSource: "channel", approvedEngines: ["codex", "claude"], allowedCodexMcps: ["private-server"] };
    db.prepare("INSERT INTO channel_meta(slug,data) VALUES(?,?)").run("dedicated", JSON.stringify(meta));
    db.prepare("INSERT INTO channel_meta(slug,data) VALUES(?,?)").run("shared", JSON.stringify({ engine: "codex" }));
    db.prepare("INSERT INTO sessions(slug,thread_key,session_id,engine) VALUES(?,?,?,?)").run("dedicated", "thread", "session", "codex");
    db.prepare("INSERT INTO thread_overrides(slug,thread_key,kind,value) VALUES(?,?,?,?)").run("dedicated", "thread", "engine", "codex");
    migrations.find(m => m.version === 53).up(db);
    const after = JSON.parse(db.prepare("SELECT data FROM channel_meta WHERE slug='dedicated'").get().data);
    assert.equal(after.engine, "codex-channel");
    assert.deepEqual(after.approvedEngines, ["codex-channel", "claude"]);
    assert.deepEqual(after.allowedChannelCodexMcps, ["private-server"]);
    assert.equal(db.prepare("SELECT engine FROM sessions").get().engine, "codex-channel");
    assert.equal(db.prepare("SELECT value FROM thread_overrides").get().value, "codex-channel");
    assert.equal(JSON.parse(db.prepare("SELECT data FROM channel_meta WHERE slug='shared'").get().data).engine, "codex");
  } finally { db.close(); }
});
