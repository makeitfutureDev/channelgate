# ChannelGate — AGENTS.md

Canonical instruction file. `CLAUDE.md`, `GEMINI.md`, `HERMES.md` are symlinks to this file —
edit here only.

## What this is

A **local, self-hosted Node.js daemon** (Linux) that turns Claude Code into a Slack bot. Each
Slack message runs a **headless `claude -p` subprocess** inside that conversation's **own
container** (rootless Podman), with the **per-conversation gated folder**
(`~/ChannelGate/<platform>/<slug>/`; metadata under `~/.channelgate/`) as its working directory.
The container is the confinement boundary; the folder's `.claude/settings.json` carries the tool
permissions, the MCP allowlist and memory-off per the `channelgate` skill, and the subprocess is
driven per the `headless-app-creator` skill. A small admin web UI (served by the same process)
configures per-channel access plus personal, channel, and organization Composio tokens.

This is **not** a Vercel/Supabase/Next.js platform, so the MIF profiles (A/B/C) and its mandatory
planning workflow don't apply. Keep `AGENTS.md` canonical, maintain the living `FEATURES.md` +
`TEST-PLAN.md`, and use scoped acceptance criteria where they help. Do not require the
`brainstorming` or `writing-plans` skills before project work, and do not create or maintain a
`TASKS.md` task ledger.

## Architecture (the contract)

```
Slack (Socket Mode, @slack/bolt)
  │  message event (DM | mpim | channel | private)
  ▼
Gateway daemon (Node ESM, Express)
  │  gate: DM → no mention needed · elsewhere → require @bot mention
  │  authz: author must be in channel.allowedUsers
  │  ensure ~/.channelgate/channels/<platform>/<slug>/ exists (+ .claude/settings.json lockdown)
  │  ensure the channel's container is up (rootless Podman: own HOME volume, work folder mounted,
  │                                        bridge network)
  │  resolve session: thread_ts → claude session_id (resume) | new
  │  build MCP config: channel.allowedMcps + `composio-user` (author) + `composio` (channel→org)
  ▼
spawn("claude", ["-p", text, "--output-format","stream-json","--verbose",
                 ("--session-id"|"-r"), id,
                 "--mcp-config", <json>, "--strict-mcp-config",
                 (admin ? "--dangerously-skip-permissions" : [])],
       { cwd: channelFolder })          ← exec'd inside the channel's container, never on the host
  │  parse NDJSON → final text + token/cost
  ▼
post/edit Slack message in the thread
```

## Where things live

- `src/start.js` — the process entry point (`npm start`, systemd unit): checks the
  Node floor with NO static imports, then dynamic-imports `server.js`.
- `src/server.js` — boot: load env, ensure gateway root, wire deps, start Slack + Express.
- `src/config/` — on-disk config: `store.js` (users/channels CRUD), `settings.js` (UI settings +
  getters), `schedules.js`, `acks.js`, `paths.js` (folder locations), `harden.js` (0700/0600 on the
  runtime secret files at boot + first-boot admin password on a brand-new install),
  `channel-env.js` (the per-channel environment secrets: a channel's OWN CLI logins, write-only on
  every surface, injected as process env at spawn, provider-shaped so a vault is a new provider
  and not a rewrite).
- `src/gateway/run.js` — the run orchestrator: engine selection/precedence, Claude→Codex fallback,
  warm-vs-cold, session recovery; the heart of a turn.
- `src/gateway/folders.js` — channel folder provisioning, `.claude/settings.json` generation (tool
  permissions, the MCP allowlist, memory-off and the Stop hook — no `sandbox` block: the container
  is the boundary), the CLAUDE.md/AGENTS.md managed instructions block, and the auto-injected
  `channel-memory` skill + library skill-stubs. `.claude/skills` is canonical; a guarded relative
  `.agents/skills` symlink exposes the same complete tree to Codex without duplicate copies.
- `src/gateway/guide.js` + `gateway-usage/` — the **`gateway-usage` skill**: the chat operating
  manual injected into EVERY channel folder each run, resolved for the channel's PLATFORM
  (`platforms/<id>/<name>.md` overlays the shared `references/<name>.md`, the adapter's `guideDrop`
  removes files describing absent capabilities, `{{PLATFORM}}` is substituted at materialization) (how to write mrkdwn replies, @-mention, set
  reminders, make tables/canvases, read history, run background jobs, admin). The built-in default
  ships in `src/gateway/gateway-usage/` (`SKILL.md` + `references/*.md`, in git — the restorable
  baseline); admins customize any file live (full override) via the `update_gateway_guide` /
  `reset_gateway_guide` MCP tools, stored as a per-file overlay in `~/.channelgate/config/gateway-usage/`
  (override wins per file, so a `git pull` still surfaces new default files). Marker-guarded,
  write-on-change, injected in all modes incl. clean.
- `src/gateway/mcp.js` + `mcp-catalog.js` + `mcp-discovery.js` — build the per-run `--mcp-config`
  (gateway control MCP + dual Composio identities; Skills/Toolbox use channel→user→org). Slack
  beyond the gateway's own bot tools is the **Composio** Slack toolkit — there is no separate hosted
  Slack MCP.
- `src/gateway/modes.js` — the read/bash/auto/admin mode → tool-permission mapping (read = read-only
  tools, bash = shell + file writes, auto = permission prompts auto-approved, admin =
  `--dangerously-skip-permissions` for an admin author). A mode is a TOOL preset; none of them
  changes what the channel's container mounts.
- `src/runtimes/` — WHERE an engine process runs: the `RuntimeBackend` contract (`contract.js`),
  `resolve.js` (the one place that builds the RuntimeTarget a turn, a background job and the memory
  reviewer all receive — each resolves at its OWN spawn), and `container/` — the rootless Podman
  backend: the CLI probe, the image, the lifecycle (create/start/stop, recreate by create-time
  fingerprint, leases, the idle reaper), exec, the per-channel HOME volume and the mounts. It is the
  only runtime: the daemon refuses to boot without a container CLI, and nothing downstream asks
  "is this a container?" — it reads the target's declared capabilities.
- `src/gateway/claude-login.js` + `claude-token-relay.js` — the one home for "WHICH Claude login
  does the gateway use, and what does a run receive?". The resolver's order is: a configured
  `claude setup-token` → the OPERATOR's own `$CLAUDE_CONFIG_DIR`/`~/.claude` login → a login signed
  in to the gateway's engine home → the daemon's `ANTHROPIC_API_KEY` → a named remedy. The operator's
  login is NEVER copied, linked or mounted (Claude Code writes `.credentials.json` by rename, so a
  copy that refreshes logs the original out); every container run receives a RELAY of that login's
  current ACCESS token in `CLAUDE_CODE_OAUTH_TOKEN`, refreshed by a cheap turn in that login's own
  config dir. The container credential modes, the engine health probe, the boot log and `/status`
  all read the same resolver; nothing else may stat a credentials file.
- `src/gateway/{background,scheduler,followups,nudges}.js` — daemon-side automation (bg jobs that
  outlive the subprocess, cron/one-time schedules, pending-response digests, no-response nudges).
- `src/gateway/channel-memory.js` + `memory-review.js` — the channel memory system: the budgeted
  `MEMORY.md` index + `memory/<topic>.md` files, the atomic batch write API behind
  `update_channel_memory`, the session-start snapshot `run.js` prepends to every FRESH session's
  prompt (recall is injected, never left to a Read), and the post-reply background reviewer (a
  reduced-tool `claude -p` in the same gated folder, `CG_TOOLSET=memory-review`, origin
  `memory_review`) that saves what the model did not and announces it in the thread.
- `src/gateway/{sessions,thread-engine,usage}.js` — thread_ts↔session_id map, per-thread engine
  override, and the usage ledger.
- `src/engines/` — engine runners: `claude.js` + `session-pool.js`/`persistent-session.js` (warm
  pool), `codex.js` (Codex CLI), `stream.js` (NDJSON→delta/event parsing), `engine-health.js`.
  `codex-auth.js` is the one home for "is Codex signed in?" — it reads the same `auth.json` the CLI
  reads and is used by the pre-spawn gate, the health probe, and the boot warning. Claude's twin is
  `src/gateway/claude-login.js` (see above), read lazily from `adapters.js` because a static import
  would close a cycle through `config/settings.js`.
  `registry.js` is the one home for per-engine FACTS (capabilities, session identity, MCP
  transport, settings/meta keys, instruction file + skills dir, model/effort ownership, context
  window, resume command, optional `credentialState()` — the orchestrator only ever COMPARES its
  opaque fingerprint, so a per-engine credential never leaks into `run.js`) — add an engine by adding a runner + a registry entry, never by adding
  another `engine === "codex"` branch. `watchdog.js` is the shared stall watchdog for all three
  runners: quiet turns are REPORTED, not killed (see the runner rules below).
- `src/mcp/gateway-server.js` — the injected gateway control MCP server (schedules, channel admin,
  token setters, workdir, background, permission_prompt, the `gateway-usage` guide update/reset
  tools, native Slack charts, Slack Lists + `slack_upload_snippet`, and this-channel history reads).
- `src/platforms/` — the CHAT-SURFACE layer, to chat platforms what `src/engines/` is to harnesses.
  `contract.js` holds the closed capability spec + fail-closed adapter validation; `registry.js` +
  `adapters.js` + `slack.js`/`googlechat.js`/`msteams.js` are the one home for per-platform FACTS
  (what renders, what streams, edit budget, threading model, which native artifacts exist, mention
  syntax, attachment reach). `ids.js` namespaces conversation ids across surfaces (Slack's stay
  bare). `format/` is the outbound pipeline: `degrade.js` (capability-driven Markdown degradation),
  `mentions.js` (the matcher shared by all three formatters), `gchat.js`, `teams.js`.
  `connector.js` defines the ChatConnector interface and `notify.js` is the ONE path daemon-side
  automation posts through. Add a surface by adding an adapter + a connector — never by adding
  another `platform === "slack"` branch.
  `googlechat/` and `msteams/` are the two non-Slack TRANSPORTS (auth, REST client, inbound
  normalization, connector, and — for Chat — the Pub/Sub pull loop, or for Teams the JWKS-verified
  webhook). `live.js` holds which transports are CONNECTED (state), as opposed to the registry's
  facts; `manager.js` is the connect/disconnect lifecycle; `boot.js` wires both and is what
  `server.js` calls; `ingest.js` is the platform-neutral gate→authorize→run→answer path those
  surfaces use instead of the Slack-shaped `src/slack/message-pipeline.js`; `inbound.js` is the one
  message shape every transport produces. Setup for operators: `docs/PLATFORMS.md`.
- `src/slack/app.js` — Bolt Socket Mode app: routing/gating, approvals, in-thread commands, stop,
  progress rendering. `src/slack/{format,manager}.js` — mrkdwn conversion + connection manager;
  `src/slack/{charts,lists,upload,read}.js` — bot-token native charts, Slack Lists, file-snippet
  upload, and current-channel history/thread reads.
- `src/web/` + `public/` — admin API routes (`routes/admin.js`), auth, and the vanilla-JS admin UI.
  `secrets.js` is the allowlist behind `POST /api/secrets/reveal`; `security.js` also holds the
  scrypt password hashing, the Host/Origin (DNS-rebinding) guard, and the SSRF check.
- `~/.channelgate/` — runtime root (config, sessions, logs), env `CHANNELGATE_DIR` (the pre-rename
  `CLAUDE_GATEWAY_DIR` still resolves, with a one-time deprecation warning). Channel work folders
  live in a visible `~/ChannelGate/<platform>/<slug>/` by default (or a per-channel custom path);
  the `<platform>` component is the adapter's `folderName` fact — `slack` / `teams` /
  `google-chat` — resolved through `platformFolderName()`, never a literal, and an unknown/missing
  platform is Slack's. Per-channel metadata mirrors it at `channels/<platform>/<slug>/`. NOT in repo.
- `scripts/migrate-channelgate.mjs` — the one-time move from the pre-rename layout
  (`~/.claude-gateway/`, `~/Slack Agent/<slug>/`). `src/server.js` runs it FIRST at boot, before
  the database opens and before Slack connects, and it never fails the boot: a refusal or a failure
  pins the process back onto the old roots. `--dry-run` prints the plan. `--repath --from <old>
  --to <new>` repaths a folder moved by hand (the checkout itself, a custom `workDir`) in every
  store; `--verify` with the same pair is the acceptance check.

## Config model (single source of truth)

Operational data lives in **one SQLite database**, `~/.channelgate/gateway.db` (built-in
`node:sqlite`, WAL). The daemon AND the spawned MCP server process open it concurrently — SQLite
locking makes that safe (the old shared JSON files were not). All access goes through `src/db/`
and the store modules; never read the tables from a gated folder.

- `src/db/index.js` — the one connection (lazy, WAL + `busy_timeout`), runs migrations + the
  one-time legacy JSON import on first open. `src/db/migrations.js` — versioned schema keyed on
  `PRAGMA user_version`; **to evolve the schema, append a new migration, never edit an old one**.
  On any machine, `git pull` + restart auto-applies pending migrations. `src/db/import-legacy.js`
  — one-time import of the pre-SQLite JSON/JSONL into the tables (guarded by a `_meta` flag; old
  files are left on disk as inert backups).
- Tables: `users`, `channels`, `channel_meta`, `sessions`, `schedules`, `acks`,
  `followup_threads` + `followup_done`, `bg_jobs` (config-shaped rows keep their full record in a
  JSON `data` blob so every field survives + no migration for new fields); `usage` and `events`
  (the dashboard data — fully typed, indexed columns for day/week/month/channel/user rollups).

Config that stays as **JSON files** (read wholesale / bootstrap, hand-editable):
- `~/.channelgate/config/settings.json` — UI-managed daemon settings (Slack tokens, keepalive,
  Composio URL). Gitignored; **overrides `.env`** (copied into `process.env` at boot and on save).
  Slack can be (re)connected live via the manager — no process restart.
- `~/.channelgate/config/mcp-catalog.json` — admin-curated MCP server catalog.
- `~/.channelgate/channels/<platform>/<slug>/.claude/settings.json` — the per-channel lockdown contract
  that Claude Code itself reads (must be a file): tool permissions, the MCP allowlist, memory-off
  and the Stop hook. No `sandbox` block — the container is the boundary.

## Non-negotiable rules

- **Confinement is the product, and the container is the boundary.** Every turn — foreground,
  background job, schedule, memory review — runs inside the channel's own container (rootless
  Podman, image-shipped toolchain, `--cap-drop ALL`, no `sudo`): a per-channel HOME volume at
  `/home/agent` (engine sessions, CLI logins, installed tools) and, bind-mounted at their identical
  absolute paths, ONLY the channel's work folder, its clean workspace and its artifact dir
  (`~/ChannelGate/.runtime/<platform>/<slug>`, which also backs `/tmp` and `/var/tmp`), plus the
  read-only control socket. Nothing else exists on that side: no host home, no gateway root, no
  `gateway.db`, no other channel's folder, no daemon checkout, no operator `~/.claude`/`~/.codex`.
  Every container runs on the default bridge network: the per-channel *Allow network* switch
  (`allowNetwork`) is kept and tells the engines whether the channel is meant to have network
  (Codex read mode refuses network on its own), but there is no domain filtering and, in this
  release, no egress cut-off — the boundary today is the container's filesystem and process
  isolation, not its egress (a container-side egress proxy is the planned follow-up). Every
  channel folder still gets the `channelgate` lockdown file
  (`autoMemoryEnabled:false`, `autoDreamEnabled:false`, curated `permissions.allow`, the MCP
  allowlist, the Stop hook) — it carries POLICY, never a `sandbox` block, and nothing a run can do
  changes what its container mounts. Never exec an engine outside a container. Admin channels run
  in containers too: the admin author's live turn adds the bypass flag, and the work folder is
  mounted read-write like any other's — so an admin channel whose work folder is a host directory
  (the gateway's own checkout, say) hands that directory, and only that directory, to its
  container, everything in it included. That is the intended trust model for admin channels; put
  nothing in such a folder that the channel must not see. The one operator-chosen widening is the
  gateway-wide *Full-access channels see the gateway home* switch (Settings → Container runtime,
  `containerFullAccessHome`, OFF by default): while it is on, every Full-access channel's container
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
  dies. Every runner goes through `createStallWatchdog`; none keeps its own timer. Progress is
  STDOUT: engine stderr is commentary (retry/backoff/sign-in chatter) and must never reset the
  silence budget, or a wedged-but-chatty process becomes immortal — liveness is the pid probe's
  job. A turn that dies for ANY classifiable reason says which one: a wedged turn's buffered
  stderr is classified on the way out, and a credential failure it names before a tool has run is
  replay-safe, so it fails over instead of dead-ending.
- **The user must always be able to tell a run is alive.** Long turns carry a ticking heartbeat row
  (elapsed + last activity + running subagents), quiet stretches say "still connected", and both
  queues (global run slots, per-thread) report position. Any new waiting state must announce
  itself — silence that looks like death is the bug this exists to prevent.
- **A pinned runtime is never traded away.** Cross-engine failover exists so a DEFAULT never
  strands a thread. When the user pinned this thread's harness/model by hand (`/model` → "just this
  thread", a `claude`/`codex` directive, or a per-run API override), the turn fails with the
  harness's OWN error plus the manual-switch hint instead of being quietly answered by the other
  engine. Channel and gateway defaults are not pins.
- **Composio identities stay distinct.** Inject the active author's token as `composio-user` and
  independently inject shared `composio` from the channel token, falling back to the organization
  token. A channel folder never stores either token in plain settings. “My account” means
  `composio-user`; “your/channel account” means `composio`; ambiguous identity must be clarified.
- **Composio is the only external Slack MCP.** There is NO hosted per-user Slack MCP and no
  `connect_slack`/`xoxp` OAuth (removed). Slack actions beyond the gateway's own bot tools —
  cross-channel search, sending elsewhere, scheduled sends, canvases, reactions — go through the
  **Slack toolkit inside Composio** (acting as the explicitly selected personal or shared account).
  The gateway's
  own bot-token Slack tools (`slack_channel_history` / `slack_thread_replies`, `slack_post_chart`,
  Slack Lists, `slack_upload_snippet`) act as the BOT and MUST stay hard-scoped to the current
  channel id, never an arbitrary one.
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
  any config key". Names are validated against a reserved set on write AND re-filtered at the
  runner boundary (`safeSpawnEnv` inside `buildClaudeEnv`/`buildCodexEnv`), because an arbitrary
  name is code execution (`LD_PRELOAD`, `NODE_OPTIONS`, `PATH`) or identity hijack
  (`ANTHROPIC_BASE_URL`), and `extra` deliberately beats everything inherited. A rotated value must
  retire the warm process (the digest is in the pool fingerprint), a background job resolves at ITS
  own spawn because it outlives the run, and values are redacted out of replies, the live stream,
  and job output — write-only in the UI is not write-only at runtime.
- **The gateway uses the operator's own Claude login, and never copies a credential file.** Which
  login answers a turn is decided ONLY by `src/gateway/claude-login.js`; no other module may stat,
  read, link or copy a `.credentials.json`. Claude Code writes that file by RENAME and rotates the
  refresh token on every refresh, so any second copy that refreshes logs the first one out — that is
  exactly how the gateway's own engine-home copy silently expired while the operator stayed signed
  in. A run receives a RELAY of the resolved login's ACCESS token instead, gateway-owned and
  applied last in the child env so a channel secret cannot displace it. A turn with no resolvable
  login fails closed with the remedy named; it never runs on a guessed credential. A new consumer
  asks the resolver; it never adds a second notion of "the login".
- **Only admins get `--dangerously-skip-permissions`.** Non-admins run with the folder's
  `permissions.allow` allowlist (headless can't answer interactive prompts).
- **Authorization (who may talk):** a user is allowed if they are an **admin** or **approved**
  (`approved` = approved by the deployment operator). Approved users may talk in any channel they're a
  member of (membership is implied by posting) **and** in their DM. Unknown/un-approved users
  are denied **everywhere, including DMs** — the only exception is an explicit per-channel guest
  grant (`meta.allowedUsers`, channels only). This is authorization only; dangerous permissions
  still require an admin author **and** an admin-mode channel.
- **Attachments:** image/file attachments are downloaded into the channel folder's `uploads/`
  and their paths handed to Claude (read via the Read tool — images render visually).
- **Assistant status:** in an assistant/AI-app thread the bot shows the native shimmering
  status (`assistant.threads.setStatus`) with phrases that track progress; it no-ops elsewhere,
  where the streamed placeholder message is the feedback.
- **Mention gating:** respond in a DM without a mention; everywhere else require an explicit
  `<@BOT_ID>` mention.
- **Linux only:** ChannelGate targets Linux with systemd and rootless Podman — no macOS/launchd
  branches, no BSD-tool assumptions; `src/start.js` refuses every other platform with one plain
  line. Still prefer portable Node APIs over shelling out (`child_process` with `detached:true`
  instead of `setsid`, `node:fs`/`node:path` instead of shell utils) and keep any shell
  POSIX-portable.
- **Secrets** live in gitignored bootstrap/runtime configuration and the SQLite user store,
  outside published source. `users.json` is a legacy import only. Never hardcode or log tokens.
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

Use a dedicated branch and worktree from the latest upstream main. Keep shared integration
checkouts clean, stage only your changes, sign off commits under `CLA.md`, and open a pull request.
External contributors push to their own fork and never need the publisher's GitHub account or a
production checkout. See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and PR requirements.

For a checkout actually serving a daemon, follow its deployment-specific landing policy: refresh,
verify and land under `npm run with-landing-lock -- <command>`. Maintainers serialize production
integration; this is not a requirement for outside contributors to deploy their own changes.
Preserve both sides of shared documentation conflicts. Delete task worktrees/branches only after
confirming their commits are safely integrated, or after an explicit owner-authorized handoff
that preserves the commits remotely.

A deployment may keep additional private QA account, test-channel and production landing details
in a gitignored `AGENTS.local.md`. Do not commit customer identities, credentials or private system
links to public contributor instructions. Session-specific operator instructions remain binding
for that session even when public documentation is revised.
