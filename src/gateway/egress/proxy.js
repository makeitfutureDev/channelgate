// The daemon-side egress proxy: the only network a `--network none` channel container has.
//
// Why: a container holds placeholders, never real credentials (see placeholders.js). Something on
// the daemon side has to see each outbound request in the clear to swap a placeholder for the real
// value on the hosts that secret is declared for, refuse private/metadata destinations, and audit
// every destination. That is this module: an HTTP/1.1 proxy served per channel over a Unix socket
// (the caller owns the listener — one `net.createServer` per channel — and hands every accepted
// socket to `serveEgressConnection(socket, ctx)`; the socket PATH is the channel identity).
//
// Per client connection (HTTP/1.1 proxy protocol, first head capped at 64 KB / 10 s):
//   CONNECT host:port → destination policy (policy.js) →
//     refused      → 403 + {"error": category, "detail": sentence}, close;
//     raw tunnel   → a plain TCP pipe to the PINNED address (SSH, Postgres), no TLS termination;
//     otherwise    → 200, TLS-terminate with a leaf from the deployment CA (ca.js), then every
//                    request inside is parsed by an internal http.Server and forwarded over
//                    https to the pinned address with `servername` = the CONNECT host, headers
//                    swapped (rules.js), body streamed unbuffered, and — when a grant was swapped
//                    and the response is uncompressed text — the response scrubbed (scrub.js).
//                    WebSocket upgrades are swapped, then tunnelled byte-for-byte.
//   GET http://host/… (absolute-form) → policy, then plain-http forwarding; a grant swaps over
//                    plain http only when it sets `plainHttp: true`.
// A swap `canUse` refuses (owner not live, revoked) answers 403 naming the secret and the reason;
// a placeholder on a host, header or position its grant does not declare is forwarded UNCHANGED.
//
// Audit: one event per request or tunnel with names, counts and reasons — never a header value,
// a body, a placeholder or a real value. Limits (deliberate): HTTP/1.1 only (ALPN offers only
// http/1.1), compressed response bodies are passed through unscrubbed, request bodies are never
// swapped, trailers are dropped.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { checkDestination } from "./policy.js";
import { grantAllowsHost, normalizeHost, placeholdersInRequest, swapRequest } from "./rules.js";
import { createScrubber, isScrubbableContentType } from "./scrub.js";

const HEAD_LIMIT = 64 * 1024;
const META = Symbol("cgEgressMeta");
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
const noop = () => {};

// "host:port" / "[v6]:port" → { hostname, port } or null.
export function parseAuthority(authority) {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(String(authority ?? "").trim());
  if (!m) return null;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  return { hostname: normalizeHost(m[1] || m[2]), port };
}

function jsonBody(category, detail) {
  return JSON.stringify({ error: category, detail });
}

// A complete raw HTTP/1.1 response for a socket that has no http.ServerResponse.
function rawResponse(status, statusText, category, detail) {
  const body = jsonBody(category, detail);
  return `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

function upstreamFailure(err) {
  const code = err?.code || "";
  if (code === "CG_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return ["upstream-timeout", "The destination did not answer in time."];
  if (code === "ECONNREFUSED") return ["upstream-refused", "The destination refused the connection."];
  if (code.startsWith("ERR_TLS") || code.includes("CERT") || code.startsWith("ERR_SSL")) return ["upstream-tls", "The destination's TLS certificate could not be verified."];
  return ["upstream-unreachable", "The destination could not be reached."];
}

// Hop-by-hop headers (RFC 9110 §7.6.1), including any the Connection header names.
function connectionTokens(value) {
  return new Set(String(value ?? "").toLowerCase().split(",").map((t) => t.trim()).filter(Boolean));
}

function stripHopByHop(headers, { keepUpgrade = false } = {}) {
  const named = connectionTokens(headers.connection);
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (keepUpgrade && (key === "connection" || key === "upgrade")) { out[name] = value; continue; }
    if (HOP_BY_HOP.has(key) || named.has(key)) continue;
    out[name] = value;
  }
  return out;
}

function stripRawHopByHop(rawHeaders, extra = []) {
  const named = new Set(extra);
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === "connection") for (const t of connectionTokens(rawHeaders[i + 1])) named.add(t);
  }
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i].toLowerCase();
    if (!HOP_BY_HOP.has(key) && !named.has(key)) out.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  return out;
}

const pathOnly = (p) => String(p ?? "").split("?")[0].split("#")[0] || "/";

export function createEgressProxy({
  ca,
  policyFor,
  resolveGrant,
  canUse,
  audit,
  lookup,
  connectTimeoutMs = 15_000,
  headTimeoutMs = 10_000,
  log = console,
  // Extra roots for verifying UPSTREAM certificates (a private PKI; the test suite's fake upstream).
  // Production leaves this unset: the system trust store verifies every upstream.
  upstreamCa,
  // TEST-ONLY: hostnames allowed to resolve to loopback (see policy.js). Never set in production.
  allowLoopbackHosts = [],
}) {
  const live = new Set();
  const contexts = new WeakMap();
  const httpsAgent = new https.Agent({ keepAlive: true, ...(upstreamCa ? { ca: upstreamCa } : {}) });
  const httpAgent = new http.Agent({ keepAlive: true });
  let closed = false;

  function track(socket) {
    live.add(socket);
    socket.on("error", noop); // every socket error surfaces as 'close'; handlers below decide
    socket.once("close", () => live.delete(socket));
    if (closed) socket.destroy();
    return socket;
  }

  function emitAudit(event) {
    try {
      audit?.(event);
    } catch (err) {
      log?.warn?.(`[egress] audit callback failed: ${err?.message || err}`);
    }
  }

  function auditEvent(base, fields) {
    emitAudit({
      ctx: base.ctx, hostname: base.hostname ?? null, port: base.port ?? null, method: base.method ?? null,
      path: base.path ?? null, status: 0, swapped: [], refused: [], tunnel: false, blocked: null,
      bytesUp: 0, bytesDown: 0, ms: Date.now() - base.started, ...fields,
    });
  }

  async function decide(ctx, hostname, port) {
    try {
      const policy = (await policyFor(ctx)) || {};
      return await checkDestination({ hostname, port, ...policy, lookup, allowLoopbackHosts });
    } catch (err) {
      log?.warn?.(`[egress] policy check failed: ${err?.message || err}`);
      return { ok: false, category: "policy", reason: "The network policy could not be evaluated." };
    }
  }

  function secureContextFor(hostname) {
    const entry = ca.leafFor(hostname);
    let context = contexts.get(entry);
    if (!context) {
      context = tls.createSecureContext({ key: entry.key, cert: entry.cert });
      contexts.set(entry, context);
    }
    return context;
  }

  // Arm a connect deadline on an outbound socket; cleared on connect/secureConnect/close.
  function connectDeadline(socket, onTimeout, secure) {
    const timer = setTimeout(onTimeout, connectTimeoutMs);
    timer.unref();
    const clear = () => clearTimeout(timer);
    socket.once(secure ? "secureConnect" : "connect", clear);
    socket.once("close", clear);
  }

  // Resolve every placeholder the request carries, and canUse for the grants whose hosts match,
  // up front (both callbacks may be async); the swap itself is synchronous.
  async function prepareSwap(ctx, headers, path, hostname) {
    const grants = new Map();
    const verdicts = new Map();
    for (const core of placeholdersInRequest({ headers, path })) {
      let grant = null;
      try { grant = (await resolveGrant(core, ctx)) || null; } catch (err) { log?.warn?.(`[egress] resolveGrant failed: ${err?.message || err}`); }
      grants.set(core, grant);
      if (grant && !verdicts.has(grant) && grantAllowsHost(grant, hostname)) {
        let verdict;
        try { verdict = canUse ? await canUse(grant, ctx) : { ok: true }; } catch { verdict = { ok: false, reason: "denied" }; }
        verdicts.set(grant, verdict);
      }
    }
    return {
      resolveGrant: (core) => grants.get(core) || null,
      canUse: (grant) => verdicts.get(grant) || { ok: false, reason: "denied" },
    };
  }

  function deniedDetail(refused) {
    const denied = refused.filter((r) => r.denied);
    if (!denied.length) return null;
    const names = [...new Set(denied.map((r) => r.secretName || "a secret"))].join(", ");
    const reasons = [...new Set(denied.map((r) => r.reason))].join(", ");
    return `The credential ${names} may not be used right now (${reasons}).`;
  }

  // ── HTTP forwarding (inside a terminated TLS connection, or plain absolute-form http) ─────────

  async function forward({ req, res, ctx, secure, hostname, port, address, path }) {
    const base = { ctx, hostname, port, method: req.method, path: pathOnly(path), started: Date.now() };
    let bytesUp = 0;
    let bytesDown = 0;
    let status = 0;
    let swap = { swapped: [], refused: [] };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      auditEvent(base, { status, swapped: swap.swapped, refused: swap.refused, bytesUp, bytesDown });
    };
    res.once("close", finish);
    res.on("error", noop);

    const headers = stripHopByHop(req.headers);
    const prepared = await prepareSwap(ctx, headers, path, hostname);
    if (finished) return; // the client left while grants were resolved: send nothing upstream
    swap = swapRequest({ headers, path, hostname, ...prepared, plainHttp: !secure });
    const denied = deniedDetail(swap.refused);
    if (denied) {
      status = 403;
      swap = { swapped: [], refused: swap.refused }; // nothing was sent, so nothing was swapped
      req.resume();
      res.writeHead(403, { "content-type": "application/json", connection: "close" }).end(jsonBody("secret-refused", denied));
      return;
    }

    const options = {
      host: address, port, method: req.method, path: swap.path, headers: swap.headers, setHost: false,
      agent: secure ? httpsAgent : httpAgent,
      ...(secure ? { servername: net.isIP(hostname) ? "" : hostname } : {}),
    };
    const upReq = (secure ? https : http).request(options);
    upReq.on("socket", (socket) => {
      if (socket.connecting) {
        connectDeadline(socket, () => upReq.destroy(Object.assign(new Error("connect timeout"), { code: "CG_CONNECT_TIMEOUT" })), secure);
      }
    });
    upReq.on("error", (err) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const [category, detail] = upstreamFailure(err);
      status = 502;
      res.writeHead(502, { "content-type": "application/json", connection: "close" }).end(jsonBody(category, detail));
    });
    upReq.on("response", (upRes) => {
      status = upRes.statusCode;
      const contentType = upRes.headers["content-type"];
      const scrubbing = swap.swapped.length > 0 && !upRes.headers["content-encoding"] && isScrubbableContentType(contentType);
      // A scrubbed body can change length, so it goes out chunked instead.
      const outHeaders = stripRawHopByHop(upRes.rawHeaders, scrubbing ? ["content-length"] : []);
      upRes.on("data", (chunk) => { bytesDown += chunk.length; });
      upRes.on("error", () => res.destroy());
      upRes.on("close", () => { if (!upRes.complete) res.destroy(); });
      try {
        res.writeHead(status, upRes.statusMessage, outHeaders);
      } catch (err) {
        log?.warn?.(`[egress] upstream response headers rejected: ${err?.message || err}`);
        upRes.destroy();
        res.destroy();
        return;
      }
      (scrubbing ? upRes.pipe(createScrubber(swap.scrub, contentType)) : upRes).pipe(res);
    });
    res.once("close", () => { if (!res.writableFinished) upReq.destroy(); });
    req.on("data", (chunk) => { bytesUp += chunk.length; });
    req.on("error", () => upReq.destroy());
    req.pipe(upReq);
  }

  // ── WebSocket (and any other Upgrade): swap the handshake, then pipe bytes ────────────────────

  async function upgrade({ req, socket, head, ctx, secure, hostname, port, address, path }) {
    const base = { ctx, hostname, port, method: req.method, path: pathOnly(path), started: Date.now() };
    let bytesUp = head.length;
    let bytesDown = 0;
    let status = 0;
    let swap = { swapped: [], refused: [] };
    const headers = stripHopByHop(req.headers, { keepUpgrade: true });
    const prepared = await prepareSwap(ctx, headers, path, hostname);
    if (socket.destroyed) return;
    swap = swapRequest({ headers, path, hostname, ...prepared, plainHttp: !secure });
    const denied = deniedDetail(swap.refused);
    if (denied) {
      socket.end(rawResponse(403, "Forbidden", "secret-refused", denied));
      auditEvent(base, { status: 403, refused: swap.refused });
      return;
    }
    const upstream = track(secure
      ? tls.connect({ host: address, port, servername: net.isIP(hostname) ? "" : hostname, ALPNProtocols: ["http/1.1"], ...(upstreamCa ? { ca: upstreamCa } : {}) })
      : net.connect({ host: address, port }));
    let connected = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (status !== 502) socket.destroy(); // a 502 written by .end() drains, then closes
      upstream.destroy();
      auditEvent(base, { status, swapped: swap.swapped, refused: swap.refused, bytesUp, bytesDown });
    };
    connectDeadline(upstream, () => upstream.destroy(Object.assign(new Error("connect timeout"), { code: "CG_CONNECT_TIMEOUT" })), secure);
    upstream.once("error", (err) => {
      if (connected) return;
      const [category, detail] = upstreamFailure(err);
      status = 502;
      socket.end(rawResponse(502, "Bad Gateway", category, detail));
    });
    upstream.once(secure ? "secureConnect" : "connect", () => {
      connected = true;
      const lines = [`${req.method} ${swap.path} HTTP/1.1`];
      for (const [name, value] of Object.entries(swap.headers)) {
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.once("data", (chunk) => {
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(chunk.toString("latin1", 0, 16));
        status = m ? Number(m[1]) : 0;
      });
      upstream.on("data", (chunk) => { bytesDown += chunk.length; });
      socket.on("data", (chunk) => { bytesUp += chunk.length; });
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.once("close", finish);
    socket.once("close", finish);
  }

  // ── The TLS-terminated side ────────────────────────────────────────────────────────────────────

  // Neither parser server ever listens: sockets are handed in. requestTimeout 0 keeps a long
  // upload (a big `git push`) from ever being cut; our own head/connect deadlines do that job.
  const serverOptions = { maxHeaderSize: HEAD_LIMIT, requireHostHeader: false, requestTimeout: 0 };
  const inner = http.createServer(serverOptions);
  inner.keepAliveTimeout = 30_000;
  inner.on("request", (req, res) => {
    const meta = req.socket[META];
    req.socket.setTimeout(0);
    forward({ req, res, ctx: meta.ctx, secure: true, hostname: meta.hostname, port: meta.port, address: meta.address, path: req.url })
      .catch((err) => { log?.warn?.(`[egress] forward failed: ${err?.message || err}`); res.destroy(); });
  });
  inner.on("upgrade", (req, socket, head) => {
    const meta = socket[META];
    socket.setTimeout(0);
    upgrade({ req, socket, head, ctx: meta.ctx, secure: true, hostname: meta.hostname, port: meta.port, address: meta.address, path: req.url })
      .catch((err) => { log?.warn?.(`[egress] upgrade failed: ${err?.message || err}`); socket.destroy(); });
  });
  inner.on("connect", (_req, socket) => socket.end(rawResponse(405, "Method Not Allowed", "nested-connect", "CONNECT inside a tunnel is not supported.")));
  inner.on("clientError", (err, socket) => clientError(err, socket));

  function terminate({ socket, head, ctx, hostname, port, address }) {
    let context;
    try {
      context = secureContextFor(hostname);
    } catch (err) {
      socket.end(rawResponse(403, "Forbidden", "invalid-destination", "No certificate can be issued for this destination."));
      return false;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    // The certificate always names the CONNECT host: that is the destination policy approved and
    // the one the upstream connection is pinned to, whatever SNI the client sends.
    const tlsSocket = track(new tls.TLSSocket(socket, {
      isServer: true,
      secureContext: context,
      SNICallback: (_servername, cb) => {
        try { cb(null, secureContextFor(hostname)); } catch (err) { cb(err); }
      },
      ALPNProtocols: ["http/1.1"],
    }));
    tlsSocket[META] = { ctx, hostname, port, address };
    tlsSocket.setTimeout(headTimeoutMs);
    tlsSocket.on("timeout", () => tlsSocket.destroy());
    tlsSocket.once("close", () => socket.destroy());
    inner.emit("connection", tlsSocket);
    return true;
  }

  // A raw CONNECT tunnel (no TLS termination) to the pinned address. A connect failure answers
  // 502 on the client socket and lets that response drain before the socket closes.
  function tunnel({ socket, head, base, address, port }) {
    const upstream = track(net.connect({ host: address, port }));
    let bytesUp = 0;
    let bytesDown = 0;
    let status = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (status !== 502) socket.destroy();
      upstream.destroy();
      auditEvent(base, { status, tunnel: true, bytesUp, bytesDown });
    };
    connectDeadline(upstream, () => upstream.destroy(Object.assign(new Error("connect timeout"), { code: "CG_CONNECT_TIMEOUT" })), false);
    upstream.once("error", (err) => {
      if (status) return;
      const [category, detail] = upstreamFailure(err);
      status = 502;
      socket.end(rawResponse(502, "Bad Gateway", category, detail));
    });
    upstream.once("connect", () => {
      status = 200;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) { bytesUp += head.length; upstream.write(head); }
      socket.on("data", (chunk) => { bytesUp += chunk.length; });
      upstream.on("data", (chunk) => { bytesDown += chunk.length; });
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.once("close", finish);
    socket.once("close", finish);
  }

  async function onConnect(req, socket, head) {
    socket.setTimeout(0);
    const ctx = socket[META]?.ctx;
    const target = parseAuthority(req.url);
    const base = { ctx, hostname: target?.hostname ?? null, port: target?.port ?? null, method: "CONNECT", path: null, started: Date.now() };
    const deny = (category, reason) => {
      socket.end(rawResponse(403, "Forbidden", category, reason));
      auditEvent(base, { status: 403, blocked: category });
    };
    if (!target) return deny("invalid-destination", "CONNECT needs a host:port target.");
    const decision = await decide(ctx, target.hostname, target.port);
    if (socket.destroyed) return undefined;
    if (!decision.ok) return deny(decision.category, decision.reason);
    if (decision.tunnel) return tunnel({ socket, head, base, address: decision.address, port: target.port });
    return terminate({ socket, head, ctx, hostname: target.hostname, port: target.port, address: decision.address });
  }

  // ── The plain side (what the client socket speaks first) ──────────────────────────────────────

  async function onPlainRequest(req, res) {
    req.socket.setTimeout(0);
    const ctx = req.socket[META]?.ctx;
    let url = null;
    try { url = new URL(req.url); } catch { url = null; }
    const hostname = url ? normalizeHost(url.hostname) : null;
    const port = url ? Number(url.port || 80) : null;
    const base = { ctx, hostname, port, method: req.method, path: url ? pathOnly(url.pathname) : null, started: Date.now() };
    const reject = (status, category, detail) => {
      req.resume();
      res.writeHead(status, { "content-type": "application/json", connection: "close" }).end(jsonBody(category, detail));
      auditEvent(base, { status, blocked: category });
    };
    if (!url || url.protocol !== "http:") return reject(400, "not-a-proxy-request", "Send CONNECT for https, or an absolute http:// URL.");
    const decision = await decide(ctx, hostname, port);
    if (!decision.ok) return reject(403, decision.category, decision.reason);
    return forward({ req, res, ctx, secure: false, hostname, port, address: decision.address, path: `${url.pathname}${url.search}` });
  }

  async function onPlainUpgrade(req, socket, head) {
    socket.setTimeout(0);
    const ctx = socket[META]?.ctx;
    let url = null;
    try { url = new URL(req.url); } catch { url = null; }
    if (!url || url.protocol !== "http:") {
      socket.end(rawResponse(400, "Bad Request", "not-a-proxy-request", "Send CONNECT for https, or an absolute http:// URL."));
      return;
    }
    const hostname = normalizeHost(url.hostname);
    const port = Number(url.port || 80);
    const decision = await decide(ctx, hostname, port);
    if (!decision.ok) {
      socket.end(rawResponse(403, "Forbidden", decision.category, decision.reason));
      auditEvent({ ctx, hostname, port, method: req.method, path: pathOnly(url.pathname), started: Date.now() }, { status: 403, blocked: decision.category });
      return;
    }
    await upgrade({ req, socket, head, ctx, secure: false, hostname, port, address: decision.address, path: `${url.pathname}${url.search}` });
  }

  // A parse error gets a JSON 400/431; a transport error (reset, TLS alert) just closes.
  function clientError(err, socket) {
    if (!String(err?.code || "").startsWith("HPE_") || !socket.writable || socket.destroyed) { socket.destroy(); return; }
    const tooLarge = err?.code === "HPE_HEADER_OVERFLOW";
    socket.end(tooLarge
      ? rawResponse(431, "Request Header Fields Too Large", "head-too-large", "The request head exceeds 64 KB.")
      : rawResponse(400, "Bad Request", "bad-request", "The request could not be parsed."));
  }

  const front = http.createServer(serverOptions);
  front.on("connect", (req, socket, head) => {
    onConnect(req, socket, head).catch((err) => { log?.warn?.(`[egress] CONNECT failed: ${err?.message || err}`); socket.destroy(); });
  });
  front.on("request", (req, res) => {
    onPlainRequest(req, res).catch((err) => { log?.warn?.(`[egress] request failed: ${err?.message || err}`); res.destroy(); });
  });
  front.on("upgrade", (req, socket, head) => {
    onPlainUpgrade(req, socket, head).catch((err) => { log?.warn?.(`[egress] upgrade failed: ${err?.message || err}`); socket.destroy(); });
  });
  front.on("clientError", (err, socket) => clientError(err, socket));

  // Hand one accepted client connection to the proxy. `ctx` is opaque here: it is passed back to
  // policyFor / resolveGrant / canUse / audit (the channel, typically).
  function serveEgressConnection(socket, ctx) {
    track(socket);
    if (closed) return;
    socket[META] = { ctx };
    socket.setTimeout(headTimeoutMs);
    socket.on("timeout", () => socket.destroy());
    front.emit("connection", socket);
  }

  // Destroy every live client, tunnel and upstream socket; later connections are refused.
  function close() {
    closed = true;
    for (const socket of live) socket.destroy();
    live.clear();
    httpsAgent.destroy();
    httpAgent.destroy();
  }

  return { serveEgressConnection, close, get liveSockets() { return live.size; } };
}
