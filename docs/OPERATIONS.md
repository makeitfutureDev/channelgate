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
as the service user, which fails on a root-owned checkout. macOS LaunchAgents run
as the logged-in account; use a dedicated macOS account for production rather than an administrator
login. Neither service should share credentials or a runtime root with interactive development.

**macOS start-at-boot:** a LaunchAgent only starts when its user logs in graphically, so an
unattended restart leaves the Mac at the login window with the gateway down. `sudo bash
scripts/install-launchd.sh --boot` installs a LaunchDaemon instead — loaded in the system domain at
boot, still running as the owning user via `UserName`, with `HOME` set explicitly because
system-domain jobs inherit none. It removes the LaunchAgent, which the runtime-root singleton lock
would otherwise turn into a `KeepAlive` crash loop. Two ceilings remain: FileVault halts a cold
unattended reboot at the preboot unlock screen (`sudo fdesetup authrestart` covers *planned*
restarts), and with no GUI session the login keychain stays locked — the engine CLIs read
`~/.claude/.credentials.json` and are unaffected, but Keychain-sourced secrets and GUI automation
are not available.

**Engine credentials on Linux:** the service account cannot run `claude login` (no login shell,
its own empty home), so the engines authenticate via API keys. The installer creates a 0600
`<runtime root>/service.env` template read by the unit (`EnvironmentFile=`): fill in
`ANTHROPIC_API_KEY` (and `OPENAI_API_KEY` for Codex), then `systemctl restart channelgate`.
The installer also resolves the `claude`/`codex` binaries at install time and bakes their
directories into the unit's `PATH` — prefer system-wide CLI installs (e.g. npm prefix
`/usr/local`); a CLI inside a user home is exposed to the service read-only with a warning.
Without keys the daemon starts and serves the admin UI, but every engine turn fails
authentication — this file is the fix, not `claude login`.

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
| Claude Code sessions | `<engineHome>/.claude/projects/<encoded-cwd>/` is renamed to the encoding of the channel's NEW cwd, and the `cwd` field inside every transcript (including per-session `subagents/` and `tool-results/`) follows. **This is what keeps `/resume` working**: `claude -r <id>` finds the project from the cwd it is launched in, so without the rename every thread's history is invisible. `projects/` is normally a symlink into the operator's real `~/.claude`, and is resolved before anything under it is touched |
| Claude engine home | `.claude.json` (both copies) keys a `projects` map by absolute cwd |
| Codex state | the `threads` index's `rollout_path` column, each rollout's `cwd` header, `config.toml`'s `[projects."…"]` sections, and `shell_snapshots` |
| Work folder text | `MEMORY.md`, `memory/<topic>.md`, `CLAUDE.md`/`AGENTS.md` — the agent's own prose can quote a path it was told to use |
| Service definitions | the installed launchd plist / systemd user unit (their log paths name the runtime root) |
| Per-channel lockdown | `.claude/settings.json` and `settings-admin.json` are REGENERATED, not rewritten |
| Per-channel `runtime/` | the content-addressed run caches (`claude-settings/<digest>.json`, `claude-plugins/<digest>/`) are DELETED. Their filename is a digest of their contents, so rewriting one would leave a file whose name no longer describes it; the next run recreates what it needs |

Two things are deliberately left alone: the historical `events` log (rewriting an audit trail would
make it say something that did not happen) and any path outside the roots that moved — a custom
per-channel `workDir`, or the repo checkout named in a unit's `WorkingDirectory`.

### `--verify`

```bash
node scripts/migrate-channelgate.mjs --verify
```

A read-only sweep of every store above, printing what still points at a pre-rename root, grouped
and counted, exiting 1 if anything does. It opens the database read-only and writes nothing, so it
is safe while the daemon runs — use it as a pre-flight and again as the acceptance check
afterwards, where it must print `0`. `--dry-run` ends with the same audit, so completeness can be
judged BEFORE anything moves.

### Reloading the service after the migration

The migration rewrites the installed service definition, but the running service holds a CACHED
copy: `systemctl --user daemon-reload` is required before the next start reads the new log paths,
and on macOS `launchctl kickstart -k` re-runs the OLD plist — only `bootout` + `bootstrap` picks up
an edit. The migration cannot do this itself (it runs inside the service it would tear down), so it
leaves `<runtime root>/service-reload-required.json` and `scripts/update-runner.mjs` consumes it on
the next restart: `daemon-reload` before the systemd restart signal, `bootout` + `bootstrap` instead
of a kickstart on launchd. Restarting by hand? Run the command the migration logged first.

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

After migrating, re-run the service installer so the launchd label / systemd unit match the new
names (`com.makeitfuture.channelgate`, `channelgate.service`); each installer removes the pre-rename
one first so an upgraded host never runs two daemons against one runtime root.

## Retention and log rotation

Run `npm run maintenance` daily from the service manager. `CG_RETENTION_DAYS` defaults to 30 and
removes expired backup files; `CG_MAX_LOG_BYTES` defaults to 10 MiB and retains one rotated copy.
Active logs are rotated by copy-truncate, not rename: launchd and systemd hold the daemon's
stdout/stderr file descriptor open, so a renamed file would keep growing under its new name and the
size cap would never apply to the live log again. Console output is centrally redacted for Slack/OpenAI-style tokens, bearer values, and secret query
parameters before launchd/systemd receives it. Database audit/usage retention is deliberately not
automated: legal and operational owners must define it before enabling destructive row pruning.

## Upgrade and rollback canary

Before promotion: run static checks, the complete suite, `npm run backup`, `npm run restore:drill`,
then `npm run release:artifacts`. Deploy one canary service, verify `/api/health`, Slack mention/DM,
both enabled engines, approval gating, and backup restore. The transactional updater automatically
returns Git/dependencies to the prior revision after a failed health check; runtime data snapshots
are never restored automatically. Keep the previous release artifact and backup until the canary
has run for 24 hours.

The admin **Restart** button picks its exit code from the detected service manager (clean 0 under
launchd's `KeepAlive`, nonzero under the unit's `Restart=on-failure`). Nothing in the test suite can
prove a real launchd/systemd relaunch — that stays a manual canary step, and a follow-up if these
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
