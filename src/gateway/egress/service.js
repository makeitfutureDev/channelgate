// The daemon's egress service: one proxy, one listener per channel, the grants and the policy.
//
// Why: a `--network none` channel container reaches the internet ONLY through this. Each channel
// gets its own unix socket (`<gatewayRoot>/eg/<12 hex>/egress.sock`, bind-mounted read-only at
// /run/channelgate/egress), and the socket PATH is the channel identity — the proxy never trusts
// anything the container says about who it is. Deliberately NOT under `<gatewayRoot>/run`: that
// directory is mounted into EVERY container (the control socket), so a per-channel socket there
// would be reachable from every other channel.
//
// Boot (server.js, right after the control socket): load or create the deployment CA under
// config/egress-ca/, write the trust bundle every container is pointed at (the host's system roots
// + our CA, 0644, rewritten IN PLACE so a running container's bind mount keeps seeing the current
// bytes), create the proxy, register the container backend's hook. A failure logs ONE line and
// leaves the service down: proxy-mode container runs then fail closed with the remedy
// (egressError), and the boot itself continues.
//
// Audit: the proxy reports every request; only swaps of a channel/org/personal secret, refusals,
// blocked destinations and raw tunnels become `egress` events (the relay's own swap on every
// Claude API call would be hundreds of rows a turn). Everything is counted per channel in memory
// for egressStatus().
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { configDir, gatewayRoot, runtimeSocketDir } from "../../config/paths.js";
import { getContainerRuntime, getQwenConfig } from "../../config/settings.js";
import { getChannelMeta, getChannelsIndex } from "../../config/store.js";
import { normalizeChannelEnv } from "../../config/channel-env.js";
import { getOrgEnv, getUserEnv } from "../../config/scoped-env.js";
import { onConfigChange } from "../../config/change-events.js";
import { QWEN_PROVIDERS } from "../../engines/qwen.js";
import { logEvent } from "../../util/logger.js";
import { platformOr } from "../../platforms/registry.js";
import { egressActive as hookEgressActive, egressModeOf, setEgressProvider } from "../../runtimes/container/egress-hook.js";
import { loadOrCreateEgressCa } from "./ca.js";
import { createEgressProxy } from "./proxy.js";
import { normalizeHost } from "./rules.js";
import { resolveEgressGrant, revokeMissing } from "./grants.js";
import { isChannelLive, isOwnerLive, otherOwnerActive, otherSshOpen } from "./liveness.js";
import { activeEditorLeases } from "../../runtimes/container/editor-lease.js";
import { containerName } from "../../runtimes/container/names.js";
import { engineHostsFor, hostOfUrl } from "./engine-hosts.js";
import { isValidRuleHost } from "./catalog-rules.js";

// sockaddr_un.sun_path is 108 bytes including the terminating NUL.
export const MAX_SOCKET_PATH_BYTES = 107;
export const RAW_PASSTHROUGH_PORTS = Object.freeze([22, 5432, 6543]);
export const MAX_CONNECTIONS_PER_CHANNEL = 256;
export const ALWAYS_RAW = Object.freeze([{ host: "github.com", port: 22 }]);
export const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const RUN_HOSTS_TTL_MS = 24 * 60 * 60 * 1000;
const EGRESS_REMEDY = "Restart the gateway to retry, or — only if this host cannot run the proxy — set Settings → Container runtime → Egress to \"bridge\" (the legacy open network, with raw secrets in containers).";

export function egressCaDir() {
  return path.join(configDir(), "egress-ca");
}
export function egressSocketRoot() {
  return path.join(gatewayRoot(), "eg");
}
export function egressTrustBundlePath() {
  return path.join(runtimeSocketDir(), "egress-ca.pem");
}
// The empty mountpoint for the per-channel socket mount, inside the (read-only) control-socket dir.
export function egressMountpointDir() {
  return path.join(runtimeSocketDir(), "egress");
}

export function channelEgressHash({ slug, platform }) {
  return crypto.createHash("sha256").update(`${platformOr(platform).id}|${String(slug || "")}`).digest("hex").slice(0, 12);
}

// base64(sha256(SubjectPublicKeyInfo DER)) — the form Chromium's --ignore-certificate-errors-spki-list takes.
export function spkiHashOf(certPem) {
  const der = new crypto.X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("base64");
}

let state = null;

function emptyCounters() {
  return { requests: 0, swapped: 0, refused: 0, blocked: 0, tunnels: 0, bytesUp: 0, bytesDown: 0, lastAt: 0 };
}

function channelKey(ctx) {
  return `${platformOr(ctx?.platform).id}|${String(ctx?.slug || "")}`;
}

// Write the trust bundle only when its bytes change, and IN PLACE (truncate + write keeps the
// inode) — a rename would leave every running container's bind-file mount on the old inode.
function writeTrustBundle(file, caPem, systemBundle) {
  let system = "";
  try { system = readFileSync(systemBundle, "utf8"); } catch { system = ""; }
  const contents = `${system.trimEnd()}${system ? "\n" : ""}${caPem.trimEnd()}\n`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let current = null;
  try { current = readFileSync(file, "utf8"); } catch { current = null; }
  if (current !== contents) writeFileSync(file, contents, { mode: 0o644 });
  chmodSync(file, 0o644);
  return { systemRoots: Boolean(system) };
}

function qwenHosts() {
  const hosts = [];
  for (const entry of QWEN_PROVIDERS) {
    try {
      const host = hostOfUrl(getQwenConfig(entry.id).baseUrl);
      if (host) hosts.push(host);
    } catch { /* an unconfigured provider has no host */ }
  }
  return hosts;
}

export function rawPassthroughFor(meta = {}) {
  const out = [...ALWAYS_RAW.map((rule) => ({ ...rule }))];
  const declared = Array.isArray(meta?.egressRawHosts) ? meta.egressRawHosts : [];
  for (const raw of declared) {
    const host = normalizeHost(raw);
    if (!host || !isValidRuleHost(host)) continue;
    for (const port of RAW_PASSTHROUGH_PORTS) out.push({ host, port });
  }
  return out;
}

// An operator's `npm run vscode` window on this channel's container (scripts/open-vscode.mjs) is live
// work too: that launcher runs in its OWN process, so it cannot mark liveness here, but it holds a
// signed, pid-checked editor lease in daemon-owned state (editor-lease.js) — the same record the
// idle reaper honours. Since container-secrets P3 its Claude login file holds the relay
// PLACEHOLDER, which would otherwise be refused as `channel-idle`. It wakes channel, organization
// and relay grants only: an editor window has no owner, so it never wakes a personal one.
function editorAttached(ctx) {
  const slug = String(ctx?.slug || "");
  if (!slug) return false;
  try {
    return activeEditorLeases({ slug, container: { name: containerName({ slug, platform: ctx?.platform }) } }).length > 0;
  } catch {
    return false;
  }
}

// canUse: the swap-time gate. Channel binding first (a placeholder only swaps from the channel it
// was issued to; the organization's from any channel), then liveness (liveness.js).
export function canUseGrant(grant, ctx) {
  const channelId = String(ctx?.channelId || "");
  if (!channelId) return { ok: false, reason: "unbound-channel" };
  if (grant.scope !== "organization" && String(grant.channelId || "") !== channelId) return { ok: false, reason: "other-channel" };
  if (grant.scope === "personal") {
    if (!isOwnerLive(channelId, grant.owner)) return { ok: false, reason: "owner-not-live" };
    if (otherSshOpen(channelId, grant.owner)) return { ok: false, reason: "another-person-ssh-session" };
    if (otherOwnerActive(channelId, grant.owner)) return { ok: false, reason: "another-author-active" };
    return { ok: true };
  }
  if (!isChannelLive(channelId) && !editorAttached(ctx)) return { ok: false, reason: "channel-idle" };
  return { ok: true };
}

function auditWorthy(event) {
  if (event.blocked || event.tunnel) return true;
  if (Array.isArray(event.refused) && event.refused.length) return true;
  return Array.isArray(event.swapped) && event.swapped.some((s) => s.scope !== "relay");
}

function recordAudit(event) {
  const ctx = event?.ctx || {};
  const key = channelKey(ctx);
  const counters = state?.counters.get(key) || emptyCounters();
  counters.requests += 1;
  if (event.swapped?.length) counters.swapped += 1;
  if (event.refused?.length) counters.refused += 1;
  if (event.blocked) counters.blocked += 1;
  if (event.tunnel) counters.tunnels += 1;
  counters.bytesUp += Number(event.bytesUp) || 0;
  counters.bytesDown += Number(event.bytesDown) || 0;
  counters.lastAt = Date.now();
  state?.counters.set(key, counters);
  if (!auditWorthy(event)) return;
  // Names, reasons and counts only — never a header value, a body, a placeholder or a real value.
  logEvent("egress", {
    channel: ctx.channelId || "",
    slug: ctx.slug || "",
    host: event.hostname || "",
    port: event.port || 0,
    method: event.method || "",
    path: event.path || "",
    status: event.status || 0,
    swapped: (event.swapped || []).map((s) => ({ secretName: s.secretName, scope: s.scope })),
    refused: (event.refused || []).map((r) => ({ secretName: r.secretName, reason: r.reason })),
    blocked: event.blocked || null,
    tunnel: Boolean(event.tunnel),
    bytesUp: event.bytesUp || 0,
    bytesDown: event.bytesDown || 0,
    ms: event.ms || 0,
  }).catch?.(() => {});
}

export async function egressPolicyFor(ctx) {
  return policyForCtx(ctx);
}

async function policyForCtx(ctx) {
  const meta = (await getChannelMeta(ctx?.slug)) || {};
  const runHosts = [];
  const seen = state?.runHosts.get(channelKey(ctx));
  if (seen) {
    const cutoff = Date.now() - RUN_HOSTS_TTL_MS;
    for (const [host, at] of seen) if (at >= cutoff) runHosts.push(host);
  }
  return {
    mode: meta.allowNetwork === true ? "on" : "off",
    engineHosts: [...new Set([...engineHostsFor(), ...qwenHosts(), ...runHosts])],
    rawPassthrough: rawPassthroughFor(meta),
  };
}

// Register the reconcile listener: every in-process secret write revokes the placeholders of the
// names it removed.
function watchConfig(log) {
  return onConfigChange(async (change) => {
    try {
      if (change.kind === "org-env") revokeMissing({ scope: "organization", present: Object.keys(getOrgEnv()) });
      else if (change.kind === "user" && change.userId) revokeMissing({ scope: "personal", ownerId: change.userId, present: Object.keys(await getUserEnv(change.userId)) });
      else if (change.kind === "channel-meta" && change.slug) {
        const meta = await getChannelMeta(change.slug);
        if (meta?.channelId) revokeMissing({ scope: "channel", channelId: meta.channelId, present: Object.keys(normalizeChannelEnv(meta.env)) });
      }
    } catch (error) {
      log?.warn?.(`[egress] could not reconcile grants after a ${change.kind} change: ${error?.message || error}`);
    }
  });
}

function registerProvider() {
  setEgressProvider({
    running: () => Boolean(state?.running),
    socketDirFor: ({ slug, platform }) => path.join(state?.socketRoot || egressSocketRoot(), channelEgressHash({ slug, platform })),
    caBundlePath: () => state?.bundlePath || egressTrustBundlePath(),
    caSpki: () => state?.spki || "",
    ensure: (target) => ensureChannelEgress(target),
    close: (target) => closeChannelEgress(target),
    error: (target) => egressError(target),
    settings: () => getContainerRuntime(),
  });
}

export async function startEgressService({
  log = console,
  caDir = egressCaDir(),
  socketRoot = egressSocketRoot(),
  bundlePath = egressTrustBundlePath(),
  mountpoint = egressMountpointDir(),
  systemBundle = SYSTEM_CA_BUNDLE,
  lookup = undefined,
  upstreamCa = undefined,
  allowLoopbackHosts = [],
  watch = true,
} = {}) {
  if (state?.running) return egressStatus();
  state = {
    running: false, error: "", socketRoot, bundlePath, mountpoint, spki: "", ca: null, proxy: null,
    servers: new Map(), counters: new Map(), runHosts: new Map(), unsubscribe: null, log,
  };
  // Registered FIRST, even if everything below fails: a registered-but-down service is what makes
  // proxy-mode runs fail closed with the remedy instead of running on an open network.
  registerProvider();
  try {
    const ca = loadOrCreateEgressCa({ dir: caDir });
    const { systemRoots } = writeTrustBundle(bundlePath, ca.certPem, systemBundle);
    mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
    chmodSync(socketRoot, 0o700);
    mkdirSync(mountpoint, { recursive: true, mode: 0o700 });
    state.ca = ca;
    state.spki = spkiHashOf(ca.certPem);
    state.proxy = createEgressProxy({
      ca,
      policyFor: policyForCtx,
      resolveGrant: (core) => resolveEgressGrant(core),
      canUse: (grant, ctx) => canUseGrant(grant, ctx),
      audit: recordAudit,
      log,
      ...(lookup ? { lookup } : {}),
      ...(upstreamCa ? { upstreamCa } : {}),
      allowLoopbackHosts,
    });
    if (watch) state.unsubscribe = watchConfig(log);
    state.running = true;
    log?.log?.(`[egress] proxy ready — CA ${ca.certPath}, trust bundle ${bundlePath}${systemRoots ? "" : " (no system roots found: only the egress CA is trusted)"}`);
  } catch (error) {
    state.running = false;
    state.error = String(error?.message || error);
    log?.warn?.(`[egress] proxy unavailable (${state.error}) — container runs in proxy mode will fail closed until it starts.`);
  }
  return egressStatus();
}

// Bind (once) the channel's listener. Idempotent and concurrency-safe: two turns racing into one
// channel share one pending bind.
export async function ensureChannelEgress(target) {
  if (!state?.running) throw new Error(`egress proxy unavailable: ${state?.error || "the egress service is not running"}. ${EGRESS_REMEDY}`);
  const slug = String(target?.slug || "");
  if (!slug) throw new Error("egress proxy unavailable: the run has no channel");
  const platform = platformOr(target?.platform).id;
  const hash = channelEgressHash({ slug, platform });
  let existing = state.servers.get(hash);
  if (existing?.pending) {
    try { await existing.pending; } catch { /* a failed bind is retried below */ }
    existing = state.servers.get(hash);
  }
  // A listener's ctx is the channel identity the grants are checked against. A slug that now
  // belongs to a different channel id (a recreated conversation reusing the folder) gets a fresh
  // listener rather than one that would refuse — or worse, admit — the wrong channel's grants.
  const wantedId = String(target?.meta?.channelId || "");
  if (existing?.listening && wantedId && existing.ctx.channelId !== wantedId) {
    await closeChannelEgress(target);
    existing = null;
  }
  if (existing?.listening) return { socketDir: existing.dir, socketPath: existing.socketPath };
  const dir = path.join(state.socketRoot, hash);
  const socketPath = path.join(dir, "egress.sock");
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`egress proxy unavailable: the channel socket path ${socketPath} exceeds the ${MAX_SOCKET_PATH_BYTES}-byte unix socket limit (move the gateway root to a shorter path)`);
  }
  const record = { hash, dir, socketPath, ctx: Object.freeze({ channelId: "", slug, platform }), server: null, listening: false, pending: null, conns: new Set() };
  record.pending = (async () => {
    // The channel id the grants are bound to. The meta carries it; a legacy meta that does not is
    // resolved through the channels index (slug → id), never guessed.
    let channelId = String(target?.meta?.channelId || "");
    if (!channelId) {
      const index = await getChannelsIndex();
      channelId = Object.entries(index).find(([, entry]) => entry?.slug === slug && platformOr(entry?.platform).id === platform)?.[0] || "";
    }
    const ctx = Object.freeze({ channelId, slug, platform });
    record.ctx = ctx;
    mkdirSync(state.mountpoint, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    // A socket file left by a killed daemon blocks the bind; the singleton lock means no other
    // gateway owns this root.
    rmSync(socketPath, { force: true });
    const proxy = state.proxy;
    const server = net.createServer((socket) => {
      record.conns.add(socket);
      socket.once("close", () => record.conns.delete(socket));
      proxy.serveEgressConnection(socket, ctx);
    });
    // A per-channel ceiling on concurrent client connections: one runaway container cannot exhaust
    // the daemon's descriptors for every other channel.
    server.maxConnections = MAX_CONNECTIONS_PER_CHANNEL;
    server.on("error", (error) => state?.log?.warn?.(`[egress] ${slug} listener error: ${error?.message || error}`));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
    chmodSync(socketPath, 0o600);
    record.server = server;
    record.listening = true;
    return { socketDir: dir, socketPath };
  })();
  state.servers.set(hash, record);
  try {
    return await record.pending;
  } catch (error) {
    state.servers.delete(hash);
    throw new Error(`egress proxy unavailable for this channel: could not listen on ${socketPath} (${error?.message || error})`);
  } finally {
    record.pending = null;
  }
}

// Bind the listener of every proxy-mode container that is ALREADY running when the daemon starts.
// A container keeps running across a daemon restart, but its egress listener lived in the old
// daemon: without this it has no network until its channel's next turn calls ensureUp. Done here,
// for every running container, rather than in background-job recovery, because a job is not the
// only thing that outlives the daemon — a VS Code editor attach (its lease survives a restart), a
// process a developer left running from an SSH session, and a job whose recovery has not run yet
// all need the network back, and none of them passes through a turn.
// `listContainers` → [{ slug, platform, state }]; `resolveTarget(slug, meta)` → a RuntimeTarget.
export async function bindRunningChannelEgress({ listContainers = null, resolveTarget = null, log = state?.log || console } = {}) {
  if (!state?.running) return { bound: 0, failed: 0 };
  const list = listContainers || (async () => (await (await import("../../runtimes/container/index.js")).containerRuntimeStatus()).containers || []);
  const resolve = resolveTarget || (async (slug, meta) => (await import("../../runtimes/resolve.js")).resolveRuntime(slug, meta));
  let containers = [];
  try { containers = await list(); } catch (error) {
    log?.warn?.(`[egress] could not list running containers to restore their egress: ${error?.message || error}`);
    return { bound: 0, failed: 0 };
  }
  const index = await getChannelsIndex();
  let bound = 0;
  let failed = 0;
  for (const container of containers) {
    if (container?.state !== "running" || !container.slug) continue;
    const platform = platformOr(container.platform).id;
    const channelId = Object.entries(index).find(([, entry]) => entry?.slug === container.slug && platformOr(entry?.platform).id === platform)?.[0] || "";
    const meta = (await getChannelMeta(container.slug)) || {};
    try {
      const target = await resolve(container.slug, { ...meta, channelId: meta.channelId || channelId, platform });
      if (target?.container?.egress?.active !== true) continue;
      await ensureChannelEgress(target);
      bound += 1;
    } catch (error) {
      failed += 1;
      log?.warn?.(`[egress] could not restore the egress listener of ${container.slug}: ${error?.message || error}`);
    }
  }
  if (bound || failed) log?.log?.(`[egress] restored ${bound} running container listener(s)${failed ? `, ${failed} failed` : ""}`);
  return { bound, failed };
}

export async function closeChannelEgress(target) {
  if (!state) return;
  const hash = channelEgressHash({ slug: target?.slug, platform: target?.platform });
  const record = state.servers.get(hash);
  if (!record) return;
  // A bind still in flight would otherwise finish AFTER the close and leave a listener nobody tracks.
  if (record.pending) { try { await record.pending; } catch { /* nothing was bound */ } }
  if (state.servers.get(hash) !== record) return;
  state.servers.delete(hash);
  for (const socket of record.conns) socket.destroy();
  if (record.server) await new Promise((resolve) => record.server.close(() => resolve()));
  rmSync(record.socketPath, { force: true });
}

export async function stopEgressService() {
  if (!state) return;
  const current = state;
  current.running = false;
  try { current.unsubscribe?.(); } catch { /* best effort */ }
  for (const record of [...current.servers.values()]) {
    for (const socket of record.conns) socket.destroy();
    if (record.server) await new Promise((resolve) => record.server.close(() => resolve()));
    rmSync(record.socketPath, { force: true });
  }
  current.servers.clear();
  try { current.proxy?.close(); } catch { /* best effort */ }
}

// Is the proxy this target's egress? (The container backend's plan, from its hook.)
export function egressActive(target) {
  return hookEgressActive(target);
}

// The pre-spawn remedy when proxy mode cannot be honoured for this target, else null.
export function egressError(target) {
  if (egressModeOf(target?.settings || getContainerRuntime()) !== "proxy") return null;
  if (!state?.running) return `egress proxy unavailable: ${state?.error || "the egress service is not running"}. ${EGRESS_REMEDY}`;
  const slug = String(target?.slug || "");
  if (!slug) return null;
  const socketPath = path.join(state.socketRoot, channelEgressHash({ slug, platform: target?.platform }), "egress.sock");
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    return `egress proxy unavailable: the channel socket path exceeds the ${MAX_SOCKET_PATH_BYTES}-byte unix socket limit (move the gateway root to a shorter path)`;
  }
  return null;
}

// The hosts of the remote MCP URLs a run of this channel was actually handed (Claude's MCP config,
// Codex's catalog definitions). They stay reachable through the proxy with the network switch off
// — a connector the channel selected is not "the internet" — for a day after the last run named
// them.
export function noteChannelMcpHosts(target, urls = []) {
  if (!state || !target?.slug) return;
  const key = channelKey(target);
  const seen = state.runHosts.get(key) || new Map();
  const now = Date.now();
  for (const url of urls) {
    const host = hostOfUrl(url);
    if (host) seen.set(host, now);
  }
  if (seen.size) state.runHosts.set(key, seen);
}

// Every `url` in an MCP config JSON (Claude's `mcpServers`) — for noteChannelMcpHosts.
export function mcpConfigUrls(mcpConfigJson) {
  try {
    const parsed = typeof mcpConfigJson === "string" ? JSON.parse(mcpConfigJson) : mcpConfigJson;
    return Object.values(parsed?.mcpServers || {}).map((server) => server?.url).filter((url) => typeof url === "string" && url);
  } catch {
    return [];
  }
}

export function egressStatus() {
  if (!state) return { running: false, error: "not started", channels: [] };
  return {
    running: state.running,
    error: state.error,
    caPath: state.ca?.certPath || "",
    trustBundle: state.bundlePath,
    spki: state.spki,
    liveSockets: state.proxy?.liveSockets ?? 0,
    channels: [...state.servers.values()].map((record) => ({
      slug: record.ctx.slug,
      platform: record.ctx.platform,
      channelId: record.ctx.channelId,
      socketPath: record.socketPath,
      listening: record.listening,
      maxConnections: record.server?.maxConnections ?? null,
      counters: { ...(state.counters.get(channelKey(record.ctx)) || emptyCounters()) },
    })),
  };
}

// Test seam: forget everything (after stopEgressService) and unregister the backend hook.
export function __resetEgressService() {
  state = null;
  setEgressProvider(null);
}
