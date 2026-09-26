// Review fixes to the egress proxy core (src/gateway/egress/proxy.js, policy.js, rules.js, scrub.js).
// Real sockets and real TLS, like test/egress-proxy.test.js; fake hostnames resolve through an
// injected lookup to a 127.0.0.1 upstream that the TEST-ONLY allowLoopbackHosts admits.
//
// What must hold:
//  1. an absolute-form request line inside a TLS tunnel is refused (400), never forwarded as a path,
//     and a request with NO Host header is never swapped into — the upstream Host is always the
//     CONNECT host;
//  2. a Host header naming another host than the CONNECT/URL host is refused (403, domain fronting);
//  3. a personal-grant style refusal from the wrong channel does not name the secret;
//  4. a swapped request asks for `identity`, response HEADER values are scrubbed, a non-101 answer
//     to an Upgrade is scrubbed, a response with no Content-Type is scrubbed, octet-stream is not;
//  5. a DNS lookup that never answers is cut off (504 dns-timeout), in-flight lookups per channel
//     are capped (503), and an upstream that never sends headers is cut off (504);
//  6. upstream verification uses the deliberate root set with rejectUnauthorized.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { ensureTestEnv, tempDir, trackTempDir } from "./helpers.js";

ensureTestEnv();

const { createEgressProxy } = await import("../src/gateway/egress/proxy.js");
const { loadOrCreateEgressCa } = await import("../src/gateway/egress/ca.js");
const { createCaCertificate, issueLeafCertificate } = await import("../src/gateway/egress/x509.js");
const { mintPlaceholder } = await import("../src/gateway/egress/placeholders.js");

const CTX = { channelId: "C_HARD", slug: "hard" };
const REAL = `real-hard-${crypto.randomBytes(16).toString("hex")}`;
const PH = mintPlaceholder({ scope: "channel" });
const FOREIGN_PH = mintPlaceholder({ scope: "channel" });
const NAMES = ["upstream.test", "front.test", "slow.test"];

const pki = createCaCertificate({ commonName: "hardening root", days: 30 });
const leafFor = (host) => issueLeafCertificate({ caCertPem: pki.certPem, caKeyPem: pki.keyPem, hostname: host });
const seen = [];
const hung = new Set();
function handler(req, res) {
  seen.push({ url: req.url, headers: req.headers });
  const auth = String(req.headers.authorization || "");
  if (req.url === "/hang") { hung.add(res); return; }
  if (req.url === "/echo-headers") {
    res.writeHead(302, { location: `https://elsewhere.example/?t=${auth.slice(7)}`, "www-authenticate": `Bearer realm="${auth}"`, "content-type": "text/plain" });
    res.end("moved");
  } else if (req.url === "/no-type") {
    res.writeHead(200, {});
    res.end(`echo ${auth}`);
  } else if (req.url === "/binary") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(`echo ${auth}`);
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }
}
const upstreamLeaf = leafFor("upstream.test");
const upstream = https.createServer({ key: upstreamLeaf.keyPem, cert: upstreamLeaf.certPem }, handler);
upstream.on("upgrade", (req, socket) => {
  seen.push({ url: req.url, headers: req.headers, upgrade: true });
  const body = `denied for ${req.headers.authorization}`;
  socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nX-Echo: ${req.headers.authorization}\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
});
const port = await new Promise((resolve) => upstream.listen(0, "127.0.0.1", () => resolve(upstream.address().port)));

const grants = new Map([
  [PH, { placeholder: PH, value: REAL, secretName: "GITHUB_TOKEN", scope: "channel", owner: null, hosts: ["upstream.test", "front.test"], headers: ["authorization"], format: "bearer" }],
  [FOREIGN_PH, { placeholder: FOREIGN_PH, value: `other-${REAL}`, secretName: "SECRET_ELSEWHERE", scope: "channel", owner: null, hosts: ["upstream.test"], headers: ["authorization"], format: "bearer" }],
]);
const audits = [];
const pendingLookups = [];
function makeProxy(overrides = {}) {
  return createEgressProxy({
    ca: loadOrCreateEgressCa({ dir: path.join(tempDir("cg-eghard-"), "egress-ca") }),
    policyFor: () => ({ mode: "on", engineHosts: [], rawPassthrough: [] }),
    resolveGrant: async (core) => grants.get(core) || null,
    canUse: (grant) => (grant.secretName === "SECRET_ELSEWHERE" ? { ok: false, reason: "other-channel" } : { ok: true }),
    audit: (event) => audits.push(event),
    lookup: async (hostname) => {
      if (hostname === "slow.test") return new Promise((resolve) => pendingLookups.push(resolve)); // never answers by itself
      if (NAMES.includes(hostname)) return [{ address: "127.0.0.1", family: 4 }];
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    },
    upstreamCa: [pki.certPem],
    allowLoopbackHosts: NAMES,
    headTimeoutMs: 2000,
    log: { warn() {}, log() {} },
    ...overrides,
  });
}

const dir = trackTempDir(mkdtempSync("/tmp/cgegh-"));
let n = 0;
async function listenFor(proxy) {
  const socketPath = path.join(dir, `p${n += 1}.sock`);
  const server = net.createServer((socket) => proxy.serveEgressConnection(socket, CTX));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { socketPath, server };
}
const main = makeProxy();
const mainListener = await listenFor(main);

function connectVia(socketPath, host, targetPort = port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buf = Buffer.alloc(0);
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n\r\n`));
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf.toString("latin1"))?.[1]);
      if (status === 200) return resolve({ socket, status });
      let body = buf.subarray(end + 4).toString();
      socket.on("data", (c) => { body += c; });
      socket.on("close", () => resolve({ status, body }));
    };
    socket.on("data", onData);
  });
}

// One raw request over TLS through the tunnel; → the whole raw response text once the server closes
// or `until` matches.
async function rawVia({ socketPath = mainListener.socketPath, host = "upstream.test", request, until = null }) {
  const { socket, status } = await connectVia(socketPath, host);
  assert.equal(status, 200);
  const secure = tls.connect({ socket, servername: host, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
  await new Promise((resolve, reject) => { secure.once("secureConnect", resolve); secure.once("error", reject); });
  return new Promise((resolve) => {
    let out = "";
    const done = () => { secure.destroy(); resolve(out); };
    secure.on("data", (c) => { out += c.toString("latin1"); if (until && until(out)) done(); });
    secure.on("close", () => resolve(out));
    secure.on("error", () => resolve(out));
    secure.write(request);
  });
}
const complete = (text) => {
  const end = text.indexOf("\r\n\r\n");
  if (end < 0) return false;
  const length = /content-length: (\d+)/i.exec(text.slice(0, end));
  return length ? text.length >= end + 4 + Number(length[1]) : /\r\n0\r\n\r\n$/.test(text);
};
const statusOf = (text) => Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]);
const bodyOf = (text) => text.slice(text.indexOf("\r\n\r\n") + 4);
// The proxy's own JSON answers may be chunked: take the one JSON object out of the body.
const jsonOf = (text) => { const body = bodyOf(text); return JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)); };

test("an absolute-form request line inside the tunnel is refused, never forwarded", async () => {
  const before = seen.length;
  const out = await rawVia({ request: `GET https://tenant.vercel.app/steal HTTP/1.1\r\nHost: upstream.test:${port}\r\nAuthorization: Bearer ${PH}\r\n\r\n`, until: complete });
  assert.equal(statusOf(out), 400);
  assert.equal(jsonOf(out).error, "absolute-form-in-tunnel");
  assert.equal(seen.length, before, "nothing reached the upstream");
});

test("no Host header: nothing is swapped, and the upstream Host is forced to the CONNECT host", async () => {
  const out = await rawVia({ request: `GET /plain HTTP/1.1\r\nAuthorization: Bearer ${PH}\r\nConnection: close\r\n\r\n` });
  assert.equal(statusOf(out), 200);
  const saw = seen.at(-1);
  assert.equal(saw.headers.authorization, `Bearer ${PH}`, "a request tied to no host gets no real value");
  assert.equal(saw.headers.host, `upstream.test:${port}`);
});

test("a Host header naming another host than the CONNECT host is refused (domain fronting)", async () => {
  const before = seen.length;
  const out = await rawVia({ request: `GET /x HTTP/1.1\r\nHost: front.test\r\nAuthorization: Bearer ${PH}\r\n\r\n`, until: complete });
  assert.equal(statusOf(out), 403);
  assert.equal(jsonOf(out).error, "host-mismatch");
  assert.equal(seen.length, before);
  const event = audits.find((e) => e.blocked === "host-mismatch");
  assert.ok(event, "audited as blocked");
});

test("plain http: a Host header that differs from the absolute URL's host is refused", async () => {
  const plain = http.createServer((req, res) => { seen.push({ url: req.url, headers: req.headers, plain: true }); res.end("ok"); });
  const plainPort = await new Promise((resolve) => plain.listen(0, "127.0.0.1", () => resolve(plain.address().port)));
  try {
    const ask = (host) => new Promise((resolve, reject) => {
      const req = http.request({ socketPath: mainListener.socketPath, path: `http://upstream.test:${plainPort}/p`, headers: { host }, agent: false }, (r) => {
        let body = "";
        r.on("data", (c) => { body += c; });
        r.on("end", () => resolve({ status: r.statusCode, body }));
      });
      req.on("error", reject);
      req.end();
    });
    const fronted = await ask("front.test");
    assert.equal(fronted.status, 403);
    assert.equal(JSON.parse(fronted.body).error, "host-mismatch");
    assert.equal((await ask(`upstream.test:${plainPort}`)).status, 200);
  } finally {
    await new Promise((resolve) => plain.close(resolve));
  }
});

test("a placeholder presented from the wrong channel is refused without naming the secret", async () => {
  const out = await rawVia({ request: `GET /x HTTP/1.1\r\nHost: upstream.test:${port}\r\nAuthorization: Bearer ${FOREIGN_PH}\r\n\r\n`, until: complete });
  assert.equal(statusOf(out), 403);
  const body = jsonOf(out);
  assert.equal(body.error, "secret-refused");
  assert.equal(body.detail, "A credential in this request is not valid from this channel.");
  assert.ok(!out.includes("SECRET_ELSEWHERE"));
});

test("a swapped request asks for identity and its response headers are scrubbed", async () => {
  const out = await rawVia({ request: `GET /echo-headers HTTP/1.1\r\nHost: upstream.test:${port}\r\nAccept-Encoding: gzip, br\r\nAuthorization: Bearer ${PH}\r\n\r\n`, until: complete });
  assert.equal(statusOf(out), 302);
  const saw = seen.at(-1);
  assert.equal(saw.headers["accept-encoding"], "identity", "no compression can hide an echo from the scrub");
  assert.ok(!out.includes(REAL), "no real value in any response header");
  assert.match(out, new RegExp(`location: https://elsewhere\\.example/\\?t=${PH}`, "i"));
  assert.match(out, new RegExp(`www-authenticate: Bearer realm="Bearer ${PH}"`, "i"));
});

test("a response with no Content-Type is scrubbed; a declared binary one passes through", async () => {
  const untyped = await rawVia({ request: `GET /no-type HTTP/1.1\r\nHost: upstream.test:${port}\r\nAuthorization: Bearer ${PH}\r\nConnection: close\r\n\r\n` });
  assert.equal(statusOf(untyped), 200);
  assert.ok(!untyped.includes(REAL));
  assert.ok(untyped.includes(`echo Bearer ${PH}`));
  const binary = await rawVia({ request: `GET /binary HTTP/1.1\r\nHost: upstream.test:${port}\r\nAuthorization: Bearer ${PH}\r\nConnection: close\r\n\r\n` });
  assert.ok(binary.includes(`echo Bearer ${REAL}`), "octet-stream is not rewritten (documented)");
});

test("a non-101 answer to an Upgrade is scrubbed, headers and body", async () => {
  const out = await rawVia({
    request: [`GET /ws HTTP/1.1`, `Host: upstream.test:${port}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", `Authorization: Bearer ${PH}`, "", ""].join("\r\n"),
  });
  assert.equal(statusOf(out), 401);
  assert.equal(seen.at(-1).headers.authorization, `Bearer ${REAL}`, "the upstream did get the value");
  assert.ok(!out.includes(REAL), "neither the X-Echo header nor the body carries it back");
  assert.ok(out.includes(`denied for Bearer ${PH}`));
  assert.match(out, new RegExp(`x-echo: Bearer ${PH}`, "i"));
});

test("a DNS lookup that never answers is cut off, and in-flight lookups per channel are capped", async () => {
  const proxy = makeProxy({ lookupTimeoutMs: 150, maxLookupsPerChannel: 1 });
  const { socketPath, server } = await listenFor(proxy);
  try {
    const first = connectVia(socketPath, "slow.test");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await connectVia(socketPath, "slow.test");
    assert.equal(second.status, 503);
    assert.equal(JSON.parse(second.body).error, "too-many-lookups");
    const timedOut = await first;
    assert.equal(timedOut.status, 504);
    assert.equal(JSON.parse(timedOut.body).error, "dns-timeout");
    // The slot is free again once the first decision ended.
    const third = await connectVia(socketPath, "upstream.test");
    assert.equal(third.status, 200);
    third.socket.destroy();
  } finally {
    proxy.close();
    await new Promise((resolve) => server.close(resolve));
    for (const resolve of pendingLookups.splice(0)) resolve([]);
  }
});

test("an upstream that never sends response headers is cut off with 504", async () => {
  const proxy = makeProxy({ responseHeaderTimeoutMs: 150 });
  const { socketPath, server } = await listenFor(proxy);
  try {
    const out = await rawVia({ socketPath, request: `GET /hang HTTP/1.1\r\nHost: upstream.test:${port}\r\n\r\n`, until: complete });
    assert.equal(statusOf(out), 504);
    assert.equal(jsonOf(out).error, "upstream-timeout");
  } finally {
    proxy.close();
    await new Promise((resolve) => server.close(resolve));
    for (const res of hung) res.destroy();
  }
});

test("upstream trust: the host bundle is added to Node's roots, and verification is never optional", async () => {
  const bundle = path.join(tempDir("cg-eghost-"), "ca-certificates.crt");
  writeFileSync(bundle, pki.certPem);
  const trusted = makeProxy({ upstreamCa: undefined, systemCaBundle: bundle });
  const untrusted = makeProxy({ upstreamCa: undefined, systemCaBundle: path.join(dir, "missing.crt") });
  const a = await listenFor(trusted);
  const b = await listenFor(untrusted);
  try {
    const ok = await rawVia({ socketPath: a.socketPath, request: `GET /plain HTTP/1.1\r\nHost: upstream.test:${port}\r\nConnection: close\r\n\r\n` });
    assert.equal(statusOf(ok), 200, "a root from the host bundle verifies the upstream");
    const refused = await rawVia({ socketPath: b.socketPath, request: `GET /plain HTTP/1.1\r\nHost: upstream.test:${port}\r\n\r\n`, until: complete });
    assert.equal(statusOf(refused), 502);
    assert.equal(jsonOf(refused).error, "upstream-tls");
  } finally {
    trusted.close();
    untrusted.close();
    await Promise.all([a, b].map(({ server }) => new Promise((resolve) => server.close(resolve))));
  }
});

test.after(async () => {
  main.close();
  await new Promise((resolve) => mainListener.server.close(resolve));
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});
