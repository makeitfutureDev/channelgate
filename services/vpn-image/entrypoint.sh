#!/bin/sh
# The operator generates this config from an allowlisted profile. Never accept an
# arbitrary path or additional OpenVPN command-line options from the container.
set -eu

test -r /vpn/client.ovpn
test -r /vpn/auth
test -c /dev/net/tun

/usr/local/bin/cg-vpn-firewall
exec openvpn --config /vpn/client.ovpn
