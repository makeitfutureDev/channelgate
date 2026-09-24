# Isolated VPN database service

The optional operator helper provisions a dedicated rootless Podman OpenVPN 3 Linux service and an
unprivileged MySQL verification/extractor container. Ordinary channel containers keep their existing
capabilities, mounts, image and bridge network. There is no Docker/Podman socket inside either
service container and no published port. Provisioning is operator-only; a channel manager or
organization admin can then switch the prepared service on/off through chat or settings.

Only the VPN service has `/dev/net/tun` and `NET_ADMIN`. Its private D-Bus services also
receive the limited UID/GID/capability-transition and file-access capabilities they need; no
host D-Bus socket is mounted. The extractor shares its network namespace,
but has no network capabilities, TUN device, VPN keys, engine credentials, gateway socket or host
home mount. A firewall permits only the configured database IPv4 address and TCP port through
`tun0`, blocks that database address outside the tunnel even during disconnects, rejects other
tunnel traffic, and blocks tunnel IPv6. Public traffic retains the rootless interface/default route
(`tap0` with slirp4netns on some hosts, `eth0` on others). No host routing/firewall changes occur.

## Use from chat and settings

After the operator completes setup below, use any of these controls:

- Ask the channel agent to “turn VPN on”, “turn VPN off”, or “check VPN status”. Claude and Codex
  use `set_channel_vpn({enabled:true|false})` and `get_channel_vpn_status` for the current channel.
- In the admin web UI, open the channel and use **VPN** beside **Network**. Changes save immediately.
- In Slack, open the channel's **⚙️ Settings → General Settings**; the **VPN** row sits under the
  Auto/Lean/Network switches, with **Turn on** / **Turn off** / **Refresh**.

Channel managers and organization admins may switch it; admitted members may read its status.
Tool calls retain the gateway's normal control-plane approval policy. Every mutation rechecks
current access at the effect boundary. The web interface requires an active admin session.
Uploading an `.ovpn` file and adding Secrets alone does not perform the operator setup.

ON enables automatic startup and starts connecting. **Starting** is not **Connected**: connected
requires both containers, a working tunnel and database route. OFF disables automatic startup and
removes the owned pair, including containers previously started manually. Network off or missing
Secrets prevent startup but never prevent stopping. The supervisor also stops an active pair when
Network is disabled. Status shows only fixed diagnostic messages and missing secret names;
provider logs, profile keys and credential values never appear in these controls.

Certificate failures remain errors: never disable `remote-cert-tls server` to bypass verification.
OpenVPN 3 uses the same core library as OpenVPN Connect; the older OpenVPN 2 service image is
no longer used for new starts.
The tunnel serves only the dedicated database extractor, not the ordinary agent container.

## Read the database from the channel

Once status is **Connected**, ask the agent to list available databases or tables, describe a
selected table, or read up to 100 matching rows. Claude and Codex use `query_channel_database`.
It accepts structured operations, never arbitrary SQL, connection URLs, hostnames or credentials:

```json
{"operation":"list_databases"}
{"operation":"list_tables","database":"example"}
{"operation":"describe_table","database":"example","table":"customers"}
{"operation":"select_rows","database":"example","table":"customers","columns":["id","name"],"filters":[{"column":"active","value":true}],"limit":20}
```

Reads require current channel admission, Network on and a ready VPN/extractor pair. Turning VPN
on/off still requires a channel manager/admin. The tool pins the owned extractor container, checks
its tunnel namespace, and sends its request over stdin. The database credentials remain in the
extractor's protected file. Once a VPN service is configured, its selected VPN/database secret
references are excluded from new foreground and background agent process environments; unrelated
channel secrets keep their existing behavior. Existing running processes retain their environment
until they exit. Reads use a read-only transaction, parameterized values, validated
identifiers, bounded rows/output and a finite timeout. Use a provider-issued read-only account as
an additional database-enforced restriction. SQL expressions, writes, stored procedures, file
operations and arbitrary queries are not supported. Large results are truncated or refused; the
agent must request a narrower selection. This does not grant the agent a shell inside the service.

## Configure and start

Run as the OS account owning the gateway and its rootless Podman runtime, with its user systemd
bus available. The host needs `/dev/net/tun`, Podman, slirp4netns, flock and Node meeting the gateway's
minimum. No host packages are installed by this helper. The dedicated image pins OpenVPN 3 Linux
27.1 from the signed official package repository, verifies the repository key checksum, and includes
iptables, route tools and the database client; the ordinary ChannelGate image does not change.

Add these values through the selected channel's Secrets panel, never in command arguments:

- `VPN_USERNAME`, `VPN_PASSWORD`
- `MYSQL_USERNAME`, `MYSQL_PASSWORD` (use a provider-issued read-only database account)

Place the `.ovpn` profile in that channel's working folder. The importer requires a bounded regular
file owned by the operator, rejects symlinks/hardlinks and restricts it to mode `0600`. It accepts
one TCP endpoint, a TUN client, inline CA/certificate/private key, optional inline TLS keys and a
small set of validated client options. Scripts, plugins, management endpoints, external files,
extra connections and broad routes are rejected. It regenerates the configuration with
`route-nopull`, server certificate verification, fixed credential paths and exactly one database
route. The OpenVPN 3 driver translates this protected configuration to client-compatible directives
and supplies username/password through its container-private D-Bus API. Authentication values never
ride process arguments or logs.

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
agent query tool exposes only the bounded read operations above. This helper does not change
database grants.
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
supervision; inspect `status`/`verify` to confirm actual readiness. Before starting, it verifies
the image version and source digest and refreshes the supervisor into an immutable private bundle.
A running obsolete service is restarted onto that bundle. Missing/stale images refuse startup
with the build remedy; the service does not silently fall back to OpenVPN 2. Boot without an interactive
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
the image or manually installing an updated unit. Restart the service after secret rotation. Kernel locks
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
podman build --format docker -t localhost/channelgate/vpn:2 services/vpn-image
python3 -B services/vpn-image/live_acceptance.py
```

The live fixture creates two uniquely named disposable containers with synthetic addresses. It
proves real TUN/network capabilities, firewall counters, allowed/denied destinations, public
connectivity, extractor isolation and tunnel-loss blocking, then removes only those fixtures. It
uses no customer credentials and does not claim that a real VPN authentication or MySQL login
succeeded. A provider-backed `verify`, secret rotation, service restart and boot recovery remain
separate live acceptance gates.

After upgrading, rebuild the dedicated image when its source digest changes, then turn VPN on
from the channel controls. ON refreshes the protected supervisor automatically. Operator
`install-unit` remains available for preparing a unit without starting it.
