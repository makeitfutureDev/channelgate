// SSH access to channel containers (docs/SSH-ACCESS.md), the store-backed half: public-key
// validation and fingerprints, the per-person key registry, the per-channel grant list and its
// audit, the host authorized_keys export (every line restricted by construction), the
// in-container sshd files, the session records, and the Slack-facing MCP tools.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const SSH_DIR = tempDir("cg-ssh-access-");
process.env.CHANNELGATE_SSH_DIR = SSH_DIR;

const access = await import("../src/gateway/ssh-access.js");
const { operatorHomeGranted } = await import("../src/runtimes/container/lifecycle.js");
const { POLICY_KEYS, policyDiff } = await import("../src/config/channel-audit.js");
const { defaultChannelMeta, saveChannelMeta, upsertChannelEntry, setUser, getChannelMeta } = await import("../src/config/store.js");
const { readEvents } = await import("../src/util/logger.js");
const { register } = await import("../src/mcp/tools/ssh-access.js");
const { ctxFromClaims, buildControlPlane } = await import("../src/mcp/gateway-server.js");
const { GATEWAY_TOOL_NAMES } = await import("../src/gateway/mcp-catalog.js");

// Throwaway public keys generated for this test file (public halves only; the private halves were discarded).
const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJGL94yuutmsHOUH3doi4E7xZXvtMROqyt4ckprx0On+ test@example";
const ED25519_FP = "SHA256:uu2wi/CXuJwBs7vrtrw3rqatzf9bPK9N04v6FHuLccQ";
const ECDSA = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBB7xGqVLgj/wDYYZaRR/XjlTDkK//RHq86D7nTfr7jfTv3EWwkmYiOBTi1t7BPKtJGRr75Ua0G3CRby2IJ3oh8c= laptop";
const ECDSA_FP = "SHA256:qtNabX0TsET9zoX1T9FJu2JdNnoIrt/gICsaJe/xrH8";
const hasKeygen = spawnSync("ssh-keygen", ["-?"], { encoding: "utf8" }).status != null;

function keygen(type, bits, comment) {
  const dir = tempDir("cg-keygen-");
  const file = path.join(dir, "key");
  execFileSync("ssh-keygen", ["-q", "-N", "", "-t", type, ...(bits ? ["-b", String(bits)] : []), "-C", comment, "-f", file], { stdio: "pipe" });
  const pub = readFileSync(`${file}.pub`, "utf8").trim();
  const fingerprint = execFileSync("ssh-keygen", ["-lf", `${file}.pub`], { encoding: "utf8" }).split(/\s+/)[1];
  return { pub, fingerprint };
}

test("public keys: ed25519/ecdsa parse to the ssh-keygen fingerprint, and everything unsafe is refused with a readable reason", () => {
  const ed = access.parsePublicKey(`  ${ED25519}\r\n`);
  assert.equal(ed.type, "ssh-ed25519");
  assert.equal(ed.fingerprint, ED25519_FP);
  assert.equal(ed.comment, "test@example");
  assert.equal(ed.bits, 256);
  assert.equal(ed.line, ED25519.split(" ").slice(0, 2).join(" "));
  const ec = access.parsePublicKey(ECDSA);
  assert.equal(ec.fingerprint, ECDSA_FP);
  assert.equal(ec.family, "ECDSA");
  assert.equal(ec.bits, 256);
  assert.throws(() => access.parsePublicKey(""), /PUBLIC key/);
  assert.throws(() => access.parsePublicKey("-----BEGIN OPENSSH PRIVATE KEY-----"), /PRIVATE key/);
  assert.throws(() => access.parsePublicKey(`${ED25519}\n${ECDSA}`), /exactly one/);
  assert.throws(() => access.parsePublicKey("ssh-dss AAAAB3NzaC1kc3MAAACBAP nobody"), /DSA keys are not accepted/);
  assert.throws(() => access.parsePublicKey("ssh-ed25519 not*base64*"), /not valid base64/);
  assert.throws(() => access.parsePublicKey("ssh-ed25519 AAAA"), /not a well-formed/);
  assert.throws(() => access.parsePublicKey(`ssh-rsa ${ED25519.split(" ")[1]}`), /does not match its declared type/);
  assert.throws(() => access.parsePublicKey("ssh-foo AAAAB3NzaC1kc3MAAACBAP"), /Unsupported key type/);
});

test("public keys: RSA is measured off the modulus — 2048 passes with the ssh-keygen fingerprint, 1024 is refused", { skip: !hasKeygen && "ssh-keygen unavailable" }, () => {
  const strong = keygen("rsa", 2048, "rsa@example");
  const parsed = access.parsePublicKey(strong.pub);
  assert.equal(parsed.fingerprint, strong.fingerprint);
  assert.equal(parsed.bits, 2048);
  const weak = keygen("rsa", 1024, "weak@example");
  assert.throws(() => access.parsePublicKey(weak.pub), /at least 2048 bits \(this one is 1024\)/);
  const ed = keygen("ed25519", 0, "fresh@example");
  assert.equal(access.parsePublicKey(ed.pub).fingerprint, ed.fingerprint);
});

test("key registry: one person's keys, idempotent re-adds, never another account's key, only your own removals", async () => {
  const first = await access.addSshKey("U_KEYS_A", ED25519, { label: "work laptop" });
  assert.equal(first.created, true);
  assert.equal(first.key.fingerprint, ED25519_FP);
  assert.equal(first.key.label, "work laptop");
  const again = await access.addSshKey("U_KEYS_A", ED25519);
  assert.equal(again.created, false);
  assert.equal(again.key.id, first.key.id);
  await assert.rejects(access.addSshKey("U_KEYS_B", ED25519), /already registered to another account/);
  await assert.rejects(access.addSshKey("", ED25519), /No user identity/);
  const second = await access.addSshKey("U_KEYS_A", ECDSA);
  assert.equal(second.key.label, "laptop", "the key comment becomes the default label");
  assert.deepEqual((await access.listSshKeys("U_KEYS_A")).map((k) => k.fingerprint), [ED25519_FP, ECDSA_FP]);
  assert.equal((await access.findSshKeyByFingerprint(ED25519_FP)).userId, "U_KEYS_A");
  assert.equal(await access.findSshKeyByFingerprint("SHA256:nope"), null);
  assert.deepEqual((await access.keysForUsers(["U_KEYS_A", "U_KEYS_A", ""])).length, 2);
  assert.equal(await access.removeSshKey("U_KEYS_B", ED25519_FP), null, "someone else cannot remove it");
  assert.equal((await access.removeSshKey("U_KEYS_A", ED25519_FP)).fingerprint, ED25519_FP);
  assert.equal((await access.removeSshKey("U_KEYS_A", second.key.id)).id, second.key.id);
  assert.deepEqual(await access.listSshKeys("U_KEYS_A"), []);
});

test("key registry: a person is capped so a runaway paste cannot fill the host file", { skip: !hasKeygen && "ssh-keygen unavailable" }, async () => {
  for (let i = 0; i < access.MAX_KEYS_PER_USER; i += 1) await access.addSshKey("U_KEYS_CAP", keygen("ed25519", 0, `k${i}`).pub);
  await assert.rejects(access.addSshKey("U_KEYS_CAP", keygen("ed25519", 0, "one-too-many").pub), /already have/);
});

test("grants live on channel meta, dedupe, audit as a list, and the home-grant block mirrors the runtime's own rule", () => {
  assert.deepEqual(access.sshUsersOf({ sshUsers: ["U1", "U1", " U2 ", ""] }), ["U1", "U2"]);
  assert.deepEqual(access.sshUsersOf({}), []);
  assert.deepEqual(access.grantSshUser({ sshUsers: ["U1"] }, "U2"), { sshUsers: ["U1", "U2"], changed: true });
  assert.deepEqual(access.grantSshUser({ sshUsers: ["U1"] }, "U1"), { sshUsers: ["U1"], changed: false });
  assert.deepEqual(access.revokeSshUser({ sshUsers: ["U1", "U2"] }, "U1"), { sshUsers: ["U2"], changed: true });
  assert.deepEqual(access.revokeSshUser({}, "U1"), { sshUsers: [], changed: false });
  assert.ok(POLICY_KEYS.includes("sshUsers"), "an SSH grant is channel posture and must be audited");
  const diff = policyDiff({ sshUsers: ["U2", "U1"] }, { sshUsers: ["U1", "U3"] });
  assert.deepEqual(diff.sshUsers, { from: ["U1", "U2"], to: ["U1", "U3"] });
  for (const adminMode of [true, false]) {
    for (const fullAccessHome of [true, false, undefined]) {
      const settings = { fullAccessHome };
      assert.equal(access.sshBlockedByHomeGrant({ adminMode }, settings), operatorHomeGranted({ meta: { adminMode }, settings }), `adminMode=${adminMode} fullAccessHome=${fullAccessHome}`);
    }
  }
  assert.equal(access.parseUserRef("<@U123ABC|tibi>"), "U123ABC");
  assert.equal(access.parseUserRef("<@U123ABC>"), "U123ABC");
  assert.equal(access.parseUserRef("@U123ABC"), "U123ABC");
  assert.equal(access.parseUserRef(" U123ABC "), "U123ABC");
  assert.equal(access.parseUserRef("29:1abc@teams"), "29:1abc@teams");
  assert.equal(access.parseUserRef("not a user"), "");
});

test("host side: no endpoint means not configured, and every exported line is restrict,command= by construction", async () => {
  assert.equal(access.sshAccessState(path.join(SSH_DIR, "missing")).configured, false);
  assert.match(access.sshAccessState(path.join(SSH_DIR, "missing")).reason, /install-ssh-access\.sh/);
  const before = access.exportHostAuthorizedKeys({ dir: SSH_DIR });
  assert.equal(before.written, false);
  writeFileSync(path.join(SSH_DIR, "endpoint.json"), JSON.stringify({ host: "gw.example.com", port: 22, user: "channelgate-ssh", attachCommand: "/usr/bin/node /usr/local/lib/channelgate/cg-ssh-attach.mjs" }));
  const state = access.sshAccessState(SSH_DIR);
  assert.equal(state.configured, true);
  assert.equal(state.endpoint.host, "gw.example.com");
  assert.throws(() => access.renderHostAuthorizedKeys([], { attachCommand: 'node "x"' }), /double quotes/);
  const key = (await access.addSshKey("U_EXPORT", ED25519)).key;
  const rendered = access.renderHostAuthorizedKeys([key, { id: "bad id", type: "ssh-ed25519", base64: "AAAA" }, { id: "x", type: "ssh-dss", base64: "AAAA" }], { attachCommand: state.endpoint.attachCommand });
  const lines = rendered.split("\n").filter((line) => line && !line.startsWith("#"));
  assert.equal(lines.length, 1, "a malformed id and an unsupported type are dropped, never emitted bare");
  assert.equal(lines[0], `restrict,command="/usr/bin/node /usr/local/lib/channelgate/cg-ssh-attach.mjs ${key.id}" ssh-ed25519 ${ED25519.split(" ")[1]} cg:${key.id}`);
  const exported = access.exportHostAuthorizedKeys({ dir: SSH_DIR });
  assert.equal(exported.written, true);
  assert.equal(statSync(exported.path).mode & 0o777, 0o640, "sshd's AuthorizedKeysCommand runs as the login account, which is in the group");
  const body = readFileSync(exported.path, "utf8");
  assert.ok(body.includes(`cg:${key.id}`));
  for (const line of body.split("\n").filter((l) => l && !l.startsWith("#"))) assert.match(line, /^restrict,command="[^"]+" (ssh-|ecdsa-|sk-)/);
  await access.removeSshKey("U_EXPORT", ED25519_FP);
  assert.equal(access.connectSnippet({ endpoint: state.endpoint, channel: "acme-app" }), "Host acme-app\n  HostName acme-app\n  User agent\n  ProxyCommand ssh channelgate-ssh@gw.example.com acme-app");
  assert.match(access.connectSnippet({ endpoint: { ...state.endpoint, port: 2222 }, channel: "acme-app", alias: "acme" }), /^Host acme\n[\s\S]*ProxyCommand ssh -p 2222 channelgate-ssh@gw\.example\.com acme-app$/);
});

test("the root installer finds node without relying on root's PATH, copies it beside the wrapper, and never dies silently", () => {
  const script = readFileSync(new URL("../scripts/install-ssh-access.sh", import.meta.url), "utf8");
  assert.match(script, /^trap 'echo "❌ install-ssh-access\.sh failed at line \$LINENO/m, "an ERR trap names the failing line");
  assert.doesNotMatch(script, /=\$\{CG_NODE_BIN:-\$\(command -v node\)\}/, "a failing command substitution in an assignment exits silently under set -e");
  assert.match(script, /candidate="\$\(command -v node 2>\/dev\/null \|\| true\)"/, "the PATH lookup must not abort the script");
  for (const location of ["$home/.local/bin/node", "$home/.local/node/bin/node", "/.nvm/versions/node/*/bin/node", "$home/.volta/bin/node", "/usr/local/bin/node"]) {
    assert.ok(script.includes(location), `the installer looks in ${location}`);
  }
  assert.match(script, /install -m 0755 -o root -g root "\$NODE_SRC" "\$NODE_BIN"/, "node is copied root-owned beside the wrapper");
  assert.match(script, /NODE_BIN="\$LIB_DIR\/node"/, "the attach command uses the copy, not the operator's private install");
  assert.match(script, /runuser -u "\$SSH_USER" -- "\$NODE_BIN" -e "process\.exit\(0\)"/, "the login account is proven able to execute it before sshd is configured");
  assert.match(script, /ssh-keyscan -p "\$SSH_PORT" -t ed25519 "\$SSH_HOST"/, "the advertised endpoint is probed");
  assert.match(script, /answers with a different SSH host key[\s\S]*exit 1/, "an address that reaches another server is fatal");
  assert.match(script, /Cloudflare/, "a proxied web hostname is called out as the usual mistake");
  const parsed = spawnSync("bash", ["-n", new URL("../scripts/install-ssh-access.sh", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test("container side: the generated sshd_config is key-only, forwards inside, no agent forwarding, reaps dead peers; files are private", async () => {
  const target = { artifactDir: path.join(SSH_DIR, "artifacts", "acme") };
  mkdirSync(target.artifactDir, { recursive: true });
  const config = access.renderContainerSshdConfig("/x/ssh");
  for (const line of ["PasswordAuthentication no", "UsePAM no", "AllowUsers agent", "AllowTcpForwarding yes", "AllowAgentForwarding no", "X11Forwarding no", "ClientAliveInterval 60", "ClientAliveCountMax 3", "HostKey /x/ssh/host_key", "AuthorizedKeysFile /x/ssh/authorized_keys", "Subsystem sftp internal-sftp", "PermitRootLogin no", "PidFile none"]) {
    assert.ok(config.split("\n").includes(line), `sshd_config must carry "${line}"`);
  }
  const key = (await access.addSshKey("U_FILES", ECDSA)).key;
  const result = access.materializeContainerSshFiles(target, [key, { type: "ssh-dss", base64: "AAAA", userId: "U_BAD" }]);
  assert.equal(result.dir, path.join(target.artifactDir, "ssh"));
  assert.equal(result.hostKeyPresent, false, "the host key is generated inside the container on first use");
  assert.equal(statSync(result.dir).mode & 0o777, 0o700);
  for (const name of ["sshd_config", "authorized_keys"]) assert.equal(statSync(path.join(result.dir, name)).mode & 0o777, 0o600, name);
  const keys = readFileSync(path.join(result.dir, "authorized_keys"), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(keys, [`ecdsa-sha2-nistp256 ${ECDSA.split(" ")[1]} cg:U_FILES`]);
  assert.equal(access.containerHostKeyFingerprint(target), "");
  writeFileSync(path.join(result.dir, "host_key.pub"), `${ED25519}\n`);
  assert.equal(access.containerHostKeyFingerprint(target), ED25519_FP);
  await access.removeSshKey("U_FILES", ECDSA_FP);
  assert.throws(() => access.containerSshDir({}), /artifact directory/);
});

test("sessions: open, list live per channel, close with a reason, and a restart closes the orphans", () => {
  let clock = 1_000;
  const now = () => clock;
  const a = access.openSshSession({ userId: "U_S1", slug: "acme", channelId: "C1", fingerprint: ED25519_FP, client: "203.0.113.5", container: "cg-acme", now });
  clock = 2_000;
  const b = access.openSshSession({ userId: "U_S2", slug: "acme", channelId: "C1", fingerprint: ECDSA_FP, now });
  access.openSshSession({ userId: "U_S3", slug: "other", channelId: "C2", fingerprint: ECDSA_FP, now });
  assert.deepEqual(access.listSshSessions({ slug: "acme" }).map((s) => s.id), [b, a]);
  access.closeSshSession(a, { reason: "client disconnected", now: () => 3_000 });
  assert.deepEqual(access.listSshSessions({ slug: "acme" }).map((s) => s.id), [b]);
  const closed = access.listSshSessions({ slug: "acme", live: false }).find((s) => s.id === a);
  assert.equal(closed.endedAt, 3_000);
  assert.equal(closed.endReason, "client disconnected");
  assert.equal(closed.client, "203.0.113.5");
  assert.equal(access.closeOrphanSshSessions("daemon restart", { now: () => 4_000 }), 2);
  assert.deepEqual(access.listSshSessions({}), []);
});

// ── The MCP tools ─────────────────────────────────────────────────────────────────────────────
const CHANNEL_ID = "C_SSH_TOOLS";
const ADMIN = "U_SSH_ADMIN";
const DEV = "U_SSH_DEV";
const OUTSIDER = "U_SSH_OUT";
await setUser(ADMIN, { name: "Contact", isAdmin: true, approved: true });
await setUser(DEV, { name: "Apps", isAdmin: false, approved: true });
await setUser(OUTSIDER, { name: "Nobody", isAdmin: false, approved: false });
const entry = await upsertChannelEntry(CHANNEL_ID, { name: "ssh-tools", type: "channel", isDM: false });
await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: CHANNEL_ID, name: "ssh-tools", type: "channel", isDM: false }), allowBash: true });

function toolsFor(authorId) {
  const tools = new Map();
  const ctx = ctxFromClaims({ channelId: CHANNEL_ID, slug: entry.slug, authorId, threadKey: "1700000000.000200", principalTrusted: true, engine: "claude" });
  register({ registerTool: (name, _def, handler) => tools.set(name, handler) }, ctx);
  return tools;
}
const reply = (result) => result.content[0].text;

test("tools: registered names, permission list and control-plane gates line up", () => {
  const names = [...toolsFor(DEV).keys()];
  assert.deepEqual(names.sort(), ["add_my_ssh_key", "grant_channel_ssh", "list_my_ssh_keys", "remove_my_ssh_key", "revoke_channel_ssh", "show_channel_ssh"]);
  for (const name of names) assert.ok(GATEWAY_TOOL_NAMES.includes(name), `${name} must be on the Claude permission allowlist`);
  const plane = buildControlPlane({ loadMeta: async () => ({}) });
  assert.equal(plane.get("add_my_ssh_key").authz, "any");
  assert.equal(plane.get("remove_my_ssh_key").authz, "any");
  assert.equal(plane.get("grant_channel_ssh").authz, "manage");
  assert.equal(plane.get("revoke_channel_ssh").authz, "manage");
  assert.equal(plane.has("show_channel_ssh"), false, "reads carry no approval card");
  assert.equal(plane.has("list_my_ssh_keys"), false);
  assert.match(plane.get("grant_channel_ssh").details({ user: "<@U1>" }), /full shell/);
  assert.doesNotMatch(plane.get("add_my_ssh_key").details({ label: "laptop" }), /AAAA/, "never the key material");
});

test("tools: a person registers only their own key; unapproved users and private keys are refused", async () => {
  const dev = toolsFor(DEV);
  assert.match(reply(await dev.get("add_my_ssh_key")({ public_key: "-----BEGIN OPENSSH PRIVATE KEY-----" })), /PRIVATE key/);
  const added = reply(await dev.get("add_my_ssh_key")({ public_key: ED25519, label: "macbook" }));
  assert.match(added, /Registered your ED25519 key \*\*SHA256:/);
  assert.match(added, /gateway host now accepts it/, "the endpoint from the earlier test is configured, so the file is exported");
  assert.match(reply(await dev.get("add_my_ssh_key")({ public_key: ED25519 })), /Already registered/);
  assert.match(reply(await toolsFor(OUTSIDER).get("add_my_ssh_key")({ public_key: ECDSA })), /Only an approved user/);
  assert.match(reply(await dev.get("list_my_ssh_keys")({})), /macbook/);
  assert.match(reply(await toolsFor(ADMIN).get("list_my_ssh_keys")({})), /no registered SSH key/);
  const exported = readFileSync(path.join(SSH_DIR, "authorized_keys"), "utf8");
  assert.ok(exported.includes(ED25519.split(" ")[1]));
});

test("tools: grants need a manager, an approved grantee, and are audited; show hands out the connection block only to the granted", async () => {
  const dev = toolsFor(DEV);
  const admin = toolsFor(ADMIN);
  assert.match(reply(await dev.get("grant_channel_ssh")({ user: `<@${DEV}>` })), /Only this channel's managers/);
  assert.match(reply(await admin.get("grant_channel_ssh")({ user: `<@${OUTSIDER}|nobody>` })), /not an approved user/);
  assert.match(reply(await admin.get("grant_channel_ssh")({ user: "not a user" })), /user id or @mention/);
  const shownBefore = reply(await dev.get("show_channel_ssh")({}));
  assert.match(shownBefore, /Granted: nobody yet/);
  assert.match(shownBefore, /You are not granted here/);
  const granted = reply(await admin.get("grant_channel_ssh")({ user: `<@${DEV}|apps>` }));
  assert.match(granted, /✅ @Apps may now SSH/);
  assert.doesNotMatch(granted, /not registered a key/);
  assert.deepEqual((await getChannelMeta(entry.slug)).sshUsers, [DEV]);
  const audit = readEvents({ limit: 20 }).find((event) => event.event === "channel_meta_changed" && event.slug === entry.slug && event.keys?.includes("sshUsers"));
  assert.ok(audit, "the grant must leave a channel_meta_changed row naming sshUsers");
  assert.equal(audit.author, ADMIN);
  assert.match(reply(await admin.get("grant_channel_ssh")({ user: DEV })), /already has SSH access/);
  const shown = reply(await dev.get("show_channel_ssh")({}));
  assert.match(shown, /Gateway endpoint: `channelgate-ssh@gw\.example\.com`/);
  assert.match(shown, /Granted: @Apps\b/);
  assert.match(shown, new RegExp(`ProxyCommand ssh channelgate-ssh@gw\\.example\\.com ${entry.slug}`));
  assert.match(shown, /Live sessions: none/);
  const adminGranted = reply(await admin.get("grant_channel_ssh")({ user: ADMIN }));
  assert.match(adminGranted, /not registered a key yet/);
  assert.match(reply(await admin.get("show_channel_ssh")({})), /no key registered yet/);
  assert.match(reply(await toolsFor(OUTSIDER).get("show_channel_ssh")({})), /not allowed in this channel/);
  assert.match(reply(await dev.get("revoke_channel_ssh")({ user: ADMIN })), /Only this channel's managers/);
  assert.match(reply(await admin.get("revoke_channel_ssh")({ user: ADMIN })), /revoked here/);
  assert.match(reply(await admin.get("revoke_channel_ssh")({ user: ADMIN })), /has no SSH access here/);
  assert.deepEqual((await getChannelMeta(entry.slug)).sshUsers, [DEV]);
  assert.match(reply(await dev.get("remove_my_ssh_key")({ key: "SHA256:nope" })), /No key of yours/);
  assert.match(reply(await dev.get("remove_my_ssh_key")({ key: ED25519_FP })), /✅ Removed/);
  assert.ok(!readFileSync(path.join(SSH_DIR, "authorized_keys"), "utf8").includes(ED25519.split(" ")[1]), "the host file follows a removal at once");
  assert.match(reply(await dev.get("show_channel_ssh")({})), /granted but have no key registered/);
});

test("tools: the block on Admin + containerFullAccessHome is spelled out on grant and on show", async () => {
  const settingsMod = await import("../src/config/settings.js");
  const original = settingsMod.getContainerRuntime;
  await saveChannelMeta(entry.slug, { ...(await getChannelMeta(entry.slug)), adminMode: true });
  const { sshBlockedByHomeGrant } = access;
  assert.equal(sshBlockedByHomeGrant(await getChannelMeta(entry.slug), { fullAccessHome: true }), true);
  assert.equal(sshBlockedByHomeGrant(await getChannelMeta(entry.slug), original()), original().fullAccessHome === true);
  await saveChannelMeta(entry.slug, { ...(await getChannelMeta(entry.slug)), adminMode: false });
});
