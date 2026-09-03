import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, statSync, readFileSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
const { hardenRuntimeFiles, writeSecretFile, assertRuntimeHardening } = await import("../src/config/harden.js");
const { settingsFile, usersFile, dbFile, gatewayRoot } = await import("../src/config/paths.js");

// ~/.claude-gateway holds Slack tokens, every user's personal Composio token, the run-API key and
// the admin password. These were created under the default umask (0644 — readable by every other
// account on the host). Permissions are pinned here so a regression can't quietly re-open them.

const mode = (p) => statSync(p).mode & 0o777;

test("writeSecretFile creates 0600 files and re-tightens an existing 0644 one", () => {
  const f = path.join(scratch, "secret-a.json");
  writeSecretFile(f, "{}\n");
  assert.equal(mode(f), 0o600);

  // The trap this guards: writeFileSync's `mode` is ignored when the file already exists — so a
  // plain write over a legacy 0644 file silently leaves it world-readable.
  chmodSync(f, 0o644);
  writeFileSync(f, "stale");
  assert.equal(mode(f), 0o644, "precondition — the file is world-readable again");
  writeSecretFile(f, "{\"fresh\":true}\n");
  assert.equal(mode(f), 0o600, "writeSecretFile must atomically replace and re-tighten the file");
  assert.equal(readFileSync(f, "utf8"), "{\"fresh\":true}\n", "contents must still be written");
});

test("hardenRuntimeFiles tightens the runtime root and every credential file", () => {
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  mkdirSync(path.dirname(dbFile()), { recursive: true });
  const db = dbFile();
  const targets = [settingsFile(), usersFile(), db, `${db}-wal`, `${db}-shm`];
  for (const f of targets) writeFileSync(f, "{}", { mode: 0o644 });

  const { failed } = hardenRuntimeFiles();
  assert.deepEqual(failed, [], "no path should fail to chmod in a scratch dir");

  for (const f of targets) {
    assert.equal(mode(f), 0o600, `${path.basename(f)} must be owner-only`);
  }
  assert.equal(mode(gatewayRoot()), 0o700, "the runtime root itself must be owner-only");
});

test("hardenRuntimeFiles clears stranded per-run token files", async () => {
  const { runTmpDir } = await import("../src/config/paths.js");
  mkdirSync(runTmpDir(), { recursive: true });
  const stranded = path.join(runTmpDir(), "cg-mcp-crashed.json");
  writeFileSync(stranded, "{\"tokens\":\"here\"}");
  assert.ok(existsSync(stranded), "precondition — a crash left a token file behind");

  hardenRuntimeFiles();
  assert.ok(!existsSync(stranded), "boot must not leave a run's tokens on disk");
});

test("hardenRuntimeFiles skips paths that don't exist and never throws", () => {
  const missing = path.join(scratch, "config", "mcp-catalog.json");
  if (existsSync(missing)) return; // another test created it; the skip path is what matters here
  assert.doesNotThrow(() => hardenRuntimeFiles());
});

test("boot fails closed when any runtime path could not be hardened", () => {
  assert.doesNotThrow(() => assertRuntimeHardening({ failed: [] }));
  assert.throws(
    () => assertRuntimeHardening({ failed: ["gateway.db: EPERM"] }),
    /refusing to boot.*gateway\.db: EPERM/
  );
});

// With no admin password every /api route is open. On a loopback bind that was the local-dev
// convenience, but it hands any other process on the host every stored token — not a defensible
// default for a product. Fixing it must NOT lock out existing operators, so the generation is
// scoped strictly to installs that have never been configured.
test("a brand-new install gets a generated admin password", async () => {
  const { ensureAdminPasswordOnFirstBoot } = await import("../src/config/harden.js");
  let saved = "";
  const generated = await ensureAdminPasswordOnFirstBoot({
    settingsExist: false,
    hasPassword: false,
    generate: () => "fresh-secret",
    save: async (pw) => { saved = pw; },
  });
  assert.equal(generated, "fresh-secret", "the password is returned once so boot can print it");
  assert.equal(saved, "fresh-secret");
});

test("an EXISTING install is never given a password behind the operator's back", async () => {
  const { ensureAdminPasswordOnFirstBoot } = await import("../src/config/harden.js");
  let saved = null;
  // The dangerous case: a configured gateway deliberately running open on loopback. Generating
  // here would lock its operator out of their own admin UI on the next restart.
  const generated = await ensureAdminPasswordOnFirstBoot({
    settingsExist: true,
    hasPassword: false,
    generate: () => "must-not-happen",
    save: async (pw) => { saved = pw; },
  });
  assert.equal(generated, "");
  assert.equal(saved, null, "an existing install must not be modified");
});

test("an install that already has a password is left alone", async () => {
  const { ensureAdminPasswordOnFirstBoot } = await import("../src/config/harden.js");
  let saved = null;
  const generated = await ensureAdminPasswordOnFirstBoot({
    settingsExist: false,
    hasPassword: true,
    generate: () => "must-not-happen",
    save: async (pw) => { saved = pw; },
  });
  assert.equal(generated, "");
  assert.equal(saved, null);
});

test("a first-boot password persistence failure rejects instead of leaving the API open", async () => {
  const { ensureAdminPasswordOnFirstBoot } = await import("../src/config/harden.js");
  await assert.rejects(
    ensureAdminPasswordOnFirstBoot({
      settingsExist: false,
      hasPassword: false,
      generate: () => "fresh-secret",
      save: async () => { throw new Error("disk is read-only"); },
    }),
    /disk is read-only/
  );
});
