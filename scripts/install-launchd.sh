#!/usr/bin/env bash
# Install ChannelGate as a macOS launchd service. Idempotent — re-run to update after
# moving the repo or upgrading node.
#
#   (default)  LaunchAgent  in ~/Library/LaunchAgents  — starts at GUI LOGIN, runs as you.
#   --boot     LaunchDaemon in /Library/LaunchDaemons  — starts at BOOT, no login required.
#
# Boot mode exists because a LaunchAgent's domain only comes into being when its user logs in
# graphically: after an unattended restart the Mac sits at the login window and the gateway never
# starts. A LaunchDaemon loads in the system domain at boot instead. It still runs AS the invoking
# user (UserName), because the engine credentials, work folders and runtime root all live in that
# user's home.
#
# Boot mode's two known ceilings (see docs/OPERATIONS.md):
#   · FileVault — a cold unattended reboot halts at the preboot unlock screen, where nothing runs
#     at all. Boot mode covers "disk unlocked, nobody logged in", not "nobody touched the Mac".
#   · No GUI session — the login keychain stays LOCKED. The engine CLIs read
#     ~/.claude/.credentials.json so they are fine, but anything sourcing a secret from Keychain,
#     and any GUI/browser automation, will not work.
set -euo pipefail

LABEL="com.makeitfuture.channelgate"
# The pre-rename label. An upgrade must tear the old job down before installing the new one, or
# two daemons fight over the runtime root's singleton lock and KeepAlive turns that into a crash
# loop. Kept for one major; harmless on a fresh machine (nothing to remove).
LEGACY_LABEL="com.makeitfuture.claude-gateway"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

BOOT_MODE=0
for arg in "$@"; do
  case "$arg" in
    --boot) BOOT_MODE=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg (expected --boot)" >&2; exit 2 ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || { echo "launchd packaging is macOS-only (Linux: scripts/install-systemd.sh)"; exit 2; }

# ── Identify the user the gateway runs as ────────────────────────────────────────────────────
# Boot mode is invoked with sudo, so $HOME/$USER/PATH belong to root at this point — every value
# below must be resolved against the INVOKING user instead, or the service would be pointed at
# /var/root and root's PATH.
if [ "$BOOT_MODE" = "1" ]; then
  [ "$(id -u)" -eq 0 ] || { echo "❌ Boot mode writes to /Library/LaunchDaemons — run: sudo bash scripts/install-launchd.sh --boot"; exit 1; }
  RUN_USER="${SUDO_USER:-}"
  if [ -z "$RUN_USER" ] || [ "$RUN_USER" = "root" ]; then
    echo "❌ Run this with sudo from your normal account (found SUDO_USER='${SUDO_USER:-}')."
    echo "   The gateway must run as the user that owns the engine credentials, never as root."
    exit 1
  fi
  RUN_HOME="$(dscl . -read "/Users/$RUN_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  [ -n "$RUN_HOME" ] && [ -d "$RUN_HOME" ] || { echo "❌ Could not resolve home directory for $RUN_USER"; exit 1; }
  # Resolve the toolchain in the user's own login shell, not root's secure_path.
  as_user() { sudo -u "$RUN_USER" -H "$@"; }
  user_which() { as_user "${SHELL_BIN:-/bin/zsh}" -lc "command -v $1" 2>/dev/null || true; }
else
  RUN_USER="$(id -un)"
  RUN_HOME="$HOME"
  as_user() { "$@"; }
  user_which() { command -v "$1" 2>/dev/null || true; }
fi

NODE_BIN="${CG_NODE_BIN:-$(user_which node)}"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { echo "❌ node not found for user $RUN_USER (override with CG_NODE_BIN=/path/to/node)"; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"
CLAUDE_BIN="${CG_CLAUDE_BIN:-$(user_which claude)}"

GW_HOME="${CHANNELGATE_DIR:-${CLAUDE_GATEWAY_DIR:-$RUN_HOME/.channelgate}}"
LOG_DIR="$GW_HOME/logs"

# Escape a value for interpolation into plist XML (& first, then angle brackets) — paths like
# "~/Dev & Tools" or an npm prefix containing "<" must not corrupt or reshape the document.
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# launchd jobs get a minimal PATH — build one that resolves node plus EVERY supported engine CLI
# (claude/codex/opencode, mirroring install-systemd.sh), deduplicated, existing dirs only. Never
# append an unset/empty segment: an empty PATH component means "current directory", which would
# make every subprocess spawn consult the CWD first.
AGENT_PATH="$NODE_DIR"
add_path_dir() {
  [ -n "${1:-}" ] && [ -d "$1" ] || return 0
  case ":$AGENT_PATH:" in *":$1:"*) ;; *) AGENT_PATH="$AGENT_PATH:$1";; esac
}
for engine in claude codex opencode; do
  bin="$(user_which "$engine")"
  if [ -z "$bin" ]; then
    echo "⚠️  $engine CLI not found for $RUN_USER — the service can start, but $engine runs will fail until it is installed."
    continue
  fi
  add_path_dir "$(dirname "$bin")"
done
for dir in /opt/homebrew/bin /usr/local/bin /usr/bin /bin "$RUN_HOME/.local/bin" "$RUN_HOME/.npm-global/bin"; do
  add_path_dir "$dir"
done

as_user mkdir -p "$LOG_DIR"
as_user chmod 700 "$GW_HOME" "$LOG_DIR" 2>/dev/null || true

AGENT_PLIST="$RUN_HOME/Library/LaunchAgents/$LABEL.plist"
# Overridable so the install path can be exercised against a scratch tree in tests.
DAEMON_PLIST="${CG_LAUNCHD_DAEMON_DIR:-/Library/LaunchDaemons}/$LABEL.plist"
LEGACY_AGENT_PLIST="$RUN_HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
LEGACY_DAEMON_PLIST="${CG_LAUNCHD_DAEMON_DIR:-/Library/LaunchDaemons}/$LEGACY_LABEL.plist"

# ── Retire the pre-rename job FIRST ──────────────────────────────────────────────────────────
# Both labels point at the same checkout and the same runtime root, so leaving the old one loaded
# means two daemons racing for the singleton lock. Unload + remove whichever old plist exists.
if [ -f "$LEGACY_DAEMON_PLIST" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    echo "→ Removing the pre-rename LaunchDaemon $LEGACY_LABEL"
    launchctl bootout "system/$LEGACY_LABEL" 2>/dev/null || true
    rm -f "$LEGACY_DAEMON_PLIST"
  else
    echo "❌ The pre-rename LaunchDaemon $LEGACY_LABEL is installed and needs root to remove."
    echo "   Run: sudo bash scripts/uninstall-launchd.sh --boot"
    exit 1
  fi
fi
if [ -f "$LEGACY_AGENT_PLIST" ]; then
  echo "→ Removing the pre-rename LaunchAgent $LEGACY_LABEL"
  as_user launchctl bootout "gui/$(id -u "$RUN_USER")/$LEGACY_LABEL" 2>/dev/null || true
  as_user launchctl unload "$LEGACY_AGENT_PLIST" 2>/dev/null || true
  rm -f "$LEGACY_AGENT_PLIST"
fi

# The daemon takes a singleton lock on the runtime root, so an agent and a daemon can never both
# run — the loser throws EALREADYRUNNING and KeepAlive turns that into a crash loop. Installing
# one mode therefore removes the other.
if [ "$BOOT_MODE" = "1" ]; then
  PLIST="$DAEMON_PLIST"
  if [ -f "$AGENT_PLIST" ]; then
    echo "→ Removing the login-time LaunchAgent (it would fight the daemon for the singleton lock)"
    as_user launchctl bootout "gui/$(id -u "$RUN_USER")/$LABEL" 2>/dev/null || true
    as_user launchctl unload "$AGENT_PLIST" 2>/dev/null || true
    rm -f "$AGENT_PLIST"
  fi
else
  PLIST="$AGENT_PLIST"
  if [ -f "$DAEMON_PLIST" ]; then
    echo "❌ The boot-time LaunchDaemon is installed; installing the agent too would crash-loop."
    echo "   Remove it first: sudo bash scripts/uninstall-launchd.sh --boot"
    exit 1
  fi
  mkdir -p "$RUN_HOME/Library/LaunchAgents"
fi

# UserName/GroupName drop the daemon from root to the owning user. HOME must be set explicitly:
# system-domain jobs inherit no HOME, and every runtime path is derived from it.
BOOT_KEYS=""
if [ "$BOOT_MODE" = "1" ]; then
  BOOT_KEYS="  <key>UserName</key><string>$(xml_escape "$RUN_USER")</string>
  <key>GroupName</key><string>staff</string>
  <key>InitGroups</key><true/>"
fi

NODE_BIN_XML="$(xml_escape "$NODE_BIN")"
APP_DIR_XML="$(xml_escape "$APP_DIR")"
LOG_DIR_XML="$(xml_escape "$LOG_DIR")"
AGENT_PATH_XML="$(xml_escape "$AGENT_PATH")"
RUN_HOME_XML="$(xml_escape "$RUN_HOME")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
$BOOT_KEYS
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN_XML</string>
    <string>$APP_DIR_XML/src/start.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR_XML</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$AGENT_PATH_XML</string>
    <key>HOME</key><string>$RUN_HOME_XML</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG_DIR_XML/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR_XML/launchd.err.log</string>
</dict>
</plist>
EOF

if [ "$BOOT_MODE" = "1" ]; then
  # launchd refuses to load a system plist that is group/world-writable or not owned by root.
  chown root:wheel "$PLIST"
  chmod 644 "$PLIST"
  launchctl bootout "system/$LABEL" 2>/dev/null || true
  launchctl bootstrap system "$PLIST"
else
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
fi

if [ "$BOOT_MODE" = "1" ]; then
  echo "✅ Installed $LABEL as a LaunchDaemon (starts at boot, no login required)"
else
  echo "✅ Installed $LABEL as a LaunchAgent (starts at GUI login)"
fi
echo "   plist:  $PLIST"
echo "   user:   $RUN_USER"
echo "   repo:   $APP_DIR"
echo "   node:   $NODE_BIN"
echo "   claude: ${CLAUDE_BIN:-NOT FOUND (install/auth the claude CLI)}"
echo "   logs:   $LOG_DIR/launchd.{out,err}.log"
echo "   admin:  http://localhost:\${PORT:-4747}"
if [ "$BOOT_MODE" = "1" ]; then
  echo "Manage: sudo launchctl kickstart -k system/$LABEL  ·  uninstall: sudo bash scripts/uninstall-launchd.sh --boot"
  echo "Note:   FileVault still halts a cold unattended reboot at the preboot unlock screen."
  echo "        For a planned restart that comes back on its own, use: sudo fdesetup authrestart"
else
  echo "Manage: launchctl unload/load \"$PLIST\"  ·  uninstall: bash scripts/uninstall-launchd.sh"
fi
