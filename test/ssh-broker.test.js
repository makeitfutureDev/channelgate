// The SSH attach broker (src/gateway/ssh-broker.js): a developer's connection arrives at the
// daemon's socket through the host wrapper, is authorized key → user → channel → grant, holds a
// container LEASE for its whole life (the idle reaper must never stop a box someone is inside),
// prepares the in-container sshd files and the Claude relay, and pipes bytes through
// `<cli> exec -i <container> cg-sshd`. Also exercises scripts/cg-ssh-attach.mjs for real.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { ensureTestEnv, trackTempDir } from "./helpers.js";

ensureTestEnv();
// Unix socket paths are short-lived and short (the 108-byte limit), so the attach dir is a
// sibling of the OS tmpdir rather than the deeper scratch root.
const SSH_DIR = mkdtempSync(path.join(os.tmpdir(), "cgssh-"));
trackTempDir(SSH_DIR);
process.env.CHANNELGATE_SSH_DIR = SSH_DIR;
const ARTIFACTS = path.join(SSH_DIR, "art");

const broker = await import("../src/gateway/ssh-broker.js");
const access = await import("../src/gateway/ssh-access.js");
const { createContainerReaper } = await import("../src/runtimes/container/reaper.js");
const { defaultChannelMeta, saveChannelMeta, upsertChannelEntry, setUser, getChannelMeta } = await import("../src/config/store.js");
const { readEvents } = await import("../src/util/logger.js");

const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJGL94yuutmsHOUH3doi4E7xZXvtMROqyt4ckprx0On+ test@example";
const ECDSA = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBB7xGqVLgj/wDYYZaRR/XjlTDkK//RHq86D7nTfr7jfTv3EWwkmYiOBTi1t7BPKtJGRr75Ua0G3CRby2IJ3oh8c= laptop";
const DEV = "U_BROKER_DEV";
const STRANGER = "U_BROKER_STRANGER";
const CHANNEL_ID = "C_BROKER";
const silent = { log() {}, warn() {} };

await setUser(DEV, { name: "Apps", approved: true });
await setUser(STRANGER, { name: "Stranger", approved: true });
await setUser("U_BROKER_UNAPPROVED", { name: "Out", approved: false });
const entry = await upsertChannelEntry(CHANNEL_ID, { name: "Broker Channel", type: "channel", isDM: false });
await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: CHANNEL_ID, name: "Broker Channel", type: "channel", isDM: false }), allowBash: true, sshUsers: [DEV] });
await access.addSshKey(DEV, ED25519);
await access.addSshKey(STRANGER, ECDSA);
writeFileSync(path.join(SSH_DIR, "endpoint.json"), JSON.stringify({ host: "gw.example.com", port: 22, user: "channelgate-ssh", attachCommand: "/usr/bin/node /usr/local/lib/channelgate/cg-ssh-attach.mjs" }));

// A container runtime made of the REAL reaper (so "not stopped while a session is open" is proved
// against the actual idle logic) and a fake ensureUp/exec.
let clock = 0;
const stopped = [];
const reaper = createContainerReaper({ now: () => clock, stopContainer: async (name) => { stopped.push(name); } });
const ensured = [];
const runtime = {
  acquireLease: (target, lease) => reaper.acquireLease(target, lease),
  async ensureUp(target, opts) {
    ensured.push({ name: target.container.name, leaseId: opts?.lease?.id || "" });
    reaper.markRunning(target.container.name, target);
    return { created: false, started: false };
  },
};
function resolveTarget(slug, meta, { uidStrategy = "keep-id" } = {}) {
  const artifactDir = path.join(ARTIFACTS, slug);
  mkdirSync(artifactDir, { recursive: true });
  return { slug, platform: "slack", meta, runtime, artifactDir, workDir: `/work/${slug}`, settings: { idleMinutes: 10 }, container: { name: `cg-${slug}`, uid: 1000, gid: 1000, uidStrategy } };
}
const children = [];
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin.pipe(child.stdout); // sshd stand-in: echo
  child.kill = (signal = "SIGTERM") => {
    if (child.exitCode != null || child.signalCode != null) return false;
    child.signalCode = signal;
    child.stdout.end();
    child.emit("exit", null, signal);
    return true;
  };
  children.push(child);
  return child;
}
const relays = [];
const deps = {
  resolveTarget,
  spawnExec: (target, cliBin) => { const child = fakeChild(); child.spawnedWith = { target, cliBin }; return child; },
  cliBin: async () => "/usr/bin/podman",
  installRelay: async (target) => { relays.push(target.slug); return { source: "operator", expiresAt: 0 }; },
};
const authorizeOptions = { settings: { fullAccessHome: false }, resolveMeta: async (e) => e.meta || (await getChannelMeta(e.slug)) };

function readLine(socket) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const onData = (chunk) => {
      const nl = chunk.indexOf(0x0a);
      if (nl === -1) { chunks.push(chunk); return; }
      socket.removeListener("data", onData);
      chunks.push(chunk.subarray(0, nl));
      resolve({ line: JSON.parse(Buffer.concat(chunks).toString("utf8")), rest: chunk.subarray(nl + 1) });
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("closed before a status line")));
  });
}
async function attach(header) {
  const socket = net.connect(path.join(SSH_DIR, broker.SSH_ATTACH_SOCKET));
  await once(socket, "connect");
  socket.write(`${JSON.stringify(header)}\n`);
  const status = await readLine(socket);
  return { socket, ...status };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test.after(async () => { await broker.stopSshBroker(); });

test("the broker does not bind before the host is set up, and never throws", async () => {
  const other = mkdtempSync(path.join(os.tmpdir(), "cgssh-off-"));
  trackTempDir(other);
  const state = await broker.startSshBroker({ dir: other, log: silent, retryMs: 0, deps, authorizeOptions });
  assert.equal(state.server, null);
  assert.equal(broker.sshBrokerStatus().listening, false);
  await broker.stopSshBroker();
});

test("a granted developer's connection is authorized, leased, prepared, relayed and piped; the lease outlives the idle window and ends with the connection", async () => {
  const state = await broker.startSshBroker({ dir: SSH_DIR, log: silent, retryMs: 0, deps, authorizeOptions });
  assert.ok(state.server, "the socket binds once endpoint.json exists");
  assert.ok(existsSync(path.join(SSH_DIR, "authorized_keys")), "keys are exported at bind time");
  const { socket, line, rest } = await attach({ v: 1, key: ED25519, channel: entry.slug, client: "203.0.113.5" });
  assert.equal(line.ok, true, JSON.stringify(line));
  assert.equal(line.channel, entry.slug);
  assert.equal(line.container, `cg-${entry.slug}`);
  assert.deepEqual(line.claude, { relayed: true, source: "operator", reason: "" });
  assert.equal(rest.length, 0, "nothing rides behind the status line before the client speaks");
  // Prepared: files for every granted key, relay installed, exec spawned with our lease excluded from "others inside".
  const sshDir = path.join(ARTIFACTS, entry.slug, "ssh");
  assert.ok(readFileSync(path.join(sshDir, "authorized_keys"), "utf8").includes(ED25519.split(" ")[1]));
  assert.ok(!readFileSync(path.join(sshDir, "authorized_keys"), "utf8").includes(ECDSA.split(" ")[1]), "an ungranted user's key is not in the box");
  assert.match(readFileSync(path.join(sshDir, "sshd_config"), "utf8"), /AllowUsers agent/);
  assert.deepEqual(relays, [entry.slug]);
  assert.equal(ensured.at(-1).name, `cg-${entry.slug}`);
  assert.match(ensured.at(-1).leaseId, /^ssh:/, "ensureUp is told about the session's own lease so a rebuild is never deferred by it");
  const child = children.at(-1);
  assert.deepEqual(child.spawnedWith.cliBin, "/usr/bin/podman");
  // Bytes flow both ways through the fake sshd.
  socket.write("ping over ssh\n");
  const [echo] = await once(socket, "data");
  assert.equal(String(echo), "ping over ssh\n");
  // THE requirement: an open SSH session keeps the container alive past the idle window.
  assert.equal(reaper.leaseCount(`cg-${entry.slug}`), 1);
  clock = 11 * 60_000;
  assert.deepEqual(await reaper.tick(), [], "a leased container is never idle-stopped");
  assert.deepEqual(stopped, []);
  const live = access.listSshSessions({ slug: entry.slug });
  assert.equal(live.length, 1);
  assert.equal(live[0].userId, DEV);
  assert.equal(live[0].client, "203.0.113.5");
  assert.equal(broker.liveSshSessions({ slug: entry.slug }).length, 1);
  assert.ok(readEvents({ limit: 20 }).some((e) => e.event === "ssh_session_start" && e.slug === entry.slug && e.author === DEV));
  assert.ok((await access.listSshKeys(DEV))[0].lastUsedAt > 0, "the key's last use is recorded");
  // Hang up: the exec is killed, the lease released, the row closed, and the reaper may now stop the box.
  socket.end();
  await settle();
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(reaper.leaseCount(`cg-${entry.slug}`), 0);
  assert.equal(access.listSshSessions({ slug: entry.slug }).length, 0);
  assert.equal(access.listSshSessions({ slug: entry.slug, live: false })[0].endReason, "client disconnected");
  assert.equal(broker.liveSshSessions().length, 0);
  clock += 11 * 60_000;
  assert.deepEqual(await reaper.tick(), [`cg-${entry.slug}`]);
  assert.ok(readEvents({ limit: 20 }).some((e) => e.event === "ssh_session_end" && e.slug === entry.slug));
});

test("refusals name the remedy and leave no lease, no session and no exec behind", async () => {
  const before = children.length;
  const cases = [
    [{ v: 1, key: "ssh-ed25519 AAAA", channel: entry.slug }, /not a valid public key/],
    [{ v: 1, key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", channel: entry.slug }, /not registered/],
    [{ v: 1, key: ECDSA, channel: entry.slug }, /no SSH grant/],
    [{ v: 1, key: ED25519, channel: "no-such-channel" }, /no channel is called/],
    [{ v: 1, key: ED25519, channel: "" }, /name the channel/],
    [{ v: 1, keyId: "00000000-0000-0000-0000-000000000000", channel: entry.slug }, /not registered/],
  ];
  for (const [header, expected] of cases) {
    const { socket, line } = await attach(header);
    assert.equal(line.ok, false, JSON.stringify(header));
    assert.match(line.error, expected, JSON.stringify(header));
    socket.destroy();
  }
  const raw = net.connect(path.join(SSH_DIR, broker.SSH_ATTACH_SOCKET));
  await once(raw, "connect");
  raw.write("this is not json\n");
  assert.match((await readLine(raw)).line.error, /malformed/);
  raw.destroy();
  await settle();
  assert.equal(children.length, before, "no exec was spawned for a refused connection");
  assert.equal(reaper.leaseCount(`cg-${entry.slug}`), 0);
  assert.equal(access.listSshSessions({}).length, 0);
  assert.ok(readEvents({ limit: 40 }).some((e) => e.event === "ssh_attach_refused"));
});

test("authorization refuses an unapproved account, a channel that does not admit the user, and the operator-home grant", async () => {
  await access.addSshKey("U_BROKER_UNAPPROVED", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  const unapproved = await broker.authorizeSshAttach({ key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", channel: entry.slug }, authorizeOptions);
  assert.match(unapproved.error, /not approved/);
  const closed = await broker.authorizeSshAttach({ key: ED25519, channel: entry.slug }, { ...authorizeOptions, resolveMeta: async (e) => ({ ...e.meta, access: "admins" }) });
  assert.match(closed.error, /not allowed in/);
  const blocked = await broker.authorizeSshAttach({ key: ED25519, channel: entry.slug }, { settings: { fullAccessHome: true }, resolveMeta: async (e) => ({ ...e.meta, adminMode: true }) });
  assert.match(blocked.error, /containerFullAccessHome/);
  const fine = await broker.authorizeSshAttach({ key: ED25519, channel: CHANNEL_ID }, { settings: { fullAccessHome: true }, resolveMeta: async (e) => ({ ...e.meta, adminMode: false }) });
  assert.equal(fine.ok, true, "the conversation id works as a selector too, and Admin off means no home mount");
  assert.equal(fine.user.id, DEV);
  const byName = await broker.authorizeSshAttach({ key: ED25519, channel: "#broker channel" }, authorizeOptions);
  assert.equal(byName.ok, true);
  await access.removeSshKey("U_BROKER_UNAPPROVED", (await access.listSshKeys("U_BROKER_UNAPPROVED"))[0].fingerprint);
});

test("exec args follow the container's uid rule and name cg-sshd with the ssh dir", () => {
  const keepId = broker.sshExecArgs(resolveTarget("x", {}));
  assert.deepEqual(keepId, ["exec", "-i", "-e", `CG_SSH_DIR=${path.join(ARTIFACTS, "x", "ssh")}`, "cg-x", "cg-sshd"]);
  const pinned = broker.sshExecArgs(resolveTarget("y", {}, { uidStrategy: "user" }));
  assert.deepEqual(pinned.slice(0, 4), ["exec", "-i", "--user", "1000:1000"]);
});

test("the host wrapper (scripts/cg-ssh-attach.mjs) speaks the protocol end to end and reports a refusal on stderr", async () => {
  const authFile = path.join(SSH_DIR, "auth-info");
  writeFileSync(authFile, `publickey ${ED25519.split(" ").slice(0, 2).join(" ")}\n`);
  const script = new URL("../scripts/cg-ssh-attach.mjs", import.meta.url).pathname;
  const env = { ...process.env, CHANNELGATE_SSH_DIR: SSH_DIR, SSH_USER_AUTH: authFile, SSH_ORIGINAL_COMMAND: entry.slug, SSH_CONNECTION: "203.0.113.9 51234 10.0.0.1 22" };
  const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  await new Promise((resolve) => setTimeout(resolve, 300)); // the wrapper must consume the status line first
  child.stdin.write("through the wrapper\n");
  await new Promise((resolve) => { const check = () => (out.includes("through the wrapper") ? resolve() : setTimeout(check, 10)); check(); });
  assert.equal(out, "through the wrapper\n", "stdout carries ONLY the raw stream — the status line never leaks into the SSH transport");
  assert.equal(access.listSshSessions({ slug: entry.slug })[0]?.client, "203.0.113.9");
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  await settle();
  assert.equal(access.listSshSessions({ slug: entry.slug }).length, 0);

  const refused = spawn(process.execPath, [script], { env: { ...env, SSH_ORIGINAL_COMMAND: "no-such-channel" }, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  refused.stderr.on("data", (chunk) => { err += chunk; });
  const [refusedCode] = await once(refused, "exit");
  assert.equal(refusedCode, 1);
  assert.match(err, /no channel is called/);

  const noChannel = spawn(process.execPath, [script], { env: { ...env, SSH_ORIGINAL_COMMAND: "" }, stdio: ["pipe", "pipe", "pipe"] });
  let usage = "";
  noChannel.stderr.on("data", (chunk) => { usage += chunk; });
  const [usageCode] = await once(noChannel, "exit");
  assert.equal(usageCode, 2);
  assert.match(usage, /name the channel/);
});

test("stopping the broker ends live sessions (lease released, row closed) and unlinks the socket", async () => {
  const { line } = await attach({ v: 1, key: ED25519, channel: entry.slug });
  assert.equal(line.ok, true);
  assert.equal(reaper.leaseCount(`cg-${entry.slug}`), 1);
  await broker.stopSshBroker();
  assert.equal(reaper.leaseCount(`cg-${entry.slug}`), 0);
  assert.equal(access.listSshSessions({ slug: entry.slug, live: false })[0].endReason, "daemon shutdown");
  assert.equal(existsSync(path.join(SSH_DIR, broker.SSH_ATTACH_SOCKET)), false);
  assert.equal(broker.sshBrokerStatus().listening, false);
  // A restart closes whatever the previous daemon left open in the table.
  access.openSshSession({ userId: DEV, slug: entry.slug, channelId: CHANNEL_ID, fingerprint: "SHA256:x" });
  await broker.startSshBroker({ dir: SSH_DIR, log: silent, retryMs: 0, deps, authorizeOptions });
  assert.equal(access.listSshSessions({ slug: entry.slug }).length, 0);
  assert.equal(access.listSshSessions({ slug: entry.slug, live: false })[0].endReason, "daemon restart");
});
