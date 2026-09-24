// SSH access to channel containers — the key registry, the per-channel grant list, the host-side
// authorized_keys export and the in-container sshd files (docs/SSH-ACCESS.md). The BROKER that
// accepts a connection is ssh-broker.js; this module holds the pure and store-backed parts so the
// MCP tools can import it without dragging the runtime backend along.
//
// The shape, in one paragraph: a developer registers ONE public key once, bound to the chat
// identity that pasted it; a channel manager grants that person SSH on a channel; the developer's
// ssh client reaches the gateway host's dedicated login account, whose forced command hands the
// connection to the daemon over a unix socket; the daemon authorizes key → user → channel grant
// and runs an inetd-mode sshd INSIDE the channel container on that byte stream. No container ever
// listens on a port, every line of the host authorized_keys is `restrict,command=…` by
// construction, and a live session holds a container lease so the idle reaper never stops a box
// someone is inside.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDb } from "../db/index.js";
import { sshAccessDir } from "../config/paths.js";

// ── Public keys ───────────────────────────────────────────────────────────────────────────────
// What a developer may register. ssh-dss is refused outright (OpenSSH itself no longer accepts
// it); RSA must be at least 2048 bits, which is the key's own modulus size read off the blob, not
// a claim on the line.
export const SSH_KEY_TYPES = Object.freeze({
  "ssh-ed25519": Object.freeze({ family: "ED25519" }),
  "sk-ssh-ed25519@openssh.com": Object.freeze({ family: "ED25519-SK" }),
  "ecdsa-sha2-nistp256": Object.freeze({ family: "ECDSA" }),
  "ecdsa-sha2-nistp384": Object.freeze({ family: "ECDSA" }),
  "ecdsa-sha2-nistp521": Object.freeze({ family: "ECDSA" }),
  "sk-ecdsa-sha2-nistp256@openssh.com": Object.freeze({ family: "ECDSA-SK" }),
  "ssh-rsa": Object.freeze({ family: "RSA", minBits: 2048 }),
});
export const SSH_PUBLIC_KEY_HELP = "Paste the single line of your PUBLIC key file (`~/.ssh/id_ed25519.pub`): it starts with ssh-ed25519, ecdsa-sha2-nistp256/384/521 or ssh-rsa.";

function readString(buf, offset) {
  if (offset + 4 > buf.length) throw new Error("truncated key blob");
  const len = buf.readUInt32BE(offset);
  if (offset + 4 + len > buf.length) throw new Error("truncated key blob");
  return { value: buf.subarray(offset + 4, offset + 4 + len), next: offset + 4 + len };
}

function mpintBits(n) {
  let i = 0;
  while (i < n.length && n[i] === 0) i += 1;
  if (i >= n.length) return 0;
  let lead = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    if (n[i] & (1 << bit)) break;
    lead += 1;
  }
  return (n.length - i) * 8 - lead;
}

export function sshFingerprint(blob) {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Parse and validate ONE OpenSSH public key line. Throws a human-readable message (the MCP tool
 * shows it verbatim). Returns the canonical line pieces plus the SHA256 fingerprint that
 * `ssh-keygen -lf` prints, which is the identity every other function keys on.
 */
export function parsePublicKey(input) {
  const text = String(input || "").replace(/\r/g, "").trim();
  if (!text) throw new Error(SSH_PUBLIC_KEY_HELP);
  if (/PRIVATE KEY/i.test(text)) {
    throw new Error("That is a PRIVATE key. Paste the .pub file's single line instead — and treat the private key as compromised now that it has been pasted into a chat.");
  }
  if (text.includes("\n")) throw new Error(`Paste exactly one public key line. ${SSH_PUBLIC_KEY_HELP}`);
  const parts = text.split(/\s+/);
  const type = parts[0];
  const b64 = parts[1] || "";
  const comment = parts.slice(2).join(" ").replace(/[^\x20-\x7e]/g, "").slice(0, 120);
  if (type === "ssh-dss") throw new Error("DSA keys are not accepted (OpenSSH itself refuses them). Generate an ed25519 key: `ssh-keygen -t ed25519`.");
  const spec = SSH_KEY_TYPES[type];
  if (!spec) throw new Error(`Unsupported key type "${type.slice(0, 40)}". ${SSH_PUBLIC_KEY_HELP}`);
  if (!b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) throw new Error(`The key data after "${type}" is not valid base64. ${SSH_PUBLIC_KEY_HELP}`);
  const blob = Buffer.from(b64, "base64");
  let head;
  try {
    head = readString(blob, 0);
  } catch {
    throw new Error(`The key data is not a well-formed ${type} public key. ${SSH_PUBLIC_KEY_HELP}`);
  }
  if (head.value.toString("latin1") !== type) throw new Error(`The key data does not match its declared type "${type}". ${SSH_PUBLIC_KEY_HELP}`);
  let bits = 0;
  try {
    if (type === "ssh-rsa") {
      const e = readString(blob, head.next);
      const n = readString(blob, e.next);
      bits = mpintBits(n.value);
    } else if (spec.family === "ED25519" || spec.family === "ED25519-SK") {
      bits = 256;
    } else {
      bits = Number(type.match(/nistp(\d+)/)?.[1]) || 0;
    }
  } catch {
    throw new Error(`The key data is not a well-formed ${type} public key. ${SSH_PUBLIC_KEY_HELP}`);
  }
  if (spec.minBits && bits < spec.minBits) throw new Error(`RSA keys must be at least ${spec.minBits} bits (this one is ${bits}). Generate an ed25519 key: \`ssh-keygen -t ed25519\`.`);
  const canonical = blob.toString("base64");
  return { type, base64: canonical, comment, fingerprint: sshFingerprint(blob), bits, family: spec.family, line: `${type} ${canonical}` };
}

// ── Key registry (ssh_keys) ───────────────────────────────────────────────────────────────────
function rowToKey(row) {
  if (!row) return null;
  const [type, base64] = String(row.public_key).split(" ");
  return {
    id: row.id, userId: row.user_id, fingerprint: row.fingerprint, type: type || row.key_type, base64: base64 || "",
    label: row.label || "", createdAt: Number(row.created_ms) || 0, lastUsedAt: row.last_used_ms == null ? null : Number(row.last_used_ms),
  };
}

export const MAX_KEYS_PER_USER = 5;

/** Register a public key for a user. Idempotent for the same key; refuses a key another user owns. */
export async function addSshKey(userId, text, { label = "", now = Date.now } = {}) {
  if (!userId) throw new Error("No user identity — a key can only be registered by the person who will use it.");
  const parsed = parsePublicKey(text);
  const db = getDb();
  const existing = db.prepare("SELECT id, user_id, fingerprint, key_type, public_key, label, created_ms, last_used_ms FROM ssh_keys WHERE fingerprint = ?").get(parsed.fingerprint);
  if (existing) {
    if (existing.user_id === userId) return { key: rowToKey(existing), created: false, parsed };
    throw new Error("That key is already registered to another account. Every person registers their OWN key; keys are never shared.");
  }
  const count = db.prepare("SELECT COUNT(*) AS n FROM ssh_keys WHERE user_id = ?").get(userId)?.n || 0;
  if (count >= MAX_KEYS_PER_USER) throw new Error(`You already have ${MAX_KEYS_PER_USER} registered keys — remove one first (list_my_ssh_keys / remove_my_ssh_key).`);
  const id = randomUUID();
  const cleanLabel = String(label || parsed.comment || "").replace(/[^\x20-\x7e]/g, "").slice(0, 80);
  db.prepare("INSERT INTO ssh_keys(id, user_id, fingerprint, key_type, public_key, label, created_ms) VALUES(?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, parsed.fingerprint, parsed.type, parsed.line, cleanLabel, now());
  return { key: rowToKey(db.prepare("SELECT * FROM ssh_keys WHERE id = ?").get(id)), created: true, parsed };
}

export async function listSshKeys(userId) {
  return getDb().prepare("SELECT * FROM ssh_keys WHERE user_id = ? ORDER BY created_ms").all(userId).map(rowToKey);
}

export function listAllSshKeys() {
  return getDb().prepare("SELECT * FROM ssh_keys ORDER BY user_id, created_ms").all().map(rowToKey);
}

/** Remove one of the caller's OWN keys, addressed by id or fingerprint. Never someone else's. */
export async function removeSshKey(userId, ref) {
  const wanted = String(ref || "").trim();
  if (!userId || !wanted) return null;
  const db = getDb();
  const row = db.prepare("SELECT * FROM ssh_keys WHERE user_id = ? AND (id = ? OR fingerprint = ?)").get(userId, wanted, wanted);
  if (!row) return null;
  db.prepare("DELETE FROM ssh_keys WHERE id = ?").run(row.id);
  return rowToKey(row);
}

export async function findSshKeyByFingerprint(fingerprint) {
  return rowToKey(getDb().prepare("SELECT * FROM ssh_keys WHERE fingerprint = ?").get(String(fingerprint || "")));
}

export async function findSshKeyById(id) {
  return rowToKey(getDb().prepare("SELECT * FROM ssh_keys WHERE id = ?").get(String(id || "")));
}

export async function keysForUsers(userIds = []) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return getDb().prepare(`SELECT * FROM ssh_keys WHERE user_id IN (${placeholders}) ORDER BY user_id, created_ms`).all(...ids).map(rowToKey);
}

export function touchSshKey(id, { now = Date.now } = {}) {
  getDb().prepare("UPDATE ssh_keys SET last_used_ms = ? WHERE id = ?").run(now(), String(id || ""));
}

// ── Channel grants (channel_meta.sshUsers) ─────────────────────────────────────────────────────
// A grant is a list of user ids on the channel's meta, next to allowedUsers/managers, so it is
// audited (channel-audit.js POLICY_KEYS), survives without a migration, and reads like the other
// access lists. It is authorization on top of isAuthorized(): a grant never admits someone the
// channel's access policy would refuse.
export function sshUsersOf(meta) {
  const list = Array.isArray(meta?.sshUsers) ? meta.sshUsers : [];
  return [...new Set(list.map((id) => String(id || "").trim()).filter(Boolean))];
}

export function grantSshUser(meta, userId) {
  const id = String(userId || "").trim();
  const current = sshUsersOf(meta);
  return current.includes(id) ? { sshUsers: current, changed: false } : { sshUsers: [...current, id], changed: true };
}

export function revokeSshUser(meta, userId) {
  const id = String(userId || "").trim();
  const current = sshUsersOf(meta);
  return current.includes(id) ? { sshUsers: current.filter((u) => u !== id), changed: true } : { sshUsers: current, changed: false };
}

// Mirrors operatorHomeGranted() in src/runtimes/container/lifecycle.js (a test pins the two
// together): while a channel's container would mount the operator's whole home, no SSH session
// may enter it — that mount is meant for the admin's own chat turns, never for a developer's shell.
export function sshBlockedByHomeGrant(meta, settings) {
  return Boolean(meta?.adminMode) && settings?.fullAccessHome === true;
}

// Slack writes a mention as <@U123|name>; other surfaces hand over bare ids. Accept both.
export function parseUserRef(input) {
  const text = String(input || "").trim();
  const mention = text.match(/^<@([^|>\s]+)(?:\|[^>]*)?>$/);
  if (mention) return mention[1];
  if (/^@?[A-Za-z0-9:_.@-]+$/.test(text)) return text.replace(/^@/, "");
  return "";
}

// ── The host side: endpoint facts and the exported authorized_keys ─────────────────────────────
export const SSH_ENDPOINT_FILE = "endpoint.json";
export const SSH_AUTHORIZED_KEYS_FILE = "authorized_keys";

/** What the root installer recorded about the login account devs connect to. */
export function readSshEndpoint(dir = sshAccessDir()) {
  const file = path.join(dir, SSH_ENDPOINT_FILE);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, reason: error?.code === "ENOENT" ? `${file} is missing` : `${file} is unreadable (${error?.message || error})` };
  }
  const host = String(raw?.host || "").trim();
  const user = String(raw?.user || "").trim();
  const attachCommand = String(raw?.attachCommand || "").trim();
  const port = Number(raw?.port) || 22;
  if (!host || !user || !attachCommand) return { ok: false, reason: `${file} needs host, user and attachCommand` };
  if (/["\r\n]/.test(attachCommand)) return { ok: false, reason: `${file}: attachCommand must be one line without double quotes` };
  return { ok: true, host, user, port, attachCommand, installedAt: String(raw?.installedAt || "") };
}

/** Is the host set up for SSH access at all? (dir present + endpoint recorded) */
export function sshAccessState(dir = sshAccessDir()) {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return { configured: false, dir, endpoint: null, reason: `${dir} does not exist — run \`sudo bash scripts/install-ssh-access.sh\` on the gateway host` };
  }
  if (!st.isDirectory()) return { configured: false, dir, endpoint: null, reason: `${dir} is not a directory` };
  const endpoint = readSshEndpoint(dir);
  if (!endpoint.ok) return { configured: false, dir, endpoint: null, reason: endpoint.reason };
  return { configured: true, dir, endpoint, reason: "" };
}

/**
 * The host's authorized_keys for the dedicated login account. EVERY line is
 * `restrict,command="<attach> <keyId>"`: no pty, no forwarding, no agent, no rc file, and the only
 * thing that can run is the gateway's own attach wrapper. sshd's ForceCommand in the Match block
 * (written by the installer) enforces the same thing from the other side.
 */
export function renderHostAuthorizedKeys(keys, { attachCommand }) {
  const cmd = String(attachCommand || "").trim();
  if (!cmd || /["\r\n]/.test(cmd)) throw new Error("the attach command must be a single line without double quotes");
  const lines = [
    "# Managed by ChannelGate — regenerated from the gateway database whenever a key changes. Edits are overwritten.",
    "# Every key is restricted to the gateway's attach command; there is no shell behind this account.",
  ];
  for (const key of keys) {
    if (!/^[A-Za-z0-9+/=]+$/.test(key.base64) || !SSH_KEY_TYPES[key.type] || !/^[0-9a-f-]+$/i.test(key.id)) continue;
    lines.push(`restrict,command="${cmd} ${key.id}" ${key.type} ${key.base64} cg:${key.id}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Write the host authorized_keys (0640, atomic) when the host is set up; a no-op otherwise. */
export function exportHostAuthorizedKeys({ dir = sshAccessDir(), keys = null } = {}) {
  const state = sshAccessState(dir);
  if (!state.configured) return { written: false, path: "", count: 0, reason: state.reason };
  const rows = keys || listAllSshKeys();
  const body = renderHostAuthorizedKeys(rows, { attachCommand: state.endpoint.attachCommand });
  const file = path.join(dir, SSH_AUTHORIZED_KEYS_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, body, { mode: 0o640 });
  chmodSync(temporary, 0o640); // the daemon's umask (0077 under systemd) must not win
  renameSync(temporary, file);
  return { written: true, path: file, count: rows.length, reason: "" };
}

/** The ssh_config block a developer pastes once per channel. One key per person; the channel rides in the ProxyCommand. */
export function connectSnippet({ endpoint, channel, alias = channel }) {
  const port = Number(endpoint?.port) && Number(endpoint.port) !== 22 ? ` -p ${Number(endpoint.port)}` : "";
  return [
    `Host ${alias}`,
    `  HostName ${channel}`,
    "  User agent",
    `  ProxyCommand ssh${port} ${endpoint.user}@${endpoint.host} ${channel}`,
  ].join("\n");
}

// ── The container side: what sshd -i reads inside the box ──────────────────────────────────────
export const CONTAINER_SSH_SUBDIR = "ssh";
export const CONTAINER_SSH_USER = "agent";

export function containerSshDir(target) {
  if (!target?.artifactDir) throw new Error("this runtime target has no artifact directory — SSH attach needs the container backend");
  return path.join(target.artifactDir, CONTAINER_SSH_SUBDIR);
}

// sshd starts every session with a CLEAN environment (its compiled PATH, HOME, USER, SHELL), so
// without this an SSH shell, a remote command or VS Code's server never saw the container's own
// variables — CLAUDE_CONFIG_DIR above all, which made an interactive `claude` read ~/.claude.json and
// greet a developer with onboarding and a login screen although the relayed login worked. The
// session gets exactly what `podman exec` gets: the container's environment (the image's ENV plus
// what the gateway set at create — no secret rides either; channel secrets go per exec, to engine
// turns only), minus the names sshd itself owns per session, plus CG_WORKDIR so a login shell can
// start in the channel folder. Anything sshd_config cannot carry verbatim is dropped, not escaped.
const SESSION_ENV_SKIP = new Set(["HOME", "USER", "LOGNAME", "SHELL", "MAIL", "HOSTNAME", "TERM", "container", "SSH_AUTH_SOCK"]);
const SESSION_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SESSION_ENV_VALUE = /^[^"\\\x00-\x1f\x7f]*$/;

/** The session environment from the container's `Config.Env` (`NAME=value` strings) and the target. */
export function containerSessionEnv(containerEnv, target) {
  const env = {};
  for (const entry of Array.isArray(containerEnv) ? containerEnv : []) {
    const text = String(entry);
    const at = text.indexOf("=");
    if (at <= 0) continue;
    env[text.slice(0, at)] = text.slice(at + 1);
  }
  if (target?.workDir) env.CG_WORKDIR = String(target.workDir);
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (SESSION_ENV_SKIP.has(name) || !SESSION_ENV_NAME.test(name) || !SESSION_ENV_VALUE.test(value)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * The in-container sshd_config. Unprivileged sshd can only ever serve the account it runs as, so
 * AllowUsers is belt-and-braces. Forwarding stays ON (it lands in the container's own network
 * namespace — that is the point of running sshd inside), agent forwarding stays OFF (everyone in
 * the box is the same uid, so a forwarded agent would be usable by any other session in it).
 * ClientAlive reaps a dead TCP peer in about three minutes, so a laptop that fell off the network
 * cannot pin the container through a lease forever.
 */
export function renderContainerSshdConfig(dir, env = {}) {
  // ONE directive: sshd keeps the first SetEnv line it reads and silently ignores the rest.
  const setEnv = Object.keys(env).sort().map((name) => `"${name}=${env[name]}"`);
  return [
    "# Generated by ChannelGate for one inetd-mode sshd session inside this channel's container. Regenerated before every session.",
    `HostKey ${dir}/host_key`,
    "PidFile none",
    "UsePAM no",
    "StrictModes no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PermitEmptyPasswords no",
    "PubkeyAuthentication yes",
    `AuthorizedKeysFile ${dir}/authorized_keys`,
    `AllowUsers ${CONTAINER_SSH_USER}`,
    "PermitRootLogin no",
    "PermitTTY yes",
    "AllowTcpForwarding yes",
    "AllowStreamLocalForwarding yes",
    "GatewayPorts no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "PermitTunnel no",
    "PermitUserRC no",
    // Only this ONE name, set per key below — never ~/.ssh/environment or an arbitrary option.
    `PermitUserEnvironment ${SSH_SESSION_USER_ENV}`,
    "ClientAliveInterval 60",
    "ClientAliveCountMax 3",
    "AcceptEnv LANG LC_* COLORTERM",
    "Subsystem sftp internal-sftp",
    "PrintMotd no",
    "LogLevel INFO",
    ...(setEnv.length ? [`SetEnv ${setEnv.join(" ")}`] : []),
  ].join("\n") + "\n";
}

// The name the session learns its developer by. sshd sets it from the matched key's line, so a
// session cannot claim another developer's identity through its own environment — inside the
// container everyone is the same uid anyway, which is why the files it selects are per developer
// but never a secret from the others in the box (docs/SSH-ACCESS.md).
export const SSH_SESSION_USER_ENV = "CG_SSH_USER";
const SSH_USER_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

/** `environment="CG_SSH_USER=<id>" type base64 comment` lines — what the in-container sshd matches the second handshake against. */
export function renderContainerAuthorizedKeys(keys) {
  const lines = ["# Generated by ChannelGate — the keys of every user currently granted SSH on this channel."];
  for (const key of keys) {
    if (!/^[A-Za-z0-9+/=]+$/.test(key.base64) || !SSH_KEY_TYPES[key.type]) continue;
    const userId = String(key.userId || "");
    const options = SSH_USER_ID_RE.test(userId) ? `environment="${SSH_SESSION_USER_ENV}=${userId}" ` : "";
    lines.push(`${options}${key.type} ${key.base64} cg:${userId}`);
  }
  return `${lines.join("\n")}\n`;
}

function writePrivate(file, body) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, body, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

/** Write sshd_config + authorized_keys into `<artifactDir>/ssh` (0700/0600); the host key is the container's job. */
export function materializeContainerSshFiles(target, keys, { env = {} } = {}) {
  const dir = containerSshDir(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writePrivate(path.join(dir, "sshd_config"), renderContainerSshdConfig(dir, env));
  writePrivate(path.join(dir, "authorized_keys"), renderContainerAuthorizedKeys(keys));
  return { dir, keyCount: keys.length, hostKeyPresent: existsSync(path.join(dir, "host_key")) };
}

/** The channel's own host-key fingerprint, once a first session generated it (so a dev can verify it). */
export function containerHostKeyFingerprint(target) {
  try {
    const pub = readFileSync(path.join(containerSshDir(target), "host_key.pub"), "utf8").trim().split(/\s+/)[1];
    return pub ? sshFingerprint(Buffer.from(pub, "base64")) : "";
  } catch {
    return "";
  }
}

// ── Sessions (ssh_sessions): who is inside which box, and the record after they leave ─────────
export function openSshSession({ id = randomUUID(), userId, slug, channelId, fingerprint, client = "", container = "", now = Date.now } = {}) {
  getDb().prepare("INSERT INTO ssh_sessions(id, user_id, slug, channel_id, fingerprint, client, container, started_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, String(userId || ""), String(slug || ""), String(channelId || ""), String(fingerprint || ""), String(client || "").slice(0, 120), String(container || ""), now());
  return id;
}

export function closeSshSession(id, { reason = "", now = Date.now } = {}) {
  getDb().prepare("UPDATE ssh_sessions SET ended_ms = ?, end_reason = ? WHERE id = ? AND ended_ms IS NULL").run(now(), String(reason || "").slice(0, 200), String(id || ""));
}

/** A daemon restart drops every brokered session (the byte pipe ran through the daemon); say so in the rows. */
export function closeOrphanSshSessions(reason = "daemon restart", { now = Date.now } = {}) {
  return getDb().prepare("UPDATE ssh_sessions SET ended_ms = ?, end_reason = ? WHERE ended_ms IS NULL").run(now(), reason).changes;
}

export function listSshSessions({ slug = "", live = true, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (slug) { where.push("slug = ?"); args.push(slug); }
  if (live) where.push("ended_ms IS NULL");
  const sql = `SELECT * FROM ssh_sessions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY started_ms DESC LIMIT ?`;
  return getDb().prepare(sql).all(...args, Math.max(1, Math.min(500, Number(limit) || 50))).map((row) => ({
    id: row.id, userId: row.user_id, slug: row.slug, channelId: row.channel_id, fingerprint: row.fingerprint, client: row.client,
    container: row.container, startedAt: Number(row.started_ms), endedAt: row.ended_ms == null ? null : Number(row.ended_ms), endReason: row.end_reason || "",
  }));
}
