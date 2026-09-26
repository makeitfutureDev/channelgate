#!/usr/bin/env node
// cg-egress-connect — an SSH `ProxyCommand` for a `--network none` channel container
// (container-secrets P3). Copied VERBATIM into the channel image as
// /opt/channelgate/bin/cg-egress-connect.mjs by scripts/build-image.mjs (the same mechanism that
// stages egress-forwarder.js as cg-egress.mjs); the POSIX shim containers/bin/cg-egress-connect
// execs it. Node built-ins only: it runs on the image's bare node.
//
//   ssh -o ProxyCommand='/opt/channelgate/bin/cg-egress-connect %h %p' git@github.com
//
// Why: under `--network none` an ssh client has no route; the container's only way out is the
// in-container forwarder on 127.0.0.1:3128, which pipes to the daemon's egress proxy. This speaks
// `CONNECT host:port` to it and, on a 200, pipes stdin/stdout through the tunnel byte for byte. The
// PROXY decides: a raw tunnel exists only for the host:ports it allows (github.com:22 always, plus
// the channel's declared raw hosts on 22/5432/6543, and only with Allow network on). A refusal is
// one readable line on stderr and exit 1 — ssh then prints "kex_exchange_identification: Connection
// closed by remote host", so the line naming the reason is what the developer needs to see. The
// proxy cannot add an SSH key: the tunnel carries the developer's own authentication, nothing more.
import net from "node:net";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_PROXY_HOST = "127.0.0.1";
export const DEFAULT_PROXY_PORT = 3128;
const HEAD_LIMIT = 16 * 1024;
const BODY_LIMIT = 4 * 1024;
const HEAD_TIMEOUT_MS = 30_000;
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62})(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}))*\.?$/;

// → "host:port" / "[v6]:port" for the CONNECT line, or throws with a usage-grade reason.
export function connectAuthority(host, port) {
  const name = String(host || "").trim();
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error(`invalid port: ${port}`);
  const bare = name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
  if (net.isIPv6(bare)) return `[${bare}]:${portNumber}`;
  if (net.isIPv4(bare) || HOSTNAME_RE.test(bare)) return `${bare.replace(/\.$/, "")}:${portNumber}`;
  throw new Error(`invalid host: ${host}`);
}

function refusalLine(authority, head, body) {
  const status = /^HTTP\/1\.[01] (\d{3}[^\r\n]*)/.exec(head)?.[1] || "no status line";
  let detail = "";
  try {
    const parsed = JSON.parse(body);
    detail = [parsed?.error, parsed?.detail].filter(Boolean).join(": ");
  } catch {
    detail = body.replace(/\s+/g, " ").trim().slice(0, 300);
  }
  return `cg-egress-connect: the gateway's egress proxy refused ${authority} (${status.trim()})${detail ? ` — ${detail}` : ""}`;
}

/**
 * CONNECT through the proxy, then pipe `stdin` → tunnel → `stdout`. Resolves the exit code: 0 once
 * an established tunnel closes, 1 on a refusal or an unreachable proxy (one line on `stderr`).
 */
export function connectThroughProxy({
  host, port,
  proxyHost = DEFAULT_PROXY_HOST, proxyPort = DEFAULT_PROXY_PORT,
  stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  headTimeoutMs = HEAD_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    let authority;
    try { authority = connectAuthority(host, port); }
    catch (error) {
      stderr.write(`cg-egress-connect: ${error.message}\nusage: cg-egress-connect <host> <port>\n`);
      resolve(2);
      return;
    }
    let settled = false;
    const finish = (code, message = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (message) stderr.write(`${message}\n`);
      resolve(code);
    };
    const socket = net.connect(Number(proxyPort), proxyHost);
    const timer = setTimeout(() => {
      socket.destroy();
      finish(1, `cg-egress-connect: the egress proxy did not answer the CONNECT for ${authority} within ${Math.round(headTimeoutMs / 1000)} s`);
    }, headTimeoutMs);
    timer.unref?.();
    let buffer = Buffer.alloc(0);
    let tunnelled = false;
    socket.on("error", (error) => {
      if (tunnelled) { finish(0); return; }
      finish(1, `cg-egress-connect: cannot reach the egress forwarder at ${proxyHost}:${proxyPort} (${error.code || error.message}) — this works only inside a ChannelGate channel container whose network is the egress proxy`);
    });
    socket.once("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    const onHead = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffer.length > HEAD_LIMIT) {
          socket.destroy();
          finish(1, `cg-egress-connect: the egress proxy sent an oversized response to the CONNECT for ${authority}`);
        }
        return;
      }
      socket.off("data", onHead);
      const head = buffer.subarray(0, end).toString("latin1");
      const rest = buffer.subarray(end + 4);
      if (!/^HTTP\/1\.[01] 200\b/.test(head)) {
        // Read the (short) JSON body for its reason, then give up.
        let body = rest.toString("utf8");
        const done = () => { socket.destroy(); finish(1, refusalLine(authority, head, body)); };
        socket.on("data", (more) => { body += more; if (body.length > BODY_LIMIT) done(); });
        socket.once("end", done);
        socket.once("close", done);
        return;
      }
      tunnelled = true;
      clearTimeout(timer);
      if (rest.length) stdout.write(rest);
      socket.pipe(stdout, { end: false });
      stdin.pipe(socket);
      // The developer's ssh closed its side: half-close ours so the server sees EOF.
      stdin.once("end", () => socket.end());
      socket.once("close", () => {
        try { stdin.unpipe(socket); } catch { /* already gone */ }
        // ssh keeps our stdin open until it sees our stdout end; stop reading so the process exits.
        try { stdin.destroy?.(); } catch { /* not destroyable */ }
        const done = () => finish(0);
        if (stdout === process.stdout) stdout.write("", done);
        else { try { stdout.end?.(); } catch { /* ended */ } done(); }
      });
    };
    socket.on("data", onHead);
  });
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Run only as the entry point, so the test suite can import the functions.
if (isEntryPoint()) {
  const [host, port] = process.argv.slice(2);
  const code = await connectThroughProxy({
    host, port,
    proxyPort: Number(process.env.CG_EGRESS_PORT || DEFAULT_PROXY_PORT),
  });
  process.exitCode = code;
}
