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
  const log = path.join(runtime, "logs", "launchd.out.log");
  writeFileSync(log, "x".repeat(1024 * 1024 + 1)); // just over the 1 MiB floor
  const inodeBefore = statSync(log).ino;
  execFileSync(process.execPath, [path.join(root, "scripts/runtime-maintenance.mjs")], {
    env: { ...process.env, CLAUDE_GATEWAY_DIR: runtime, CG_MAX_LOG_BYTES: "1048576" },
    stdio: "pipe",
  });
  // Same inode, now empty: launchd/systemd keep the daemon's fd open, so a rename would let the
  // "rotated" inode keep growing forever while the cap never applies to the live path.
  assert.equal(statSync(log).ino, inodeBefore);
  assert.equal(statSync(log).size, 0);
  assert.equal(statSync(path.join(runtime, "logs", "launchd.out.log.1")).size, 1024 * 1024 + 1);
});

test("release artifact generator emits deterministic SBOM and provenance checksums", () => {
  const out = tempDir("cg-release-test-");
  execFileSync(process.execPath, [path.join(root, "scripts/release-artifacts.mjs"), out]);
  const sbom = JSON.parse(readFileSync(path.join(out, "sbom.cdx.json"), "utf8"));
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.ok(sbom.components.length > 0);
  assert.ok(statSync(path.join(out, "provenance.intoto.jsonl.sha256")).size > 64);
});

test("service packages pin dedicated identities and hardened runtime boundaries", () => {
  const systemd = readFileSync(path.join(root, "scripts/install-systemd.sh"), "utf8");
  const launchd = readFileSync(path.join(root, "scripts/install-launchd.sh"), "utf8");
  assert.match(systemd, /User=\$SERVICE_USER/);
  assert.match(systemd, /NoNewPrivileges=true/);
  assert.match(systemd, /ProtectSystem=strict/);
  // The engines spawn by bare name: the unit must carry an explicit PATH with the resolved CLI
  // dirs (systemd's default PATH won't have nvm/user-prefix installs) and the credential env
  // file for the login-less service account. HOME must exist for os.homedir()-derived state.
  assert.match(systemd, /Environment=PATH=\$SERVICE_PATH/);
  assert.match(systemd, /Environment=HOME=\$SERVICE_HOME/);
  assert.match(systemd, /EnvironmentFile=-\$ENV_FILE/);
  assert.match(systemd, /command -v "\$engine"/);
  assert.match(launchd, /ProcessType<\/key><string>Background/);
  // Self-update runs git + npm as the service account inside the checkout, so the installer must
  // hand it ownership (guarded, then proven) instead of leaving root-owned files behind.
  assert.match(systemd, /chown -R "\$SERVICE_USER:\$SERVICE_USER" "\$APP_DIR"/);
  assert.match(systemd, /refusing to chown it/);
  assert.match(systemd, /su -s \/bin\/sh/);
});

test("the launchd PATH has no empty components, covers every engine CLI, and is XML-escaped", () => {
  const launchd = readFileSync(path.join(root, "scripts/install-launchd.sh"), "utf8");
  // The old build pasted a possibly-empty $CLAUDE_DIR straight into the PATH string; an empty
  // component means "the current directory", which every spawned subprocess would then search.
  assert.doesNotMatch(launchd, /AGENT_PATH="[^"]*\$CLAUDE_DIR/);
  assert.doesNotMatch(launchd, /::/);
  assert.match(launchd, /for engine in claude codex opencode/); // same engine list as install-systemd.sh
  assert.match(launchd, /\[ -d "\$1" \]/); // only directories that exist
  assert.match(launchd, /case ":\$AGENT_PATH:" in \*":\$1:"\*/); // deduplicated
  // Every value interpolated into the plist goes through xml_escape — a repo path containing &,
  // < or > would otherwise produce a document launchd refuses to parse.
  assert.match(launchd, /xml_escape\(\)/);
  for (const name of ["NODE_BIN", "APP_DIR", "LOG_DIR", "AGENT_PATH"]) {
    assert.match(launchd, new RegExp(`${name}_XML="\\$\\(xml_escape "\\$${name}"\\)"`));
    assert.doesNotMatch(launchd, new RegExp(`<string>\\$${name}(?!_XML)`));
  }
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
  assert.match(readFileSync(path.join(root, "scripts/install-launchd.sh"), "utf8"), /<string>\$APP_DIR_XML\/src\/start\.js<\/string>/);
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

test("launchd boot mode starts without a login and cannot coexist with the LaunchAgent", () => {
  const launchd = readFileSync(path.join(root, "scripts/install-launchd.sh"), "utf8");
  const uninstall = readFileSync(path.join(root, "scripts/uninstall-launchd.sh"), "utf8");

  // A LaunchAgent's domain only exists once its user logs in graphically, so an unattended
  // reboot leaves the Mac at the login window with the gateway down. Boot mode installs a
  // system-domain LaunchDaemon instead.
  assert.match(launchd, /LaunchDaemons/);
  assert.match(launchd, /launchctl bootstrap system/);

  // It must drop to the owning user — the engine credentials, runtime root and channel folders
  // all live in that home — and carry an explicit HOME, since system-domain jobs inherit none.
  assert.match(launchd, /<key>UserName<\/key><string>\$\(xml_escape "\$RUN_USER"\)<\/string>/);
  assert.match(launchd, /<key>HOME<\/key><string>\$RUN_HOME_XML<\/string>/);
  // launchd refuses a system plist that isn't root-owned.
  assert.match(launchd, /chown root:wheel/);

  // Under sudo, $HOME/$USER/PATH belong to root; every value must be resolved against the
  // invoking user or the service would point at /var/root and root's secure_path.
  assert.match(launchd, /SUDO_USER/);
  assert.match(launchd, /dscl \. -read "\/Users\/\$RUN_USER" NFSHomeDirectory/);

  // The runtime-root singleton lock means agent + daemon can never both run: the loser exits
  // EALREADYRUNNING and KeepAlive turns that into a crash loop. Installing one removes/refuses
  // the other, in both directions.
  assert.match(launchd, /Removing the login-time LaunchAgent/);
  assert.match(launchd, /would crash-loop/);

  assert.match(uninstall, /--boot/);
  assert.match(uninstall, /launchctl bootout "system\/\$label"/);
});
