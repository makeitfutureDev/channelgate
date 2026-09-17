#!/bin/sh
set -eu
python3 /usr/local/lib/channelgate-vpn/checks.py validate-env >/dev/null

# Install the kill switch before opening the tunnel. Insert rules instead of
# flushing a chain: on an in-place retry there is never an unprotected interval.
# Public/default interface traffic remains available; the database address must NEVER
# leave by any interface other than tun0, including before/after a reconnect.
iptables -w 10 -I OUTPUT 1 ! -o tun0 -d "$DB_HOST/32" -j REJECT
iptables -w 10 -I OUTPUT 1 -o tun0 -j REJECT
iptables -w 10 -I OUTPUT 1 -o tun0 -d "$DB_HOST/32" -p tcp --dport "${DB_PORT:-3306}" -j ACCEPT

# Do not expose the extractor to unsolicited connections from the VPN network.
iptables -w 10 -I INPUT 1 -i tun0 -j DROP
iptables -w 10 -I INPUT 1 -i tun0 -s "$DB_HOST/32" -p tcp --sport "${DB_PORT:-3306}" -m conntrack --ctstate ESTABLISHED -j ACCEPT
ip6tables -w 10 -I OUTPUT 1 -o tun0 -j REJECT
ip6tables -w 10 -I INPUT 1 -i tun0 -j DROP
