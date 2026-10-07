import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

const { saveSettings } = await import("../src/config/settings.js");
const { installPerplexityResearchLogin, perplexityResearchMcp, perplexityResearchPreamble } = await import("../src/gateway/perplexity-research.js");
const { PERPLEXITY_HOST, PERPLEXITY_SESSION_COOKIE, PERPLEXITY_RELAY_SECRET_NAME, PERPLEXITY_MCP_NAME } = await import("../src/gateway/perplexity-research-contract.js");
const { lookupGrant, resolveEgressGrant } = await import("../src/gateway/egress/grants.js");
const { swapHeaders, swapRequest } = await import("../src/gateway/egress/rules.js");
const { buildEngineMcpRuntime } = await import("../src/gateway/run-engine-mcp.js");
const { buildSettings } = await import("../src/gateway/folders.js");
const { buildCodexArgs } = await import("../src/engines/codex.js");
const { createFakeRuntime } = await import("./fixtures/fake-runtime-backend.js");
const { upsertChannelEntry, patchChannelMeta } = await import("../src/config/store.js");

const config = { enabled: true, sessionToken: "fake-perplexity-login-one" };
function target(channelId = "C_RESEARCH") {
  const t = createFakeRuntime().target();
  t.meta = { ...t.meta, channelId, allowNetwork: true };
  t.container = { ...t.container, home: "/home/agent", egress: { active: true, rawNetwork: false } };
  t.writes = [];
  t.runtime.writeHomeFile = async (_target, entry) => t.writes.push(entry);
  return t;
}
function enable() {
  saveSettings({ perplexityResearchEnabled: true, perplexitySessionToken: config.sessionToken });
}
async function storeTarget(t) {
  const entry = await upsertChannelEntry(t.meta.channelId, { name: t.meta.channelId, type: "channel", platform: "slack" });
  await patchChannelMeta(entry.slug, (meta) => ({ ...meta, allowNetwork: true }));
  return entry;
}

test("research login delivery contains only a stable channel-bound placeholder, never the session", async () => {
  enable();
  const t = target("C_RESEARCH_LOGIN");
  assert.equal(await installPerplexityResearchLogin(t), true);
  assert.equal(t.writes[0].file, "/home/agent/.config/perplexity-web-mcp/token");
  const placeholder = t.writes[0].body.trim();
  assert.match(placeholder, /^cgph_r[a-z2-7]{32}$/);
  assert.ok(!JSON.stringify(t.writes).includes(config.sessionToken));
  assert.equal(lookupGrant(placeholder).channelId, t.meta.channelId);
  assert.equal(lookupGrant(placeholder).secretName, PERPLEXITY_RELAY_SECRET_NAME);
  await installPerplexityResearchLogin(t);
  assert.equal(t.writes[1].body, t.writes[0].body);
  const second = target("C_RESEARCH_OTHER");
  await installPerplexityResearchLogin(second);
  assert.notEqual(second.writes[0].body, t.writes[0].body);
});

test("cookie relay resolves rotations live, disconnect revokes old grants and reconnect mints a new one", async () => {
  enable();
  const t = target("C_RESEARCH_ROTATE");
  const entry = await storeTarget(t);
  await installPerplexityResearchLogin(t);
  const placeholder = t.writes[0].body.trim();
  let grant = await resolveEgressGrant(placeholder);
  assert.equal(grant.value, config.sessionToken);
  assert.deepEqual(grant.hosts, [PERPLEXITY_HOST]);
  assert.deepEqual(grant.cookies, [PERPLEXITY_SESSION_COOKIE]);
  await patchChannelMeta(entry.slug, (meta) => ({ ...meta, allowNetwork: false }));
  assert.equal(await resolveEgressGrant(placeholder), null, "network-off pauses old login even if Perplexity is reachable as another selected MCP");
  assert.ok(lookupGrant(placeholder), "a policy pause is reversible and does not discard the saved login");
  await patchChannelMeta(entry.slug, (meta) => ({ ...meta, allowNetwork: true }));
  saveSettings({ perplexitySessionToken: "fake-perplexity-login-two" });
  grant = await resolveEgressGrant(placeholder);
  assert.equal(grant.value, "fake-perplexity-login-two", "no relay cache may serve the prior login");
  saveSettings({ perplexityResearchEnabled: false });
  assert.equal(await resolveEgressGrant(placeholder), null);
  enable();
  await installPerplexityResearchLogin(t);
  assert.notEqual(t.writes[1].body.trim(), placeholder);
  saveSettings({ perplexitySessionToken: "" });
  await installPerplexityResearchLogin(t);
  assert.equal(t.writes[2].body, "");
  assert.equal(lookupGrant(t.writes[1].body.trim()), null);
});

test("Perplexity cookie swaps only the named complete value on its TLS host and obeys liveness", async () => {
  enable();
  const t = target("C_RESEARCH_COOKIE");
  await storeTarget(t);
  await installPerplexityResearchLogin(t);
  const placeholder = t.writes[0].body.trim();
  const grant = await resolveEgressGrant(placeholder);
  const run = (cookie, options = {}) => swapHeaders({
    hostname: PERPLEXITY_HOST, headers: { host: PERPLEXITY_HOST, cookie },
    resolveGrant: (core) => core === placeholder ? grant : null,
    canUse: () => ({ ok: true }), ...options,
  });
  const cookie = `theme=dark; ${PERPLEXITY_SESSION_COOKIE}=${placeholder}; other=value`;
  const good = run(cookie);
  assert.equal(good.headers.cookie, cookie.replace(placeholder, config.sessionToken));
  assert.equal(good.scrub.get(config.sessionToken), placeholder);
  assert.equal(good.swapped.length, 1);
  for (const refused of [
    run(cookie, { hostname: "other.invalid", headers: { host: "other.invalid", cookie } }),
    run(cookie, { headers: { host: "other.invalid", cookie } }),
    run(cookie, { plainHttp: true }),
    run(cookie, { canUse: () => ({ ok: false, reason: "channel-mismatch" }) }),
    run(`wrong_cookie=${placeholder}`),
    run(`${PERPLEXITY_SESSION_COOKIE}=prefix-${placeholder}`),
    run(`${PERPLEXITY_SESSION_COOKIE}=${placeholder}; ${PERPLEXITY_SESSION_COOKIE}=another`),
    run(`${PERPLEXITY_SESSION_COOKIE}=${placeholder}; other=${placeholder}`),
  ]) {
    assert.equal(refused.swapped.length, 0);
    assert.ok(!JSON.stringify(refused.headers).includes(config.sessionToken));
    assert.ok(refused.refused.length);
  }
  const authorization = run("", { headers: { host: PERPLEXITY_HOST, authorization: `Bearer ${placeholder}` } });
  assert.equal(authorization.swapped.length, 0);
  const query = swapRequest({ headers: { host: PERPLEXITY_HOST }, hostname: PERPLEXITY_HOST,
    path: `/?session=${placeholder}`, resolveGrant: () => grant, canUse: () => ({ ok: true }) });
  assert.equal(query.swapped.length, 0);
  const injection = run(cookie, { resolveGrant: () => ({ ...grant, value: "bad; other=injected" }) });
  assert.equal(injection.headers.cookie, cookie);
  assert.equal(injection.swapped.length, 0);
});

test("research is omitted from clean, network-off, host, unprotected and unconfigured runs", async () => {
  enable();
  for (const t of [
    { ...target(), meta: { channelId: "C_RESEARCH_OFF", allowNetwork: false } },
    { ...target(), container: { egress: { active: false } } },
    { ...target(), meta: { allowNetwork: true } },
    { ...target(), runtime: {} },
  ]) {
    assert.deepEqual(perplexityResearchMcp(t), {});
    assert.equal(perplexityResearchPreamble(t), "");
    assert.equal(await installPerplexityResearchLogin(t), false);
    assert.deepEqual(t.writes, []);
  }
  const t = target();
  assert.deepEqual(perplexityResearchMcp(t, { clean: true }), {});
  assert.equal(await installPerplexityResearchLogin(t, { clean: true }), false);
  assert.deepEqual(t.writes, []);
  saveSettings({ perplexityResearchEnabled: false });
  assert.deepEqual(perplexityResearchMcp(t), {});
});

test("Claude and Codex receive the same credential-free managed MCP, including read-only permission", async () => {
  enable();
  const t = target();
  const input = { target: t, channelId: t.meta.channelId, slug: "research", authorId: "U_RESEARCH", threadKey: "1.2", origin: "slack_foreground" };
  for (const engine of ["claude", "codex"]) {
    const payload = await buildEngineMcpRuntime({ ...input, engine });
    const definition = JSON.parse(payload.mcpConfigJson).mcpServers[PERPLEXITY_MCP_NAME];
    assert.deepEqual(definition, { command: "/usr/local/bin/cg-perplexity-research", args: [] });
    assert.ok(!payload.mcpConfigJson.includes(config.sessionToken));
    assert.equal(payload.managedServers[0].toolTimeoutSec, 960);
    if (engine === "codex") {
      const args = buildCodexArgs({ target: t, prompt: "research", cwd: "/workspace", isNewSession: true, writable: false,
        codexMcpPolicy: { servers: payload.managedServers, apps: [] }, outFile: "/tmp/answer.txt" });
      assert.ok(args.includes('mcp_servers.perplexity-research.command="/usr/local/bin/cg-perplexity-research"'));
      assert.ok(args.includes("mcp_servers.perplexity-research.tool_timeout_sec=960"));
      assert.ok(args.includes('mcp_servers.perplexity-research.default_tools_approval_mode="approve"'));
    }
  }
  const settings = await buildSettings({ allowNetwork: true, mode: "read" }, { target: t });
  assert.ok(settings.allowedMcpServers.some((item) => item.serverName === PERPLEXITY_MCP_NAME));
  assert.ok(settings.permissions.allow.includes(`mcp__${PERPLEXITY_MCP_NAME}`));
  assert.ok(!settings.permissions.allow.includes("Bash"));
  assert.match(perplexityResearchPreamble(t), /research subagent/);
  assert.ok(!perplexityResearchPreamble(t).includes(config.sessionToken));
  const clean = await buildEngineMcpRuntime({ ...input, engine: "claude", clean: true });
  assert.deepEqual(JSON.parse(clean.mcpConfigJson), { mcpServers: {} });
  const off = await buildEngineMcpRuntime({ ...input, target: { ...t, meta: { ...t.meta, allowNetwork: false } } });
  assert.equal(JSON.parse(off.mcpConfigJson).mcpServers[PERPLEXITY_MCP_NAME], undefined);
  const leanSettings = await buildSettings({ cleanMode: true }, { target: t });
  assert.equal(leanSettings.allowedMcpServers.length, 0);
});
