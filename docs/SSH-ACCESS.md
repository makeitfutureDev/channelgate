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

To open VS Code directly on the channel folder, use the command "show SSH access" prints:
`code --remote ssh-remote+acme-app <channel folder>`. Connecting from Remote-SSH's own menu opens an
empty window instead; its File → Open Folder dialog starts in the channel folder (a custom work
folder included), because every session seeds `files.dialog.defaultPath` in the container's VS Code
machine settings — merge-only, and never over a value you set yourself.

Inside, you are user `agent` in the channel's work folder (an interactive login starts there;
image spec 1.5.1), with the same environment an engine turn gets and the channel's persistent
`/home/agent` (installed tools, `gh`/`vercel`/`supabase` logins, Claude and Codex history).
Codex uses the shared sign-in mount, and `codex` in a session gets what a chat turn's Codex gets:
the gateway tools, your own Composio accounts as `composio-user`, the channel's as
`composio-agent`, the channel's selected MCP servers and your channel secrets. Started from your
home, `/` or a parent of the channel folder it moves into the channel folder so its `AGENTS.md`
applies. Like Claude's claude.ai connectors, the ChatGPT connectors of the shared Codex sign-in
(`codex_apps`) are off in a session except apps the channel selected — they belong to the
operator's account. For any other command, `with-secrets <command>`
runs it with your channel secrets (bare `with-secrets` prints how to load them into the shell).
Everyone in a container is that one `agent` user: set your
git identity per session, and expect to see other sessions' processes. A daemon restart drops
brokered sessions — reconnect.

### `claude` in a session is a chat turn's Claude

Before your shell starts, the daemon prepares the session the way it prepares a turn in that
channel, refreshes it every 20 minutes while any session is open, and re-prepares it within a
second of a change that concerns it (a secret or MCP selection added to the channel, an
organization secret, your own secrets or Composio token). A `claude` that is already running
keeps the environment and servers it started with, like any process. For a NEW secret the
running `claude` needs no restart: `list_secrets` is live, `CG_SESSION_ENV` names the session's
current env file, and the assistant sources it in the same command (`. "$CG_SESSION_ENV"; gh …`).
A new MCP server does need a new `claude`; the SSH connection itself needs no reconnect. What a
session gets:

- **The channel's tool policy and MCP allowlist** — the same lockdown file every turn runs with.
- **The same MCP servers a turn gets:** the gateway's control tools (memory, schedules, skills,
  channel settings, the bot's Slack tools; not the background-job, progress and approval-card
  tools, which speak into a thread a session does not have), `composio-user` for YOUR connected
  accounts, `composio-agent` for the channel's, the toolboxes and the channel's selected catalog
  servers — and nothing else (`--strict-mcp-config`): the operator's own claude.ai connectors
  are not loaded.
- **The run environment:** the organization's, your own and the channel's secrets, by the names a
  turn is told about, sourced by the `claude` wrapper so Claude's tools have them. Your shell can
  read them too (`env`), exactly as a turn's process can read its own. Behind the egress proxy
  (the default) they are **placeholders** — see "Network and secrets inside a session" below.
- **The gateway's Claude login, shown as the account it is:** `/status` says "Claude Max
  account" with the operator's organization and email, `/usage` shows the plan's windows, and the
  default model is the plan's. It is the operator's login (the same one every turn uses): your
  session's usage counts against it. Claude reads the login from an access-only file the daemon
  writes and refreshes; it holds no refresh token and is removed when the channel's last session
  ends. Behind the egress proxy its access token is the channel's relay placeholder (the plan,
  expiry and rate tier beside it are the real login's — they are facts, not secrets), so the file
  is useless outside the container. `claude -r <session id>` resumes a thread's own session.

Codex over SSH is unchanged (its login is the shared sign-in mount). "show SSH access" in the
channel prints what a session gets. If a part could not be prepared — no Claude login on the
host, a channel whose Composio session is unavailable — the attach still succeeds and the daemon
log names the part.

## Network and secrets inside a session (the egress proxy)

Channel containers run with `--network none` and reach the outside only through the gateway's
egress proxy (image spec 1.6.0). An SSH session is inside that container, so the same rules apply:

- **The proxy environment is set for you.** sshd starts every session with a clean environment,
  so the daemon writes the complete proxy/CA set (`HTTP(S)_PROXY` → `http://127.0.0.1:3128`,
  `NO_PROXY`, `NODE_USE_ENV_PROXY=1`, the CA-bundle variables → `/run/channelgate/egress-ca.pem`,
  `CG_EGRESS=proxy`), Chromium's proxy arguments for your own `agent-browser`
  (`AGENT_BROWSER_ARGS`) and `GIT_SSH_COMMAND` into the session's one `SetEnv` line, and again at
  the top of the session's env file — so `. "$CG_SESSION_ENV"` (and `with-secrets`, and the
  `claude`/`codex` wrappers) re-assert them if a shell changed them. `ALL_PROXY` is unset. The
  channel's *Allow network* switch is enforced there: off, only the engine endpoints and the
  channel's connectors answer (`curl` gets `403 network-off`); on, any public host.
- **Secrets are placeholders.** Every secret with an egress rule (the built-in GitHub, Vercel,
  Supabase, Make and Composio names, or one an admin marked *Used on hosts*) is a `cgph_…`
  placeholder in your environment. The proxy swaps in the real value only on that secret's hosts,
  so `gh`, `vercel`, `git` over HTTPS and `curl -H "Authorization: Bearer $TOKEN"` work as usual and
  `printenv` shows nothing worth copying out. A secret without a rule is still the raw value and
  flagged *unprotected* (the session status and `session.md` name it); with *Withhold unprotected
  secrets* on it is not in the session at all.
- **Your personal secrets pause while someone else is attached.** A personal placeholder swaps
  only while its owner is working in the channel (a turn, a job or your own session) and **no other
  person** has an SSH session open there. While one is, the proxy answers
  `403 secret-refused … another-person-ssh-session` for your personal secrets — and for every other
  member's personal secrets while you are attached — and each turn's credential note says
  personal secrets are paused. Channel and organization secrets are not affected.
- **`-L` forwards to external hosts no longer work.** A local forward is dialled from inside the
  container, which has no route: `ssh -L 5432:db.example.com:5432 acme-app` fails. Forwards to
  container-local ports (`ssh -L 3000:localhost:3000 acme-app`) and every `-R` forward are
  unchanged. Reach an external database through the channel's VPN/database helper, or ask an admin
  to declare its host as a raw host (`egressRawHosts`, ports 22/5432/6543) and connect from inside.
- **Outbound SSH goes through a helper.** `git clone git@github.com:org/repo.git` works in a
  session as is: `GIT_SSH_COMMAND` runs `ssh -o ProxyCommand='/opt/channelgate/bin/cg-egress-connect
  %h %p'`, which asks the proxy for a raw tunnel. The proxy allows one only to `github.com:22` and
  the channel's declared raw hosts, and only with *Allow network* on. For your own `ssh`, pass the
  same option (`ssh -o ProxyCommand='/opt/channelgate/bin/cg-egress-connect %h %p' user@host`) or
  add it to a config of your own — the gateway never writes the shared `~/.ssh`. The first
  connection asks you to accept the host key as usual. The proxy **cannot inject an SSH key**: you
  authenticate with a key you bring (agent forwarding is off, so it has to be in the box, where
  everyone in the channel can read it — prefer a deploy key scoped to one repository), and a
  destination-restricted key broker is a later item.
- **VS Code servers.** Client versions the image pre-installs need no download. For any other
  version the Remote-SSH installer's `curl` goes through the proxy environment, so it needs *Allow
  network* on; with it off, set `"remote.SSH.localServerDownload": "always"` on your laptop so the
  client downloads the server and copies it in over the session.
- **The editor token file.** `<artifacts>/vscode/claude-token` (read by the `claude` wrapper
  outside an SSH session, e.g. a `podman exec` shell or an operator's `npm run vscode` window) holds
  the same relay placeholder, and is removed when the channel's last session ends as well as when
  the `npm run vscode` launcher exits. An open `npm run vscode` window counts as live work for the
  channel's own and organization secrets and the Claude login, never for anyone's personal ones.

Under the legacy *Legacy open network* mode, a channel's `rawNetwork` escape or a `/sudo` thread
none of this applies: values are real, and the network is the container's own.

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
- **A session has the channel's secrets, like a turn does — as placeholders.** They sit in
  per-developer files under the channel's artifact dir (`ssh/users/<id>/`), selected by the
  `CG_SSH_USER` name sshd sets from the developer's own key line and admits nothing else for. The
  files are per developer for correctness — your `composio-user` is yours — not for secrecy from
  each other: everyone in the box is one uid, and a shell can read a running turn's
  `/proc/<pid>/environ`, the CLI logins in `/home/agent`, the Codex sign-in mount and the Claude
  login file anyway. Behind the egress proxy that is bounded: what anyone in the box can read is a
  placeholder that only works from inside it, on its declared hosts, while the channel has live
  work (a personal one only while its owner is here and nobody else is attached); the MCP tokens
  are relayed by the daemon and never in the box at all. Unprotected secrets and the CLI logins in
  `/home/agent` are still real. Grant SSH as you would grant a login to the project box.
- **The Claude login file holds no refresh token.** It cannot rotate the operator's session or
  sign the host out; it expires with the access token and is rewritten by the 20-minute refresh.
- **Claude never self-updates inside a channel** (`DISABLE_AUTOUPDATER=1` on every container): a
  copy it once installed into `~/.npm-global/bin` — first on the image PATH — had replaced the
  pinned CLI for every turn in that channel and shadowed the login wrapper.
- **Agent forwarding is off** inside the container: every session is the same uid, so a forwarded
  agent would be usable by anyone else in the box.

## Files and troubleshooting

| Where | What |
| --- | --- |
| `/var/lib/channelgate-ssh/endpoint.json` | host, port, login account, attach command (installer-written) |
| `/var/lib/channelgate-ssh/authorized_keys` | every registered key, `restrict,command=` (daemon-written) |
| `/var/lib/channelgate-ssh/attach.sock` | the daemon's attach socket (0660, group = login account) |
| `/etc/ssh/sshd_config.d/channelgate.conf` | the Match block for the login account, plus an `AllowUsers`/`AllowGroups` line when the host restricts logins |
| `<artifacts>/<platform>/<slug>/ssh/` | `sshd_config` (its one `SetEnv` carries the container env + the proxy set), `authorized_keys`, `host_key` for the container (identical path inside) |
| `<artifacts>/<platform>/<slug>/ssh/users/<id>/` | one developer's `env` (proxy set first, then secrets — placeholders behind the proxy), `session.md`, `settings.json`, `mcp.json`, Codex's `codex-args.sh` + `codex-secrets.json` (the capability only) |
| `<artifacts>/<platform>/<slug>/vscode/claude-token` | the Claude login the wrapper reads outside an SSH session (the relay placeholder behind the proxy); removed with the channel's last session |
| `gateway.db` → `ssh_keys`, `ssh_sessions`, `events` | keys, sessions, audit |

- *`channelgate-ssh@…: Permission denied (publickey)`* straight away, with nothing in the daemon
  log — the **host** sshd refused the login account before the gateway was ever asked, and a
  refusal by an access list looks exactly like a wrong key. Most often an `AllowUsers` or
  `AllowGroups` line in a hardening file names the machine's real people and not the login
  account. The installer checks this with `sshd -T -C user=channelgate-ssh,…` and appends the
  account to the list inside `channelgate.conf` (lists accumulate; your own line is untouched), so
  rerunning it is the fix (a rerun keeps the configured endpoint). A `DenyUsers`/`DenyGroups`
  match cannot be overridden and stops the installer with the file to edit.
- *`Too many authentication failures`*, or a refusal only on a laptop with several keys — the
  host's `MaxAuthTries` (often 3 on a hardened host) ran out before your agent offered the key you
  registered. Both hops authenticate separately with that same key, and an `IdentityFile` in the
  `Host` block does **not** reach the `ProxyCommand` hop, so pin it in both places:

  ```
  Host acme-app
    HostName acme-app
    User agent
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    ProxyCommand ssh -p 2222 -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 channelgate-ssh@gw.example.com acme-app
  ```

  Point both paths at the key whose fingerprint `list_my_ssh_keys` shows. If that key lives only in
  an agent (Secretive, 1Password, a hardware key), point them at its **public** key file instead:
  `IdentitiesOnly` then selects that agent key rather than refusing the agent. The generated block
  leaves this out on purpose — a guessed path would lock out exactly those agent-only setups.
- *"this SSH key is not registered"* — register it from chat; the key must be the same one the
  ssh client offers (`ssh -v` shows which).
- *"you have no SSH grant on …"* — a manager grants it in that channel.
- *"the gateway attach socket is unavailable"* — the daemon is down, or the installer ran with a
  different `CG_SSH_DIR` than the daemon's `CHANNELGATE_SSH_DIR`.
- *Attach fails with `ENOENT` although the daemon looks healthy* (`ss -xl` still lists
  `attach.sock` as listening, but the file is gone) — the socket file was deleted underneath a live
  listener. Restart the daemon to rebind it. Current releases never delete a socket another process
  is serving, and log `already served by another process` instead of taking it over; that line
  means a second gateway on this host is using the same attach directory.
- *Host key changed* warnings — the channel's `ssh/host_key` was removed (a deleted channel
  artifact dir); remove the stale `known_hosts` line.
- *`403 secret-refused … another-person-ssh-session`* — someone else has an SSH session open in the
  channel, so personal secrets are paused (above); it clears the moment they disconnect.
  `channel-idle` means nothing is live in the channel — which a session itself is, so it only shows
  up from a shell outside any session.
- *`cg-egress-connect: the gateway's egress proxy refused github.com:22 (403 Forbidden) —
  network-off …`* — outbound SSH needs *Allow network* on; any other host must be a declared raw
  host. `kex_exchange_identification: Connection closed` right after it is ssh's own echo of that.
- *Connection drops on daemon restart* — expected; reconnect.
- `journalctl -u channelgate | grep '\[ssh\]'` shows binds, sessions and relay refresh failures.
