// The egress proxy end to end (src/gateway/egress/proxy.js): a real Unix-socket listener, real TLS
// termination with the deployment CA, real HTTPS/HTTP/TCP upstreams on 127.0.0.1. Fake hostnames
// (`upstream.test`, …) resolve through an injected lookup, and the TEST-ONLY `allowLoopbackHosts`
// lets exactly those names reach loopback — production policy refuses loopback outright.
//
// What must hold: the upstream sees the REAL value while the container only ever sent the
// placeholder; a host the grant does not declare receives the placeholder unchanged; an echoed
// real value comes back scrubbed; refused destinations answer 403 with a category; raw tunnels
// and WebSocket upgrades pipe bytes; audit events carry no values; close() leaves nothing open
// (this file's process must exit on its own).
//
// Socket paths are capped at ~108 bytes, so the listener lives in a SHORT mkdtemp under /tmp.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir, trackTempDir } from "./helpers.js";

ensureTestEnv();

const { createEgressProxy, parseAuthority } = await import("../src/gateway/egress/proxy.js");
const { loadOrCreateEgressCa } = await import("../src/gateway/egress/ca.js");
const { createCaCertificate, issueLeafCertificate } = await import("../src/gateway/egress/x509.js");
const { mintPlaceholder, shapePlaceholder, corePlaceholder } = await import("../src/gateway/egress/placeholders.js");

const CTX = { channel: "C_EGRESS", slug: "egress-test" };
const REAL = `real-gh-${crypto.randomBytes(16).toString("hex")}`;
const PH = mintPlaceholder({ scope: "channel" });
const PERSONAL_REAL = `real-personal-${crypto.randomBytes(16).toString("hex")}`;
const PERSONAL_PH = mintPlaceholder({ scope: "personal" });
const RELAY_REAL = `real-relay-${crypto.randomBytes(16).toString("hex")}`;
const RELAY_TOKEN = shapePlaceholder({ scope: "relay", shape: "anthropic-oauth" });
const LOOPBACK_NAMES = ["upstream.test", "other.test", "plain.test", "echo.test", "dead.test"];

// ── Fixtures: upstreams, CA, proxy, listener ─────────────────────────────────────────────────────

const listen = (server, host = "127.0.0.1") => new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));

const upstreamPki = createCaCertificate({ commonName: "fake public root", days: 30 });
const upstreamLeaf = (hostname) => issueLeafCertificate({ caCertPem: upstreamPki.certPem, caKeyPem: upstreamPki.keyPem, hostname });

const seen = []; // { server, method, url, headers, bodyBytes }
function upstreamHandler(name) {
  return (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ server: name, method: req.method, url: req.url, headers: req.headers, body: body.toString() });
      if (req.url.startsWith("/leak-compressed")) {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "br" });
        res.end(`opaque ${req.headers.authorization}`);
      } else if (req.url.startsWith("/leak")) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-upstream": name });
        // Echo the credential in two writes so it can straddle chunks on the way back.
        const auth = String(req.headers.authorization || "");
        res.write(`you sent: ${auth.slice(0, 12)}`);
        setTimeout(() => res.end(`${auth.slice(12)} (done)`), 5);
      } else {
        res.writeHead(200, { "content-type": "application/json", connection: "keep-alive" });
        res.end(JSON.stringify({ ok: true, server: name, bytes: body.length }));
      }
    });
  };
}

const upstreamA = https.createServer({ ...(() => { const l = upstreamLeaf("upstream.test"); return { key: l.keyPem, cert: l.certPem }; })() }, upstreamHandler("upstream"));
upstreamA.on("upgrade", (req, socket, head) => {
  seen.push({ server: "upstream-ws", method: req.method, url: req.url, headers: req.headers });
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  if (head.length) socket.write(head);
  socket.on("data", (chunk) => socket.write(chunk));
  socket.on("error", () => {});
});
const upstreamB = https.createServer({ ...(() => { const l = upstreamLeaf("other.test"); return { key: l.keyPem, cert: l.certPem }; })() }, upstreamHandler("other"));
const plainUpstream = http.createServer(upstreamHandler("plain"));
const echoServer = net.createServer((socket) => { socket.on("error", () => {}); socket.pipe(socket); });

const portA = await listen(upstreamA);
const portB = await listen(upstreamB);
const plainPort = await listen(plainUpstream);
const echoPort = await listen(echoServer);
const deadPort = await (async () => { const s = net.createServer(); const p = await listen(s); await closeServer(s); return p; })();

const caStore = loadOrCreateEgressCa({ dir: path.join(tempDir("cg-egress-proxy-"), "egress-ca") });

const grants = new Map([
  [PH, { placeholder: PH, value: REAL, secretName: "GITHUB_TOKEN", scope: "channel", owner: "C_EGRESS", hosts: ["upstream.test", "plain.test"], headers: ["authorization"], format: "bearer" }],
  [PERSONAL_PH, { placeholder: PERSONAL_PH, value: PERSONAL_REAL, secretName: "MY_TOKEN", scope: "personal", owner: "U_OWNER", hosts: ["upstream.test"], headers: ["x-api-key"], format: "raw" }],
  [corePlaceholder(RELAY_TOKEN), { placeholder: corePlaceholder(RELAY_TOKEN), value: RELAY_REAL, secretName: "CLAUDE_CODE_OAUTH_TOKEN", scope: "relay", owner: null, hosts: ["upstream.test"], headers: ["authorization"], format: "bearer" }],
]);

const audits = [];
const lookups = [];
const proxy = createEgressProxy({
  ca: caStore,
  policyFor: (ctx) => {
    assert.equal(ctx, CTX);
    return { mode: "on", allowHosts: null, rawPassthrough: [{ host: "echo.test", port: echoPort }], engineHosts: [] };
  },
  resolveGrant: async (placeholder, ctx) => { assert.equal(ctx, CTX); return grants.get(placeholder) || null; },
  canUse: (grant) => (grant.scope === "personal" ? { ok: false, reason: "owner-not-live" } : { ok: true }),
  audit: (event) => audits.push(event),
  lookup: async (hostname) => {
    lookups.push(hostname);
    if (LOOPBACK_NAMES.includes(hostname)) return [{ address: "127.0.0.1", family: 4 }];
    if (hostname === "metadata.test") return [{ address: "169.254.169.254", family: 4 }];
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  },
  upstreamCa: [upstreamPki.certPem],
  allowLoopbackHosts: LOOPBACK_NAMES,
  connectTimeoutMs: 2000,
  headTimeoutMs: 1000,
  log: { warn() {}, log() {} },
});

const sockDir = trackTempDir(mkdtempSync("/tmp/cgeg-"));
const socketPath = path.join(sockDir, "p.sock");
const listener = net.createServer((socket) => proxy.serveEgressConnection(socket, CTX));
await new Promise((resolve) => listener.listen(socketPath, resolve));

// ── Client helpers (what the in-container forwarder + a client library do) ──────────────────────

// Open the proxy socket, send CONNECT, and resolve once the response head is in.
function connectVia(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buf = Buffer.alloc(0);
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf.toString("latin1"))?.[1]);
      const rest = buf.subarray(end + 4);
      if (status === 200) {
        if (rest.length) socket.unshift(rest);
        resolve({ socket, status });
        return;
      }
      let body = rest.toString();
      socket.on("data", (c) => { body += c; });
      socket.on("close", () => resolve({ socket, status, body }));
    };
    socket.on("data", onData);
  });
}

async function tlsVia(host, port) {
  const { socket, status } = await connectVia(host, port);
  assert.equal(status, 200);
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host, ca: [caStore.certPem], rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
    secure.once("secureConnect", () => resolve(secure));
    secure.once("error", reject);
  });
}

// One HTTPS request through the proxy. → { status, headers, body }
async function fetchVia({ host, port, method = "GET", path: reqPath = "/", headers = {}, body }) {
  const secure = await tlsVia(host, port);
  return new Promise((resolve, reject) => {
    const req = http.request({ createConnection: () => secure, host, port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { secure.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }); });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function waitFor(predicate, what) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const lastSeen = (server) => seen.filter((s) => s.server === server).at(-1);
const auditFor = (predicate) => audits.find(predicate);

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────────

test("parseAuthority accepts host:port and [v6]:port only", () => {
  assert.deepEqual(parseAuthority("API.GitHub.com:443"), { hostname: "api.github.com", port: 443 });
  assert.deepEqual(parseAuthority("[::1]:8443"), { hostname: "::1", port: 8443 });
  for (const bad of ["example.com", "example.com:0", "example.com:99999", ":443", "a:b:c", "", null]) assert.equal(parseAuthority(bad), null, String(bad));
});

test("the upstream sees the real value while the client sent the placeholder", async () => {
  const res = await fetchVia({ host: "upstream.test", port: portA, path: "/echo?q=1", headers: { authorization: `Bearer ${PH}` } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).server, "upstream");
  const saw = lastSeen("upstream");
  assert.equal(saw.headers.authorization, `Bearer ${REAL}`);
  assert.equal(saw.headers.host, `upstream.test:${portA}`, "Host is preserved");
  assert.equal(saw.headers["proxy-authorization"], undefined);
  await waitFor(() => auditFor((e) => e.path === "/echo"), "the /echo audit");
  const event = auditFor((e) => e.path === "/echo");
  assert.deepEqual(
    { hostname: event.hostname, port: event.port, method: event.method, status: event.status, tunnel: event.tunnel, blocked: event.blocked, swapped: event.swapped },
    { hostname: "upstream.test", port: portA, method: "GET", status: 200, tunnel: false, blocked: null, swapped: [{ secretName: "GITHUB_TOKEN", scope: "channel", owner: "C_EGRESS" }] },
  );
  assert.equal(event.ctx, CTX);
  assert.ok(event.bytesDown > 0 && event.ms >= 0);
});

test("a shaped relay token is swapped whole, and a streamed request body goes through", async () => {
  const payload = crypto.randomBytes(256 * 1024);
  const res = await fetchVia({ host: "upstream.test", port: portA, method: "POST", path: "/upload", headers: { authorization: `Bearer ${RELAY_TOKEN}`, "content-type": "application/octet-stream", "transfer-encoding": "chunked" }, body: payload });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).bytes, payload.length);
  assert.equal(lastSeen("upstream").headers.authorization, `Bearer ${RELAY_REAL}`);
  await waitFor(() => auditFor((e) => e.path === "/upload"), "the /upload audit");
  assert.equal(auditFor((e) => e.path === "/upload").bytesUp, payload.length);
});

test("a host the grant does not declare receives the placeholder unchanged", async () => {
  const res = await fetchVia({ host: "other.test", port: portB, path: "/echo", headers: { authorization: `Bearer ${PH}` } });
  assert.equal(res.status, 200);
  assert.equal(lastSeen("other").headers.authorization, `Bearer ${PH}`);
  await waitFor(() => auditFor((e) => e.hostname === "other.test"), "the other.test audit");
  const event = auditFor((e) => e.hostname === "other.test");
  assert.deepEqual(event.swapped, []);
  assert.deepEqual(event.refused, [{ secretName: "GITHUB_TOKEN", reason: "host" }]);
});

test("an echoed real value comes back scrubbed to the placeholder; compressed bodies pass untouched", async () => {
  const res = await fetchVia({ host: "upstream.test", port: portA, path: "/leak", headers: { authorization: `Bearer ${PH}` } });
  assert.equal(res.status, 200);
  assert.equal(lastSeen("upstream").headers.authorization, `Bearer ${REAL}`, "the upstream did get the value");
  assert.equal(res.body, `you sent: Bearer ${PH} (done)`);
  assert.ok(!res.body.includes(REAL));
  assert.equal(res.headers["content-length"], undefined, "a scrubbed body is re-framed");
  assert.equal(res.headers["x-upstream"], "upstream");
  // Documented limit: we never decompress, so a compressed echo is not scrubbed.
  const compressed = await fetchVia({ host: "upstream.test", port: portA, path: "/leak-compressed", headers: { authorization: `Bearer ${PH}` } });
  assert.equal(compressed.headers["content-encoding"], "br");
  assert.equal(compressed.body, `opaque Bearer ${REAL}`);
});

test("a canUse refusal answers 403 naming the secret and never reaches the upstream", async () => {
  const before = seen.length;
  const res = await fetchVia({ host: "upstream.test", port: portA, path: "/personal", headers: { "x-api-key": PERSONAL_PH } });
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.body), { error: "secret-refused", detail: "The credential MY_TOKEN may not be used right now (owner-not-live)." });
  assert.equal(seen.length, before);
  await waitFor(() => auditFor((e) => e.path === "/personal"), "the refusal audit");
  assert.equal(auditFor((e) => e.path === "/personal").status, 403);
});

test("refused destinations answer 403 with a category and are audited as blocked", async () => {
  const meta = await connectVia("metadata.test", 80);
  assert.equal(meta.status, 403);
  assert.equal(JSON.parse(meta.body).error, "blocked-address");
  assert.match(JSON.parse(meta.body).detail, /metadata/);
  const unknown = await connectVia("nowhere.test", 443);
  assert.equal(JSON.parse(unknown.body).error, "dns-failure");
  const literal = await connectVia("10.0.0.1", 443);
  assert.equal(JSON.parse(literal.body).error, "blocked-address");
  await waitFor(() => auditFor((e) => e.hostname === "metadata.test"), "the blocked audit");
  const event = auditFor((e) => e.hostname === "metadata.test");
  assert.deepEqual({ method: event.method, status: event.status, blocked: event.blocked }, { method: "CONNECT", status: 403, blocked: "blocked-address" });
});

test("an unreachable upstream answers 502 with a category", async () => {
  const res = await fetchVia({ host: "dead.test", port: deadPort, path: "/x" });
  assert.equal(res.status, 502);
  assert.equal(JSON.parse(res.body).error, "upstream-refused");
});

test("plain http: absolute-form requests are forwarded, but a grant without plainHttp is not swapped", async () => {
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: "GET", path: `http://plain.test:${plainPort}/plain?token=1`, headers: { host: `plain.test:${plainPort}`, authorization: `Bearer ${PH}` }, agent: false }, (r) => {
      let body = "";
      r.on("data", (c) => { body += c; });
      r.on("end", () => resolve({ status: r.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(res.status, 200);
  const saw = lastSeen("plain");
  assert.equal(saw.url, "/plain?token=1", "origin-form upstream");
  assert.equal(saw.headers.authorization, `Bearer ${PH}`);
  await waitFor(() => auditFor((e) => e.path === "/plain"), "the plain audit");
  assert.deepEqual(auditFor((e) => e.path === "/plain").refused, [{ secretName: "GITHUB_TOKEN", reason: "plain-http" }]);
});

test("a raw passthrough tunnel pipes bytes to a plain TCP server", async () => {
  const { socket, status } = await connectVia("echo.test", echoPort);
  assert.equal(status, 200);
  const echoed = await new Promise((resolve) => {
    let got = "";
    socket.on("data", (c) => { got += c; if (got.length >= 9) resolve(got); });
    socket.write("ping-pong");
  });
  assert.equal(echoed, "ping-pong");
  socket.end();
  await waitFor(() => auditFor((e) => e.tunnel), "the tunnel audit");
  const event = auditFor((e) => e.tunnel);
  assert.deepEqual({ hostname: event.hostname, status: event.status, bytesUp: event.bytesUp, bytesDown: event.bytesDown }, { hostname: "echo.test", status: 200, bytesUp: 9, bytesDown: 9 });
});

test("a WebSocket upgrade is swapped and then round-trips bytes", async () => {
  const secure = await tlsVia("upstream.test", portA);
  const head = await new Promise((resolve) => {
    let buf = "";
    const onData = (c) => {
      buf += c.toString("latin1");
      if (buf.includes("\r\n\r\n")) { secure.off("data", onData); resolve(buf); }
    };
    secure.on("data", onData);
    secure.write([
      "GET /ws?room=1 HTTP/1.1", `Host: upstream.test:${portA}`, "Upgrade: websocket", "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", `Authorization: Bearer ${PH}`, "", "",
    ].join("\r\n"));
  });
  assert.match(head, /^HTTP\/1\.1 101 /);
  assert.equal(lastSeen("upstream-ws").headers.authorization, `Bearer ${REAL}`);
  assert.equal(lastSeen("upstream-ws").headers.upgrade, "websocket");
  const frame = Buffer.from([0x81, 0x85, 1, 2, 3, 4, 0x69, 0x67, 0x6f, 0x68, 0x6e]);
  const echoed = await new Promise((resolve) => {
    const chunks = [];
    secure.on("data", (c) => { chunks.push(c); if (Buffer.concat(chunks).length >= frame.length) resolve(Buffer.concat(chunks)); });
    secure.write(frame);
  });
  assert.ok(echoed.equals(frame));
  secure.destroy();
  await waitFor(() => auditFor((e) => e.path === "/ws"), "the upgrade audit");
  const event = auditFor((e) => e.path === "/ws");
  assert.equal(event.status, 101);
  assert.deepEqual(event.swapped, [{ secretName: "GITHUB_TOKEN", scope: "channel", owner: "C_EGRESS" }]);
});

test("an oversized head gets 431 and a silent client is dropped", async () => {
  const big = await new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let out = "";
    socket.on("data", (c) => { out += c; });
    socket.on("close", () => resolve(out));
    socket.on("error", () => {});
    socket.write(`CONNECT upstream.test:${portA} HTTP/1.1\r\nX-Pad: ${"a".repeat(70 * 1024)}\r\n\r\n`);
  });
  assert.match(big, /^HTTP\/1\.1 431 /);
  assert.equal(JSON.parse(big.slice(big.indexOf("\r\n\r\n") + 4)).error, "head-too-large");
  const started = Date.now();
  await new Promise((resolve) => { const s = net.connect(socketPath); s.on("close", resolve); s.on("error", () => {}); });
  assert.ok(Date.now() - started < 5000, "the head timeout closed the idle connection");
});

test("audit events never carry a header value, a placeholder or a real value", () => {
  assert.ok(audits.length >= 10);
  const text = JSON.stringify(audits.map(({ ctx, ...rest }) => rest));
  for (const secret of [REAL, PH, PERSONAL_REAL, PERSONAL_PH, RELAY_REAL, corePlaceholder(RELAY_TOKEN), "Bearer", "cgph_", "q=1", "room=1"]) {
    assert.ok(!text.includes(secret), `audit leaked ${secret.slice(0, 12)}…`);
  }
  for (const event of audits) {
    assert.deepEqual(Object.keys(event).sort(), ["blocked", "bytesDown", "bytesUp", "ctx", "hostname", "method", "ms", "path", "port", "refused", "status", "swapped", "tunnel"]);
  }
  assert.ok(lookups.every((name) => !name.includes("cgph_")));
});

test("close() tears down live tunnels and refuses later connections", async () => {
  const { socket } = await connectVia("echo.test", echoPort);
  const closed = new Promise((resolve) => socket.on("close", resolve));
  proxy.close();
  await closed;
  assert.equal(proxy.liveSockets, 0);
  const late = await new Promise((resolve) => {
    const s = net.connect(socketPath);
    let out = "";
    s.on("data", (c) => { out += c; });
    s.on("close", () => resolve(out));
    s.on("error", () => resolve(out));
    s.on("connect", () => s.write(`CONNECT upstream.test:${portA} HTTP/1.1\r\n\r\n`));
  });
  assert.equal(late, "");
  await new Promise((resolve) => listener.close(resolve));
  upstreamA.closeAllConnections();
  upstreamB.closeAllConnections();
  plainUpstream.closeAllConnections();
  await Promise.all([closeServer(upstreamA), closeServer(upstreamB), closeServer(plainUpstream), closeServer(echoServer)]);
});
