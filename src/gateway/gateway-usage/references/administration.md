# Channel & gateway administration

These gateway tools change how a channel or the whole gateway behaves. Most are **admin-only**;
a few are open to **channel managers** (an admin, or — when the channel opts in — an approved
member/listed manager). If you call one without permission, it returns a polite refusal. All
channel-setting changes take effect **on the next message**.

## Composio modes and personal tokens
Two Composio accounts can be injected: `composio-agent` (YOUR own account) and `composio-user`
(the requester's). How each is backed is admin configuration — it changes nothing about how you
use them, and you should not describe your own account to users as “the channel token” or “the
org fallback”. The admin chooses one global Composio mode in Settings:

- **Personal:** a saved user token backs `composio-user`; a channel token, else the organization
  default, backs `composio-agent`.
- **SDK:** one organization SDK key dynamically provisions stable identities for each Slack user
  and channel, with a separate Composio session per Slack thread. Every user can manage the
  connections on their personal identity. Managing `composio-agent`'s connections follows this
  channel's managing rights; other authorized members can use its existing connections.

Switching modes never deletes existing personal, channel, or organization Composio tokens.
`set_my_composio_token` / `clear_my_composio_token` still update the saved Personal-mode credential
while SDK mode is active, but that credential remains inactive until Personal mode is selected
again. The SAFEST way for someone to set their personal Composio key is the bot's **App Home tab**
(the app's Home in the sidebar) → **Connect my Composio key**: that opens a private modal, so the
key never becomes a Slack message. Recommend that first; if they paste a token in chat instead,
tell them to send it in a **DM** and delete the message after — Slack keeps history readable.

Composio's Slack toolkit is how the bot does Slack actions beyond the gateway's own bot tools
(send elsewhere, schedule, canvas, react, cross-channel search — see `references/messages.md`).

Other personal integrations:
- `set_my_toolbox_token` / `clear_my_toolbox_token` — Toolbox.

`composio-agent` always remains separate from every user's `composio-user` connection, and it is
never injected in a **DM** — a one-to-one conversation only ever gets the requester's personal
`composio-user`, in both modes.

## Claude and Codex engine authentication

If someone asks you to fix an expired or missing Claude/Codex OAuth login, tell them they must go
to the **computer or VPS running the gateway** and authenticate the relevant CLI there with their
own subscription account or API key. This is host-side engine authentication: it cannot be repaired
remotely by the Slack agent, by changing a channel setting, or by reconnecting Composio.

Do not ask anyone to paste an engine API key, OAuth token, or subscription credential into Slack.
Give only the appropriate host-side direction (for example, use the engine CLI's login flow or set
the service account's API-key configuration), and let the operator complete it directly on the
gateway host. On a service-account/VPS deployment, follow that host's operations procedure for
injecting the API key and restarting the service rather than attempting interactive OAuth from a
Slack turn.

This section is for engine credentials only. For an ordinary provider CLI's browser/device flow,
use `references/cli-device-login.md`: its waiting process must remain alive in the same assistant
turn until CLI confirmation and identity verification.

## Control-plane tools block on a human Approve click
Every tool below that CHANGES state (modes, network, workdir, Drive link, MCP allowlist,
instructions, gateway guide, tokens) posts a Slack Approve/Deny card and
BLOCKS until someone clicks — the Approve click must come from someone who could authorize the
change themselves (admin-tier tools need an admin's click, manage-tier a manager's; anyone
eligible may Deny or Comment) — auto mode and admin mode do not skip it, and a deny or ~4-minute
timeout refuses the change. A gateway admin can decide the same card from the admin web UI instead
of clicking in chat; that counts as an admin's decision and is recorded as the *admin UI*. `update_gateway` is the one exception: for an admin author it starts
without an extra card when the channel is already in Auto or Admin mode; Read/Worker modes still
prompt. `restart_gateway` skips the extra card only in Admin mode; Auto/Read/Worker still prompt.
Schedules are NOT in this list: `create_schedule`/`delete_schedule` never ask (see
`references/reminders.md`). Call a prompting tool once and wait for the result; don't retry a refusal, and tell the user
what needs approving if they seem unaware. Read-only tools (`list_*`, `get_*`) and in-thread posts
(charts, tables, snippets) never prompt.


## MCP servers allowed in this channel (managers)
- `list_available_mcps` — servers the host offers.
- `list_channel_mcps` — what's allowed here now.
- `add_channel_mcps` / `remove_channel_mcps` — allow/stop MCP servers here (by name).

## Skills granted in this channel (managers)
- `show_channel_skills` — what is active here, by tier, with the context cost.
- `add_channel_skills` / `remove_channel_skills` — grant/revoke catalog skills here (by slug).
- `set_channel_skill_template` — make this channel follow a template (Development, Sales, …) live.
- `add_my_skills` / `remove_my_skills` — any member's OWN tier (their runs only, no card).
- Authoring, proposals, usage, sources, publishing and the organization tier: `references/skills.md`.

## Channel modes (permissions)
The three base modes are **Read-only**, **Worker**, and **Admin**. **Auto** and **Lean** are separate
options beside the mode picker in the web editor and under the Slack reply's Settings button.
Auto approves tool requests for every authorized author. Lean runs without optional skills and
connectors; in Admin mode it applies to non-admins while admins keep full context. Switching
Worker/Admin preserves these options. Choosing Read-only clears Auto; enabling Auto selects Worker.
Every run remains inside its channel container.
- `set_channel_bash` (managers) — Bash + file-edit tools in the working folder.
- `set_channel_auto_mode` (managers) — autonomous: permission prompts auto-approved, folder
  writable. Needed for `run_in_background`.
- `set_channel_admin_mode` (admin) — for **admin authors**, every tool without prompts
  (`--dangerously-skip-permissions`). Non-admin authors get Worker with the selected Auto/Lean options. Still inside the
  container — see "Admin access & the container" below.
- `set_channel_network` (admin) — record whether this channel is meant to have network access
  (needs Bash on to be useful) so `git`/`gh`/`curl` and deploy CLIs may be used; the engines are
  told the answer (Codex read mode refuses network on its own). There is no per-domain allow-list
  to add to. The switch is *advisory*: the container is not actually cut off, so a request may
  succeed while the switch is off — that is not permission. If the switch is off and a task needs
  the network, say so and ask an admin to turn it on (effective on the NEXT message) rather than
  working around it. The current value is in the gateway-managed block at the top of this
  conversation's instruction file.

## Admin access & the container (read this before diagnosing "file not found")

**Verify the actual target before claiming host access.** Parent directories can exist solely
to hold a permitted nested mount: seeing `/home/management` or a gateway-root-shaped directory
does not mean its other children are mounted. Test the named database or configuration path
with metadata-only checks when contents are not requested. A wildcard match elsewhere in the
container image, such as a system service database or a MIME description named `*.sqlite3.xml`,
is not evidence that the gateway's database is exposed. Compare the exact target with this
attempt's resolved mount facts; if its location is unknown, report that uncertainty instead of
identifying an unrelated file as runtime data. Do not save an unverified access claim as memory.

**Every turn runs inside this channel's container — Admin/Full-access mode included.** By default,
the host directory mounts are this channel's working folder, clean workspace and artifact folder
(also backing `/tmp` and `/var/tmp`). The container also has its own home volume (`/home/agent`),
the image's toolchain and a read-only control socket. A host directory chosen as the working folder
is visible in full at its identical absolute path; unrelated host directories are normally absent.

**The operator can deliberately widen Full-access channels to the gateway user's whole home.**
Settings → Container runtime → **Full-access channels see the gateway home**
(`containerFullAccessHome`, off by default) adds a read-write bind mount of that home at its
identical absolute path ONLY when this channel is in Admin/Full-access mode. It includes other
channels' folders and memory, repositories, gateway configuration, logs, metadata and credential
stores under that home. The container engine's storage is masked. This does not mount the whole
host filesystem. The switch is gateway-wide and no MCP tool can flip it; an admin author alone,
Auto, Lean or a tool permission cannot enable the grant. Changing the switch or channel mode
changes the required container mounts; readiness checks reconcile them before the next run.

**The mount belongs to the channel, not the author.** While granted, every admitted author can
read the mounted home through file tools; only an admin author's turn in Admin mode receives
write-capable bypass tools. The container remains the filesystem/process boundary. Read the
**Container access for this run** note in `SKILL.md` for the gateway switch and this resolved
runtime's operator-home mount. If that note has no resolved target, verify current runtime state
before asserting access. Diagnose only paths this runtime actually mounts: an absent host path
does not prove that it was deleted, and a mounted path must not be described as impossible.

**`$HOME` is this channel's home, not the operator's account home.** `~` is `/home/agent` inside
the container and belongs to this channel alone: a login you make there (`gh auth login`,
`vercel login`) or a tool you install stays for this channel's next turns and is invisible to
every other channel.

**Never copy secrets into the working folder.** The folder is often a git checkout and may sync
elsewhere; a credential pasted there can end up committed. A credential this channel should have
is a `/secrets` variable (below) — use its injected environment value, not a project `.env` file.

## Working folder & Drive
- `get_channel_workdir` / `set_channel_workdir` (admin) / `clear_channel_workdir` (admin) — run
  the channel's agent in a real project directory instead of the default folder.
- `list_folders` (admin) — browse host folders to pick one for `set_channel_workdir`.
- `get_channel_drive_folder` / `set_channel_drive_folder` (admin) / `clear_channel_drive_folder`
  (admin) — two-way-sync a Google Drive folder into the channel folder's `Drive/` subfolder.

## This channel's own environment secrets (its own CLI logins)
“Write-only” describes the UI/API listing and reveal contract. A secret injected into a run is
available to that process and its CLI for authorized use; do not claim it is unreadable at runtime.
Listings remain masked and outputs are redacted. Never print a value to demonstrate availability.

This channel can hold its OWN credentials — its own Supabase project, its own Vercel account —
instead of sharing whatever login the gateway host has. Values are stored in channel metadata in
the gateway's SQLite database and injected into the engine process environment at spawn. They
are not written to the project's `.env`; the container backend uses a protected internal
environment file to pass them into the process. Do not read the gateway store or internal files
to discover credentials.

**Start with this attempt's inventory.** The prompt's **[Channel credentials for THIS attempt]**
lists sorted names from the channel variables actually supplied to that run, never values or
token suffixes. It refreshes on resumed turns and overrides earlier inventories, including an
explicit empty result after removal. Clean runs omit it. This is not an inventory of host logins,
MCP accounts or every process environment variable, and a name is not proof of validity, account
ownership or scope. Before asking for a new credential, follow the discovery and account-selection
rules in `SKILL.md`: check relevant skills, these names, permitted non-secret CLI auth status and
the selected account's MCP tools. Missing MCP access alone is not missing API/CLI access.

When shell use is permitted, check only a relevant name without showing its value. For example:

```sh
node -e 'console.log("HUBSPOT_ACCESS_TOKEN present:", Boolean(process.env.HUBSPOT_ACCESS_TOKEN))'
```

This returns a boolean, not the token or its suffix. Never run a full environment dump (`env`,
`printenv` or printing `process.env`), enable shell tracing, or print credentials to debug access.
Use the value directly from the environment inside an authorized API client or CLI invocation.
Check the tool's actual authentication mechanism: some consume an environment variable
automatically; others require an explicit option or request header. Merely naming a variable
`VERCEL_TOKEN` does not establish that a CLI automatically consumes it. Avoid embedding literal
values in commands, generated files, replies or logs. Verify only the requested account and data
scope; never silently fall back to another account or credential. A supplied credential does not
override the channel's tool permissions or *Allow network* policy.

- Anyone authorized to use the agent here manages them in Settings → Secrets, with `/secrets`,
  or the 🔑 reply button, in every channel mode. Admins can also use the
  Admin UI → the channel's card.
- **Settings and API listings never reveal values.** They show masked metadata (name, provider,
  available suffix and who/when); no reveal endpoint exists for channel environment secrets.
  The running process can consume an injected value for authorized work. Do not use that runtime
  access to recover or display a token; re-issue a lost token at the provider and set it again.
- You have no tool for setting them: it is a human action, on purpose. If a task needs a
  credential this channel does not have, say which variable name is missing and point at
  `/secrets` — do not ask anyone to paste a token into the conversation.
- The values are stripped out of your replies automatically, so do not try to echo one to confirm
  it: you will get `[REDACTED]` and you will have taught the user a bad habit.

## Settings inside Slack

The Slack **Settings** reply button is available to every authorized agent user, including channel
guests. It allows editing engine/model/effort, channel skills and templates, MCP connection tokens
and labels, and write-only secrets. Cloud MCP is visible and editable only by current admins.
A separate **Access** tab is visible only to admins and current channel managers. It edits mode,
Admin/full access, Auto, Lean, network, who may use/manage the channel, and named guests/managers. Manager
policy applies to this entire page; changing Full access still leaves run-time bypass admin-author-only.
Every interaction re-checks agent access and channel membership. This console does not grant
admin rights or change the permissions required by separate gateway control tools.

## Updating the gateway itself (Enterprise admin)
- Managed updates require an active Enterprise entitlement. Other editions show their commit count
  behind and must be updated manually by the host operator using `npm run update` in the checkout.
- The managed runner starts in a separate systemd user service so it survives the daemon restart.
  Long phases continue reporting; an absent runner is reported as interrupted, never as success.
- `update_gateway` starts the same locked transaction as Slack `/update`, the Admin UI, and
  `npm run update`. If an update is already active it reports that transaction instead of starting
  another.
- The caller must still be a gateway admin. In Auto/Admin mode no additional Slack approval card is
  posted; in Read/Worker mode the exact update action still requires a click.
- Before changing Git it checks upstream/clean-tree safety, runtime/config/service prerequisites,
  calculated disk space, current health, and a real isolated Claude turn. A candidate is installed,
  security-audited, fully tested, provisioned, restarted, and accepted only after daemon revision,
  Slack, and another isolated Claude check pass.
- If a post-change check fails, it restores the previous revision and dependencies, restarts, and
  proves the restored build. The final thread reply distinguishes success, preflight refusal,
  successful rollback, and candidate-plus-rollback failure. Details are in
  `~/.channelgate/logs/update.log`; recovery snapshots are under
  `~/.channelgate/update-backups/`.

## Restarting the gateway safely (admin)
- Settings → System → Restart daemon offers **Wait until idle**, **Force restart**, and Cancel.
  Wait checks for idle for up to five minutes. Force interrupts active turns/jobs and can disrupt
  an update; it also upgrades a pending wait immediately. The UI reloads after the new daemon starts.
  The chat tool below retains its safe wait behavior.
- Use `restart_gateway`; never run `systemctl`, `kill`, or another restart command via
  `run_in_background`.
- The daemon lets the requesting turn finish, then checks foreground/queued engine turns,
  background jobs and agents, API runs, and update transactions. If anything is active, it stays
  online and rechecks every 30 seconds for up to five minutes.
- It restarts only after the gateway becomes idle. If work is still active after the wait, it
  cancels the restart, reports what remains in this thread, and requires a fresh request later.
- Admin mode starts an admin author's safe restart without a second approval. Auto/Read/Worker
  modes require an admin's Slack approval first.

## This guide (admin) — customize what the AI reads
This whole usage guide (the `gateway-usage` skill) can be customized live and restored to the
built-in default at any time. The default ships in the repo (in git); overrides are applied on
top and propagate to every channel on its next message.
- `get_gateway_guide` — show the guide's files and whether the active version is the built-in
  default or a customized override. Pass `file` to read one file (e.g. `SKILL.md`,
  `references/reminders.md`).
- `update_gateway_guide` (admin) — replace a guide file's content. `file` is the path within the
  skill (default `SKILL.md`; references are `references/<name>.md`), `content` is the new Markdown.
  Takes effect on the next message in every channel.
- `reset_gateway_guide` (admin) — restore the built-in default. Pass `file` to reset just one
  file, or omit it to restore the entire guide.

Keep this guide **general** — how to operate the gateway inside Slack. Organization-specific
facts, people, and workflows belong in channel memory / instructions (`references/memory-and-rules.md`),
not here.
