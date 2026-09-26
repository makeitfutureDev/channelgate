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
//   {"channelgate":"hello","v":1,"service":"gateway"|"composio-sdk"|"remote-mcp",
//    "cap":"<signed capability>","engine":"claude"|"codex","toolset":"","progressReport":false,
//    "args":[],"framed":true}
// Server → the MCP stream, preceded by one framing line when the client asked for `framed`:
//   {"channelgate":"ready","v":1,"service":"…"}      — MCP frames follow on the same socket
// A REFUSAL is always announced, then the socket closes:
//   {"channelgate":"error","reason":"…"}
// `framed` is an opt-in diagnostic, not a requirement: the minimum viable bridge is "write the
// hello, then pipe", and that still works — it just cannot tell a refusal apart from a malformed
// MCP frame. ./socket-bridge.js (the reference client the image ships) opts in and prints the
// reason on stderr, where the engine's MCP startup log shows it.
// Services:
//   gateway       the control plane (src/mcp/gateway-server.js), tool surface fixed by the claims.
//   composio-sdk  Enterprise SDK-mode Composio: args[0] is the session URL, which the capability's
//                 `composioSessions` must grant (src/ee/composio-sdk-bridge.js).
//   remote-mcp    a header-bearing remote MCP server (composio-user / composio-agent in token
//                 mode, makeitfuture-toolbox, make-toolbox) relayed by the daemon: args[0] is the
//                 server NAME. The capability's signed `remoteMcps` claim must name it AND the
//                 daemon's in-memory registry (./remote-mcp-registry.js) must hold a live
//                 registration for it under the capability's jti; the daemon then dials the real
//                 URL with the real headers (./remote-relay.js) and relays tools/list + tools/call,
//                 re-authorizing each. The container never holds the credential.
//                 At most MAX_RELAYS_PER_GRANT_SERVER connections per grant and server at once,
//                 each holding the registration alive while it is open.
// Refusals from the two relaying services are fixed sentences ("remote MCP is not authorized for
// this run", "too many remote MCP connections for this run", "remote MCP unavailable", "composio
// bridge unavailable"): an upstream error can quote a request header or a URL, and none of that may
// reach a container. The gateway service refuses a hello that carries `args`: only a relayed entry
// run through a pre-1.6.0 image's broker (which drops CG_MCP_SERVICE) sends one.
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
//   CG_MCP_SERVICE         default "gateway"; "composio-sdk" for the SDK-mode Composio bridge;
//                          "remote-mcp" for a relayed header-bearing remote MCP server
//   argv                   forwarded as `args` — the composio-sdk session URL, or the remote-mcp
//                          server name
// Codex reaches this bridge through ./secret-env-bridge.js (the capability comes from its 0600
// bundle, never argv/env), which forwards CG_MCP_SERVICE and CG_MCP_SOCKET to it.
// CG_APPROVAL_SECRET and CG_PORT deliberately do NOT appear: an in-process server calls the
// daemon's own background/approval/restart handlers directly, so a container never holds the
// loopback IPC credentials and there is no /internal/* route for it to reach.
import net from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runtimeSocketDir, runtimeSocketFile } from "../config/paths.js";
import { verifyGatewayCapability } from "../gateway/mcp-capability.js";
import { createDirectDaemonIpc, createGatewayMcpServer, ctxFromClaims } from "./gateway-server.js";
import { runBridge } from "../ee/composio-sdk-bridge.js";
import { authorizeRemoteMcp, retainRemoteMcps } from "./remote-mcp-registry.js";
import { runRemoteRelay } from "./remote-relay.js";

const HELLO_TIMEOUT_MS = 2_000;
const HELLO_MAX_BYTES = 64 * 1024;
// The kernel's sockaddr_un limit is 108 bytes on Linux — and it is a HARD limit, not
// a truncation. A gateway root deep enough to blow it must degrade to "container runs can't reach
// the control plane", never to a failed boot.
const MAX_SOCKET_PATH_BYTES = 100;
const SERVICES = new Set(["gateway", "composio-sdk", "remote-mcp"]);
const REFUSAL_BY_SERVICE = { "composio-sdk": "composio bridge unavailable", "remote-mcp": "remote MCP unavailable" };
// At most this many relay connections at once per grant and server. A slot is held from the
// accepted hello until BOTH the socket has closed AND the upstream dial has settled (and been torn
// down), so a container that says hello and hangs up in a loop can keep at most this many dials in
// flight per server, never an unbounded number. Per server rather than per grant because an SSH
// session hands ONE capability to every `claude` the developer starts: two processes with four
// relayed servers already hold eight connections on the same grant.
export const MAX_RELAYS_PER_GRANT_SERVER = 8;
const relaySlots = new Map(); // `${jti}\0${name}` → open count

// A string field of the hello, or "" — never String(x) on attacker-shaped JSON: an object whose
// toString is not callable throws, and this runs after the handshake timer is gone.
const helloString = (value, max = 80) => (typeof value === "string" ? value.slice(0, max) : "");
const firstArg = (frame) => (Array.isArray(frame.args) ? helloString(frame.args[0], 2048) : "");

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

// One relay slot + one registration hold for an accepted remote-mcp connection (see
// MAX_RELAYS_PER_GRANT_SERVER). The hold is what keeps a warm process's grant alive after the
// turn that minted it released its own (src/mcp/remote-mcp-registry.js). Null when full.
function acquireRelaySlot(jti, name) {
  const key = `${jti}\u0000${name}`;
  const open = relaySlots.get(key) || 0;
  if (open >= MAX_RELAYS_PER_GRANT_SERVER) return null;
  relaySlots.set(key, open + 1);
  const releaseHold = retainRemoteMcps(jti);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const left = (relaySlots.get(key) || 1) - 1;
      if (left > 0) relaySlots.set(key, left);
      else relaySlots.delete(key);
      releaseHold();
    },
  };
}

/** Open relay connections, for tests and diagnostics (counts only). */
export function relaySlotStats() {
  let open = 0;
  for (const count of relaySlots.values()) open += count;
  return { open, grants: relaySlots.size };
}

/**
 * Serve one accepted connection. Exported for tests, which drive it over a socketpair.
 * `secret()` is the daemon's own capability signing secret; `handlers` are the daemon-side
 * background/approval/restart functions the in-process tools call directly.
 */
export function serveMcpConnection(socket, { handlers = {}, secret = () => process.env.CG_APPROVAL_SECRET || "", log = console, connectRemote = undefined } = {}) {
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

  // A malformed hello must never become an unhandled rejection (which ends the daemon): anything
  // unexpected in the handshake is a refusal.
  function onData(chunk) {
    handleData(chunk).catch(() => {
      if (!socket.destroyed) refuse(socket, "malformed hello");
    });
  }

  async function handleData(chunk) {
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
    if (!SERVICES.has(frame.service)) return refuse(socket, `unsupported service "${helloString(frame.service, 40)}"`);
    // The gateway service takes no arguments. A relayed entry reaching it anyway means a broker
    // that dropped CG_MCP_SERVICE — an image older than spec 1.6.0 — and serving the control plane
    // under a Composio/toolbox server's name would be silently wrong. Say what to do instead.
    if (frame.service === "gateway" && Array.isArray(frame.args) && frame.args.length) {
      return refuse(socket, "the gateway service takes no arguments; if this came from a relayed MCP entry the channel image is older than this gateway — run `npm run build:image`");
    }

    const cap = typeof frame.cap === "string" ? frame.cap : "";
    const verify = () => verifyGatewayCapability(cap, { secret: secret() });
    const checked = verify();
    if (!checked.ok) return refuse(socket, `capability rejected (${checked.reason})`);

    // remote-mcp is authorized BEFORE anything is dialled, and refused with one fixed sentence that
    // names neither the server's URL nor why (unknown name, missing claim, expired registration).
    let remoteName = "";
    let remoteTarget = null;
    let relayLease = null;
    if (frame.service === "remote-mcp") {
      remoteName = firstArg(frame).slice(0, 80);
      try {
        remoteTarget = authorizeRemoteMcp(checked, remoteName);
      } catch {
        return refuse(socket, "remote MCP is not authorized for this run");
      }
      relayLease = acquireRelaySlot(checked.claims.jti, remoteName);
      if (!relayLease) return refuse(socket, "too many remote MCP connections for this run");
    }

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
      } else if (frame.service === "remote-mcp") {
        // The close listener goes on BEFORE the upstream dial: a container that hangs up while
        // the daemon is still connecting must not leave that upstream client (an SSE stream
        // carrying the real credential) open with nothing on the other end. Whichever of "socket
        // closed" and "dial settled" comes second tears the relay down and frees the slot.
        let relay = null;
        let dialing = true;
        let closedWhileDialing = false;
        let tornDown = false;
        const teardown = () => {
          if (tornDown) return;
          tornDown = true;
          relay?.close?.();
          relayLease.release();
        };
        socket.once("close", () => {
          if (dialing) closedWhileDialing = true;
          else teardown();
        });
        try {
          relay = await runRemoteRelay({
            url: remoteTarget.url,
            headers: remoteTarget.headers,
            transport,
            authorize: () => authorizeRemoteMcp(verify(), remoteName),
            ...(connectRemote ? { connect: connectRemote } : {}),
          });
        } finally {
          dialing = false;
          if (closedWhileDialing || socket.destroyed) teardown();
        }
        if (tornDown) return;
      } else {
        // SDK-mode Composio reads the organization SDK key from gateway settings, which a container
        // cannot see, so it rides this socket too. The session URL is not a secret; runBridge still
        // validates it is a hosted Composio tool_router URL before connecting.
        const url = firstArg(frame);
        const { server } = await runBridge(url, { transport, verifyCapability: verify });
        socket.once("close", () => { server.close?.().catch?.(() => {}); });
      }
      if (frame.framed === true) writeFrame(socket, { channelgate: "ready", v: 1, service: frame.service });
      socket.resume();
    } catch (e) {
      // Deliberately terse for the relaying services: upstream errors can quote request headers or URLs.
      const reason = frame.service === "gateway" ? String(e?.message || "server error") : REFUSAL_BY_SERVICE[frame.service];
      log?.warn?.(`[gateway] MCP socket: ${frame.service} connection failed — ${reason}`);
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
export async function startMcpSocketServer({ handlers = {}, socketPath = runtimeSocketFile(), dir = runtimeSocketDir(), secret, log = console, connectRemote = undefined } = {}) {
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
      serveMcpConnection(socket, { handlers, secret, log, connectRemote });
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
