#!/usr/bin/env bash
# Restore the encrypted config backup into ~/.channelgate.
#
# Looks for the blob at $CG_BACKUP_FILE, then ~/.channelgate/backups/config.tar.gz.enc,
# then the legacy in-repo backup/config.tar.gz.enc (backups written before they moved out of
# the repo). Key: set CG_BACKUP_PASSPHRASE, or place the key file at
# ~/.channelgate/.backup-key (the same key used by `npm run backup`).
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GW_HOME="${CHANNELGATE_DIR:-${CLAUDE_GATEWAY_DIR:-$HOME/.channelgate}}"
DB_FILE="${CHANNELGATE_DB:-${CLAUDE_GATEWAY_DB:-$GW_HOME/gateway.db}}"   # same override src/config/paths.js honors
BLOB=""
for candidate in "${CG_BACKUP_FILE:-}" "$GW_HOME/backups/config.tar.gz.enc" "$APP_DIR/backup/config.tar.gz.enc"; do
  [ -n "$candidate" ] && [ -f "$candidate" ] && { BLOB="$candidate"; break; }
done
[ -n "$BLOB" ] || { echo "No backup found (set CG_BACKUP_FILE, or place the blob at $GW_HOME/backups/config.tar.gz.enc)"; exit 1; }
echo "Restoring from $BLOB"

if [ -n "${CG_BACKUP_PASSPHRASE:-}" ]; then
  PASS_OPT=(-pass env:CG_BACKUP_PASSPHRASE)
elif [ -n "${CG_BACKUP_KEY_FILE:-}" ] && [ -f "$CG_BACKUP_KEY_FILE" ]; then
  PASS_OPT=(-pass file:"$CG_BACKUP_KEY_FILE")
elif [ -f "$GW_HOME/.backup-key" ]; then
  PASS_OPT=(-pass file:"$GW_HOME/.backup-key")
else
  echo "❌ No key. Set CG_BACKUP_PASSPHRASE/CG_BACKUP_KEY_FILE, or copy your key to $GW_HOME/.backup-key."
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! openssl enc -d -aes-256-cbc -pbkdf2 "${PASS_OPT[@]}" -in "$BLOB" -out "$TMP/config.tgz" 2>/dev/null; then
  echo "❌ Decryption failed — wrong key/passphrase?"
  exit 1
fi

mkdir -p "$GW_HOME"
if [ -e "$DB_FILE" ] || [ -d "$GW_HOME/config" ]; then
  echo "⚠️  Existing gateway state will be replaced. Stop the daemon before continuing."
  if [ "${CG_RESTORE_CONFIRM:-}" != "YES" ]; then
    if [ ! -t 0 ]; then
      echo "❌ Non-interactive restore refused. Stop the daemon and set CG_RESTORE_CONFIRM=YES explicitly."
      exit 1
    fi
    read -r -p "I stopped the gateway; replace its state? Type RESTORE: " a
    [ "${a:-}" = "RESTORE" ] || { echo "Aborted."; exit 0; }
  fi
fi

mkdir -p "$TMP/payload"
tar -xzf "$TMP/config.tgz" -C "$TMP/payload"
if [ ! -f "$TMP/payload/gateway.db" ]; then
  echo "❌ Backup has no gateway.db; refusing an incomplete modern restore."
  exit 1
fi
node "$APP_DIR/scripts/sqlite-snapshot.mjs" verify "$TMP/payload/gateway.db" "$TMP/payload/gateway.db"
mkdir -p "$(dirname "$DB_FILE")" # CHANNELGATE_DB may point outside $GW_HOME
cp "$TMP/payload/gateway.db" "$DB_FILE.restore"
chmod 600 "$DB_FILE.restore"
# The daemon runs the DB in WAL mode and never closes it on shutdown, so gateway.db-wal/-shm
# from the database being REPLACED normally still sit here. Left in place, SQLite would replay
# those stale frames over the restored file on next open (silently reintroducing discarded
# changes, or corrupting — the backup's page layout differs after VACUUM INTO). Remove them
# before the restored file lands so no opener can ever pair it with the old sidecars.
rm -f "$DB_FILE-wal" "$DB_FILE-shm"
mv "$DB_FILE.restore" "$DB_FILE"
# Verify the file actually left in place — not just the pristine payload copy above.
node "$APP_DIR/scripts/sqlite-snapshot.mjs" verify "$DB_FILE" "$DB_FILE"

# REPLACE the managed directories, never merge: `cp -R backup/. live/` would let files absent
# from the backup survive, producing a hybrid config that matches neither the backup nor the
# previous state. Stage a full copy next to the destination (same filesystem, so mv is atomic),
# move the live dir aside, move the staged one in, and only then delete the old dir; any failure
# puts the original back.
replace_dir() {
  src="$1"; dest="$2"
  staged="$dest.restore-staged"; old="$dest.restore-old"
  rm -rf "$staged" "$old"
  if ! cp -R "$src" "$staged"; then
    rm -rf "$staged"
    echo "❌ Failed to stage restore for $dest — live state untouched."; exit 1
  fi
  if [ -d "$dest" ] && ! mv "$dest" "$old"; then
    rm -rf "$staged"
    echo "❌ Could not move $dest aside — live state untouched."; exit 1
  fi
  if ! mv "$staged" "$dest"; then
    # Plain `[ -d "$old" ] && mv …` would be a failed command under `set -e` when there was no
    # live dir to save, aborting before the message below ever prints.
    if [ -d "$old" ]; then mv "$old" "$dest"; fi
    rm -rf "$staged"
    echo "❌ Failed to install restored $dest — original put back."; exit 1
  fi
  rm -rf "$old"
}
replace_dir "$TMP/payload/config" "$GW_HOME/config"
if [ -d "$TMP/payload/channels" ]; then replace_dir "$TMP/payload/channels" "$GW_HOME/channels"; fi
echo "✅ Restored config into $GW_HOME"
echo "   Restart the gateway: sudo systemctl restart channelgate  (systemctl --user restart channelgate for a user unit, or npm start)"
