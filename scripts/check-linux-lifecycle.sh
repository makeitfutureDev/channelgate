#!/usr/bin/env bash
# Destructive operations acceptance, ONLY on an empty GitHub-hosted Ubuntu VM.
# No provider credentials, chat connections or engine prompts are needed or accepted here.
set -euo pipefail
if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ] ||
   [ "$(cat /proc/1/comm)" != systemd ]; then
  echo "Refusing: this check requires a disposable GitHub-hosted VM with PID-1 systemd." >&2
  exit 2
fi
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE="${1:?Pass the evidence output directory}"
APP_DIR=/opt/channelgate-lifecycle
SERVICE_USER=cg-lifecycle
SERVICE_HOME=/var/lib/channelgate-lifecycle
for occupied in "$APP_DIR" "$SERVICE_HOME" /etc/systemd/system/channelgate.service /etc/systemd/system/claude-gateway.service; do
  [ ! -e "$occupied" ] || { echo "Refusing occupied lifecycle fixture: $occupied" >&2; exit 2; }
done
if id "$SERVICE_USER" >/dev/null 2>&1 || id claude-gateway >/dev/null 2>&1; then
  echo "Refusing existing lifecycle or legacy service account" >&2; exit 2
fi
mkdir -p "$EVIDENCE"
exec > >(tee "$EVIDENCE/lifecycle.log") 2>&1
printf 'revision=%s\n' "$(git -C "$SOURCE_DIR" rev-parse HEAD)"
printf 'runner=%s\n' "${ImageOS:-unknown} ${ImageVersion:-unknown}"
uname -sr
node --version
podman --version
systemctl --version | head -1
df -h /opt /var/lib

cleanup() {
  outcome=$?
  trap - EXIT
  if [ -f /etc/systemd/system/channelgate.service ]; then
    sudo bash "$APP_DIR/scripts/uninstall-systemd.sh" --system || true
  fi
  printf 'exit_code=%s\n' "$outcome"
  exit "$outcome"
}
trap cleanup EXIT
pass() { printf 'PASS %s\n' "$1"; }
as_service() {
  sudo runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" CHANNELGATE_DIR="$SERVICE_HOME" \
    CHANNELGATE_DB="" CLAUDE_GATEWAY_DIR="" CLAUDE_GATEWAY_DB="" \
    XDG_RUNTIME_DIR="/run/user/$(id -u "$SERVICE_USER")" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$SERVICE_USER")/bus" \
    PATH="$PATH" "$@"
}
health() {
  node --input-type=module - "$1" <<'NODE'
import assert from 'node:assert/strict';
const previous = process.argv[2];
for (let attempt = 0; attempt < 90; attempt += 1) {
  try {
    const response = await fetch('http://127.0.0.1:4747/api/health', { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.ok(data.instanceId && data.instanceId !== previous);
    assert.equal(data.slack.connected, false);
    console.log(data.instanceId);
    process.exit(0);
  } catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
}
throw new Error('Fresh healthy daemon instance did not become available');
NODE
}

# Clone public source only; never copy the caller's home, credentials or runtime state.
sudo git clone --no-checkout "https://github.com/${GITHUB_REPOSITORY:?}.git" "$APP_DIR"
sudo git -C "$APP_DIR" fetch origin "$(git -C "$SOURCE_DIR" rev-parse HEAD)"
sudo git -C "$APP_DIR" checkout --detach "$(git -C "$SOURCE_DIR" rev-parse HEAD)"
BOOTSTRAP_ROOT="$(mktemp -d)"
sudo env PATH="$PATH" CHANNELGATE_DIR="$BOOTSTRAP_ROOT" CHANNELGATE_DB="" CLAUDE_GATEWAY_DIR="" CLAUDE_GATEWAY_DB="" \
  bash "$APP_DIR/scripts/install.sh" --without-whisper
# Public, disposable fixture password prevents a generated bootstrap secret reaching CI logs.
# The daemon listens only on loopback; no provider/chat tokens are configured.
sudo tee "$APP_DIR/.env" >/dev/null <<'ENV'
ADMIN_PASSWORD=public-disposable-lifecycle-fixture
CG_BIND_HOST=127.0.0.1
PORT=4747
ENV
sudo env PATH="$PATH" CG_SERVICE_USER="$SERVICE_USER" CG_SERVICE_HOME="$SERVICE_HOME" \
  bash "$APP_DIR/scripts/install-systemd.sh"
FIRST_INSTANCE="$(health '')"
systemctl is-enabled channelgate.service
systemctl is-active channelgate.service
[ "$(systemctl show channelgate.service -p User --value)" = "$SERVICE_USER" ]
[ "$(systemctl show channelgate.service -p Delegate --value)" = yes ]
[ "$(sudo stat -c %a "$SERVICE_HOME/service.env")" = 600 ]
as_service podman info --format '{{.Host.Security.Rootless}}' | grep -qx true
pass 'fresh systemd installation, dedicated identity, enablement and HTTP liveness'
as_service podman run --rm --userns=keep-id --cap-drop=all --security-opt=no-new-privileges \
  --network=bridge channelgate/runtime:latest node --input-type=module -e \
  'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; assert.notEqual(process.getuid(),0); const s=readFileSync("/proc/self/status","utf8"); assert.match(s,/CapEff:\s+0+\n/); assert.match(s,/NoNewPrivs:\s+1\n/); console.log("container uid="+process.getuid()+" zero capabilities, no-new-privileges");'
pass 'production image runs with rootless identity and dropped capabilities (no engine prompt)'
sudo systemctl restart channelgate.service
SECOND_INSTANCE="$(health "$FIRST_INSTANCE")"
pass 'real systemd restart produces a new healthy daemon instance'

# Use the freshly installed disposable daemon database, never an operator deployment.
sudo systemctl stop channelgate.service
as_service node --input-type=module - "$SERVICE_HOME" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
const root = process.argv[2];
const db = new DatabaseSync(`${root}/gateway.db`);
db.exec("CREATE TABLE lifecycle_proof(value TEXT); INSERT INTO lifecycle_proof VALUES ('before-backup')");
db.close();
writeFileSync(`${root}/config/lifecycle-proof.json`, '{"value":"before-backup"}\n');
NODE
sudo systemctl start channelgate.service
THIRD_INSTANCE="$(health "$SECOND_INSTANCE")"
as_service env CG_BACKUP_PASSPHRASE=public-disposable-backup-fixture bash "$APP_DIR/scripts/backup-config.sh"
as_service env CG_BACKUP_PASSPHRASE=public-disposable-backup-fixture bash "$APP_DIR/scripts/restore-drill.sh"
sudo systemctl stop channelgate.service
as_service node --input-type=module - "$SERVICE_HOME" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
const root = process.argv[2];
const db = new DatabaseSync(`${root}/gateway.db`);
db.exec("UPDATE lifecycle_proof SET value='after-backup'");
db.close();
writeFileSync(`${root}/config/stray-lifecycle.json`, '{}');
writeFileSync(`${root}/gateway.db-wal`, 'stale-wal');
writeFileSync(`${root}/gateway.db-shm`, 'stale-shm');
NODE
as_service env CG_BACKUP_PASSPHRASE=public-disposable-backup-fixture CG_RESTORE_CONFIRM=YES \
  bash "$APP_DIR/scripts/restore-config.sh"
as_service node --input-type=module - "$SERVICE_HOME" <<'NODE'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
const root = process.argv[2];
assert.equal(existsSync(`${root}/gateway.db-wal`), false);
assert.equal(existsSync(`${root}/gateway.db-shm`), false);
assert.equal(existsSync(`${root}/config/stray-lifecycle.json`), false);
assert.equal(JSON.parse(readFileSync(`${root}/config/lifecycle-proof.json`)).value, 'before-backup');
const db = new DatabaseSync(`${root}/gateway.db`, { readOnly: true });
assert.equal(db.prepare('SELECT value FROM lifecycle_proof').get().value, 'before-backup');
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
db.close();
NODE
sudo systemctl start channelgate.service
health "$THIRD_INSTANCE"
pass 'live encrypted fixture snapshot, disposable drill, replacement restore and healthy restart'

# Existing injected transaction tests are separately labelled: these do not claim a real update
# across authenticated engine versions or an induced failure in a production deployment.
as_service env -u CHANNELGATE_DIR -u CHANNELGATE_DB -u CLAUDE_GATEWAY_DIR -u CLAUDE_GATEWAY_DB \
  -u CG_WORKSPACE_DIR -u CG_TEST_SCRATCH \
  bash -c 'cd "$1" && node --test test/update-runner.test.js test/update-state.test.js test/update-smoke.test.js' bash "$APP_DIR" \
  > "$EVIDENCE/update-fixture-tests.tap" 2>&1
pass 'injected update failure/rollback and container smoke regression tests'
sudo bash "$APP_DIR/scripts/uninstall-systemd.sh" --system
[ ! -e /etc/systemd/system/channelgate.service ]
if systemctl is-active --quiet channelgate.service; then echo 'Service remained active after uninstall'; exit 1; fi
id "$SERVICE_USER" >/dev/null
as_service test -s "$SERVICE_HOME/gateway.db"
as_service test -s "$SERVICE_HOME/backups/config.tar.gz.enc"
pass 'uninstall removes and stops system unit while preserving account, database and backup'
printf '%s\n' \
  'NOT RUN: actual host reboot and post-reboot recovery (hosted job does not survive reboot).' \
  'NOT RUN: authenticated Claude/Codex update, induced live candidate failure and automatic rollback.' \
  'NOT RUN: Slack/Airtable/Composio or other external acceptance campaigns.'
