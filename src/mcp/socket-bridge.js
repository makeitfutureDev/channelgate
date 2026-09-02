#!/usr/bin/env node
// cg-mcp-bridge — the container-side half of the gateway control MCP (v0.8 P2). Copied into the
// channel image as /opt/channelgate/bin/cg-mcp-bridge; no dependencies, so it runs on the image's
// bare node. The engine spawns it as an ordinary stdio MCP server; it connects to the daemon's
// unix socket, sends one hello line, and is a pipe from then on. See src/mcp/socket-server.js for
// the protocol and the env contract.
import net from "node:net";

const SOCKET = process.env.CG_MCP_SOCKET || "/run/channelgate/mcp.sock";
const die = (msg) => { process.stderr.write(`[cg-mcp-bridge] ${msg}\n`); process.exit(1); };
const hello = `${JSON.stringify({
  channelgate: "hello",
  v: 1,
  service: process.env.CG_MCP_SERVICE || "gateway",
  cap: process.env.CG_GATEWAY_CAPABILITY || "",
  engine: process.env.CG_ENGINE || "",
  toolset: process.env.CG_TOOLSET || "",
  progressReport: process.env.CG_PROGRESS_REPORT === "1",
  args: process.argv.slice(2), // the composio-sdk service's session URL; ignored by "gateway"
  framed: true, // ask for the one-line ready/error handshake below
})}\n`;

const socket = net.connect(SOCKET);
socket.setNoDelay(true);
socket.on("error", (e) => die(`cannot reach the gateway control socket at ${SOCKET}: ${e.code || e.message}`));
socket.on("connect", () => socket.write(hello));

// The daemon answers with exactly one framing line before any MCP traffic: "ready" (start piping)
// or "error" (say why on stderr, where the engine's MCP startup log shows it, and exit). Without
// this the engine would see a refusal as an unparseable JSON-RPC frame and report nothing useful.
let head = Buffer.alloc(0);
const onData = (chunk) => {
  head = Buffer.concat([head, chunk]);
  const nl = head.indexOf(10);
  if (nl === -1) {
    if (head.length > 65536) die("the gateway sent an oversized handshake");
    return;
  }
  const line = head.subarray(0, nl).toString("utf8");
  const rest = head.subarray(nl + 1);
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    die(`unreadable handshake from the gateway: ${line.slice(0, 200)}`);
    return;
  }
  if (frame.channelgate !== "ready") die(`the gateway refused this run: ${frame.reason || line.slice(0, 200)}`);
  socket.off("data", onData);
  if (rest.length) process.stdout.write(rest);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
};
socket.on("data", onData);

// Either side closing ends the bridge: the engine finished, or the daemon dropped the run.
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());
process.stdin.on("error", () => {});
process.stdout.on("error", () => process.exit(0));
