#!/usr/bin/env node
// cg-egress — the container-side half of the egress proxy. Copied VERBATIM into the channel image as
// /opt/channelgate/bin/cg-egress.mjs by scripts/build-image.mjs (the same mechanism that stages
// socket-bridge.js as cg-mcp-bridge.mjs); cg-init starts it in the background when CG_EGRESS=proxy.
// Node built-ins only: it runs on the image's bare node, before anything else.
//
// A `--network none` container has only `lo`. Every HTTP(S) client in it is pointed at
// http://127.0.0.1:3128 (HTTPS_PROXY and friends); this listens there and pipes each accepted
// connection, byte for byte, to the daemon's per-channel egress socket (bind-mounted read-only at
// /run/channelgate/egress/egress.sock). It speaks no HTTP itself — the proxy protocol, TLS
// termination and every policy decision are the daemon's. A unix connect that fails destroys the
// client socket (the client sees ECONNRESET: "the proxy is down"), a failure is logged at most once
// a minute per category, and the process never exits on an error: a restart of the daemon must not
// leave a container without its forwarder.
import net from "node:net";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.CG_EGRESS_PORT || 3128);
const SOCKET = process.env.CG_EGRESS_SOCKET || "/run/channelgate/egress/egress.sock";
const HOST = "127.0.0.1";
const LOG_EVERY_MS = 60_000;
const lastLogged = new Map();

function logOnce(category, message) {
  const now = Date.now();
  if (now - (lastLogged.get(category) || 0) < LOG_EVERY_MS) return;
  lastLogged.set(category, now);
  process.stderr.write(`[cg-egress] ${message}\n`);
}

export function forward(client, { socketPath = SOCKET } = {}) {
  client.on("error", () => {});
  client.pause();
  const upstream = net.connect(socketPath);
  let connected = false;
  upstream.on("error", (error) => {
    if (!connected) {
      logOnce(`connect:${error.code || "error"}`, `cannot reach the gateway egress socket at ${socketPath}: ${error.code || error.message}`);
      // A RESET, not a clean close: the client must read "the proxy is down" (ECONNRESET), not an
      // empty response it might retry as if the destination had answered.
      if (typeof client.resetAndDestroy === "function") client.resetAndDestroy();
      else client.destroy();
      return;
    }
    client.destroy();
  });
  upstream.once("connect", () => {
    connected = true;
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
}

export function startForwarder({ port = PORT, host = HOST, socketPath = SOCKET } = {}) {
  const server = net.createServer((client) => forward(client, { socketPath }));
  server.on("error", (error) => {
    logOnce(`listen:${error.code || "error"}`, `cannot listen on ${host}:${port}: ${error.code || error.message}`);
    // EADDRINUSE: another forwarder (a second cg-init, a manual start) already serves this port —
    // that is the job done. Anything else: retry, never exit.
    if (error.code === "EADDRINUSE") return;
    setTimeout(() => server.listen(port, host), 5_000);
  });
  server.listen(port, host);
  return server;
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Run only as the entry point, so the test suite can import forward/startForwarder.
if (isEntryPoint()) {
  process.on("uncaughtException", (error) => logOnce("uncaught", `unexpected error: ${error?.message || error}`));
  startForwarder();
}
