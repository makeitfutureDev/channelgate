# Operations runbook

## Backup and restore

Stop the daemon before restoring. Interactive restores require typing `RESTORE`; unattended
automation additionally requires the explicit `CG_RESTORE_CONFIRM=YES` environment flag.

`npm run backup` creates a transactionally consistent SQLite snapshot with `VACUUM INTO`, packages
the durable config/channel metadata, and encrypts it with AES-256-CBC/PBKDF2. Store the blob and key
separately off-host. Set `CG_BACKUP_PASSPHRASE` or `CG_BACKUP_KEY_FILE` in unattended environments.
Run `npm run restore:drill` after every material upgrade and at least monthly; it restores into a
disposable directory and runs SQLite `quick_check`. Stop the service before a real `npm run restore`.

Both scripts read the database from `CLAUDE_GATEWAY_DB` when it is set (the same override
`src/config/paths.js` honors), falling back to `$CHANNELGATE_DIR/gateway.db`. A restore
**replaces** the managed `config/` and `channels/` directories rather than merging into them: each
is staged beside its destination, swapped in with `mv`, and the previous copy is removed only after
the swap succeeds — so a restored gateway never carries files the backup does not contain. If the
archive step fails, `npm run backup` aborts instead of writing a partial blob.

**Backup scope:** `npm run backup` covers the gateway's operational state — `gateway.db`, config,
and the gated `~/.channelgate/channels/` folders. It deliberately does NOT include the visible
channel workspaces (`~/ChannelGate/<platform>/<slug>/` or per-channel custom folders): those are working
directories, usually git repositories with their own remotes. Back them up separately if their
contents aren't pushed anywhere.

## Service identities

Linux production installs use `sudo bash scripts/install-systemd.sh`, which creates the
non-login `channelgate` account and a mode-0700 `/var/lib/channelgate` (an install upgraded from the
pre-rename release keeps its existing `claude-gateway` account and `/var/lib/claude-gateway`, so no
data moves underneath it; only a fresh install gets the new names). It also `chown`s the
checkout to that account and verifies the account can write it — self-update runs `git` and `npm ci`
as the service user, which fails on a root-owned checkout. A single-user box may instead run a
user-scope unit (`~/.config/systemd/user/channelgate.service`, with `loginctl enable-linger` so it
survives logout); the updater and the migration find both scopes. `sudo bash
scripts/uninstall-systemd.sh` (`npm run service:uninstall`) removes either unit — current and
pre-rename names — and leaves the service account and runtime root in place. The service must never
share credentials or a runtime root with interactive development. ChannelGate runs on Linux only;
there is no other service packaging.

**Engine credentials — Claude uses the host user's own login.** The gateway authenticates Claude
with the `claude` sign-in of the user the daemon runs as (`$CLAUDE_CONFIG_DIR`, else `~/.claude`) —
the same one that user maintains in their own shell. Keep that signed in and there is nothing else
to configure: the daemon reads the login where it lives, relays its current *access* token to each
run (host and container alike), and refreshes it on the host when it gets close to expiry. The
credentials file is never copied, linked or mounted, because Claude Code rotates the refresh token
on every refresh and a second copy that refreshes logs the first one out.

A login *session* expires every few weeks and only a new interactive `claude` login moves that date.
The daemon prints the source and the date at boot (`[gateway] claude login: operator (…), session
expires …`), warns three days ahead, and shows the same line in `/status` and `/api/health`. Because
a daemon that has been up for weeks would otherwise never say it again, an hourly watch re-checks
the login while it runs: the gateway DMs every admin daily from three days before the login expires,
and daily while it is missing (once per UTC day per message class, remembered in the database so a
restart cannot turn it into a spam loop). The DM names the login, its expiry in UTC and in the
gateway's local timezone, and the remedy — never any token material. When it lapses, run `claude` as
the daemon's user and sign in again — no restart needed, and the next hourly check goes quiet on its
own.

Two alternatives remain, in this precedence: a `claude setup-token` value pasted into *Settings →
Container runtime* (long-lived, never rotates), and the daemon's own `ANTHROPIC_API_KEY`. A login
signed in to the gateway's own engine home (`<runtime root>/engine-state/claude/home/.claude`) also
still counts, behind the host user's.

*Measured, not assumed:* the relayed token rides the child's environment, but Claude Code strips
`CLAUDE_CODE_OAUTH_TOKEN` (and `ANTHROPIC_API_KEY`) from the environment of every Bash tool
subprocess — verified on 2026-09-02 on this host: a tool call running
`sh -c 'echo ${#CLAUDE_CODE_OAUTH_TOKEN}'` printed 0 while `HOME` was visible — so an agent cannot
`printenv` it, on the host or in a container. What still inherits the process environment is a
stdio MCP server Claude Code itself spawns; only the gateway's own bridges and admin-curated catalog
servers are ever injected, and they run as the same user in any case. The token is the ACCESS half
only (hours), never the refresh token.

**Engine credentials on Linux:** the service account cannot run `claude login` (no login shell,
its own empty home), so the engines authenticate via API keys. The installer creates a 0600
`<runtime root>/service.env` template read by the unit (`EnvironmentFile=`): fill in
`ANTHROPIC_API_KEY` (and `OPENAI_API_KEY` for Codex), then `systemctl restart channelgate`.
The installer also resolves the `claude`/`codex` binaries at install time and bakes their
directories into the unit's `PATH` — prefer system-wide CLI installs (e.g. npm prefix
`/usr/local`); a CLI inside a user home is exposed to the service read-only with a warning.
Without keys the daemon starts and serves the admin UI, but every engine turn fails
authentication — this file is the fix, not `claude login`. Container channels honor the same key:
with no gateway login to relay, `ANTHROPIC_API_KEY` in the daemon's environment authenticates
Claude inside the container too (it crosses through the reviewed passthrough list in
`src/engines/child-env.js`), so a keyed install never sees "no Claude login to relay".

## The ChannelGate rename migration

`scripts/migrate-channelgate.mjs` moves a pre-rename install onto the current layout:
`~/.claude-gateway/` → `~/.channelgate/`, `~/Slack Agent/<slug>/` →
`~/ChannelGate/<platform>/<slug>/`, and, inside the runtime root,
`channels/<slug>` → `channels/<platform>/<slug>` plus the same for `clean-workspaces/`. It runs
automatically at boot (before the database opens and before Slack connects) and as a post-update
step, and it is idempotent.

**What counts as "already migrated" is STATE, not existence.** The migration runs when the old root
holds a `gateway.db` or a `config/` directory and the new root holds neither. A `~/.channelgate/`
that exists but is empty of state — a stray `mkdir`, an engine probe, a test that forgot to pin its
environment — is treated as a leftover and the old install is MERGED into it, entry by entry;
nothing at the destination is ever overwritten, and a colliding name is logged with its old copy
left in place for you to reconcile. If the new root already holds gateway state it is never touched:
the run says so and leaves the old root alone. The same rule applies to the workspace: an empty
`~/ChannelGate/` is not a reason to skip the per-channel moves.

**Before it moves anything** it refuses if the pre-rename deployment is still working: a
`gateway.lock` held by a live pid (the daemon), an `update.lock` held by a live pid (a self-update
transaction), or any `bg_jobs` row whose recorded pid is still alive (a detached background shell
whose cwd is inside the old workspace). A refusal moves nothing.

### What gets repathed

Moving the folders is the easy half. Every store that RECORDS an absolute path has to follow, or
the daemon comes back pointing at directories that no longer exist:

| Store | What moves |
| --- | --- |
| Database JSON blobs | every `data` column in the schema — channel `workDir`, background-job `cwd`/`logFile`, approval and run records, anything a later migration adds |
| Database typed columns | every non-blob TEXT column holding a path (`usage_repair_batches.backup_path` today) |
| Config JSON | `config/settings.json`, `config/mcp-catalog.json` (a local MCP server's `command`/`args` can name a path), the pre-SQLite `users.json`/`channels.json`/`schedules.json` backups, `update-state.json`, each update backup's `manifest.json`, and the per-channel legacy `meta.json`/`sessions.json`/`thread-*.json` |
| Claude Code sessions | `<engineHome>/.claude/projects/<encoded-cwd>/` is renamed to the encoding of the channel's NEW cwd, and the `cwd` field inside every transcript (including per-session `subagents/` and `tool-results/`) follows — **only `cwd`**, see "state vs. content" below. **This is what keeps `/resume` working**: `claude -r <id>` finds the project from the cwd it is launched in, so without the rename every thread's history is invisible. `projects/` is normally a symlink into the operator's real `~/.claude`, and is resolved before anything under it is touched |
| Claude engine home | `.claude.json` (both copies) keys a `projects` map by absolute cwd |
| Codex state | the `threads` index's `rollout_path` column, each rollout's `session_meta`/`turn_context` `cwd` + `workspace_roots`, `config.toml`'s `[projects."…"]` sections, and `shell_snapshots` |
| Work folder text | `MEMORY.md`, `memory/<topic>.md`, `CLAUDE.md`/`AGENTS.md` — the agent's own prose can quote a path it was told to use |
| Service definitions | the installed systemd user unit (its log paths name the runtime root) |
| Per-channel lockdown | `.claude/settings.json` and `settings-admin.json` are REGENERATED, not rewritten |
| Per-channel `runtime/` | the content-addressed run caches (`claude-settings/<digest>.json`, `claude-plugins/<digest>/`) are DELETED. Their filename is a digest of their contents, so rewriting one would leave a file whose name no longer describes it; the next run recreates what it needs |

Two things are deliberately left alone: the historical `events` log (rewriting an audit trail would
make it say something that did not happen) and any path outside the roots that moved — a custom
per-channel `workDir`, or the repo checkout named in a unit's `WorkingDirectory`.

### State vs. content: what may be rewritten at all

An engine transcript is two things in one file. A few fields are **state** — the engine reads them
back to restore a session — and everything else is **content**: a record of what was said and done.
A message that quoted `~/Slack Agent/ops`, a `cat` whose stdout printed it, a shell command that ran
there. Rewriting content would edit history to say something that never happened, so the migration
never touches it and `--verify` never bills it.

The decision is made per JSON **key path**, never by substring, and the lists are deliberately tiny.
Anything not on one is content.

| Store | State keys | Everything else |
| --- | --- | --- |
| Claude transcripts (`projects/**/*.jsonl`, `subagents/*.json`) | `cwd` — the session's working directory, what `claude -r` and the migration's own project-dir resolution read back | `message.content[]`, `toolUseResult.*` (including `stdout`, `filePath`), `attachment.*`, and `snapshot.trackedFileBackups`, whose object KEYS are paths — object keys are never rewritten by anything |
| Codex rollouts (`sessions/**/*.jsonl`, format v0.143) | `payload.cwd` (the `session_meta` header and each `turn_context`) and `payload.workspace_roots[]` | `payload.state.*` under a `world_state` item, plus every message, argument and tool output |

**The `filesystem` key.** `world_state.payload.state.environments.filesystem` is a rendered XML blob
(`<filesystem><workspace_roots><root>…</root></workspace_roots><permission_profile …>`) that Codex
emits once per turn, next to the `turn_context` it was derived from, as the environment context
shown to the model. It is **content**, not state: Codex does not read it back to locate anything —
on resume it re-derives the world state from the restored `session_meta`/`turn_context` cwd, which
*is* repathed. The same goes for its neighbours `state.agents_md.directory` (the label on an inlined
copy of an AGENTS.md) and `state.environments.environments.local.cwd` (the same cwd, already covered
authoritatively). Repathing the two authoritative fields is what actually moves a session; rewriting
the snapshot would only rewrite what the model was once told.

### `--verify`

```bash
node scripts/migrate-channelgate.mjs --verify
```

A read-only sweep of every store above, grouped and counted, exiting 1 if any **state** still points
at a pre-rename root. It opens the database read-only and writes nothing, so it is safe while the
daemon runs — use it as a pre-flight and again as the acceptance check afterwards, where it must
print `0`. `--dry-run` ends with the same audit, so completeness can be judged BEFORE anything moves.

Three rules make the number mean something:

1. **Per key, not per substring** — the split above. Content is reported in its own
   `historical content — a record of what was said and done, left by design` section, next to the
   `events` log, and never counts toward the exit code. On a busy install it is normally the far
   larger number, and that is fine.
2. **A name is not state, a cwd is.** A Claude project directory is stale when its name is no longer
   the encoding of its own cwd, or when that cwd no longer exists — *not* because the name still
   spells a pre-rename path. A channel whose custom `workDir` really is `~/Slack Agent/<slug>` was
   deliberately left in place, so the directory encoding that cwd is exactly right.
3. **After the move, a path that still resolves is correct.** A state field naming a pre-rename path
   that still exists on disk points at a real directory that did not move. Those are listed under
   `still on disk — deliberately not moved, so the recorded path is correct` with the stores that
   reference them, so the reason the count is zero is visible rather than assumed. Before the move
   this exoneration is switched off — nothing has moved yet, so everything is billed, which is what
   makes the same command work as a pre-flight.

So a non-zero exit always means there is something to repair, and `--repath` is the repair.

### `--repath`

```bash
node scripts/migrate-channelgate.mjs --dry-run --repath   # preview
node scripts/migrate-channelgate.mjs --repath             # apply
```

Every rewrite pass the migration runs — database blobs and typed columns, config JSON, Claude
projects (including directory renames) and engine home, Codex index/rollouts/`config.toml`,
work-folder text, service definitions, and the per-channel lockdown regeneration — applied against
the **current** roots. It moves nothing: not the runtime root, not the workspace, not a single
channel folder. Use it when the one-time migration could not cover everything: a host somebody moved
by hand, a store that was locked when the boot migration went through, a channel folder an operator
relocated themselves.

Unlike the one-time migration, which drops every content-addressed run cache under
`channels/**/runtime/` (at migration time all of them name the old roots), a repath drops only a
cache that actually still mentions one — otherwise every run would cold-start a healthy install.

It prints the same plan and the same summary as a migration, and ends with the audit
(`audit (post-repath)`), so a run is its own acceptance check. It is **idempotent** — the rules are
keyed on the pre-rename roots and on the flat `channels/<slug>` layout, so a store already on the new
paths matches nothing and a second run reports zero and rewrites no byte. It refuses while the daemon
is running for exactly the reason the migration does (it rewrites the same live stores); `--dry-run`
reports the blocker and previews anyway, writing nothing.

#### `--from <old> --to <new>` — a folder you moved by hand

```bash
node scripts/migrate-channelgate.mjs --dry-run --repath --from /old/place --to /new/place   # preview
node scripts/migrate-channelgate.mjs --repath --from /old/place --to /new/place             # apply
node scripts/migrate-channelgate.mjs --verify --from /old/place --to /new/place             # count
```

The rename rules only know the roots the product renamed. A folder *you* moved — the daemon's own
checkout (`~/Code/claude-gateway` → `~/Code/channelgate`), a channel's custom `workDir`, a project
directory — is invisible to them, so hand the pair over and it becomes one more rewrite rule for
every pass above: the channel record, Claude project directories (renamed to the new cwd's encoding,
which is what keeps `-r` resume working) and their transcripts, the engine home's `.claude.json`,
Codex `config.toml`/index/rollouts, the moved folder's own `MEMORY.md`/`memory/*.md`, the installed
service definition (`WorkingDirectory`), and the sandbox regeneration. Repeat the two flags for
several folders. Move the folder FIRST, then repath: the rule says where the folder *is*, and the
prose is rewritten there. Both sides must be absolute and distinct, and the new path may not lie
under the old one (that rule would rewrite its own output on every run). A malformed or misplaced
pair (without `--repath`/`--verify`) exits 2 with usage before anything is read. `--verify` handed
the same pairs counts what still names the old side, so the acceptance check is the same command.

### Reloading the service after the migration

The migration rewrites the installed service definition, but the running service holds a CACHED
copy: `systemctl --user daemon-reload` is required before the next start reads the new log paths.
The migration cannot do this itself (it runs inside the service it would tear down), so it leaves
`<runtime root>/service-reload-required.json` and `scripts/update-runner.mjs` consumes it on the
next restart: `daemon-reload` (in the unit's own scope) before the restart signal. Restarting by
hand? Run the command the migration logged first.

`--dry-run` deliberately bypasses these checks and reports them instead — previewing the plan while
the daemon is up is exactly when an operator wants it. The finding is printed as the first plan line
(`busy: … — a real run would refuse right now`), the old database is opened read-only, and neither
new root is created.

**On refusal or failure the boot continues on the OLD paths.** The process pins `CHANNELGATE_DIR`
and `CG_WORKSPACE_DIR` back to the pre-rename roots for its own lifetime — an env override, not a
symlink, because a symlinked runtime root would defeat the channel sandbox's wholesale read-deny on
that root. Clear the blocker and restart, or run the script by hand.

Preview with `node scripts/migrate-channelgate.mjs --dry-run`, which prints the same plan and writes
nothing. Channels with a custom `workDir` are never moved, an existing destination is never
clobbered (it is skipped and reported), a cross-device move copies and verifies before removing the
source, and each old location keeps a `MOVED.md` breadcrumb. Every channel's `.claude/settings.json`
is regenerated afterwards because the sandbox allow/deny lists embed absolute paths.

After migrating, re-run the service installer so the systemd unit matches the new name
(`channelgate.service`); the installer removes the pre-rename one first so an upgraded host never
runs two daemons against one runtime root.

## Container runtime

Optional, off by default, and Linux-only. When it is on, a channel's engine processes run inside a
long-lived container of that channel's own instead of the daemon's host sandbox — separate HOME,
separate CLI logins, its own process namespace, and none of the host's files reachable. The daemon
itself is unaffected: it still runs on the host, and a machine with no container CLI boots exactly
as before.

**Prerequisites.** Rootless **Podman** is the supported runtime (Docker works and is probed as a
fallback, but rootless podman is what the uid story is built on). On Debian/Ubuntu:

```bash
sudo apt install podman uidmap
grep "^$USER:" /etc/subuid /etc/subgid    # must return a range for the DAEMON user
podman info --format '{{.Host.Security.Rootless}}'   # must be true
```

`uidmap` (the `newuidmap`/`newgidmap` helpers) and the `/etc/subuid` + `/etc/subgid` ranges are what
make `--userns=keep-id` work; without them files written inside a container come back owned by the
wrong uid on the host. Add the ranges with `sudo usermod --add-subuids 100000-165535 --add-subgids
100000-165535 <daemon-user>` and re-run `podman system migrate` if podman had already been used.
Everything below is run **as the user the daemon runs as** — a rootless store belongs to one user,
and two gateways on one host (each under its own account) get entirely separate stores.

**Build the image.** Nothing runs until the channel image exists; the daemon never builds one inside
a turn, because a build takes minutes and would look like a hung answer.

```bash
npm run build:image                        # channelgate/runtime:<spec version> + :latest
npm run build:image -- --cli docker        # force a CLI
npm run build:image -- --no-cache
```

The build bakes the **daemon user's real uid/gid** into the image's `agent` user, so build it as
that user — building as someone else produces an image whose channels cannot write their own
workdir, and building as root is refused outright. CLI versions come from
`containers/versions.json`; bump a pin, rebuild, and each channel picks the new image up on its next
turn (the container fingerprint follows the resolved image ID, not the moving tag).

**A self-update rebuilds it for you.** With the container runtime switched on, the transactional
updater runs the build itself, after dependencies and before the restart, whenever the candidate
changed anything under `containers/`, bumped `imageSpecVersion`, or no image is built at all — so a
`/update` no longer leaves every container channel on the previous toolchain. The build is the one
step that never blocks: if it fails, the update reports `channel image build failed — run
\`npm run build:image\`` and carries on to the restart, because the image already on disk keeps
running every container channel. A manual `git pull` still needs a manual rebuild; the daemon
compares the built image's `cg.image.version` label against the spec this checkout expects and logs
`the built image is spec X but this checkout expects Y` at boot when they differ. An older image
still runs — it is just missing whatever the newer spec added. After a rolled-back update the same
line can appear the other way round (the image is NEWER than the restored checkout); that image
runs too, and the next successful update settles it.

**Settings → Container runtime** (admin UI):

| Setting | Meaning |
| --- | --- |
| Enable the container runtime | the gateway-wide switch. Off = every channel runs on the host, whatever it is pinned to |
| Default for channels that don't pin | `host` or `container` for channels with no explicit choice |
| Container CLI | `auto` (podman, then docker), or force one |
| Image reference | default `channelgate/runtime:latest` |
| Stop an idle channel container after | minutes, default 10 |
| Max containers running at once | default 8; past it the least-recently-used **idle** container is stopped |
| Process / memory / CPU limit | `--pids-limit` (default 1024), `--memory` (e.g. `2g`), `--cpus` (e.g. `1.5`); blank = no limit |
| Claude token for container runs | the output of `claude setup-token` on the gateway host — write-only |

Values that would reach the container CLI's argv are validated at the boundary: a flag, a space or a
shell metacharacter in the image/memory/cpu fields is rejected with an error, not silently cleaned.

**Engine logins.** By default a container Claude run is handed a RELAY of the host user's own
Claude login — its current access token, in `CLAUDE_CODE_OAUTH_TOKEN` — so keeping `claude` signed
in on the host is all a container channel needs. Nothing is copied or mounted. Optionally run
`claude setup-token` on the gateway host and paste the value into *Claude token for container runs*:
that token is then used instead and never needs refreshing. Codex is different — it rewrites
`auth.json` in place, so every container shares a read-write mount of the gateway's real auth file;
keep the host signed in with `codex login`. Codex *sessions* and history are still per channel.

**Flip a channel.** Admin UI → the channel → **Runtime** → *Container* (or *Host*, or *Gateway
default*), or in chat `set_channel_runtime` (admins only) — the reply says which backend the next
turn will actually use. It takes effect on the next message; the thread's session resumes across the
switch in both directions, because the workdir is bind-mounted at the same absolute path on both
backends. Two things override the pin without changing it: the gateway kill switch, and **admin
mode** (an admin channel is deliberately unconfined and always runs on the host). The channel
listing shows the effective decision beside the stored pin.

**Where things live.** Containers and the per-channel HOME volumes live in the rootless podman store
under the daemon user's home — `~/.local/share/containers` by default; `podman info --format
'{{.Store.VolumePath}}'` prints the exact path. The channel's *work* directory is never a volume: it
is the same `~/ChannelGate/<platform>/<slug>` (or the channel's custom workdir) bind-mounted at the
identical absolute path, so host tooling and VS Code see the agent's files instantly. Per-run
engine-facing files (the settings copy, the MCP config, plugin dirs, job logs) live in
`~/ChannelGate/.runtime/<platform>/<slug>`, also bind-mounted at the identical path. Nothing under
`~/.channelgate/` is mounted except the read-only control-socket directory.

**What persists where.** The short version: everything a channel *accumulates* survives, and only
running *processes* do not. A channel container is stopped routinely — after
`containerIdleMinutes` of quiet, and to make room under `containerMaxRunning` — and recreated
whenever its create-time configuration changes (an image rebuild, a limit change, a network-mode
flip). Neither loses data.

| Where | Holds | Survives a `stop`/`start` | Survives a `rm` + recreate | Follows a channel that changes backend |
| --- | --- | --- | --- | --- |
| Per-channel HOME **volume** (`/home/agent`) | engine sessions and transcripts, CLI logins (`gh`, `vercel`, `supabase`, MCP auth), `npm -g`, `pip --user`/`pipx`/`uv`/`cargo` installs, caches, dotfiles | yes | yes — the daemon removes a HOME volume only when the CHANNEL is deleted, never on a rollback, a reconfiguration or an image bump | **no** — a host run sees the daemon's own logins again |
| `/tmp` and `/var/tmp` (bind mounts of `~/ChannelGate/.runtime/<platform>/<slug>/{tmp,var-tmp}`) | scratch files, Claude Code's per-session scratchpad, anything an agent parks between turns | yes | yes | no |
| Channel work directory (`~/ChannelGate/<platform>/<slug>`, bind mount) | the project itself | yes — it is a host directory | yes | yes, it is the same directory on both backends |
| Per-run artifacts (`~/ChannelGate/.runtime/<platform>/<slug>`, bind mount) | this run's settings copy, MCP config, job logs | yes | yes | n/a — rebuilt every run |
| Engine session history (Claude transcripts, Codex rollouts, subagent transcripts) | inside the HOME volume | yes | yes | **yes**, carried automatically (below) |
| `/run` (tmpfs, 64m, `noexec`) | run-helper pid files, the read-only control socket | **no** — fresh on every start, deliberately | no | no |
| Image layers (`/usr`, `/opt/channelgate`, the pinned engines) | read-only and root-owned | yes | replaced by an image rebuild | n/a |
| Foreground/warm engine processes | — | no — a stop kills them; the turn replays | no | no |
| Detached background jobs | — | no — a stop kills them, and the next turn says so | no | no |

`/tmp` and `/var/tmp` were tmpfs until image spec 1.1.0, which meant the idle reaper's routine stop
emptied them ten minutes after every turn. They are host directories now, so they keep their
contents — and the size cap that came with tmpfs is gone with it: they grow against the disk, just
like the channel's work directory. Both are visible on the host under
`~/ChannelGate/.runtime/<platform>/<slug>/`, so an operator can see (and, if a channel ever hoards,
clear) what an agent parked there. Nothing in the daemon deletes them.

**Installing tools in a channel.** An agent can install whatever it needs, and it stays installed —
everything below writes inside the per-channel HOME volume:

| How | Lands in | Notes |
| --- | --- | --- |
| `npm install -g <pkg>` | `~/.npm-global/bin` | `NPM_CONFIG_PREFIX`; first on PATH, so a channel's own version wins over the image's |
| `pip install <pkg>` | `~/.local/bin` | `PIP_USER=1` + `PIP_BREAK_SYSTEM_PACKAGES=1`, so Debian's *externally-managed-environment* refusal never appears |
| `pipx install <app>` | `~/.local/pipx`, shims in `~/.local/bin` | the right choice for a Python CLI with its own dependencies |
| shell installers piped from `curl` (uv, rustup, bun, deno, …) | `~/.local/bin`, `~/.cargo/bin`, `~/.bun/bin`, `~/.deno/bin` | all four are on the image PATH |
| anything hand-dropped in `~/bin` | `~/bin` | on the image PATH |

Codex runs its shell commands through a **login** shell (`bash -lc`), and Debian's `/etc/profile` resets
PATH on the way in; the image re-asserts its PATH from `/etc/profile.d/channelgate-path.sh` (spec
1.1.1), so both engines see the same install dirs. In a Codex shell `~/.local/bin` and `~/bin` end
up ahead of `~/.npm-global/bin` (Debian's `~/.profile` prepends them once more) — a pip-installed
CLI with the same name as an npm one wins there, and the npm one wins in a Claude shell.
| `apt install` | — | **not available**: there is no `sudo` and the toolchain is root-owned by design, so a channel cannot replace its own engines. Ask the operator to add the package to `containers/Containerfile` and rebuild |

Inside a hand-made virtualenv, `pip install` needs `PIP_USER=0` (a `--user` install is not possible
in a venv); `pipx` handles this for itself. If a CLI installs but the shell cannot find it, the
container is running an image built before spec 1.1.0 widened the PATH — rebuild with
`npm run build:image`; the daemon logs that mismatch at boot.

**Engine history follows a thread across backends.** A thread that changes runtime backend between
two messages — you flipped the channel to *Container*, or back to *Host*, or admin mode/the kill
switch did it for you — used to lose its engine-native history and get healed instead (a fresh
session with the chat transcript replayed). It is now carried across before the resume, lazily and
per thread: Claude's `projects/<cwd-key>/<id>.jsonl` plus its `<id>/` subagent directory, Codex's
`sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`. Nothing is deleted on either side — the older copy is
overwritten, the source stays where it is — and the session row is re-stamped so the next turn knows
which side is newest. The daemon cannot reach a HOME volume directly, so the container half stages
through the bind-mounted artifact dir (`…/.runtime/<platform>/<slug>/carry/<id>/`, removed either
way) and runs one `cp` inside. It is best-effort: a failure logs
`session carry-over failed (…) — the resume falls back to the existing heal` and the turn answers
as it did before. Grep for `carried <engine> session` to see one happen. Note this carries the
CONVERSATION, not the HOME: CLI logins and npm-installed tools still do not follow a channel back
to the host backend.

**Inspect and debug.**

```bash
podman ps --filter label=channelgate=1                 # every ChannelGate container on this host
podman ps -a --filter label=cg.install=<install id>    # only THIS gateway's (see /api/health)
podman exec -it <container> bash                       # a shell in a channel, as the agent user
podman logs <container>                                # cg-init output
podman volume ls | grep -- -home                       # the per-channel HOME volumes
```

`/api/health` (authenticated) carries a `containerRuntime` block: the CLI kind, version and
rootlessness, whether the image is present, the control socket, and every running container with its
lease count and idle time. `/status` in a channel names its backend, container, image, state and
uptime. An attached `podman exec` terminal inherits the channel's environment, not the daemon's.

**Rollback.** Three levers, in increasing order of blast radius: set one channel's Runtime back to
*Host*; switch **Enable the container runtime** off, which returns every channel to the host
immediately; or roll the release back through the transactional updater. None of them deletes a
thing — HOME volumes are removed only when a channel is deleted, never on a rollback or a
reconfiguration, and the two temp trees are host directories the daemon never touches, so
re-enabling the runtime finds every CLI login and every scratch file where it was left. Note the one
asymmetry: in-container HOME state (CLI logins, npm-installed tools) does **not** follow a channel
back to the host backend; the host run sees the daemon's own logins again. A thread's engine session
history DOES follow it, in both directions — see "What persists, and what does not" above.

**Known caveats (v0.8 P1).**

- **Per-user Codex skill grants are not delivered in containers.** The per-run Codex skill overlay
  lives under a synthetic host HOME that a container does not have; a containerized Codex run gets
  the channel's skills through the mounted workdir, but not that overlay.
- **Codex sessions are per channel, but the sign-in is shared.** Every container mounts the same
  `auth.json` the gateway uses. A `codex login` on the host that *replaces* the file leaves a
  running container holding the old inode — `/status` and `/api/health` report the drift; restart
  the channel's container (or let the reaper stop it) to pick the new one up.
- **A relayed access token is readable by the channel's own agent.** It rides the exec
  environment, so an agent in that channel can print it. It cannot rotate anything (an access token
  carries no refresh half) and it dies within hours, but it is a live credential for that window;
  the P3 egress proxy replaces it with an opaque token.
- **Egress is not yet policed per channel** (P3). A container runs on the default bridge unless the
  channel's network mode is *off*.
- **A carry can start one container while the kill switch is off.** Reading a thread's history out
  of a HOME volume needs a container, so the first message in each moved thread may start that
  channel's container once even with **Enable the container runtime** off. It holds a lease only for
  the copy; the idle reaper runs in that state precisely so those containers are stopped again after
  `containerIdleMinutes`.

**Claude login in containers:** with no `containerClaudeOauthToken`, each container Claude run
receives a RELAY of the gateway's resolved login — normally the host user's own `~/.claude` — as a
current OAuth access token in `CLAUDE_CODE_OAUTH_TOKEN` (refreshed on the host first by a cheap
haiku turn, in that login's own config dir, when under 30 minutes remain). Host runs are handed the
same token for the same reason. The login file is never copied: Claude Code rotates refresh tokens,
and a copy that refreshes logs the original out. A relayed access token cannot rotate anything. A
`claude setup-token` value, when configured, is used instead and needs no refresh.

**Service unit:** the installer sets `KillMode=mixed`. systemd then sends SIGTERM only to the
daemon, which drains, marks the shutdown and sweeps its own engine children (host process groups,
container run groups) so interrupted turns replay on the next boot. With the default
`control-group` mode systemd signals the engine (or the `podman exec` client) directly and the
turn is recorded as a plain error instead of being replayed. Existing installs: add
`KillMode=mixed` under `[Service]` and `systemctl --user daemon-reload`.

## Retention and log rotation

Run `npm run maintenance` daily from the service manager. `CG_RETENTION_DAYS` defaults to 30 and
removes expired backup files; `CG_MAX_LOG_BYTES` defaults to 10 MiB and retains one rotated copy.
Active logs are rotated by copy-truncate, not rename: systemd holds the daemon's
stdout/stderr file descriptor open, so a renamed file would keep growing under its new name and the
size cap would never apply to the live log again. Console output is centrally redacted for Slack/OpenAI-style tokens, bearer values, and secret query
parameters before systemd (or the journal) receives it. Database audit/usage retention is deliberately not
automated: legal and operational owners must define it before enabling destructive row pruning.

## Upgrade and rollback canary

The transactional updater's phases are: preflight → snapshot → checkout → install → audit → test →
provision → **channel image** → restart → verify, with an automatic rollback (restore → install →
restart → verify) on any failure up to the restart. The channel-image phase is the single exception
to that rollback: it only runs when the container runtime is on and the image is provably behind
this revision, and a failure there is reported and stepped over rather than rolled back (see
[Container runtime](#container-runtime)).

Before promotion: run static checks, the complete suite, `npm run backup`, `npm run restore:drill`,
then `npm run release:artifacts`. Deploy one canary service, verify `/api/health`, Slack mention/DM,
both enabled engines, approval gating, and backup restore. The transactional updater automatically
returns Git/dependencies to the prior revision after a failed health check; runtime data snapshots
are never restored automatically. Keep the previous release artifact and backup until the canary
has run for 24 hours.

The admin **Restart** button picks its exit code from the detected service manager (nonzero under
the unit's `Restart=on-failure`, clean 0 for an unmanaged foreground run). Nothing in the test suite
can prove a real systemd relaunch — that stays a manual canary step, and a follow-up if these
paths ever get an automated harness: press Restart on the canary and confirm the daemon comes back
with a new instance id.

## License keys

The daemon verifies its license key at boot and about every 24 hours, and reports usage counts
daily and once at shutdown. Both are fire-and-forget: neither can delay a boot, a turn, or an
exit, and neither can kill a run. Full model in [`LICENSE-KEYS.md`](LICENSE-KEYS.md); exact
payloads in [`PRIVACY-AND-DATA-FLOW.md`](PRIVACY-AND-DATA-FLOW.md).

**Day-to-day.** Settings → License shows the tier, the key's last four characters, the last
verification, the next scheduled check, a banner for any non-quiet state, and this month's
per-conversation usage against the limit. *Verify now* forces a check. In chat,
`get_license_status` answers the same question for anyone allowed in the channel.

**What each state means for an operator.**

| Banner | What happened | What to do |
| --- | --- | --- |
| *(none)* | `valid`, or `no_key` on a deliberately unlicensed install | nothing |
| offline grace | the platform has been unreachable for under 14 days; the last verified tier still applies | check egress to `CHANNELGATE_PLATFORM_URL`; it will heal itself when the network does |
| grace expired | unreachable for over 14 days | the tier is kept until the start of the next UTC month, then the no-key limits apply — fix connectivity before then, or ask for an offline payload |
| key rejected / revoked | the platform returned 401 / 403 | the no-key limits are already in force; install a valid key |

**Egress.** The only host the daemon itself contacts is `CHANNELGATE_PLATFORM_URL`
(`https://makeitfuture.com/channelgate/api` by default) over HTTPS, with a 10-second timeout. A
deployment that must originate no outbound traffic at all runs on `CHANNELGATE_LICENSE_PAYLOAD`
(an offline signed license) and makes no request.

**Backups.** The cached verification and the installation id live in `_meta` in `gateway.db`, and
this month's counters in `license_usage` — both are covered by the normal encrypted config backup.
Restoring an older database restores an older cached verification; the next check refreshes it.
Deleting the `_meta` installation-id row simply mints a new random one.

**Troubleshooting a refused conversation.** A refusal is always a visible reply in the thread, and
it is also logged: `license_run_refused` in the event log carries the conversation, the reason
(`conversation_limit` or `monthly_cap`), the UTC month, and the run count. Cross-check it against
Settings → License → *Usage this month*.
