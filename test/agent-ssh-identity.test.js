import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, chownSync, copyFileSync, linkSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const { agentSshDir, ensureAgentSshIdentity } = await import("../src/config/agent-ssh.js");
const { configDir } = await import("../src/config/paths.js");
const freshDir = () => path.join(tempDir("cg-agent-ssh-"), "identity");

test("one stable deployment identity is generated lazily with exact SSH permissions", () => {
  assert.equal(agentSshDir(), path.join(configDir(), "agent-ssh"));
  const dir = freshDir();
  const identity = ensureAgentSshIdentity({ dir });
  assert.match(identity.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+=* channelgate-agent$/);
  assert.match(identity.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  assert.equal(lstatSync(identity.privateKeyPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(identity.publicKeyPath).mode & 0o777, 0o644);
  const original = readFileSync(identity.privateKeyPath);
  assert.deepEqual(ensureAgentSshIdentity({ dir }), identity);
  assert.deepEqual(readFileSync(identity.privateKeyPath), original);
});

test("generated OpenSSH private key interoperates with ssh-keygen derivation, fingerprint and signing", () => {
  const identity = ensureAgentSshIdentity({ dir: freshDir() });
  const derive = spawnSync("ssh-keygen", ["-y", "-f", identity.privateKeyPath], { encoding: "utf8" });
  assert.equal(derive.status, 0, derive.stderr);
  assert.equal(derive.stdout.trim(), identity.publicKey);
  const fingerprint = spawnSync("ssh-keygen", ["-l", "-f", identity.publicKeyPath], { encoding: "utf8" });
  assert.equal(fingerprint.status, 0, fingerprint.stderr);
  assert.ok(fingerprint.stdout.includes(identity.fingerprint));
  const message = path.join(path.dirname(identity.dir), "message");
  writeFileSync(message, "deployment outbound SSH identity interoperability\n");
  const signed = spawnSync("ssh-keygen", ["-Y", "sign", "-f", identity.privateKeyPath, "-n", "channelgate-test", message], { encoding: "utf8" });
  assert.equal(signed.status, 0, signed.stderr);
  const allowed = path.join(path.dirname(identity.dir), "allowed_signers");
  writeFileSync(allowed, `agent ${identity.publicKey}\n`);
  const verified = spawnSync("ssh-keygen", ["-Y", "verify", "-f", allowed, "-I", "agent", "-n", "channelgate-test", "-s", `${message}.sig`], { input: readFileSync(message), encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
});

test("restrictive process umask still produces readable public key and private 0600 identity", () => {
  const dir = freshDir();
  const moduleUrl = new URL("../src/config/agent-ssh.js", import.meta.url).href;
  const source = `import {ensureAgentSshIdentity} from ${JSON.stringify(moduleUrl)}; process.umask(0o077); process.stdout.write(JSON.stringify(ensureAgentSshIdentity({dir:process.argv[1]})));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source, dir], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const identity = JSON.parse(child.stdout);
  assert.equal(lstatSync(identity.privateKeyPath).mode & 0o7777, 0o600);
  assert.equal(lstatSync(identity.publicKeyPath).mode & 0o7777, 0o644);
});

test("simultaneous fresh processes all observe the same complete keypair", async () => {
  const dir = freshDir();
  const moduleUrl = new URL("../src/config/agent-ssh.js", import.meta.url).href;
  const source = `import {ensureAgentSshIdentity} from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(ensureAgentSshIdentity({dir:process.argv[1]})));`;
  const results = await Promise.all(Array.from({ length: 10 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, dir], { env: process.env });
    let output = "";
    let error = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
  })));
  for (const identity of results) assert.deepEqual(identity, results[0]);
  assert.deepEqual(readdirSync(path.dirname(dir)), ["identity"]);
});

test("an existing incomplete identity fails closed instead of replacing keys", () => {
  const dir = freshDir();
  mkdirSync(dir, { mode: 0o700 });
  assert.throws(() => ensureAgentSshIdentity({ dir }), /invalid or unsafe/);
  assert.deepEqual(readdirSync(dir), []);
  const other = ensureAgentSshIdentity({ dir: freshDir() });
  copyFileSync(other.privateKeyPath, path.join(dir, "id_ed25519"));
  assert.throws(() => ensureAgentSshIdentity({ dir }), /invalid or unsafe/);
  assert.deepEqual(readFileSync(path.join(dir, "id_ed25519")), readFileSync(other.privateKeyPath));
});

test("corrupt, mismatched and nonregular files fail without disclosing secret bytes", () => {
  const other = ensureAgentSshIdentity({ dir: freshDir() });
  for (const mutation of ["private", "public", "mismatch", "directory"]) {
    const identity = ensureAgentSshIdentity({ dir: freshDir() });
    if (mutation === "private") writeFileSync(identity.privateKeyPath, "DO-NOT-DISCLOSE-SECRET");
    if (mutation === "public") writeFileSync(identity.publicKeyPath, "corrupt public key");
    if (mutation === "mismatch") copyFileSync(other.publicKeyPath, identity.publicKeyPath);
    if (mutation === "directory") {
      rmSync(identity.privateKeyPath);
      mkdirSync(identity.privateKeyPath);
    }
    assert.throws(() => ensureAgentSshIdentity({ dir: identity.dir }), error => {
      assert.match(error.message, /invalid or unsafe/);
      assert.ok(!error.message.includes("DO-NOT-DISCLOSE-SECRET"));
      return true;
    });
  }
});

test("identity directory, parent and key symlinks and hardlinked keys are refused", () => {
  const identity = ensureAgentSshIdentity({ dir: freshDir() });
  const dirLink = freshDir();
  symlinkSync(identity.dir, dirLink);
  assert.throws(() => ensureAgentSshIdentity({ dir: dirLink }), /invalid or unsafe/);
  const parentLink = freshDir();
  symlinkSync(path.dirname(identity.dir), parentLink);
  assert.throws(() => ensureAgentSshIdentity({ dir: path.join(parentLink, "identity") }), /invalid or unsafe/);
  for (const key of ["id_ed25519", "id_ed25519.pub"]) {
    for (const kind of ["symlink", "hardlink"]) {
      const target = ensureAgentSshIdentity({ dir: freshDir() });
      const file = path.join(target.dir, key);
      rmSync(file);
      (kind === "symlink" ? symlinkSync : linkSync)(path.join(identity.dir, key), file);
      assert.throws(() => ensureAgentSshIdentity({ dir: target.dir }), /invalid or unsafe/);
      rmSync(file);
    }
  }
});

test("overbroad permissions and ownership mismatches are refused", () => {
  for (const which of ["dir", "privateKeyPath", "publicKeyPath"]) {
    const identity = ensureAgentSshIdentity({ dir: freshDir() });
    chmodSync(identity[which], 0o777);
    assert.throws(() => ensureAgentSshIdentity({ dir: identity.dir }), /invalid or unsafe/);
  }
  if (process.getuid() === 0) {
    for (const which of ["dir", "privateKeyPath", "publicKeyPath"]) {
      const identity = ensureAgentSshIdentity({ dir: freshDir() });
      chownSync(identity[which], 65534, 65534);
      assert.throws(() => ensureAgentSshIdentity({ dir: identity.dir }), /invalid or unsafe/);
      chownSync(identity[which], 0, 0);
    }
  }
});
