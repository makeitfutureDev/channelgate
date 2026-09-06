#!/usr/bin/env bash
# Install a hardened system service. Run as root; the daemon itself runs as a dedicated account.
set -euo pipefail
[ "$(uname -s)" = "Linux" ] || { echo "systemd packaging is Linux-only"; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash scripts/install-systemd.sh"; exit 1; }
for required in systemctl loginctl podman newuidmap newgidmap runuser flock; do
  command -v "$required" >/dev/null || { echo "$required is required (install rootless Podman and uidmap first)"; exit 1; }
done
# Serialize subordinate-id allocation and service provisioning across simultaneous installers.
exec 9>/run/lock/channelgate-install.lock
flock -x 9
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

# Engines run from the image. Only the daemon's Node/Podman tools need a host PATH.
SERVICE_PATH="$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin"
# Values are embedded in a systemd unit, whose quoting/expansion rules differ from shell.
case "$SERVICE_USER" in *[!a-zA-Z0-9_-]*|"") echo "Invalid service account name"; exit 1;; esac
for value in "$APP_DIR" "$SERVICE_HOME" "$NODE_BIN"; do
  case "$value" in *[[:space:]%\"\\]*|[!/]*) echo "Service paths must be absolute and contain no whitespace, percent, quote or backslash"; exit 1;; esac
done
# Before provisioning an account or changing checkout ownership, prove the parent directories
# are traversable. Do not widen an operator's private home ACL to make a service install work.
relocation_remedy() {
  echo "The service account cannot reach the checkout or Node executable."
  echo "Relocate the checkout to /opt/channelgate and use a system-wide Node installation, then rerun this installer."
  echo "No account or checkout ownership was changed."
  exit 1
}
if id "$SERVICE_USER" >/dev/null 2>&1; then
  CG_CHECK_PARENT="$(dirname "$APP_DIR")" CG_CHECK_NODE="$NODE_BIN" runuser -u "$SERVICE_USER" -- /bin/sh -c \
    'test -x "$CG_CHECK_PARENT" && test -x "$CG_CHECK_NODE"' || relocation_remedy
else
  "$NODE_BIN" "$APP_DIR/scripts/service-path-preflight.mjs" "$(dirname "$APP_DIR")" "$(dirname "$NODE_BIN")" || relocation_remedy
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --add-subids-for-system --user-group --home-dir "$SERVICE_HOME" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
SERVICE_UID="$(id -u "$SERVICE_USER")"
[ "$SERVICE_UID" -ne 0 ] || { echo "The daemon must use a non-root account"; exit 1; }
# Upgrade old service accounts without rewriting existing namespace mappings.
for mapping in subuid subgid; do
  touch "/etc/$mapping"
  if ! awk -F: -v account="$SERVICE_USER" -v uid="$SERVICE_UID" '($1==account || $1==uid) && $3>=65536 { found=1 } END { exit !found }' "/etc/$mapping"; then
    first="$(awk -F: 'BEGIN { top=100000 } $2+$3>top { top=$2+$3 } END { print top }' "/etc/$mapping")"
    last="$((first + 65535))"
    case "$mapping" in
      subuid) usermod --add-subuids "$first-$last" "$SERVICE_USER" ;;
      subgid) usermod --add-subgids "$first-$last" "$SERVICE_USER" ;;
    esac
  fi
done
loginctl enable-linger "$SERVICE_USER"
systemctl start "user@$SERVICE_UID.service"
SERVICE_RUNTIME_DIR="/run/user/$SERVICE_UID"
[ -d "$SERVICE_RUNTIME_DIR" ] || { echo "The service user's runtime directory was not created"; exit 1; }
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

# Probe and build in the final daemon identity's own rootless store. The installer's store and
# image UID cannot be reused by a different service account.
run_as_service() {
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" CHANNELGATE_DIR="$SERVICE_HOME" \
    XDG_RUNTIME_DIR="$SERVICE_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="unix:path=$SERVICE_RUNTIME_DIR/bus" \
    PATH="$SERVICE_PATH" "$@"
}
run_as_service podman info --format '{{.Host.Security.Rootless}}' | grep -qx true || {
  echo "Rootless Podman is not usable as $SERVICE_USER"; exit 1;
}
run_as_service "$NODE_BIN" "$APP_DIR/scripts/build-image.mjs" --cli podman

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
After=network-online.target user@$SERVICE_UID.service
Wants=network-online.target
Requires=user@$SERVICE_UID.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=CHANNELGATE_DIR=$SERVICE_HOME
Environment=HOME=$SERVICE_HOME
Environment=PATH=$SERVICE_PATH
Environment=XDG_RUNTIME_DIR=$SERVICE_RUNTIME_DIR
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=$SERVICE_RUNTIME_DIR/bus
EnvironmentFile=-$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/src/start.js
Restart=on-failure
RestartSec=5
# SIGTERM only the daemon: it drains, marks the shutdown and sweeps its own engine children
# (host process groups, container run groups). Unknown interrupted executions are not replayed.
KillMode=mixed
UMask=0077
# Podman's newuidmap/newgidmap helpers need their setuid transition. Each channel container
# still independently applies no-new-privileges to all engine processes.
NoNewPrivileges=false
Delegate=yes
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$SERVICE_HOME $APP_DIR $SERVICE_RUNTIME_DIR
LockPersonality=true
RestrictSUIDSGID=false

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"
echo "✅ Installed $UNIT_NAME as $SERVICE_USER (runtime $SERVICE_HOME)"
