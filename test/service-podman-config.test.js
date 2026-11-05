import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers.js";
import { configureServicePodman } from "../scripts/configure-service-podman.mjs";

test("service Podman config is private, idempotent, and preserves operator settings", () => {
  const home = tempDir("cg-service-podman-");
  mkdirSync(path.join(home, ".config/containers"), { recursive: true });
  const original = path.join(home, ".config/containers/containers.conf");
  writeFileSync(original, '[engine]\nevents_logger="file"\n');
  const configured = configureServicePodman(home);
  assert.match(readFileSync(configured.configFile, "utf8"), /cgroup_manager = "cgroupfs"/);
  assert.equal(lstatSync(configured.configFile).mode & 0o777, 0o600);
  for (const folder of [configured.tempDir, configured.varTmpDir]) {
    assert.equal(lstatSync(folder).mode & 0o777, 0o700);
    writeFileSync(path.join(folder, "retained"), "persistent across installer runs");
    chmodSync(folder, 0o755);
  }
  assert.deepEqual(configureServicePodman(home), configured);
  assert.equal(readFileSync(original, "utf8"), '[engine]\nevents_logger="file"\n');
  for (const folder of [configured.tempDir, configured.varTmpDir]) {
    assert.equal(readFileSync(path.join(folder, "retained"), "utf8"), "persistent across installer runs");
    assert.equal(lstatSync(folder).mode & 0o777, 0o700);
  }
});

test("service provisioning refuses symlinked folders and managed-file collisions", () => {
  const home = tempDir("cg-service-links-");
  const outside = tempDir("cg-service-outside-");
  symlinkSync(outside, path.join(home, ".config"));
  assert.throws(() => configureServicePodman(home), /symlink/);
  const normal = tempDir("cg-service-unmanaged-");
  const folder = path.join(normal, ".config/containers/containers.conf.d");
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "99-channelgate-system-service.conf");
  writeFileSync(file, "operator-owned contents");
  assert.throws(() => configureServicePodman(normal), /unmanaged/);
  assert.equal(readFileSync(file, "utf8"), "operator-owned contents");
});

test("system unit preserves temporary backing and does not migrate live containers on startup", () => {
  const unit = readFileSync(new URL("../scripts/install-systemd.sh", import.meta.url), "utf8");
  assert.match(unit, /START_SERVICE=0/);
  assert.match(unit, /if \[ "\$START_SERVICE" -eq 1 \]; then systemctl start/);
  assert.match(unit, /^Delegate=yes$/m);
  assert.match(unit, /^PrivateTmp=false$/m);
  assert.match(unit, /^BindPaths=\$SERVICE_HOME\/service-tmp:\/tmp \$SERVICE_HOME\/service-var-tmp:\/var\/tmp$/m);
  assert.match(unit, /^ReadWritePaths=.* \/tmp \/var\/tmp$/m);
  assert.match(unit, /run_as_service "\$NODE_BIN" "\$APP_DIR\/scripts\/configure-service-podman.mjs"/);
  assert.ok(unit.indexOf('scripts/configure-service-podman.mjs') < unit.indexOf("run_as_service podman info"));
  assert.doesNotMatch(unit, /ExecStartPre=.*podman.*migrate|podman (?:system reset|system prune|volume prune)/);
});
