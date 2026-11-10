// Custom MCP connections (src/gateway/custom-mcps.js): a remote MCP server added by URL + Bearer
// token on a conversation (`custom-<name>`) or on a person (`my-<name>`). Covers the record rules,
// what a run receives, the Claude/Codex wiring, the daemon relay's public-address pinning, the
// per-server revocation, and the admin routes' write-only contract.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
import { createFakeRuntime } from "./fixtures/fake-runtime-backend.js";

ensureTestEnv();
process.env.CG_APPROVAL_SECRET = "custom-mcp-signing-secret";

const {
  CUSTOM_MCP_LIMIT,
  admitCustomMcpsInSettings,
  assertPublicCustomMcpUrl,
  customMcpRemotes,
  customMcpTokens,
  listCustomMcps,
  normalizeCustomMcpAuthType,
  normalizeCustomMcpName,
  normalizeCustomMcpToken,
  normalizeCustomMcpUrl,
  patchCustomMcps,
  resolveCustomMcpsForRun,
} = await import("../src/gateway/custom-mcps.js");
const { buildMcpRuntimePayload } = await import("../src/gateway/mcp.js");
const { verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const { lookupRemoteMcp, registerRemoteMcps, revokeRemoteMcpServer, clearRemoteMcps } = await import("../src/mcp/remote-mcp-registry.js");
const { createPublicPinnedFetch } = await import("../src/mcp/public-fetch.js");
const { runRemoteRelay } = await import("../src/mcp/remote-relay.js");
const { buildCodexArgs, codexSecretBundle } = await import("../src/engines/codex.js");
const { hostBackend } = await import("../src/runtimes/host.js");
const { buildSettings } = await import("../src/gateway/folders.js");
const { workspaceRoot } = await import("../src/config/paths.js");
const { allowedFsRoot } = await import("../src/web/security.js");

const PUBLIC = async () => [{ address: "93.184.215.14", family: 4 }];
const identity = {
  channelId: "C_CUSTOM",
  slug: "custom-mcp-test",
  authorId: "U_CUSTOM",
  threadKey: "1.000",
  origin: "slack_foreground",
  gatewayFsRoot: allowedFsRoot(),
  gatewayWorkspaceRoot: workspaceRoot(),
};

test("names, URLs and tokens are validated and normalized", () => {
  assert.equal(normalizeCustomMcpName("  Linear "), "linear");
  assert.equal(normalizeCustomMcpName("my-server-2"), "my-server-2");
  for (const bad of ["", "-x", "x-", "has space", "under_score", "a".repeat(33), "ünï"]) {
    assert.throws(() => normalizeCustomMcpName(bad), /Name must be/, bad);
  }
  assert.equal(normalizeCustomMcpUrl(" https://mcp.example.com/mcp "), "https://mcp.example.com/mcp");
  assert.throws(() => normalizeCustomMcpUrl("http://mcp.example.com/mcp"), /https/);
  assert.throws(() => normalizeCustomMcpUrl("https://user:pw@mcp.example.com/"), /username or password/);
  assert.throws(() => normalizeCustomMcpUrl("https://mcp.example.com/#x"), /fragment/);
  assert.throws(() => normalizeCustomMcpUrl("not a url"), /valid/);
  assert.equal(normalizeCustomMcpToken("Bearer abcdefgh123"), "abcdefgh123", "a pasted 'Bearer ' prefix is dropped");
  assert.throws(() => normalizeCustomMcpToken("short"), /at least/);
  assert.throws(() => normalizeCustomMcpToken("abc def ghi"), /spaces/);
  assert.throws(() => normalizeCustomMcpToken("abcdefgh\r\nX-Evil: 1"), /spaces|line breaks/);
});

test("the address check refuses loopback, private and metadata destinations", async () => {
  assert.equal(await assertPublicCustomMcpUrl("https://mcp.example.com/mcp", { lookup: PUBLIC }), "https://mcp.example.com/mcp");
  await assert.rejects(assertPublicCustomMcpUrl("https://127.0.0.1/mcp"), /URL refused: .*loopback/);
  await assert.rejects(assertPublicCustomMcpUrl("https://localhost/mcp"), /URL refused/);
  await assert.rejects(assertPublicCustomMcpUrl("https://169.254.169.254/mcp"), /URL refused/);
  await assert.rejects(
    assertPublicCustomMcpUrl("https://internal.example.com/mcp", { lookup: async () => [{ address: "10.1.2.3", family: 4 }] }),
    /URL refused: .*private/,
  );
  await assert.rejects(
    assertPublicCustomMcpUrl("https://mixed.example.com/mcp", { lookup: async () => [{ address: "93.184.215.14", family: 4 }, { address: "127.0.0.1", family: 4 }] }),
    /URL refused/, "ANY internal record refuses the host",
  );
});

test("patch upserts by name, keeps the token on a URL-only update, caps the list and masks every listing", () => {
  let list = patchCustomMcps([], { set: { name: "Linear", url: "https://mcp.linear.app/mcp", token: "lin_secret_1234" }, actor: "<@U1>", now: new Date("2026-10-01T00:00:00Z") });
  assert.deepEqual(list, [{ name: "linear", url: "https://mcp.linear.app/mcp", token: "lin_secret_1234", authType: "bearer", setBy: "<@U1>", setAt: "2026-10-01T00:00:00.000Z" }]);
  list = patchCustomMcps(list, { set: { name: "linear", url: "https://mcp.linear.app/v2" } });
  assert.equal(list[0].token, "lin_secret_1234", "an update without a token keeps the stored one");
  assert.equal(list[0].url, "https://mcp.linear.app/v2");
  assert.throws(() => patchCustomMcps(list, { set: { name: "other", url: "https://x.example.com/" } }), /token is required/);
  for (let i = 1; i < CUSTOM_MCP_LIMIT; i += 1) list = patchCustomMcps(list, { set: { name: `s${i}`, url: "https://x.example.com/", token: `token-${i}-abcdef` } });
  assert.equal(list.length, CUSTOM_MCP_LIMIT);
  assert.throws(() => patchCustomMcps(list, { set: { name: "overflow", url: "https://x.example.com/", token: "token-overflow" } }), /At most/);
  assert.equal(patchCustomMcps(list, { set: { name: "s1", url: "https://y.example.com/" } }).length, CUSTOM_MCP_LIMIT, "updating an existing entry is not blocked by the cap");
  list = patchCustomMcps(list, { remove: "s1" });
  assert.ok(!list.some((entry) => entry.name === "s1"));
  assert.throws(() => patchCustomMcps(list, { remove: "missing" }), /No custom MCP/);

  const masked = listCustomMcps(list, "channel");
  assert.deepEqual(masked[0], { name: "linear", serverName: "custom-linear", url: "https://mcp.linear.app/v2", authType: "bearer", hasToken: true, tokenLast4: "1234", setBy: "", setAt: masked[0].setAt });
  assert.ok(!JSON.stringify(masked).includes("lin_secret"), "the token never leaves in a listing");
  assert.equal(listCustomMcps(list, "user")[0].serverName, "my-linear");
});

test("a run gets the channel's servers, plus the author's own only when the author is trusted; Lean gets none", () => {
  const channelList = [{ name: "linear", url: "https://mcp.linear.app/mcp", token: "chan-token-1" }];
  const userList = [{ name: "notes", url: "https://notes.example.com/mcp", token: "user-token-2" }, { name: "bad", url: "ftp://x", token: "t-bad-12345" }];
  assert.deepEqual(resolveCustomMcpsForRun({ channelList, userList }), {
    "custom-linear": { url: "https://mcp.linear.app/mcp", token: "chan-token-1", authType: "bearer" },
    "my-notes": { url: "https://notes.example.com/mcp", token: "user-token-2", authType: "bearer" },
  });
  assert.deepEqual(Object.keys(resolveCustomMcpsForRun({ channelList, userList, principalTrusted: false })), ["custom-linear"]);
  assert.deepEqual(resolveCustomMcpsForRun({ channelList, userList, clean: true }), {});
  const runMap = resolveCustomMcpsForRun({ channelList, userList });
  assert.deepEqual(customMcpRemotes(runMap)["custom-linear"], { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer chan-token-1" }, publicOnly: true });
  assert.deepEqual(customMcpTokens(runMap).sort(), ["chan-token-1", "user-token-2"]);
});

test("a container run relays custom servers through the daemon with the public-only dial, never the token", async () => {
  const customMcps = { "custom-linear": { url: "https://mcp.linear.app/mcp", token: "relay-secret-123" }, "my-notes": { url: "https://notes.example.com/mcp", token: "relay-secret-456" } };
  const payload = await buildMcpRuntimePayload({ ...identity, customMcps, target: createFakeRuntime().target() });
  assert.doesNotMatch(payload.configJson, /relay-secret|Bearer/);
  const servers = JSON.parse(payload.configJson).mcpServers;
  assert.equal(servers["custom-linear"].env.CG_MCP_SERVICE, "remote-mcp");
  assert.deepEqual(servers["my-notes"].args.slice(-1), ["my-notes"]);
  const claims = verifyGatewayCapability(servers.gateway.env.CG_GATEWAY_CAPABILITY, { secret: process.env.CG_APPROVAL_SECRET }).claims;
  assert.deepEqual(claims.remoteMcps, ["custom-linear", "my-notes"]);
  assert.deepEqual(lookupRemoteMcp(claims.jti, "custom-linear"), { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer relay-secret-123" }, publicOnly: true });
  assert.ok(payload.relayDigest["my-notes"].startsWith("sha256:"), "a rotated token still retires a warm process");
  clearRemoteMcps(claims.jti);

  // Host turns use the same daemon relay, keeping all credentials out of artifacts.
  const host = JSON.parse((await buildMcpRuntimePayload({ ...identity, customMcps })).configJson).mcpServers;
  assert.equal(host["custom-linear"].env.CG_MCP_SERVICE, "remote-mcp");
  assert.doesNotMatch(JSON.stringify(host), /relay-secret/);
});

test("the Claude lockdown admits each custom server by name and URL and pre-approves its tools", async () => {
  const settings = admitCustomMcpsInSettings(await buildSettings({ _slug: "x" }), [{ name: "custom-linear", url: "https://mcp.linear.app/mcp" }]);
  assert.ok(settings.allowedMcpServers.some((m) => m.serverName === "custom-linear"));
  assert.ok(settings.allowedMcpServers.some((m) => m.serverUrl === "https://mcp.linear.app/mcp"));
  assert.ok(settings.permissions.allow.includes("mcp__custom-linear"));
  const fromMap = admitCustomMcpsInSettings({}, { "my-notes": { url: "https://notes.example.com/mcp", token: "t" } });
  assert.deepEqual(fromMap.allowedMcpServers, [{ serverName: "my-notes" }, { serverUrl: "https://notes.example.com/mcp" }]);
  assert.ok(!JSON.stringify(fromMap).includes('"t"'), "only names and URLs reach the settings file");
  const nameOnly = admitCustomMcpsInSettings({}, [{ name: "custom-q" }]);
  assert.deepEqual(nameOnly.allowedMcpServers, [{ serverName: "custom-q" }], "a container run's settings carry no URL");
});

test("Codex relays custom servers in a container and on the sudo host", () => {
  const target = createFakeRuntime().target();
  const customMcps = { "custom-linear": { url: "https://mcp.linear.app/mcp", token: "codex-secret-789" } };
  const bundle = `${target.artifactDir}/run/codex-secrets.json`;
  const args = buildCodexArgs({ prompt: "x", sessionId: "t", isNewSession: true, cwd: target.cwd, outFile: `${target.artifactDir}/tmp/o.txt`, target, customMcps, secretBundlePath: bundle, headerHelpers: [] });
  assert.ok(args.includes(`mcp_servers.custom-linear.env.CG_MCP_SERVICE="remote-mcp"`));
  assert.ok(!args.join("\n").includes("codex-secret-789"));
  assert.ok(!args.some((arg) => arg.startsWith("mcp_servers.custom-linear.url=")));
  assert.deepEqual(codexSecretBundle({ isolated: true, gatewayCapability: "cap", customMcps }), { gatewayCapability: "cap" }, "a container's bundle holds no custom token");

  const host = hostBackend.prepareTarget({ slug: "sudo", cwd: "/work", workDir: "/work", cleanWorkDir: "", meta: { sudoMode: true }, settings: {} });
  const helpers = [];
  const hostArgs = buildCodexArgs({ prompt: "x", sessionId: "t", isNewSession: true, cwd: "/work", outFile: "/tmp/o.txt", target: host, customMcps, secretBundlePath: "/tmp/b.json", headerHelpers: helpers });
  assert.ok(hostArgs.includes(`mcp_servers.custom-linear.env.CG_MCP_SERVICE="remote-mcp"`));
  assert.deepEqual(helpers, []);
  assert.equal(codexSecretBundle({ customMcps })["customMcp:custom-linear"], undefined);
  const clean = buildCodexArgs({ prompt: "x", sessionId: "t", isNewSession: true, cwd: "/work", outFile: "/tmp/o.txt", target: host, clean: true, customMcps, secretBundlePath: "/tmp/b.json", headerHelpers: [] });
  assert.ok(!clean.some((arg) => arg.includes("custom-linear")));
});

test("the public-only fetch pins the connection to the vetted records and never follows a redirect", async () => {
  const seen = [];
  const requestImpl = (url, options, onResponse) => {
    seen.push({ url: url.href, options });
    const listeners = {};
    queueMicrotask(() => {
      options.lookup(url.hostname, { all: true }, (err, records) => seen.push({ records }));
      const { Readable } = process.getBuiltinModule("node:stream");
      const res = Readable.from([Buffer.from('{"ok":true}')]);
      res.statusCode = url.pathname === "/redirect" ? 302 : 200;
      res.statusMessage = "OK";
      res.rawHeaders = ["content-type", "application/json", ...(url.pathname === "/redirect" ? ["location", "https://127.0.0.1/"] : [])];
      onResponse(res);
    });
    return { on: (event, fn) => { listeners[event] = fn; }, write: (body) => seen.push({ body }), end() {} };
  };
  const fetch = createPublicPinnedFetch({ resolve: async (href) => ({ url: new URL(href), addresses: [{ address: "93.184.215.14", family: 4 }] }), requestImpl });
  const response = await fetch("https://mcp.example.com/mcp", { method: "POST", headers: { Authorization: "Bearer abc", "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(seen[0].options.method, "POST");
  assert.equal(seen[0].options.headers.authorization, "Bearer abc");
  const { globalAgent } = await import("node:https");
  assert.ok(seen[0].options.agent && seen[0].options.agent !== globalAgent, "never the global agent, which may tunnel through HTTPS_PROXY");
  assert.deepEqual(seen.find((entry) => entry.records).records, [{ address: "93.184.215.14", family: 4 }]);
  const redirected = await fetch("https://mcp.example.com/redirect");
  assert.equal(redirected.status, 302, "a redirect is handed back, not followed");

  const refusing = createPublicPinnedFetch({ resolve: async () => { throw new Error("mcp.example.com resolves to a private address"); }, requestImpl });
  await assert.rejects(refusing("https://mcp.example.com/mcp"), /private address/);
});

test("the relay asks for the public-only dial exactly when the registration says so", async () => {
  const calls = [];
  const connect = async (options) => {
    calls.push(options);
    throw new Error("stop here");
  };
  for (const publicOnly of [true, false]) {
    await assert.rejects(runRemoteRelay({ url: "https://mcp.example.com/mcp", headers: {}, publicOnly, transport: {}, authorize: () => {}, connect }), /stop here/);
  }
  assert.equal(calls[0].publicOnly, true);
  assert.equal(Object.hasOwn(calls[1], "publicOnly"), false);
});

test("revoking one custom server leaves the rest of a live grant untouched", () => {
  const exp = Date.now() + 60_000;
  registerRemoteMcps({ jti: "jti-a", exp, servers: { "composio-user": { url: "https://c.example.com/", headers: {} }, "custom-linear": { url: "https://l.example.com/", headers: {}, publicOnly: true } }, meta: { slug: "chan-a", authorId: "U1" } });
  registerRemoteMcps({ jti: "jti-b", exp, servers: { "custom-linear": { url: "https://l.example.com/", headers: {}, publicOnly: true } }, meta: { slug: "chan-b", authorId: "U1" } });
  assert.equal(revokeRemoteMcpServer((meta) => meta.slug === "chan-a", "custom-linear"), 1);
  assert.equal(lookupRemoteMcp("jti-a", "custom-linear"), null);
  assert.ok(lookupRemoteMcp("jti-a", "composio-user"), "the other servers keep working");
  assert.ok(lookupRemoteMcp("jti-b", "custom-linear"), "another channel's grant is untouched");
  clearRemoteMcps("jti-a");
  clearRemoteMcps("jti-b");
});

// ── Admin routes ────────────────────────────────────────────────────────────────────────────────
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { defaultChannelMeta, getChannelMeta, getUser, saveChannelMeta, setUser, upsertChannelEntry } = await import("../src/config/store.js");
const entry = await upsertChannelEntry("C_CMCP", { name: "custom-mcp-routes", type: "channel", isDM: false });
await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: "C_CMCP", name: "custom-mcp-routes", type: "channel", isDM: false }));
await setUser("U_CMCP", { name: "Custom Person", approved: true });
const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;
async function call(path, { method = "GET", body } = {}) {
  const response = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() };
}

// A literal public address needs no DNS, so the save path's address check runs for real offline.
const PUBLIC_URL = "https://93.184.215.14/mcp";

test("channel routes save write-only, refuse internal addresses, mask every listing and remove", async () => {
  const saved = await call("/channels/C_CMCP/custom-mcps/Linear", { method: "PUT", body: { url: PUBLIC_URL, token: "chan-route-secret-9876" } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.servers.map((s) => [s.serverName, s.tokenLast4]), [["custom-linear", "9876"]]);
  assert.equal((await getChannelMeta(entry.slug)).customMcps[0].token, "chan-route-secret-9876");

  const listed = await call("/channels");
  const channel = listed.json.channels.find((item) => item.channelId === "C_CMCP");
  assert.equal(channel.meta.customMcps[0].serverName, "custom-linear");
  assert.ok(!JSON.stringify(listed.json).includes("chan-route-secret"), "the channel list never carries the token");
  assert.ok(!JSON.stringify(await call("/channels/C_CMCP/custom-mcps")).includes("chan-route-secret"));

  const loop = await call("/channels/C_CMCP/custom-mcps/evil", { method: "PUT", body: { url: "https://127.0.0.1:4747/api", token: "abcdefgh1234" } });
  assert.equal(loop.status, 400);
  assert.match(loop.json.error, /refused/);
  const plain = await call("/channels/C_CMCP/custom-mcps/evil", { method: "PUT", body: { url: "http://93.184.215.14/", token: "abcdefgh1234" } });
  assert.equal(plain.status, 400);

  const urlOnly = await call("/channels/C_CMCP/custom-mcps/linear", { method: "PUT", body: { url: "https://93.184.215.14/v2" } });
  assert.equal(urlOnly.status, 200);
  assert.equal((await getChannelMeta(entry.slug)).customMcps[0].token, "chan-route-secret-9876");

  const removed = await call("/channels/C_CMCP/custom-mcps/linear", { method: "DELETE" });
  assert.deepEqual(removed.json.servers, []);
  assert.equal((await call("/channels/NOPE/custom-mcps")).status, 404);
});

test("user routes keep a person's servers on their record, masked in the user list", async () => {
  const saved = await call("/users/U_CMCP/custom-mcps/notes", { method: "PUT", body: { url: PUBLIC_URL, token: "user-route-secret-5555" } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.servers[0].serverName, "my-notes");
  assert.equal((await getUser("U_CMCP")).customMcps[0].token, "user-route-secret-5555");
  const users = await call("/users");
  const flat = JSON.stringify(users.json);
  assert.ok(flat.includes("my-notes"));
  assert.ok(!flat.includes("user-route-secret"), "the user list never carries the token");
  const removed = await call("/users/U_CMCP/custom-mcps/notes", { method: "DELETE" });
  assert.deepEqual(removed.json.servers, []);
  assert.equal((await call("/users/U_CMCP/custom-mcps/notes", { method: "DELETE" })).status, 400);
});


test("Composio authentication persists, survives partial updates and rejects unknown types", () => {
  assert.equal(normalizeCustomMcpAuthType(), "bearer");
  for (const authType of [null, "", "oauth", "x-consumer-api-key", {}, ["composio"]]) {
    assert.throws(() => normalizeCustomMcpAuthType(authType), /Authentication type/);
  }
  let list = patchCustomMcps([], { set: { name: "second", url: PUBLIC_URL, token: "ck_second_test_1234", authType: "composio" } });
  assert.equal(list[0].authType, "composio");
  list = patchCustomMcps(list, { set: { name: "second", url: `${PUBLIC_URL}/v2` } });
  assert.equal(list[0].authType, "composio", "omitting authentication preserves the saved type");
  assert.equal(list[0].token, "ck_second_test_1234");
  assert.equal(listCustomMcps(list, "channel")[0].authType, "composio");
  assert.equal(listCustomMcps(list, "user")[0].authType, "composio");
  assert.throws(() => patchCustomMcps(list, { set: { name: "second", url: PUBLIC_URL, authType: "evil" } }), /Authentication type/);
  assert.throws(() => normalizeCustomMcpToken("Bearer ck_second_test_1234", "composio"), /spaces/);
  assert.throws(() => normalizeCustomMcpToken("ck_second\r\nx-evil: foo", "composio"), /spaces|line breaks/);
  const legacy = [{ name: "legacy", url: PUBLIC_URL, token: "old-test-token-5555" }];
  assert.equal(listCustomMcps(legacy, "channel")[0].authType, "bearer");
  assert.deepEqual(resolveCustomMcpsForRun({ channelList: [{ ...list[0], authType: "evil" }] }), {}, "invalid stored authentication is not dialled");
  list = patchCustomMcps(list, { set: { name: "second", url: PUBLIC_URL, authType: "bearer" } });
  assert.equal(list[0].token, "ck_second_test_1234", "auth-only edit retains the credential");
  assert.equal(list[0].authType, "bearer");
});

test("Composio consumer keys select one header for both engines and stay out of container artifacts", async () => {
  const channelList = [{ name: "second", url: PUBLIC_URL, token: "ck_channel_test_7777", authType: "composio" }];
  const userList = [{ name: "personal", url: PUBLIC_URL, token: "ck_personal_test_8888", authType: "composio" }];
  const customMcps = resolveCustomMcpsForRun({ channelList, userList });
  const remotes = customMcpRemotes(customMcps);
  assert.deepEqual(remotes["custom-second"].headers, { "x-consumer-api-key": channelList[0].token });
  assert.deepEqual(remotes["my-personal"].headers, { "x-consumer-api-key": userList[0].token });
  assert.equal(remotes["custom-second"].publicOnly, true);
  const target = createFakeRuntime().target();
  const payload = await buildMcpRuntimePayload({ ...identity, customMcps, target });
  assert.doesNotMatch(payload.configJson, /ck_channel|ck_personal|x-consumer-api-key/);
  const config = JSON.parse(payload.configJson).mcpServers;
  const claims = verifyGatewayCapability(config.gateway.env.CG_GATEWAY_CAPABILITY, { secret: process.env.CG_APPROVAL_SECRET }).claims;
  assert.deepEqual(lookupRemoteMcp(claims.jti, "custom-second"), remotes["custom-second"]);
  clearRemoteMcps(claims.jti);
  const bearerPayload = await buildMcpRuntimePayload({ ...identity, customMcps: { "custom-second": { ...customMcps["custom-second"], authType: "bearer" } }, target });
  assert.notEqual(payload.relayDigest["custom-second"], bearerPayload.relayDigest["custom-second"], "auth changes retire the warm process");
  const bearerClaims = verifyGatewayCapability(JSON.parse(bearerPayload.configJson).mcpServers.gateway.env.CG_GATEWAY_CAPABILITY, { secret: process.env.CG_APPROVAL_SECRET }).claims;
  clearRemoteMcps(bearerClaims.jti);
  const host = JSON.parse((await buildMcpRuntimePayload({ ...identity, customMcps })).configJson).mcpServers;
  assert.equal(host["custom-second"].env.CG_MCP_SERVICE, "remote-mcp");
  assert.doesNotMatch(JSON.stringify(host), /ck_channel|ck_personal/);
  for (const runtime of [target, hostBackend.prepareTarget({ slug: "sudo", cwd: "/work", workDir: "/work", cleanWorkDir: "", meta: { sudoMode: true }, settings: {} })]) {
    const helpers = [];
    const args = buildCodexArgs({ prompt: "x", sessionId: "t", isNewSession: true, cwd: runtime.cwd || "/work", outFile: "/tmp/out.txt", target: runtime, customMcps, secretBundlePath: "/tmp/test-bundle.json", headerHelpers: helpers });
    assert.doesNotMatch(JSON.stringify(args), /ck_channel|ck_personal/);
    if (runtime === target) {
      assert.deepEqual(helpers, []);
      assert.deepEqual(codexSecretBundle({ isolated: true, gatewayCapability: "cap", customMcps }), { gatewayCapability: "cap" });
    } else {
      assert.deepEqual(helpers, []);
    }
  }
});

test("both admin API scopes accept Composio, preserve auth on partial saves and reject invalid auth", async () => {
  for (const scopePath of ["/channels/C_CMCP", "/users/U_CMCP"]) {
    const path = `${scopePath}/custom-mcps/second`;
    const saved = await call(path, { method: "PUT", body: { url: PUBLIC_URL, token: "ck_api_test_3333", authType: "composio" } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.servers[0].authType, "composio");
    assert.ok(!JSON.stringify(saved.json).includes("ck_api_test"));
    const updated = await call(path, { method: "PUT", body: { url: `${PUBLIC_URL}/changed` } });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.servers[0].authType, "composio");
    for (const authType of ["invalid", null, 42]) {
      const invalid = await call(path, { method: "PUT", body: { url: PUBLIC_URL, authType } });
      assert.equal(invalid.status, 400);
      assert.match(invalid.json.error, /Authentication type/);
    }
    assert.equal((await call(`${scopePath}/custom-mcps`)).json.servers[0].authType, "composio");
    await call(path, { method: "DELETE" });
  }
});


test("custom headers and query fields are write-only, merged by name, cleared explicitly and materialized only by the relay", () => {
  let list = patchCustomMcps([], { set: { name: "generic", url: PUBLIC_URL, authType: "custom",
    headers: [{ name: "x-consumer-api-key", value: "second-key-test" }, { name: "X-Tenant", value: "abc" }],
    queryParams: [{ name: "api_key", value: "private + /&é" }],
  } });
  const masked = listCustomMcps(list, "channel")[0];
  assert.equal(masked.hasToken, false);
  assert.deepEqual(masked.headers, [{ name: "x-consumer-api-key", hasValue: true, valueLast4: "test" }, { name: "X-Tenant", hasValue: true, valueLast4: "" }]);
  assert.doesNotMatch(JSON.stringify(masked), /second-key|private|"abc"/);
  list = patchCustomMcps(list, { set: { name: "generic", url: PUBLIC_URL,
    headers: [{ name: "X-Consumer-Api-Key", value: "" }], queryParams: [{ name: "api_key" }],
  } });
  assert.deepEqual(list[0].headers, [{ name: "X-Consumer-Api-Key", value: "second-key-test" }]);
  const run = resolveCustomMcpsForRun({ channelList: list });
  assert.equal(run["custom-generic"].url, PUBLIC_URL, "run map retains the base URL");
  const remote = customMcpRemotes(run)["custom-generic"];
  assert.deepEqual(remote.headers, { "X-Consumer-Api-Key": "second-key-test" });
  assert.equal(remote.url, PUBLIC_URL + "?api_key=private+%2B+%2F%26%C3%A9");
  const redactions = customMcpTokens(run);
  for (const value of ["second-key-test", "private + /&é", "private%20%2B%20%2F%26%C3%A9", "private+%2B+%2F%26%C3%A9"]) assert.ok(redactions.includes(value));
  list = patchCustomMcps(list, { set: { name: "generic", url: PUBLIC_URL } });
  assert.equal(list[0].headers.length, 1, "omitted arrays retain existing fields");
  list = patchCustomMcps(list, { set: { name: "generic", url: PUBLIC_URL, headers: [], queryParams: [] } });
  assert.deepEqual(customMcpRemotes(resolveCustomMcpsForRun({ channelList: list }))["custom-generic"], { url: PUBLIC_URL, headers: {}, publicOnly: true });
});

test("generic request configuration rejects transport overrides, injection, duplicates and oversized effective URLs without echoing secrets", () => {
  const baseSet = { name: "generic", url: PUBLIC_URL, authType: "custom" };
  const patch = (set) => patchCustomMcps([], { set: { ...baseSet, ...set } });
  for (const name of ["Host", "Content-Length", "Connection", "Transfer-Encoding", "TE", "Trailer", "Upgrade", "Proxy-Authorization", "Expect", "Accept", "Content-Type", "MCP-Session-Id", "MCP-Protocol-Version", "Last-Event-ID", "bad name", "x".repeat(129)]) {
    assert.throws(() => patch({ headers: [{ name, value: "private-secret-value" }] }), (error) => !error.message.includes("private-secret-value"));
  }
  for (const value of ["secret\r\nInjected: 1", "secret\tvalue", "secret\x00value", "secret\x7fvalue", "secret😀", "s".repeat(8193)]) assert.throws(() => patch({ headers: [{ name: "X-Key", value }] }));
  assert.throws(() => patch({ headers: [{ name: "X-Key", value: "first" }, { name: "x-key", value: "second" }] }), /unique/);
  assert.throws(() => patch({ headers: [{ name: "X-Key", value: "" }] }), /required/);
  assert.throws(() => patch({ queryParams: [{ name: "api_key" }] }), /required/);
  for (const name of ["", "a&b", "a=b", "a#b", "a\nb", "x".repeat(129)]) assert.throws(() => patch({ queryParams: [{ name, value: "private-secret-value" }] }));
  assert.throws(() => patch({ queryParams: [{ name: "a", value: "x" }, { name: "a", value: "y" }] }), /unique/);
  assert.throws(() => patch({ url: PUBLIC_URL + "?a=saved", queryParams: [{ name: "a", value: "new" }] }), /duplicates/);
  assert.throws(() => patch({ queryParams: [{ name: "a", value: "secret\nvalue" }] }), /controls/);
  assert.throws(() => patch({ queryParams: [{ name: "a", value: "é".repeat(400) }] }), /2048/);
  assert.throws(() => patch({ headers: Array.from({ length: 17 }, (_, i) => ({ name: `X-${i}`, value: "v" })) }), /16/);
  assert.throws(() => patch({ queryParams: Array.from({ length: 17 }, (_, i) => ({ name: `k${i}`, value: "v" })) }), /16/);
  for (const [authType, name] of [["bearer", "authorization"], ["composio", "X-Consumer-Api-Key"]]) {
    assert.throws(() => patch({ authType, token: "preset-token-test", headers: [{ name, value: "collision" }] }), /duplicates/);
    assert.throws(() => patch({ authType, token: "preset-token-test", headers: Array.from({ length: 16 }, (_, i) => ({ name: `X-${i}`, value: "v" })) }), /16/);
  }
  const bad = { name: "bad", url: PUBLIC_URL, authType: "custom", headers: [{ name: "Host", value: "evil" }] };
  assert.deepEqual(resolveCustomMcpsForRun({ channelList: [bad] }), {});
  assert.deepEqual(customMcpRemotes({ bad }), {});
  const combined = patch({ authType: "composio", token: "preset-token-test", headers: [{ name: "X-Tenant", value: "tenant" }], queryParams: [{ name: "key", value: "secret" }] });
  assert.deepEqual(customMcpRemotes(resolveCustomMcpsForRun({ channelList: combined }))["custom-generic"].headers, { "X-Tenant": "tenant", "x-consumer-api-key": "preset-token-test" });
});

test("both API scopes accept generic request fields, mask values and preserve or clear saved fields", async () => {
  for (const scopePath of ["/channels/C_CMCP", "/users/U_CMCP"]) {
    const path = `${scopePath}/custom-mcps/generic`;
    const saved = await call(path, { method: "PUT", body: { url: PUBLIC_URL, authType: "custom", headers: [{ name: "X-Key", value: "api-header-secret" }], queryParams: [{ name: "key", value: "api-query-secret" }] } });
    assert.equal(saved.status, 200);
    assert.doesNotMatch(JSON.stringify(saved.json), /api-header|api-query/);
    const edited = await call(path, { method: "PUT", body: { url: PUBLIC_URL, headers: [{ name: "x-key", value: "" }] } });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.servers[0].queryParams[0].hasValue, true);
    assert.equal(edited.json.servers[0].headers[0].valueLast4, "cret");
    const invalid = await call(path, { method: "PUT", body: { url: PUBLIC_URL, headers: [{ name: "Connection", value: "api-header-secret" }] } });
    assert.equal(invalid.status, 400);
    assert.doesNotMatch(JSON.stringify(invalid.json), /api-header-secret/);
    const cleared = await call(path, { method: "PUT", body: { url: PUBLIC_URL, headers: [], queryParams: [] } });
    assert.deepEqual(cleared.json.servers[0].headers, []);
    assert.deepEqual(cleared.json.servers[0].queryParams, []);
    await call(path, { method: "DELETE" });
  }
});
