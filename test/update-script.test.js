import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const update = readFileSync(new URL("../scripts/update.sh", import.meta.url), "utf8");
const provision = readFileSync(new URL("../scripts/update-provision.sh", import.meta.url), "utf8");
const runner = readFileSync(new URL("../scripts/update-runner.mjs", import.meta.url), "utf8");

test("update shell is a strict compatibility wrapper around the Node transaction runner", () => {
  assert.match(update, /set -euo pipefail/);
  assert.match(update, /exec node "\$APP_DIR\/scripts\/update-runner\.mjs" "\$@"/);
  assert.doesNotMatch(update, /git pull|npm ci|launchctl|systemctl/);
});

test("runner retains targeted systemd and launchd service support", () => {
  assert.match(runner, /systemctl/);
  assert.match(runner, /MainPID/);
  assert.match(runner, /SIGUSR2/);
  assert.match(runner, /launchctl/);
  assert.match(runner, /kickstart/);
});

test("runner preflight enforces the real runtime floor and gates candidates on the full check set", () => {
  // package.json engines.node / src/start.js require >= 22.13 (node:sqlite is stable there); a
  // preflight that only refused < 20 would happily update a deployment onto a runtime the daemon
  // then refuses to boot on.
  assert.match(runner, /nodeMajor < 22 \|\| \(nodeMajor === 22 && nodeMinor < 13\)/);
  assert.match(runner, /Node\.js >=22\.13 is required/);
  assert.doesNotMatch(runner, /nodeMajor < 20/);
  // A candidate is only accepted after the same verification set CI runs, not `npm test` alone.
  assert.match(runner, /"run", "check:static"/);
  assert.match(runner, /runCommand\("npm", \["test"\]/);
});

test("optional provisioning retains Whisper, workspace migration, and gated rclone behavior", () => {
  assert.match(provision, /install-whisper\.mjs/);
  assert.match(provision, /migrate-workspace\.mjs/);
  assert.match(provision, /driveSyncEnabled/);
  assert.match(provision, /install_rclone/);
});
