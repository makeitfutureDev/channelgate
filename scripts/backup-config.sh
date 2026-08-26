#!/usr/bin/env bash
# Encrypted backup of the gateway config to ~/.channelgate/backups (NEVER the repo).
#
# Backs up the SQLite source of truth plus config and channel metadata (which include Slack + Composio
# tokens) as an AES-256 + PBKDF2 encrypted blob: $GW_HOME/backups/config.tar.gz.enc. Even
# encrypted, credential blobs must never enter git history — copy the blob + key to your own
# safe location (external drive, password manager, private storage) to move machines.
#
# Key: set CG_BACKUP_PASSPHRASE to use a passphrase you control. Otherwise a random key is
# generated once at ~/.channelgate/.backup-key (kept local, gitignored) — copy that file to
# any machine you want to restore on.
set -euo pipefail

GW_HOME="${CHANNELGATE_DIR:-${CLAUDE_GATEWAY_DIR:-$HOME/.channelgate}}"
DB_FILE="${CHANNELGATE_DB:-${CLAUDE_GATEWAY_DB:-$GW_HOME/gateway.db}}"   # same override src/config/paths.js honors
[ -d "$GW_HOME/config" ] || { echo "No config at $GW_HOME/config — nothing to back up."; exit 1; }
[ -f "$DB_FILE" ] || { echo "No SQLite database at $DB_FILE — refusing an incomplete backup."; exit 1; }
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Decide the encryption key source.
if [ -n "${CG_BACKUP_PASSPHRASE:-}" ]; then
  PASS_OPT=(-pass env:CG_BACKUP_PASSPHRASE)
  echo "🔑 Using CG_BACKUP_PASSPHRASE"
elif [ -n "${CG_BACKUP_KEY_FILE:-}" ]; then
  [ -f "$CG_BACKUP_KEY_FILE" ] || { echo "Backup key file not found: $CG_BACKUP_KEY_FILE"; exit 1; }
  PASS_OPT=(-pass file:"$CG_BACKUP_KEY_FILE")
else
  KEYFILE="$GW_HOME/.backup-key"
  if [ ! -f "$KEYFILE" ]; then
    openssl rand -base64 32 > "$KEYFILE"
    chmod 600 "$KEYFILE"
    echo "🔑 Generated a backup key at $KEYFILE"
    echo "   ⚠️  KEEP IT SAFE — you cannot restore without it. Copy it to any machine you restore on."
  fi
  PASS_OPT=(-pass file:"$KEYFILE")
fi

TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/payload"

# VACUUM INTO produces a transactionally consistent, compact snapshot even while the daemon is live.
node "$APP_DIR/scripts/sqlite-snapshot.mjs" snapshot "$DB_FILE" "$TMP/payload/gateway.db"
cp -R "$GW_HOME/config" "$TMP/payload/config"
if [ -d "$GW_HOME/channels" ]; then cp -R "$GW_HOME/channels" "$TMP/payload/channels"; fi

# Tar the durable config (skip regenerable lockdowns, uploads, and machine-specific sessions).
# Include channels only when it exists, and FAIL CLOSED on any tar error — the old fallback
# silently retried without channel data while the manifest still claimed it was included.
TAR_ITEMS=(gateway.db config)
CONTENTS="transactionally consistent gateway.db + config/"
if [ -d "$TMP/payload/channels" ]; then
  TAR_ITEMS+=(channels)
  CONTENTS="$CONTENTS + durable channel metadata"
fi
if ! tar -czf "$TMP/config.tgz" -C "$TMP/payload" \
  --exclude='channels/*/uploads' \
  --exclude='channels/*/.claude' \
  --exclude='channels/*/sessions.json' \
  "${TAR_ITEMS[@]}"; then
  echo "❌ tar failed while archiving ${TAR_ITEMS[*]} — refusing to write a partial backup."
  exit 1
fi

OUT_DIR="$GW_HOME/backups"
mkdir -p "$OUT_DIR"
VERSIONED="$OUT_DIR/config-$TS.tar.gz.enc"
openssl enc -aes-256-cbc -pbkdf2 -salt "${PASS_OPT[@]}" -in "$TMP/config.tgz" -out "$VERSIONED"
cp "$VERSIONED" "$OUT_DIR/config.tar.gz.enc"
chmod 600 "$VERSIONED" "$OUT_DIR/config.tar.gz.enc"

cat > "$OUT_DIR/MANIFEST.txt" <<EOF
Encrypted ChannelGate config backup.
Last backup: $TS
Cipher: openssl aes-256-cbc + pbkdf2 (salted)
Contents: $CONTENTS
Restore:  npm run restore     (requires the key: CG_BACKUP_PASSPHRASE or ~/.channelgate/.backup-key)
This blob lives OUTSIDE the repo on purpose — never commit it. Copy blob + key off-machine yourself.
EOF

SIZE="$(wc -c < "$VERSIONED" | tr -d ' ')"
echo "✅ Encrypted backup → $OUT_DIR/config.tar.gz.enc ($SIZE bytes)"
echo "   Copy it (plus your key) somewhere safe off this machine — it is NOT committed to git."
