#!/usr/bin/env bash
# Install a hardened system service. Run as root; the daemon itself runs as a dedicated account.
set -euo pipefail
[ "$(uname -s)" = "Linux" ] || { echo "systemd packaging is Linux-only"; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash scripts/install-systemd.sh"; exit 1; }
command -v systemctl >/dev/null || { echo "systemctl not found"; exit 1; }
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Pre-rename account/runtime names. An upgraded host keeps using them (the runtime root, the
# database and every channel folder live there) unless the operator overrides — only a FRESH
# install gets the new defaults. Nothing here is renamed underneath an existing deployment.
LEGACY_SERVICE_USER="claude-gateway"
LEGACY_SERVICE_HOME="/var/lib/claude-gateway"
LEGACY_UNIT_NAME="claude-gateway.service"
if [ -n "${CG_SERVICE_USER:-}" ]; then
  SERVICE_USER="$CG_SERVICE_USER"
elif id "$LEGACY_SERVICE_USER" >/dev/null 2>&1; then
  SERVICE_USER="$LEGACY_SERVICE_USER"
else
  SERVICE_USER="channelgate"
fi
if [ -n "${CG_SERVICE_HOME:-}" ]; then
  SERVICE_HOME="$CG_SERVICE_HOME"
elif [ -d "$LEGACY_SERVICE_HOME" ]; then
  SERVICE_HOME="$LEGACY_SERVICE_HOME"
else
  SERVICE_HOME="/var/lib/channelgate"
fi
UNIT_NAME="channelgate.service"
NODE_BIN="$(command -v node)"

# The daemon spawns `claude`/`codex` by bare name, and systemd services get a minimal PATH —
# resolve the engine CLIs NOW (from the installing user's PATH) and bake their dirs into the
# unit, mirroring what install-launchd.sh already does on macOS. A binary under /home or /root
# would be unreachable behind ProtectHome=true, so those dirs also get a read-only bind hole.
SERVICE_PATH="$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin"
BIND_RO=""
for engine in claude codex opencode; do
  bin="$(command -v "$engine" 2>/dev/null || true)"
  if [ -z "$bin" ]; then
    echo "⚠️  $engine CLI not found on PATH — the service can start, but $engine runs will fail until it is installed system-wide."
    continue
  fi
  dir="$(dirname "$bin")"
  case ":$SERVICE_PATH:" in *":$dir:"*) ;; *) SERVICE_PATH="$SERVICE_PATH:$dir";; esac
  case "$dir" in
    /home/*|/root/*)
      echo "⚠️  $engine resolves to $bin (inside a user home). Exposing it read-only to the service; prefer a system-wide install (e.g. npm prefix /usr/local)."
      case " $BIND_RO " in *" $dir "*) ;; *) BIND_RO="$BIND_RO $dir";; esac
      ;;
  esac
done
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$SERVICE_HOME" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$SERVICE_HOME" "$SERVICE_HOME/logs"

# The service account must OWN the checkout, not merely have it listed in ReadWritePaths:
# self-update runs `git fetch/merge` and `npm ci` as $SERVICE_USER inside $APP_DIR, and both
# mutate files/refs (and .git/, node_modules/) that stay owned by whoever ran this installer
# (root) otherwise — the update would fail with EACCES, or git would refuse the "dubious
# ownership" checkout. Sanity-check the target first: a recursive chown of the wrong directory
# is not recoverable, so only proceed when $APP_DIR really is this checkout.
if [ ! -f "$APP_DIR/package.json" ] || [ ! -e "$APP_DIR/scripts/install-systemd.sh" ]; then
  echo "❌ $APP_DIR does not look like the gateway checkout — refusing to chown it."
  exit 1
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
# Prove the result rather than assuming it: a read-only mount (or an ACL/immutable bit) leaves the
# checkout unwritable even after a "successful" chown, and self-update would only find that out
# mid-transaction. CG_CHECK_DIR travels through the (non-login) su environment, so no path is ever
# pasted into a shell string.
if ! CG_CHECK_DIR="$APP_DIR" su -s /bin/sh -c \
  'test -w "$CG_CHECK_DIR" && { [ ! -e "$CG_CHECK_DIR/.git" ] || test -w "$CG_CHECK_DIR/.git"; }' "$SERVICE_USER"; then
  echo "❌ $SERVICE_USER cannot write $APP_DIR (or its .git) after chown — read-only mount or ACL?"
  echo "   Self-update runs git + npm as that account and needs write access to the checkout."
  exit 1
fi
echo "✅ Checkout $APP_DIR is owned and writable by $SERVICE_USER (self-update ready)"

# Engine credentials for the login-less service account: the operator's own `claude login` state
# lives in THEIR home, not the service's. API keys go in a 0600 env file the unit reads; see
# docs/OPERATIONS.md ("Service identities").
ENV_FILE="$SERVICE_HOME/service.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'ENVEOF'
# Engine credentials for the channelgate service (chmod 0600, owned by the service user).
# Uncomment and fill in — the daemon passes ONLY allowlisted names to engine subprocesses.
#ANTHROPIC_API_KEY=
#OPENAI_API_KEY=
ENVEOF
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
fi

# Retire the pre-rename unit BEFORE writing the new one: both ExecStart the same checkout against
# the same runtime root, and the daemon's singleton lock would make the second one crash-loop.
LEGACY_UNIT="/etc/systemd/system/$LEGACY_UNIT_NAME"
if [ -f "$LEGACY_UNIT" ]; then
  echo "→ Retiring the pre-rename unit $LEGACY_UNIT_NAME"
  systemctl disable --now "$LEGACY_UNIT_NAME" 2>/dev/null || true
  rm -f "$LEGACY_UNIT"
fi

UNIT="/etc/systemd/system/$UNIT_NAME"
cat > "$UNIT" <<EOF
[Unit]
Description=ChannelGate
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=CHANNELGATE_DIR=$SERVICE_HOME
Environment=HOME=$SERVICE_HOME
Environment=PATH=$SERVICE_PATH
EnvironmentFile=-$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/src/start.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$SERVICE_HOME $APP_DIR
${BIND_RO:+BindReadOnlyPaths=${BIND_RO# }}
LockPersonality=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"
echo "✅ Installed $UNIT_NAME as $SERVICE_USER (runtime $SERVICE_HOME)"

# Ubuntu 23.10+ restricts unprivileged user namespaces via AppArmor, which kills every sandboxed
# Bash call in every channel (Read/MCP keep working, so nothing else looks wrong). The daemon also
# warns at boot; say it here, where the operator already has root — see scripts/apparmor/README.md.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] \
   && [ ! -f /etc/apparmor.d/claude-code-userns ]; then
  echo "⚠️  AppArmor restricts unprivileged user namespaces on this host and the claude-code-userns profile is not installed —"
  echo "    sandboxed Bash will fail in every channel. Run: sudo sh $APP_DIR/scripts/apparmor/claude-userns-fix.sh --apply"
fi
