# VPN and SSH access

Set up access for the task without changing ChannelGate application code. Choose one of the
following paths based on the provider's requirements and the current execution environment.

## Option 1: OpenVPN profiles supported by ChannelGate setup

Use ChannelGate's existing isolated channel VPN service when the supplied OpenVPN
profile and database target fit its supported contract. Read
[Supported OpenVPN setup](#supported-openvpn-setup) before provisioning,
changing or diagnosing the service. Also consult the current `gateway-usage`
reference `references/channel-vpn.md` and the checkout's `docs/CHANNEL-VPN.md`
for the installed deployment's exact interface.

The supported service uses an isolated OpenVPN container and a separate MySQL
extractor, restricted to one database IPv4 address and TCP port. Provisioning is a
host-operator action. Once provisioned, admitted members can inspect status with
`get_channel_vpn_status`; channel managers/admins can switch it with
`set_channel_vpn`; admitted members can make bounded reads through
`query_channel_database` when Network is on and the service is connected.
Discover the tools actually exposed in the current run before using them.

The ordinary agent container does not join the VPN. Uploading a profile or adding
Secrets alone does not provision the service. Do not promise shell access to the
private database from the agent container. A provider profile outside the importer's
contract, a different protocol, or a database requiring unsupported TLS settings
calls for Option 2 or an operator handoff; never weaken validation to make it fit.

## Option 2: Agent procedure — VPN or SSH tunnel access

Use this when a task needs a private network or database and the supported
ChannelGate OpenVPN service does not fit, or an SSH bastion is supplied.
Set up the connection for the task without changing ChannelGate application code.

1. **Identify the access path.** Record the target host, port, protocol, intended
   environment, and who owns access. Use an **SSH local port forward** for one TCP
   service when an SSH bastion is supplied. Use the provider's **VPN client or
   approved profile** when the target requires VPN routing. Check the current
   execution environment and network permissions; use host/operator access only
   when authorized. Do not assume the ordinary agent container can run a VPN or
   reach a host-side tunnel.

2. **Prepare access.** Put credentials in the conversation/channel Secrets UI or
   an approved secret store, never in chat, source files, command arguments, or
   logs. Verify the SSH host-key fingerprint or VPN server identity with the
   provider. If using first-use trust, state clearly that identity remains
   unverified and pin the observed key; never disable host-key or certificate
   checks. Use the least privileged database account available.

3. **Connect in isolation.** For SSH, bind a temporary **localhost-only** port,
   forward only the required remote host and port, and close it when the task
   ends. For VPN, use an isolated container or approved channel VPN service with
   access restricted to the required destinations. Do not alter the shared host's
   default route. Keep different connections in separate processes or network
   namespaces so they do not overlap. A host connection is not automatically
   available inside an ordinary channel container.

4. **Verify in layers.** Confirm connection state, DNS/route or SSH forwarding,
   target TCP port, database authentication, then one bounded read-only query.
   Stop at the failing layer and report it without revealing secrets or customer
   data. Respect any environment-specific time windows and query guards.

5. **Close and hand off.** Stop the tunnel or VPN session when no longer needed.
   Record the connection method, required Secret **names**, how to reconnect,
   MFA requirements, tested endpoint, and any unverified identity. If access must
   survive restarts, ask the host operator for a supervised isolated service; do
   not build a general ChannelGate feature for a single connection.

## Runtime and lifecycle checks for either option

- Use the current run's resolved mount and network facts. Admin mode or an
  operator-home mount does not turn a container into a host process. Host work
  requires an authorized host/operator execution path, such as an admin's
  direct-host `/sudo` thread.
- Network on does not grant arbitrary private routing or raw sockets. Respect
  proxy refusals and the deployment's declared raw-socket destinations; do not
  bypass the egress policy or expose a localhost tunnel on a public interface.
- HTTPS credential placeholders cannot authenticate an SSH or database protocol.
  Use the approved secret mechanism for that protocol. If raw credentials are
  needed, have an admin configure their authorized delivery; never request
  secret values in chat.
- For SSH, keep the forward and consuming client in the same reachable execution
  environment, track the process you started, and verify the target connection;
  an established SSH session alone does not prove database connectivity.
- Clean up connections created for this task, including on failure. Do not stop
  another task's service or disable an existing persistent channel VPN merely
  because your query ended. Leave a persistent service running only within its
  established authorization, and state its final status in the handoff.

## Supported OpenVPN setup

Source of this runbook: the ChannelGate checkout's `docs/CHANNEL-VPN.md` and the
injected `gateway-usage/references/channel-vpn.md`. Check the installed version
before acting; use its documented commands and status diagnostics.

### Inputs and boundary

Collect the registered channel ID, project name, provider-supplied OpenVPN
profile, database IPv4 address and TCP port, and access owner. Use a read-only
MySQL account. The project name must match `[a-z][a-z0-9-]{0,47}` and cannot be
renamed without retiring the service.

The host operator runs setup as the OS account owning the gateway and its
rootless Podman runtime, with the user systemd bus and required TUN support.
An ordinary channel container cannot provision this service.

Store `VPN_USERNAME`, `VPN_PASSWORD`, `MYSQL_USERNAME` and
`MYSQL_PASSWORD` in the selected channel's Secrets UI. Custom Secret names can
be mapped with `--vpn-user-secret`, `--vpn-password-secret`,
`--mysql-user-secret` and `--mysql-password-secret`.

The provider's `.ovpn` profile can itself contain private keys. Deliver it
through the approved file mechanism into that channel's working folder, as a
regular operator-owned file with mode `0600`, never a symlink/hardlink. Do not
paste its contents into chat, print it, or commit it to source control. This
protected importer input is distinct from storing credentials in source files.

The importer accepts one TCP remote, a TUN client, inline CA/certificate/private
key, optional inline TLS keys, and a small allowlist of client options. It rejects
scripts, plugins, management interfaces, external file references, additional
connections, UDP and broad routes. It regenerates configuration with
`route-nopull`, server certificate verification and one database route.
An import or certificate failure is a failure to resolve, never grounds to
disable verification or relax the importer.

### Operator runbook

Substitute the confirmed non-secret values. Run from the appropriate checkout
on the gateway host, with Network enabled for this channel:

```sh
npm run vpn -- configure --channel C_EXAMPLE --project crm-readonly \
  --profile /path/to/channel/client.ovpn --db-host 10.20.30.40 --db-port 3306
npm run vpn -- build --channel C_EXAMPLE
npm run vpn -- install-unit --channel C_EXAMPLE
npm run vpn -- enable --channel C_EXAMPLE
npm run vpn -- status --channel C_EXAMPLE
npm run vpn -- verify --channel C_EXAMPLE
```

When using a helper checkout beside a separately installed gateway, follow the
operator documentation for `--gateway-source` on every command. Do not point
a newer store or migration path at an unrelated deployment.

For an existing supervised service, disable it before reconfiguring a profile
or target, rebuilding, or manually installing an updated unit. Restart after
Secret rotation. Do not interrupt an existing service without authorization
for that change.

### Verify, use and close

"Starting" is not "Connected": check both service containers, tunnel and database
route readiness. Operator `verify` runs only `SELECT 1` and `SHOW DATABASES`.
Report sanitized status or missing Secret names, never provider logs containing
credentials, profile keys or customer rows.

From an ordinary channel use `query_channel_database` for structured
`list_databases`, `list_tables`, `describe_table`, `count_rows` or
`select_rows` operations. Row selection uses explicit columns and bounded
limits (at most 100 per page); it does not accept arbitrary SQL, writes or
alternate destinations. A truncated or failed response is not an empty result.

The database transport is plain TCP inside the encrypted tunnel. Do not claim
database TLS is negotiated. If the provider requires it, use an approved
alternative under Option 2 or hand off to the operator.

Once configured, the selected VPN/database Secrets are withheld from new agent
environments and remain with the protected service. Do not try to extract them.

Enabling the service also configures supervised automatic startup. When a
task-specific service is no longer needed, a manager/admin can turn it off with
`set_channel_vpn({enabled:false})`, or the operator can run:

```sh
npm run vpn -- disable --channel C_EXAMPLE
```

Disabling preserves configuration and Secrets. Record whether the service was
stopped or remains running under an existing persistent authorization, plus
the reconnect steps, Secret names, MFA requirements and verified endpoint.
