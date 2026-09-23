# SSH access to channel containers

Developers can open a real SSH session — terminal, VS Code Remote-SSH, sftp, port forwards —
inside a channel's own container, the same box the assistant works in, without any account on
the gateway host and without any container ever listening on a port. One key per person,
registered once from chat; access granted per channel by that channel's managers; the container
stays up for as long as a session is open.

## How it works

```
laptop ──ssh──▶ gateway host: login account `channelgate-ssh`
                  sshd Match block → ForceCommand cg-ssh-attach (no pty, no forwarding, no shell)
                    │  unix socket: which key, which channel
                    ▼
                ChannelGate daemon (src/gateway/ssh-broker.js)
                  key → registered user → channel admits them → SSH grant → not home-mounted
                  container lease (never idle-stopped while the session lives)
                  prepares <artifacts>/ssh/{sshd_config,authorized_keys}, refreshes the Claude relay
                    │  podman exec -i <container> cg-sshd      (sshd -i on stdio, unprivileged)
                    ▼
                the channel container: the developer's ssh client completes a SECOND handshake with
                this sshd, so the pty, the shell, sftp and every port forward live in the container
```

Two hops, on purpose. The outer hop authenticates the person and names the channel; everything a
client could ask of the host is denied there (`restrict` on every key line, `ForceCommand`,
`PermitTTY no`, no forwarding, no agent, no rc file). The inner hop is a full SSH session served by
an sshd running *inside* the container as the unprivileged `agent` user, in inetd mode on the byte
stream the daemon piped through. The container's network namespace is where forwards land, which
is what makes VS Code Remote-SSH and "forward my app's port 3000" work.

## Operator setup (once)

Prerequisites on the gateway host: `openssh-server` with `Include /etc/ssh/sshd_config.d/*.conf`
at the top of `/etc/ssh/sshd_config` (Debian/Ubuntu default), a Node install the installer can find (it looks on root's `PATH`, then in the invoking user's and the service account's `~/.local`, nvm, volta and fnm trees, then the system locations; `CG_NODE_BIN` overrides), and the channel
image rebuilt at spec 1.4.0 or later (`npm run build:image` — it now ships `openssh-server` and the
`cg-sshd` helper; containers are recreated on their next turn).

```bash
sudo CG_SSH_HOST=ssh.example.com CG_SSH_PORT=22 bash scripts/install-ssh-access.sh
```

`CG_SSH_HOST`/`CG_SSH_PORT` are the address and port at which developers reach **this machine's
sshd** — a NAT-forwarded port on the office router, a VPN name, a bare IP. They are NOT the
gateway's web URL: a hostname behind an HTTP proxy such as Cloudflare never carries SSH, and the
connection block would simply hang. The installer probes the address and compares the answering
host key with this machine's own; a different key aborts, no answer is a warning (NAT hairpin
often refuses a self-connection). The recorded values live in `endpoint.json` and go straight
into every `show_channel_ssh` block, so fix them by rerunning the installer.

The installer is idempotent and creates:

- the login account (`CG_SSH_USER`, default `channelgate-ssh`): system account, locked password,
  home under the attach dir, `/bin/sh` only so sshd can run the forced command;
- the attach directory (`CG_SSH_DIR`, default `/var/lib/channelgate-ssh`), owned by the daemon's
  account and group-owned by the login account (mode 2750): `endpoint.json` (what developers are
  told), the daemon-exported `authorized_keys` (0640) and the daemon's `attach.sock` (0660);
- root-owned copies of `scripts/cg-ssh-attach.mjs` and `scripts/cg-ssh-authorized-keys` under
  `/usr/local/lib/channelgate/` (the login account cannot read the checkout; sshd insists an
  `AuthorizedKeysCommand` is root-owned);
- `/etc/ssh/sshd_config.d/channelgate.conf`, validated with `sshd -t` and reloaded.

Other knobs: `CG_SSH_PORT` (the host sshd's port, default 22), `CG_SERVICE_USER` when the daemon
does not run as `channelgate`/`claude-gateway` (it defaults to the checkout's owner),
`CG_NODE_BIN`. The installer keeps a root-owned COPY of the Node binary beside the wrapper (`/usr/local/lib/channelgate/node`), because the login account cannot traverse a per-user install under a private home; re-run the installer after upgrading Node or after an update that changes `scripts/cg-ssh-attach.mjs`. It never fails silently: every abort names the failing line.

The daemon needs no restart: it checks the directory every minute, closes any session records a
previous daemon left open, exports the registered keys and binds the socket. Its boot log says
`[ssh] attach socket …`. Until then every `add_my_ssh_key` answers that the host is not set up
yet, and `show_channel_ssh` names the installer.

## Developer flow

1. **Register your key once**, in any channel or DM with the assistant:
   "add my SSH key `ssh-ed25519 AAAA… me@laptop`" (the `.pub` line, never the private key). The
   assistant answers with the SHA256 fingerprint. Keys are per person, up to five, and a key can
   belong to one account only.
2. **Get granted on a channel**: a manager of that channel (an admin, or whoever `manageAccess`
   names) says "grant SSH access to @you" there. Grants are per channel, audited as
   `channel_meta_changed` (`sshUsers`), and never admit someone the channel's access policy
   would refuse.
3. **Connect**: "show SSH access" in the channel prints the block to paste into `~/.ssh/config`:

   ```
   Host acme-app
     HostName acme-app
     User agent
     ProxyCommand ssh channelgate-ssh@gateway.example.com acme-app
   ```

   Then `ssh acme-app`, `sftp acme-app`, `ssh -L 3000:localhost:3000 acme-app`, or VS Code
   Remote-SSH → `acme-app`. The channel rides in the ProxyCommand: one key, one config block per
   channel, several channels at once. The first connection records the channel's own host key.

Inside, you are user `agent` in the channel's work folder, with the channel's persistent
`/home/agent` (installed tools, `gh`/`vercel`/`supabase` logins, Claude and Codex history).
`claude` uses the gateway's relayed operator login (refreshed every 20 minutes while a session is
open, the same relay as `npm run vscode`); Codex uses the shared sign-in mount. Everyone in a
container is that one `agent` user: set your git identity per session, and expect to see other
sessions' processes. A daemon restart drops brokered sessions — reconnect.

## What the daemon checks on every connection

- the presented key is registered (unknown keys are refused before anything else is looked up);
- its owner is an approved user or an admin;
- the channel exists and admits that user (`isAuthorized()`: the channel's access policy, guest
  grants, DM peer);
- the user is on the channel's `sshUsers` grant list;
- the channel would **not** mount the operator's home: while a channel is in Admin mode and the
  gateway's `containerFullAccessHome` switch is on, SSH is refused with that reason. That mount
  is for an admin's own chat turns, never for a developer's shell.

Every refusal is one line in the developer's terminal naming the remedy, and an
`ssh_attach_refused` event. Every accepted session is an `ssh_session_start` / `ssh_session_end`
pair in `events` and a row in `ssh_sessions` (who, which channel, from where, how long, why it
ended); `show_channel_ssh` lists the live ones.

## Security model, plainly

- **The host side can do nothing.** `channelgate-ssh` has no password, no shell of its own, no
  container access and no home content; sshd forces the attach wrapper and denies pty, forwarding,
  agent forwarding, tunnels and rc files; every exported key line repeats `restrict,command=`.
  A bug in the wrapper escapes to an account that can only talk to the daemon's socket, and the
  daemon re-verifies everything.
- **Nothing listens.** The in-container sshd runs on stdio for one session; there is no port on
  the host or in the container. The host sshd's single port is the only door.
- **Revocation is immediate for new connections** (the host file is regenerated on every key
  change; the container file on every attach). An already-open session ends when it disconnects;
  a manager who needs it gone now stops the container (`podman stop`) or restarts the daemon.
- **Sessions hold a container lease.** The idle reaper and the max-running eviction never stop a
  container with a live session, and a container rebuild waits for the session like it waits for
  a run. `ClientAlive` inside the container reaps a dead TCP peer in about three minutes, so a
  laptop that vanished cannot pin a container forever.
- **Channel secrets are not in the session's environment** — they ride each run's private
  env-file — but a shell shares the container with live runs and can read a running turn's
  `/proc/<pid>/environ`, the channel's CLI logins in `/home/agent`, the Codex sign-in mount and
  the Claude relay token file. Grant SSH as you would grant a login to the project box.
- **Agent forwarding is off** inside the container: every session is the same uid, so a forwarded
  agent would be usable by anyone else in the box.

## Files and troubleshooting

| Where | What |
| --- | --- |
| `/var/lib/channelgate-ssh/endpoint.json` | host, port, login account, attach command (installer-written) |
| `/var/lib/channelgate-ssh/authorized_keys` | every registered key, `restrict,command=` (daemon-written) |
| `/var/lib/channelgate-ssh/attach.sock` | the daemon's attach socket (0660, group = login account) |
| `/etc/ssh/sshd_config.d/channelgate.conf` | the Match block for the login account |
| `<artifacts>/<platform>/<slug>/ssh/` | `sshd_config`, `authorized_keys`, `host_key` for the container (identical path inside) |
| `gateway.db` → `ssh_keys`, `ssh_sessions`, `events` | keys, sessions, audit |

- *"this SSH key is not registered"* — register it from chat; the key must be the same one the
  ssh client offers (`ssh -v` shows which).
- *"you have no SSH grant on …"* — a manager grants it in that channel.
- *"the gateway attach socket is unavailable"* — the daemon is down, or the installer ran with a
  different `CG_SSH_DIR` than the daemon's `CHANNELGATE_SSH_DIR`.
- *Host key changed* warnings — the channel's `ssh/host_key` was removed (a deleted channel
  artifact dir); remove the stale `known_hosts` line.
- *Connection drops on daemon restart* — expected; reconnect.
- `journalctl -u channelgate | grep '\[ssh\]'` shows binds, sessions and relay refresh failures.
