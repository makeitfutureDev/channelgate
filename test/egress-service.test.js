// The daemon's egress service (src/gateway/egress/service.js) end to end: boot writes the trust
// bundle and registers the container backend's hook; one listener per channel under a SHORT path
// whose accepted sockets carry that channel's identity; the policy reads the channel's CURRENT meta
// on every request; the swap gate is channel binding + liveness; audit rows only for swaps,
// refusals, blocks and tunnels; and a service that is down makes a proxy-mode run fail closed.
//
// Real sockets, real TLS: fake hostnames resolve through an injected lookup to a 127.0.0.1 upstream
// that the TEST-ONLY allowLoopbackHosts admits (production refuses loopback outright).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { ensureTestEnv, tempDir, trackTempDir } from "./helpers.js";

ensureTestEnv();

const service = await import("../src/gateway/egress/service.js");
const grants = await import("../src/gateway/egress/grants.js");
const liveness = await import("../src/gateway/egress/liveness.js");
const { createCaCertificate, issueLeafCertificate } = await import("../src/gateway/egress/x509.js");
const { upsertChannelEntry, patchChannelMeta, defaultChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { patchChannelEnv } = await import("../src/config/channel-env.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { containerBackend } = await import("../src/runtimes/container/index.js");
const { getDb } = await import("../src/db/index.js");

const SETTINGS = { cli: "auto", image: "channelgate/runtime:latest", idleMinutes: 10, maxRunning: 8, pidsLimit: 1024, memory: "", cpus: "", hasClaudeOauthToken: true, egressMode: "proxy", egressSecretsStrict: false };
const CHANNEL = "C_EGSVC";
const OTHER = "C_EGSVC_OTHER";
const LOOPBACK_NAMES = ["upstream.test", "api.anthropic.com", "mcp.example.test"];

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const pki = createCaCertificate({ commonName: "fake public root", days: 30 });
const leaf = issueLeafCertificate({ caCertPem: pki.certPem, caKeyPem: pki.keyPem, hostname: "upstream.test" });
const seen = [];
const upstream = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
const upstreamPort = await listen(upstream);

// A stand-in for the host's /etc/ssl/certs/ca-certificates.crt: two real (unrelated) roots.
const systemRootA = createCaCertificate({ commonName: "system root A", days: 30 }).certPem;
const systemRootB = createCaCertificate({ commonName: "system root B", days: 30 }).certPem;
const systemBundle = path.join(tempDir("cg-egsys-"), "ca-certificates.crt");
writeFileSync(systemBundle, systemRootA);
const socketRoot = trackTempDir(mkdtempSync("/tmp/cgeg-"));
const bundlePath = path.join(tempDir("cg-egrun-"), "egress-ca.pem");
const bootOptions = {
  log: { log() {}, warn() {} },
  caDir: path.join(tempDir("cg-egca-"), "egress-ca"),
  socketRoot,
  bundlePath,
  mountpoint: path.join(tempDir("cg-egmp-"), "egress"),
  systemBundle,
  lookup: async (hostname) => {
    if (LOOPBACK_NAMES.includes(hostname)) return [{ address: "127.0.0.1", family: 4 }];
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  },
  upstreamCa: [pki.certPem],
  allowLoopbackHosts: LOOPBACK_NAMES,
};

async function registerChannel(channelId, { allowNetwork = true, env = {} } = {}) {
  const entry = await upsertChannelEntry(channelId, { name: channelId, type: "channel", isDM: false, platform: "slack" });
  await patchChannelMeta(entry.slug, (existing) => {
    let next = existing?.env || {};
    for (const [name, spec] of Object.entries(env)) next = patchChannelEnv(next, { set: { name, ...spec } });
    return { ...(existing || defaultChannelMeta({ channelId, name: channelId, type: "channel", isDM: false })), allowNetwork, env: next };
  });
  return entry;
}

const status = await service.startEgressService(bootOptions);
const entry = await registerChannel(CHANNEL, { env: { MY_API_KEY: { value: "real-api-key-value-0001", hosts: ["upstream.test"] } } });
const targetFor = async (channelId, slug) => resolveRuntime(slug, { platform: "slack", channelId, allowNetwork: true }, { settings: SETTINGS });
const target = await targetFor(CHANNEL, entry.slug);
const bound = await service.ensureChannelEgress(target);
const runEnv = await grants.resolveEgressRunEnv({ meta: await getChannelMeta(entry.slug), channelId: CHANNEL, target });
const PLACEHOLDER = runEnv.env.MY_API_KEY;

function egressEvents() {
  return getDb().prepare("SELECT * FROM events WHERE event = 'egress' ORDER BY id").all().map((row) => ({ ...row, data: JSON.parse(row.data || "{}") }));
}

// CONNECT through the channel's socket, then one HTTPS request trusting the written bundle.
async function request({ socketPath = bound.socketPath, host = "upstream.test", port = upstreamPort, headers = {} } = {}) {
  const socket = net.connect(socketPath);
  const head = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf.toString("latin1"))?.[1]), rest: buf.subarray(end + 4) });
    };
    socket.on("data", onData);
  });
  if (head.status !== 200) {
    let body = head.rest.toString();
    await new Promise((resolve) => { socket.on("data", (c) => { body += c; }); socket.on("close", resolve); });
    return { connect: head.status, body };
  }
  const secure = tls.connect({ socket, servername: host, ca: readFileSync(bundlePath, "utf8"), ALPNProtocols: ["http/1.1"] });
  await new Promise((resolve, reject) => { secure.once("secureConnect", resolve); secure.once("error", reject); });
  return new Promise((resolve, reject) => {
    const req = http.request({ createConnection: () => secure, host, port, path: "/v1/thing", headers }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => { secure.destroy(); resolve({ connect: 200, status: res.statusCode, body }); });
    });
    req.on("error", reject);
    req.end();
  });
}

test("boot: the CA, a trust bundle of system roots + our CA (0644), and an active plan for container targets", () => {
  assert.equal(status.running, true, status.error);
  const bundle = readFileSync(bundlePath, "utf8");
  assert.ok(bundle.startsWith(systemRootA.trim()), "the system roots come first");
  assert.ok(bundle.includes(readFileSync(status.caPath, "utf8").trim()));
  assert.equal(statSync(bundlePath).mode & 0o777, 0o644);
  assert.equal(target.container.egress.active, true);
  assert.equal(target.container.egress.caBundle, bundlePath);
  const der = new crypto.X509Certificate(readFileSync(status.caPath, "utf8")).publicKey.export({ type: "spki", format: "der" });
  assert.equal(target.container.egress.caSpki, crypto.createHash("sha256").update(der).digest("base64"));
});

test("the trust bundle is rewritten IN PLACE (same inode) so a running container's file mount stays current", async () => {
  const before = statSync(bundlePath).ino;
  writeFileSync(systemBundle, systemRootB);
  await service.stopEgressService();
  service.__resetEgressService();
  await service.startEgressService(bootOptions);
  assert.ok(readFileSync(bundlePath, "utf8").includes(systemRootB.trim()));
  assert.equal(statSync(bundlePath).ino, before);
  await service.ensureChannelEgress(target);
});

test("one listener per channel under a short 0700/0600 path, idempotent", async () => {
  const again = await service.ensureChannelEgress(target);
  assert.equal(again.socketPath, bound.socketPath);
  assert.ok(Buffer.byteLength(bound.socketPath) <= service.MAX_SOCKET_PATH_BYTES);
  assert.equal(path.dirname(bound.socketPath), path.join(socketRoot, service.channelEgressHash({ slug: entry.slug, platform: "slack" })));
  assert.match(path.basename(path.dirname(bound.socketPath)), /^[0-9a-f]{12}$/);
  assert.equal(statSync(path.dirname(bound.socketPath)).mode & 0o777, 0o700);
  assert.equal(statSync(bound.socketPath).mode & 0o777, 0o600);
  assert.equal(target.container.egress.socketDir, path.dirname(bound.socketPath), "the plan names the directory the listener lives in");
  const listed = service.egressStatus().channels.filter((c) => c.slug === entry.slug);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].channelId, CHANNEL, "the accepted socket's ctx is that channel");
});

test("no live work: the channel's placeholder is refused (403 naming the secret), and the refusal is audited", async () => {
  const before = egressEvents().length;
  const res = await request({ headers: { authorization: `Bearer ${PLACEHOLDER}` } });
  assert.equal(res.status, 403);
  assert.match(res.body, /MY_API_KEY/);
  assert.match(res.body, /channel-idle/);
  const events = egressEvents().slice(before);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data.refused, [{ secretName: "MY_API_KEY", reason: "channel-idle" }]);
  assert.ok(!JSON.stringify(events[0]).includes("real-api-key-value-0001"));
  assert.ok(!JSON.stringify(events[0]).includes(PLACEHOLDER), "no placeholder in the audit either");
});

test("a live turn: the upstream sees the real value; a request with no placeholder writes no audit row", async () => {
  const release = liveness.markLive({ channelId: CHANNEL, ownerId: "U1", kind: "turn", id: "t1" });
  try {
    const before = egressEvents().length;
    const res = await request({ headers: { authorization: `Bearer ${PLACEHOLDER}` } });
    assert.equal(res.status, 200);
    assert.equal(seen.at(-1).headers.authorization, "Bearer real-api-key-value-0001");
    const swapped = egressEvents().slice(before);
    assert.equal(swapped.length, 1);
    assert.deepEqual(swapped[0].data.swapped, [{ secretName: "MY_API_KEY", scope: "channel" }]);

    const quiet = egressEvents().length;
    const plain = await request({ headers: { accept: "application/json" } });
    assert.equal(plain.status, 200);
    assert.equal(egressEvents().length, quiet, "an ordinary request is counted, not logged");
    const counters = service.egressStatus().channels.find((c) => c.slug === entry.slug).counters;
    assert.ok(counters.requests >= 3);
    assert.ok(counters.swapped >= 1);
  } finally {
    release();
  }
});

test("the placeholder only works from its own channel's socket", async () => {
  const other = await registerChannel(OTHER, {});
  const otherTarget = await targetFor(OTHER, other.slug);
  const otherBound = await service.ensureChannelEgress(otherTarget);
  const release = liveness.markLive({ channelId: OTHER, kind: "turn", id: "t2" });
  try {
    const res = await request({ socketPath: otherBound.socketPath, headers: { authorization: `Bearer ${PLACEHOLDER}` } });
    assert.equal(res.status, 403);
    assert.match(res.body, /not valid from this channel/);
    assert.doesNotMatch(res.body, /MY_API_KEY/, "another channel's secret is never named");
  } finally {
    release();
  }
});

test("policyFor reads the channel's CURRENT meta: off blocks non-engine hosts on the next request, on admits them", async () => {
  await registerChannel(CHANNEL, { allowNetwork: false });
  const before = egressEvents().length;
  const off = await request({ headers: {} });
  assert.equal(off.connect, 403);
  assert.match(off.body, /network-off/);
  const blocked = egressEvents().slice(before);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].data.blocked, "network-off");

  const policy = await service.egressPolicyFor({ slug: entry.slug, platform: "slack", channelId: CHANNEL });
  assert.equal(policy.mode, "off");
  for (const host of ["api.anthropic.com", "claude.ai", "api.openai.com", "chatgpt.com"]) assert.ok(policy.engineHosts.includes(host), host);
  assert.deepEqual(policy.rawPassthrough, [{ host: "github.com", port: 22 }]);

  // A remote MCP a run of this channel was handed stays reachable with the switch off.
  service.noteChannelMcpHosts(target, service.mcpConfigUrls(JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://mcp.example.test/mcp" }, gateway: { command: "node" } } })));
  assert.ok((await service.egressPolicyFor({ slug: entry.slug, platform: "slack", channelId: CHANNEL })).engineHosts.includes("mcp.example.test"));

  await registerChannel(CHANNEL, { allowNetwork: true });
  const on = await request({ headers: {} });
  assert.equal(on.status, 200, "flipped on: the very next request goes through");
});

test("raw passthrough: github.com:22 always, plus each declared raw host on 22/5432/6543", () => {
  assert.deepEqual(service.rawPassthroughFor({ egressRawHosts: ["db.example.com", "not a host"] }), [
    { host: "github.com", port: 22 },
    { host: "db.example.com", port: 22 }, { host: "db.example.com", port: 5432 }, { host: "db.example.com", port: 6543 },
  ]);
});

test("canUse: channel/org need live work in the channel; personal needs its owner live and no other person's SSH session", () => {
  const ctx = { channelId: "C_LIVE", slug: "c-live", platform: "slack" };
  const channelGrant = { scope: "channel", channelId: "C_LIVE" };
  const orgGrant = { scope: "organization", channelId: "" };
  const personal = { scope: "personal", channelId: "C_LIVE", owner: "U_OWNER" };
  assert.deepEqual(service.canUseGrant(channelGrant, ctx), { ok: false, reason: "channel-idle" });
  assert.deepEqual(service.canUseGrant(orgGrant, ctx), { ok: false, reason: "channel-idle" });
  assert.deepEqual(service.canUseGrant(personal, ctx), { ok: false, reason: "owner-not-live" });
  assert.deepEqual(service.canUseGrant(channelGrant, { ...ctx, channelId: "" }), { ok: false, reason: "unbound-channel" });

  const job = liveness.markLive({ channelId: "C_LIVE", ownerId: "U_OTHER", kind: "job", id: "j1" });
  assert.deepEqual(service.canUseGrant(channelGrant, ctx), { ok: true });
  assert.deepEqual(service.canUseGrant(orgGrant, { ...ctx, channelId: "C_ANYWHERE" }), { ok: false, reason: "channel-idle" }, "the org grant still needs live work in THAT channel");
  assert.deepEqual(service.canUseGrant(personal, ctx), { ok: false, reason: "owner-not-live" }, "someone else's job does not wake a personal grant");
  const turn = liveness.markLive({ channelId: "C_LIVE", ownerId: "U_OWNER", kind: "turn", id: "t9" });
  assert.deepEqual(service.canUseGrant(personal, ctx), { ok: false, reason: "another-author-active" }, "U_OTHER's job is still running");
  job();
  assert.deepEqual(service.canUseGrant(personal, ctx), { ok: true });
  assert.deepEqual(service.canUseGrant(personal, { ...ctx, channelId: "C_ELSEWHERE" }), { ok: false, reason: "other-channel" });

  liveness.__setSshSessionSource(() => [{ channelId: "C_LIVE", userId: "U_DEV", slug: "c-live" }]);
  try {
    assert.deepEqual(service.canUseGrant(personal, ctx), { ok: false, reason: "another-person-ssh-session" });
    liveness.__setSshSessionSource(() => [{ channelId: "C_LIVE", userId: "U_OWNER", slug: "c-live" }]);
    assert.deepEqual(service.canUseGrant(personal, ctx), { ok: true }, "the owner's own session is fine");
    turn();
    assert.deepEqual(service.canUseGrant(channelGrant, ctx), { ok: true }, "an SSH session is live work too");
    assert.equal(liveness.isOwnerLive("C_LIVE", "U_OWNER"), true);
  } finally {
    liveness.__setSshSessionSource(null);
  }
  assert.equal(liveness.isChannelLive("C_LIVE"), false);
});

// Container-secrets P3: an operator's `npm run vscode` window (its own process, so no liveness mark
// here) holds a signed editor lease; the relay placeholder in its Claude login file must work while
// it is open. It wakes channel/org/relay grants, never a personal one, and ends with the lease.
test("canUse: an operator's editor lease on the channel's container is live work for non-personal grants", async () => {
  const { createEditorLease } = await import("../src/runtimes/container/editor-lease.js");
  const { containerName } = await import("../src/runtimes/container/names.js");
  const ctx = { channelId: "C_EDITOR", slug: "c-editor", platform: "slack" };
  const relayGrant = { scope: "relay", channelId: "C_EDITOR" };
  const personal = { scope: "personal", channelId: "C_EDITOR", owner: "U_OWNER" };
  assert.deepEqual(service.canUseGrant(relayGrant, ctx), { ok: false, reason: "channel-idle" });
  const lease = createEditorLease({ slug: ctx.slug, container: { name: containerName(ctx) } });
  try {
    assert.deepEqual(service.canUseGrant(relayGrant, ctx), { ok: true });
    assert.deepEqual(service.canUseGrant({ scope: "channel", channelId: "C_EDITOR" }, ctx), { ok: true });
    assert.deepEqual(service.canUseGrant(personal, ctx), { ok: false, reason: "owner-not-live" }, "an editor window has no owner");
    assert.deepEqual(service.canUseGrant(relayGrant, { ...ctx, slug: "c-other", channelId: "C_EDITOR" }), { ok: false, reason: "channel-idle" }, "only THAT container's lease");
  } finally {
    lease.release();
  }
  assert.deepEqual(service.canUseGrant(relayGrant, ctx), { ok: false, reason: "channel-idle" }, "and it ends with the lease");
});

// Container-secrets P3, end to end: developer A is attached over SSH (the broker's live-session
// view, which liveness.js reads); developer B's turn in the same channel is live and holds B's
// personal placeholder — the proxy refuses to swap it ("another-person-ssh-session"), the turn's
// credential note says personal secrets are paused, and the moment A leaves the same request passes.
test("another developer attached over SSH: the author's personal placeholder is refused, the preamble says paused, and it swaps again once they leave", async () => {
  const { setUser } = await import("../src/config/store.js");
  const { patchUserEnv } = await import("../src/config/scoped-env.js");
  const { channelCredentialsPreamble } = await import("../src/gateway/channel-credentials.js");
  const DEV_A = "U_EGSVC_DEV_A";
  const AUTHOR_B = "U_EGSVC_AUTHOR_B";
  await setUser(AUTHOR_B, { name: "B", approved: true });
  await patchUserEnv(AUTHOR_B, { set: { name: "B_PERSONAL_KEY", value: "b-personal-real-value-0001", hosts: ["upstream.test"] } });
  const meta = await getChannelMeta(entry.slug);
  liveness.__setSshSessionSource(() => [{ channelId: CHANNEL, userId: DEV_A, slug: entry.slug }]);
  const release = liveness.markLive({ channelId: CHANNEL, ownerId: AUTHOR_B, kind: "turn", id: "b-turn" });
  try {
    const turn = await grants.resolveEgressRunEnv({ meta, channelId: CHANNEL, authorId: AUTHOR_B, target });
    const placeholder = turn.env.B_PERSONAL_KEY;
    assert.match(placeholder, /^cgph_p[a-z2-7]{32}$/, "B's turn still gets the personal placeholder");
    assert.equal(turn.personalPaused, true);
    const preamble = channelCredentialsPreamble(turn.env, { scopes: turn.scopes, placeholders: turn.placeholders, hosts: turn.hosts, personalPaused: turn.personalPaused });
    assert.match(preamble, /Personal secrets are PAUSED right now[^\n]*\["B_PERSONAL_KEY"\]/);

    const before = seen.length;
    const refused = await request({ headers: { authorization: `Bearer ${placeholder}` } });
    assert.equal(refused.status, 403);
    assert.equal(JSON.parse(refused.body).error, "secret-refused");
    assert.match(refused.body, /B_PERSONAL_KEY[^"]*another-person-ssh-session/);
    assert.equal(seen.length, before, "the upstream never saw the request");
    const audited = egressEvents().at(-1);
    assert.deepEqual(audited.data.refused, [{ secretName: "B_PERSONAL_KEY", reason: "another-person-ssh-session" }]);
    // The channel's own placeholder is NOT paused: it is not personal.
    assert.equal((await request({ headers: { authorization: `Bearer ${PLACEHOLDER}` } })).status, 200);

    // A leaves: the same placeholder swaps on the very next request, and the next resolve is unpaused.
    liveness.__setSshSessionSource(() => []);
    const ok = await request({ headers: { authorization: `Bearer ${placeholder}` } });
    assert.equal(ok.status, 200);
    assert.equal(seen.at(-1).headers.authorization, "Bearer b-personal-real-value-0001");
    assert.equal((await grants.resolveEgressRunEnv({ meta, channelId: CHANNEL, authorId: AUTHOR_B, target })).personalPaused, false);
  } finally {
    release();
    liveness.__setSshSessionSource(null);
  }
});

test("a personal grant pauses while ANOTHER author has a turn or job in the channel; ownerless work does not pause it", () => {
  const ctx = { channelId: "C_AUTHORS", slug: "c-authors", platform: "slack" };
  const personal = { scope: "personal", channelId: "C_AUTHORS", owner: "U_OWNER" };
  const mine = liveness.markLive({ channelId: "C_AUTHORS", ownerId: "U_OWNER", kind: "turn", id: "mine" });
  try {
    assert.deepEqual(service.canUseGrant(personal, ctx), { ok: true });
    const review = liveness.markLive({ channelId: "C_AUTHORS", ownerId: "", kind: "review", id: "r" });
    assert.deepEqual(service.canUseGrant(personal, ctx), { ok: true }, "a memory review carries no personal env and pauses nothing");
    review();
    const theirs = liveness.markLive({ channelId: "C_AUTHORS", ownerId: "U_OTHER", kind: "turn", id: "theirs" });
    assert.deepEqual(service.canUseGrant(personal, ctx), { ok: false, reason: "another-author-active" });
    theirs();
    const job = liveness.markLive({ channelId: "C_AUTHORS", ownerId: "U_OTHER", kind: "job", id: "j" });
    assert.deepEqual(service.canUseGrant(personal, ctx), { ok: false, reason: "another-author-active" });
    job();
    assert.deepEqual(service.canUseGrant(personal, ctx), { ok: true }, "resumes when the other author's work ends");
    const elsewhere = liveness.markLive({ channelId: "C_ELSEWHERE", ownerId: "U_OTHER", kind: "turn", id: "e" });
    assert.deepEqual(service.canUseGrant(personal, ctx), { ok: true }, "another channel's work is irrelevant");
    elsewhere();
    // Channel grants are shared by design: another author's work does not pause them.
    const other = liveness.markLive({ channelId: "C_AUTHORS", ownerId: "U_OTHER", kind: "turn", id: "o" });
    assert.deepEqual(service.canUseGrant({ scope: "channel", channelId: "C_AUTHORS" }, ctx), { ok: true });
    other();
  } finally {
    mine();
  }
});

test("listeners: a connection ceiling per channel, a rebind when the channel id changes, a close that waits for a bind", async () => {
  assert.equal(service.egressStatus().channels.find((c) => c.slug === entry.slug).maxConnections, service.MAX_CONNECTIONS_PER_CHANNEL);
  assert.equal(service.MAX_CONNECTIONS_PER_CHANNEL, 256);

  const moved = await registerChannel("C_EGSVC_MOVED", {});
  const movedTarget = await targetFor("C_EGSVC_MOVED", moved.slug);
  await service.ensureChannelEgress(movedTarget);
  const relabelled = { ...movedTarget, meta: { ...movedTarget.meta, channelId: "C_EGSVC_REUSED" } };
  await service.ensureChannelEgress(relabelled);
  assert.equal(service.egressStatus().channels.find((c) => c.slug === moved.slug).channelId, "C_EGSVC_REUSED", "rebound with the new identity");

  // A close racing a bind: the close waits, then removes what the bind created.
  await service.closeChannelEgress(movedTarget);
  const binding = service.ensureChannelEgress(movedTarget);
  const closing = service.closeChannelEgress(movedTarget);
  const { socketPath } = await binding;
  await closing;
  assert.equal(service.egressStatus().channels.some((c) => c.slug === moved.slug), false);
  assert.throws(() => statSync(socketPath), /ENOENT/);
});

test("boot: every RUNNING proxy-mode container gets its listener back before its next turn", async () => {
  const recovered = await registerChannel("C_EGSVC_BOOT", {});
  const recoveredTarget = await targetFor("C_EGSVC_BOOT", recovered.slug);
  await service.closeChannelEgress(recoveredTarget);
  assert.equal(service.egressStatus().channels.some((c) => c.slug === recovered.slug), false);
  const out = await service.bindRunningChannelEgress({
    listContainers: async () => [
      { slug: recovered.slug, platform: "slack", state: "running" },
      { slug: "stopped-one", platform: "slack", state: "exited" },
    ],
    resolveTarget: async (slug, meta) => resolveRuntime(slug, meta, { settings: SETTINGS }),
    log: { log() {}, warn() {} },
  });
  assert.deepEqual(out, { bound: 1, failed: 0 });
  const restored = service.egressStatus().channels.find((c) => c.slug === recovered.slug);
  assert.equal(restored.listening, true);
  assert.equal(restored.channelId, "C_EGSVC_BOOT");
  // Legacy bridge mode: nothing to bind.
  const legacy = await service.bindRunningChannelEgress({
    listContainers: async () => [{ slug: recovered.slug, platform: "slack", state: "running" }],
    resolveTarget: async (slug, meta) => resolveRuntime(slug, meta, { settings: { ...SETTINGS, egressMode: "bridge" } }),
    log: { log() {}, warn() {} },
  });
  assert.deepEqual(legacy, { bound: 0, failed: 0 });
});

test("a removed secret's placeholder is revoked by the config-change listener", async () => {
  const release = liveness.markLive({ channelId: CHANNEL, kind: "turn", id: "t3" });
  try {
    await registerChannel(CHANNEL, { env: { TEMP_KEY: { value: "temp-key-value-00001", hosts: ["upstream.test"] } } });
    const meta = await getChannelMeta(entry.slug);
    const out = await grants.resolveEgressRunEnv({ meta, channelId: CHANNEL, target });
    const ph = out.env.TEMP_KEY;
    assert.ok(grants.lookupGrant(ph));
    await patchChannelMeta(entry.slug, (existing) => ({ env: patchChannelEnv(existing?.env, { remove: "TEMP_KEY" }) }));
    const deadline = Date.now() + 2000;
    while (grants.lookupGrant(ph) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(grants.lookupGrant(ph), null);
  } finally {
    release();
  }
});

test("service down: egressError names the remedy and the container backend's credential gate fails closed", async () => {
  assert.equal(service.egressError(target), null);
  assert.equal(containerBackend.credentialError(target, "claude"), null);
  await service.stopEgressService();
  assert.match(service.egressError(target), /^egress proxy unavailable: .*Container runtime → Egress/);
  const blocked = containerBackend.credentialError(target, "claude");
  assert.match(String(blocked?.message || ""), /egress proxy unavailable/);
  await assert.rejects(service.ensureChannelEgress(target), /egress proxy unavailable/);
  // The legacy bridge mode never asks for the proxy.
  assert.equal(service.egressError({ ...target, settings: { ...SETTINGS, egressMode: "bridge" } }), null);
  // A fresh prepareTarget while down: inactive plan, and still no network of its own.
  const down = await targetFor(CHANNEL, entry.slug);
  assert.equal(down.container.egress.active, false);
  assert.equal(down.container.network, "none");
});

test("a boot that cannot load the CA logs one line and leaves the service down, never throwing", async () => {
  service.__resetEgressService();
  const brokenDir = tempDir("cg-egbroken-");
  writeFileSync(path.join(brokenDir, "ca.key"), "not a key");
  writeFileSync(path.join(brokenDir, "ca.pem"), "not a cert");
  const warnings = [];
  const out = await service.startEgressService({ ...bootOptions, caDir: brokenDir, log: { log() {}, warn: (m) => warnings.push(m) } });
  assert.equal(out.running, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[egress\] proxy unavailable/);
  assert.match(service.egressError(target), /egress proxy unavailable/);
});

test.after(async () => {
  await service.stopEgressService();
  service.__resetEgressService();
  await new Promise((resolve) => upstream.close(() => resolve()));
});
