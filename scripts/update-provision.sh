#!/usr/bin/env bash
# Optional/idempotent provisioning applied after the candidate lockfile and test suite pass.
# Failure of optional Whisper/rclone assets keeps their feature dormant; workspace migration stays
# best-effort and idempotent, matching the historical update behavior.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

read_setting() {
  local settings="${CHANNELGATE_DIR:-${CLAUDE_GATEWAY_DIR:-$HOME/.channelgate}}/config/settings.json"
  SETTINGS="$settings" KEY="$1" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    try { const s = JSON.parse(readFileSync(process.env.SETTINGS, "utf8"));
      const v = s[process.env.KEY]; process.stdout.write(v === undefined || v === null ? "" : String(v)); }
    catch (e) {}' 2>/dev/null || true
}

install_rclone() {
  bash "$APP_DIR/scripts/install-rclone.sh"
}

ensure_rclone() {
  [ "$(read_setting driveSyncEnabled)" = "true" ] || { echo "→ Drive sync off — skipping rclone check."; return 0; }
  if command -v rclone >/dev/null 2>&1; then echo "→ rclone present ($(rclone version 2>/dev/null | head -1 || true))."; return 0; fi
  local rcpath; rcpath="$(read_setting driveSyncRclonePath)"
  if [ -n "$rcpath" ] && [ -x "$rcpath" ]; then echo "→ rclone present at $rcpath."; return 0; fi
  echo "→ rclone not found — installing (Drive sync is enabled)…"
  install_rclone && echo "→ rclone installed." || echo "⚠ rclone install failed — Drive sync stays dormant until rclone is available (https://rclone.org/install/)."
}

WHISPER_ENABLED="$(read_setting whisperEnabled)"
if [ "$WHISPER_ENABLED" = "false" ]; then
  echo "→ Local Whisper disabled — skipping runtime and model check."
else
  echo "→ Checking local Whisper…"
  if ! node scripts/install-whisper.mjs; then
    echo "⚠ Local Whisper setup failed — Slack transcripts remain available; run 'npm run whisper:install' to repair local transcription."
  fi
fi

echo "→ Migrating to the ChannelGate roots (~/.channelgate, ~/ChannelGate/<platform>)…"
node scripts/migrate-channelgate.mjs || true

echo "→ Migrating working folders to the workspace…"
node scripts/migrate-workspace.mjs || true

echo "→ Checking rclone (Google Drive sync)…"
ensure_rclone || true
