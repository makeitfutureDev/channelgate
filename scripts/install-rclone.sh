#!/usr/bin/env bash
# Install the host-side rclone binary used by the daemon's Google Drive sync. Root installs use
# /usr/local/bin; ordinary daemon users get a durable ~/.local/bin copy. The downloaded archive is
# checked against rclone's release checksum before anything is installed.
set -euo pipefail

if command -v rclone >/dev/null 2>&1; then
  echo "→ rclone present ($(rclone version 2>/dev/null | head -1 || true))."
  exit 0
fi

[ "$(uname -s)" = "Linux" ] || { echo "⚠ rclone auto-install is supported on Linux only."; exit 1; }
for command in curl sha256sum unzip; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "⚠ $command is required to install rclone. Install rclone manually: https://rclone.org/install/"
    exit 1
  }
done

case "$(uname -m)" in
  x86_64|amd64) RCLONE_ARCH="amd64" ;;
  aarch64|arm64) RCLONE_ARCH="arm64" ;;
  armv7l) RCLONE_ARCH="arm-v7" ;;
  armv6l) RCLONE_ARCH="arm-v6" ;;
  i386|i486|i586|i686) RCLONE_ARCH="386" ;;
  *) echo "⚠ Unsupported rclone architecture: $(uname -m). Install it manually: https://rclone.org/install/"; exit 1 ;;
esac

RCLONE_VERSION="$(curl -fsSL https://downloads.rclone.org/version.txt | tr -d '\r\n' | sed 's/^rclone //')"
[[ "$RCLONE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "⚠ Could not resolve a valid rclone release version."
  exit 1
}

RCLONE_ARCHIVE="rclone-${RCLONE_VERSION}-linux-${RCLONE_ARCH}.zip"
RCLONE_URL="https://downloads.rclone.org/${RCLONE_VERSION}"
RCLONE_TMP="$(mktemp -d)"
trap 'rm -rf "$RCLONE_TMP"' EXIT

curl -fsSL "$RCLONE_URL/$RCLONE_ARCHIVE" -o "$RCLONE_TMP/$RCLONE_ARCHIVE"
curl -fsSL "$RCLONE_URL/SHA256SUMS" -o "$RCLONE_TMP/SHA256SUMS"
RCLONE_SUM="$(grep -F "  $RCLONE_ARCHIVE" "$RCLONE_TMP/SHA256SUMS" | head -1)"
[ -n "$RCLONE_SUM" ] || { echo "⚠ The rclone release checksum is missing $RCLONE_ARCHIVE."; exit 1; }
printf '%s\n' "$RCLONE_SUM" | (cd "$RCLONE_TMP" && sha256sum -c -)
unzip -q "$RCLONE_TMP/$RCLONE_ARCHIVE" -d "$RCLONE_TMP"

if [ -n "${CG_RCLONE_INSTALL_DIR:-}" ]; then
  RCLONE_INSTALL_DIR="$CG_RCLONE_INSTALL_DIR"
elif [ "$(id -u)" = "0" ]; then
  RCLONE_INSTALL_DIR="/usr/local/bin"
else
  RCLONE_INSTALL_DIR="${HOME:?HOME is required}/.local/bin"
fi
case "$RCLONE_INSTALL_DIR" in
  /*) ;;
  *) echo "⚠ The rclone install directory must be absolute: $RCLONE_INSTALL_DIR"; exit 1 ;;
esac

install -d -m 0755 "$RCLONE_INSTALL_DIR"
install -m 0755 "$RCLONE_TMP/rclone-${RCLONE_VERSION}-linux-${RCLONE_ARCH}/rclone" "$RCLONE_INSTALL_DIR/rclone"
"$RCLONE_INSTALL_DIR/rclone" version >/dev/null
echo "→ rclone installed at $RCLONE_INSTALL_DIR/rclone ($RCLONE_VERSION)."
