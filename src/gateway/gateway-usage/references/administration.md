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
- `set_my_skills_token` / `clear_my_skills_token` — Skills Manager (skillsmanager.uk).
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

## Control-plane tools block on a human Approve click
Every tool below that CHANGES state (modes, network, workdir, Drive link, MCP allowlist,
instructions, gateway guide, tokens) posts a Slack Approve/Deny card and
BLOCKS until someone clicks — the Approve click must come from someone who could authorize the
change themselves (admin-tier tools need an admin's click, manage-tier a manager's; anyone
eligible may Deny or Comment) — auto mode and admin mode do not skip it, and a deny or ~4-minute
timeout refuses the change. `update_gateway` is the one exception: for an admin author it starts
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

## Channel modes (permissions)
Modes are TOOL-permission presets. None of them changes what you can see: every run, whatever the
mode and whoever the author, is confined to this channel's container.
- `set_channel_bash` (managers) — Bash + file-edit tools in the working folder.
- `set_channel_auto_mode` (managers) — autonomous: permission prompts auto-approved, folder
  writable. Needed for `run_in_background`.
- `set_channel_admin_mode` (admin) — for **admin authors**, every tool without prompts
  (`--dangerously-skip-permissions`). Non-admin authors stay restricted. Still inside the
  container — see "Admin access & the container" below.
- `set_channel_network` (admin) — record whether this channel is meant to have network access
  (needs Bash on to be useful) so `git`/`gh`/`curl` and deploy CLIs may be used; the engines are
  told the answer (Codex read mode refuses network on its own). There is no per-domain allow-list
  to add to. If the switch is off and a task needs the network, ask an admin to turn it on
  (effective on the NEXT message) rather than working around it.

## Admin access & the container (read this before diagnosing "file not found")

**Every turn runs inside this channel's container — admin mode included.** What exists on your
side of the boundary: the working folder (bind-mounted from the host at the same absolute path),
your own home directory (`/home/agent`, a per-channel volume — your CLI logins, installed tools,
sessions), `/tmp`, and the image's toolchain. The operator's home, the gateway's own files, other
channels' folders and every other host path are NOT permission-denied — they **do not exist** in
your filesystem view, whoever the author is and whatever the mode. If a real host file seems
missing, say "not visible inside this channel's container", not "deleted / a host mount / a
permissions problem" — and do not diagnose host configuration from inside the container. There
is no turn that sees the whole machine; a file the channel needs has to be put in the working
folder by someone who can reach it.

**An admin channel sees one host directory: its own working folder.** An admin channel whose
working folder is a host directory (a repo checkout, say) has that directory mounted read-write —
everything in it, and nothing beside it. That is the intended trust model for admin channels; it
is not a route to the rest of the host.

**`$HOME` is this channel's home, not the operator's account home.** `~` is `/home/agent` inside
the container and belongs to this channel alone: a login you make there (`gh auth login`,
`vercel login`) or a tool you install stays for this channel's next turns and is invisible to
every other channel.

**Never copy secrets into the working folder.** The folder is often a git checkout and may sync
elsewhere; a credential pasted there can end up committed. A credential this channel should have
is a `/secrets` variable (below) — it arrives as environment, never as a file.

## Working folder & Drive
- `get_channel_workdir` / `set_channel_workdir` (admin) / `clear_channel_workdir` (admin) — run
  the channel's agent in a real project directory instead of the default folder.
- `list_folders` (admin) — browse host folders to pick one for `set_channel_workdir`.
- `get_channel_drive_folder` / `set_channel_drive_folder` (admin) / `clear_channel_drive_folder`
  (admin) — two-way-sync a Google Drive folder into the channel folder's `Drive/` subfolder.

## This channel's own environment secrets (its own CLI logins)
This channel can hold its OWN credentials — its own Supabase project, its own Vercel account —
instead of sharing whatever login the gateway host has. They are stored per channel and passed to
every run here as environment variables, so a CLI picks them up by itself: `supabase`, `vercel`
and friends read `SUPABASE_ACCESS_TOKEN` / `VERCEL_TOKEN` without being told to.

- Anyone who can run commands here manages them with the `/secrets` Slack command (or the 🔑
  button on a reply footer, shown once the channel has at least one). Admins can also use the
  Admin UI → the channel's card.
- **You cannot read them and neither can anyone else.** Every surface shows the NAME and the last
  four characters only; there is no reveal anywhere, deliberately. A lost token is re-issued at the
  provider, not recovered here. To replace one, set it again.
- You have no tool for setting them: it is a human action, on purpose. If a task needs a
  credential this channel does not have, say which variable name is missing and point at
  `/secrets` — do not ask anyone to paste a token into the conversation.
- The values are stripped out of your replies automatically, so do not try to echo one to confirm
  it: you will get `[REDACTED]` and you will have taught the user a bad habit.

## Updating the gateway itself (admin)
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
