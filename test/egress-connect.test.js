// The SSH ProxyCommand helper (src/mcp/egress-connect.js → /opt/channelgate/bin/cg-egress-connect.mjs
// behind the containers/bin/cg-egress-connect shim; container-secrets P3). What must hold: it speaks
// exactly `CONNECT host:port` to the in-container forwarder, pipes stdio both ways once the proxy
// answers 200 (bytes that arrive with the 200 included), half-closes on the client's EOF and exits 0
// when the tunnel closes; a refusal is ONE stderr line naming the proxy's reason and exit 1; an
// unreachable forwarder is exit 1 with the reason; bad arguments are exit 2; and the file stays
// dependency-free (the image runs it on bare node).
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { connectAuthority, connectThroughProxy, tunnelMode, TUNNEL_MODE_HEADER, DEFAULT_PROXY_PORT, DEFAULT_PROXY_HOST } = await import("../src/mcp/egress-connect.js");
const { TUNNEL_MODE_HEADER: PROXY_TUNNEL_MODE_HEADER } = await import("../src/gateway/egress/proxy.js");
const { PassThrough } = await import("node:stream");
const HELPER = fileURLToPath(new URL("../src/mcp/egress-connect.js", import.meta.url));

// A stand-in for the forwarder + proxy on 127.0.0.1: records each CONNECT head, then runs `serve`.
async function fakeProxy(serve) {
  const heads = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      heads.push(buffer.slice(0, end));
      serve(socket, buffer.slice(end + 4));
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { heads, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

function runHelper(args, { port, input = null, keepOpenMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, ...args], { env: { PATH: process.env.PATH, CG_EGRESS_PORT: String(port) }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== null) {
      child.stdin.write(input);
      setTimeout(() => child.stdin.end(), keepOpenMs);
    }
    setTimeout(() => { child.kill("SIGKILL"); reject(new Error("the helper did not exit")); }, 5000).unref();
  });
}

test("connectAuthority: host:port, [v6]:port, and invalid input refused", () => {
  assert.equal(connectAuthority("github.com", "22"), "github.com:22");
  assert.equal(connectAuthority("github.com.", 22), "github.com:22", "a trailing dot is dropped");
  assert.equal(connectAuthority("10.0.0.5", 5432), "10.0.0.5:5432", "the proxy, not the helper, refuses private addresses");
  assert.equal(connectAuthority("2001:db8::1", 22), "[2001:db8::1]:22");
  assert.equal(connectAuthority("[2001:db8::1]", 22), "[2001:db8::1]:22");
  for (const [host, port] of [["github.com", 0], ["github.com", 70000], ["github.com", "ssh"], ["", 22], ["bad host", 22], ["a\r\nX-Injected: 1", 22], ["-oProxyCommand=x", 22]]) {
    assert.throws(() => connectAuthority(host, port), /invalid (host|port)/, `${JSON.stringify(host)}:${port}`);
  }
  assert.equal(DEFAULT_PROXY_HOST, "127.0.0.1");
  assert.equal(DEFAULT_PROXY_PORT, 3128, "the forwarder's port (image-paths CONTAINER_EGRESS_PORT)");
});

test("a 200 tunnel pipes stdio both ways — bytes riding with the 200 included — and exits 0 when it closes", async () => {
  const proxy = await fakeProxy((socket, early) => {
    // The server's SSH banner arrives in the same segment as the 200.
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\nSSH-2.0-fake\r\n");
    let got = early;
    socket.on("data", (chunk) => { got += chunk; });
    socket.on("end", () => { socket.end(`echo:${got}`); });
  });
  try {
    const out = await runHelper(["github.com", "22"], { port: proxy.port, input: "SSH-2.0-client\r\n", keepOpenMs: 50 });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(proxy.heads[0], "CONNECT github.com:22 HTTP/1.1\r\nHost: github.com:22");
    assert.equal(out.stdout, "SSH-2.0-fake\r\necho:SSH-2.0-client\r\n", "client EOF half-closes the tunnel; the server's last bytes still arrive");
    assert.equal(out.stderr, "");
  } finally {
    await proxy.close();
  }
});

test("the tunnel closing first ends the helper even while the client keeps stdin open", async () => {
  const proxy = await fakeProxy((socket) => { socket.end("HTTP/1.1 200 Connection Established\r\n\r\nbye"); });
  try {
    const child = spawn(process.execPath, [HELPER, "github.com", "22"], { env: { PATH: process.env.PATH, CG_EGRESS_PORT: String(proxy.port) }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    assert.equal(stdout, "bye");
  } finally {
    await proxy.close();
  }
});

test("a refusal is one stderr line naming the proxy's reason, exit 1, nothing on stdout", async () => {
  const body = JSON.stringify({ error: "network-off", detail: "This channel's network is off." });
  const proxy = await fakeProxy((socket) => {
    socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  });
  try {
    const out = await runHelper(["example.com", "22"], { port: proxy.port });
    assert.equal(out.code, 1);
    assert.equal(out.stdout, "");
    assert.equal(out.stderr, "cg-egress-connect: the gateway's egress proxy refused example.com:22 (403 Forbidden) — network-off: This channel's network is off.\n");
  } finally {
    await proxy.close();
  }
});

test("the tunnel-mode header: the helper's copy matches the proxy's, and parsing is exact", () => {
  assert.equal(TUNNEL_MODE_HEADER, PROXY_TUNNEL_MODE_HEADER, "the helper is staged on its own, so it keeps a copy");
  assert.equal(tunnelMode("HTTP/1.1 200 Connection Established\r\nX-ChannelGate-Tunnel: inspect"), "inspect");
  assert.equal(tunnelMode("HTTP/1.1 200 Connection Established\r\nx-channelgate-tunnel: RAW"), "raw");
  assert.equal(tunnelMode("HTTP/1.1 200 Connection Established"), "", "an older proxy sends no header: bytes pass as before");
  assert.equal(tunnelMode("HTTP/1.1 200 OK\r\nX-Other: X-ChannelGate-Tunnel: inspect"), "");
});

test("an inspected tunnel refuses a non-TLS client with the reason and sends nothing", async () => {
  // A TDS PRELOGIN (Azure SQL) starts with 0x12, not the TLS handshake byte 0x16.
  const proxy = await fakeProxy((socket) => {
    socket.write("HTTP/1.1 200 Connection Established\r\nX-ChannelGate-Tunnel: inspect\r\n\r\n");
    socket.on("data", (chunk) => { proxy.received = (proxy.received || 0) + chunk.length; });
  });
  try {
    const out = await runHelper(["sql.example.com", "1433"], { port: proxy.port, input: Buffer.from([0x12, 0x01, 0x00, 0x2f]), keepOpenMs: 2000 });
    assert.equal(out.code, 1);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /^cg-egress-connect: sql\.example\.com:1433 is not a declared raw destination for this channel; the gateway's egress proxy carries only HTTPS \(TLS\) to it, and this client is not speaking TLS, so nothing was sent\. Ask for the exact host and port with allow_channel_ssh_host\(\{host: "sql\.example\.com", port: 1433\}\)/);
    assert.equal(out.stderr.split("\n").filter(Boolean).length, 1, "one line");
    assert.equal(proxy.received || 0, 0, "the refused bytes never left the container");
  } finally {
    await proxy.close();
  }
});

test("an inspected tunnel passes a TLS client through unchanged", async () => {
  const proxy = await fakeProxy((socket) => {
    socket.write("HTTP/1.1 200 Connection Established\r\nX-ChannelGate-Tunnel: inspect\r\n\r\n");
    let got = Buffer.alloc(0);
    socket.on("data", (chunk) => { got = Buffer.concat([got, chunk]); });
    socket.on("end", () => socket.end(`got:${got.toString("hex")}`));
  });
  try {
    const out = await runHelper(["example.com", "443"], { port: proxy.port, input: Buffer.from([0x16, 0x03, 0x01, 0xaa]), keepOpenMs: 50 });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout, "got:160301aa");
    assert.equal(out.stderr, "");
  } finally {
    await proxy.close();
  }
});

test("a client that waits for the server on an inspected tunnel gets one hint, and the tunnel stays up", async () => {
  const proxy = await fakeProxy((socket) => {
    socket.write("HTTP/1.1 200 Connection Established\r\nX-ChannelGate-Tunnel: inspect\r\n\r\n");
    setTimeout(() => socket.end(), 120);
  });
  try {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (c) => { err += c; });
    stdout.resume();
    const code = await connectThroughProxy({ host: "db.example.com", port: 3306, proxyPort: proxy.port, stdin, stdout, stderr, inspectHintMs: 20 });
    assert.equal(code, 0, "the hint does not end the tunnel; the server closing it does");
    assert.match(err, /^cg-egress-connect: db\.example\.com:3306 is not a declared raw destination for this channel; .*no TLS handshake has arrived yet .*allow_channel_ssh_host\(\{host: "db\.example\.com", port: 3306\}\)/);
    assert.equal(err.split("\n").filter(Boolean).length, 1);
  } finally {
    await proxy.close();
  }
});

test("an unreachable forwarder and bad arguments fail with the reason", async () => {
  const closed = await fakeProxy(() => {});
  const port = closed.port;
  await closed.close();
  const down = await runHelper(["github.com", "22"], { port });
  assert.equal(down.code, 1);
  assert.match(down.stderr, /cannot reach the egress forwarder at 127\.0\.0\.1:\d+ \(ECONNREFUSED\) — this works only inside a ChannelGate channel container/);
  const usage = await runHelper(["github.com"], { port });
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /invalid port[\s\S]*usage: cg-egress-connect <host> <port>/);
});

test("the helper is dependency-free, and the image stages it behind a POSIX shim", async () => {
  const source = readFileSync(HELPER, "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const spec of imports) assert.match(spec, /^node:/, `${spec} is not a node built-in`);
  const { EGRESS_CONNECT, VERBATIM_HELPERS } = await import("../src/runtimes/container/image-bundle.js");
  assert.equal(EGRESS_CONNECT.source, "src/mcp/egress-connect.js");
  assert.equal(EGRESS_CONNECT.dest, "bin/cg-egress-connect.mjs");
  assert.ok(VERBATIM_HELPERS.includes(EGRESS_CONNECT));
  const build = readFileSync(new URL("../scripts/build-image.mjs", import.meta.url), "utf8");
  assert.match(build, /for \(const helper of VERBATIM_HELPERS\)[\s\S]*?cpSync\(source, path\.join\(dir, helper\.dest\)\)/);
  const shim = readFileSync(new URL("../containers/bin/cg-egress-connect", import.meta.url), "utf8");
  assert.match(shim, /^#!\/bin\/sh\n/);
  assert.match(shim, /exec node \/opt\/channelgate\/bin\/cg-egress-connect\.mjs "\$@"\n$/);
});
