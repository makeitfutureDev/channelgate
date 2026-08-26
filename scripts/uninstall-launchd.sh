#!/usr/bin/env bash
# Stop and remove the ChannelGate launchd service.
#
#   (default)  removes the LaunchAgent  (~/Library/LaunchAgents)
#   --boot     removes the LaunchDaemon (/Library/LaunchDaemons) — needs sudo
#   --all      removes both
set -euo pipefail
LABEL="com.makeitfuture.channelgate"
# Pre-rename label — removed alongside the current one so an upgraded machine cannot keep a second
# job pointing at the same checkout.
LEGACY_LABEL="com.makeitfuture.claude-gateway"

WANT_AGENT=1
WANT_DAEMON=0
for arg in "$@"; do
  case "$arg" in
    --boot) WANT_AGENT=0; WANT_DAEMON=1 ;;
    --all)  WANT_AGENT=1; WANT_DAEMON=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg (expected --boot or --all)" >&2; exit 2 ;;
  esac
done

removed=0

if [ "$WANT_DAEMON" = "1" ]; then
  found_daemon=0
  for label in "$LABEL" "$LEGACY_LABEL"; do
    DAEMON_PLIST="${CG_LAUNCHD_DAEMON_DIR:-/Library/LaunchDaemons}/$label.plist"
    [ -f "$DAEMON_PLIST" ] || continue
    found_daemon=1
    [ "$(id -u)" -eq 0 ] || { echo "❌ Removing the LaunchDaemon needs root: sudo bash scripts/uninstall-launchd.sh --boot"; exit 1; }
    launchctl bootout "system/$label" 2>/dev/null || true
    rm -f "$DAEMON_PLIST"
    echo "✅ Removed LaunchDaemon $label"
    removed=1
  done
  [ "$found_daemon" = "1" ] || echo "LaunchDaemon not installed (${CG_LAUNCHD_DAEMON_DIR:-/Library/LaunchDaemons}/$LABEL.plist not found)"
fi

if [ "$WANT_AGENT" = "1" ]; then
  # Under sudo, target the invoking user's home rather than root's.
  AGENT_USER="${SUDO_USER:-$(id -un)}"
  AGENT_HOME="$(dscl . -read "/Users/$AGENT_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  [ -n "$AGENT_HOME" ] || AGENT_HOME="$HOME"
  found_agent=0
  for label in "$LABEL" "$LEGACY_LABEL"; do
    AGENT_PLIST="$AGENT_HOME/Library/LaunchAgents/$label.plist"
    [ -f "$AGENT_PLIST" ] || continue
    found_agent=1
    if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
      sudo -u "$AGENT_USER" launchctl bootout "gui/$(id -u "$AGENT_USER")/$label" 2>/dev/null || true
      sudo -u "$AGENT_USER" launchctl unload "$AGENT_PLIST" 2>/dev/null || true
    else
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      launchctl unload "$AGENT_PLIST" 2>/dev/null || true
    fi
    rm -f "$AGENT_PLIST"
    echo "✅ Removed LaunchAgent $label"
    removed=1
  done
  [ "$found_agent" = "1" ] || echo "LaunchAgent not installed ($AGENT_HOME/Library/LaunchAgents/$LABEL.plist not found)"
fi

[ "$removed" = "1" ] || true
