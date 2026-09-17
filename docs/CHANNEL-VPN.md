# Isolated VPN database service

The optional operator helper provisions a dedicated rootless Podman OpenVPN service and an
unprivileged MySQL verification/extractor container. Ordinary channel containers keep their existing
capabilities, mounts, image and bridge network. There is no Docker/Podman socket inside either
service container and no published port. This is an operator CLI, not an agent tool or a new Admin
mode permission.

Only the VPN service has `/dev/net/tun` and `NET_ADMIN`. The extractor shares its network namespace,
but has no network capabilities, TUN device, VPN keys, engine credentials, gateway socket or host
home mount. A firewall permits only the configured database IPv4 address and TCP port through
`tun0`, blocks that database address outside the tunnel even during disconnects, rejects other
tunnel traffic, and blocks tunnel IPv6. Public traffic retains the rootless interface/default route
(`tap0` with slirp4netns on some hosts, `eth0` on others). No host routing/firewall changes occur.

## Configure and start

Run as the OS account owning the gateway and its rootless Podman runtime, with its user systemd
bus available. The host needs `/dev/net/tun`, Podman, slirp4netns, flock and Node meeting the gateway's
minimum. No host packages are installed by this helper. The dedicated image contains OpenVPN,
iptables, route tools and the database client; the ordinary ChannelGate image does not change.

Add these values through the selected channel's Secrets panel, never in command arguments:

- `VPN_USERNAME`, `VPN_PASSWORD`
- `MYSQL_USERNAME`, `MYSQL_PASSWORD` (use a provider-issued read-only database account)

Place the `.ovpn` profile in that channel's working folder. The importer requires a bounded regular
file owned by the operator, rejects symlinks/hardlinks and restricts it to mode `0600`. It accepts
one TCP endpoint, a TUN client, inline CA/certificate/private key, optional inline TLS keys and a
small set of validated client options. Scripts, plugins, management endpoints, external files,
extra connections and broad routes are rejected. It regenerates the configuration with
`auth-nocache`, `route-nopull`, server certificate verification, fixed credential paths and exactly
one database route. CBC profiles explicitly configure modern OpenVPN cipher negotiation.

```sh
npm run vpn -- configure --channel C_EXAMPLE --project crm-readonly \
  --profile /path/to/channel/client.ovpn --db-host 10.20.30.40 --db-port 3306
npm run vpn -- build --channel C_EXAMPLE
npm run vpn -- install-unit --channel C_EXAMPLE
npm run vpn -- enable --channel C_EXAMPLE
npm run vpn -- status --channel C_EXAMPLE
npm run vpn -- verify --channel C_EXAMPLE
```

Secret names can be mapped with `--vpn-user-secret`, `--vpn-password-secret`,
`--mysql-user-secret` and `--mysql-password-secret` during configuration. Only those selected
channel variables are resolved; unrelated credentials are not forwarded. Missing credentials or
disabled channel network policy refuse startup before any service container changes.

The `verify` command executes only `SELECT 1` and `SHOW DATABASES`, returning schema names and
sanitized readiness results. It does not export customer rows or accept arbitrary SQL. The
extractor container remains available for separately authorized extraction work. SQL read-only
privileges must be enforced by the database account; this helper does not change database grants.
The initial contract uses database TCP without TLS inside the encrypted VPN. Providers requiring
database TLS need a separate configuration extension; it is not silently negotiated here.

## Persistence, updates and shutdown

Non-secret desired configuration and secret references live in `channel_meta.vpnService` using
the gateway's existing store. Immutable normalized profile revisions, auth files and the installed
operator bundle live in `~/.channelgate/services/vpn/<owner-id>/`, with `0700` directories and
`0600` files. These paths are not mounted into ordinary channel containers. The VPN receives only
its profile/auth files; the extractor receives only its database credential file. Auth files are
refreshed from current channel Secrets when the service starts. Public container fingerprints are
keyed HMACs rather than password hashes.

`install-unit` reports the exact user service name and the standalone helper path. It installs
without starting or enabling the service. `enable` enables it at user-manager startup and starts
supervision; inspect `status`/`verify` to confirm actual readiness. Boot without an interactive
login requires the operator's existing user-manager/linger setup. `disable` stops it and removes
automatic startup. It preserves configuration and Secrets.

```sh
npm run vpn -- disable --channel C_EXAMPLE
systemctl --user status channelgate-vpn-OWNER.service
journalctl --user -u channelgate-vpn-OWNER.service -n 30
systemctl --user restart channelgate-vpn-OWNER.service
```

The supervisor holds a kernel lock for its lifetime; concurrent reconfiguration and manual
start/stop are refused. Disable the user service before configuring a new profile/target, rebuilding
the helper or installing an updated unit. Restart the service after secret rotation. Kernel locks
release on process exit, including crashes. There are no independent container restarts that could
leave the extractor attached to an obsolete VPN namespace. Lost containers or routes stop the pair
and fail the unit visibly; the operator can correct the cause and restart. The OpenVPN process can
perform its own connection retries while its namespace and firewall remain intact.

For manual foreground-independent operation, `start` creates the pair, and `stop` removes only
containers bearing this service's ownership/role labels. Use `disable` for a supervised service.
Names owned by another workload are never removed. Services use `cg.service.*` labels, not the
normal channel lifecycle's `cg.install` label, so ordinary gateway restarts and idle reaping do
not sweep them.

To use the helper with a separately installed stable gateway, pass
`--gateway-source /path/to/existing/gateway` on each command. It imports that gateway's store
modules and current schema and installs only its own standalone helper closure. It never changes
the stable checkout, upgrades the gateway, or runs newer database migrations against it. An
existing `CHANNELGATE_DIR` override must identify that deployment's runtime root.

## Verification

```sh
node --test test/vpn-profile.test.js test/vpn-service.test.js
python3 -B services/vpn-image/test_checks.py
podman build --format docker -t localhost/channelgate/vpn:1 services/vpn-image
python3 -B services/vpn-image/live_acceptance.py
```

The live fixture creates two uniquely named disposable containers with synthetic addresses. It
proves real TUN/network capabilities, firewall counters, allowed/denied destinations, public
connectivity, extractor isolation and tunnel-loss blocking, then removes only those fixtures. It
uses no customer credentials and does not claim that a real VPN authentication or MySQL login
succeeded. A provider-backed `verify`, secret rotation, service restart and boot recovery remain
separate live acceptance gates.
