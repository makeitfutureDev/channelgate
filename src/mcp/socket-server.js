// The daemon-hosted MCP socket (v0.8 P2). A containerized run has no gateway.db, no config dir and
// no daemon port — the three things the stdio gateway MCP server depends on — so the daemon serves
// the control plane ITSELF over a unix socket instead of spawning a child that would need all of
// them mounted. One `net` server on `runtimeSocketFile()` (dir 0700, socket 0600); the container
// backend bind-mounts that directory READ-ONLY at /run/channelgate. No TCP, no bridge IP, so it
// works for `--network none` channels and is identical on rootful docker, rootless docker and
// podman.
//
// ── Wire protocol ────────────────────────────────────────────────────────────────────────────
// Client → one newline-terminated JSON line, then MCP JSON-RPC:
//   {"channelgate":"hello","v":1,"service":"gateway"|"composio-sdk","cap":"<signed capability>",
//    "engine":"claude"|"codex","toolset":"","progressReport":false,"args":[],"framed":true}
// Server → the MCP stream, preceded by one framing line when the client asked for `framed`:
//   {"channelgate":"ready","v":1,"service":"…"}      — MCP frames follow on the same socket
// A REFUSAL is always announced, then the socket closes:
//   {"channelgate":"error","reason":"…"}
// `framed` is an opt-in diagnostic, not a requirement: the minimum viable bridge is "write the
// hello, then pipe", and that still works — it just cannot tell a refusal apart from a malformed
// MCP frame. ./socket-bridge.js (the reference client the image ships) opts in and prints the
// reason on stderr, where the engine's MCP startup log shows it.
// A hello that does not arrive within 2 s, exceeds 64 KB, or carries a capability this daemon did
// not sign is refused. Minting and verification now happen in ONE process, which kills the whole
// aud/secret-skew class the child-process path had to defend against.
//
// ── containers/bin/cg-mcp-bridge env contract (implemented by ./socket-bridge.js) ────────────
//   CG_GATEWAY_CAPABILITY  the signed run capability — the ONLY authority on this socket
//   CG_ENGINE              "claude" | "codex"        (hint; the signed claim wins)
//   CG_TOOLSET             ""|"memory-review"|…      (hint; the signed claim wins)
//   CG_PROGRESS_REPORT     "1" enables report_progress (hint; the signed claim wins)
//   CG_MCP_SOCKET          default "/run/channelgate/mcp.sock"
//   CG_MCP_SERVICE         default "gateway"; "composio-sdk" for the SDK-mode Composio bridge
//   argv                   forwarded as `args` — the composio-sdk session URL
// CG_APPROVAL_SECRET and CG_PORT deliberately do NOT appear: an in-process server calls the
// daemon's own background/approval/restart handlers directly, so a container never holds the
// loopback IPC credentials and there is no /internal/* route for it to reach.
import net from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runtimeSocketDir, runtimeSocketFile } from "../config/paths.js";
import { verifyGatewayCapability } from "../gateway/mcp-capability.js";
import { createDirectDaemonIpc, createGatewayMcpServer, ctxFromClaims } from "./gateway-server.js";
import { runBridge } from "./composio-sdk-bridge.js";

const HELLO_TIMEOUT_MS = 2_000;
const HELLO_MAX_BYTES = 64 * 1024;
// The kernel's sockaddr_un limit is 108 bytes on Linux, 104 on macOS — and it is a HARD limit, not
// a truncation. A gateway root deep enough to blow it must degrade to "container runs can't reach
// the control plane", never to a failed boot.
const MAX_SOCKET_PATH_BYTES = 100;
const SERVICES = new Set(["gateway", "composio-sdk"]);

let active = null; // { server, path, conns }

function writeFrame(socket, frame) {
  try {
    socket.write(`${JSON.stringify(frame)}\n`);
  } catch {
    /* the peer already went away */
  }
}

function refuse(socket, reason) {
  writeFrame(socket, { channelgate: "error", reason });
  socket.end();
}

/**
 * Serve one accepted connection. Exported for tests, which drive it over a socketpair.
 * `secret()` is the daemon's own capability signing secret; `handlers` are the daemon-side
 * background/approval/restart functions the in-process tools call directly.
 */
export function serveMcpConnection(socket, { handlers = {}, secret = () => process.env.CG_APPROVAL_SECRET || "", log = console } = {}) {
  socket.setNoDelay?.(true);
  let head = Buffer.alloc(0);
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      refuse(socket, "handshake timed out");
    }
  }, HELLO_TIMEOUT_MS);
  timer.unref?.();

  const finish = () => {
    settled = true;
    clearTimeout(timer);
    socket.off("data", onData);
  };

  async function onData(chunk) {
    if (settled) return;
    head = Buffer.concat([head, chunk]);
    const nl = head.indexOf(10);
    if (nl === -1) {
      if (head.length > HELLO_MAX_BYTES) {
        finish();
        refuse(socket, "handshake too large");
      }
      return;
    }
    const line = head.subarray(0, nl).toString("utf8");
    const rest = head.subarray(nl + 1);
    finish();

    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return refuse(socket, "malformed hello");
    }
    if (frame?.channelgate !== "hello" || frame.v !== 1) return refuse(socket, "unsupported hello");
    if (!SERVICES.has(frame.service)) return refuse(socket, `unsupported service "${String(frame.service ?? "").slice(0, 40)}"`);

    const cap = typeof frame.cap === "string" ? frame.cap : "";
    const verify = () => verifyGatewayCapability(cap, { secret: secret() });
    const checked = verify();
    if (!checked.ok) return refuse(socket, `capability rejected (${checked.reason})`);

    // Hold every byte that followed the hello until the MCP transport is attached: the transport
    // reads the socket's own "data" events, and there is no way to hand it bytes we already took.
    // An explicitly paused stream stays paused when a new "data" listener arrives, so the resume
    // below (after connect) is what actually starts the MCP stream — dropping it wedges the run.
    socket.pause();
    if (rest.length) socket.unshift(rest);

    try {
      const transport = new StdioServerTransport(socket, socket);
      if (frame.service === "gateway") {
        const ctx = ctxFromClaims(checked.claims, {
          engine: typeof frame.engine === "string" ? frame.engine : "",
          toolset: typeof frame.toolset === "string" ? frame.toolset : "",
          progressReport: frame.progressReport === true,
          daemon: createDirectDaemonIpc(handlers),
          verifyCapability: verify, // re-checked at every tool call, exactly as the stdio server does
        });
        const server = createGatewayMcpServer(ctx);
        await server.connect(transport);
        socket.once("close", () => { server.close?.().catch?.(() => {}); });
      } else {
        // SDK-mode Composio reads the organization SDK key from gateway settings, which a container
        // cannot see, so it rides this socket too. The session URL is not a secret; runBridge still
        // validates it is a hosted Composio tool_router URL before connecting.
        const url = Array.isArray(frame.args) ? String(frame.args[0] || "") : "";
        const { server } = await runBridge(url, { transport });
        socket.once("close", () => { server.close?.().catch?.(() => {}); });
      }
      if (frame.framed === true) writeFrame(socket, { channelgate: "ready", v: 1, service: frame.service });
      socket.resume();
    } catch (e) {
      // Deliberately terse for composio: upstream errors can quote request headers or URLs.
      const reason = frame.service === "gateway" ? String(e?.message || "server error") : "composio bridge unavailable";
      log?.warn?.(`[gateway] MCP socket: ${frame.service} connection failed — ${e?.message || e}`);
      refuse(socket, reason);
    }
  }

  socket.on("data", onData);
  socket.on("error", () => {
    if (!settled) finish();
  });
  return socket;
}

/**
 * Bind the daemon's MCP socket. NEVER throws and never fails the boot: an unbindable path (too
 * long, a read-only root, a platform without unix sockets) logs one line and leaves container runs
 * to fail closed with a clear message of their own.
 * @returns {Promise<{server: import("node:net").Server, path: string}|null>}
 */
export async function startMcpSocketServer({ handlers = {}, socketPath = runtimeSocketFile(), dir = runtimeSocketDir(), secret, log = console } = {}) {
  if (active) return active;
  try {
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
      log?.warn?.(`[gateway] MCP socket skipped — ${socketPath} exceeds the ${MAX_SOCKET_PATH_BYTES}-byte unix socket path limit; container channels cannot reach the gateway control plane.`);
      return null;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // pre-existing dirs predate this mode
    // A socket file left behind by a killed daemon blocks the bind. The singleton lock guarantees
    // no second gateway owns this root, so removing it is safe.
    rmSync(socketPath, { force: true });

    const conns = new Set();
    const server = net.createServer((socket) => {
      conns.add(socket);
      socket.once("close", () => conns.delete(socket));
      serveMcpConnection(socket, { handlers, secret, log });
    });
    server.on("error", (e) => log?.warn?.(`[gateway] MCP socket error: ${e?.message || e}`));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    chmodSync(socketPath, 0o600);
    active = { server, path: socketPath, conns };
    log?.log?.(`[gateway] MCP control socket: ${socketPath}`);
    return active;
  } catch (e) {
    log?.warn?.(`[gateway] MCP control socket unavailable (${e?.message || e}) — container channels cannot reach the gateway control plane.`);
    return null;
  }
}

export function mcpSocketStatus() {
  return active ? { listening: true, path: active.path } : { listening: false, path: "" };
}

// Shutdown must not block on a live container connection: server.close() only settles once every
// socket is gone, and a warm container holds one for the life of its run. Drop them explicitly.
export async function stopMcpSocketServer() {
  if (!active) return;
  const { server, path, conns } = active;
  active = null;
  for (const socket of conns) socket.destroy();
  conns.clear();
  await new Promise((resolve) => server.close(resolve));
  try {
    rmSync(path, { force: true });
  } catch {
    /* best effort */
  }
}
