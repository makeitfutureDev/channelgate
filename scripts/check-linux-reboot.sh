#!/usr/bin/env bash
# Real OS reboot acceptance in a disposable nested Ubuntu guest; NEVER reboot the runner.
# Guest setup follows the official Ubuntu/cloud-init QEMU guidance:
# https://documentation.ubuntu.com/public-images/public-images-how-to/launch-qcow-with-qemu/
# https://docs.cloud-init.io/en/24.3/tutorial/qemu.html
# Requires KVM. Nested virtualization on GitHub-hosted runners is experimental; unavailable
# acceleration is an explicit failure, never a skipped/passing acceptance or a slow TCG fallback.
set -euo pipefail
if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ] ||
   [ "$(cat /proc/1/comm)" != systemd ]; then
  echo 'Refusing: requires a disposable GitHub-hosted VM with PID-1 systemd.' >&2
  exit 2
fi
: "${RUNNER_TEMP:?}" "${GITHUB_REPOSITORY:?}"
[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 2
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REVISION="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || exit 2
EVIDENCE="$RUNNER_TEMP/reboot-evidence"
FIXTURE="$RUNNER_TEMP/channelgate-reboot-guest"
[ ! -e "$FIXTURE" ] || { echo 'Refusing occupied reboot fixture.' >&2; exit 2; }
umask 077
mkdir "$FIXTURE"
mkdir -p "$EVIDENCE"
exec > >(tee "$EVIDENCE/reboot.log") 2>&1
QEMU_PID=''
cleanup() {
  outcome=$?
  trap - EXIT
  if [ -n "$QEMU_PID" ]; then
    kill "$QEMU_PID" 2>/dev/null || true
    wait "$QEMU_PID" 2>/dev/null || true
  fi
  # No disks, cloud-init data, private keys, runtime files or raw guest logs are retained.
  rm -rf -- "$FIXTURE"
  printf 'exit_code=%s\n' "$outcome"
  exit "$outcome"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'revision=%s\nrunner=%s %s\n' "$REVISION" "${ImageOS:-unknown}" "${ImageVersion:-unknown}"
if [ ! -c /dev/kvm ]; then
  echo 'UNAVAILABLE: /dev/kvm is absent; actual guest reboot acceptance was NOT RUN.'
  exit 1
fi
sudo apt-get update -qq > "$FIXTURE/host-apt.log" 2>&1
sudo apt-get install -y -qq qemu-system-x86 qemu-utils cloud-image-utils acl >> "$FIXTURE/host-apt.log" 2>&1
sudo setfacl -m "u:$(id -u):rw" /dev/kvm
[ -r /dev/kvm ] && [ -w /dev/kvm ] || {
  echo 'UNAVAILABLE: KVM is inaccessible; actual guest reboot acceptance was NOT RUN.'; exit 1;
}
# Sparse backing disk still needs real space for the full production toolchain build.
[ "$(df -Pk "$FIXTURE" | awk 'NR==2 {print $4}')" -ge 25165824 ] || {
  echo 'UNAVAILABLE: fewer than 24 GiB free for the production-image guest fixture.'; exit 1;
}
echo 'CHECK downloading official Ubuntu Noble cloud image and checksum manifest'
IMAGE=noble-server-cloudimg-amd64.img
IMAGE_BASE=https://cloud-images.ubuntu.com/noble/current
curl --fail --silent --show-error --location --retry 3 "$IMAGE_BASE/SHA256SUMS" -o "$FIXTURE/SHA256SUMS"
curl --fail --silent --show-error --location --retry 3 "$IMAGE_BASE/$IMAGE" -o "$FIXTURE/$IMAGE"
(
  cd "$FIXTURE"
  awk -v image="$IMAGE" '$2 == image || $2 == "*" image { print }' SHA256SUMS > image.sha256
  [ "$(wc -l < image.sha256)" -eq 1 ]
  sha256sum --check image.sha256
)
printf 'image_sha256=%s\n' "$(awk '{print $1}' "$FIXTURE/image.sha256")"
qemu-img create -q -f qcow2 -F qcow2 -b "$FIXTURE/$IMAGE" "$FIXTURE/guest.qcow2" 48G
ssh-keygen -q -t ed25519 -N '' -C disposable-reboot-fixture -f "$FIXTURE/ssh-key"
cat > "$FIXTURE/user-data" <<CLOUD
#cloud-config
users:
  - name: reboot-check
    groups: [sudo]
    shell: /bin/bash
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    lock_passwd: true
    ssh_authorized_keys:
      - $(cat "$FIXTURE/ssh-key.pub")
ssh_pwauth: false
disable_root: true
CLOUD
printf 'instance-id: channelgate-reboot-fixture\nlocal-hostname: channelgate-reboot-fixture\n' > "$FIXTURE/meta-data"
cloud-localds "$FIXTURE/seed.img" "$FIXTURE/user-data" "$FIXTURE/meta-data"
# Run as the runner user. The owned child lives only for this script and is reaped by its trap.
qemu-system-x86_64 -enable-kvm -cpu host -smp 2 -m 4096 -display none -monitor none \
  -serial "file:$FIXTURE/serial.log" \
  -drive "file=$FIXTURE/guest.qcow2,format=qcow2,if=virtio" \
  -drive "file=$FIXTURE/seed.img,format=raw,if=virtio" \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22 -device virtio-net-pci,netdev=net0 \
  > "$FIXTURE/qemu.log" 2>&1 &
QEMU_PID=$!
SSH=(ssh -i "$FIXTURE/ssh-key" -p 2222 -o BatchMode=yes -o ConnectTimeout=5
  -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$FIXTURE/known_hosts"
  -o ServerAliveInterval=15 -o ServerAliveCountMax=4 reboot-check@127.0.0.1)
wait_ssh() {
  for attempt in $(seq 1 120); do
    kill -0 "$QEMU_PID" 2>/dev/null || {
      echo 'UNAVAILABLE: KVM guest exited before SSH readiness; reboot acceptance incomplete.'
      tail -n 20 "$FIXTURE/qemu.log"
      return 1;
    }
    if "${SSH[@]}" true >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  echo 'FAIL guest SSH readiness timed out'; return 1
}
wait_ssh
"${SSH[@]}" sudo cloud-init status --wait > "$FIXTURE/cloud-init.log" 2>&1
echo 'PASS disposable KVM Ubuntu guest booted'
# Arguments are restricted to an owner/repo slug and a full SHA before SSH constructs a command.
"${SSH[@]}" sudo bash -s -- "$GITHUB_REPOSITORY" "$REVISION" <<'GUEST'
set -euo pipefail
[ "$(cat /proc/1/comm)" = systemd ]
[ "$(hostname)" = channelgate-reboot-fixture ]
APP_DIR=/opt/channelgate-reboot
SERVICE_USER=cg-reboot
SERVICE_HOME=/var/lib/channelgate-reboot
for occupied in "$APP_DIR" "$SERVICE_HOME" /etc/systemd/system/channelgate.service /etc/systemd/system/claude-gateway.service; do
  [ ! -e "$occupied" ] || { echo 'FAIL occupied guest fixture'; exit 2; }
done
if id "$SERVICE_USER" >/dev/null 2>&1 || id claude-gateway >/dev/null 2>&1; then exit 2; fi
phase=prerequisites
setup_failed() {
  outcome=$?
  printf 'FAIL guest setup phase=%s line=%s\n' "$phase" "$1"
  # Only synthetic public-source installation output, bounded and scrubbed. Never print the
  # daemon journal, environment/config, cloud-init seed, SSH key or runtime database.
  for log in /var/tmp/reboot-prerequisites.log /var/tmp/reboot-install.log; do
    if [ -f "$log" ]; then
      tail -n 60 "$log" | sed -E 's/public-disposable-[A-Za-z0-9-]+/[fixture-password]/g; s/(sk-|xox[baprs]-)[A-Za-z0-9_-]+/[redacted]/g'
    fi
  done
  exit "$outcome"
}
trap 'setup_failed "$LINENO"' ERR
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq > /var/tmp/reboot-prerequisites.log 2>&1
apt-get install -y -qq ca-certificates curl git xz-utils podman uidmap slirp4netns fuse-overlayfs >> /var/tmp/reboot-prerequisites.log 2>&1
phase=node
mkdir /var/tmp/reboot-node
cd /var/tmp/reboot-node
curl -fsSL --retry 3 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o SHASUMS256.txt
awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ {print}' SHASUMS256.txt > node.sha256
[ "$(wc -l < node.sha256)" -eq 1 ]
NODE_ARCHIVE="$(awk '{print $2}' node.sha256)"
curl -fsSL --retry 3 "https://nodejs.org/dist/latest-v24.x/$NODE_ARCHIVE" -o "$NODE_ARCHIVE"
sha256sum --check node.sha256
tar -xJf "$NODE_ARCHIVE" -C /usr/local --strip-components=1
printf 'node_version=%s\nnode_sha256=%s\n' "$(node --version)" "$(awk '{print $1}' node.sha256)"
phase=public-source
git clone --quiet --no-checkout "https://github.com/$1.git" "$APP_DIR"
git -C "$APP_DIR" fetch --quiet origin "$2"
git -C "$APP_DIR" checkout --quiet --detach "$2"
[ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$2" ]
# Public synthetic password avoids first-boot random secrets. No Slack/provider credentials.
cat > "$APP_DIR/.env" <<'ENV'
ADMIN_PASSWORD=public-disposable-reboot-fixture
CG_BIND_HOST=127.0.0.1
PORT=4747
ENV
phase=install-dependencies
echo 'CHECK installing daemon dependencies in guest'
CHANNELGATE_DIR=/var/tmp/reboot-bootstrap bash "$APP_DIR/scripts/install.sh" --without-whisper > /var/tmp/reboot-install.log 2>&1
phase=install-system-service
echo 'CHECK production systemd installer is building the complete rootless image in guest'
CG_SERVICE_USER="$SERVICE_USER" CG_SERVICE_HOME="$SERVICE_HOME" bash "$APP_DIR/scripts/install-systemd.sh" >> /var/tmp/reboot-install.log 2>&1
cat > /var/tmp/reboot-health.mjs <<'NODE'
import assert from 'node:assert/strict';
for (let attempt = 0; attempt < 120; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:4747/api/health', { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.slack.connected, false);
    assert.ok(data.instanceId && data.instanceId !== process.argv[2]);
    console.log(data.instanceId);
    process.exit(0);
  } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
}
throw Error('Fresh healthy daemon instance did not become available');
NODE
cat > /var/tmp/reboot-as-service <<'SERVICE'
#!/usr/bin/env bash
set -euo pipefail
uid="$(id -u cg-reboot)"
cd /var/lib/channelgate-reboot
exec runuser -u cg-reboot -- env -i HOME=/var/lib/channelgate-reboot CHANNELGATE_DIR=/var/lib/channelgate-reboot \
  XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
  PATH=/usr/local/bin:/usr/bin:/bin "$@"
SERVICE
chmod 700 /var/tmp/reboot-as-service
phase=pre-reboot-state
node /var/tmp/reboot-health.mjs > /var/tmp/reboot-first-instance
systemctl is-enabled --quiet channelgate.service
systemctl is-active --quiet channelgate.service
[ "$(systemctl show channelgate.service -p User --value)" = "$SERVICE_USER" ]
/var/tmp/reboot-as-service podman info --format '{{.Host.Security.Rootless}}' | grep -qx true
/var/tmp/reboot-as-service node --input-type=module <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/var/lib/channelgate-reboot/gateway.db');
db.exec("CREATE TABLE reboot_proof(value TEXT); INSERT INTO reboot_proof VALUES ('persisted-through-os-reboot')");
db.close();
NODE
/var/tmp/reboot-as-service podman volume create reboot-proof >/dev/null
/var/tmp/reboot-as-service podman run --rm --userns=keep-id --cap-drop=all --security-opt=no-new-privileges \
  --network=none -v reboot-proof:/proof:U channelgate/runtime:latest node -e \
  'require("node:assert/strict").notEqual(process.getuid(), 0); require("node:fs").writeFileSync("/proof/marker", "persisted-through-os-reboot")'
cat /proc/sys/kernel/random/boot_id > /var/tmp/reboot-first-boot-id
sync
echo 'PASS real service installation, HTTP health, database and rootless volume fixture before reboot'
GUEST
FIRST_BOOT="$("${SSH[@]}" cat /proc/sys/kernel/random/boot_id)"
printf 'guest_boot_before=%s\n' "$FIRST_BOOT"
echo 'CHECK rebooting guest OS; GitHub runner stays alive'
# systemctl schedules a real guest OS reboot. It may close SSH before reporting success.
"${SSH[@]}" sudo systemctl reboot || true
REBOOTED=false
for attempt in $(seq 1 120); do
  kill -0 "$QEMU_PID" 2>/dev/null || { echo 'FAIL guest process exited during reboot'; exit 1; }
  CURRENT_BOOT="$("${SSH[@]}" cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)"
  if [[ "$CURRENT_BOOT" =~ ^[a-f0-9-]{36}$ ]] && [ "$CURRENT_BOOT" != "$FIRST_BOOT" ]; then
    REBOOTED=true; break
  fi
  sleep 3
done
[ "$REBOOTED" = true ] || { echo 'FAIL guest OS boot ID did not change'; exit 1; }
printf 'guest_boot_after=%s\n' "$CURRENT_BOOT"
"${SSH[@]}" sudo bash -s <<'VERIFY'
set -euo pipefail
trap 'printf "FAIL post-reboot verification line=%s\n" "$LINENO"' ERR
[ "$(cat /proc/sys/kernel/random/boot_id)" != "$(cat /var/tmp/reboot-first-boot-id)" ]
# Do not start/restart the service here: HTTP must return after automatic boot startup.
NEW_INSTANCE="$(node /var/tmp/reboot-health.mjs "$(cat /var/tmp/reboot-first-instance)")"
[ "$NEW_INSTANCE" != "$(cat /var/tmp/reboot-first-instance)" ]
systemctl is-enabled --quiet channelgate.service
systemctl is-active --quiet channelgate.service
[ "$(systemctl show channelgate.service -p User --value)" = cg-reboot ]
[ "$(loginctl show-user cg-reboot -p Linger --value)" = yes ]
/var/tmp/reboot-as-service podman info --format '{{.Host.Security.Rootless}}' | grep -qx true
printf 'daemon_instance_before=%s\ndaemon_instance_after=%s\n' "$(cat /var/tmp/reboot-first-instance)" "$NEW_INSTANCE"
echo 'PASS actual OS reboot, enabled active service autostart, new HTTP instance and rootless runtime'
/var/tmp/reboot-as-service podman run --rm --userns=keep-id --cap-drop=all --security-opt=no-new-privileges \
  --network=none -v reboot-proof:/proof channelgate/runtime:latest node -e \
  'const a=require("node:assert/strict"); a.notEqual(process.getuid(),0); a.equal(require("node:fs").readFileSync("/proof/marker","utf8"),"persisted-through-os-reboot")'
cat > /var/tmp/reboot-db-check.mjs <<'NODE'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/var/lib/channelgate-reboot/gateway.db', { readOnly: true });
assert.equal(db.prepare('SELECT value FROM reboot_proof').get().value, 'persisted-through-os-reboot');
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
db.close();
NODE
chmod 644 /var/tmp/reboot-db-check.mjs
/var/tmp/reboot-as-service node /var/tmp/reboot-db-check.mjs
echo 'PASS database integrity and rootless named-volume marker survived guest OS reboot'
bash /opt/channelgate-reboot/scripts/uninstall-systemd.sh --system
[ ! -e /etc/systemd/system/channelgate.service ]
if systemctl is-active --quiet channelgate.service; then echo 'FAIL service still active after uninstall'; exit 1; fi
id cg-reboot >/dev/null
/var/tmp/reboot-as-service node /var/tmp/reboot-db-check.mjs
echo 'PASS actual uninstall stops/removes service and preserves service identity and database marker'
VERIFY
echo 'PASS completed real guest OS reboot acceptance; no authenticated engines or external chat services used'
