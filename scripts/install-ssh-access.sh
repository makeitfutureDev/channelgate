#!/usr/bin/env bash
# Enable SSH access to channel containers (docs/SSH-ACCESS.md). Run as root on the gateway host,
# once; re-run after an update that changes scripts/cg-ssh-attach.mjs. Idempotent.
#
# What it sets up:
#   * a dedicated, unprivileged login account (default channelgate-ssh): no password, no home of
#     its own, no container access; sshd's Match block forces every login into the attach wrapper;
#   * the shared directory (default /var/lib/channelgate-ssh), owned by the daemon's account and
#     group-owned by the login account, holding endpoint.json (written here), the daemon-exported
#     authorized_keys and the daemon's attach socket;
#   * root-owned copies of the attach wrapper and the AuthorizedKeysCommand under
#     /usr/local/lib/channelgate;
#   * /etc/ssh/sshd_config.d/channelgate.conf, then `sshd -t` and a reload.
# The daemon notices the directory within a minute and needs no restart.
set -euo pipefail
trap 'echo "❌ install-ssh-access.sh failed at line $LINENO — nothing is half-configured (every step is idempotent); fix the cause and rerun" >&2' ERR
[ "$(uname -s)" = "Linux" ] || { echo "SSH access setup is Linux-only"; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash scripts/install-ssh-access.sh"; exit 1; }
for required in sshd useradd install; do
  command -v "$required" >/dev/null || command -v "/usr/sbin/$required" >/dev/null || { echo "$required is required (install openssh-server first)"; exit 1; }
done
SSHD_BIN="$(command -v sshd || echo /usr/sbin/sshd)"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# The daemon's account owns the shared directory. Detect the systemd service account the same way
# install-systemd.sh names it; an operator-run daemon passes CG_SERVICE_USER explicitly.
if [ -n "${CG_SERVICE_USER:-}" ]; then
  SERVICE_USER="$CG_SERVICE_USER"
elif id channelgate >/dev/null 2>&1; then
  SERVICE_USER="channelgate"
elif id claude-gateway >/dev/null 2>&1; then
  SERVICE_USER="claude-gateway"
else
  SERVICE_USER="$(stat -c %U "$APP_DIR")"
fi
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "Service account $SERVICE_USER does not exist (set CG_SERVICE_USER)"; exit 1; }
[ "$(id -u "$SERVICE_USER")" -ne 0 ] || { echo "The daemon account must not be root"; exit 1; }
SSH_USER="${CG_SSH_USER:-channelgate-ssh}"
SSH_DIR="${CG_SSH_DIR:-/var/lib/channelgate-ssh}"
SSH_HOST="${CG_SSH_HOST:-$(hostname -f 2>/dev/null || hostname)}"
SSH_PORT="${CG_SSH_PORT:-22}"
LIB_DIR="/usr/local/lib/channelgate"
# Node for the attach wrapper. Root's sudo PATH (secure_path) rarely contains a per-user Node
# install, so look where the daemon actually finds it: the invoking user's and the service
# account's ~/.local, nvm, volta and fnm trees, then the system locations. Never `$(command -v
# node)` inside an assignment under `set -e` — a miss there exits the script with no message.
find_node() {
  [ -n "${CG_NODE_BIN:-}" ] && { echo "$CG_NODE_BIN"; return; }
  local candidate home
  candidate="$(command -v node 2>/dev/null || true)"
  [ -n "$candidate" ] && { echo "$candidate"; return; }
  for home in "${SUDO_USER:+$(getent passwd "$SUDO_USER" | cut -d: -f6)}" "$(getent passwd "$SERVICE_USER" | cut -d: -f6)" /root; do
    [ -n "$home" ] || continue
    for candidate in "$home/.local/bin/node" "$home/.local/node/bin/node" "$home"/.nvm/versions/node/*/bin/node "$home/.volta/bin/node" "$home"/.local/share/fnm/node-versions/*/installation/bin/node; do
      [ -x "$candidate" ] && { echo "$candidate"; return; }
    done
  done
  for candidate in /usr/local/bin/node /usr/bin/node /opt/node/bin/node /snap/bin/node; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  echo ""
}
NODE_SRC="$(find_node)"
[ -n "$NODE_SRC" ] && [ -x "$NODE_SRC" ] || { echo "❌ node was not found (root's PATH is $PATH). Pass it explicitly: sudo CG_NODE_BIN=\"\$(command -v node)\" CG_SSH_HOST=… bash scripts/install-ssh-access.sh"; exit 1; }
NODE_SRC="$(readlink -f "$NODE_SRC")"
# The login account must be able to EXECUTE node, and a per-user install usually sits under a
# 0700 home it cannot traverse. Node is a self-contained binary, so the installer keeps a
# root-owned copy beside the wrapper; rerun the installer after upgrading Node to refresh it.
NODE_BIN="$LIB_DIR/node"
echo "→ node: $NODE_SRC → $NODE_BIN"
case "$SSH_USER" in *[!a-zA-Z0-9_-]*|"") echo "Invalid login account name"; exit 1;; esac
case "$SSH_HOST" in *[!a-zA-Z0-9_.:-]*|"") echo "Invalid CG_SSH_HOST"; exit 1;; esac
case "$SSH_PORT" in *[!0-9]*|"") echo "Invalid CG_SSH_PORT"; exit 1;; esac
for value in "$SSH_DIR" "$NODE_BIN"; do
  case "$value" in *[[:space:]%\"\\]*|[!/]*) echo "Paths must be absolute and contain no whitespace, percent, quote or backslash"; exit 1;; esac
done
[ "$SSH_USER" != "$SERVICE_USER" ] || { echo "The login account must be a different account from the daemon's ($SERVICE_USER)"; exit 1; }

# The login account: system account, a real /bin/sh so sshd can run the forced command, and a
# home nothing writes to. It never gets a password.
if ! id "$SSH_USER" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$SSH_DIR/home" --no-create-home --shell /bin/sh "$SSH_USER"
fi
usermod -L "$SSH_USER" 2>/dev/null || true
install -d -m 2750 -o "$SERVICE_USER" -g "$SSH_USER" "$SSH_DIR"
install -d -m 0755 -o root -g root "$SSH_DIR/home"

# Root-owned copies: sshd refuses an AuthorizedKeysCommand that is not root-owned, and the login
# account cannot read the checkout anyway.
install -d -m 0755 -o root -g root "$LIB_DIR"
install -m 0755 -o root -g root "$NODE_SRC" "$NODE_BIN"
install -m 0755 -o root -g root "$APP_DIR/scripts/cg-ssh-attach.mjs" "$LIB_DIR/cg-ssh-attach.mjs"
sed "s|/var/lib/channelgate-ssh/authorized_keys|$SSH_DIR/authorized_keys|" "$APP_DIR/scripts/cg-ssh-authorized-keys" > "$LIB_DIR/cg-ssh-authorized-keys.tmp"
install -m 0755 -o root -g root "$LIB_DIR/cg-ssh-authorized-keys.tmp" "$LIB_DIR/cg-ssh-authorized-keys"
rm -f "$LIB_DIR/cg-ssh-authorized-keys.tmp"
ATTACH_COMMAND="$NODE_BIN $LIB_DIR/cg-ssh-attach.mjs"
# Prove the login account can run the wrapper's interpreter before sshd is pointed at it — the
# failure mode otherwise is every developer seeing a bare "exit 127".
if ! runuser -u "$SSH_USER" -- "$NODE_BIN" -e "process.exit(0)" 2>/dev/null; then
  echo "❌ $SSH_USER cannot execute $NODE_BIN — check that $LIB_DIR is world-readable and the binary is not on a noexec mount"
  exit 1
fi

# What the daemon tells developers, and the command it restricts every key to.
umask 022
cat > "$SSH_DIR/endpoint.json.tmp" <<JSON
{
  "host": "$SSH_HOST",
  "port": $SSH_PORT,
  "user": "$SSH_USER",
  "attachCommand": "$ATTACH_COMMAND",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
chmod 0644 "$SSH_DIR/endpoint.json.tmp"
mv "$SSH_DIR/endpoint.json.tmp" "$SSH_DIR/endpoint.json"

# The sshd side. Everything a developer's ssh could ask of the HOST is denied here: the forced
# command is the only thing that runs, no pty, no forwarding of any kind, no rc file. The
# developer's real session — pty, forwards, sftp — is served by the sshd INSIDE the container.
CONF_DIR="/etc/ssh/sshd_config.d"
install -d -m 0755 "$CONF_DIR"
if ! grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config; then
  echo "❌ /etc/ssh/sshd_config does not include $CONF_DIR/*.conf — add 'Include /etc/ssh/sshd_config.d/*.conf' at its TOP, then rerun."
  exit 1
fi
cat > "$CONF_DIR/channelgate.conf.tmp" <<CONF
# Managed by ChannelGate (scripts/install-ssh-access.sh). SSH access to channel containers:
# the $SSH_USER account exists only to hand connections to the gateway daemon.
Match User $SSH_USER
    AuthorizedKeysCommand $LIB_DIR/cg-ssh-authorized-keys %f
    AuthorizedKeysCommandUser $SSH_USER
    AuthorizedKeysFile none
    ForceCommand $ATTACH_COMMAND
    ExposeAuthInfo yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PubkeyAuthentication yes
    PermitTTY no
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitUserRC no
    GatewayPorts no
CONF
chmod 0644 "$CONF_DIR/channelgate.conf.tmp"
mv "$CONF_DIR/channelgate.conf.tmp" "$CONF_DIR/channelgate.conf"
if ! "$SSHD_BIN" -t; then
  echo "❌ sshd rejected the configuration; $CONF_DIR/channelgate.conf was removed"
  rm -f "$CONF_DIR/channelgate.conf"
  exit 1
fi
if command -v systemctl >/dev/null; then
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || echo "⚠ reload the SSH service by hand (systemctl reload ssh)"
fi
echo "✅ SSH access enabled: developers connect through $SSH_USER@$SSH_HOST${SSH_PORT:+:$SSH_PORT} (attach dir $SSH_DIR, daemon account $SERVICE_USER)"
echo "   The daemon binds $SSH_DIR/attach.sock within a minute. Register keys and grants from Slack (docs/SSH-ACCESS.md)."
