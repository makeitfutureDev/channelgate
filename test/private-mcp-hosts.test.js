// Admin-approved private destinations for custom MCP connections (src/config/private-mcp-hosts.js):
// the list's normalization, the save-time and per-dial resolution (src/mcp/public-fetch.js
// resolveCustomMcpUrl), plain http only to an approved private host:port, the relay/registry
// acceptance of http for a custom MCP only, and the settings route's validation.
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { normalizePrivateMcpHost, normalizePrivateMcpHosts, readPrivateMcpHosts, privateMcpHostKey, PRIVATE_MCP_HOST_LIMIT } = await import("../src/config/private-mcp-hosts.js");
const { resolveCustomMcpUrl, createCustomMcpFetch, createPublicPinnedFetch } = await import("../src/mcp/public-fetch.js");
const { assertPublicCustomMcpUrl, customMcpRemotes } = await import("../src/gateway/custom-mcps.js");
const { remoteMcpServerProblem } = await import("../src/mcp/remote-mcp-registry.js");
const { validateRemoteUrl, connectRemoteClient } = await import("../src/mcp/remote-relay.js");

const lookupTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

test("an approved entry is one exact private host:port; anything wider is refused", () => {
  assert.equal(normalizePrivateMcpHost(" 192.168.130.33:10500 "), "192.168.130.33:10500");
  assert.equal(normalizePrivateMcpHost("10.0.0.5:80"), "10.0.0.5:80");
  assert.equal(normalizePrivateMcpHost("172.20.1.1:443"), "172.20.1.1:443");
  assert.equal(normalizePrivateMcpHost("[FD00:0::5]:8080"), "[fd00::5]:8080");
  assert.equal(normalizePrivateMcpHost("Rhino-WS.lan:10500"), "rhino-ws.lan:10500");
  for (const [bad, why] of [
    ["192.168.130.33", /host:port/],
    ["192.168.130.33:0", /port/],
    ["192.168.130.33:70000", /port/],
    ["127.0.0.1:4747", /loopback/],
    ["169.254.169.254:80", /metadata/],
    ["100.100.100.200:80", /carrier-grade/],
    ["8.8.8.8:443", /public/],
    ["[::1]:80", /loopback/],
    ["localhost:80", /valid host/],
    ["a.localhost:80", /valid host/],
    ["http://192.168.1.2:80", /host:port/],
    ["192.168.1.2:80/path", /host:port/],
  ]) assert.throws(() => normalizePrivateMcpHost(bad), why, bad);
});

test("a saved list refuses a bad entry; a stored list drops it", () => {
  assert.deepEqual(normalizePrivateMcpHosts(["192.168.1.2:80", "", "192.168.1.2:80", "10.1.1.1:9000"]), ["192.168.1.2:80", "10.1.1.1:9000"]);
  assert.throws(() => normalizePrivateMcpHosts(["192.168.1.2:80", "127.0.0.1:80"]), /loopback/);
  assert.throws(() => normalizePrivateMcpHosts("192.168.1.2:80"), /array/);
  assert.throws(() => normalizePrivateMcpHosts(Array.from({ length: PRIVATE_MCP_HOST_LIMIT + 1 }, (_, i) => `10.0.0.${i + 1}:80`)), /At most/);
  assert.deepEqual(readPrivateMcpHosts(["127.0.0.1:80", "192.168.1.2:80", 5, null]), ["192.168.1.2:80"]);
  assert.deepEqual(readPrivateMcpHosts(undefined), []);
  assert.equal(privateMcpHostKey(new URL("http://192.168.1.2/mcp")), "192.168.1.2:80");
  assert.equal(privateMcpHostKey(new URL("https://192.168.1.2/mcp")), "192.168.1.2:443");
  assert.equal(privateMcpHostKey(new URL("http://[fd00::5]:8080/")), "[fd00::5]:8080");
});

test("a custom MCP URL reaches a private address only on its exact approved host:port", async () => {
  const privateHosts = ["192.168.130.33:10500", "rhino.lan:10500"];
  const ok = await resolveCustomMcpUrl("http://192.168.130.33:10500/mcp", { privateHosts });
  assert.equal(ok.private, true);
  assert.deepEqual(ok.addresses, [{ address: "192.168.130.33", family: 4 }]);
  assert.equal((await resolveCustomMcpUrl("https://192.168.130.33:10500/mcp", { privateHosts })).private, true, "https to the approved port works too");
  // Another port on the same machine, or another LAN address, is not approved.
  await assert.rejects(resolveCustomMcpUrl("http://192.168.130.33:22/", { privateHosts }), /https/);
  await assert.rejects(resolveCustomMcpUrl("https://192.168.130.34:10500/", { privateHosts }), /private/);
  // No list: the public-only rule as before.
  await assert.rejects(resolveCustomMcpUrl("http://192.168.130.33:10500/mcp"), /https/);
  // An approved NAME must resolve to private addresses only — never a mix, never loopback/public.
  assert.equal((await resolveCustomMcpUrl("http://rhino.lan:10500/mcp", { privateHosts, lookup: lookupTo("192.168.130.33") })).private, true);
  await assert.rejects(resolveCustomMcpUrl("http://rhino.lan:10500/mcp", { privateHosts, lookup: lookupTo("127.0.0.1") }), /loopback/);
  await assert.rejects(resolveCustomMcpUrl("http://rhino.lan:10500/mcp", { privateHosts, lookup: lookupTo("192.168.130.33", "93.184.215.14") }), /public/);
  await assert.rejects(resolveCustomMcpUrl("http://rhino.lan:10500/mcp", { privateHosts, lookup: lookupTo("169.254.169.254") }), /metadata/);
  // A public https destination is unaffected by the list.
  assert.equal((await resolveCustomMcpUrl("https://mcp.example.com/mcp", { privateHosts, lookup: lookupTo("93.184.215.14") })).private, false);
  // The save-time check names the reason.
  assert.equal(await assertPublicCustomMcpUrl("http://192.168.130.33:10500/mcp", { privateHosts }), "http://192.168.130.33:10500/mcp");
  await assert.rejects(assertPublicCustomMcpUrl("http://192.168.130.33:10500/mcp"), /URL refused: must use https/);
});

function fakeRequest(seen, scheme) {
  return (url, options, onResponse) => {
    seen.push({ scheme, url: url.href, options });
    queueMicrotask(() => {
      const res = Readable.from([Buffer.from('{"ok":true}')]);
      res.statusCode = 200;
      res.statusMessage = "OK";
      res.rawHeaders = ["content-type", "application/json"];
      onResponse(res);
    });
    return { on() {}, write() {}, end() {} };
  };
}

test("the custom MCP fetch dials plain http only to an approved private destination, re-reading the list per request", async () => {
  const seen = [];
  let approved = ["192.168.130.33:10500"];
  const fetch = createCustomMcpFetch(() => approved, { requestImpl: fakeRequest(seen, "https"), httpRequestImpl: fakeRequest(seen, "http") });
  const response = await fetch("http://192.168.130.33:10500/mcp", { method: "POST", headers: { Authorization: "Bearer abc" }, body: "{}" });
  assert.equal(response.status, 200);
  assert.equal(seen[0].scheme, "http");
  assert.equal(seen[0].options.headers.authorization, "Bearer abc");
  const { globalAgent } = await import("node:http");
  assert.ok(seen[0].options.agent && seen[0].options.agent !== globalAgent, "never the global agent");
  approved = [];
  await assert.rejects(fetch("http://192.168.130.33:10500/mcp"), /https/, "a removed approval stops the next request");
  // The ordinary public fetch never speaks plain http, whatever its resolver says.
  const publicFetch = createPublicPinnedFetch({ resolve: async (href) => ({ url: new URL(href), addresses: [{ address: "93.184.215.14", family: 4 }] }), requestImpl: fakeRequest(seen, "https"), httpRequestImpl: fakeRequest(seen, "http") });
  await assert.rejects(publicFetch("http://mcp.example.com/mcp"), /HTTPS/);
});

test("http is relayable for a custom MCP only, and the relay hands it the private-aware fetch", async () => {
  const remotes = customMcpRemotes({ "custom-rhino": { url: "http://192.168.130.33:10500/mcp", token: "abcdefgh1234", authType: "bearer" } });
  assert.equal(remotes["custom-rhino"].publicOnly, true);
  assert.equal(remoteMcpServerProblem(remotes["custom-rhino"]), "");
  assert.match(remoteMcpServerProblem({ url: "http://192.168.130.33:10500/mcp", headers: {} }), /not https/, "a built-in remote stays https-only");
  assert.throws(() => validateRemoteUrl("http://192.168.130.33:10500/mcp"), /HTTPS/);
  assert.equal(validateRemoteUrl("http://192.168.130.33:10500/mcp", { allowHttp: true }).protocol, "http:");
  // publicOnly WITHOUT a private-host getter keeps refusing http before any dial.
  await assert.rejects(connectRemoteClient({ url: "http://192.168.130.33:10500/mcp", publicOnly: true, retryDelaysMs: [] }), /HTTPS/);
});

test("the settings route validates the list and the stored list is read leniently", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/web/routes/settings.js", import.meta.url), "utf8");
  assert.match(source, /patch\.privateMcpHosts = normalizePrivateMcpHosts\(body\.privateMcpHosts\)/);
  const { saveSettings, getPrivateMcpHosts, settingsForApi } = await import("../src/config/settings.js");
  await saveSettings({ privateMcpHosts: ["192.168.130.33:10500", "127.0.0.1:80"] });
  assert.deepEqual(getPrivateMcpHosts(), ["192.168.130.33:10500"], "a stored invalid entry is never trusted");
  assert.deepEqual(settingsForApi().privateMcpHosts, ["192.168.130.33:10500"]);
});
