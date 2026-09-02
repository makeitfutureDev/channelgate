#!/usr/bin/env bash
# Decrypt and restore into a disposable root, verify SQLite, then remove it.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_ROOT="${CHANNELGATE_DIR:-${CLAUDE_GATEWAY_DIR:-$HOME/.channelgate}}"
DRILL_ROOT="$(mktemp -d)"
trap 'rm -rf "$DRILL_ROOT"' EXIT
if [ -z "${CG_BACKUP_PASSPHRASE:-}" ] && [ -z "${CG_BACKUP_KEY_FILE:-}" ]; then export CG_BACKUP_KEY_FILE="$SOURCE_ROOT/.backup-key"; fi
# Pre-seed stale WAL/SHM sidecars: a real restore target has them (the daemon never closes the
# DB), and they belong to the database being discarded. The drill proves restore removes them —
# a fresh empty root would let that regression pass unseen.
printf 'stale-wal-from-discarded-db' > "$DRILL_ROOT/gateway.db-wal"
printf 'stale-shm-from-discarded-db' > "$DRILL_ROOT/gateway.db-shm"
# CHANNELGATE_DB is cleared explicitly: restore-config.sh honors it, and an inherited live
# override would make the drill restore the database OVER the real one instead of into the
# disposable root ("" counts as unset via ${...:-}).
CHANNELGATE_DIR="$DRILL_ROOT" CHANNELGATE_DB="" CLAUDE_GATEWAY_DIR="" CLAUDE_GATEWAY_DB="" CG_BACKUP_FILE="${CG_BACKUP_FILE:-$SOURCE_ROOT/backups/config.tar.gz.enc}" \
  bash "$APP_DIR/scripts/restore-config.sh"
if [ -e "$DRILL_ROOT/gateway.db-wal" ] || [ -e "$DRILL_ROOT/gateway.db-shm" ]; then
  echo "❌ Restore left stale WAL/SHM sidecars next to the restored gateway.db."
  exit 1
fi
node "$APP_DIR/scripts/sqlite-snapshot.mjs" verify "$DRILL_ROOT/gateway.db" "$DRILL_ROOT/gateway.db"
echo "✅ Restore drill passed; disposable runtime removed."
