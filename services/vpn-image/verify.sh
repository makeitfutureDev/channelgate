#!/bin/sh
set -eu
exec python3 /usr/local/lib/channelgate-vpn/checks.py verify "$@"
