// The daemon-hosted MCP socket (src/mcp/socket-server.js) — the container half of the gateway
// control plane. Everything here runs over a REAL unix socket with a REAL MCP client, because the
// point of this path is that a container reaches the control plane with nothing but a bearer: no
// database, no config dir, no loopback port, no shared secret.
//
// Socket paths are capped at ~108 bytes by the kernel, and os.tmpdir() can already be most of that
// on a sandboxed CI box, so every socket here lives in a SHORT mkdtemp directly under /tmp.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureTestEnv, trackTempDir } from "./helpers.js";

const scratch = ensureTestEnv();
process.env.CG_APPROVAL_SECRET = "mcp-socket-signing-secret";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { mintGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const { startMcpSocketServer, stopMcpSocketServer, mcpSocketStatus } = await import("../src/mcp/socket-server.js");

const SECRET = "mcp-socket-signing-secret";
const SLUG = "mcp-socket-test";
const CHANNEL = "C_MCP_SOCKET";
const AUTHOR = "U_SOCKET_ADMIN";
const BRIDGE = fileURLToPath(new URL("../src/mcp/socket-bridge.js", import.meta.url));

const sockDirs = [];
function shortSocketDir() {
  // Deliberately NOT under the scratch TMPDIR: a unix socket path is capped at ~108 bytes and the
  // scratch root is already long. Registered for the exit-handler cleanup in helpers.js so a
  // crashed run does not leave it behind either (the `after` hook below only runs on a clean end).
  const dir = trackTempDir(mkdtempSync("/tmp/cgsock-"));
  sockDirs.push(dir);
  return dir;
}

function capability({ secret = SECRET, toolset = "", progressReport = false, author = AUTHOR, threadKey = "1700000000.000100", ttlMs } = {}) {
  return mintGatewayCapability({
    secret,
    channelId: CHANNEL,
    slug: SLUG,
    authorId: author,
    threadKey,
    origin: "slack_foreground",
    engine: "claude",
    toolset,
    progressReport,
    ...(ttlMs ? { ttlMs } : {}),
  });
}

// A raw client: connect, send one line, collect whatever comes back before the close.
function rawExchange(socketPath, line) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let out = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(line));
    socket.on("data", (chunk) => { out += chunk; });
    socket.on("close", () => resolve(out));
    socket.on("error", reject);
  });
}

// One listener per test, torn down with the test: the module keeps a single active server, so a
// leaked one from a failed test would silently serve the next test's assertions.
async function serverOn(t, handlers = {}) {
  const dir = shortSocketDir();
  const socketPath = path.join(dir, "mcp.sock");
  const active = await startMcpSocketServer({ handlers, socketPath, dir, log: { log() {}, warn() {} } });
  assert.ok(active, "the socket server must bind under a short /tmp path");
  t.after(() => stopMcpSocketServer());
  return socketPath;
}

test.before(async () => {
  await setUser(AUTHOR, { name: "Socket Admin", approved: true, isAdmin: true });
  await upsertChannelEntry(CHANNEL, { name: SLUG, type: "channel", isDM: false });
  await saveChannelMeta(SLUG, { channelId: CHANNEL, platform: "slack", allowBash: false, adminMode: false });
});

test.after(async () => {
  await stopMcpSocketServer().catch(() => {});
  for (const dir of sockDirs) rmSync(dir, { recursive: true, force: true });
});

test("the socket is 0600 inside a 0700 directory and reports itself", async (t) => {
  const socketPath = await serverOn(t);
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
  assert.deepEqual(mcpSocketStatus(), { listening: true, path: socketPath });
  await stopMcpSocketServer();
  assert.equal(mcpSocketStatus().listening, false);
});

test("a malformed or unsupported hello is refused with one JSON line, then closed", async (t) => {
  const socketPath = await serverOn(t);
  const bad = await rawExchange(socketPath, "not json at all\n");
  assert.deepEqual(JSON.parse(bad.trim()), { channelgate: "error", reason: "malformed hello" });

  const wrongVersion = await rawExchange(socketPath, `${JSON.stringify({ channelgate: "hello", v: 2, service: "gateway", cap: capability() })}\n`);
  assert.match(JSON.parse(wrongVersion.trim()).reason, /unsupported hello/);

  const wrongService = await rawExchange(socketPath, `${JSON.stringify({ channelgate: "hello", v: 1, service: "shell", cap: capability() })}\n`);
  assert.match(JSON.parse(wrongService.trim()).reason, /unsupported service/);
});

test("a capability this daemon did not sign is rejected — a bearer is the only authority here", async (t) => {
  const socketPath = await serverOn(t);
  for (const [label, cap] of [
    ["someone else's secret", capability({ secret: "a-different-daemons-secret" })],
    ["no capability at all", ""],
    ["an expired grant", capability({ ttlMs: 1 })],
  ]) {
    await new Promise((r) => setTimeout(r, 5)); // let the 1 ms TTL actually lapse
    const answer = await rawExchange(socketPath, `${JSON.stringify({ channelgate: "hello", v: 1, service: "gateway", cap })}\n`);
    const frame = JSON.parse(answer.trim());
    assert.equal(frame.channelgate, "error", label);
    assert.match(frame.reason, /capability rejected/, label);
  }
});

// The end-to-end shape a container actually uses: the engine spawns cg-mcp-bridge as an ordinary
// stdio MCP server, the bridge dials the socket, and the MCP client never learns the difference.
async function withBridgeClient(socketPath, env, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE],
    stderr: "pipe",
    env: {
      PATH: process.env.PATH || "",
      CG_MCP_SOCKET: socketPath,
      ...env,
    },
  });
  const client = new Client({ name: "mcp-socket-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

test("the reference bridge carries a full stdio↔socket MCP session, toolset from the bearer alone", async (t) => {
  const socketPath = await serverOn(t);

  // Full control plane: the ordinary run.
  const full = await withBridgeClient(socketPath, { CG_GATEWAY_CAPABILITY: capability(), CG_ENGINE: "claude" }, async (client) => {
    assert.equal(client.getServerVersion()?.name, "channelgate");
    return (await client.listTools()).tools.map((t) => t.name);
  });
  assert.ok(full.includes("set_channel_bash"), "the full surface registers the channel-admin tools");
  assert.ok(full.includes("update_channel_memory"));
  assert.ok(full.length > 20, `expected the whole control plane, got ${full.length}`);
  // progressReport is off unless the grant says otherwise — no env reaches the daemon here.
  assert.ok(!full.includes("report_progress"));

  // The SIGNED toolset alone reduces the surface. Nothing in the bridge's environment says
  // "memory-review" — the daemon reads it out of the capability.
  const reduced = await withBridgeClient(socketPath, { CG_GATEWAY_CAPABILITY: capability({ toolset: "memory-review" }) }, async (client) =>
    (await client.listTools()).tools.map((t) => t.name));
  assert.deepEqual(reduced, ["update_channel_memory"]);

  const withProgress = await withBridgeClient(socketPath, { CG_GATEWAY_CAPABILITY: capability({ progressReport: true }) }, async (client) =>
    (await client.listTools()).tools.map((t) => t.name));
  assert.ok(withProgress.includes("report_progress"));
});

test("a bridge whose bearer is refused says why on stderr instead of emitting a broken frame", async (t) => {
  const socketPath = await serverOn(t);
  const child = spawn(process.execPath, [BRIDGE], {
    env: { PATH: process.env.PATH || "", CG_MCP_SOCKET: socketPath, CG_GATEWAY_CAPABILITY: capability({ secret: "wrong" }) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let err = "";
  let out = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (c) => { err += c; });
  child.stdout.on("data", (c) => { out += c; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 1);
  assert.match(err, /refused this run/);
  assert.match(err, /capability rejected/);
  assert.equal(out, "", "a refusal must never reach the engine's stdin as MCP traffic");
});

test("tools run against the DAEMON's own handlers — no loopback port, no shared secret", async (t) => {
  const calls = [];
  const socketPath = await serverOn(t, {
    background: (body) => { calls.push(["background", body]); return { ok: true, id: "job-7", label: body.label || "job" }; },
    approval: (body) => { calls.push(["approval", body]); return { allow: true, reason: "Approved by test", decidedBy: AUTHOR }; },
    restart: (body) => { calls.push(["restart", body]); return { ok: true, id: "restart-1", waitMs: 60_000 }; },
  });

  const cap = capability({ threadKey: "1700000000.000100" });
  const answers = await withBridgeClient(socketPath, { CG_GATEWAY_CAPABILITY: cap }, async (client) => ({
    approval: await client.callTool({ name: "request_approval", arguments: { details: "ship it?" } }),
    // A control-plane tool: the approval gate ALSO goes through the injected handler, and the
    // handler's allow:true is what lets the change land.
    bash: await client.callTool({ name: "set_channel_bash", arguments: { enabled: true } }),
  }));
  const textOf = (r) => r.content?.map((i) => i.text || "").join("\n") || "";
  assert.deepEqual(JSON.parse(textOf(answers.approval)), { approved: true, feedback: "Approved by test", decided_by: AUTHOR });
  assert.match(textOf(answers.bash), /Bash \+ file edits ON/);

  // ctx.threadKey came from the CLAIMS: no CG_THREAD_KEY existed anywhere in this process tree.
  assert.ok(calls.length >= 2);
  for (const [, body] of calls) assert.equal(body.threadKey, "1700000000.000100");
  assert.equal(calls.find(([kind]) => kind === "approval")[1].authorId, AUTHOR);
});

// The framing line is an opt-in diagnostic, not a requirement — the minimum viable bridge is
// "write the hello, then pipe", which is what a 40-line shell-adjacent client can manage. Drive
// the raw JSON-RPC by hand to prove nothing extra lands in the MCP stream for such a client.
test("a minimal unframed bridge gets a clean MCP stream with no framing line in it", async (t) => {
  const socketPath = await serverOn(t);
  const lines = await new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    const out = [];
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ channelgate: "hello", v: 1, service: "gateway", cap: capability() })}\n`);
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "raw", version: "1" } } })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        out.push(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
      if (out.length) { socket.destroy(); resolve(out); }
    });
  });
  assert.equal(lines.length, 1, "exactly one response, and no framing line ahead of it");
  const response = JSON.parse(lines[0]);
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, "channelgate");
  assert.equal(response.channelgate, undefined);
});

test("an over-long socket path degrades to a warning instead of failing the boot", async () => {
  const warnings = [];
  const tooLong = path.join(scratch, "x".repeat(120), "mcp.sock");
  const result = await startMcpSocketServer({ socketPath: tooLong, dir: path.dirname(tooLong), log: { log() {}, warn: (m) => warnings.push(m) } });
  assert.equal(result, null);
  assert.match(warnings.join("\n"), /unix socket path limit/);
  assert.equal(mcpSocketStatus().listening, false);
});
