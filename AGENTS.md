# ChannelGate — AGENTS.md

Canonical instruction file for Claude Code, Codex and contributors. `CLAUDE.md` symlinks to this
file — edit here only. A deployment may add private rules in a gitignored `AGENTS.local.md` (see
Contributor workflow).

## What this is

A **self-hosted Linux daemon** (Node ESM, Express, `node:sqlite`) that runs coding agents inside
team chat. Every conversation — a Slack DM, group or channel; Microsoft Teams and Google Chat in
Beta — gets its **own work folder** (`~/ChannelGate/<platform>/<slug>/`), its **own rootless
Podman container**, its own persistent memory and one engine session per thread. Each message runs
a **headless engine turn inside that container**: Claude Code (`claude -p`, the primary engine),
OpenAI Codex (`codex exec`), or OpenCode (a proof adapter admitted only read-only and
network-off). The container is the confinement boundary; the folder's `.claude/settings.json`
carries the tool policy. A built-in admin web UI (same process) manages users, channels, engines,
MCP connections, skills, per-channel secrets, schedules, usage and the license. `src/ee/` is the
proprietary licensing plane (see the rules).

Project records: `FEATURES.md` (shipped behavior), `TEST-PLAN.md` (the cumulative regression and
the live acceptance gates) and `CHANGELOG.md` (user-visible changes). There is no `TASKS.md` and no
mandatory planning phase (rule below). Operator and design references: `README.md`, `INSTALL.md`,
`docs/OPERATIONS.md`, `docs/PLATFORMS.md`, `docs/SKILLS.md`, `docs/ENGINE-CAPABILITIES.md`,
`docs/COMPATIBILITY.md`, `docs/OPENCODE-ADAPTER.md`, `docs/LICENSE-KEYS.md`. The bundled skills
`channelgate`, `headless-app-creator` and `skill-authoring` (`src/gateway/skills/bundled/`) describe
this repository's own conventions to agents working on it.

## Architecture (the contract)

```
Chat surface: Slack (Socket Mode, @slack/bolt) · Google Chat (Pub/Sub pull) · Teams (JWKS-verified webhook)
  │  one inbound shape (src/platforms/inbound.js); Slack pipeline src/slack/message-pipeline.js,
  │  the other surfaces src/platforms/ingest.js
  ▼
Gateway daemon
  │  gate: DM → no mention needed · elsewhere → explicit @bot mention
  │  authz: isAuthorized() — admin or approved user, the channel's access policy, per-channel guest grant
  │  license admission (src/ee/limits.js), then provision ~/ChannelGate/<platform>/<slug>/
  │    (.claude/settings.json lockdown, managed CLAUDE.md block, gateway-usage + channel-memory skills,
  │     granted catalog skills)
  │  ensure the channel's container is up (rootless Podman: HOME volume, work folder + clean workspace
  │    + artifact dir at identical paths, control socket read-only, bridge network)
  │  resolve session: thread key → engine session id (resume) | fresh (memory catalog prepended)
  │  build MCP config: gateway control (socket bridge) + composio-user (author) + composio-agent
  │    (channel → org token) + selected catalog/plugin servers → a 0600 file in the artifact dir
  ▼
exec inside the container (Claude, cold):
  claude -p <text> --output-format stream-json --verbose --include-partial-messages
         --setting-sources "" --settings <lockdown> --append-system-prompt-file <CLAUDE.md>
         [--model M] [--effort E] (--session-id <new> | -r <id>) --mcp-config <file> --strict-mcp-config
         --permission-prompt-tool mcp__gateway__permission_prompt [--plugin-dir …]
         [--dangerously-skip-permissions   ← admin author in an Admin channel only]
  warm pool: the same flags, prompt over stdin with --input-format stream-json
  Codex: codex exec [resume <id>] --json -c … (sandbox, MCP, approval policy as -c overrides)
  │  parse NDJSON → deltas/events → progress card, final text, tokens/cost
  ▼
post/edit the reply in the thread (degraded to the surface's capabilities) → usage ledger → memory review
```

## Where things live

- `src/start.js` + `src/platform-gate.js` + `src/server.js` — entry and boot. `start.js` checks the
  Node floor (≥ 22.13, `node:sqlite`) with NO static imports, the gate refuses every non-Linux
  host with one plain line, then `server.js` boots in this order: `.env`, the legacy-layout
  migration FIRST, the runtime root + database + singleton lock, settings over env, the skills
  catalog, hardening, the container CLI probe (FATAL without one), the MCP socket, Express,
  license verification (started, never awaited), Slack + the other transports, automation.
- `src/config/` — `paths.js` (every location; env `CHANNELGATE_DIR`, `CHANNELGATE_DB`,
  `CG_WORKSPACE_DIR`; the pre-rename `CLAUDE_GATEWAY_*` names still resolve with a one-time
  warning), `settings.js` (UI-managed settings, getters, engine enablement, the runtime-change
  policy), `store.js` (users/channels CRUD), `schedules.js`, `acks.js`, `harden.js` (0700/0600
  on the runtime root and its secret files at boot, fatal on failure; the first-boot admin
  password), `channel-env.js` (per-channel environment secrets: write-only, provider-shaped,
  reserved-name validation, `safeSpawnEnv`), `cli-catalog.js` (the deploy CLIs the image ships
  and the env names each reads), `channel-audit.js` (`channel_meta_changed` events carrying only
  the changed keys), `dead-fields.js` (retired fields stripped on every write).
- `src/db/` — `index.js` (the one lazy `node:sqlite` connection: WAL, `busy_timeout`,
  `foreign_keys`, migrations on open, the one-time legacy JSON import behind `_meta` flags),
  `migrations.js` (versioned on `PRAGMA user_version`, currently 24 — append, never edit),
  `import-legacy.js`, `fts.js` (the optional FTS5 `channel_memory_fts` index; without FTS5 memory
  search degrades to a scan).
- `src/gateway/run.js` — the run orchestrator: engine adapter selection and precedence (per-run
  override → thread pin → channel → gateway default), Claude↔Codex failover, warm-vs-cold, session
  recovery, license admission, MCP assembly, and the per-attempt preambles (runtime identity,
  container access facts, channel credential names, the memory catalog). The heart of a turn.
- `src/gateway/folders.js` + `library-skills.js` — channel folder provisioning: the generated
  `.claude/settings.json` (curated `permissions.allow`/`ask`/`deny`, `allowedMcpServers`,
  `autoMemoryEnabled:false`, `autoDreamEnabled:false`, the Stop hook — no `sandbox` block, no host
  path except the operator home in the admin variant's `additionalDirectories`), the
  marker-guarded managed block in `CLAUDE.md` (`AGENTS.md` is a symlink to it: the channel's
  Mode/Auto/Lean/Network switches, the hard rules, the admin's global instructions), the
  `channel-memory` protocol and the granted catalog skills materialized as REAL files under
  `.claude/skills/` with `.agents/skills -> ../.claude/skills` for Codex. Conflicting local entries
  are archived under the runtime root's `skill-backups/` before replacement. The engine hooks
  shipped into the image live in `src/gateway/hooks/` (today only the Claude Stop hook that keeps a
  turn open while its background subagents run).
- `src/gateway/guide.js` + `gateway-usage/` — the **`gateway-usage` skill**, the chat operating
  manual injected into EVERY channel folder each run (all modes, Lean included), resolved for the
  channel's platform: `platforms/<id>/<name>.md` overlays the shared `references/<name>.md`, the
  adapter's `guideDrop` removes files for absent capabilities, `{{PLATFORM}}`/`{{PLATFORM_ID}}`/
  `{{CONTAINER_ACCESS}}` are substituted at materialization. The default ships in git (the
  restorable baseline); admins override any file live via `update_gateway_guide` /
  `reset_gateway_guide` / `get_gateway_guide`, stored per file under
  `~/.channelgate/config/gateway-usage/` (override wins per file, so a `git pull` still surfaces
  new default files).
- `src/gateway/mcp.js` + `run-engine-mcp.js` + `mcp-catalog.js` + `mcp-discovery.js` +
  `mcp-capability.js` — the per-run MCP payload: the `gateway` control server (always; over the
  read-only socket bridge in containers, carrying only a signed HMAC run capability with a toolset
  and TTL), `composio-user` (the author's personal token only), `composio-agent` (channel token →
  organization default; suppressed in DMs), the toolbox/Make servers when a token resolves, then
  — through the engine adapter — the channel/organization-selected catalog servers ("Cloud MCP")
  and plugin-package servers mapped onto explicitly selected connections. Lean injects nothing.
  Slack beyond the gateway's own bot tools is the **Composio** Slack toolkit — there is no
  separate hosted Slack MCP. Composio SDK mode is Enterprise-only (`src/ee/`).
- `src/gateway/modes.js` — the three base modes `read` (Read-only), `worker` (shell + file
  writes) and `admin` (Worker for members; `--dangerously-skip-permissions` only for a trusted
  admin author), the two independent options **Auto** (`autoMode`: tool requests auto-approved)
  and **Lean** (`cleanMode`: no optional skills or connectors; an admin author in an Admin channel
  keeps full context), the orthogonal advisory network switch, plus `isAuthorized()` (who may
  talk) and `canManage()` (who may change a channel's access settings). A mode is a TOOL preset;
  what the container mounts is decided by the runtime backend alone.
- `src/gateway/skills/` + `access-grants.js` + `plugin-runtime.js` + `run-grant-artifacts.js` —
  the **skills platform** (`docs/SKILLS.md`): a SQLite catalog of immutable content-hashed
  revisions holding the exact bytes of every file; owners `bundled` / `folder` (the operator's
  `~/.claude/skills`, `~/.agents/skills`, `GATEWAY_SKILL_SOURCES`) / `git` (tarball sync, webhook,
  publish back) / peer gateways; grants as the union organization ∪ channel (own + assigned
  template) ∪ personal, `requires:` resolved per message; governance flags Enabled / Discoverable
  / Mandatory; plugin packages (`.claude-plugin` / `.codex-plugin`) stored as one revision, their
  hooks admitted only on an authorized live admin turn. Shared grants materialize durably into
  `.claude/skills/`; personal grants become a per-run temporary plugin dir (`--plugin-dir`) for
  Claude and an explicit per-turn catalog for Codex, removed after the run and invisible to other
  authors. The catalog's own MCP endpoint (`POST /mcp/skills`, `src/web/skills-mcp.js`) and its
  access tokens sit outside the admin session.
- `src/gateway/channel-memory.js` + `memory-search.js` + `memory-review.js` — channel memory:
  `MEMORY.md` + `memory/<topic>.md` are the UNCAPPED, portable source of truth (I/O bounds only),
  written atomically in batches behind `update_channel_memory`; a fresh session gets a **catalog**
  prepended (fact and topic counts, topic file names — never the contents) and retrieves on demand
  via `search_channel_memory` (FTS5-backed when available) and `read_channel_memory`; the
  post-reply background reviewer is a reduced-tool `claude -p` in the same gated folder
  (`CG_TOOLSET=memory-review`, origin `memory_review`, every mutating tool denied, only the save
  tool exposed) that saves what the model did not and announces it in the thread.
- `src/gateway/claude-login.js` + `claude-token-relay.js` + `login-watch.js` — the one home for
  "WHICH Claude login does the gateway use, and what does a run receive?". Precedence: a configured
  `claude setup-token` → the OPERATOR's `$CLAUDE_CONFIG_DIR`/`~/.claude` login → a login signed in
  to the gateway's engine home → `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` → a named remedy. The
  operator's login is NEVER copied, linked or mounted; every container run receives a RELAY of the
  resolved login's current ACCESS token in `CLAUDE_CODE_OAUTH_TOKEN`, refreshed by a cheap turn in
  that login's own config dir. The container credential modes, the health probe, the boot log,
  `/status` and the hourly login watch (which DMs admins at most once a day per message class
  while the login is expiring or missing) all read the same resolver. Codex's twin is
  `src/engines/codex-auth.js`.
- `src/gateway/{background,scheduler,followups,nudges,loops,api-runs}.js` — daemon-side
  automation: background shell jobs and background agents that outlive the turn and report back
  into the thread, cron/one-time schedules (with the daily-thread delivery mode), pending-response
  digests, no-response nudges, the durable `/loop` pacing (the harness's own `ScheduleWakeup`/
  `CronCreate` calls become schedule rows with a tick budget), and the HTTP run API
  (`POST /api/runs`: API-key or admin-session auth, a synthetic `api` channel or a real thread,
  idempotency window, in-flight cap, `api_jobs`; the caller-supplied author is never trusted for
  personal tokens or admin state).
- `src/gateway/{approval-requests,instruction-approvals,approval-link-tokens}.js` +
  `src/slack/approvals.js` + `src/web/approval-links.js` + `src/platforms/approval-delivery.js` —
  approvals: one decision path with scopes once / thread / forever ("forever" is admin-only), the
  `permission_prompt` and `request_approval` cards, durable approvals (`background_shell`,
  `channel_instructions`) that never expire and re-post after a restart, and signed single-use
  browser links (`/approve/<token>`: GET decides nothing, POST decides exactly once and re-checks
  authority) for surfaces without Block Kit and for automation.
- `src/gateway/{updater,update-state,update-smoke,restart}.js` + `scripts/update-*` — the
  transactional self-update (the automatic path is an Enterprise entitlement; `scripts/update.sh`
  stays available to every operator): one durable transaction and lock, a detached built-ins-only
  runner (preflight, smoke, snapshot, install → restart → verify, automatic rollback), results on
  `/api/health`; `restart_gateway` drains turns, jobs, API runs and update transactions first.
- Smaller gateway modules: `sessions.js` + `thread-engine.js` (thread key ↔ engine session,
  per-thread pins), `session-adopt.js` + `session-carry.js` (`/resume` of a local session whose
  cwd is this channel; host → container carry-over), `stopped-turns.js`, `active-runs.js`
  (durable rows so interactive turns recover after a restart), `usage.js` + `usage-repair.js`,
  `model-info.js`, `runtime-identity.js` + `runtime-access.js` + `channel-credentials.js` (the
  per-attempt engine/model, mount and credential-name facts), `diagnosis.js` (a failed run opens
  a root-cause thread and proposes, never applies), `drivesync.js`, `transcribe.js` (local
  Whisper), `browser-env.js`, `make-toolbox.js`, `safe-fs.js` (no-follow writes under
  agent-writable folders), `shutdown.js`.
- `src/engines/` — engines. `adapters.js` holds the validated manifests (`claude`, `codex`,
  `opencode`); `registry.js` derives ids, the fallback graph (claude ↔ codex only) and the
  optional `credentialState()` fingerprint the orchestrator only ever COMPARES; `contract.js`
  enforces the required facts (cli, session identity, MCP transport, settings/meta keys,
  instruction file + skills dir, models/efforts, context window, resume command) and methods
  (`compileConfinement`, `run`, `interrupt`, `discoverMcps`, `health`). Add an engine by adding a
  runner + a manifest, never by adding another `engine === "codex"` branch. Runners: `claude.js`
  + `session-pool.js`/`persistent-session.js` (warm pool), `codex.js`, `opencode.js` (read-only,
  network-off, no MCP, outside the failover graph; its CLI is not shipped in the runtime image).
  Shared: `stream.js` (NDJSON → deltas/events), `watchdog.js` (the ONE stall watchdog),
  `child-env.js` (the child env and passthrough list; `buildClaudeEnv`/`buildCodexEnv`/
  `buildOpenCodeEnv` live in their runners), `network-policy.js` (the advisory switch checked
  against the engine's declared `networkModes`), `model-discovery.js`, `engine-health.js`,
  `codex-auth.js` (is Codex signed in — reads the CLI's own `auth.json`), `loop-wakeup.js`,
  `runtime-target.js`. `adapters.js` reads `claude-login.js` lazily because a static import would
  close a cycle through `config/settings.js`.
- `src/runtimes/` — WHERE an engine process runs: `contract.js` (the RuntimeBackend contract),
  `resolve.js` (the one place that builds the RuntimeTarget a turn, a background job and the
  memory reviewer each receive at their OWN spawn), `registry.js` (registers the container backend
  and nothing else; `local.js` is the unregistered host spawner kept for direct-runner tests) and
  `container/` — the rootless Podman backend: the CLI probe (`podman`, then `docker`), the image
  (expected version + digest over every file in `containers/` compared with the built image's
  labels; a missing or stale image fails the run closed with the `npm run build:image` remedy),
  the lifecycle (create/start/stop, recreate by create-time fingerprint and image ID, leases, the
  idle reaper), exec (session-leader helpers so a later exec can signal the whole tree),
  credentials, the per-channel HOME volume and the mounts, the operator's VS Code lease
  (`npm run vscode -- <channel>`).
- `containers/` — the runtime image: `Containerfile` (`node:22-bookworm-slim`, the `agent` user
  at the daemon's real uid/gid, tini, a root-owned toolchain under `/opt/channelgate`),
  `versions.json` (`imageSpecVersion` + every pin: Claude Code, Codex, `mcp-remote`, `vercel`,
  `supabase`, Playwright + `agent-browser` with Chromium, Python with OpenCV and faster-whisper;
  apt adds `gh`, `git`, `ffmpeg`, `ripgrep`, `psql` and friends) and `bin/` (the POSIX `cg-*`
  helpers: init, exec, probe, signal, sweep, the MCP socket bridge shim). `scripts/build-image.mjs`
  stages only the import closure of the engine-spawned helpers, never the checkout.
- `src/mcp/` — `gateway-server.js` is a thin assembler over `tools/` (`background`,
  `channel-admin`, `license`, `schedules`, `skills`, `slack-native`, `tokens`, `workspace-read`),
  each registering its tools behind the verified capability; `socket-server.js` serves it on the
  daemon side over `~/.channelgate/run/mcp.sock` (bind-mounted read-only at `/run/channelgate`, no
  DB mount, no port), `socket-bridge.js` is the container-side stdio↔socket pipe copied into the
  image verbatim, `secret-env-bridge.js`/`remote-secret-bridge.js` launch credentialed stdio and
  remote MCPs from a 0600 bundle so a secret never rides argv.
- `src/platforms/` — the CHAT-SURFACE layer, to chat platforms what `src/engines/` is to engines.
  `contract.js` (the closed capability spec + fail-closed adapter validation), `registry.js` +
  `adapters.js` + `slack.js`/`googlechat.js`/`msteams.js` (per-platform FACTS: what renders, what
  streams, edit budget, threading, native artifacts, mention syntax, attachment reach,
  `folderName`, `guideDrop`, GA/Beta status), `ids.js` (namespaced conversation ids; Slack's stay
  bare), `format/` (`degrade.js` capability-driven Markdown degradation, `mentions.js` the shared
  matcher, `gchat.js`, `teams.js`), `connector.js` + `notify.js` (`postNotice`/`postDirectMessage`,
  the ONE path unattended posts take), `inbound.js` (the one message shape every transport
  produces), `ingest.js` (gate → authorize → run → answer for the non-Slack surfaces),
  `durable-inbox.js` (SQLite at-least-once intake, resumed after a restart), the platform-neutral
  attachment, voice, text-command, reply-session and approval-delivery helpers, `live.js` (which
  transports are CONNECTED), `manager.js`, `boot.js` (what `server.js` calls). `googlechat/` and
  `msteams/` are the two non-Slack TRANSPORTS (auth, REST client, inbound normalization,
  connector; the Pub/Sub pull loop, or the JWKS-verified webhook at `/api/teams/messages`).
  Setup: `docs/PLATFORMS.md`.
- `src/slack/` — Bolt Socket Mode. `app.js` (handlers, modals, slash commands, reactions) and
  `message-pipeline.js` (the whole inbound turn: gating, authorization, attachments, in-thread
  commands, run, delivery) with `message-normalize.js`, `download.js` (`uploads/<thread>/…`),
  `util.js` (dedupe, the per-thread run queue) and `members.js`; `progress.js` (assistant status,
  the timeline card, the heartbeat, the streamed answer), `deliver.js` (the one unattended
  delivery path), `footer.js` (stats + Resume / Files / Secrets / Settings / file buttons),
  `format.js` (mrkdwn), `manager.js` (live connect); the native bot-token artifacts `charts.js`,
  `tables.js`, `lists.js`, `upload.js`, `read.js`; the modals `channel-settings.js` (runtime, MCP,
  skills, secrets, access tabs), `secret-explorer.js` (list and write, never read),
  `file-explorer.js`, `model-wizard.js` (`/model`); and the cards `approvals.js`,
  `busy-thread-choice.js` (Steer / Queue / Cancel), `engine-switch-choice.js`.
- `src/web/` + `public/` — the admin API and the vanilla-JS admin UI. `app.js` mounts the public
  self-authenticating routes (Teams webhook, `/approve/<token>`, `/mcp/skills`, the GitHub webhook)
  ahead of the admin auth stack; `routes/admin.js` is an aggregator over `routes/{settings,
  observability, approvals, schedules, channels, users, skills}.js`, with `routes/runs.js` (the run
  API) and `routes/approve.js` mounted separately. `secrets.js` is the name-resolved allowlist
  behind `POST /api/secrets/reveal` (in `routes/settings.js`); `security.js` holds scrypt password
  hashing, the Host/Origin (DNS-rebinding) guard, the SSRF check over `ip-policy.js`, path
  containment and the login limiter; `auth.js` (admin session + the narrower run-API key);
  `file-editor.js` / `file-download.js` / `file-upload.js` (one-time grant URLs → per-editor
  cookies, re-authorized on every request); `assets.js` (content-hash cache busting for the
  build-less UI); `skills-mcp.js`.
- `src/ee/` — the **proprietary, source-visible** licensing plane (`LICENSE-EE.md`): `license.js`
  (key storage, Ed25519-verified platform responses, the state machine), `tiers.js`, `limits.js`
  (`licenseAdmission()`: conversation admission + the monthly per-conversation message cap, the
  usage report), `composio-*.js` (the Enterprise Composio SDK sessions), `update-entitlement.js`.
- `src/util/` — `redact.js` (the secret redactor for replies, streams and job output),
  `bounded-bytes.js` (inbound byte caps), `semaphore.js` (the global run slots), `proc.js`
  (process-group kills), `process-outcome.js` (human descriptions of exits), `logger.js` (the
  `events` table), `timezone.js` (daemon-local time vs UTC containers), `cron.js`, `keyed-lock.js`,
  `singleton.js`, `drops.js`, `tail.js`.
- `scripts/` — install and service (`install.sh`, `install-systemd.sh`, `install-whisper.mjs`),
  updates (`update.sh` → `update-runner.mjs`), backup and restore (`backup-config.sh`,
  `restore-config.sh`, `restore-drill.sh`, `runtime-maintenance.mjs`), the image
  (`build-image.mjs`), the checks (`run-tests.mjs`, `static-check.mjs`, `secret-scan.mjs`,
  `security-coverage.mjs`, `check-dco.mjs`), the nightly CLI canaries, release
  (`release-artifacts.mjs`, `check-release-candidate.mjs`, `reviewed-artifact-fixtures.json`),
  the landing lock (`with-landing-lock.mjs`, a Git ref with liveness checks) and the one-time
  migrations: `migrate-channelgate.mjs` (the pre-rename layout move `server.js` runs first at
  boot and never fails the boot on; `--dry-run`, `--repath --from <old> --to <new>`, `--verify`),
  `migrate-workspace.mjs`, `migrate-skills-manager.mjs`.
- `test/` — a flat directory of `*.test.js` files run by `scripts/run-tests.mjs` (never a bare
  glob), `helpers.js` (`ensureTestEnv()` pins a scratch runtime root — call it before importing
  anything that opens the database; the runner fails if a test touched the real home),
  `fixtures/` (fake engines, plugins, a fake runtime backend), and two `*.live.test.js` files that
  self-skip unless `CG_LIVE_CONTAINER=1` / `CG_LIVE_PLUGIN_CONTAINER=1`.
- `~/.channelgate/` — the runtime root (`gateway.db`, `config/`, `channels/<platform>/<slug>/`
  metadata mirrors, `logs/`, `run/mcp.sock`, `run-tmp/`, `engine-state/`, `clean-workspaces/`,
  `skill-backups/`, backups, update state). `~/ChannelGate/<platform>/<slug>/` — the visible work
  folders (or a per-channel custom path), with the hidden `.runtime/<platform>/<slug>` artifact
  tree beside them. The `<platform>` component is the adapter's `folderName` fact (`slack` /
  `teams` / `google-chat`) through `platformFolderName()`, never a literal; an unknown or missing
  platform is Slack's. None of it is in the repo.

## Config model (single source of truth)

Operational data lives in **one SQLite database**, `~/.channelgate/gateway.db` (built-in
`node:sqlite`, WAL). The daemon serves the control MCP in-process (one instance per socket
connection); the stdio-child entry of the same server opens the database concurrently, which
SQLite locking makes safe (the old shared JSON files were not). All access goes through `src/db/`
and the store modules; a container never sees the file, and a run reads gateway state only
through the control MCP.

- **To evolve the schema, append a new migration, never edit an old one.** `git pull` + restart
  auto-applies pending migrations on any machine.
- Tables: identity and conversations (`users`, `channels`, `channel_meta`, `sessions`,
  `thread_overrides`, `conversation_reply_sessions`, `active_runs`, `stopped_turns`,
  `inbound_events`, `teams_graph_subscriptions`); automation (`schedules`, `acks`,
  `followup_threads`, `followup_done`, `followup_digest_messages`, `bg_jobs`, `api_jobs`);
  approvals (`approval_requests`, `approval_link_tokens`); skills (`skills`, `skill_revisions`,
  `skill_revision_files`, `skill_sources`, `skill_templates`, `skill_usage`, `skill_proposals`,
  `skill_access_tokens`); Composio SDK (`composio_sessions`); licensing (`license_usage`);
  dashboard data (`usage`, `usage_components`, `usage_requests`, `usage_repair_batches`,
  `events` — typed, indexed columns for day/week/month/channel/user rollups); plus `_meta`
  (key/value, created at open) and the optional FTS5 `channel_memory_fts`. Config-shaped rows
  (`channel_meta`, `users`, `bg_jobs`) keep their full record in a JSON `data` blob so every field
  survives without a migration; `dead-fields.js` strips retired fields on write.

Config that stays as **files** (read wholesale / bootstrap, hand-editable):
- `~/.channelgate/config/settings.json` — UI-managed daemon settings (platform tokens, engine
  defaults, container runtime, license key). Gitignored; **overrides `.env`** (copied into
  `process.env` at boot and on save). Slack and the other transports can be (re)connected live
  via the managers — no process restart.
- `~/.channelgate/config/mcp-catalog.json` — the admin-curated MCP server catalog.
- `~/.channelgate/config/gateway-usage/` — per-file overrides of the `gateway-usage` skill.
- `~/.channelgate/channels/<platform>/<slug>/.claude/settings.json` — the per-channel lockdown
  contract Claude Code itself reads (must be a file): tool permissions, the MCP allowlist,
  memory-off and the Stop hook. No `sandbox` block — the container is the boundary.
- `containers/versions.json` — the image contract: the spec version and every toolchain pin
  (`docs/COMPATIBILITY.md`; the nightly canaries read the same file).

## Non-negotiable rules

- **Confinement is the product, and the container is the boundary.** Every turn — foreground,
  background job, schedule, API run, memory review — runs inside the channel's own container
  (rootless Podman, image-shipped toolchain, `--cap-drop ALL`, no `sudo`): a per-channel HOME
  volume at `/home/agent` (engine sessions, CLI logins, installed tools) and, bind-mounted at
  their identical absolute paths, ONLY the channel's work folder, its clean workspace and its
  artifact dir (`~/ChannelGate/.runtime/<platform>/<slug>`, which also backs `/tmp` and
  `/var/tmp`), plus the read-only control socket. Nothing else exists on that side: no host home,
  no gateway root, no `gateway.db`, no other channel's folder, no daemon checkout, no operator
  `~/.claude`/`~/.codex`. Every container runs on the default bridge network: the per-channel
  *Allow network* switch (`allowNetwork`) tells the engines whether the channel is meant to have
  network and is checked against the engine's declared `networkModes` (OpenCode refuses "on",
  Codex read mode refuses network on its own), but there is no domain filtering and, in this
  release, no egress cut-off (`NETWORK_POLICY_ENFORCED = false`) — the boundary today is the
  container's filesystem and process isolation, not its egress; a container-side egress proxy is
  the planned follow-up. Every channel folder still gets the lockdown file
  (`autoMemoryEnabled:false`, `autoDreamEnabled:false`, curated `permissions.allow`, the MCP
  allowlist, the Stop hook) — it carries POLICY, never a `sandbox` block, and nothing a run can
  do changes what its container mounts. Never exec an engine outside a container. Admin channels
  run in containers too: the admin author's live turn adds the bypass flag, and the work folder is
  mounted read-write like any other's — so an admin channel whose work folder is a host directory
  (the gateway's own checkout, say) hands that directory, and only that directory, to its
  container, everything in it included. That is the intended trust model for admin channels; put
  nothing in such a folder that the channel must not see. The one operator-chosen widening is the
  gateway-wide *Admin channels can access the host home* switch (Settings → Container runtime,
  `containerFullAccessHome`, OFF by default): while it is on, every Admin-mode channel's container
  also bind-mounts the daemon user's WHOLE home read-write at its identical path — every channel's
  work folder and memory, every repo, the gateway root with its logs, metadata and credential
  stores — with only the container engine's own storage masked. It is a boolean, never a path
  (`operatorHomeMounts` in `src/runtimes/container/lifecycle.js`), it is part of the create-time
  fingerprint, no MCP tool can flip it, and it is per CHANNEL: every author the channel admits can
  read the home through the file tools, only an admin author's turn writes with the bypass tools.
- **Secrets never ride a listing response.** `/api/settings`, `/api/channels`, `/api/users` and the
  channel-meta PUT return `has*`/`last4` ONLY. A value is fetched one at a time from
  `POST /api/secrets/reveal`, which re-checks the admin password even for a valid session and
  audit-logs what was revealed (never the value). New secret fields go in the `src/web/secrets.js`
  allowlist — resolved by NAME with own-property checks, so it can never become "read any config
  key". The admin password is stored as a scrypt hash and is deliberately not revealable.
- **A run is never killed for being quiet, and never capped by runtime.** Reaching the inactivity
  window makes the watchdog probe whether the engine PROCESS still exists and, if it does, REPORT
  the wait to the user and keep going. A turn ends only on a vanished process or the absolute
  `CG_MAX_SILENCE` budget. `COMMAND_TIMEOUT` = how often a quiet turn reports itself, NOT when it
  dies (both are read per turn in `run.js`). Every runner goes through `createStallWatchdog`;
  none keeps its own timer. Progress is STDOUT: engine stderr is commentary (retry/backoff/sign-in
  chatter) that records liveness but never resets the silence budget, or a wedged-but-chatty
  process becomes immortal — liveness is the pid probe's job. A turn that dies for ANY
  classifiable reason says which one: a wedged turn's buffered stderr is classified on the way
  out, and a credential failure it names before a tool has run is replay-safe, so it fails over
  instead of dead-ending.
- **The user must always be able to tell a run is alive.** Long turns carry a ticking heartbeat row
  (elapsed + last activity + running subagents), quiet stretches say "still connected", and both
  queues (global run slots, per-thread) report position. Any new waiting state must announce
  itself — silence that looks like death is the bug this exists to prevent.
- **A pinned runtime is never traded away.** Cross-engine failover exists so a DEFAULT never
  strands a thread. When the user pinned this thread's harness/model by hand (`/model` → "just this
  thread", a `claude`/`codex` directive, or a per-run API override), the turn fails with the
  harness's OWN error plus the manual-switch hint instead of being quietly answered by the other
  engine. Channel and gateway defaults are not pins.
- **Composio identities stay distinct.** Inject the active author's personal token as
  `composio-user` and, independently, the channel token as `composio-agent`, falling back to the
  organization token (never the other way round; a DM gets only `composio-user`). A channel folder
  never stores either token in plain settings. "My account" means `composio-user`; "your/channel
  account" means `composio-agent`. Reads/searches may use either or both unless the user restricts
  the account or scope. Writes/sends/state changes require the intended identity and connected
  account; reuse established choices and clarify only unresolved mutation identity. Independent
  authorized reads can continue while that clarification is pending.
- **Composio is the only external Slack MCP.** There is NO hosted per-user Slack MCP and no
  `connect_slack`/`xoxp` OAuth (removed). Slack actions beyond the gateway's own bot tools —
  cross-channel search, sending elsewhere, scheduled sends, canvases, reactions — go through the
  **Slack toolkit inside Composio** (acting as the explicitly selected personal or shared
  account). The gateway's own bot-token Slack tools (`slack_channel_history` /
  `slack_thread_replies`, `slack_download_file`, `slack_post_chart`, `slack_post_table`, Slack
  Lists, `slack_upload_snippet`) act as the BOT and MUST stay hard-scoped to the current channel
  id, never an arbitrary one.
- **Platform capabilities are declared once and fail closed.** Every difference between chat
  surfaces (tables, headings, images, streaming, ephemeral messages, threads, native charts/Lists,
  attachment reach) lives in the adapter's capability descriptor in `src/platforms/`, and is read
  through `platformSupports()` / `capabilitiesFor()` — never by comparing a platform id to a
  literal. An undeclared capability resolves to the LEAST capable value, an unknown capability KEY
  throws, and an unknown/missing platform on a stored record resolves to Slack (every row written
  before multi-platform support is a Slack row). Reply formatting is degraded on the way OUT by
  `format/degrade.js`, not by teaching the model a per-surface dialect; each formatter re-proves
  the control-sequence escaping contract for its own platform. Unattended posts go through
  `postNotice`/`postDirectMessage`, and a platform whose transport is not wired gets a connector
  that THROWS on write — a silent no-op would look like a delivered answer to the scheduler.
- **A channel's secrets are write-only and never leave the channel.** Per-channel environment
  secrets (`src/config/channel-env.js`) are what let one conversation act as its own Supabase or
  Vercel account instead of sharing the host's single login. Every surface returns name + provider
  + last4 + who/when and NOTHING else — no reveal path, not even for admins, and deliberately not
  in the `src/web/secrets.js` allowlist, whose named-getter shape is what stops it becoming "read
  any config key". Names are validated against the reserved prefixes and names on write AND
  re-filtered at the runner boundary (`safeSpawnEnv` from `channel-env.js`, applied inside
  `buildClaudeEnv`/`buildCodexEnv`), because an arbitrary name is code execution (`LD_PRELOAD`,
  `NODE_OPTIONS`, `PATH`) or identity hijack (`ANTHROPIC_BASE_URL`), and `extra` deliberately
  beats everything inherited. A rotated value must retire the warm process (the digest is in the
  pool fingerprint), a background job resolves at ITS own spawn because it outlives the run, and
  values are redacted out of replies, the live stream, and job output — write-only in the UI is
  not write-only at runtime: a run's process can read its own environment, and every attempt is
  told the injected NAMES so it can use them without printing them.
- **The gateway uses the operator's own Claude login, and never copies a credential file.** Which
  login answers a turn is decided ONLY by `src/gateway/claude-login.js`; no other module may stat,
  read, link or copy a `.credentials.json`. Claude Code writes that file by RENAME and rotates the
  refresh token on every refresh, so any second copy that refreshes logs the first one out — that is
  exactly how the gateway's own engine-home copy silently expired while the operator stayed signed
  in. A run receives a RELAY of the resolved login's ACCESS token instead, gateway-owned and
  applied last in the child env so a channel secret cannot displace it. A turn with no resolvable
  login fails closed with the remedy named; it never runs on a guessed credential. A new consumer
  asks the resolver; it never adds a second notion of "the login".
- **Only admins get `--dangerously-skip-permissions`**, and only in an Admin-mode channel.
  Everyone else runs with the folder's `permissions.allow` allowlist and answers tool requests
  through the `permission_prompt` approval card (or Auto mode); headless can't answer interactive
  prompts.
- **Authorization (who may talk)** is `isAuthorized()` in `src/gateway/modes.js`, checked before
  anything else runs on every surface: a user is allowed if they are an **admin** or **approved**
  (`approved` = approved by the deployment operator). Approved users may talk in their DM and in
  any channel whose access policy is the default `approved` (membership is implied by posting);
  a channel may narrow that to `admins` or to `none`. Unknown/un-approved users are denied
  **everywhere, including DMs** — the only exception is an explicit per-channel guest grant
  (`meta.allowedUsers`, channels only, constrained to current members). Who may change a channel's
  access settings is `canManage()` (`meta.manageAccess`: admins, members, or a named list). This
  is authorization only; dangerous permissions still require an admin author **and** an admin-mode
  channel, and the run-API caller's `author` is never trusted for either.
- **Attachments:** image/file attachments are downloaded into the channel folder's `uploads/`
  (per-file cap in `src/util/bounded-bytes.js`, no-follow writes) and their paths handed to the
  engine as text (read via the Read tool — images render visually); a failed download is named,
  never pretended. Voice notes are transcribed locally (Whisper) when enabled.
- **Assistant status:** in an assistant/AI-app thread the bot shows the native shimmering
  status (`assistant.threads.setStatus`) with phrases that track progress; it no-ops elsewhere,
  where the streamed placeholder message is the feedback.
- **Mention gating:** respond in a DM without a mention; everywhere else require an explicit
  `<@BOT_ID>` mention. The only bypasses are the reaction trigger on a thread the bot already
  engaged and the scan for mentions posted before the bot joined; registered slash commands work
  at conversation top level.
- **Linux only:** ChannelGate targets Linux with systemd and rootless Podman — no macOS/launchd
  branches, no BSD-tool assumptions; `src/start.js` (through `platform-gate.js`) refuses every
  other platform with one plain line. Still prefer portable Node APIs over shelling out (`child_process` with `detached:true`
  instead of `setsid`, `node:fs`/`node:path` instead of shell utils) and keep any shell
  POSIX-portable.
- **Secrets** live in gitignored bootstrap/runtime configuration and the SQLite user store,
  outside published source. `users.json` is a legacy import only. Never hardcode or log tokens;
  `npm run secret-scan` must stay clean and CI runs it over candidate history too.
- **`src/ee/` is proprietary and the enforcement is not optional.** The directory is
  source-visible under its own `LICENSE-EE.md`, not the root Sustainable Use License. Removing,
  disabling or circumventing the key verification, the usage limits or the usage reporting —
  including the `licenseAdmission()` call site in `src/gateway/run.js` and the `license_usage`
  schema — is a license violation and is sent back in review. Patches to that directory, new
  tiers or limits, and any licensing/CLA/trademark text change need a prior discussion.
- **Project records:** shipped behavior lives in `FEATURES.md`; the cumulative regression lives in
  `TEST-PLAN.md`. Keep both aligned with shipped code. Do not create, consult, or update
  `TASKS.md`, and do not make a brainstorming or standalone plan-writing phase a prerequisite for
  implementation. Use the active request, repository state, focused acceptance criteria, and
  tests as the working source of truth.
- **Behavior changes need acceptance evidence.** Update `FEATURES.md` and `TEST-PLAN.md`, with
  regression tests and reproducible acceptance instructions for Claude and Codex whenever both
  can reach the behavior. State exact fixtures, setup, prompt/action, expected evidence and pass
  rules. Mark engine-independent cases only when the engine cannot affect them. Contributors need
  no private QA service access: include results and unexecuted live cases in the PR. Maintainers
  must complete the applicable live release gates before declaring a release ready.

## Contributor workflow

### Beta development and stable promotion

- `beta` is the integration branch for all new development, fixes, documentation and tests.
  Start each task from current `origin/beta` in its own branch/worktree; validate and land on
  `beta`, then push `origin beta`. Keep a served beta checkout on `beta` between tasks.
- `main` is the stable release branch for downstream installations. Completing a task or
  receiving permission to push to `beta` never authorizes a merge or push to `main`.
- Promote `beta` to `main` only after BOTH a full test pass and the user's explicit confirmation
  to release that exact candidate. Prepare a release PR and report its candidate commit, scope,
  test results and live acceptance evidence BEFORE asking for confirmation. A request to adopt
  this workflow, earlier general approval, silence, or a beta merge is not release approval.
  The maintainer procedure, gates and evidence rules are `docs/MAINTAINER-RELEASE.md`,
  `docs/RELEASE-CHECKLIST.md` and `docs/RELEASE-ACCEPTANCE.md`; the release workflow accepts only
  the package version's exact tag on `main` (`scripts/check-release-candidate.mjs`).
- A full test pass means `npm run test:coverage` (the full regression suite with coverage floors),
  `npm run check:static`, `npm run secret-scan`, `npm run test:security-coverage`,
  `npm audit --omit=dev --audit-level=high`, and `npm run check:dco -- origin/main..HEAD`
  (`origin/beta..HEAD` for a development branch), plus passing CI and every applicable live
  release gate in `TEST-PLAN.md` for Claude and Codex. Include exact fixtures, prompts/actions and
  observed evidence; a skipped, blocked, failed or unexecuted required check is not a pass. Only
  cases unaffected by engine choice may be marked engine-independent. Maintainers complete private
  deployment acceptance where applicable.
- Approval and evidence belong to the exact tested candidate. If its content changes, or
  integration with newer `main` changes the proposed release, rerun the applicable full checks
  and obtain fresh user confirmation before promotion. Release only the approved candidate;
  do not include later beta commits. Keep `beta` up to date with the approved stable history.
- These branch and release rules apply to both Claude and Codex and override generic skill
  defaults that say to merge completed tasks into `main`. Use the deployment's serialized landing
  lock for integration; never switch a shared served checkout to `main` merely to publish a release.

Use a dedicated branch and worktree from the latest upstream `beta`. Target development pull
requests at `beta`; completed development work is merged and pushed to `beta`. Keep shared
integration checkouts clean, stage only your changes (never `git add -A` / `git commit -a`), write
conventional imperative subjects, sign off every commit under `CLA.md` (`git commit -s`; the
trailer is the CLA acceptance), and open a pull request with the design note and the actual check
output. External contributors push to their own fork and never need the publisher's GitHub account
or a production checkout. See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks, what is
accepted directly and what needs a prior discussion.

For a checkout actually serving a daemon, follow its deployment-specific landing policy: refresh,
verify and land under `npm run with-landing-lock -- <command>`. Maintainers serialize production
integration; this is not a requirement for outside contributors to deploy their own changes.
Preserve both sides of shared documentation conflicts (`FEATURES.md`, `TEST-PLAN.md` and
`CHANGELOG.md` are the usual hotspots). Delete task worktrees/branches only after confirming their
commits are safely integrated, or after an explicit owner-authorized handoff that preserves the
commits remotely.

A deployment may keep additional private QA account, test-channel and production landing details
in a gitignored `AGENTS.local.md`. Do not commit customer identities, credentials or private system
links to public contributor instructions. Session-specific operator instructions remain binding
for that session even when public documentation is revised.
