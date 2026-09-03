#!/usr/bin/env bash
# Stop and remove the ChannelGate systemd service — the inverse of install-systemd.sh.
#
#   (default)  removes every unit that exists: the system unit (/etc/systemd/system, needs root)
#              and the invoking user's unit (~/.config/systemd/user)
#   --system   only the system unit  — sudo bash scripts/uninstall-systemd.sh --system
#   --user     only the user unit
#
# The service account and its runtime root (/var/lib/channelgate: database, config, channel
# folders) are deliberately left in place — removing a unit must never destroy operational state.
set -euo pipefail
[ "$(uname -s)" = "Linux" ] || { echo "systemd packaging is Linux-only"; exit 2; }
command -v systemctl >/dev/null || { echo "systemctl not found"; exit 1; }
UNIT_NAME="channelgate.service"
# Pre-rename unit — removed alongside the current one so an upgraded machine cannot keep a second
# service pointing at the same checkout.
LEGACY_UNIT_NAME="claude-gateway.service"

WANT_SYSTEM=1
WANT_USER=1
for arg in "$@"; do
  case "$arg" in
    --system) WANT_SYSTEM=1; WANT_USER=0 ;;
    --user)   WANT_SYSTEM=0; WANT_USER=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg (expected --system or --user)" >&2; exit 2 ;;
  esac
done

removed=0

if [ "$WANT_SYSTEM" = "1" ]; then
  SYSTEM_DIR="${CG_SYSTEMD_SYSTEM_DIR:-/etc/systemd/system}"
  found_system=0
  for unit in "$UNIT_NAME" "$LEGACY_UNIT_NAME"; do
    [ -f "$SYSTEM_DIR/$unit" ] || continue
    found_system=1
    [ "$(id -u)" -eq 0 ] || { echo "❌ Removing the system unit needs root: sudo bash scripts/uninstall-systemd.sh --system"; exit 1; }
    systemctl disable --now "$unit" 2>/dev/null || true
    rm -f "$SYSTEM_DIR/$unit"
    echo "✅ Removed system unit $unit"
    removed=1
  done
  if [ "$found_system" = "1" ]; then
    systemctl daemon-reload
    systemctl reset-failed "$UNIT_NAME" "$LEGACY_UNIT_NAME" 2>/dev/null || true
  else
    echo "System unit not installed ($SYSTEM_DIR/$UNIT_NAME not found)"
  fi
fi

if [ "$WANT_USER" = "1" ]; then
  # Under sudo, target the invoking user's unit rather than root's.
  UNIT_USER="${SUDO_USER:-$(id -un)}"
  UNIT_HOME="$(getent passwd "$UNIT_USER" 2>/dev/null | cut -d: -f6)"
  [ -n "$UNIT_HOME" ] || UNIT_HOME="$HOME"
  USER_DIR="${CG_SYSTEMD_USER_DIR:-$UNIT_HOME/.config/systemd/user}"
  user_systemctl() {
    if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
      sudo -u "$UNIT_USER" XDG_RUNTIME_DIR="/run/user/$(id -u "$UNIT_USER")" systemctl --user "$@"
    else
      systemctl --user "$@"
    fi
  }
  found_user=0
  for unit in "$UNIT_NAME" "$LEGACY_UNIT_NAME"; do
    [ -f "$USER_DIR/$unit" ] || continue
    found_user=1
    user_systemctl disable --now "$unit" 2>/dev/null || true
    rm -f "$USER_DIR/$unit"
    echo "✅ Removed user unit $unit"
    removed=1
  done
  if [ "$found_user" = "1" ]; then
    user_systemctl daemon-reload 2>/dev/null || true
    user_systemctl reset-failed "$UNIT_NAME" "$LEGACY_UNIT_NAME" 2>/dev/null || true
  else
    echo "User unit not installed ($USER_DIR/$UNIT_NAME not found)"
  fi
fi

[ "$removed" = "1" ] || true
