#!/usr/bin/env bash
# Keep channel containers alive across gateway restarts on an EXISTING system-service install.
#
#   sudo bash scripts/repair-service-unit.sh
#
# Units written before this fix say KillMode=mixed. The channel containers share the unit's control
# group (rootless Podman with cgroupfs), so systemd SIGKILLed every one of them — and the conmon
# that would have recorded the exit — on each stop, restart and update, while Podman went on
# listing them as running. This sets KillMode=process in the installed unit and reloads systemd.
# Nothing is restarted and nothing else in the unit changes: the new value applies from the next
# stop. Safe to run again; a fresh `install-systemd.sh` already writes the same line.
set -euo pipefail
[ "$(uname -s)" = "Linux" ] || { echo "systemd packaging is Linux-only"; exit 2; }
command -v systemctl >/dev/null || { echo "systemctl not found"; exit 1; }
[ "$#" -eq 0 ] || { echo "Usage: sudo bash scripts/repair-service-unit.sh"; exit 2; }
SYSTEM_DIR="${CG_SYSTEMD_SYSTEM_DIR:-/etc/systemd/system}"

found=0
changed=0
for unit in channelgate.service claude-gateway.service; do
  file="$SYSTEM_DIR/$unit"
  [ -f "$file" ] || continue
  found=1
  if grep -q '^KillMode=' "$file" && ! grep '^KillMode=' "$file" | grep -qvx 'KillMode=process'; then
    echo "✅ $unit already keeps its containers across a restart (KillMode=process)"
  else
    [ -w "$file" ] && [ -w "$SYSTEM_DIR" ] || { echo "❌ Changing $file needs root: sudo bash scripts/repair-service-unit.sh"; exit 1; }
    grep -q '^\[Service\]$' "$file" || { echo "❌ $file has no [Service] section — not a unit this script can repair"; exit 1; }
    tmp="$(mktemp "$SYSTEM_DIR/.$unit.XXXXXX")"
    # Drop every existing KillMode line and write the one value directly under [Service].
    awk '/^KillMode=/ { next } { print } /^\[Service\]$/ { print "KillMode=process" }' "$file" > "$tmp"
    chmod --reference="$file" "$tmp"
    chown --reference="$file" "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$file"
    changed=1
    echo "✅ $unit: KillMode=process written to $file"
  fi
done
if [ "$found" -eq 0 ]; then
  echo "No system unit found in $SYSTEM_DIR — nothing to repair."
  echo "A user unit (~/.config/systemd/user) is repaired by hand: set KillMode=process under [Service], then systemctl --user daemon-reload."
  exit 1
fi
if [ "$changed" -eq 1 ]; then systemctl daemon-reload; fi
# A drop-in can still override the unit file; systemd's own answer is the one that counts.
for unit in channelgate.service claude-gateway.service; do
  [ -f "$SYSTEM_DIR/$unit" ] || continue
  effective="$(systemctl show --property=KillMode --value "$unit" 2>/dev/null || true)"
  if [ -n "$effective" ] && [ "$effective" != "process" ]; then
    echo "❌ systemd still reports KillMode=$effective for $unit — a drop-in under $SYSTEM_DIR/$unit.d overrides the unit file. Remove that line and run this again."
    exit 1
  fi
done
echo "No restart is needed: from the next stop or restart on, channel containers and the work inside them keep running."
echo "A stopped service therefore leaves its containers up until the gateway starts again; scripts/uninstall-systemd.sh stops them."
