// The SSH attach broker (docs/SSH-ACCESS.md): a unix socket the host's dedicated SSH login
// account reaches through its forced command. Per connection the daemon authorizes the presented
// key against the registry and the channel's grant list, resolves the channel's container target,
// holds a container LEASE for the whole session (so the idle reaper and the max-running eviction
// never stop a box someone is inside), prepares the in-container sshd files, refreshes the Claude
// login relay the way the VS Code attach does, and runs `<cli> exec -i <container> cg-sshd` with
// the developer's SSH byte stream piped straight through. The developer's own ssh client then
// completes a second handshake with THAT sshd — inside the container's namespaces — so pty,
// shell, sftp and port forwards all land in the box. Nothing listens on a port anywhere.
//
// Trust: the wrapper's claims (which key, which channel) are believed because nothing but the
// forced command can run as the login account (sshd_config Match + `restrict,command=` on every
// key line); the socket is group-writable for that account only. The daemon still verifies the
// key exists, the user is approved, the channel admits them and the grant is present — so a
// forged header from that account could at most name a key it cannot use anyway.
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { sshAccessDir } from "../config/paths.js";
import { getContainerRuntime } from "../config/settings.js";
import { getChannelMeta, getUser, listChannels } from "../config/store.js";
import { isAuthorized } from "./modes.js";
import { isShuttingDown } from "./shutdown.js";
import { logEvent } from "../util/logger.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { cliEnv, defaultExec } from "../runtimes/container/cli.js";
import { containerRuntimeStatus } from "../runtimes/container/index.js";
import { prepareSshSession, releaseSshSession } from "./ssh-session.js";
import { onConfigChange } from "../config/change-events.js";
import {
  closeOrphanSshSessions, closeSshSession, containerSshDir, exportHostAuthorizedKeys, findSshKeyByFingerprint, findSshKeyById,
  containerSessionEnv, keysForUsers, materializeContainerSshFiles, openSshSession, parsePublicKey, sshAccessState, sshBlockedByHomeGrant, sshUsersOf, touchSshKey,
} from "./ssh-access.js";

export const SSH_ATTACH_SOCKET = "attach.sock";
export const HEADER_LIMIT_BYTES = 32 * 1024;
export const HEADER_TIMEOUT_MS = 10_000;
export const RELAY_REFRESH_MS = 20 * 60_000;
export const KILL_GRACE_MS = 5_000;
const MAX_SOCKET_PATH_BYTES = 100;

function refuse(error) {
  return { ok: false, error };
}

// Which channel did the developer name? Exact match on slug, conversation id or name (case
// folded), and it has to be unique — "acme" matching two channels is an error, not a guess.
export async function findSshChannel(selector) {
  const wanted = String(selector || "").trim().toLowerCase().replace(/^#/, "");
  if (!wanted) return { ok: false, error: "name the channel to attach to (its slug, as shown by “show SSH access” in Slack)" };
  const channels = await listChannels();
  const matches = channels.filter((entry) => [entry.slug, entry.channelId, entry.name].some((value) => String(value || "").toLowerCase() === wanted));
  if (matches.length === 1) return { ok: true, entry: matches[0] };
  if (matches.length > 1) return { ok: false, error: `"${selector}" matches more than one channel — use its slug` };
  return { ok: false, error: `no channel is called "${selector}"` };
}

async function defaultResolveMeta(entry) {
  // effectiveMeta overlays a DM's org template (which can carry adminMode); run.js is imported
  // lazily because it is the heaviest module in the daemon and the broker must stay importable
  // from the tool layer's tests.
  const { effectiveMeta } = await import("./run.js");
  const meta = entry.meta || (await getChannelMeta(entry.slug)) || {};
  return effectiveMeta(meta);
}

/**
 * key → user → channel → grant → not blocked. Every refusal names the remedy in words a developer
 * reads in their terminal; none of them leaks which of the earlier steps another key would pass.
 */
export async function authorizeSshAttach(header, { settings = getContainerRuntime(), resolveMeta = defaultResolveMeta, findChannel = findSshChannel } = {}) {
  if (isShuttingDown()) return refuse("the gateway is restarting — reconnect in a moment");
  const keyText = String(header?.key || "").trim();
  const keyId = String(header?.keyId || "").trim();
  let key = null;
  if (keyText) {
    let parsed;
    try {
      parsed = parsePublicKey(keyText);
    } catch {
      return refuse("the presented key is not a valid public key");
    }
    key = await findSshKeyByFingerprint(parsed.fingerprint);
  } else if (keyId) {
    key = await findSshKeyById(keyId);
  }
  if (!key) return refuse("this SSH key is not registered with the gateway — in Slack, tell the assistant “add my SSH key <paste your .pub line>”");
  const user = await getUser(key.userId);
  const admin = Boolean(user?.isAdmin);
  const approved = Boolean(user?.approved || admin);
  if (!approved) return refuse("your gateway account is not approved");
  const found = await findChannel(header?.channel);
  if (!found.ok) return refuse(found.error);
  const meta = await resolveMeta(found.entry);
  if (!isAuthorized(meta, key.userId, meta.isDM, { isAdminUser: admin, isApprovedUser: approved })) return refuse(`you are not allowed in ${found.entry.slug}`);
  if (!sshUsersOf(meta).includes(key.userId)) return refuse(`you have no SSH grant on ${found.entry.slug} — ask one of its managers to say “grant SSH access to @you” there`);
  if (sshBlockedByHomeGrant(meta, settings)) {
    return refuse(`SSH into ${found.entry.slug} is refused while the channel is in Admin mode and the gateway's containerFullAccessHome switch is on: that container would expose the operator's whole home. Turn one of them off.`);
  }
  return { ok: true, key, user: { id: key.userId, admin, approved, name: String(user?.name || "") }, entry: found.entry, meta };
}

async function defaultCliBin(target) {
  const status = await containerRuntimeStatus(target.settings);
  if (!status.cli?.ok) throw new Error(status.cli?.reason || "the container CLI is unavailable");
  return status.cli.bin;
}

// `exec -i` with stdin attached, the same uid rule as exec.js, and the ssh dir named in plain env
// (it is a path, not a secret). cg-sshd does the rest inside.
export function sshExecArgs(target) {
  const c = target.container;
  const args = ["exec", "-i"];
  if (c.uidStrategy !== "keep-id" && c.uid != null) args.push("--user", `${c.uid}:${c.gid}`);
  args.push("-e", `CG_SSH_DIR=${containerSshDir(target)}`, c.name, "cg-sshd");
  return args;
}

// The running container's environment — what `podman exec` gives a process and, through the
// in-container sshd_config, what an SSH session now gets too.
async function defaultContainerEnv(target, cliBin) {
  const result = await defaultExec([cliBin, "inspect", "--format", "{{json .Config.Env}}", target.container.name], { timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error((result.stderr || `inspect exited ${result.code}`).trim().slice(0, 200));
  return JSON.parse(result.stdout || "[]");
}

function defaultSpawnExec(target, cliBin) {
  return spawnProcess(cliBin, sshExecArgs(target), { stdio: ["pipe", "pipe", "pipe"], env: cliEnv() });
}

function writeLine(socket, payload) {
  try {
    socket.write(`${JSON.stringify(payload)}\n`);
  } catch {
    /* peer gone */
  }
}

// One brokered session, from an already-parsed header to the last byte.
async function runSession(socket, header, leftover, state) {
  const { deps, log } = state;
  const auth = await deps.authorize(header);
  const client = String(header?.client || "").slice(0, 120);
  if (!auth.ok) {
    writeLine(socket, { ok: false, error: auth.error });
    socket.end();
    void logEvent("ssh_attach_refused", { reason: auth.error, channel: String(header?.channel || "").slice(0, 80), client });
    return;
  }
  const { key, user, entry, meta } = auth;
  const id = randomUUID();
  // How many live sessions this developer, and this channel, have: the session files are per
  // developer and the login file per channel, and each goes when its last session ends.
  const userKey = `${entry.slug}\u0000${user.id}`;
  const counts = state.counts;
  let counted = false;
  const count = (delta) => {
    counts.users.set(userKey, (counts.users.get(userKey) || 0) + delta);
    counts.channels.set(entry.slug, (counts.channels.get(entry.slug) || 0) + delta);
    if ((counts.users.get(userKey) || 0) <= 0) counts.users.delete(userKey);
    if ((counts.channels.get(entry.slug) || 0) <= 0) counts.channels.delete(entry.slug);
  };
  const target = deps.resolveTarget(entry.slug, meta);
  if (!target?.container?.name) {
    writeLine(socket, { ok: false, error: "this channel does not run in a container" });
    socket.end();
    return;
  }
  // The lease comes FIRST — before ensureUp, like run.js — so the reaper cannot stop the container
  // between "it is up" and "sshd is inside".
  const lease = target.runtime.acquireLease(target, { kind: "ssh", id });
  const session = {
    id, slug: entry.slug, channelId: entry.channelId, userId: user.id, userName: user.name, fingerprint: key.fingerprint, client,
    container: target.container.name, startedAt: Date.now(), finish: null, refresh: null,
  };
  state.sessions.set(id, session);
  let child = null;
  let timer = null;
  let done = false;
  let cliBin = "";
  const stderrTail = [];
  const finish = async (reason) => {
    if (done) return;
    done = true;
    if (timer) clearInterval(timer);
    state.sessions.delete(id);
    if (counted) {
      count(-1);
      const lastForUser = !counts.users.has(userKey);
      const lastInChannel = !counts.channels.has(entry.slug);
      try { await deps.releaseSession({ target, entry, user, cliBin, lastForUser, lastInChannel, log }); }
      catch (error) { log.warn?.(`[ssh] session files for ${entry.slug}/${user.id} not released: ${error?.message || error}`); }
    }
    lease.release();
    closeSshSession(id, { reason });
    try { socket.destroy(); } catch { /* already gone */ }
    if (child && child.exitCode == null && child.signalCode == null) {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
      const hard = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, KILL_GRACE_MS);
      hard.unref?.();
    }
    const durationMs = Date.now() - session.startedAt;
    log.log?.(`[ssh] session ${id.slice(0, 8)} ended for ${user.id} on ${entry.slug} after ${Math.round(durationMs / 1000)}s (${reason})`);
    await logEvent("ssh_session_end", { slug: entry.slug, channel: entry.channelId, author: user.id, session: id, durationMs, reason, stderr: stderrTail.slice(-5).join(" | ").slice(0, 500) });
  };
  session.finish = finish;
  try {
    await target.runtime.ensureUp(target, { announce() {}, lease });
    const keys = await keysForUsers(sshUsersOf(meta));
    cliBin = await deps.cliBin(target);
    let containerEnv = [];
    try { containerEnv = await deps.containerEnv(target, cliBin); }
    catch (error) { log.warn?.(`[ssh] container environment for ${entry.slug}: ${error?.message || error} — the session starts with sshd's own`); }
    materializeContainerSshFiles(target, keys, { env: containerSessionEnv(containerEnv, target) });
    // What the session gets — prepared like a turn (ssh-session.js) and refreshed while it is open,
    // so the relayed login, the signed capability and a rotated secret stay current.
    let claude = { relayed: false, reason: "" };
    let prepared = { mcpServers: [], secrets: [], rejectedMcps: [], problems: [], toolset: "" };
    count(1);
    counted = true;
    const refresh = async () => {
      try {
        prepared = await deps.prepareSession({ target, entry, meta, user, cliBin, log });
        claude = prepared.claude || { relayed: true, source: "", reason: "" };
      } catch (error) {
        claude = { relayed: false, reason: String(error?.message || error) };
        log.warn?.(`[ssh] Claude relay for ${entry.slug}: ${claude.reason}`);
      }
    };
    await refresh();
    session.refresh = refresh;
    child = deps.spawnExec(target, cliBin);
    touchSshKey(key.id);
    openSshSession({ id, userId: user.id, slug: entry.slug, channelId: entry.channelId, fingerprint: key.fingerprint, client, container: target.container.name });
    child.stderr?.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) if (line.trim()) stderrTail.push(line.trim().slice(0, 200));
      if (stderrTail.length > 20) stderrTail.splice(0, stderrTail.length - 20);
    });
    child.once("error", (error) => { void finish(`exec failed: ${error?.message || error}`); });
    child.once("exit", (code, signal) => { void finish(`sshd exited (${signal || code})`); });
    socket.once("close", () => { void finish("client disconnected"); });
    socket.once("error", () => { void finish("client connection error"); });
    writeLine(socket, {
      ok: true, session: id, channel: entry.slug, container: target.container.name, claude,
      mcp: prepared.mcpServers || [], secrets: prepared.secrets || [], toolset: prepared.toolset || "", problems: prepared.problems || [],
    });
    if (leftover?.length) child.stdin.write(leftover);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    child.stdin.on("error", () => { /* sshd went away first; exit handles it */ });
    timer = setInterval(() => { void refresh(); }, state.relayRefreshMs);
    timer.unref?.();
    log.log?.(`[ssh] session ${id.slice(0, 8)}: ${user.id} → ${entry.slug} (${target.container.name})${client ? ` from ${client}` : ""}`);
    await logEvent("ssh_session_start", {
      slug: entry.slug, channel: entry.channelId, author: user.id, session: id, fingerprint: key.fingerprint, client,
      claudeRelayed: claude.relayed, claudeAccount: Boolean(claude.account), mcp: prepared.mcpServers || [], secrets: prepared.secrets || [], problems: prepared.problems || [],
      codexMcp: prepared.codex?.mcpServers || [], ...(prepared.codex?.reason ? { codexProblem: prepared.codex.reason } : {}),
    });
  } catch (error) {
    writeLine(socket, { ok: false, error: `could not attach: ${String(error?.message || error)}` });
    await finish(`failed: ${String(error?.message || error).slice(0, 200)}`);
  }
}

// Read one JSON header line (bounded, with a deadline), then hand the rest of the stream over.
function acceptConnection(socket, state) {
  const chunks = [];
  let size = 0;
  let settled = false;
  const deadline = setTimeout(() => {
    if (settled) return;
    settled = true;
    writeLine(socket, { ok: false, error: "attach header timed out" });
    socket.destroy();
  }, state.headerTimeoutMs);
  deadline.unref?.();
  const onData = (chunk) => {
    if (settled) return;
    size += chunk.length;
    if (size > HEADER_LIMIT_BYTES) {
      settled = true;
      clearTimeout(deadline);
      writeLine(socket, { ok: false, error: "attach header too large" });
      socket.destroy();
      return;
    }
    const nl = chunk.indexOf(0x0a);
    if (nl === -1) {
      chunks.push(chunk);
      return;
    }
    settled = true;
    clearTimeout(deadline);
    socket.removeListener("data", onData);
    chunks.push(chunk.subarray(0, nl));
    const leftover = chunk.subarray(nl + 1);
    let header;
    try {
      header = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!header || typeof header !== "object") throw new Error("not an object");
    } catch {
      writeLine(socket, { ok: false, error: "malformed attach header" });
      socket.destroy();
      return;
    }
    socket.pause();
    runSession(socket, header, leftover, state)
      .then(() => socket.resume())
      .catch((error) => {
        state.log.warn?.(`[ssh] session failed: ${error?.message || error}`);
        writeLine(socket, { ok: false, error: "internal error" });
        socket.destroy();
      });
  };
  socket.on("data", onData);
  socket.once("error", () => { clearTimeout(deadline); });
}

let active = null;

/**
 * Bind the attach socket when the host is set up (scripts/install-ssh-access.sh); otherwise say
 * so once and re-check periodically, so enabling SSH access never needs a daemon restart. Never
 * throws and never fails the boot.
 */
// Is anything LISTENING at this unix socket path right now? The attach directory is one per HOST,
// not one per runtime root: a second gateway under another CHANNELGATE_DIR (a test daemon from a
// worktree, a second install) reaches the same path. Deleting whatever sits there before binding —
// what this used to do unconditionally — silently took SSH access away from the daemon that owned
// it: its listener survived on an unlinked inode, so every developer's attach got ENOENT while
// `ss -xl` still showed it listening. So look first, and only ever remove a file nobody serves.
//   "live"    a peer accepted the connection — leave it alone
//   "stale"   the file exists but nothing listens (ECONNREFUSED: its owner died) — safe to replace
//   "absent"  there is no file (ENOENT)
//   "unknown" anything else (EACCES, a timeout) — never a licence to delete
// A probe that closes without a header costs the owner nothing: its header deadline drops it,
// with no refusal event and no log line.
export function probeUnixSocket(file, { timeoutMs = 1_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect(file);
    const done = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => done("unknown"), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => done("live"));
    socket.once("error", (error) => done(error?.code === "ECONNREFUSED" ? "stale" : error?.code === "ENOENT" ? "absent" : "unknown"));
  });
}

export async function startSshBroker({ dir = sshAccessDir(), log = console, retryMs = 60_000, relayRefreshMs = RELAY_REFRESH_MS, headerTimeoutMs = HEADER_TIMEOUT_MS, ...overrides } = {}) {
  if (active?.server) return active;
  if (!active) {
    active = {
      server: null, dir, path: path.join(dir, SSH_ATTACH_SOCKET), sessions: new Map(), log, retryTimer: null, warned: false, warnedOwner: false, conns: new Set(),
      relayRefreshMs, headerTimeoutMs,
      counts: { users: new Map(), channels: new Map() },
      unsubscribe: null,
      deps: {
        authorize: (header) => authorizeSshAttach(header, overrides.authorizeOptions || {}),
        resolveTarget: resolveRuntime,
        cliBin: defaultCliBin,
        containerEnv: defaultContainerEnv,
        prepareSession: (session) => prepareSshSession(session),
        releaseSession: (session) => releaseSshSession(session),
        spawnExec: defaultSpawnExec,
        ...(overrides.deps || {}),
      },
    };
  }
  const state = active;
  state.unsubscribe ||= subscribeConfigChanges(state);
  const scheduleRetry = () => {
    if (retryMs <= 0 || state.retryTimer) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      startSshBroker({ dir, log, retryMs, relayRefreshMs, headerTimeoutMs, ...overrides }).catch(() => {});
    }, retryMs);
    state.retryTimer.unref?.();
  };
  const setup = sshAccessState(dir);
  if (!setup.configured) {
    if (!state.warned) {
      log.log?.(`[ssh] SSH access to channel containers is not set up (${setup.reason}); enable it with \`sudo bash scripts/install-ssh-access.sh\``);
      state.warned = true;
    }
    scheduleRetry();
    return state;
  }
  try {
    if (Buffer.byteLength(state.path) > MAX_SOCKET_PATH_BYTES) throw new Error(`${state.path} exceeds the unix socket path limit`);
    const orphaned = closeOrphanSshSessions("daemon restart");
    if (orphaned) log.log?.(`[ssh] ${orphaned} session record(s) from before the restart closed`);
    // Before touching anything this daemon shares with other processes — the exported keys, the
    // socket path — make sure nobody else is already serving it (see probeUnixSocket).
    const existing = await probeUnixSocket(state.path);
    if (existing === "live" || existing === "unknown") {
      if (!state.warnedOwner) {
        log.warn?.(existing === "live"
          ? `[ssh] ${state.path} is already served by another process — a second gateway on this host, or a test daemon sharing the attach directory. Leaving it alone: SSH access stays with that process, and this daemon takes over within a minute of it going away.`
          : `[ssh] could not tell whether ${state.path} is in use — leaving it alone and retrying; SSH access stays off here until it can be checked.`);
        state.warnedOwner = true;
      }
      scheduleRetry();
      return state;
    }
    state.warnedOwner = false;
    const exported = exportHostAuthorizedKeys({ dir });
    if (existing === "stale") rmSync(state.path, { force: true });
    const server = net.createServer((socket) => {
      state.conns.add(socket);
      socket.once("close", () => state.conns.delete(socket));
      if (isShuttingDown()) {
        writeLine(socket, { ok: false, error: "the gateway is restarting — reconnect in a moment" });
        socket.destroy();
        return;
      }
      acceptConnection(socket, state);
    });
    server.on("error", (error) => log.warn?.(`[ssh] attach socket error: ${error?.message || error}`));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(state.path, resolve);
    });
    chmodSync(state.path, 0o660); // the login account is in the directory's group
    state.server = server;
    state.warned = false;
    log.log?.(`[ssh] attach socket ${state.path} — ${exported.count} key(s) exported; developers connect through ${setup.endpoint.user}@${setup.endpoint.host}${setup.endpoint.port !== 22 ? `:${setup.endpoint.port}` : ""}`);
  } catch (error) {
    if (!state.warned) {
      log.warn?.(`[ssh] attach socket unavailable (${error?.message || error}) — SSH access stays off until it can bind`);
      state.warned = true;
    }
    scheduleRetry();
  }
  return state;
}

export function sshBrokerStatus() {
  return {
    listening: Boolean(active?.server),
    path: active?.path || "",
    sessions: active ? [...active.sessions.values()].map(({ finish, ...rest }) => ({ ...rest })) : [],
  };
}

/** Which brokered sessions are inside a channel right now (daemon-local view; the DB view is listSshSessions). */
export function liveSshSessions({ slug = "" } = {}) {
  return sshBrokerStatus().sessions.filter((session) => !slug || session.slug === slug);
}

// Shutdown must not wait on a developer's open terminal: every session is ended (its container
// lease released, its row closed) and the socket is unlinked. A daemon restart is a reconnect.
export async function stopSshBroker() {
  if (!active) return;
  const state = active;
  active = null;
  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.unsubscribe?.();
  for (const session of [...state.sessions.values()]) {
    try { await session.finish?.("daemon shutdown"); } catch { /* best effort */ }
  }
  for (const socket of state.conns) socket.destroy();
  state.conns.clear();
  // Closing a listening unix server removes its own socket file. There is deliberately no
  // unlink here: a daemon that never bound the path — setup not done, or another process already
  // serving it — used to delete that process's live socket on its way out.
  if (state.server) await new Promise((resolve) => state.server.close(resolve));
}

// A configuration write that concerns a live session re-prepares it at once (secrets, MCP
// selection, mode switches; the organization's secrets; the developer's own record), coalesced
// per session so a burst of saves runs one refresh. A `claude` already running keeps the
// environment and servers it started with, like any process; the NEXT one a developer starts in
// the session gets the change — without waiting for the periodic tick.
export const CONFIG_REFRESH_DEBOUNCE_MS = 250;
function subscribeConfigChanges(state) {
  const pending = new Map();
  return onConfigChange((change) => {
    for (const session of state.sessions.values()) {
      if (!session.refresh) continue;
      const concerns = change.kind === "org-env"
        || (change.kind === "channel-meta" && change.slug === session.slug)
        || (change.kind === "user" && change.userId === session.userId);
      if (!concerns || pending.has(session.id)) continue;
      const timer = setTimeout(() => {
        pending.delete(session.id);
        if (!state.sessions.has(session.id)) return;
        void session.refresh();
      }, CONFIG_REFRESH_DEBOUNCE_MS);
      timer.unref?.();
      pending.set(session.id, timer);
    }
  });
}
