// Admin-surface posture left over from the 2026-11 review of the stable branch:
//   - ADMIN_PASSWORD in the environment may be a scrypt hash, `npm run hash-password` prints the
//     line, and the daemon warns at boot about a cleartext or a forgotten (shadowed) value;
//   - a Public URL on a loopback bind with no declared proxy is warned about at boot;
//   - the GitHub webhook refuses what it can refuse before its body parser runs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const { saveSettings } = await import("../src/config/settings.js");
const leaf = await import("../src/web/password-hash.js");
const security = await import("../src/web/security.js");
const { bootPostureWarnings } = await import("../src/web/boot-posture.js");
const { skillsWebhookGate } = await import("../src/web/skills-mcp.js");

const HASH = await leaf.hashPassword("correct horse");

test("the hashing leaf imports nothing but node:crypto, and security.js re-exports it unchanged", () => {
  const imports = [...read("src/web/password-hash.js").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:crypto"]);
  for (const name of ["timingSafeEqualStr", "isHashedPassword", "hashPassword", "verifyPassword"]) assert.equal(security[name], leaf[name], name);
});

test("an ADMIN_PASSWORD from the environment verifies as a hash and still as legacy cleartext", async () => {
  assert.equal(leaf.isHashedPassword(HASH), true);
  assert.equal(await leaf.verifyPassword("correct horse", HASH), true);
  assert.equal(await leaf.verifyPassword("wrong", HASH), false);
  assert.equal(await leaf.verifyPassword("plain", "plain"), true);
  assert.equal(await leaf.verifyPassword("plain2", "plain"), false);
  assert.equal(await leaf.verifyPassword("x", "scrypt$only-salt"), false, "a malformed record never verifies");
});

test("hash-password reads the password from stdin and prints a line both .env loaders take verbatim", async () => {
  const run = (input) => spawnSync(process.execPath, [path.join(root, "scripts/hash-password.mjs")], { input, encoding: "utf8" });
  const ok = run("s3cret pass\n");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^ADMIN_PASSWORD='scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+'\n$/);
  assert.doesNotMatch(ok.stdout + ok.stderr, /s3cret pass/, "the password is never echoed");

  // Node's own .env loader (what server.js uses) returns the hash intact, "$" included.
  const dir = mkdtempSync(path.join(os.tmpdir(), "cg-hash-"));
  writeFileSync(path.join(dir, ".env"), ok.stdout);
  const loaded = spawnSync(process.execPath, ["-e", "process.loadEnvFile('.env'); process.stdout.write(process.env.ADMIN_PASSWORD)"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(await leaf.verifyPassword("s3cret pass", loaded.stdout), true);
  assert.equal(await leaf.verifyPassword("s3cret pass ", loaded.stdout), false);

  const empty = run("");
  assert.equal(empty.status, 1);
  assert.equal(empty.stdout, "");
  assert.match(empty.stderr, /empty password/);
  // Never from argv: it would sit in the shell history and the process list.
  assert.doesNotMatch(read("scripts/hash-password.mjs"), /process\.argv/);
  assert.equal(JSON.parse(read("package.json")).scripts["hash-password"], "node scripts/hash-password.mjs");
});

test("hash-password turns the terminal echo off before either prompt is shown", async () => {
  // A terminal stand-in: stdin claims to be a TTY and every raw-mode switch is written to stderr,
  // in line with the prompts, so the ORDER is what the assertion reads. Found live with a real
  // pty: the prompt used to be written first, and a password typed at once was echoed.
  const dir = mkdtempSync(path.join(os.tmpdir(), "cg-hash-tty-"));
  const preload = path.join(dir, "fake-tty.mjs");
  writeFileSync(preload, 'process.stdin.isTTY = true;\nprocess.stdin.setRawMode = (on) => { process.stderr.write(on ? "<raw:on>" : "<raw:off>"); return process.stdin; };\n');
  const child = spawn(process.execPath, ["--import", preload, path.join(root, "scripts/hash-password.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let answered = 0;
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
    if (answered === 0 && stderr.includes("New admin password: ")) { answered = 1; child.stdin.write("typed pass\r"); }
    if (answered === 1 && stderr.includes("Repeat it: ")) { answered = 2; child.stdin.end("typed pass\r"); }
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const status = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  assert.equal(status, 0, stderr);
  assert.ok(stderr.startsWith("<raw:on>New admin password: <raw:off>\n<raw:on>Repeat it: <raw:off>\n"), JSON.stringify(stderr.slice(0, 120)));
  assert.doesNotMatch(stdout + stderr, /typed pass/);
  const hash = stdout.match(/^ADMIN_PASSWORD='(scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+)'\n$/)?.[1];
  assert.equal(await leaf.verifyPassword("typed pass", hash), true);
});

test("boot warns about a cleartext ADMIN_PASSWORD in the environment, and not about a hashed one", () => {
  const cleartext = bootPostureWarnings({ envPassword: "hunter2" });
  assert.equal(cleartext.length, 1);
  assert.match(cleartext[0], /stored in cleartext/);
  assert.match(cleartext[0], /npm run hash-password/);
  assert.doesNotMatch(cleartext[0], /hunter2/, "a warning never carries the value");
  assert.deepEqual(bootPostureWarnings({ envPassword: HASH }), []);
  assert.deepEqual(bootPostureWarnings({}), []);
  assert.deepEqual(bootPostureWarnings(), []);
  assert.deepEqual(bootPostureWarnings({ envPassword: undefined, settingsPassword: HASH }), []);
});

test("boot warns when an environment ADMIN_PASSWORD is shadowed by the one set in the admin UI", () => {
  const shadowedClear = bootPostureWarnings({ envPassword: "hunter2", settingsPassword: HASH });
  assert.equal(shadowedClear.length, 1);
  assert.match(shadowedClear[0], /becomes the admin password again if that one is removed, and it is stored in cleartext/);
  assert.doesNotMatch(shadowedClear[0], /hunter2/);
  const shadowedHash = bootPostureWarnings({ envPassword: HASH, settingsPassword: HASH });
  assert.equal(shadowedHash.length, 1);
  assert.match(shadowedHash[0], /becomes the admin password again if that one is removed\. Delete the line/);
});

test("boot warns about a Public URL on a loopback bind with no declared proxy, and only then", () => {
  const facts = { publicUrl: "https://gate.example.com", bindHost: "127.0.0.1", trustProxy: "" };
  const warned = bootPostureWarnings(facts);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /no reverse proxy is declared/);
  assert.match(warned[0], /Behind a reverse proxy/);
  assert.equal(bootPostureWarnings({ ...facts, bindHost: "::1" }).length, 1);
  assert.deepEqual(bootPostureWarnings({ ...facts, trustProxy: "cloudflare" }), []);
  assert.deepEqual(bootPostureWarnings({ ...facts, trustProxy: "xff" }), []);
  assert.deepEqual(bootPostureWarnings({ ...facts, publicUrl: "" }), []);
  // A non-loopback bind is reached directly: the socket address IS the client there.
  assert.deepEqual(bootPostureWarnings({ ...facts, bindHost: "0.0.0.0" }), []);
  // Both kinds at once are both reported.
  assert.equal(bootPostureWarnings({ ...facts, envPassword: "hunter2" }).length, 2);
});

test("server.js prints the posture warnings from the live configuration", () => {
  const src = read("src/server.js");
  assert.match(src, /for \(const warning of bootPostureWarnings\(\{\s+envPassword: process\.env\.ADMIN_PASSWORD,\s+settingsPassword: getSettings\(\)\.adminPassword,\s+publicUrl: getPublicUrl\(\),\s+bindHost: HOST,\s+trustProxy: getTrustProxy\(\),\s+\}\)\)\s+console\.warn\(`\[gateway\] WARNING: \$\{warning\}`\);/);
});

test("the GitHub webhook answers without reading the body when there is no secret or no well-formed signature", async () => {
  let parsed = 0;
  const probe = express();
  probe.post("/hook", skillsWebhookGate(), (_req, _res, next) => { parsed += 1; next(); }, (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => { const s = probe.listen(0, "127.0.0.1", () => resolve(s)); });
  const post = (headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/hook`, { method: "POST", headers, body: "x".repeat(4096) });
  try {
    saveSettings({ skillsWebhookSecret: "" });
    const unconfigured = await post({ "x-hub-signature-256": `sha256=${"a".repeat(64)}` });
    assert.equal(unconfigured.status, 404);
    assert.deepEqual(await unconfigured.json(), { error: "webhook not configured" });

    saveSettings({ skillsWebhookSecret: "hook-secret" });
    for (const signature of [undefined, "", "sha256=bad", `sha1=${"a".repeat(40)}`, `sha256=${"A".repeat(64)}`, `sha256=${"a".repeat(65)}`]) {
      const refused = await post(signature === undefined ? {} : { "x-hub-signature-256": signature });
      assert.equal(refused.status, 401, String(signature));
    }
    assert.equal(parsed, 0, "nothing reached the body parser");

    // A well-formed signature passes the gate; whether it is the RIGHT one is the handler's job.
    const shaped = await post({ "x-hub-signature-256": `sha256=${"a".repeat(64)}` });
    assert.equal(shaped.status, 200);
    assert.equal(parsed, 1);
  } finally {
    saveSettings({ skillsWebhookSecret: "" });
    server.close();
  }
  // The real mount puts the gate ahead of the 2 MB parser.
  assert.match(read("src/web/skills-mcp.js"), /app\.post\("\/api\/skills\/webhook\/github", skillsWebhookGate\(\), express\.raw\(/);
});
