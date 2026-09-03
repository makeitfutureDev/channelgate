#!/usr/bin/env bash
# One-command setup for ChannelGate on a fresh Linux machine.
# Usage: bash scripts/install.sh [--no-service] [--with-whisper|--without-whisper]
#   --no-service   Don't print the systemd service step at the end (you will run the daemon yourself).
#   --with-whisper / --without-whisper   Skip the interactive voice-transcription question.
#
# ChannelGate runs on Linux only: the daemon is a systemd unit and every channel runs inside a
# rootless Podman container. Anything else stops here.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
NO_SERVICE=0
WHISPER_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-service) NO_SERVICE=1 ;;
    --with-whisper|--without-whisper) WHISPER_ARGS+=("$arg") ;;
    *) echo "Unknown install option: $arg"; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

say "ChannelGate — install"
echo "repo: $APP_DIR"

# 0. Linux only ---------------------------------------------------------------------
if [ "$(uname -s)" != "Linux" ]; then
  echo "❌ ChannelGate runs on Linux only (systemd + rootless Podman); this host is $(uname -s)."
  exit 2
fi

# 1. Node.js >= 22.13 (node:sqlite is stable from 22.13) --------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js >= 22.13 is required. Install it (https://nodejs.org or your distribution's packages) and re-run."
  exit 1
fi
if ! node -e 'const [maj, min] = process.versions.node.split(".").map(Number); process.exit(maj > 22 || (maj === 22 && min >= 13) ? 0 : 1)'; then
  echo "❌ Node.js >= 22.13 required (found $(node -v)) — the gateway's SQLite store needs the built-in node:sqlite."
  exit 1
fi
echo "✅ node $(node -v)"

# 2. claude CLI (required) --------------------------------------------------------
if command -v claude >/dev/null 2>&1; then
  echo "✅ claude $(claude --version 2>/dev/null | head -1)"
else
  echo "⚠️  'claude' CLI not found — the gateway spawns it directly. Install + authenticate:"
  echo "     npm install -g @anthropic-ai/claude-code   &&   claude login"
fi

# 3. codex CLI (optional — only for the Codex engine) -----------------------------
if command -v codex >/dev/null 2>&1; then
  echo "✅ codex $(codex --version 2>/dev/null | head -1) (optional engine available)"
else
  echo "ℹ️  'codex' not found (optional — needed only for the Codex engine):"
  echo "     npm install -g @openai/codex   &&   codex login"
fi

# 4. rootless Podman (the channel runtime) -----------------------------------------
if command -v podman >/dev/null 2>&1; then
  echo "✅ podman $(podman --version 2>/dev/null | head -1)"
else
  echo "⚠️  'podman' not found — every channel runs inside a rootless Podman container:"
  echo "     sudo apt install podman uidmap   (then: npm run build:image)"
fi

# 5. dependencies -----------------------------------------------------------------
say "Installing dependencies…"
if [ -f package-lock.json ]; then npm ci || npm install; else npm install; fi

# 6. local Whisper -----------------------------------------------------------------
say "Voice transcription"
node scripts/configure-whisper.mjs "${WHISPER_ARGS[@]}"

# 7. .env scaffold ----------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✅ created .env (tokens are optional here — you can set them in the admin UI)"
else
  echo "✅ .env already present"
fi

# 8. systemd service (needs root, so it is a separate step) ----------------------------
if [ "$NO_SERVICE" -eq 0 ]; then
  echo "ℹ️  Install the systemd service (starts at boot, restarts on failure):"
  echo "     sudo bash scripts/install-systemd.sh"
else
  echo "ℹ️  Skipped the service step (--no-service). Run 'npm start' to launch manually."
fi

PORT_SHOW="${PORT:-4747}"
say "✅ Done. Next steps:"
cat <<EOT
  1) Create the Slack app from slack-app-manifest.json
       api.slack.com/apps → Create New App → From a manifest → paste the file → Create → Install.
  2) Open the admin UI:  http://localhost:${PORT_SHOW}
       → Settings tab → paste the Slack Bot / App-Level / Signing tokens → Save & connect.
  3) Invite the bot to a channel (/invite) or DM it.
  See INSTALL.md for the full walkthrough.
EOT
