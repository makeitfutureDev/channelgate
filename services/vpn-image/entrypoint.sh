#!/bin/sh
# OpenVPN 3 Linux uses a private system bus and service stack. Provider logs
# remain in the container's private tmpfs; stdout contains fixed events only.
set -eu

RUNTIME=/run/channelgate-vpn
LOGS=/run/openvpn3
children=""
required_children=""
vpn_pid=""

start_child() {
    component=$1
    shift
    "$@" &
    child=$!
    children="$children $child"
    required_children="$required_children $component:$child"
}

hostnamed_loop() {
    hostnamed_pid=""
    stop_hostnamed() {
        trap - TERM INT HUP
        if [ -n "$hostnamed_pid" ]; then
            kill -TERM "$hostnamed_pid" 2>/dev/null || true
            wait "$hostnamed_pid" 2>/dev/null || true
        fi
        exit 0
    }
    trap stop_hostnamed TERM INT HUP
    while :; do
        /lib/systemd/systemd-hostnamed &
        hostnamed_pid=$!
        if wait "$hostnamed_pid"; then
            # Debian 12 systemd-hostnamed exits successfully when idle. v252
            # has no supported exit-on-idle override, so immediately restore it.
            hostnamed_pid=""
            sleep 0.1
        else
            code=$?
            return "$code"
        fi
    done
}

stop_children() {
    trap - EXIT TERM INT HUP
    rm -f "$RUNTIME/status.json"

    # Let the controller disconnect the session before stopping its D-Bus peers.
    if [ -n "$vpn_pid" ] && kill -0 "$vpn_pid" 2>/dev/null; then
        kill -TERM "$vpn_pid" 2>/dev/null || true
        remaining=50
        while kill -0 "$vpn_pid" 2>/dev/null && [ "$remaining" -gt 0 ]; do
            sleep 0.1
            remaining=$((remaining - 1))
        done
    fi
    for child in $children; do
        kill -TERM "$child" 2>/dev/null || true
    done
    remaining=50
    while [ "$remaining" -gt 0 ]; do
        alive=false
        for child in $children; do
            if kill -0 "$child" 2>/dev/null; then alive=true; fi
        done
        [ "$alive" = false ] && break
        sleep 0.1
        remaining=$((remaining - 1))
    done
    for child in $children; do
        kill -KILL "$child" 2>/dev/null || true
    done
    wait 2>/dev/null || true
}

on_signal() { exit 0; }
on_exit() { code=$?; stop_children; exit "$code"; }
trap on_signal TERM INT HUP
trap on_exit EXIT

test -r /vpn/client.ovpn
test -r /vpn/auth
test -c /dev/net/tun
python3 /usr/local/lib/channelgate-vpn/checks.py validate-env >/dev/null

umask 077
mkdir -p "$RUNTIME" "$LOGS" /run/dbus /var/lib/openvpn3
chmod 0700 "$RUNTIME" "$LOGS" /var/lib/openvpn3
chown _openvpn:_openvpn "$LOGS" /var/lib/openvpn3
chmod 0755 /run/dbus
: > "$RUNTIME/openvpn3-required"
cp /etc/resolv.conf "$RUNTIME/resolv.conf"

/usr/local/bin/cg-vpn-firewall

umask 022
start_child dbus dbus-daemon --system --nofork --nopidfile \
    >"$LOGS/dbus.log" 2>&1
dbus_pid=$child
remaining=100
while [ ! -S /run/dbus/system_bus_socket ] && [ "$remaining" -gt 0 ]; do
    kill -0 "$dbus_pid" 2>/dev/null || break
    sleep 0.1
    remaining=$((remaining - 1))
done
test -S /run/dbus/system_bus_socket

# OpenVPN's services need hostname1 while registering and reconnecting. D-Bus
# activation cannot elevate under no-new-privileges, so supervise a loop around
# hostnamed's expected successful idle exits. A real hostnamed failure tears
# down the container through the ordinary required-child monitor below.
start_child hostnamed hostnamed_loop >"$LOGS/hostnamed.log" 2>&1
sleep 1

for service in log configmgr backendstart sessionmgr; do
    if [ "$service" = backendstart ]; then
        start_child backendstart setpriv --reuid=_openvpn --regid=_openvpn --clear-groups \
            /usr/libexec/openvpn3-linux/openvpn3-service-backendstart \
            --idle-exit 0 --client-log-level 4 --client-log-file "$LOGS/client.log" \
            >"$LOGS/backendstart.log" 2>&1
    else
        start_child "$service" setpriv --reuid=_openvpn --regid=_openvpn --clear-groups \
            "/usr/libexec/openvpn3-linux/openvpn3-service-$service" --log-level 4 \
            --idle-exit 0 \
            >"$LOGS/$service.log" 2>&1
    fi
    sleep 1
done

start_child netcfg /usr/libexec/openvpn3-linux/openvpn3-service-netcfg \
    --idle-exit 0 --resolv-conf "$RUNTIME/resolv.conf" --log-file "$LOGS/netcfg.log" \
    >"$LOGS/netcfg-stdio.log" 2>&1
sleep 1

python3 /usr/local/lib/channelgate-vpn/vpn3.py &
vpn_pid=$!
children="$children $vpn_pid"
required_children="$required_children controller:$vpn_pid"

# Any private service or controller exit tears down the whole namespace.
while :; do
    for item in $required_children; do
        component=${item%%:*}
        child=${item#*:}
        if ! kill -0 "$child" 2>/dev/null; then
            if wait "$child" 2>/dev/null; then code=0; else code=$?; fi
            printf '{"event":"vpn_runtime_stopped","component":"%s","exitCode":%s}\n' \
                "$component" "$code"
            exit 1
        fi
    done
    sleep 1
done
