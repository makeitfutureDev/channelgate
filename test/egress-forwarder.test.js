// The container-side egress forwarder (src/mcp/egress-forwarder.js → /opt/channelgate/bin/cg-egress.mjs
// in the image): a TCP listener on 127.0.0.1 that pipes every connection, byte for byte, to the
// daemon's per-channel unix socket. What must hold: a round trip in both directions, a failed unix
// connect RESETS the client (the client sees "the proxy is down", never a hang), the forwarder
// survives that failure, and the file stays dependency-free (the image runs it on bare node).
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureTestEnv, trackTempDir } from "./helpers.js";

ensureTestEnv();

const { startForwarder } = await import("../src/mcp/egress-forwarder.js");
const FORWARDER = fileURLToPath(new URL("../src/mcp/egress-forwarder.js", import.meta.url));

const dir = trackTempDir(mkdtempSync("/tmp/cgfw-"));
const socketPath = path.join(dir, "egress.sock");
const listenUnix = (server, file) => new Promise((resolve) => server.listen(file, resolve));
const port = (server) => new Promise((resolve) => server.once("listening", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

function roundTrip(portNumber, payload) {
  return new Promise((resolve, reject) => {
    const client = net.connect(portNumber, "127.0.0.1");
    let got = "";
    client.on("data", (chunk) => { got += chunk; if (got.length >= payload.length + 5) client.end(); });
    client.on("error", (error) => resolve({ error: error.code || error.message, got }));
    client.on("close", () => resolve({ got }));
    client.on("connect", () => client.write(payload));
    setTimeout(() => reject(new Error("round trip timed out")), 3000).unref();
  });
}

test("TCP → unix → TCP: bytes flow both ways unchanged", async () => {
  const upstream = net.createServer((socket) => socket.on("data", (chunk) => socket.write(`echo:${chunk}`)));
  await listenUnix(upstream, socketPath);
  const forwarder = startForwarder({ port: 0, host: "127.0.0.1", socketPath });
  const p = await port(forwarder);
  try {
    const out = await roundTrip(p, "CONNECT api.github.com:443 HTTP/1.1\r\n\r\n");
    assert.equal(out.got, "echo:CONNECT api.github.com:443 HTTP/1.1\r\n\r\n");
  } finally {
    await close(forwarder);
    await close(upstream);
  }
});

test("a failed unix connect resets the client, and the forwarder keeps serving", async () => {
  rmSync(socketPath, { force: true });
  const forwarder = startForwarder({ port: 0, host: "127.0.0.1", socketPath });
  const p = await port(forwarder);
  const errors = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { errors.push(String(chunk)); return true; };
  try {
    const down = await roundTrip(p, "hello");
    assert.equal(down.got, "", "nothing comes back from a proxy that is not there");
    assert.equal(down.error, "ECONNRESET", "the client sees a reset, not an empty answer");
    const again = await roundTrip(p, "hello");
    assert.equal(again.got, "");
    // Logged at most once a minute per failure category.
    assert.equal(errors.filter((line) => line.includes("cannot reach the gateway egress socket")).length, 1);
    // The daemon comes back: the same forwarder serves again without a restart.
    const upstream = net.createServer((socket) => socket.on("data", (chunk) => socket.write(`back:${chunk}`)));
    await listenUnix(upstream, socketPath);
    try {
      assert.equal((await roundTrip(p, "ping")).got, "back:ping");
    } finally {
      await close(upstream);
    }
  } finally {
    process.stderr.write = originalWrite;
    await close(forwarder);
  }
});

test("run as the image runs it: node <file>, listening on CG_EGRESS_PORT, dialing CG_EGRESS_SOCKET", async () => {
  const upstream = net.createServer((socket) => socket.on("data", (chunk) => socket.write(`child:${chunk}`)));
  const childSocket = path.join(dir, "child.sock");
  await listenUnix(upstream, childSocket);
  const probe = net.createServer();
  const free = await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve(probe.address().port)));
  await close(probe);
  const child = spawn(process.execPath, [FORWARDER], { env: { ...process.env, CG_EGRESS_PORT: String(free), CG_EGRESS_SOCKET: childSocket }, stdio: "ignore" });
  try {
    let out = null;
    for (let i = 0; i < 50 && !out?.got; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      out = await roundTrip(free, "x").catch(() => null);
    }
    assert.equal(out?.got, "child:x");
  } finally {
    child.kill("SIGKILL");
    await close(upstream);
  }
});

test("the forwarder imports node built-ins only (it is copied verbatim into the image)", () => {
  const source = readFileSync(FORWARDER, "utf8");
  const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  for (const spec of specifiers) assert.match(spec, /^node:/, `${spec} is not a node built-in`);
});

test("the image build stages the forwarder where cg-init starts it", () => {
  const build = readFileSync(new URL("../scripts/build-image.mjs", import.meta.url), "utf8");
  assert.equal(/const EGRESS_FORWARDER_SOURCE = "([^"]+)"/.exec(build)[1], "src/mcp/egress-forwarder.js");
  assert.equal(/const EGRESS_FORWARDER_DEST = "([^"]+)"/.exec(build)[1], "bin/cg-egress.mjs");
  const init = readFileSync(new URL("../containers/bin/cg-init", import.meta.url), "utf8");
  assert.match(init, /"\$\{CG_EGRESS:-\}" = "proxy"/, "started only when the daemon created the container in proxy mode");
  assert.match(init, /node \/opt\/channelgate\/bin\/cg-egress\.mjs [^\n]*&/, "in the background, before exec");
  assert.ok(init.indexOf("cg-egress.mjs") < init.lastIndexOf('exec "$@"'));
});
