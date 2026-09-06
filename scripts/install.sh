#!/usr/bin/env bash
# One-command setup for ChannelGate on a fresh Linux machine.
# Usage: bash scripts/install.sh [--no-service] [--with-whisper|--without-whisper] [--skip-image]
#   --no-service   Don't print the systemd service step at the end (you will run the daemon yourself).
#   --with-whisper / --without-whisper   Skip the interactive voice-transcription question.
#   --skip-image   Don't build the channel container image now (CG_BUILD_IMAGE=no is the same);
#                  run `npm run build:image` before the first message instead.
#
# ChannelGate runs on Linux only: the daemon is a systemd unit and every channel runs inside a
# rootless Podman container. Anything else stops here.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
NO_SERVICE=0
BUILD_IMAGE=1
case "${CG_BUILD_IMAGE:-}" in
  0|n|N|no|NO|false|FALSE|off|OFF) BUILD_IMAGE=0 ;;
esac
WHISPER_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-service) NO_SERVICE=1 ;;
    --skip-image) BUILD_IMAGE=0 ;;
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

# 2–3. engine CLIs ----------------------------------------------------------------
# Both CLIs ship in the channel image. Host CLI logins are not service credentials.
echo "Claude and Codex are installed in the runtime image."
echo "Configure ANTHROPIC_API_KEY and OPENAI_API_KEY in the daemon environment."

# 4. rootless Podman (the channel runtime) -----------------------------------------
HAVE_PODMAN=0
if command -v podman >/dev/null 2>&1; then
  echo "✅ podman $(podman --version 2>/dev/null | head -1)"
  HAVE_PODMAN=1
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

# 7. channel container image ---------------------------------------------------------
# Every conversation runs inside this image, and the daemon fails a run closed without it. The
# image is where the shared toolchain lives (engine CLIs, ffmpeg/ffprobe, OpenCV, faster-whisper and
# its pre-cached speech model) — so building it IS part of the install, not a step to remember later.
say "Channel container image"
IMAGE_BUILT=0
if [ "$NO_SERVICE" -eq 0 ]; then
  echo "The service installer builds the image as the final service account."
  echo "Run: sudo bash scripts/install-systemd.sh"
elif [ "$BUILD_IMAGE" -eq 0 ]; then
  echo "ℹ️  Skipped the channel image build (--skip-image / CG_BUILD_IMAGE=no). Before the first message run:"
  echo "     npm run build:image"
elif [ "$HAVE_PODMAN" -eq 0 ]; then
  echo "⚠️  No container CLI — install rootless Podman first, then build the channel image:"
  echo "     sudo apt install podman uidmap   &&   npm run build:image"
else
  echo "Building the channel image (a Debian toolchain, the pinned engine CLIs, ffmpeg, OpenCV,"
  echo "faster-whisper and its speech model — several minutes on a cold cache)…"
  if node scripts/build-image.mjs; then
    IMAGE_BUILT=1
  else
    echo "⚠️  The channel image build failed. Fix the cause and re-run it before the first message:"
    echo "     npm run build:image"
  fi
fi

# 8. .env scaffold ----------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✅ created .env (tokens are optional here — you can set them in the admin UI)"
else
  echo "✅ .env already present"
fi

# 9. systemd service (needs root, so it is a separate step) ----------------------------
if [ "$NO_SERVICE" -eq 0 ]; then
  echo "ℹ️  Install the systemd service (starts at boot, restarts on failure):"
  echo "     sudo bash scripts/install-systemd.sh"
else
  echo "ℹ️  Skipped the service step (--no-service). Run 'npm start' to launch manually."
fi

PORT_SHOW="${PORT:-4747}"
if [ "$IMAGE_BUILT" -eq 1 ]; then
  say "✅ Done. Next steps:"
else
  say "✅ Dependencies ready. Build the runtime image as the account that will run the daemon before the first message. Next steps:"
fi
cat <<EOT
  1) Create the Slack app from slack-app-manifest.json
       api.slack.com/apps → Create New App → From a manifest → paste the file → Create → Install.
  2) Open the admin UI:  http://localhost:${PORT_SHOW}
       → Settings tab → paste the Slack Bot / App-Level / Signing tokens → Save & connect.
  3) Invite the bot to a channel (/invite) or DM it.
  See INSTALL.md for the full walkthrough.
EOT
