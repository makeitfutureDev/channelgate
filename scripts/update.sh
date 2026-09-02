#!/usr/bin/env bash
# Compatibility entry point. The Node runner owns locking, preflight, candidate validation,
# restart health checks, automatic rollback, and durable status reporting.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$APP_DIR/scripts/update-runner.mjs" "$@"
