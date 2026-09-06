import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactLogValue } from "../src/util/redact.js";
import { tempDir } from "./helpers.js";

const root = path.resolve(import.meta.dirname, "..");

test("central log redaction removes credential-shaped values", () => {
  const text = redactLogValue("xoxb-123-secret Bearer abc.def.ghi? token=oops https://x/?secret=bad");
  assert.doesNotMatch(text, /xoxb-123-secret|abc\.def\.ghi|secret=bad/);
  assert.match(text, /\[REDACTED\]/);
});

test("encrypted backup includes a verified SQLite snapshot and restore drill passes", () => {
  const runtime = tempDir("cg-backup-test-");
  mkdirSync(path.join(runtime, "config"), { recursive: true });
  writeFileSync(path.join(runtime, "config", "settings.json"), "{}\n");
  const db = new DatabaseSync(path.join(runtime, "gateway.db"));
  db.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('durable')");
  db.close();
  // CLAUDE_GATEWAY_DB is emptied ("" counts as unset via ${...:-}): the scripts honor it now,
  // and the test-harness scratch override in process.env must not leak into the scripted root.
  const env = { ...process.env, CLAUDE_GATEWAY_DIR: runtime, CLAUDE_GATEWAY_DB: "", CG_BACKUP_PASSPHRASE: "test-only-passphrase" };
  execFileSync("bash", [path.join(root, "scripts/backup-config.sh")], { env, stdio: "pipe" });
  assert.ok(existsSync(path.join(runtime, "backups", "config.tar.gz.enc")));
  execFileSync("bash", [path.join(root, "scripts/restore-drill.sh")], { env, stdio: "pipe" });
});

test("restore over an existing runtime removes the discarded database's WAL/SHM sidecars", () => {
  // The daemon never closes the WAL-mode DB, so a real restore target always has gateway.db-wal/
  // -shm from the database being replaced. Left behind, SQLite would replay those stale frames
  // over the restored file on next open. The drill can't see this (fresh tmpdir), so restore is
  // exercised here against a pre-populated root.
  const runtime = tempDir("cg-restore-stale-");
  mkdirSync(path.join(runtime, "config"), { recursive: true });
  writeFileSync(path.join(runtime, "config", "settings.json"), "{}\n");
  const db = new DatabaseSync(path.join(runtime, "gateway.db"));
  db.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('durable')");
  db.close();
  // CLAUDE_GATEWAY_DB is emptied ("" counts as unset via ${...:-}): the scripts honor it now,
  // and the test-harness scratch override in process.env must not leak into the scripted root.
  const env = { ...process.env, CLAUDE_GATEWAY_DIR: runtime, CLAUDE_GATEWAY_DB: "", CG_BACKUP_PASSPHRASE: "test-only-passphrase" };
  execFileSync("bash", [path.join(root, "scripts/backup-config.sh")], { env, stdio: "pipe" });
  // Simulate the post-shutdown state of a DIFFERENT, newer database being discarded.
  writeFileSync(path.join(runtime, "gateway.db-wal"), "stale-wal-from-discarded-db");
  writeFileSync(path.join(runtime, "gateway.db-shm"), "stale-shm-from-discarded-db");
  // A file that exists live but NOT in the backup must not survive: restore promises
  // replacement, and the old `cp -R backup/. live/` merge produced hybrid state.
  writeFileSync(path.join(runtime, "config", "stray-not-in-backup.json"), "{}\n");
  execFileSync("bash", [path.join(root, "scripts/restore-config.sh")], {
    env: { ...env, CG_RESTORE_CONFIRM: "YES" },
    stdio: "pipe",
  });
  assert.equal(existsSync(path.join(runtime, "gateway.db-wal")), false);
  assert.equal(existsSync(path.join(runtime, "gateway.db-shm")), false);
  assert.equal(existsSync(path.join(runtime, "config", "stray-not-in-backup.json")), false);
  assert.ok(existsSync(path.join(runtime, "config", "settings.json")));
  const restored = new DatabaseSync(path.join(runtime, "gateway.db"), { readOnly: true });
  assert.equal(restored.prepare("SELECT value FROM proof").get().value, "durable");
  restored.close();
});

test("backup and restore honor the CLAUDE_GATEWAY_DB override", () => {
  const runtime = tempDir("cg-dbenv-test-");
  mkdirSync(path.join(runtime, "config"), { recursive: true });
  writeFileSync(path.join(runtime, "config", "settings.json"), "{}\n");
  const dbFile = path.join(runtime, "custom-location", "gw.db"); // NOT $GW_HOME/gateway.db
  mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('override')");
  db.close();
  const env = {
    ...process.env,
    CLAUDE_GATEWAY_DIR: runtime,
    CLAUDE_GATEWAY_DB: dbFile,
    CG_BACKUP_PASSPHRASE: "test-only-passphrase",
  };
  execFileSync("bash", [path.join(root, "scripts/backup-config.sh")], { env, stdio: "pipe" });
  // Restore into a fresh root, still pointing the DB somewhere custom.
  const target = tempDir("cg-dbenv-restore-");
  const targetDb = path.join(target, "elsewhere", "gw.db");
  mkdirSync(path.dirname(targetDb), { recursive: true });
  execFileSync("bash", [path.join(root, "scripts/restore-config.sh")], {
    env: {
      ...env,
      CLAUDE_GATEWAY_DIR: target,
      CLAUDE_GATEWAY_DB: targetDb,
      CG_BACKUP_FILE: path.join(runtime, "backups", "config.tar.gz.enc"),
      CG_RESTORE_CONFIRM: "YES",
    },
    stdio: "pipe",
  });
  assert.equal(existsSync(path.join(target, "gateway.db")), false); // honored the override…
  const restored = new DatabaseSync(targetDb, { readOnly: true }); // …and landed it here
  assert.equal(restored.prepare("SELECT value FROM proof").get().value, "override");
  restored.close();
});

test("log rotation copy-truncates the live file instead of renaming its inode", () => {
  const runtime = tempDir("cg-maint-test-");
  mkdirSync(path.join(runtime, "logs"), { recursive: true });
  const log = path.join(runtime, "logs", "daemon.out.log");
  writeFileSync(log, "x".repeat(1024 * 1024 + 1)); // just over the 1 MiB floor
  const inodeBefore = statSync(log).ino;
  execFileSync(process.execPath, [path.join(root, "scripts/runtime-maintenance.mjs")], {
    env: { ...process.env, CLAUDE_GATEWAY_DIR: runtime, CG_MAX_LOG_BYTES: "1048576" },
    stdio: "pipe",
  });
  // Same inode, now empty: systemd keeps the daemon's fd open, so a rename would let the
  // "rotated" inode keep growing forever while the cap never applies to the live path.
  assert.equal(statSync(log).ino, inodeBefore);
  assert.equal(statSync(log).size, 0);
  assert.equal(statSync(path.join(runtime, "logs", "daemon.out.log.1")).size, 1024 * 1024 + 1);
});

test("release inventory names nested dependencies accurately and labels unsigned metadata", () => {
  const out = tempDir("cg-release-test-");
  execFileSync(process.execPath, [path.join(root, "scripts/release-artifacts.mjs"), out]);
  const sbom = JSON.parse(readFileSync(path.join(out, "npm-lock-inventory.cdx.json"), "utf8"));
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.ok(sbom.components.length > 0);
  assert.ok(sbom.components.every((c) => !c.name.includes("node_modules") && c.purl && c["bom-ref"]));
  assert.ok(sbom.dependencies.length > 0);
  assert.match(sbom.metadata.properties[0].value, /excludes runtime image/);
  assert.ok(statSync(path.join(out, "build-metadata.json.sha256")).size > 64);
});

test("service packages pin dedicated identities and hardened runtime boundaries", () => {
  const systemd = readFileSync(path.join(root, "scripts/install-systemd.sh"), "utf8");
  const uninstall = readFileSync(path.join(root, "scripts/uninstall-systemd.sh"), "utf8");
  assert.match(systemd, /User=\$SERVICE_USER/);
  assert.match(systemd, /NoNewPrivileges=false/);
  assert.match(systemd, /Delegate=yes/);
  assert.match(systemd, /--add-subids-for-system/);
  assert.match(systemd, /run_as_service "\$NODE_BIN"/);
  assert.match(systemd, /ProtectSystem=strict/);
  // The engines spawn by bare name: the unit must carry an explicit PATH with the resolved CLI
  // dirs (systemd's default PATH won't have nvm/user-prefix installs) and the credential env
  // file for the login-less service account. HOME must exist for os.homedir()-derived state.
  assert.match(systemd, /Environment=PATH=\$SERVICE_PATH/);
  assert.match(systemd, /Environment=HOME=\$SERVICE_HOME/);
  assert.match(systemd, /EnvironmentFile=-\$ENV_FILE/);
  assert.match(systemd, /podman newuidmap newgidmap/);
  // Self-update runs git + npm as the service account inside the checkout, so the installer must
  // hand it ownership (guarded, then proven) instead of leaving root-owned files behind.
  assert.match(systemd, /chown -R "\$SERVICE_USER:\$SERVICE_USER" "\$APP_DIR"/);
  assert.match(systemd, /refusing to chown it/);
  assert.match(systemd, /su -s \/bin\/sh/);
  // Linux only: both packaging scripts refuse any other kernel, and the uninstaller mirrors what
  // the installer creates — the system unit (root) and the user-scope unit, current AND pre-rename
  // names — without ever touching the service account or the runtime root that holds the database.
  for (const script of [systemd, uninstall]) assert.match(script, /uname -s.*Linux/);
  assert.match(uninstall, /^UNIT_NAME="channelgate\.service"$/m);
  assert.match(uninstall, /^LEGACY_UNIT_NAME="claude-gateway\.service"$/m);
  assert.match(uninstall, /\/etc\/systemd\/system/);
  assert.match(uninstall, /\.config\/systemd\/user/);
  assert.match(uninstall, /systemctl disable --now "\$unit"/);
  assert.match(uninstall, /systemctl --user "\$@"/);
  assert.match(uninstall, /needs root/);
  assert.doesNotMatch(uninstall, /userdel|rm -rf/);
  // The npm aliases point at the systemd scripts and nothing else; the launchd ones are gone.
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["service:install"], "bash scripts/install-systemd.sh");
  assert.equal(pkg.scripts["service:uninstall"], "bash scripts/uninstall-systemd.sh");
  assert.deepEqual(Object.keys(pkg.scripts).filter((name) => name.startsWith("service:")).sort(), ["service:install", "service:uninstall"]);
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /launchd/);
});

test("the service entry point gates the Node version before any src module is imported", () => {
  // ESM hoists static imports above every statement, so a version check inside src/server.js runs
  // AFTER node:sqlite has already been required. src/start.js exists to check first and then
  // dynamically import the real server — it must therefore stay free of static imports.
  const entry = readFileSync(path.join(root, "src/start.js"), "utf8");
  assert.doesNotMatch(entry, /^\s*import\s+[^(]/m, "src/start.js must not use a static import");
  assert.doesNotMatch(entry, /^\s*(?:export|require\()/m);
  assert.match(entry, /process\.versions\.node/);
  assert.match(entry, /major === 22 && minor < 13/);
  assert.match(entry, /await import\("\.\/server\.js"\)/);
  // Everything that launches the daemon must exec the gate, not the server directly.
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.start, "node src/start.js");
  assert.match(pkg.scripts.dev, /src\/start\.js$/);
  assert.match(readFileSync(path.join(root, "scripts/install-systemd.sh"), "utf8"), /ExecStart=\$NODE_BIN \$APP_DIR\/src\/start\.js/);
  // Linux only: the platform refusal is one plain line from a dependency-free module that the
  // gate dynamically imports AFTER the Node floor and BEFORE the server graph.
  assert.match(entry, /await import\("\.\/platform-gate\.js"\)/);
  assert.ok(entry.indexOf("process.versions.node") < entry.indexOf("platform-gate.js"));
  assert.ok(entry.indexOf("platform-gate.js") < entry.indexOf('await import("./server.js")'));
});

test("the entry point refuses every platform but Linux with one plain line", async () => {
  const { platformRefusal, SUPPORTED_PLATFORM } = await import("../src/platform-gate.js");
  assert.equal(SUPPORTED_PLATFORM, "linux");
  assert.equal(platformRefusal("linux"), "");
  for (const platform of ["darwin", "win32", "freebsd"]) {
    assert.equal(platformRefusal(platform), `ChannelGate runs on Linux only (systemd + rootless Podman); this host is ${platform}.`);
  }
  // The gate module must stay free of imports so the refusal never depends on a Linux-only module.
  const gate = readFileSync(path.join(root, "src/platform-gate.js"), "utf8");
  assert.doesNotMatch(gate, /^\s*import\s/m);
  // And no launchd/macOS surface is left for the entry point to fall through to.
  assert.doesNotMatch(readFileSync(path.join(root, "src/start.js"), "utf8"), /darwin|launchd/i);
});

test("backup fails closed and restore replaces managed directories instead of merging", () => {
  const backup = readFileSync(path.join(root, "scripts/backup-config.sh"), "utf8");
  const restore = readFileSync(path.join(root, "scripts/restore-config.sh"), "utf8");
  // The retry-without-channels fallback silently produced a backup the manifest lied about.
  assert.doesNotMatch(backup, /\|\| tar -czf/);
  assert.match(backup, /refusing to write a partial backup/);
  assert.match(backup, /Contents: \$CONTENTS/); // the manifest describes what actually went in
  // `cp -R payload/. live/` merged, leaving files that the backup does not contain alive.
  assert.doesNotMatch(restore, /cp -R "\$TMP\/payload\/(config|channels)\/\."/);
  assert.match(restore, /replace_dir\(\)/);
  assert.match(restore, /mv "\$staged" "\$dest"/);
  assert.match(restore, /original put back/);
  // Both scripts follow the same DB override the daemon honors (src/config/paths.js).
  for (const script of [backup, restore]) assert.match(script, /DB_FILE="\$\{CHANNELGATE_DB:-\$\{CLAUDE_GATEWAY_DB:-\$GW_HOME\/gateway\.db\}\}"/);
  assert.doesNotMatch(backup, /"\$GW_HOME\/gateway\.db"/);
  assert.doesNotMatch(restore, /"\$GW_HOME\/gateway\.db"/);
});

test("every operations shell script parses", () => {
  // `bash -n` on the whole directory: these scripts only ever run on an operator's machine (or as
  // root during install), where a syntax error surfaces at the worst possible moment.
  const scripts = readdirSync(path.join(root, "scripts")).filter((name) => name.endsWith(".sh"));
  assert.ok(scripts.length > 0);
  for (const name of scripts) execFileSync("bash", ["-n", path.join(root, "scripts", name)], { stdio: "pipe" });
});
