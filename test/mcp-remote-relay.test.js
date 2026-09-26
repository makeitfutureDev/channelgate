// The HTTP leg of the `remote-mcp` relay (src/mcp/remote-relay.js): the daemon dials a real MCP
// server over Streamable HTTP with the registered headers, falls back to HTTP+SSE only on a 4xx,
// and serves the result on a socket-side transport. The relay insists on https, so the tests hand
// it an https URL plus a fetch that rewrites the request onto a loopback http server — exactly the
// bytes a real server would see, without a TLS fixture.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectRemoteClient, runRemoteRelay, validateRemoteUrl } from "../src/mcp/remote-relay.js";

function toolServer(seen) {
  const server = new Server({ name: "remote", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    seen.calls.push(request.params.arguments);
    return { content: [{ type: "text", text: `echo:${request.params.arguments?.v}` }] };
  });
  return server;
}

// mode "streamable": stateless Streamable HTTP on /mcp. mode "sse": POST /mcp answers 405 (an
// SSE-only server), GET /mcp opens the legacy stream, POST /messages carries client frames.
// mode "broken": every request is a 502.
async function startRemote(t, mode) {
  const seen = { headers: [], calls: [] };
  const sse = new Map();
  const httpServer = http.createServer(async (req, res) => {
    seen.headers.push({ method: req.method, path: req.url, key: req.headers["x-consumer-api-key"] || "", auth: req.headers.authorization || "" });
    if (mode === "broken") { res.writeHead(502).end("upstream says: key ck_leak"); return; }
    if (mode === "streamable" && req.url === "/mcp") {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = toolServer(seen);
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    if (mode === "sse" && req.url === "/mcp" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res);
      sse.set(transport.sessionId, transport);
      await toolServer(seen).connect(transport);
      return;
    }
    if (mode === "sse" && req.url.startsWith("/messages")) {
      const id = new URL(req.url, "http://x").searchParams.get("sessionId");
      await sse.get(id)?.handlePostMessage(req, res);
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  t.after(() => new Promise((resolve) => { httpServer.closeAllConnections?.(); httpServer.close(resolve); }));
  const fetchVia = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.href || input.url);
    assert.equal(url.protocol, "https:", "the relay only ever asks for https");
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  };
  return { seen, fetch: fetchVia };
}

test("the relay dials Streamable HTTP with the registered headers", async (t) => {
  const remote = await startRemote(t, "streamable");
  const client = await connectRemoteClient({ url: "https://remote.example/mcp", headers: { "x-consumer-api-key": "ck_http_secret" }, fetch: remote.fetch });
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["echo"]);
  assert.ok(remote.seen.headers.length > 0);
  assert.ok(remote.seen.headers.every((h) => h.key === "ck_http_secret"), "every request carries the header");
});

test("a 4xx from the Streamable endpoint falls back to HTTP+SSE, headers included", async (t) => {
  const remote = await startRemote(t, "sse");
  const client = await connectRemoteClient({ url: "https://remote.example/mcp", headers: { Authorization: "Bearer tb_sse_secret" }, fetch: remote.fetch });
  t.after(() => client.close());
  const result = await client.callTool({ name: "echo", arguments: { v: 7 } });
  assert.equal(result.content[0].text, "echo:7");
  assert.deepEqual(remote.seen.headers[0], { method: "POST", path: "/mcp", key: "", auth: "Bearer tb_sse_secret" }, "Streamable HTTP was tried first");
  assert.ok(remote.seen.headers.some((h) => h.method === "GET" && h.auth === "Bearer tb_sse_secret"), "the SSE stream carries the header");
  assert.ok(remote.seen.headers.some((h) => h.path.startsWith("/messages") && h.auth === "Bearer tb_sse_secret"), "and so does every SSE POST");
});

test("a 5xx is a failure, not a transport hint, and its message quotes nothing upstream", async (t) => {
  const remote = await startRemote(t, "broken");
  await assert.rejects(
    connectRemoteClient({ url: "https://remote.example/mcp", headers: { "x-consumer-api-key": "ck_leak" }, fetch: remote.fetch }),
    (error) => error.message === "remote MCP server unavailable",
  );
  assert.equal(remote.seen.headers.filter((h) => h.method === "GET").length, 0, "no SSE fallback on a 5xx");
});

test("only https URLs without embedded credentials are dialled", async () => {
  assert.throws(() => validateRemoteUrl("http://remote.example/mcp"), /HTTPS/);
  assert.throws(() => validateRemoteUrl("https://user:pw@remote.example/mcp"), /credentials/);
  assert.throws(() => validateRemoteUrl("not a url"), /valid URL/);
  await assert.rejects(connectRemoteClient({ url: "http://remote.example/mcp" }), /HTTPS/);
  assert.equal(validateRemoteUrl("https://eu1.make.com/mcp/server/abc").hostname, "eu1.make.com");
});

test("runRemoteRelay authorizes before dialling and on every forwarded request, and forwards progress", async (t) => {
  // A remote that reports progress on its tool call.
  const upstream = new Server({ name: "remote", version: "1.0.0" }, { capabilities: { tools: {} } });
  upstream.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "slow", inputSchema: { type: "object" } }] }));
  upstream.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const token = request.params._meta?.progressToken;
    if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2 } });
    return { content: [{ type: "text", text: "done" }] };
  });
  const [upClient, upServer] = InMemoryTransport.createLinkedPair();
  await upstream.connect(upServer);
  const remote = new Client({ name: "relay", version: "1.0.0" }, { capabilities: {} });
  await remote.connect(upClient);

  let allowed = true;
  let checks = 0;
  const authorize = () => { checks += 1; if (!allowed) throw new Error("remote MCP is not authorized for this run"); };
  const [engineSide, relaySide] = InMemoryTransport.createLinkedPair();
  await assert.rejects(runRemoteRelay({ url: "https://remote.example/mcp", transport: relaySide, authorize: () => { throw new Error("no"); }, remote }), /no/);
  const { close } = await runRemoteRelay({ url: "https://remote.example/mcp", transport: relaySide, authorize, remote });
  t.after(close);
  const engine = new Client({ name: "engine", version: "1.0.0" }, { capabilities: {} });
  await engine.connect(engineSide);
  const progress = [];
  const result = await engine.callTool({ name: "slow", arguments: {} }, undefined, { onprogress: (p) => progress.push(p) });
  assert.equal(result.content[0].text, "done");
  assert.deepEqual(progress, [{ progress: 1, total: 2 }], "upstream progress reaches the engine under its own token");
  const before = checks;
  await engine.listTools();
  assert.equal(checks, before + 1, "each forwarded request re-authorizes");
  allowed = false;
  await assert.rejects(engine.listTools(), /not authorized/);
  await engine.close();
});
