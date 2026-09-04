# Changelog — ChannelGate

ChannelGate was formerly *Claude Gateway for Slack*; entries below the rename keep their original
wording. All notable changes to the gateway, newest first. Dates are when the work landed.
This project brings Claude Code (and optionally OpenAI Codex) into Slack as a self-hosted,
per-channel-sandboxed agent. See `FEATURES.md` for the living catalog and `docs/WHY.md` for the
product overview.

> **Publication dates.** Every public release entry below carries the date the Licensor published
> it. Entries for work that never left the private repository are not publications. No version is
> relicensed automatically (license v1.2 removed the former Change Date before first publication).
>
> | License version | Effective | Published |
> | --- | --- | --- |
> | Makeitfuture Sustainable Use License 1.2 | 2026-08-25 | not yet published |
> | Makeitfuture Sustainable Use License 1.1 | 2026-08-20 | never published |
> | Makeitfuture Sustainable Use License 1.0 | 2026-08-06 | never published |

## [Unreleased] — v0.8: container-per-channel runtime, P1 (2026-09-02)

### Changed
- **Small text files now offer both editing surfaces.** When a Public URL is configured, eligible
  files up to 3,000 characters retain the native Slack *Edit* popup alongside *Edit in browser*;
  larger eligible files remain browser-only. Slack does not expose a modal-size setting, so the
  browser editor remains the larger workspace.

### Fixed
- **Composio (and every other injected remote MCP server) is back for Claude in channels that pick
  a global MCP server.** The channel lockdown lists a picked server by URL, and Claude Code then
  matches every REMOTE server by URL: a `serverName` entry no longer admits it, so `composio-user`,
  `composio-agent`, Skills Manager, Toolbox and the Make toolbox were dropped as "blocked by
  enterprise policy" — silently, before any connection attempt, which is why the run config still
  showed both Composio identities resolved while the model reported no Composio tools. Codex was
  never affected (it has no such allowlist). The lockdown now carries each injected remote server's
  URL beside its name (`injectedRemoteAllowMatches`, `src/gateway/mcp-catalog.js`); SDK-mode
  Composio admits its `*.composio.dev` tool-router hosts. Takes effect on the next turn after a
  restart — the per-run settings artifact is keyed by content.
- **A Claude thread inside a Codex-default channel no longer starts "Not logged in".** The
  relayed Claude login was resolved for the CHANNEL's harness before the thread's own harness was
  settled, so a thread that had started on Claude while its channel later moved to Codex spawned
  Claude with no `CLAUDE_CODE_OAUTH_TOKEN` — inside a container that is Claude Code's own
  "Not logged in · Please run /login", two seconds in, every time (`src/gateway/run.js`). The
  credential is now resolved after the thread-engine decision; the stub engine reports whether it
  received a login so the E2E can prove the spawn was authenticated.
- **The nightly engine canary installs Claude Code the way the product documents.** Its Claude
  jobs had failed on both runners since the npm package moved to a native binary fetched by its
  postinstall — `npm install --ignore-scripts` left a shim with nothing to run ("executable format
  is invalid" on macOS). The pinned and the drift-probe jobs now use the official installer
  (`2.1.258` / `latest`), and the Codex target moves to `0.152.0`, the first release whose network
  proxy keeps approved tunnels on Linux (`.github/workflows/nightly-canary.yml`,
  `docs/COMPATIBILITY.md`).
- **CI is green on macOS again, and the security-coverage gate no longer depends on the runner's
  toolchain.** Thirteen tests failed only on macOS because `os.tmpdir()` there is a symlink
  (`/var/folders/…` → `/private/var/…`) and the code under test resolves REAL paths — credential
  files, toolchain binaries, custom work dirs — so a fixture built from the symlinked form never
  string-matched what the code reported. The shared test scratch root is now canonical
  (`test/helpers.js`); Linux reproduces the old failure with a symlinked `TMPDIR`. The access-grants
  coverage area gained tests for the stable toolchain launcher dir (with an explicit fixture
  toolchain instead of whatever `~/.local/node` the runner happens to have), the isolated-target
  refusal, an unreadable `.claude/agents` directory, every post-signature refusal of a gateway
  capability, and `userOnlySkillGrants`.
- **`/update` rebuilds the channel image when this revision needs a new one.** The updater pulled,
  installed dependencies and restarted; the container image was built only by a manual
  `npm run build:image`. So an update that changed `containers/` or bumped `imageSpecVersion` left
  every container channel running the previous toolchain until an operator noticed the boot warning.
  With the container runtime on, the update now runs the build itself — after dependencies, before
  the restart — whenever the candidate touched `containers/`, moved the spec version, or no image is
  built at all. The decision is a pure `needsImageBuild()` in `src/runtimes/container/image.js`
  (unit-tested), the built version comes from the image's own `cg.image.version` label, and the
  expected version is read out of the CANDIDATE's `containers/versions.json` rather than a constant
  the runner imported before the checkout moved under it. A failed build never blocks the update:
  it reports `channel image build failed — run \`npm run build:image\`` and continues to the
  restart, because the image already on disk still runs every container channel.
- **The approval card no longer calls a container channel's job "unsandboxed".** The card for a
  background shell job in an AUTO channel told the admin it "Runs OUTSIDE the engine sandbox as the
  daemon user" — true on the host, and false in a container channel, where the job runs inside that
  channel's own container on the image's toolchain with only the channel's mounts. The card now
  reads the run's target and says `Runs inside this channel's container (<image>)` for an isolated
  runtime, keeping today's wording for the host. Driven by `runtimeSupports(target, "isolated")`,
  never a backend id, and it is still an admin-tier click either way.
- **The test suite cleans up after itself.** Every test process created a scratch gateway root and a
  sibling TMPDIR and removed neither — roughly three hundred directories per `npm test`. On a host
  whose `/tmp` is a tmpfs with a fixed inode budget, the accumulation eventually exhausted the
  inodes and unrelated work started failing with "unable to open database file". `test/helpers.js`
  now tracks every scratch directory it hands out and removes them on process exit (`node --test`
  gives each file its own process, so that is complete), every `mkdtempSync` in the suite goes
  through that helper, and a new `pretest` step (`scripts/test-scratch-sweep.mjs`) sweeps anything
  older than two hours that an earlier crash left behind, skipping what it cannot remove.
- **Claude now runs on the operator's own login, host and container.** The gateway used to symlink
  `~/.claude/.credentials.json` into its synthetic engine home. Claude Code writes that file by
  RENAME, so the first refresh a gateway run performed replaced the link with an independent copy of
  the operator's session — which then aged out on its own while the operator's real login stayed
  valid, and every Claude turn on the affected gateway silently failed over to Codex. Nothing plants
  that link any more. `src/gateway/claude-login.js` is one resolver for "which Claude login does the
  gateway use" — a configured `claude setup-token`, else the host user's own `~/.claude`, else a
  login signed in to the engine home, else `ANTHROPIC_API_KEY`, else a named remedy — and the relay
  reads and refreshes THAT source, in that login's own config dir. Every run now receives its current
  ACCESS token in `CLAUDE_CODE_OAUTH_TOKEN`, host runs included (previously containers only), so a
  host child never depends on a credentials file the gateway no longer maintains. Fail-closed stays
  container-only; a host turn with no login logs the remedy once an hour and lets the engine speak.
  Boot, `/api/health` and `/status` name the login source and the date its session dies, and warn
  three days ahead. No setup-token is required for anything any more.

### Removed
- **Settings → Network → "CLI integrations".** The switch, its `cliIntegrations` setting, the
  live "installed" badges and the read-only linking of the daemon's shared host login
  (`~/.supabase`, `~/.vercel`) into runs are gone. ChannelGate now targets Linux with the container
  runtime only: a container has no domain allow-list and its image ships `vercel` and `supabase`,
  so the switch had no effect there, and a channel's own provider login is a `/secrets` variable —
  never the daemon's host-wide file, which is the identity mix-up the switch invited. `/secrets`
  now suggests every catalog name; a stored `cliIntegrations` value is inert. First slice of
  retiring the host sandbox runtime and macOS.
- **The host sandbox runtime and the network allow-list.** Claude Code `sandbox.*` settings
  generation, the Codex host permission profiles and `network_proxy` compilation, the toolchain
  launcher grants, the host credential links, the `SENSITIVE_HOME` deny lists, the AppArmor/userns
  fix, the per-domain egress allow-list (`networkDomains`, per-channel `extraNetworkDomains`, the
  `request_network_domain` tool and its card), the container kill switch and the per-channel
  runtime pin are gone. The container is the boundary: every turn — admin channels included — runs
  in the channel's own rootless Podman container with a per-channel HOME volume and only the work
  folder, clean workspace and artifact dir mounted, and the daemon refuses to boot without a
  container CLI. Modes stay as tool-permission presets; `.claude/settings.json` keeps permissions,
  the MCP allowlist, memory-off and the Stop hook, with no `sandbox` block. *Allow network* stays as
  a per-channel switch the engines are told about — it filters nothing and does not yet cut a
  container's egress (every container is on the bridge network); the egress proxy is a later slice.
- **macOS support.** ChannelGate runs on Linux only — systemd for the service, rootless Podman for
  every channel. Gone: the launchd installers (`scripts/install-launchd.sh`,
  `scripts/uninstall-launchd.sh`, the `service:*:boot` npm scripts), the darwin branches of the
  self-updater (launchd probe, `kickstart` restart, `bootout` + `bootstrap` reload), the
  migration's plist rewrite, the admin Stop route's `launchctl bootout`, the shutdown exit-code
  rule for `KeepAlive`, the Homebrew/CMake Whisper source build, the extra macOS disk requirement,
  and the macOS legs of the CI and nightly matrices. `npm run service:install` /
  `service:uninstall` now wrap `scripts/install-systemd.sh` and the new
  `scripts/uninstall-systemd.sh` (system AND user units, current and pre-rename names, never the
  runtime root); `npm run setup` and `src/start.js` refuse any other platform with one plain line
  ("ChannelGate runs on Linux only (systemd + rootless Podman); this host is <platform>."), and the
  documentation describes one platform.

### Changed
- **The repository is `makeitfutureDev/channelgate`.** Development, the served `main` and the
  landing lock (`refs/channelgate/landing-lock`, renamed from `refs/claude-gateway/…`) live in the
  new repository, whose history starts from one fresh-start commit of the scrubbed tree; the
  previous repository is a read-only archive of the full history. An existing checkout is repointed
  with the three commands in `INSTALL.md` → *Upgrading* — a plain `git pull` cannot fast-forward
  across unrelated histories, and the updater refuses a diverged checkout by design.

### Added
- **Failover after the in-place retries, with a choice of who decides.** A provider that stays
  unavailable through the transient retries now fails over to the other harness (five-minute
  cooldown for the channel), and Settings gained *How a failover happens*: `auto` (the silent switch)
  or `ask` — a card in the Slack thread with *Switch to <other>* / *Try <failed> again* buttons; the
  click re-runs the original message on the chosen harness (*Switch* pins the thread there). When
  both harnesses fail the error names both in one sentence and a watched thread gets the same card.
  The retry pause hands the run slot and container lease back for its length. The same-engine
  gateway-default-model retry now covers Claude (`model_not_found`) as well as Codex
  (`src/gateway/run.js`, `src/slack/engine-switch-choice.js`, `src/engines/stream.js`).
- **Transient provider failures are retried in place.** A 5xx, an "overloaded", a connection
  reset/timeout, or an unexplained 404 from the Codex backend (the 2026-09-03 ChatGPT Codex outage
  failed every turn on both gateways with "404 Not Found: Unknown error" for a few minutes) no
  longer ends the turn with a red error on the first try: the gateway re-runs the same turn on the
  same engine up to two more times, ten seconds apart (`CG_TRANSIENT_RETRY_ATTEMPTS`,
  `CG_TRANSIENT_RETRY_DELAY_MS`), only while no tool has run, and never for authentication,
  usage-limit or model-rejection failures, which keep their own failover / model-retry paths. Every
  attempt is a `run_transient_retry` event and a status-line notice ("retrying in 10s (1/2)"); a
  reply that needed more than one attempt says so in one line, an exhausted error says how often it
  was retried, and a cancel ends the pause early (`src/gateway/run.js`, `src/engines/codex.js`).
  Review fixes on the same change: a retried FRESH Claude session runs under a new session id (the
  CLI refuses to create one twice — "Session ID … is already in use"); the warm Claude process, which
  stays alive after a provider failure, now rejects that turn with the classified error instead of
  posting "API Error: …" as the reply (`src/engines/persistent-session.js`); a turn that already
  streamed text is never replayed (Claude's replay-safety now matches Codex's); Claude's catch-all
  `provider` kind and the bare "API Error:" prefix no longer count as an outage (a rejected model or
  an unknown 4xx fails once); Codex's stderr never decides a replay (a wedge or an unexplained exit
  keeps its honest message, and a recovered "unexpected status 429" line no longer becomes a
  usage-limit cooldown), the underscore error codes it actually emits (`internal_server_error`,
  `response_stream_disconnected`, …) do qualify, a 404 whose body names the model is a model
  rejection, and the stderr excerpt in a classified failure is redacted; the retry knobs are read
  per turn (so `.env` values count) and the kinds each engine may replay are an adapter fact
  (`transientKinds`). Known cost, inherent to a replay: on a RESUMED session the failed attempt's
  prompt (and the provider's error line) stay in the transcript before the retried one.
- **`--repath --from <old> --to <new>` for a folder moved by hand.** The rename migration's rules
  only know the roots the product renamed; a folder the operator moved — the daemon's own checkout,
  a channel's custom `workDir` — was invisible to them, so its channel record, Claude project
  directory and transcripts, engine `.claude.json`, Codex `config.toml`, memory prose and service
  definition kept naming the old place, and thread resume in that channel broke. The pair
  (repeatable) is now one more rewrite rule for every pass, `--verify` handed the same pair counts
  what is still stale, and a malformed or misplaced pair is refused with usage before anything is
  read (`scripts/migrate-channelgate.mjs`, `docs/OPERATIONS.md`).
- **The Claude login expiry now reaches an admin in Slack, without a restart.** The three-day
  warning was evaluated only at boot and in `/status`, so a daemon that had been up for weeks never
  raised it — the first symptom was Claude turns silently failing over to Codex. A new hourly watch
  (`src/gateway/login-watch.js`, started next to the nudge sweep and stopped with the other runtime
  services) re-resolves the login and DMs every admin once per UTC day: from three days before the
  session expires, and daily while there is no usable login at all. The DM names the login kind and
  config dir, the expiry in UTC and in the gateway's local timezone, and the remedy — never any
  token material. The "already told them today" marker lives in the `_meta` table, so a restart
  cannot re-spam; a class change (expiring → missing) still notifies the same day, and a login that
  goes healthy clears the class. One unreachable admin does not stop the others, and a tick that
  reached nobody stays due for the next hour.
- **Container Claude runs accept the daemon's API key.** A Linux service install authenticates
  with `ANTHROPIC_API_KEY` (docs/OPERATIONS.md) and has no login to relay; container turns used to
  fail closed with "no Claude login to relay" on exactly that install. The key is now the third
  credential mode (setup-token → relay of a login → API key), gated from the live environment.
- **Image spec 1.1.1 — the image PATH now reaches Codex's login shells.** Codex runs commands
  through `bash -lc`, and Debian's `/etc/profile` reset PATH to the distro default, so a Codex
  shell in a container never saw `~/.npm-global/bin` (npm -g installs) or `/opt/channelgate/bin`.
  `/etc/profile.d/channelgate-path.sh` re-asserts the image PATH after that reset; a durability
  test pins it. Also fixes the opt-in live durability test's marker parsing.
- **A channel can run its engines inside its own long-lived Linux container.** Roughly a hundred
  commits of sandbox repair were all fights with a *subtractive* boundary — start from the whole
  host, enumerate the denies. A container is *additive*: the channel gets only what the image and
  the mounts provide, and the whole bug class becomes inexpressible. v0.8 P1 lands the runtime
  seam and the container backend; it **deletes nothing** — the `host` backend stays fully working,
  admin channels stay on it, and a gateway-wide kill switch returns every channel to it at once.
  - **`src/runtimes/` — a runtime backend registry** (`contract.js`, `registry.js`, `resolve.js`,
    `host.js`, `container/`), to WHERE an engine runs what `src/engines/` is to WHICH engine runs.
    A backend that omits a method or a declared capability does not load; an unknown capability key
    throws. `resolveRuntime()` decides once per turn and hands the target to the folder generator,
    the MCP builder, the runners, the artifact paths and the session stamp — nothing downstream
    compares a backend id to a literal.
  - **Precedence**: `containerRuntimeEnabled:false` → host · admin mode → host · `meta.runtime` →
    that · else `containerDefaultBackend`. A per-run override can only reduce capability, so it can
    never move a turn between backends.
  - **The container**: rootless Podman preferred (`auto` = podman, then docker), `--userns=keep-id`
    (or a pinned `--user`), identical-path bind mounts of the channel workdir, the clean workspace
    and a per-channel artifact dir under `~/ChannelGate/.runtime/`, a per-channel HOME **volume** at
    `/home/agent`, the control socket read-only at `/run/channelgate`, a `/run` tmpfs (with `/tmp`
    and `/var/tmp` persistent — see the durability entry below), `--cap-drop ALL`,
    `no-new-privileges`, and pids/memory/cpu caps that degrade with a warning where cgroups are not
    delegated. The gateway root, `config/`, `gateway.db`, the channel metadata folder, the daemon
    checkout and the operator's `~/.claude`/`~/.codex` are never mounted. Run environment travels in
    a 0600 `--env-file`, never on argv.
  - **Lifecycle**: created on first use, restarted in under a second when exited, recreated only
    when the create-time fingerprint changes (and only when no lease is held), stopped — not
    removed — after `containerIdleMinutes` (default 10) with runs, background jobs and memory-review
    runs each holding a lease, and bounded by `containerMaxRunning` with LRU stop and an honest wait
    rather than killing someone's job. A boot reconcile sweeps the previous daemon's foreground and
    warm process groups and leaves detached background jobs running.
  - **Engine logins**: Claude prefers a `claude setup-token` value injected as
    `CLAUDE_CODE_OAUTH_TOKEN` (no mount, no shared refresh chain) and otherwise seeds one copy of
    the gateway's credentials into the channel's HOME; Codex gets a shared read-write file mount of
    the real `auth.json` because it refreshes in place, with a per-channel `CODEX_HOME` so sessions
    and history stay per channel. No login at all fails the turn closed with the exact remedy
    instead of failing over to an engine that would also fail.
  - **Inside the container each engine's own sandbox is off** — the OS boundary the daemon owns is
    the confinement. `permissions.allow`, the mode mapping, the memory-off flags, the MCP allowlist
    and the admin-only bypass are unchanged, and the Stop hook and MCP helpers come from the image's
    `/opt/channelgate` bundle rather than this checkout.
  - **The gateway control MCP is served by the daemon over a unix socket** (`run/mcp.sock`, 0600 in
    a 0700 directory, mounted read-only) instead of a stdio child that would need the database,
    the config directory and the daemon port mounted into every channel. One hello line, then MCP;
    identity is the signed run capability alone, with `toolset` and `progressReport` as SIGNED
    claims; `CG_APPROVAL_SECRET` and `CG_PORT` never enter a container. Minting and verification now
    happen in one process, retiring the aud/secret-skew class permanently. Composio SDK mode rides
    the same socket as a second service.
  - **The stall watchdog learned a third answer.** A container child's pid names the exec client,
    not the engine, so liveness is an async backend probe of the run's process group — and a probe
    that throws, times out or is inconclusive reports *unknown* and the turn keeps waiting. Only a
    definite "gone" ends a turn; a quiet turn is still reported, never killed.
  - **Background jobs and memory review** resolve their own backend at their own spawn, hold a
    lease, and run detached inside the container; job output is tailed from a log at an identical
    path on both sides and the real exit code comes back through a `[cg-exit:N]` marker. A recovered
    job is probed and signalled by its run id, never by a stale client pid.
  - **Where a run happened is recorded and shown**: an additive `sessions.runtime` column
    (migration 13, `''` default, so older code still boots on the new schema), a `/status` Runtime
    line, a ` · container` heartbeat suffix, the image ref on the reply footer, and a `/resume`
    command in the container's own form (`podman exec -it -w <cwd> <name> …`).
  - **Admin surface**: a Settings → Container runtime card (kill switch, default backend, CLI,
    image, idle minutes, max running, pids/memory/cpu caps, and the write-only Claude token), a
    per-channel/DM **Runtime** select that shows the effective decision beside the stored pin, the
    `set_channel_runtime` chat tool, and `containerRuntime` in `/api/health`. Every value that would
    reach the container CLI's argv is refused with a 400 rather than sanitized.
  - **`npm run build:image`** builds `containers/Containerfile` with the daemon user's uid/gid baked
    in, the CLI versions pinned in `containers/versions.json`, and an in-image bundle resolved as
    the import closure of the three helpers an engine spawns — the checkout is never mounted and
    never copied. Because a tag is a moving pointer, the container fingerprint uses the resolved
    image ID, so a rebuild retires containers on their next run.
  - **Cross-platform**: a host with no container CLI boots exactly as before and reports why in
    `/api/health`; the channel image and its helper scripts are Linux-only by design, and macOS
    stays a supported daemon and development host on the `host` backend.
- **A thread's engine history follows it when its channel changes runtime backend.** Stop, start and
  recreate already lost nothing (the HOME volume and the workdir bind outlive a container). The one
  remaining loss was a thread whose channel MOVED — host → container when it is containerized,
  container → host when it is set to admin mode, pinned back, or caught by the kill switch: the
  engine's state dir moved with it, the resume found no session, and the turn was healed instead,
  which keeps the conversation readable but throws away the compactions, tool results and subagent
  transcripts the chat transcript never held. The session's files are now carried across before the
  first resume attempt — lazily, per thread, in both directions, overwriting the older copy and
  deleting nothing on either side.
  - **`sessionState`, a new per-engine fact** (`src/engines/adapters.js`): where a harness keeps a
    session, as paths relative to its state dir. Claude: `projects/<cwd-key>/<id>.jsonl` plus the
    `<id>/` subagent directory, keyed off the RUN's cwd so clean mode keys the directory it ran in.
    Codex: `sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` — a pattern, because the filename carries a
    timestamp nobody can recompute, and the date tree survives the copy because that is what
    `codex exec resume` walks. An engine that declares none is skipped, never guessed at.
  - **`copyIn`/`copyOut`, two optional runtime-backend methods** (`src/runtimes/contract.js`): host
    is a plain `node:fs` copy; the container stages through the bind-mounted artifact dir and runs
    ONE `sh -c` inside, because the daemon cannot reach a HOME volume. A staged file naming a path
    outside the requested state dirs is refused rather than written. Optional is still fail-closed:
    a backend that hangs a non-function on one of these names does not load.
  - The session row is **re-stamped the moment a carry succeeds**, so it always names the side
    holding the newest copy — without it the next turn would carry the stale copy back over
    everything this one added. `run_config` records `sessionCarried` when it happened, and every
    failure is one log line plus the heal that was already there.
  - The idle reaper now starts even with the gateway kill switch OFF: flipping that switch is the
    container → host transition, and a carry may bring one container up to read its HOME volume, so
    something has to stop it again. It only ever acts on containers this process started.
- **Nothing a container channel accumulates is lost any more — including `/tmp` (image spec 1.1.0).**
  A channel container is stopped as a matter of routine (the ten-minute idle sweep, the
  max-running cap) and recreated whenever its create-time fingerprint changes, so durability is a
  question about an ordinary Tuesday, not about a rollback. The HOME volume and the workdir bind
  already survived all of it; `/tmp` and `/var/tmp` did not, because they were tmpfs — every idle
  stop silently emptied them, a regression against the host backend where Claude Code's
  `/tmp/claude-<uid>/…` scratchpad survives between turns.
  - `/tmp` and `/var/tmp` are now rw bind mounts of `~/ChannelGate/.runtime/<platform>/<slug>/tmp`
    and `…/var-tmp` — per channel, never shared, never deleted by the daemon, and visible on the
    host so an operator can see what an agent parked there. `/run` stays the only tmpfs (pid files
    and the read-only socket mount, which must be fresh at every start). The tmpfs size caps are
    gone with the tmpfs: both trees grow against the disk, exactly like the work directory. The
    mount list is part of the container fingerprint, so every existing container is recreated once
    on its next run — with its HOME volume, which is the proof that a recreate keeps everything.
  - **Image spec 1.1.0** widens the PATH to every place a channel can install into, ahead of the
    pinned toolchain: `~/.npm-global/bin`, `~/.local/bin`, `~/bin`, `/opt/channelgate/bin`, the
    distro dirs, then `~/.cargo/bin`, `~/.bun/bin`, `~/.deno/bin`, `~/go/bin`. All of them are
    inside the per-channel HOME volume, so an installed CLI stays installed across a stop, a restart
    and a recreate. It also adds `python3-pip`, `python3-venv` and `pipx` with `PIP_USER=1` +
    `PIP_BREAK_SYSTEM_PACKAGES=1` and `PIPX_BIN_DIR=~/.local/bin`, so a plain `pip install <cli>`
    lands in the volume instead of failing on Debian's externally-managed-environment marker.
    `apt`/`sudo` remain deliberately unavailable — the toolchain is root-owned so a channel can
    never replace its own engines. Rebuild with `npm run build:image`; the daemon compares the built
    image's spec label against the one the checkout expects and names that command at boot when they
    differ.
  - Pinned by `test/container-durability.test.js` (the mount and tmpfs contract, the idle sweep and
    the boot reconcile issuing no destructive verb, a recreate reusing the same HOME volume, a
    source scan proving no production caller passes `destroy(…, { volumes: true })`, and the
    Containerfile/PATH facts) plus an opt-in live proof against a real podman,
    `npm run test:live-container`.

## [Unreleased] — One /model wizard replaces /engine + /effort (2026-07-16)

### Added
- **Google Chat and Microsoft Teams transports (preview).** Both surfaces can now receive and
  answer messages. Google Chat runs outbound-only on a Cloud Pub/Sub PULL subscription (no inbound
  endpoint, no tunnel — the same posture as Slack's Socket Mode); Teams runs on the documented Bot
  Framework endpoint `/api/teams/messages`, which authenticates every request against the Bot
  Framework JWKS before anything else happens. Credentials, live connect/disconnect, and per-platform
  health are in the admin Settings page; setup for both is in `docs/PLATFORMS.md`. A turn on either
  surface goes through the same gate, authorization, confinement, and usage accounting as a Slack
  turn — and neither is escalatable to full access, because escalation needs an interactive
  permission prompt neither surface has yet. Written against `node:crypto` and `fetch`: no new
  dependency for either platform.
- **License keys, tiers, and usage limits (`src/ee/`).** A deployment without a key serves one
  conversation per UTC month with 500 AI messages in it; a free key unlocks every conversation and
  keeps the 500-message monthly cap per conversation; an enterprise key removes both. Limits are
  server-defined and ride a signed payload, so the Licensor can change what a key is worth without
  a release. `src/ee/` is **proprietary, source-visible** code owned by MAKEITFUTURE S.R.L. and is
  not under the Sustainable Use License — see `src/ee/LICENSE-EE.md` and `LICENSE.md` §3.2/§4.5.
  - **Verification** (`src/ee/license.js`): the key comes from Settings (listings return
    `hasLicenseKey` + the last four characters only; the value is revealable one at a time through
    `POST /api/secrets/reveal`) or from `CHANNELGATE_LICENSE_KEY` as a bootstrap. The daemon checks
    `POST {platform}/v1/license/verify` at boot and every 24 h, verifies the response's Ed25519
    signature locally, and caches it. Verification is **never awaited on the boot path** — Slack
    connects while it is in flight, and the run gate reads the cached state.
  - **States**: `no_key · valid · invalid · revoked · grace · expired_grace`. Unreachable keeps the
    last verified tier for 14 days; past that it is still kept until the **next UTC month
    boundary** and only then falls back to the no-key limits — never mid-month, never silently.
    `invalid`/`revoked` drop immediately. Every non-quiet state raises a banner in the admin UI.
    A response whose signature does not verify changes nothing in either direction.
  - **Enforcement** (`src/ee/limits.js`, called from `licenseAdmission()` in
    `src/gateway/run.js`): conversation admission (the first N distinct conversations of the UTC
    month are the allowed set, persisted in the new `license_usage` table — schema migration 12)
    and the per-conversation monthly cap, counted **at spawn** for every origin except the
    deployment's own memory-review runs, with a one-time 80 % warning. A refused turn is a short,
    platform-degraded reply carrying the sign-up link — never an error, never silence, and no run
    starts. Nothing here can crash or kill a run.
  - **Admin UI**: a License card under Settings — state banner, tier, key last four, last/next
    verification, expiry, installation id, *Verify now*, key set/clear (with the existing reveal),
    the platform URL, and this month's per-conversation usage bars against the limit line.
  - **Gateway MCP tools**: `get_license_status` (any allowed user, never shows the key) and
    `set_license_key` / `clear_license_key` (admins only, behind the control-plane approval click).
  - **Data leaving the install** is exactly two payloads — the verify request (key, installation
    id, version) and the daily/at-shutdown usage report (installation id, key hash, version, UTC
    month, per-conversation **hashes** and counts). Never message content, user ids, channel names,
    or credentials. Documented in `docs/PRIVACY-AND-DATA-FLOW.md` and `docs/LICENSE-KEYS.md`.
  - **Air-gapped deployments** can run on `CHANNELGATE_LICENSE_PAYLOAD`, a signed license verified
    locally against the same public key; such an install makes no outbound request at all.
  - The Ed25519 verification key shipped in `src/ee/license-public-key.js` is a clearly labelled
    **placeholder**; the production key is swapped in at deploy time, and
    `CHANNELGATE_LICENSE_PUBLIC_KEY` overrides it for staging and tests.

### Changed
- **Admin Settings loads with the multi-platform registry enabled.** Platform UI manifests now
  contain data only: runtime adapter functions (including optional helpers such as `normalizeName`)
  are removed generically before cloning, preventing `/api/settings` from failing with a
  `DataCloneError` when Google Chat and Teams are registered.
- **README rewritten as a hero landing page, plus GitHub repository metadata**: above the fold the
  README now opens with the H1, the tagline the site's meta description repeats verbatim, a badge
  row (Sustainable Use License 1.2, CI, Node ≥ 22.13, the three chat platforms, the three engines),
  a three-sentence what-it-is, a placeholder for a 45-second demo GIF, a seven-step "Running in 10
  minutes" quick start, a ten-row feature grid, the architecture flow, a ✅/➖/❌ comparison table
  footnoted as a generalisation about categories, security in five bullets, the Free / Partner /
  Reseller-white-label-enterprise licensing lanes, one UTM-tagged Makeitfuture CTA, and a
  documentation index. Every operational section (Slack app setup, install, updating, admin UI,
  engines, configuration, security model, environment variables, admin password) is preserved
  below it. New: `.github/REPO-METADATA.md` (About text, website, the ten repository topics and the
  `gh repo edit` command to apply them at launch) and `docs/assets/README.md` (specs for the demo
  GIF and the 1280 × 640 social preview — neither binary is committed). `test/readme.test.js`
  guards the shape: one H1, one "formerly" attribution, never "open source", the CTA and UTM links,
  every relative link resolving, well-formed badge URLs, and the licensing facts.
- **Renamed to ChannelGate, with new folders and a boot migration** (formerly
  *Claude Gateway for Slack*): the display name, the npm package (`channelgate`), the Slack app
  manifest, the launchd label (`com.makeitfuture.channelgate`), the systemd unit
  (`channelgate.service`), and the bundled lockdown skill (`.claude/skills/channelgate`) all
  follow the product name. The hidden runtime root moves from `~/.claude-gateway/` to
  `~/.channelgate/` (env `CHANNELGATE_DIR` / `CHANNELGATE_DB`, with `CLAUDE_GATEWAY_DIR` /
  `CLAUDE_GATEWAY_DB` still honoured for one major behind a one-time deprecation warning), and
  the visible workspace root moves from `~/Slack Agent/<slug>/` to
  `~/ChannelGate/<platform>/<slug>/` — `slack/`, `teams/`, `google-chat/`, taken from the
  platform registry so a new surface adds a folder by adding an adapter. Per-channel metadata
  (`<root>/channels/<platform>/<slug>/`) and clean-mode workspaces move the same way; a custom
  per-channel `workDir` is never touched. `scripts/migrate-channelgate.mjs` runs once at boot
  (before the database opens and before Slack connects) and on the post-update step: it refuses
  while the old daemon holds its singleton/update lock, prints a dry-run plan, moves the runtime
  root, moves each channel's folders by its stored platform, rewrites stored absolute paths,
  regenerates every channel's `.claude/settings.json`, drops warm sessions, and leaves a
  `MOVED.md` breadcrumb. A failure never fails the boot — the daemon continues on the old paths.
  `node scripts/migrate-channelgate.mjs --dry-run` prints the plan without changing anything.
- Repository restructure for the public release: product docs merged into `docs/WHY.md`,
  engine capabilities moved to `docs/`, marketing site moved to its own repository,
  internal names scrubbed.

### Licensing
- **Makeitfuture Sustainable Use License 1.2 (2026-08-25)**: the Software is renamed ChannelGate;
  new §3.2 adds license keys and usage limits (no key: one conversation; free key: unlimited
  conversations at 500 AI messages/conversation/month; enterprise: unlimited) with end-user keys
  only, and §4.5 makes circumventing them a violation; §3.1 states that any number of separate
  single-customer deployments are permitted service work on the customer's key; §4 names the
  Reseller, White-Label, Enterprise, and optional Partner agreements; the former §7 Change Date is
  removed — no automatic relicensing; new §11 sets Romanian law and Bucharest courts. New
  `docs/LICENSE-KEYS.md`, `TRADEMARK.md`, `AUTHORS.md`; `CLA.md` 1.1; FAQ and decision record
  amended. Docs only — the key enforcement itself is the `src/ee/` slice.
- **Makeitfuture Sustainable Use License 1.1 (2026-08-20)**: new §3.1 permits operating a
  dedicated deployment for a single customer as paid service work and states its four conditions;
  §4.2/§4.4 make multi-tenant operation and white-labeling explicit restrictions; new §6 plus
  `CLA.md` set inbound contribution terms with a `Signed-off-by` sign-off; new §7 adds an
  irrevocable Apache-2.0 Change Date four years after each version's publication. Worked examples
  in `docs/LICENSING-FAQ.md`; rationale and the enterprise-tier boundary policy in
  `docs/LICENSING-DECISION.md`. No code or feature changes.

### Changed
- **Community and contribution files added**: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`
  (Contributor Covenant 2.1), `SUPPORT.md`, `.github/CODEOWNERS`, issue forms (bug, feature,
  partner inquiry) with blank issues disabled, a pull-request template, and a dependency-free
  `scripts/check-dco.mjs` (`npm run check:dco`) that fails any commit without a `Signed-off-by`
  trailer — enforced in CI on every pull request.
- **File-explorer uploads are browser-only**: the native Slack `file_input` modal and private Slack
  file download path are removed. One *Upload files / folder* button sends multi-file and folder
  selections directly into the confined gateway directory, so the ingest never uses Slack storage.
- **`/model` is now the single runtime command**, a four-step wizard in one self-updating message:
  scope (*This channel* or *Just this thread*, buttons) → harness (*Claude* / *Codex* buttons, plus
  *Use defaults* to clear the scope's overrides) → model dropdown → effort dropdown. Every step
  persists the moment it's clicked. Admin-only in channels, open to approved users in DMs. Typed
  `@bot /model` is the command — no Slack-manifest slash command is registered (a Bolt handler
  answers anyway, thread-aware, if one is ever added to the app).
- **Reply footers show the governing model**: the model in the run-stats footer follows the
  configured cascade — thread override → channel/DM model → gateway default — and only when
  nothing is configured anywhere, the CLI-reported model (the engine's own default). Context-window
  % and Codex cost estimates still key on the CLI-reported runtime model.
- **Admin-UI model fields are dropdowns** (were free-text "e.g. opus" inputs): Settings' two
  per-engine defaults plus the channel Runtime card and channel/DM config editors all pick from
  the same curated options as the `/model` wizard, following the selected/inherited engine. A
  hand-edited non-curated id survives as an extra option (Save round-trips it); switching engine
  drops the other engine's pick.
- **`/engine` and `/effort` are retired** — typed or slash-command invocations answer with a pointer
  to `/model`, and old `/engine` dropdown messages in history reply with the pointer instead of erroring.

### Added
- **Create files and edit general UTF-8 text from `/files`**: writable views now show *New file*
  beside the existing upload/folder controls. The Slack modal creates one confined file with
  optional initial text using exclusive, non-overwriting semantics and records
  `channel_file_created`. Editing is content-based instead of limited to `.txt`/`.md`, so `.env*`,
  JSON/YAML/TOML, configs, scripts, and extensionless UTF-8 files use the existing Worker/Auto
  permission boundary; Full remains admin-only. Managed, credential/token/secret, key, binary,
  invalid-UTF-8, oversized, traversal, and conflicting paths remain protected.
- **Multi-file and folder upload**: the browser-only *Upload files / folder* flow preserves
  directory structure for up to 200 files / 250 MB total using a one-time user/channel/folder grant,
  HttpOnly SameSite session,
  CSRF, repeated authorization/membership/mode checks, per-file confinement and 25 MB limits,
  collision-safe writes, and `channel_file_uploaded_in_browser` audits. Empty directories are not
  represented by browser folder pickers.
- **Create folders from the native file explorer**: writable channel modes now show *New folder*
  beside *Upload files / folder*. The modal creates one directory inside the folder currently on screen,
  repeats authorization/membership/mode checks, rejects protected names, separators, traversal, and
  collisions, and records `channel_folder_created`. Read-only hides the control; Full remains
  admin-only.
- **Native channel file explorer**: `/files` opens a Block Kit modal over the current channel's
  effective working folder; a message shortcut and typed `@bot /files` cover thread-scoped use.
  Navigation is AI-free, authorization/membership is rechecked, realpaths and symlinks stay confined,
  gateway internals and likely secrets are hidden, previews are bounded, and a confirmed selected
  file (≤25 MB) is uploaded only to the originating channel/thread with an audit event. Preview now
  states that truncation is display-only; *Send to me* delivers the complete file privately through
  the bot's Slack DM. Worker/Auto modes now open eligible UTF-8 `.txt`/`.md` files in a full browser
  editor (250,000 characters / 1 MB) through the configured public gateway URL, including a live
  Markdown split preview. One-use file grants exchange for HttpOnly editor sessions, with CSP,
  no-store, CSRF, revalidated authorization/membership/mode, an open-time hash conflict check,
  atomic replace, and audit logging; Full mode remains admin-only. The 3,000-character Slack editor
  stays as the no-public-URL fallback.
- **Per-thread model + effort overrides** (`thread-models.json` / `thread-efforts.json`, next to the
  existing per-thread engine override): the wizard's thread scope pins harness/model/effort for one
  thread only. Run-time precedence: per-run API override → thread → channel/DM → gateway default.
  A harness switch (wizard or `claude`/`codex` directive) drops thread model/effort that don't
  belong to the new engine.
- **Engine-switch context replay is now detection-based**: the thread's session row remembers which
  harness minted it, so ANY switch (wizard thread/channel scope, admin UI, flipped gateway default —
  not just the typed directive) makes the next turn replay the Slack thread into the fresh session.

### Fixed
- **The rename migration's `--verify` over-counted, and there was no way to re-run its repath.** The
  audit counted every string that CONTAINED a pre-rename path, so a finished production migration
  still reported ~56 600 "occurrences" — all of them a path quoted in a message, a tool result or a
  Codex `world_state` snapshot, plus two channel folders with a custom `workDir` that were
  deliberately never moved. It now counts STATE only: per JSON key path (Claude `cwd`; Codex
  `payload.cwd` + `payload.workspace_roots[]` — `world_state` is a per-turn snapshot Codex re-derives
  on resume, so it is content), and per existence (after the move, a recorded path that still
  resolves on disk names a directory that did not move). A project directory is stale when its name
  is no longer the encoding of its own cwd, or that cwd is gone — not when the name merely spells an
  old root. Everything else is reported in a "historical content — left by design" bucket next to
  the `events` log and never reaches the exit code, and the same key allowlist now bounds the
  REWRITE too, so a past turn's `file_path` is never edited. New `--repath` (with `--dry-run`) re-runs
  every rewrite pass against the current roots — database blobs and typed columns, config JSON,
  Claude projects + engine home, Codex index/rollouts/`config.toml`, work-folder text, service files,
  lockdown regeneration — moving nothing, idempotently, and ends with its own audit; it refuses while
  the daemon runs, exactly as the migration does. Production `--verify` now reports 0.
- **Codex fallback no longer inherits a Claude channel model**: a channel pinned to e.g. `opus`
  passed `-m opus` to the Codex fallback turn, which Codex rejects; the fallback now only honors
  Codex-family channel models and otherwise uses the gateway's Codex default.
- **/model picks in template-managed DMs were silent no-ops**: DMs default to the "User" org
  template, and `effectiveMeta` unconditionally replaced the DM's own engine/model/effort with the
  template's — so a DM `/model` pick persisted but never affected a run. A runtime pick made in the
  DM now overrides the template (empty still inherits; template model/effort don't carry over
  across a harness flip).

## [Unreleased] — `/delete` can remove user messages via an admin user token (2026-07-16)

### Added
- **Settings → Slack credentials → Admin User Token (xoxp, optional)**: when set, `/delete` also
  removes messages posted by humans and other apps — `chat.delete` is called with a per-message
  token override (a workspace admin's user token may delete others' messages where workspace
  preferences allow). Write-only (masked on read), validated to be a user token (`xoxp-…`), used
  ONLY by the org-admin-gated `/delete` — never passed to runs or MCP configs. Without it,
  `/delete` keeps its bot-messages-only behavior and the summary explains how to enable full
  deletion; with it, anything Slack still refuses is counted and reported.

## [Unreleased] — `/delete` in-thread command (2026-07-16)

### Added
- **`/delete`** (typed in a thread, org-admin only): deletes every message the bot posted in THAT
  thread — replies first, parent last — hard-scoped to the triggering channel + thread. Messages by
  humans or other apps can't be deleted with a bot token; they're counted and reported in an
  ephemeral summary instead of attempted. Refuses non-admin authors, mid-run threads (stop first),
  and top-level use; deleting a bot-owned thread root also drops the thread's session state like
  `/clear`. Covered by `test/thread-delete.test.js`.

## [Unreleased] — Admin UI redesign: #makeitfuture. brand + UX overhaul (2026-07-04)

### Changed
- **Full admin UI redesign** (`public/` only — zero API/server changes). New #makeitfuture. design
  system: self-hosted Poppins (`public/fonts/`, no CDN), orange `#fe3a02` + dark-teal token palette,
  wordmark shell, inline-SVG icons replacing every emoji in the chrome, branded login page.
- **IA restructure**: Dashboard → **Overview** (4 KPIs, orange hero cost chart with gridlines +
  dated peak); Audit → **Activity** (filterable search/channel/user/engine + paginated runs table;
  duplicate summary cards dropped for a one-line all-time strip); Channels + DMs + org templates
  merged into one **Conversations** section (grouped list with capability color dots, segmented
  All/Channels/DMs filter, fail-soft 30-day cost badges); Schedules → **Automations**.
- **Channel detail rebuilt** as Access / Tools / Runtime / Instructions / Memory: capability
  radio-cards (Full access red-treated + admin-tagged, Custom reveals raw flags), live access help,
  network switch row, filterable MCP/skills checklists with enabled counts, CLAUDE.md / MEMORY.md as
  mono editor cards. The three-save-buttons-with-a-footnote model is now ONE sticky dirty-state save
  bar (file editors keep their own Save, visibly editors); PUT payloads unchanged.
- **Users** is a table (role chips, C/S/T token state, Slack identity) with a right-side edit
  drawer; **Settings** gets a vertical section nav (Connection / Agent defaults / Integrations /
  Access & security / System) over the same single-Save contract presented as a sticky save bar with
  dirty tracking, chip editors for trusted apps + network domains, a red danger zone, and branded
  confirm/info dialogs replacing native `confirm()`/`alert()`.

### Fixed
- **Dashboard bar charts rendered empty**: `.bar-fill` was an inline `<span>` so its width/height
  were silently ignored — every "bar" was a blank track. Fills are now `display:block` and visible.

## [Unreleased] — Channel memory v2, the save loop (2026-07-04)

### Changed
- **Channel memory is now skill-packaged — nothing memory-related in `CLAUDE.md`.** `MEMORY.md`
  becomes a short budgeted index (default 3,000 chars) with `memory/<topic>.md` files for depth,
  linked as `[[topic]]` (an Obsidian-style graph inside the sandbox). The protocol (recall at task
  start, concrete save triggers, end-of-task checkpoint, consolidation) lives in a
  gateway-maintained `channel-memory` skill in each folder — refreshed write-on-change, pruned
  when memory is off. Modeled on Hermes Agent + Claude Code auto-memory; plan in
  the memory-improvement design note (internal repo). (Restored 2026-07-04 after a merge resolution dropped the
  Slice 11 code.)

### Added
- **`update_channel_memory` gateway MCP tool** — `add`/`replace`/`remove` on the index +
  `write_topic` for topic files. Daemon-side write, so saving works in every mode (read channels
  can't write files in-sandbox). Budget is enforced Hermes-style: an over-budget add fails with
  "consolidate first"; responses show a usage meter. The tool description restates the save
  triggers every turn — the always-on lever that makes the agent actually save.
- **Admin UI Memory tab** shows the budget meter and `memory/` topic files; an over-budget manual
  save is allowed but flagged.

## [Unreleased] — Durable channel instructions (2026-07-03)

### Changed
- **Channel `CLAUDE.md` is now the channel's own persistent instructions** — no longer regenerated
  every turn. The gateway upserts exactly one managed block at the top
  (`<!-- GATEWAY-INSTRUCTIONS -->`: global instructions + Slack-format guide + memory note;
  refreshed only when its content changes, self-repairing markers); everything below the end
  marker is user/agent-owned and survives new sessions, `/clear`, and settings changes on BOTH
  engines (AGENTS.md symlink). Legacy generated files migrate once — boilerplate collapses into
  the block, genuine channel text is preserved. Custom (real-project) folders are never
  block-managed. (`src/gateway/folders.js`, design in the instruction-injection note (internal repo).)

### Added
- **`update_channel_instructions` gateway MCP tool** — "add a rule that X" in Slack appends a
  standing instruction to the channel section in any mode (daemon-side write, outside the
  sandbox); `mode:"replace"` is admin-only.
- **Admin UI Instructions tab edits the real file** — the managed block renders grayed-out with an
  "edit in Settings → Behavior" link; the textarea edits only the channel section; saves are
  hash-guarded (409 on a concurrent change, e.g. the agent adding a rule) instead of clobbering.

## [Unreleased] — Claude Tag parity (2026-06-25)

A milestone informed by Anthropic's "Claude Tag" (`comparison-claude-tag.md`): adopt what fits a
confined local daemon — observability, memory, scheduling, light ambient — while deliberately NOT
copying cross-channel auto-memory.

### Added
- **Scope self-check on boot** — the daemon compares the installed app's live bot scopes (read from
  Slack's `x-oauth-scopes` response header on `auth.test`) against `slack-app-manifest.json`. When a
  required scope is missing it logs a warning and DMs every admin the exact "add these + reinstall"
  list, throttled to once per change in the gap. Because it runs on every boot it also fires right
  after `update_gateway`, so an upgrade that needs a new scope announces itself instead of silently
  half-working. (`src/slack/scope-check.js`.)
- **Usage ledger** — one normalized record per run (`usage-YYYY-MM.jsonl`) across interactive,
  scheduled, and background runs: engine, model, tokens, cost, duration. Daemon-side only
  (unreadable from a gated folder). Codex cost is estimated when an admin sets a `$/1M-token` rate.
- **Audit admin tab** — monthly totals, per-channel rollups, and a recent-runs feed over the ledger
  + run logs (`GET /api/audit`, `GET /api/audit/events`). Visibility only — no spend cap.
- **Background-job durability** — jobs persist to `config/bg-jobs.json`; on restart a live job is
  watched to completion and a job that exited while the daemon was down gets an "interrupted by
  restart" continuation, so a thread never silently stalls. (Closes the Slice 7 known gap.)
- **Live TODO checklist** — the agent's own TodoWrite plan renders as a ✓/◐/○ checklist, edited in
  place and left in the thread as a record (previously discarded).
- **Folder-scoped agent memory** — an opt-out `MEMORY.md` per channel folder that the agent reads
  and updates across that channel's threads. Single-folder (no cross-channel bleed); Claude's global
  auto-memory stays off. Non-bash channels get only a narrow `Write(MEMORY.md)` permission.
- **One-time ("run at") schedules** — `create_schedule` accepts `in_minutes`/`run_at` to fire once
  and auto-delete (e.g. "remind this channel in 2h").
- **Scheduler guardrails** — minimum recurring interval (admin setting, default 60 min) rejects
  runaway crons; per-channel enabled-schedule cap + a tick concurrency ceiling.
- **Provenance preamble** — each turn tells the agent who requested it and where (metadata, not an
  instruction), so it can address people correctly.
- **`@bot status` / `/status`** — a compact report of a channel's live background jobs, scheduled
  work, and warm/in-flight sessions.
- **Per-channel org-default token opt-out** (`meta.noDefaultTokens`) — a sensitive channel refuses
  the broad gateway-wide tokens; channel/user tokens still apply.
- **Dynamic assistant suggested prompts** — derived from the bound channel's MCP servers + skills
  (and refreshed on context change) instead of two hardcoded lines.
- **Opt-in no-response nudge** (`meta.nudges`) — one gentle reminder in a thread that has gone quiet
  past a window (default 24h). Strictly single-thread; never scans other channels.
- **App Home tab** — a read-only orientation dashboard (your access level, channels the bot works
  in, admin-UI link). No secrets.

### Changed
- The in-progress **activity log collapses** to a one-line summary on completion instead of being
  deleted, leaving a compact record above the answer.
- Slack app manifest: `home_tab_enabled`, `app_home_opened`, and the `/status` slash command.

## 2026-06-23
- Embedded **Toolbox MCP** with user / channel / org-default tokens.
- **Org-default** Composio / Skills tokens as the final fallback (channel → user → org).
- **Per-channel clean mode**: run bare for the lowest token cost (no MCP servers, skills, or
  favorites block) — closest to the model's base prompt.
- Background-jobs **auto-continue** shipped (Slice 7): the daemon owns long shell work and re-injects
  a continuation turn into the same thread when it finishes.
- **Multi-agent hygiene**: the 🤖 mention-reaction only auto-engages this agent in threads it owns.
- Settings split into 5 sub-tabs; clarified channel-access wording.

## 2026-06-22
- **Trusted bot apps** allowlist — let integrations (e.g. Make.com) trigger runs despite carrying a
  `bot_id`, still requiring a real @mention from an approved user.

## 2026-06-18 – 2026-06-19
- **Interactive permission approvals** in Slack (approve once / for this thread / forever / deny).
- **Per-channel modes**: Allow Bash (sandboxed shell + file edits), Allow Network (sandbox egress
  for `git push`/`gh`), Auto mode (autonomous, prompts auto-approved, still sandboxed); `/mode`
  command + mode badge.
- **Codex** engine integration matured: sandbox mirrors the channel mode; auto-fallback to Codex
  when Claude hits its usage/session limit; per-channel + per-thread engine selection via a
  `claude`/`codex` message directive.
- **Replies as plain Slack mrkdwn** (tables → code blocks, `##` → bold) — fewer "Show more" folds.
- **Mention-by-reaction** (react 🤖 to treat a message as a mention; configurable emoji).
- Admin UI redesign: left sidebar + master-detail Channels/DMs; channel detail sub-tabs.
- Cron schedules gained per-schedule notify targets + a "Running: <title>" announcement with the
  result threaded under it.
- Resume footer shows a copyable `cd … && claude --resume` command.

## 2026-06-17 — v1.0.0 (foundation)
- **Core gateway**: Slack Socket Mode (@slack/bolt) across DM / group DM / public / private channels;
  DM needs no mention, elsewhere requires an explicit @bot mention; spawns headless `claude -p` in a
  per-conversation **gated folder** (filesystem sandbox, MCP allowlist, persistent memory off).
- **Thread-scoped sessions** (new thread = new session; replies resume) + a **warm session pool**.
- **Per-user Composio token** injected per message author at spawn (`x-consumer-api-key`) — never
  shared, persisted to channel settings, or logged.
- **Approval-based authorization**: admins + approved (MakeItFuture-list) users; unknown users denied
  everywhere unless granted per-channel.
- **Admin web UI + REST API**: per-channel allowedUsers / allowedMcps / skills / mode; per-user
  tokens (write-only, masked); Settings page for Slack tokens, keepalive, MCP URLs — applied live
  with no restart.
- **Channel cron schedules** via a scheduler MCP tool; **admin MCP tools** to manage a channel's
  allowed servers, working folder, and modes from chat.
- **Image/file attachments** downloaded into the gated folder for Claude's Read tool; native Slack
  **Assistant status** shimmer; **stop**/`/stop`/stop-reaction to interrupt a run.
- Per-channel **Agent instructions** (`CLAUDE.md` + `AGENTS.md` symlink); Skills Manager favorites
  injected into `CLAUDE.md`; visible working folders under `~/Slack Agent/<channel>`.
- Optional **admin-UI password**; one-command installer; encrypted config **backup/restore**;
  **launchd** service with `npm run update`.
