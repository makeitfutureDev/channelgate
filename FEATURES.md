# ChannelGate — Features

- Release artifact scanning recognizes only exact SHA-256 fingerprints of reviewed public
  toolchain fixtures. PEM exceptions bind the complete key, never a header or first body line;
  repository/history scans and unknown or altered artifact credentials remain strict. Public
  provenance is recorded with every exception.

A categorized catalog of what's shipped. Cross-linked to `TEST-PLAN.md` checks.

- **Scoped Slack reads:** the operating guide keeps retries within an explicitly requested
  message scope. Empty searches do not permit history sweeps; channel metadata can resolve a
  name without retrieving unrelated messages. → TEST-PLAN: Exact-message read scope.

- **Skill-grant cost comparison:** an over-cap channel grant reports the current cost before
  granting, the projected cost on the next message, and the soft cap in both admin UI/API and
  chat tool feedback. Estimates cover organization and template grants plus dependencies;
  activation remains advisory, and repeating a grant does not inflate the estimate.
  → TEST-PLAN: Skill-grant context comparison.

- **Complete background-agent reports:** successful Claude and Codex agent reports retain their
  full redacted content in durable delivery state. Long reports use the regular outbound chunking
  pipeline, including after transport recovery, without a second model turn or silent preview cutoff.
  → TEST-PLAN: Complete background-agent report delivery.

- **Per-attempt runtime identity:** every orchestrated turn receives its selected engine,
  configured model/effort and fresh/resumed session state, including clean mode, model retries,
  session recovery and cross-engine fallback. The assistant is told to distinguish configured
  aliases from provider-reported identity and leave unexposed harness defaults unknown.
  → TEST-PLAN: Per-attempt runtime identity.

- **Disposable Linux lifecycle evidence:** the manually dispatchable Linux lifecycle workflow
  exercises a fresh dedicated-account systemd install with the full rootless Podman image,
  HTTP liveness after restart, encrypted fixture backup/restore and non-destructive uninstall.
  A local fixture upstream also proves the real CLI updater restores Git and restarts systemd
  after a candidate test failure or readiness failure; engine smoke and test/pretest commands
  are controlled fixture inputs.
  Its script refuses non-hosted or occupied hosts. A separate KVM guest workflow exercises an
  actual OS reboot, service autostart and persistent database/container-volume fixtures.
  Authenticated engine update smoke and conversation/session acceptance remain separate live
  gates. → TEST-PLAN: Disposable Linux lifecycle workflow.
- **Service-account image provisioning** uses the same explicit environment as the systemd
  daemon so operator XDG/container storage settings cannot redirect a fresh build into another
  user's private Podman store, and runs from the service-owned checkout so an operator-private
  invocation directory cannot prevent Podman namespace setup.

- Development acceptance policy: behavior changes include reproducible Claude and Codex
  acceptance definitions and clearly separate automated evidence from live operator validation.
  Public contributors do not need access to a private QA service. → TEST-PLAN: Development acceptance policy.

## Release readiness remediation

- **Enterprise integration scope:** Composio SDK implementation lives under `src/ee`, is labeled
  **Beta**, and requires Enterprise entitlement at settings, session, runtime and bridge boundaries.
  Personal API principals cannot claim an author's SDK identity; the bridge permits only signed
  session destinations. SDK Beta currently supports Slack identities. Standard MCP mode remains free.
- **Beta surfaces:** Google Chat and Microsoft Teams are labeled Beta in adapter/UI metadata and
  setup docs. Their replies use the engine's actual result content, and reminders/background
  delivery resolve their own connector even with Slack disconnected.
- **Trust boundaries:** numeric destination checks handle mapped IPv6; password replacement and
  removal require current-password proof; API tool overrides are reduce-only; editor leases live
  outside agent-writable artifacts; container bind sources reject symlinked path components. The
  Claude login relay and the shared Codex sign-in mount are unchanged (audit findings 5 and 8 are a
  pending product decision, not shipped).
- **Secret handling:** masked dialogs collect password proof. Known credential values are redacted
  from primary/fallback replies, stream events, errors and background delivery checkpoints. Shell
  jobs do not inherit engine service credentials. Exact-value redaction is not a vault and does
  not prevent an engine from transforming a usable credential.
- **Durable work:** memory mutations serialize across gateway processes. Bounded nonblocking reads
  reject special files and pin parent directory descriptors before publication. API/schedule/background
  execution checkpoints distinguish unknown interrupted runs from completed results awaiting
  delivery. Results retry delivery without replaying unknown tool work. Chat accepts into SQLite
  before ACK, uses bounded conversation dispatch and stops intake promptly. Individual memory
  files replace atomically; a multi-file batch is not crash-atomic. Delivery can repeat if a remote
  acknowledgment is lost after acceptance.
- **Release controls:** license verification is bound to the current key and request generation;
  the patched dependency lock, candidate/history scans, runtime SBOM/model inventory and signed
  artifact workflow supply explicit candidate evidence. License 1.3 reconciles unchanged bundled
  EE distribution and Enterprise feature use. Live and legal gates remain in the release checklist.

## Conversation settings and persistent memory

- **Reliable provider CLI device login:** the always-on operating guide and on-demand ChannelGate
  credential guide share one lifecycle: isolate conflicting token precedence to the subprocess,
  relay link/code as commentary, retain and poll the same TTY/session in the same assistant turn,
  recover a lost/expired session with a new code, and finish only after CLI confirmation plus a
  non-secret identity/access check. → TEST-PLAN: ChannelGate skill package.

- **Deterministic Composio identity selection:** `composio-user` is always the active requester's
  personal account; `composio-agent` is the shared agent account. Pronouns and named connection
  aliases select between them, ambiguous apps connected to both require a question, and connection
  discovery recognizes normalized MCP names and verifies active aliases without silent fallback.
  A missing personal identity is never substituted: a request for the requester's own account is
  served by `composio-user` or answered with the fact that it is absent, never from the shared
  identity's data — that identity holds other people's accounts.
  The rule now travels with the FACT it applies to: every run that injects Composio prepends one
  engine-neutral line to its prompt naming the identities that turn received — both (with the
  ask-first stop), only the requester's, or only the shared one (where a request for "my inbox" is
  answered by saying so and stopping). It is per run and per author, so a shared instruction file
  never has to carry a per-author sentence, and a channel with no Composio gets no line at all.
  → TEST-PLAN: Composio identity and connection discovery.

- **Focused conversation settings:** Access presents Read-only, Worker, and Admin as the
  base modes, with Auto and Lean as independent options; Custom is no
  longer offered. MCP Connections, Cloud MCP, Environment tokens, and Skills are separate first-class
  channel pages rather than nested beneath Tools; enabled skills sort first and the channel-level
  Grant Tier switch is gone.
- **Slack settings for authorized users:** replies requested by anyone allowed to use the agent add a
  requester-bound **⚙️ Settings** footer button. Its Block Kit console mirrors the web
  setup concepts: Engine & model can be changed by every authorized user in this console; MCP Connections
  rotates/removes the write-only Composio, Toolbox and Make MCP credentials plus inherited-token
  policy, and edits the Composio account label shared with the web setup form. Labels are shown
  in the summary and prefilled for editing; changing or clearing a label preserves the token.
  Only admins can see or manage Cloud MCP capabilities, independently for Claude and Codex;
  Skills supports direct grants and live template assignment; and Secrets opens the established
  add/update/remove manager. Inherited and template grants are labelled and cannot be removed from
  the wrong tier. Credential forms never prefill stored values, and all views expose only
  configured/masked state. Opening it, navigating, submitting, and every individual mutation
  re-check current channel membership plus agent authorization, including explicit channel guests,
  so historic controls cannot retain revoked access. Cloud MCP actions additionally re-check admin
  status. Secrets can be edited in every channel mode, including through `/secrets`; file-edit
  permissions and the separate `/model` command policy are unchanged.
  **Access** is a fifth tab, visible only to current admins/channel managers. They can edit the
  base mode (including Admin/full access), Auto, Lean, network, use/manage policy and named guest/manager lists. Selecting
  Full access does not grant anyone an administrator role; bypass still requires an admin author.
  Saves acknowledge immediately with a progress view, validate named users against live human
  channel membership, re-check management and roles at the write boundary, and audit policy changes.
  DMs keep the existing four tabs. Work-dir and gateway-wide settings are not exposed here.
  → TEST-PLAN: Conversation settings + on-demand memory.
- **Truthful guest access:** approved members appear selected because they already have access;
  admins are selected and locked, while explicit guest grants remain independently editable.
- **Uncapped, on-demand channel memory:** Markdown remains the portable source of truth. Fresh
  sessions receive only a bounded catalog (counts, topic names, retrieval contract), never the
  memory body. `search_channel_memory` rebuilds and queries a derived SQLite FTS5 index and
  `read_channel_memory` loads one validated source; both handlers return through the injected MCP
  response formatter. Writes no longer fail on a character budget. The index is optional per
  engine build: a Node whose SQLite lacks FTS5 (22.13, the floor) still boots, and search falls
  back to a plain scan with the same AND semantics and excerpts until the index exists.
  → TEST-PLAN: Conversation settings + on-demand memory.

## Maintainable module and persistence boundaries
- **No-build admin modules**: the browser entrypoint delegates same-origin/CSRF-aware requests to
  `admin-api.js`, reusable DOM/dialog/secret-field rendering to `admin-view.js`, and pure save
  reconciliation/routing state to the existing `admin-state.js` / `admin-routes.js` modules.
- **Slack ingress boundaries**: Bolt registration remains in `slack/app.js`; pure control-text,
  mention, subtype, and trusted-bot normalization lives in `message-normalize.js`; process-lifetime
  queue/dedupe ownership lives in `message-lifecycle.js`; status rendering is a controller; the
  message pipeline retains orchestration while preserving its public compatibility exports.
- **Crash- and contention-safe config**: secret JSON replacement writes a same-directory 0600 temp,
  fsyncs, then atomically renames. User and channel read-modify-write patches take an
  immediate SQLite transaction and skip omitted fields, preventing concurrent writers from
  silently restoring stale security or credential fields. → TEST-PLAN: Phase E module boundaries.

## Dynamic engine model catalog

- **One live catalog for every selector:** Codex's authenticated, installed CLI supplies its current
  selectable models through `codex debug models`; hidden entries are excluded and each model keeps
  the exact reasoning efforts the CLI reports. Slack's `/model` wizard and the Admin UI consume the
  same registry snapshot, so newly available models such as Astra appear without a ChannelGate code
  change. Discovery is bounded and cached for six hours; a failed refresh retains the last good
  snapshot, or the bundled fallback on a cold start.
- **Claude stays current through rolling aliases:** the catalog offers `best`, `opus`, `sonnet`,
  `haiku`, `fable`, `opusplan`, and the supported 1M aliases instead of pinning dated model IDs.
  Saved same-engine full IDs remain valid and round-trip through the Admin UI. Provider CLI/package
  upgrades are deliberately separate and continue through reviewed dependency PRs.
  → TEST-PLAN: Dynamic engine model catalog.

## Chat-platform adapter kernel

- Validated `PlatformAdapter` contract with a CLOSED 30-key capability spec: an undeclared
  capability resolves to the LEAST capable value, an unknown capability KEY throws instead of
  answering "no", and internally inconsistent reply modes (streaming without edits, modals without
  a card primitive, edits without an edit budget, mixed threading without native threads) are
  rejected at registry load.
- Descriptors for Slack (GA), Google Chat and Microsoft Teams encoding each surface's researched
  limits — edit budget per conversation, threading model (including mixed threaded/flat surfaces),
  Markdown reach, native artifacts, attachment reach, mention syntax and broadcasts.
- Conversation ids namespaced per platform (`gchat:`, `teams:`); Slack's stay bare so every row
  written before multi-platform support keeps resolving with no migration, and an unknown platform
  on a stored record resolves to Slack rather than to a degraded surface.
- Capability-driven outbound degradation: pipe tables become fixed-width blocks, headings become
  emphasis, images become labelled links, lists become literal bullets, quotes flatten — fenced
  code stays byte-exact, and a message is chunked at the platform cap without ever leaving a fence
  open. The model writes one dialect; each surface gets what it can render.
- One shared mention matcher across all three formatters (exact directory match, longest name wins,
  emails/code spans untouched, streaming hold-back for names straddling deltas), with per-platform
  rendering and control-sequence defanging. Teams emits the `<at>` tag and its matching entity,
  filtered per chunk so a split answer never ships an orphan entity.
- `ChatConnector` interface (post/edit/remove/openDm/threadFor/directory) as the single wire-format
  boundary; `postNotice`/`postDirectMessage` is the one path for unattended daemon posts
  (scheduler, background jobs, follow-up digests, nudges, self-diagnosis, restart recovery, API
  runs, shutdown). A platform whose transport is not wired gets a connector that THROWS on write —
  a silent no-op would read as a delivered answer.
- `gateway-usage` resolves per platform: `platforms/<id>/<name>.md` overlays the shared reference,
  the adapter's `guideDrop` removes files describing absent capabilities, `{{PLATFORM}}` is
  substituted at materialization, and admin overrides still win — now per surface. Each platform
  ships a `references/platform.md` stating exactly what renders there.
  → TEST-PLAN: Chat-platform adapter kernel.

## Google Chat and Microsoft Teams transports (Beta)

- **Google Chat runs outbound-only**, like Slack: a Cloud Pub/Sub PULL subscription consumes the
  events Google publishes for the Chat app, so there is no inbound endpoint and no tunnel. The pull
  loop long-polls, backs off with full jitter, acks before dispatching (a turn outlives any ack
  deadline), dedupes at-least-once redeliveries, and STOPS on a configuration fault (revoked key,
  missing `roles/pubsub.subscriber`, absent subscription) instead of retrying it forever.
- **Microsoft Teams runs on the documented Bot Framework endpoint** (`/api/teams/messages`), which
  authenticates every request itself against the Bot Framework JWKS — RS256 only, issuer, audience
  compared in constant time, expiry with clock skew, and the token's `serviceUrl` matched to the
  activity's. It acks in 200 ms and runs the turn afterwards, because Bot Service retries anything
  it did not get a fast 2xx for. Azure Relay (no public URL) remains a transport swap in front of
  the same handler.
- **Both credentials sets are hand-rolled against `node:crypto` and `fetch`** — an RS256 JWT
  assertion exchanged for a Google access token, an Entra client-credentials grant for Teams — so
  neither surface adds a dependency to a product whose pitch is confinement. Tokens are cached,
  single-flighted, and dropped on a 401 so the next call re-mints.
- **Three hostile inputs are validated at the boundary, not downstream:** Chat resource names
  (a `..` segment or a stray slash never reaches a URL path), Teams conversation/activity ids (the
  `;messageid=` reply suffix is ours to build, never to accept), and the Teams `serviceUrl` (an
  allowlist of Bot Framework hosts — the URL arrives in the activity and receives our bearer token,
  so an unvalidated one is a credential-exfiltration primitive). Teams attachment downloads are
  restricted to Microsoft-owned hosts for the same reason.
- **One platform-neutral ingest path** turns an inbound message into a turn: the mention gate (DM
  needs none, anywhere else must address the bot), the same authorization rules as Slack, channel
  registration with the surface stamped on it, attachments written into the gated folder with the
  same no-follow discipline, `runMessage`, the usage ledger, and one answer that replaces its own
  "working on it" placeholder. Both surfaces get their own run origin, and NEITHER is escalatable:
  escalation needs an interactive permission prompt the author can answer, and until a surface has
  one its runs use the folder allowlist like every other run.
- **Google Chat's DM threading quirk is handled explicitly**: Chat mints a fresh thread per
  top-level DM message, so a first-seen DM thread is the main flow (one continuous session, reply at
  top level) and a thread the user replies into is a real side thread. A threaded reply always
  carries `messageReplyOption`, without which Chat silently starts a new thread.
- **Live connect/disconnect per platform** from the admin Settings page (credentials write-only,
  `has*`/`last4` on every listing, values only through the re-authenticated reveal endpoint), plus
  per-platform health that distinguishes *not configured*, *configured but not connected*, and — on
  Teams — *connected for sending, but no public URL, so nothing can be delivered*.
- **Teams onboarding uses Microsoft's CLI end to end**: the Admin UI and operator guide give the
  install/login commands, generate a copy-ready `teams app create` command from ChannelGate's exact
  public `/api/teams/messages` event endpoint, map the emitted credentials to Settings, and show
  how to obtain the generated app's Teams install link.
  → TEST-PLAN: Google Chat and Teams transports. Setup: `docs/PLATFORMS.md`.

## Engine adapter kernel

- Validated `EngineAdapter` and `RunContext`/`Principal`/`Origin` contracts fail closed for unknown
  engines, unsupported network policy, or adapters without confinement and health compilers.
- Claude pooling and Codex execution/MCP policy run behind adapters; fallback routing is a directed
  registry graph, and every registered CLI receives a boot version/readiness probe.
- Slack and Admin selectors consume registry manifests. Codex optional MCPs under
  `--ignore-user-config` receive complete credential-safe definitions.
- OpenCode proves the third-engine contract without orchestrator or UI conditionals. Its adapter is
  deliberately restricted to workspace read/glob/grep/list with model-tool network off: shell,
  edits, external directories, plugins, MCP, and bypass modes fail closed because OpenCode
  permissions are not an OS sandbox. JSON streaming, session resume, cancellation, usage/cost, and
  health/version are supported. See `docs/OPENCODE-ADAPTER.md`. → TEST-PLAN: OpenCode proof adapter.

## Public website
- The marketing / early-access site (and its lead-routing contract) lives in its own
  repository — this repository ships product code only.
- **Public entrypoint:** README leads with a descriptive product heading, team benefits and setup,
  followed by eight feature groups, practical use cases and explicit platform/engine support.
  Searchable product terms and descriptive documentation links cover self-hosted AI agents, Slack,
  Teams, Google Chat, Claude Code, Codex, MCP and workflow automation. The homepage distinguishes
  Codex skills/estimated costs, on-demand memory, SQLite storage, background restart outcomes,
  bot artifacts versus Composio canvases, and the actual container/credential/data-flow boundary.
  License, partner links and support status stay visible; promotional assets are linked only when
  they exist. Maintainer release/presentation instructions live in `docs/MAINTAINER-RELEASE.md`.
  → TEST-PLAN: README hero guards.

## Conversation gateway
- Slack Socket Mode listener across DM / group DM / public channel / private channel
  (`@slack/bolt`). → TEST-PLAN: Slack gateway.
- Native Slack progress and answer isolation: when a run emits task/tool/thinking progress before
  its answer,
  its collapsible live card is posted as the first thread message and updated there; the Markdown
  answer streams into a separate later message, so expanding “Thinking completed” can never split
  a sentence. A shared queue preserves creation order, each stream rolls independently before
  Slack's age limit, and answer footer/fallback behavior stays on the answer only. Text-only turns
  keep their single-message shape. → TEST-PLAN: Observability (Slice 6).
- Mention gating: DM = no mention; channel/group/private = require `@bot`. → TEST-PLAN: Slack gateway.
- Thread-scoped Claude sessions — new thread = new session, replies resume. → TEST-PLAN: Foundation.
- Subagent completion contract (mechanical) — every generated channel settings file installs a
  Stop hook (`src/gateway/hooks/stop-subagents.mjs`): the Claude CLI refuses to end a turn while
  background Agent/Task subagents are still running, forcing the parent to wait and incorporate
  their results (bounded at 30 blocks so a hung subagent can't wedge a thread; background shell
  tasks are exempt on purpose). Codex needs no hook — its orchestrator natively joins subagents
  before a turn completes. The old injected instruction rule is removed. → TEST-PLAN: Foundation.
- Background AGENTS (`run_agent_in_background`) — the durable subagent: the daemon runs a separate
  engine session (Claude or Codex, same channel folder/lockdown/mode, launching author's tokens,
  fresh session on a synthetic thread key, cold — no warm-pool residue) on a self-contained task,
  streams its progress into the job tail, then posts the agent's self-contained final report
  (capped 12k chars) directly through the sanitized/chunked unattended-delivery path. A completed
  report never depends on a second model turn (and therefore cannot be stranded by that model's
  usage limit); shell jobs and failed/incomplete agents still use an interpreted continuation.
  Allowed in every channel mode
  (the run enforces the channel's own permissions; approval prompts still surface in-thread).
  Both job kinds post a "started" note in-thread with a *Check status* button (ephemeral live
  status: runtime + recent activity; finished jobs answer with the persisted log tail, and a
  failed ephemeral falls back to a visible thread reply); `/status` marks agent jobs with 🤖.
  Agent jobs may run up to ONE WEEK (shell jobs keep a 60-minute default — they run unsandboxed);
  the cap is a runaway backstop, not a budget, matching the never-kill-quiet-turns watchdog rule.
  Jobs persist in `bg_jobs` and recover across daemon restarts (agent jobs finish as
  "interrupted"). The injected `gateway-usage` skill and the MCP tool description both make the
  routing rule explicit: delegated work that may outlive the caller's turn MUST use
  `run_agent_in_background`, never an engine-owned background Agent/Task, and the caller ends its
  turn without polling or asking the user to prompt it later. → TEST-PLAN: Background jobs.
- Plain-language process outcomes: successful background work says **completed successfully**;
  failures distinguish general errors, rejected input/options, missing or non-executable commands,
  time limits, operating-system interruption/forced stop, and restart-unknown results. The same
  semantic formatter covers Claude, Codex, OpenCode, engine health/MCP discovery, Drive sync,
  voice transcription, CLI compatibility checks, Whisper provisioning, and transactional update
  commands. Structured provider details remain actionable (quota reset, authentication, denied or
  invalid requests, temporary provider outage), and short subprocess diagnostics are secret-redacted
  before display, while raw exit values/signals stay only in structured logs/error metadata for
  diagnosis. → TEST-PLAN: Plain-language process outcomes.
- Admin outranks auto (`adminUnattendedTier`, 2026-08-08): a non-escalated run whose stored author
  is a gateway admin in an adminMode channel — every daemon origin: background agents,
  continuations, schedules, recovery — runs at the AUTO tier for both engines (writable folder
  sandbox, permission prompts auto-approved) instead of the read floor that used to make admin
  channels' background work silently no-op. Never an escalation: the
  `--dangerously-skip-permissions`/sandbox-off path stays exclusive to live admin foreground
  turns (A2), untrusted API principals never qualify, non-admin authors keep the normal floor,
  and control-plane ("agent"-type) approvals still require a human click. The `/mode admin`
  confirmation spells the split out. → TEST-PLAN: Background jobs, Security checks.
- Deterministic Codex MCP startup: Codex does not block a turn while its MCP servers come up — it
  takes whichever finished before it builds the first request, and a resumed turn reaches that
  point far sooner than a fresh one. So every header-bearing remote MCP (both Composio identities,
  the Toolbox, a channel's Make toolbox) is dialled by Codex itself over its native
  streamable-HTTP transport rather than bridged to stdio, and its credential is produced at
  startup by a per-run `http_headers_helper` script that reads the run's 0600 secret bundle — the
  token never appears in Codex's argv or environment. Remote servers still get
  `startup_timeout_sec=120` (gateway control server 60) as a ceiling on the handshake itself.
  Before this, the `mcp-remote` bridge needed ~2.4 s to answer `tools/list` and made only the cold
  window, so the SECOND turn of a Codex thread had no Composio tools at all.
  → TEST-PLAN: Background jobs, MCP.
- Resilient image/file attachments: every accepted Slack trigger is hydrated from the exact
  canonical root/reply before processing; `message` and `app_mention` delivery is deduplicated by
  message identity; direct, legacy, attachment, and file-block references are merged; incomplete
  ids resolve through `files.info` with one bounded pending-file retry. A file-only thread message
  followed immediately by an `@mention` carries that file forward, but intervening text prevents
  stale-file reuse. Ordinary files still land only in the confined channel `uploads/<thread>/`
  folder and enter the engine prompt as local paths (images render visually via the Read tool).
  Canonical/read failures preserve usable event files and text prompts, while missing download URLs
  produce an explicit skipped-file note.
- **Attachments up to 500 MB, never held in memory.** One shared ceiling
  (`ATTACHMENT_MAX_BYTES`, `src/util/bounded-bytes.js`) governs every inbound attachment — Slack,
  Google Chat, Teams and a Run API `fileUrl` — and every sink streams the body straight into the
  channel folder through `writeStreamNoFollow` (exclusive no-follow temp + rename, the running
  total checked per chunk, a declared Content-Length over the cap refused before a byte is read, an
  over-running body cut off with its temp removed and the destination untouched). A refusal names
  the size and the limit (`263.4 MB exceeds the 500 MB attachment limit`) so the person knows what
  to shrink; a Slack download above 8 MB announces itself in the assistant status while it runs. A
  body that turns out to be Slack's HTML sign-in page is refused from its first chunk, before
  anything is committed. → TEST-PLAN: Slack gateway (Slice 4).
- **On-demand attachment download, this channel only (`slack_download_file`).** The pre-run path
  delivers the files on the triggering message; anything the person shared earlier — the thread's
  first-message recording, a file posted before the mention — is visible in history (id, name,
  size) but was never in a run's prompt, and the bot could only ask for a re-upload. The gateway
  tool takes a `file_id` (or a pasted Slack file link), asks Slack for the descriptor with the bot
  token, refuses it unless Slack reports it shared in THIS channel (`listChannelIds`, the same scope
  rule as Slack Lists), streams it through `downloadSlackFiles` into `uploads/<thread ts>/` under the
  shared cap, and hands the model a LOCAL path — never a private URL or the token. A file already
  in the folder is reused. Un-gated (it lands only in this thread's folder). The hydration step
  also carries a thread ROOT's attachments into a later reply marked `carriedFrom:"root"`, and the
  pipeline downloads such a file only while it is missing from the folder and its declared size
  fits the cap — a retry of a delivery that never happened, not a re-attachment on every reply;
  files behind intervening text elsewhere in the thread are still never reached. The
  `gateway-usage` reading reference tells agents to download rather than ask for a re-upload.
  → TEST-PLAN: Slack gateway (Slice 4).
  Current-channel history/thread tools expose only safe file id/name/MIME/size metadata—never
  private Slack URLs. → TEST-PLAN: Slack gateway.
- Optional local voice prompts with Slack fallback: after the normal trigger/auth gates accept a
  DM, `@mention`, or 🤖 reaction, enabled local Whisper (`whisper.cpp` v1.9.1 + multilingual
  `large-v3-turbo`) is tried first. Disabled/unavailable local transcription falls back per clip to
  Slack's completed full VTT transcript; absent transcripts prompt the user to click **Generate
  transcript** and re-trigger. Fresh installers ask whether to provision Whisper, updates honor the
  stored setting, and disabled mode never downloads raw audio. Typed text remains instructions and
  raw audio is excluded from Claude/Codex. → TEST-PLAN: Voice prompts.
- Native Slack **channel file explorer**: `/files` opens a Block Kit modal rooted at the channel's
  effective working folder. Its title identifies the authoritative stored Slack channel name, and
  its subtitle shows the full absolute current directory, refreshed on every navigation. The
  *Browse channel files* message shortcut opens it for a selected thread, typed `@bot /files` posts
  an ephemeral *Open files* button for thread-aware use, and every interactive run footer carries a
  requester-bound `📂` button beside `💻` for one-click access; managers also receive the
  requester-bound **⚙️ Settings** snapshot button described above, and gateway admins may open a
  control attached to another user's bot reply. When an agent names up to five
  existing files inside its effective working folder for review, the same footer adds deduplicated
  `📄 filename` buttons in mention order. A named path may be absolute or written relative to the
  working folder — the form an agent inside a gated channel folder actually uses, and the one that
  keeps the host's home directory out of the Slack message. Relative references resolve against the
  run cwd before the same realpath confinement check, and must carry a separator or an extension,
  so ordinary inline code (`main`, `npm test`) and URLs never become controls. Each is bound to the requester/channel/thread and opens
  the existing explorer directly on the exact file preview. Button notices are ephemeral to the
  clicker and explicitly remain in the source thread instead of leaking into the channel timeline.
  Every sibling footer control carries a
  unique registered action id, so one or many review targets remain valid Block Kit; encoded spaces
  and source-line suffixes are accepted, while missing files, directories, malformed paths, and
  realpath escapes produce no control. The injected Slack writing guide makes the
  inline-code form a standing rule rather than a footnote: `gateway-usage` rule 3 (seen every turn),
  a worked ✅/❌ block in `references/writing-replies.md`, and a `references/git-repos.md` step
  telling repo tasks to report the landed path instead of a `.worktrees/<slug>/…` copy that step 4
  deletes before the reply is even rendered. Older local Markdown links are still detected.
  Folder navigation, pagination, metadata, and bounded text previews run daemon-side with no AI
  call. Every interaction rechecks authorization + membership; realpath confinement permits only
  contained symlinks. Every contained regular file and directory is visible and previewable,
  including dotfiles, `.env`, `.git`, `.claude/settings*.json`, the complete `.claude/skills/` tree,
  `CLAUDE.md`, `AGENTS.md`, and memory files. Broken or root-escaping symlinks are still shown by
  name but have no open control.
  Protected/internal paths remain read-only in the explorer, and forged action state cannot escape
  the working root. In writable modes, *New file* exclusively creates one safely named UTF-8 file
  with optional initial text and audits `channel_file_created`; *New folder* creates one safely
  named directory in the folder on screen. Public URL settings accept either a complete URL or a
  bare hostname, which is normalized to HTTPS. When a public URL is configured, the single *Upload files / folder* button
  opens a one-time, user-bound browser session for up to 200 files / 250 MB total and preserves
  nested folder paths (browser pickers omit empty folders). Selected files travel directly from
  the browser to the gateway folder and are never staged in Slack file storage. These flows
  refuse protected/traversal names, never overwrite collisions, and audit every result. Read-only
  mode hides write controls and Full remains admin-only. With a Public URL configured, every file
  preview also offers *Download*: a requester-bound, 10-minute, single-use URL rechecks channel
  authorization + membership and realpath confinement, then streams the complete file directly
  from the gateway with no Slack file copy, including files above Slack's 25 MB sharing limit; each
  accepted transfer audits `channel_file_downloaded`. A confirmed *Share* copies a
  selected regular file (≤25 MB) only into the originating channel/thread; *Send to me* delivers the
  complete selected file privately through the bot's Slack DM, independent of the user's network.
  Preview truncation is explicitly presentation-only. In
  Worker/Auto modes, authorized members get both the native Slack *Edit* popup (for files up to
  3,000 characters) and *Edit in browser* for valid UTF-8 text files up to
  250,000 characters / 1 MB regardless of extension, including `.env*`, JSON/YAML/TOML, scripts,
  configs, and extensionless files. Managed, credential/token/secret, key, binary, and invalid-UTF-8
  paths stay read-only. The configured public gateway URL opens a full-page editor with a live
  Markdown split preview for Markdown. A 10-minute one-use capability is exchanged for a one-hour HttpOnly,
  same-site, one-file browser session; the route is no-store/CSP/CSRF protected. Full mode remains
  admin-only, and every load/save rechecks access/membership/mode, verifies the open-time content
  hash, atomically replaces the confined file, and records an audit event. Without a public URL the
  Slack controls its native modal dimensions; apps cannot request a larger popup. Without a public
  URL, the 3,000-character Slack modal editor remains available on its own. Existing Slack apps must
  apply the latest manifest to activate the registered command + shortcut; typed `@bot /files` uses
  normal messages.
  → TEST-PLAN: Channel file explorer.
- Slack Agent app (`agent_view`): native status animation (`assistant.threads.setStatus`) with
  progress-tracking phrases in agent threads. As soon as the spawn runtime resolves, the prominent
  loading indicator identifies its configured model through `loading_messages` (for example,
  `Opus 4.8 1M · Gathering information…`, with the model first so right-edge truncation cannot hide
  it). The shared status boundary caps the rotation at Slack's documented ten messages and each
  message at the API-enforced 50 characters, adding a surrogate-safe ellipsis when needed so an
  overlong thinking/tool phrase cannot disable the live status. The compact activity line beneath
  the composer retains the same model while showing tool/thinking phases, and a cross-engine
  failover replaces both labels mid-turn. Streamed placeholder message elsewhere. Top-of-Messages-tab
  suggested prompts (seeded on `app_home_opened` tab=`messages`, derived from the channel's MCP
  servers + skills) and per-thread
  auto-titling (`assistant.threads.setTitle`) so the Messages-tab timeline reads well.
  → TEST-PLAN: Slack gateway.
- Auto-registration of any conversation the bot sees (index + default meta + folder).
- In-thread replies with a placeholder that streams → final answer + token/cost footer. Every
  footer reports only that message's root turn: resumed Codex sessions refresh their settled
  container-volume accounting path before the baseline snapshot, so cumulative provider-session
  totals cannot masquerade as one reply's tokens/value. Canonical ledger descendants remain
  additive and separate from the message footer. → TEST-PLAN: Slack gateway.
- Slack replies use native Slack text streaming: the answer is written live via
  `chat.startStream` / `appendStream` / `stopStream`, with the run-stats footer appended as a block
  at `stopStream`. Answer deltas use `markdown_text`, so small GFM pipe tables render as styled
  inline tables (including code/bold cell content); the classic-post fallback preserves them as
  aligned monospace grids when streaming is unavailable. A rejected footer block is retried without
  controls (and classic delivery preserves the stats as text), so cosmetic Block Kit validation can
  never turn an already-completed engine answer into `run_error`. If Slack rejects the stream's
  terminal call outright (a rate-limited `stopStream`), the classic recovery removes the partial
  streamed message before posting the complete answer and puts the footer on that answer, so a
  failed finalization still leaves exactly one reply rather than a truncated copy, a duplicate and a
  stats-only trailer. If Slack has ENDED the answer's stream instead
  (`message_not_in_streaming_state` / `message_not_found` on an append or on the terminal stop), the
  answer is republished rather than abandoned: a fresh stream receives the complete compiled answer,
  the refused delta is replayed onto it, the footer lands on that surviving message and the stranded
  copy is deleted only once the replacement is durable — a lost streaming window costs a message,
  never a delta or the footer. Alongside the answer, tool calls
  and the agent's plan render in Slack's native
  **task_update card**, streamed as its own message directly ABOVE the answer — a turn with progress
  is two bot messages (the live card, then the uninterrupted answer beneath it), a text-only turn
  stays one. A tool, subagent, notice or progress-report row that arrives after the answer has
  started still opens the card; only the content-free liveness pulse is suppressed then, so one
  preamble sentence before the first tool call never costs the turn its toolbox. Rows are
  grouped into ONE collapsible "steps" card
  via `task_display_mode: "plan"` (not a separate box per step): each tool call is a row that starts
  `in_progress` and closes as soon as Claude or Codex reports its result (with
  next-step/answer fallback for older events), and a `TodoWrite` plan upserts a row per item carrying
  its real pending/in_progress/complete state. Raw tool results never enter the progress event.
  A tool that FAILED is labelled on its own row (`⚠️ Bash(…) · failed`) and still closes `complete`,
  because Slack derives the card's header from the aggregate row statuses — one `error` row repaints
  the whole toolbox as "Something went wrong" even when the turn recovered and answered. `error` is
  reserved for a stage the agent itself declares failed through `report_progress`.
  Native in-turn **Claude and Codex subagents** use the same card with independently updating
  parallel rows: the engine adapters normalize Agent/Task and every shape Codex reports a child in
  — multi-child `agents_states` updates, `receiver_agents`/`receiver_thread_ids`, the
  `SubAgentActivity` start/finish lifecycle (keyed on the child's thread id, so the spawning call
  and the completion merge into one row) and the `collaboration` spawn call whose task name titles
  it — while a collab call that names no child (Codex multi-agent v2 waits) renders the
  coordination step itself rather than nothing. Because `codex exec --json` forwards NONE of those
  identity-bearing shapes (CLI 0.153.4 sends one anonymous `wait` item and hides the spawn call
  entirely), the Codex runner takes a child's identity from the only place it exists on the
  daemon's side: the child's OWN rollout, whose `session_meta` names it (`agent_path`,
  `agent_nickname`) and its parent. A collaboration item is the cue to read those rollouts and open
  a named row per child while they work; the end-of-turn accounting pass — the same one that bills
  subagent tokens — closes each row with the child's elapsed time and token spend. Completed rows
  remain visible, elapsed/token/tool metadata appears when supplied, and
  failed/stopped/missing-terminal lifecycles close with an explicit warning instead of leaving a
  spinner behind. The assistant shimmer also reports how many native agents are active. These
  joined children are distinct from durable `run_agent_in_background` jobs, which retain their
  separate status-button message because they can outlive the turn. The card degrades quietly
  (answer keeps streaming) where task chunks can't render, and the whole reply falls back to a
  plain posted reply if streaming is unavailable. → TEST-PLAN: Slack gateway.
- Persistent toolbox plus temporary assistant status: the native `task_update` toolbox is durable
  reply content in **every** thread type, including assistant/AI-app threads. Its tool, plan,
  subagent, and heartbeat rows stream live into the card message and remain available in Slack
  history after the run. Finalize, controlled stop, and every stream rollover re-send a complete
  row snapshot as `chat.stopStream` chunks, sealing each toolbox into its message after streaming
  ends. Slack REPLACES a row's title and status but APPENDS its rich `details`/`output`, so a row
  sends those only when they actually change — the seal never repeats a value the live card already
  rendered, and a value that grew carries just its added tail. A rollover reseeds the successor
  message in full. During a long-run rollover, a successor first receives the complete compiled answer and
  full toolbox snapshot (completed history plus current in-progress state); only after that copy is
  durable is the retired bot message deleted, keeping one authoritative reply visible whenever the
  answer fits Slack's single-message limit. A failed cleanup leaves both safe complete copies and
  retries at terminal state rather than risking answer loss.
  Independently, the native assistant-status shimmer is a temporary live activity surface: it
  carries **thinking summaries** (the latest line of the actual reasoning text, throttled and
  clipped to 80 chars; Codex reasoning summaries too; redacted thinking stays bare), tool labels,
  subagent counts, and elapsed time; the prominent `loading_messages` line mirrors the same
  activity (model label first). Because Slack wipes the status whenever the app writes in the
  thread, tool and semantic progress-report toolbox writes restore it immediately, while streamed answer
  appends restore it on a bounded cadence; the liveness tick also re-asserts it when unchanged.
  Status writes are serialized AND bounded: one write is in flight at a time and exactly one
  pending slot holds the latest phase, so a phrase superseded before it reached Slack is dropped
  instead of being sent late, and a rate-limited workspace cannot build a backlog. Activity can
  never race the terminal clear or resurrect the box after completion. Finalize and stop clear that
  temporary status, but DELIVERY IS NEVER GATED ON IT: the clear is fired and waited on only for a
  few seconds before the answer goes out, and it still lands afterwards (posting in the thread
  clears the box on Slack's side anyway). Ordinary channel threads simply no-op that surface while
  keeping the same persistent toolbox.
  → TEST-PLAN: Slack gateway.
- Long-turn liveness without Slack's five-minute red-card failure: the 20-second heartbeat is a
  succession of completed native task pulses rather than one indefinitely open task. Pulse IDs
  rotate every four minutes, the latest pulse is relabelled on finish/stop/delivery failure, and
  recap rows omit every heartbeat generation. The message-level safeguard independently measures
  the age of the actual Slack stream (not the earlier SDK helper): before 5 minutes it seeds a fresh
  stream with the complete compiled answer and full toolbox, then removes the retired bot message.
  Rollover repeats for arbitrarily long turns, final delivery closes the newest stream, an
  unseedable successor falls back to complete classic delivery, and sanitized failure codes are
  logged once per site without exposing payloads. When Slack ends a card's stream FIRST — an
  append delayed past its window by rate limiting, or an age cap the local clock did not beat, both
  reported as `message_not_in_streaming_state` — the card is republished rather than abandoned:
  Slack renders an abandoned stream as a bare "Something went wrong", which would leave a red error
  banner above the correct answer of a turn that merely hit (and handled) a failing tool. The
  replacement receives the complete row snapshot, the stranded copy is deleted only after it is
  durable, and a terminal seal that finds the stream already gone republishes the finished toolbox
  the same way. The ANSWER stream recovers identically — the compiled reply is reseeded, the refused
  delta replayed, the footer sealed onto the survivor — so a stream Slack ends first can cost a
  message but never the answer or its footer. Only a replacement that cannot be made durable
  degrades: to no card at all, or, for the answer, to the complete classic fallback (which also
  removes the stranded partial).
  → TEST-PLAN: Observability.
- Dedicated progress report inside the unified toolbox: for long/substantive domain work,
  the always-injected `gateway-usage` guide teaches skills to publish authoritative semantic-stage
  snapshots through one shared, strict `report_progress` MCP contract used by Claude and Codex.
  Long analysis/research/review and work spanning 100+ independent items must be split into bounded
  subagent scopes (parallel when independent, with a separate verifier where accuracy warrants it).
  Each delegated plan stage discloses the agent role, scope, actual model, and effort—or truthfully
  says the value is inherited/not exposed—and refreshes exact item, batch, and disagreement counts
  at meaningful checkpoints. Work that must outlive the turn still routes to daemon-owned agents;
  contexts without the Plan tool never claim one. Slack streams a
  `plan_update` title and rich `task_update` stage rows into the **same expandable toolbox** as the
  low-level tool/subagent history, in the turn's own progress-card message directly above the
  answer—never a third persistent message.
  Stable step IDs retain pending/in_progress/complete/error state plus optional details, output,
  and source links; each stage's details and output are delivered once, on the chunk that changes
  them, so a finished plan never renders the same paragraph two or three times. The capability is
  exposed only to visible, non-clean
  interactive Slack and non-recovery Slack-backed API turns; daemon jobs, schedules, recovery,
  diagnosis, and headless runs fail closed. Identical snapshots are deduplicated; controlled stops
  and final-delivery failures mark only the active step as error while preserving completed/pending
  work; chunk failures disable only the shared toolbox, leaving answer streaming intact. Progress-report
  state is intentionally turn-local rather than crash-persistent. → TEST-PLAN: Slack
  gateway.
- HTTP run API (`POST /api/runs`) for automations: accepts message/file input, optional target
  Slack channel, per-run engine/model/effort/mode overrides, idempotency keys, status polling,
  stop, and completion webhooks. Channel-backed API runs post the full request in Slack and use the
  same visible progress/streaming path as interactive turns; headless API runs stay silent and
  finish through status/webhook. Running/queued API jobs in `api_jobs` are recovered after daemon
  restart for both Slack-backed and headless requests, with an attempt cap. Every settled run
  publishes a cost: the engine's own dollar amount when it reports one, otherwise the usage
  ledger's priced estimate for that same run (Codex reports none), flagged `costEstimated` in the
  status response and the webhook — `null` only when nothing anywhere knows.
  → TEST-PLAN: Automation.
- Codex JSONL progress: Codex `item.started` / `item.completed` events for MCP tool calls, shell
  commands, and final agent messages feed the same Slack status/log stream as Claude, so Codex
  turns no longer look silent while tools run. Gateway-owned MCP tools are pre-approved inside Codex
  because the gateway MCP server already enforces schedule/reminder/background/channel-admin policy.
  → TEST-PLAN: Engines; Modes & approvals.
- Provenance: each turn tells the agent who requested it and where (metadata, not an instruction), so
  it can address people correctly. Tool access stays the sender's (re-resolved per message).
- Slack split-view provenance: `app_context_changed` snapshots are held per workspace/user and
  injected only into that authorized user's ordinary DM prompt, so phrases such as “this channel”
  or “this thread” resolve to the Slack conversation visible beside the agent. Entity types and fields are
  allowlisted, bounded, short-lived, and never injected into channels, clean turns, stale events,
  or another user's request. → TEST-PLAN: Slack gateway.
- Real `@`-mentions: the agent just writes `@Display Name` in its reply and the daemon rewrites it to
  a real `<@UID>` Slack mention (a blue, notifying tag) — no id lookup at generation time, so it costs
  zero extra tokens. Backed by a cached workspace directory (`users.list`, name→id, 15-min TTL,
  warmed at connect; needs the `users:read` scope). Exact-match only (longest name wins), so unknown
  names, emails (`bob@x.com`), Slack's own `@here`/`@channel`, and text inside `` `inline code` `` are
  left alone, and an ambiguous name (two users, same display name) is never guessed. Works in `stream`
  mode too — a mention split across delta chunks is held whole via a small buffer. Applies to
  interactive replies plus scheduled-run and background-continuation posts. → TEST-PLAN: mention resolution.
- Ambiguous bare first names fail safe: if two members answer to the same first-name token — including
  a handle/first-name collision — `@FirstName` stays literal instead of notifying the wrong person;
  exact full names and unambiguous handles still resolve. → TEST-PLAN: mention resolution.
- `/status` (slash command only): a compact report of what a channel is working on — live background
  jobs, scheduled work, and warm/in-flight sessions. A plain "status" message deliberately goes to
  Claude (it summarizes the thread's actual work), not the canned report.
- In-thread commands (typed as normal messages): `/help` (a practical operating guide covering
  channel/DM addressing, 🤖 engagement, thread stopping/steering, files, personal Composio setup,
  the skill catalog, channel memory/rules, the automatic gateway skills, reminders/schedules,
  long-running background work, useful status checks, and the complete command reference),
  `/files` (native explorer; thread-aware open button), `/clear` (drop the thread's session — next
  message starts fresh), `/context` (token usage + % of the context window from the last turn),
  `/resume` (the copyable `cd "…" && claude --resume <id>` terminal command for this thread's
  session — kept out of reply footers; also behind the 💻 button on "🛑 Stopped." messages → modal.
  `/resume <command or session id>` runs the same trip in REVERSE: paste that line back and the
  thread adopts the existing local session, so a conversation started in a terminal on the gateway
  machine (or left behind by a cleared thread) continues in Slack. Accepts the full pasted command,
  the bare engine invocation, or a bare id, surviving Slack's `&amp;&amp;` escaping, smart quotes,
  and backticks. **Runtime-aware lookup:** a containerized thread's transcripts live in the
  channel's own HOME volume, so the id is looked for in the stores this channel can actually reach,
  cheapest first — the daemon's engine dirs (a legacy, pre-container session), the volume read
  straight off the host where it is traversable, and otherwise the channel's container itself,
  asked through the runtime's read-only `inspectState` (one `sh -c` that globs the layout and
  returns each match's mtime and opening records; nothing is copied out). Whichever store answers,
  the same rule decides. **Same-channel only:** the transcript's own recorded `cwd` — never the
  pasted `cd` — must be this channel's effective work dir, so a session from another channel's
  folder is refused with a pointer to the channel that owns it; an id already bound to another
  thread is refused too (one session, one thread). Unknown ids are refused rather than bound
  blindly — naming the harness the PASTED command named (a `claude --resume` line pasted into a
  Codex thread is not a missing "Codex session") and saying where the gateway looked — the
  thread is pinned to the harness that minted the id, the warm pool entry for the replaced session
  is evicted, and the adoption is audit-logged as `session_adopted`),
  `/pending` (alias `/followups`; the bare words `pending` / `my followups` work too, exact-match
  like `stop` — the caller's own live list of threads the AI is waiting on them for, formatted like
  the twice-daily digest; friendly "nothing pending" when empty),
  `/model` (the runtime wizard — one message that walks scope: *This channel* or *Just this thread*
  (buttons) → harness: *Claude*/*Codex* (buttons, plus *Use defaults* to clear the scope's
  overrides) → model (one button per model) → effort (one button per level) — every step is a flat
  list of buttons, no dropdowns, with the choice already in force marked ✓ and highlighted;
  each step persisting as it's clicked. Because a step persists on click, a mis-click is corrected
  in place rather than by re-running the command: steps 2–4 carry **← Back** to the step before
  them and the final card carries **Change again**, both repainting the SAME message (walking back
  writes nothing and undoes nothing — the re-pick overwrites what the wrong click stored, and the
  repainted step shows what is actually in force). Thread scope
  writes per-thread engine/model/effort overrides that beat the channel at run time; Settings →
  Access & security chooses whether channel changes are admin-only (default) or available to every
  authorized channel user, while anyone approved may customize their DM; typed `@bot /model` is the command — no manifest slash command is
  registered (a thread-aware Bolt handler answers if one is ever added);
  the old `/engine` and `/effort` are retired and answer with a pointer), `/compact` (Claude-only),
  `/mode` (see below),
  `/delete` (org-admin only: wipe THIS thread — replies first, parent last — hard-scoped to the
  triggering channel+thread; the bot token deletes the bot's own messages, and when an optional
  Admin User Token (xoxp) is set in Settings → Slack credentials, everyone else's are deleted via a
  per-call token override too — workspace prefs permitting; anything Slack refuses is tallied +
  reported in the ephemeral summary, which also says how to enable full deletion when no user token
  is set; refuses non-admin authors, mid-run threads, and top-level use; a deleted bot-owned root
  also drops the session like `/clear`), and `/update` (admin-only — git pull + install + restart, detached).
  → TEST-PLAN: In-thread commands.
- Stop an in-flight run three ways: a plain-text **stop word** (`stop`, `cancel`, `abort`, `halt`,
  `nevermind`, …) — bare in a DM, @mentioning the bot in a channel thread (the mention gate drops an
  un-mentioned channel message before the stop word is ever read); a **stop emoji reaction** (🛑 `octagonal_sign`, ❌ `x`,
  ✋ `raised_hand`, `no_entry`, …) on any message in the thread; or the **`/stop` slash command** —
  which Slack does **not** allow inside threads, so words/reactions are the in-thread path. All post
  "🛑 Stopped." with a resume command, and that command names the harness **the stopped thread was
  running on** — resolved per stopped thread (per-thread override → the engine that minted the
  thread's live session → the channel's engine → the gateway default), because a session id is
  engine-specific and a card built from the gateway default alone hands a Claude session a Codex
  resume line. → TEST-PLAN: In-thread commands.
- **A stopped run stops answering**, on either engine: "🛑 Stopped." is the last thing the thread
  receives. Answer text still queued behind Slack's rate limiter is dropped rather than flushed by
  the stop path (which used to create the answer message itself, lazily, and post the whole buffered
  reply beneath the stop card), and the stop flag is re-read immediately before every delivery call
  — the streamed finalize and the chunked fallback — so a stop landing during usage bookkeeping
  still wins. Text that had already reached Slack stays, closed with a
  `🛑 _Stopped — partial answer._` marker so a cut-off stream is never read as a finished answer.
  → TEST-PLAN: In-thread commands.
- Stopped-request replay: if a user stops a turn after the Slack thread already had a live session,
  the gateway stores only that stopped user request and prepends it once to the next turn in the same
  thread. This fills the missing request after a killed Codex turn while leaving first-message stops
  alone (the next turn can rely on Slack thread context). → TEST-PLAN: In-thread commands.
- Busy-thread steer-or-queue choice: a message sent while the thread is mid-turn pauses behind an
  owner-only, single-use card with **Steer Conversation**, **Add to Queue**, and **Cancel Request**.
  After a valid Steer or Queue selection, the temporary bot card is deleted so the thread retains
  only the user's original follow-up message. Cancel drops only the paused message and deliberately
  leaves the run in progress going. Steering interrupts warm Claude in-protocol and cleanly
  terminates a cold Claude or Codex child; queuing leaves the active run untouched and preserves
  FIFO order. Outstanding cards survive daemon restarts, while expired/replayed/foreign clicks
  cannot duplicate or hijack the message. Slack redeliveries are matched by exact run id and
  dropped silently rather than raising a second card; boot recovery skips a row a redelivered copy
  already picked up, so the same message is never answered twice.
  Prefix **`/next`** to queue directly without the choice.
  → TEST-PLAN: In-thread commands.
- Mention-by-reaction: react with a configured emoji (default 🤖 `robot_face`) on a message to treat
  it as an `@bot` mention. Scoped to the bot's own surface (a DM, a brand-new top-level message, a
  thread with an existing gateway session, or a sessionless thread this gateway bot has posted in —
  its own reminder/daemon root, or a reply such as a `/model` or `/help` answer, which never mint a
  session) so those threads can be engaged immediately without hijacking another agent's thread. On
  first engagement, the bounded Slack replay includes the bot-authored root reminder and preceding
  replies before the reacted request. The reactor becomes the author (their authz + tokens apply).
  → TEST-PLAN: Slack gateway.
- Answer-on-join: when a tag pulls the bot into a channel (Slack's "mention a bot that isn't here →
  invite it" flow), the message that triggered the invite predates membership and never arrives as an
  event. On join the bot scans the channel's recent history (15-min window) for that pending `@bot`
  mention and replies to it in-thread — one reply, the most recent mention, skipped if it already owns
  that thread so a leave/re-join can't resurface an old tag. → TEST-PLAN: Slack gateway.
- Background jobs with auto-continue: the `run_in_background` gateway MCP tool hands a long shell
  command to the daemon (which outlives the one-shot `claude -p` subprocess); on completion the
  daemon re-injects a turn into the same thread (same session resumes with full context) and posts
  the continuation — no lost work, no "I'll continue automatically" dead-ends. → TEST-PLAN: Automation.
- Background jobs survive a daemon restart: each job is persisted in SQLite's `bg_jobs` table; on boot
  a still-running job is watched to completion, and one that exited while the daemon was down gets a
  forced "interrupted by restart" continuation — a thread never silently stalls.
- **Container-only runtime settings.** Settings expose the CLI, image, idle/container limits,
  resource caps and optional Full-access home mount. There is no host runtime switch or Claude
  subscription-token field. Boundary validation rejects invalid CLI argument values before save.
  → TEST-PLAN: Container runtime and Release readiness remediation.
- Interactive turns survive a daemon restart (auto re-run): cold Claude/Codex engine subprocesses and
  warm Claude sessions run in process groups so their MCP children can be killed as a unit; controlled
  daemon restart/stop terminates those groups, preserves the `active_runs` row, and lets the next boot
  replay the interrupted Slack turn. Each running turn is recorded in the `active_runs` table (written
  at start, deleted on normal completion/error/stop); any row still present at boot was interrupted.
  On startup the daemon snapshots those rows before Slack reconnects, then auto re-runs each: posts a
  "🔁 interrupted by a restart — picking it back up" note, resumes the same thread/session when possible,
  and re-runs the exact original prompt as the original author. The recovered turn immediately reuses
  the normal native progress controller, so its temporary shimmer, persistent toolbox, heartbeats,
  tool events, and answer deltas stay visible instead of going silent until final delivery.
  → TEST-PLAN: Automation (restart recovery of interrupted turns).
- Restart recovery joins the same per-thread FIFO as live Slack work and advertises the progress-report
  capability consistently; a changed warm-session fingerprint drains the current promise chain
  before replacing its process, so recovery and a newly arrived turn cannot terminate one another.
- Safe manual restart keeps Slack online while it checks engine turns, background jobs/agents, API
  runs, and update transactions, then rechecks every 30 seconds for up to five minutes. It starts
  shutdown only after work is idle and cancels with an in-thread explanation if work remains.
  Shutdown then performs its existing bounded drain and sweeps every tracked cold and warm process
  group (with a final hard-kill fallback). Completed rows are cleared before exit while genuinely
  interrupted rows remain recoverable on boot. → TEST-PLAN: Automation.
- One-time ("run at") schedules: `create_schedule` accepts `in_minutes`/`run_at` to fire once and
  auto-delete (e.g. "remind this channel in 2h") alongside recurring cron; recurring crons are held
  to a minimum interval (default 60 min) with per-channel + concurrency caps.
- Scheduler startup immediately checks the durable cursor, including cron minutes missed during
  restart recovery. Catch-up is bounded to the five most recent minutes and never predates a
  schedule's creation, re-enable, or cron edit. Durable epoch-minute claims prevent replay after
  restart, including repeated local clock labels at a daylight-saving fold. A queued task can
  start safely after restart; an interrupted engine execution is paused for reconciliation, and a
  saved result retries delivery without rerunning tools. Reminder claims precede posting: a crash
  at that external delivery boundary can lose a reminder but cannot automatically duplicate it.
  Short transport outages defer unclaimed recurring work within the same five-minute window.
  → TEST-PLAN: Scheduling restart durability.
- Schedule times are the GATEWAY's local zone, and they say so. Crons are matched against the
  daemon's own clock, so every container receives the daemon's IANA zone as `TZ` (at create and on
  every exec) instead of the image's `Etc/UTC` — `date` and both engines read the same wall time as
  the scheduler. The tool replies name the zone rather than relying on that: a one-time schedule is
  confirmed as "2026-09-08 09:15 Europe/Bucharest (06:15 UTC)", a recurring one adds its resolved
  next fire time, `list_schedules` repeats the zone, and the bundled reminder guidance tells the
  agent to quote it back instead of converting. → TEST-PLAN: Scheduling & reminders.
- Recurring task schedules can opt into `delivery:"daily-thread"`: the first run of each
  server-local day creates one top-level “Running” anchor and every result that day lands beneath
  it. The durable anchor survives daemon restarts, the next day starts a new thread, and agent
  sessions remain fresh per run — the session key is minted per fire and never derived from the
  reused anchor, so grouping the day's results never joins them into one conversation. Existing
  schedules retain standard per-run announcements. → TEST-PLAN: Scheduling & reminders.
- Native `/loop` in a thread: Claude Code's own loop skill paces itself with `ScheduleWakeup` /
  `CronCreate`, both of which are session-local (the harness documents its cron store as "gone when
  Claude exits") and therefore inert in a headless turn. The daemon reads the pacing call out of the
  engine stream and adopts it: the loop is re-armed as a thread-bound row in the schedule store, and
  the tick RESUMES that thread's session and replies in-thread, so iterations accumulate context the
  way they do in a terminal instead of restarting blind. Being the only schedule that runs on a real
  thread key, a tick joins the same per-thread FIFO as live Slack work (the guard restart recovery
  already needed), so a tick and a human message can never resume one session at once. Self-paced (`ScheduleWakeup` → one-time row
  the next tick re-arms) and fixed-interval (`CronCreate` → recurring row) are both supported; the
  cadence floor is 1 min rather than the unattended-cron minimum, because a loop is bounded by a
  tick budget (24) instead. Every arm, refusal, and budget stop is announced in the thread, `stop`
  in the thread cancels the pending tick as well as the running turn, and a re-arm replaces the
  pending tick rather than stacking a second one. → TEST-PLAN: Automation.
- Reminder schedules (`kind:"reminder"`): post a SINGLE message (no Claude run, no token cost) rather
  than running a session. With `ack:true` the reminder requires a ✅ — if nobody reacts within
  `ack_escalate_minutes` (default 120) the bot posts a 2nd notice, then after `ack_dm_minutes`
  (default 60) more it DMs the schedule's creator and closes the chain; a ✅ at any time resolves it.
  Pending acks persist in `config/acks.json` so the chain survives a daemon restart. The renderer
  owns the "⏰ *Reminder:*" label: one leading "Reminder:" the author already wrote is stripped from
  the posted message, the 2nd notice and the DM, so the line never stutters.
- Opt-in no-response nudge: a channel can have the bot post one gentle reminder in a thread that has
  gone quiet past a window (default 24h). Strictly single-thread; never scans other channels. An
  org-level default (Settings → Schedules & nudges, `defaultNudges`) decides whether NEW channels &
  DMs start with it on; a "Apply to all existing channels & DMs" button pushes the current default
  onto every existing conversation at once.
- "AI is waiting on you" digests: the bot passively observes the channels it's in (every message,
  mention or not) and tracks, per thread, who took part and who spoke last. It reminds about **one
  thing only** — threads where the **AI is waiting for your decision**: a genuine AI thread (the bot
  was @mentioned or posted) in which the **bot spoke last**, so the ball is now in a human
  participant's court. It deliberately does NOT nudge you about human-to-human replies you owe; if you
  replied last, the AI isn't waiting on you. Twice a day (08:00 & 14:00 Europe/Bucharest by default)
  it DMs each approved user those threads, each line a permalink. Missed slots **catch up**: each
  slot records a durable per-day "fired" marker in SQLite (`_meta`), and on every minute tick any
  slot whose time has passed today but hasn't fired yet fires late (a Mac asleep at 08:00 that wakes
  at 09:30 gets the 08:00 digest at 09:30; several missed slots collapse into ONE catch-up DM). The
  durable marker also means a daemon restart never double-sends a slot that already fired, and a
  slot due while Slack is disconnected retries until it can send. Replying in a thread clears it
  automatically (the bot is no longer the last author); React ✅ on a source thread to dismiss that
  thread manually, or react on the scheduled DM digest to dismiss **every source thread visibly
  listed in that exact digest**. Digest snapshots persist in SQLite across restarts and expire after
  14 days; overflow entries hidden behind “…and N more” stay pending. Removing the digest reaction
  reopens only dismissals still owned by it, so a newer direct source-thread dismissal survives.
  Any fresh source activity re-opens that thread. Silent when you have nothing pending. Scope-limited
  to channels the bot is a member of and already manages; it never sees private DMs/threads it isn't
  part of. Settings: enable, hours, timezone, done-emoji. The same report is available ON DEMAND: type `pending` or
  `my followups` (or `/pending`, alias `/followups`) in any thread or DM and the bot replies with
  the caller's own live list — same digest formatting + permalinks (a shared formatter, not a
  copy), with a friendly "nothing pending" note when the list is empty. The bare words are
  exact-match only (like `stop`), so "pending review my PR" is still a normal prompt.
  → TEST-PLAN: Scheduling & reminders; In-thread commands.
- Slack **Lists** (the native table/tracker): the gateway control MCP exposes `slack_list_create`,
  `slack_list_add_item`, `slack_list_update_item`, `slack_list_items`, and `slack_list_info` — the bot
  can spin up a tasklist (default **Name** + **Status** New/In progress/Done, or `todo_mode`/custom
  columns) and read/add/update rows. Composio has no Lists coverage, so these call the Slack Web API
  (`slackLists.*`) directly with the workspace bot token (needs `lists:read`/`lists:write`); text cells
  are wrapped as rich text and select values accept the option label. `list_id` accepts a raw F-id or a
  pasted List URL. A newly created standalone List is immediately granted write access to the current
  conversation, so members can see and edit it; sharing failure is reported instead of returning an
  invisible tracker. Available to any allowed user (no admin gate). → TEST-PLAN: Slack Lists.
- Native Slack **data tables**: `slack_post_table` (gateway control MCP) posts a Block Kit
  `data_table` into the current channel + thread using the workspace bot token and existing
  `chat:write` scope. Standalone read-only datasets render with a native header row, pagination,
  sorting, and filtering. Supports 1–20 columns and 1–100 data
  rows with exact rectangular-shape validation, numeric cells kept as `raw_number` for numeric
  sorting, an accessible row-header column, and Slack's 10,000-character aggregate cell limit.
  Empty text cells display as an em dash. The top-level message always has supplied or generated
  notification/accessibility fallback text. Channel/thread ids come only from trusted gateway
  context; the tool cannot redirect a table. The injected `gateway-usage` skill distinguishes a
  small explanatory GFM table embedded in the streamed answer from a sortable/filterable native
  dataset, retaining CSV/TSV snippets for big/wide exports and Slack Lists for editable trackers.
  Incoming pasted `table` and `data_table` blocks are also normalized from both message blocks and
  attachment blocks into exact JSON rows for the active turn, current-channel history/thread tools,
  and fresh-session thread replay. Numeric values stay numeric; rich-text cells retain readable
  links, mentions, emoji, lists, and line boundaries. A table-only message counts as content (while
  the normal channel mention gate still applies). No extra Slack scope is needed. Any allowed user.
  → TEST-PLAN: Native Slack data tables.
- Slack **file snippets** for big/wide tables: `slack_upload_snippet` (gateway control MCP) uploads
  `content` (CSV/TSV/markdown/code) as a FILE into the current channel + thread, so a CSV/TSV renders
  as a **scrollable spreadsheet grid** — the right shape for a large read-only table/export vs. a
  cramped message code block or a 100-row Slack List. Daemon-side via the workspace bot token
  (`files:write`) using Slack's external-upload flow (`files.getUploadURLExternal` → POST bytes →
  `files.completeUploadExternal`), so it needs no Bash/network in the channel; hard-scoped to the
  current channel. The filename extension drives rendering (`.csv`/`.tsv` = grid; text/code = plain
  snippet). Any allowed user. → TEST-PLAN: Slack file snippets.
- Native Slack **charts**: `slack_post_chart` (gateway control MCP) posts Block Kit
  `data_visualization` blocks into the current channel + thread using the workspace bot token and
  existing `chat:write` scope. Supports line/bar/area charts (1–12 series, 1–20 shared category
  points each; negative values allowed) and pie charts (1–12 positive segments), with Slack-length,
  uniqueness, and same-category validation before the API call. The top-level message always carries
  supplied or auto-generated plain-text fallback content for notifications/accessibility. No public
  image URL, renderer, extra dependency, Composio connection, or channel-side network is needed;
  channel/thread ids come only from trusted gateway context. The injected `gateway-usage` skill
  routes chart requests to the tool and tells the AI not to truncate silently or duplicate the chart
  in its prose. Any allowed user. → TEST-PLAN: Native Slack charts.
- Slack **reads & search**:
  - **This channel (bot token, no login):** `slack_channel_history` / `slack_thread_replies` read the
    current channel / a thread via the bot token, **hard-scoped to the current channel id** — safe
    because the requester is already a member here (and so is the bot), so it exposes nothing they
    couldn't scroll to. Can't wander to other channels. → TEST-PLAN: Slack reads.
  - **Cross-channel / workspace search:** done via the **Slack toolkit inside Composio**
    using the explicitly selected identity: `mcp__composio-user__*` for the active author's account
    or `mcp__composio-agent__*` for the agent's own account. Slack enforces the selected account's
    visibility. There is **no** separate hosted Slack MCP and no per-user `connect_slack` OAuth.

## Engines (Claude + Codex)
- Two CLI engines: **Claude** (default — warm sessions, exact cost, skills, `/compact`) and **Codex**
  (OpenAI Codex CLI — one-shot per message, MCP via `-c` overrides + an HTTP bridge). Selection
  precedence is **per-thread directive → per-channel → global default** — but an EXISTING thread
  sticks to the engine that minted its session: changing the channel/global harness only affects
  new threads; live conversations keep resuming on their own engine (only the automatic usage-limit
  failover runs a different engine, under a suffixed session key). The exception is a harness turned
  OFF in Settings: those threads move to an enabled engine. A row minted for a brand-new thread
  whose turn then dies BEFORE its engine starts (a pre-spawn credential gate, a runtime that cannot
  come up) is dropped with that turn, so the next message is a first turn again on the channel's
  current harness instead of "continuing on" one that never produced a session. → TEST-PLAN: Engines.
- Per-thread engine directive: a message starting with `claude` or `codex` (e.g. "@bot codex build
  the feature") switches that thread's engine; it sticks until changed (persisted per channel).
  The `/model` wizard's "just this thread" scope sets the same override (plus per-thread model +
  effort). An explicit switch — directive, per-thread wizard scope, or per-run API override — is
  the ONLY thing that moves an existing thread to the other engine: it drops thread model/effort
  overrides that don't belong to the new engine, starts a fresh session (the new engine can't
  resume the old one's conversation), and replays the Slack thread context into it so the new
  engine continues the conversation instead of starting blind.
- Gateway-wide **default model** per engine (Settings → Engine & runtime, validated like `/model`):
  when a thread/channel/DM-template sets no model, the run gets the gateway default as an explicit
  `--model`/`-m` — so the admin's interactive terminal `/model` choice (written to
  `~/.claude/settings.json`) never leaks into gateway runs. Blank = the CLI's own default.
  Precedence: thread/channel/per-request override → gateway default (per engine) → CLI default;
  Codex-fallback turns use the Codex default. All admin-UI model fields (the two Settings defaults,
  the channel Runtime card, channel/DM config editors) are **dropdowns** with the same curated
  options as the `/model` wizard, switching with the selected/inherited engine; a hand-edited
  non-curated id (e.g. a dated full id in settings.json) survives as an extra option so Save
  round-trips it, while an other-engine leftover is dropped. The Claude list includes Fable 5 as
  `claude-fable-5`; Fable is not offered as a GPT/Codex model. Settings also provides a confirmed,
  admin-only reset that clears every channel's engine/model overrides so new threads inherit these
  gateway defaults again; DMs, existing thread-owned sessions, effort, access, tools, and tokens
  are untouched. → TEST-PLAN: Engines.
 - A thread/channel/per-run Codex model that the provider explicitly rejects before generation
   retries once with that harness's distinct gateway-default model — Codex (`invalid_request_error`) and Claude (`model_not_found`) alike. The runner must prove there was no output
   or tool attempt; generic failures and partially executed turns are never replayed. Slack status,
   the reply note/footer, and the audit event identify the default that actually ran. If the default
   also fails, the original model error remains authoritative. → TEST-PLAN: Engines.
 - **The substitution is always visible in the thread.** The note is announced to the delivery
   layer (`answer_note`) before the retry spawns, so it leads the STREAMED answer a reader actually
   sees — a note only prepended to the finished reply text reaches surfaces that render that text,
   never a natively streamed Slack message. Both retry paths announce it (the channel's own harness
   and the cross-engine fallback's own model), it is delivered exactly once whichever way the
   answer arrives, and a note that could no longer lead the answer becomes a durable task-card row
   instead of being dropped. → TEST-PLAN: Engines.
 - **A refused model reads as a setting to fix, never as raw JSON.** Codex reports some provider
   refusals by handing back the whole HTTP response body as its error message; the runner unwraps
   that document (status, provider error type, sentence) before classifying, so a model the account
   cannot use is a `model_rejected` rejection with the same fallback + note instead of an
   unclassifiable failure. Whatever still ends as an error is posted as a sentence — the provider's
   own words, never a JSON document — and a model rejection names the model and the remedy
   (`/model`, or the admin UI). → TEST-PLAN: Engines.
- **Transient provider failures are retried in place (2026-09-03).** When the provider does not
  answer a request — a 5xx or 529 "overloaded", a connection reset or timeout, or an unexplained
  404 from the Codex backend (the 2026-09-03 ChatGPT Codex outage answered every request that way
  for a few minutes) — the gateway re-runs the SAME turn on the SAME engine up to two more times,
  ten seconds apart, before giving up (`CG_TRANSIENT_RETRY_ATTEMPTS`, `CG_TRANSIENT_RETRY_DELAY_MS`).
  Two rules keep it safe: the failure must be replay-safe (the runner proved no tool ran — the
  engines retry mid-turn themselves, and a gateway replay after a tool call could repeat a side
  effect), and authentication / usage-limit / model-rejection failures are excluded because they
  have their own paths (failover below, the same-engine model retry). Each attempt is a
  `run_transient_retry` event, a daemon log line and a status-line notice ("retrying in 10s (1/2)");
  a reply that needed more than one attempt says so in one italic line, and an exhausted error names
  how often it was retried. The pause ends early on cancel. "Replay-safe" means nothing of the turn
  reached anyone: no tool ran AND no text streamed (both engines). A retried FRESH Claude session
  runs under a new session id (the CLI refuses to create the same id twice), and the warm Claude
  process — which stays alive after a provider failure — rejects that turn with the classified
  failure like print mode does, so the retry covers the default Slack path. Which failure kinds an
  engine may replay is its adapter fact (`transientKinds`, `src/engines/adapters.js`): Codex's
  `transient` (`classifyCodexFailure` — status codes, the CLI's underscore error codes, or outage
  wording in the error EVENT; never its stderr, which can quote a retry it recovered from), Claude's
  `availability` / `connection` (an overload, a 5xx, a `server_error` label, a dropped connection —
  never the catch-all `provider` kind or the bare "API Error:" prefix a rejected request also
  carries). The knobs are read per turn, so `.env` / settings values count without a restart.
  → TEST-PLAN: Engines.
- **Bidirectional harness failover** when the engine driving a turn hits its usage/session/plan
  limit or its authentication is unavailable — Claude→Codex and Codex→Claude are the same mechanism,
  so a channel whose primary engine is Codex is not stranded until its ChatGPT quota resets (and
  vice-versa). Terminal zero-token limit results and typed nonzero provider failures are both
  handled, on both engines: Codex classifies its plan-credit rejection ("purchase more credits…"),
  whether it arrives as a JSON error event or on stderr with a nonzero exit. A thrown failure is
  replayed only when the runner observed **no tool call and no streamed output**, preventing a
  partially-completed side-effecting task from running twice. Authentication uses a per-engine,
  gateway-wide ~15-minute cooldown; usage limits use a per-engine, per-channel cooldown. The reply
  names which harness answered and why, and if the fallback also fails the original actionable error
  is kept. When failover can't cover a limit (disabled, or the other harness is off), the error line
  tells the user they can say `claude`/`codex` in the thread to switch by hand. Toggle in Settings
  (default on). → TEST-PLAN: Engines.
- **Failover after the in-place retries, and a choice of who decides (2026-09-04).** A provider that
  stayed unavailable through the transient retries is a failover case too: with failover on, the
  turn is answered by the other harness ("⚠️ _Codex hit a temporary provider error — retried 2×
  before giving up — using Claude._") and the channel's next turns go straight there for five
  minutes before the primary is tried again. Settings → *How a failover happens*: `auto` (default)
  switches silently — `ask` posts a card in the thread instead ("⚠️ Codex hit a temporary provider
  error — retried 2× before giving up. Nothing ran for your message. Switch this thread to Claude,
  or try Codex again?") with buttons *Switch to Claude* / *Try Codex again*, and nothing runs until
  the message's author clicks. A click re-runs the ORIGINAL Slack message (same text, attachments,
  thread) on the chosen harness; *Switch* also pins the thread to it, exactly like the `claude` /
  `codex` directive (the thread transcript is replayed into the fresh session). The card is the same
  durable, expiring, single-shot record as the busy-thread card (`src/slack/engine-switch-choice.js`;
  🛑 / `stop` discards it, a restart keeps it). Usage-limit and authentication failures follow the
  same mode (a limit that arrives as the answer included). Only a watched Slack thread can be asked —
  schedules, background agents, continuations and API runs always switch automatically. When BOTH
  harnesses fail, the error says so in one sentence ("… — Claude could not answer either: …") and a
  Slack thread gets the same card with *Try Codex again* / *Try Claude again*, in either mode. The
  retry pause itself now hands the global run slot and the container lease back for its length, so
  a sleeping turn never queues another channel's turn behind it. → TEST-PLAN: Engines.
- **A runtime the user PINNED is never traded away.** Failover exists so a DEFAULT never strands a
  thread; a thread someone pinned by hand — the `/model` wizard's "just this thread" scope, a
  `claude`/`codex` directive, or a per-run API engine/model override — is the opposite case, so it
  gets the harness's own error instead of a quiet answer from the other one (different model,
  different tools, none of the pinned session's context). The reply says so: a thrown failure adds
  "this thread is pinned to X · `model`, so it was not switched automatically — say `codex` to move
  it, or /model to repin it", and a limit that arrives as the ANSWER keeps that notice with the same
  one-line explanation above it. Channel and gateway defaults are NOT pins — failover is exactly
  what they are for — and neither is a stale thread model belonging to the other harness (it never
  reaches the CLI, so it must not silently disable failover either). → TEST-PLAN: Engines.
- **Claude runs on the operator's OWN subscription — one login, resolved in one place.** The gateway
  authenticates Claude with the `claude` sign-in of the user the daemon runs as
  (`$CLAUDE_CONFIG_DIR`, else `~/.claude`): the login that person keeps alive in their own shell. It
  is read where it lives and never copied, linked or mounted — the previous design symlinked
  `.credentials.json` into the gateway's synthetic engine home, Claude Code replaced the link with a
  plain file on its first rename-on-refresh, and the resulting independent session quietly aged out
  while the operator's own login stayed perfectly valid (every Claude turn on one gateway had been
  failing over to Codex for hours before anyone noticed). `src/gateway/claude-login.js` is now the
  single resolver — a configured `claude setup-token`, else the operator's login, else a login signed
  in to the gateway's engine home, else the daemon's `ANTHROPIC_API_KEY`, else a named remedy — and
  every consumer reads it: the token relay, the container credential modes, the engine health probe,
  the boot log and `/status`. What a run receives is a RELAY of that login's current ACCESS token in
  `CLAUDE_CODE_OAUTH_TOKEN`, on the host exactly as in a container, refreshed under 30 minutes of
  remaining life by a cheap haiku turn in that login's own config dir (the only sanctioned way, and
  byte-for-byte what the operator's own shell does). An access token carries no refresh half, so the
  operator's chain stays the only chain; the warm pool keys on the login's source file and the
  token's expiry — never the token text — so a refresh retires a warm process holding the old one.
  Fail-closed stays CONTAINER-only: a container has no other way in, while a host turn with no login
  still runs and lets the engine raise its own error, with the remedy logged once an hour. The login
  SESSION itself dies every few weeks and only a new interactive `claude` login moves that date, so
  the source and the date are printed at boot, warned about three days ahead, and carried on
  `/status` and `/api/health`. → TEST-PLAN: Engines.
- **The login expiry reaches a human before turns start failing.** Boot logs and `/status` only warn
  when somebody restarts or asks; a daemon that has been up for a month never said a word, and the
  first symptom was Claude turns quietly failing over to Codex. An hourly watch
  (`src/gateway/login-watch.js`) now re-resolves the login while the daemon runs and DMs every admin
  once per UTC day — from three days before the session expires, and daily while there is no usable
  login at all (then the message is the resolver's own remedy list). The DM names which login
  (kind + config dir), when it dies in UTC *and* in the gateway's local timezone, and the fix (sign
  in with `claude` on the gateway host; the gateway picks it up on its next turn, no restart). The
  log line is written on every tick; only the DM is rationed, and the "already told them today"
  marker lives in the database, so a daemon restarted hourly cannot spam. A class change (expiring →
  missing) is news the same day, and a login that goes healthy again clears the class so the next
  expiry notifies afresh. One unreachable admin never costs the others their alert, and a tick that
  reached nobody stays due. No token material ever rides the DM. → TEST-PLAN: Engines.
- **Codex sign-in is detected before, during, and after a turn** — a lost credential can no longer
  present as a hang. Before spawn, the runner reads the same `auth.json` the CLI reads (the stable
  engine `CODEX_HOME` first, the host state dir it is linked from second) and turns a signed-out
  host into a replay-safe `authentication` failure without burning a turn; the probe fails OPEN, so
  an unreadable or unfamiliar credential file never blocks a run. During a turn, Codex's own
  sign-in phrasing on stderr ends the run within seconds — but only while no tool has run and
  nothing has streamed, and only on wording no MCP child would produce (a bare `401` is not enough
  to blame the harness's credential). Engine stderr is liveness, not progress, on every runner: a
  process retrying an expired credential forever still exhausts its silence budget, and a wedged
  turn's buffered stderr is classified on the way out — naming the cause and, when nothing ran,
  letting it fail over instead of dead-ending in "produced no output". Codex's diagnostics (retry,
  backoff, sign-in) are redacted, capped, and shown on the Slack heartbeat row in place of
  "starting". Boot logs warn about an installed-but-signed-out CLI, `/api/health` reports every
  harness (available · signed in · enabled), and the admin rail shows one chip per enabled harness
  ("Codex · signed out"). → TEST-PLAN: Engines.
- **Per-harness on/off switch** (Settings → Engine & runtime): turn off an engine you don't have set
  up. A disabled harness disappears from every picker (admin UI global + per channel, and the Slack
  `/model` wizard), is never used as a failover target, and any channel/thread still pointing at it
  runs on an enabled harness instead — an existing thread gets a fresh session there with its
  transcript replayed, rather than a failed cross-engine resume. At least one harness must stay
  enabled: the Admin API refuses a save that would disable all of them or leave the gateway default
  pointing at a disabled engine, and the reader fails open if the stored state is ever inconsistent.
  → TEST-PLAN: Engines.
- **Retired 2026-09-03 (Linux + containers only):** the host permission profiles, the semantic network modes and the `network_proxy` compilation —
  inside its container Codex runs `--sandbox read-only` in read mode (which refuses network on its
  own) and `danger-full-access` for write modes, with no permission profiles; the container itself
  is on the bridge network. Codex confinement mirrors the channel via Gateway-owned permission profiles (never the legacy
  broad-read sandbox modes): `gateway-readonly` (root denied, minimal runtime paths + workspace
  readable, nothing writable) by default, `gateway-workspace` (adds workspace write + a private
  per-run scratch dir as TMPDIR; `.git`/`.codex` stay read-only) when Bash/Auto mode is on, profile
  network off by default, and full bypass only for an admin author in admin mode. The gateway's
  semantic network modes are **off / approved domains / unrestricted**. Claude and Codex compile
  the same normalized administrator allowlist into their OS sandboxes; Codex uses its permission-
  profile `network_proxy`, keeps local/private destinations and listener escape hatches disabled,
  and fails closed before spawn when the installed CLI lacks that feature. Full bypass remains
  foreground-admin-only and is reported honestly as unrestricted network in Slack and the admin UI.
  Non-Full runs pass `--ignore-user-config` so a host user's personal Codex config can't broaden a
  Slack run. Known platform carve-out: Codex's `:minimal` grant keeps shared `/tmp` readable and
  writable on macOS regardless of denies, so nothing sensitive (including the run scratch dir, which
  lives under the sandbox-denied gateway root) is ever placed there. → TEST-PLAN: Engines.
- **Retired 2026-09-03 (Linux + containers only):** the mechanism only — the runtime root is not mounted into the container at all and the control
  plane is reached over the read-only unix socket; the fact stands. Codex runs get NO filesystem access to the daemon runtime root (`~/.channelgate`): the local
  gateway MCP server is a separate stdio subprocess outside the command sandbox, so schedules and
  channel state remain reachable through its authorized tools only.
- **CLI catalog (`src/config/cli-catalog.js` — Vercel, Supabase, Make.com)**: the deploy CLIs the
  channel runtime image ships, with the environment variable each one accepts instead of a saved
  login. It feeds the `/secrets` name suggestions (every catalog name, so a channel acting as its
  own account types `SUPABASE_ACCESS_TOKEN`, not a guess) and the host-sandbox write-deny list for
  saved-login files. **Retired 2026-09-03 (Linux + containers only):** the Settings → Network →
  "CLI integrations" switch, its `cliIntegrations` setting, the live "installed" badges
  (`cli-detect.js` detection) and the read-only linking of the daemon's shared host login
  (`~/.supabase`, `~/.vercel`) into runs. A container has no domain allow-list and its image
  ships the CLIs, so the switch had no effect there; a channel's own provider login is a `/secrets`
  variable and never the daemon's host-wide file. A stored `cliIntegrations` value is inert. The
  git/gh baseline read re-allow for host runs went with the host runtime the same day — a container
  reads the `git`/`gh` state in its own HOME volume, never the daemon's — and the catalog is now
  only the `/secrets` name list. → TEST-PLAN: CLI integrations.
- **Retired 2026-09-03 (Linux + containers only):** the image ships the toolchain (`containers/versions.json`) and a channel installs anything else
  into its own HOME volume, so there is no host toolchain to grant. **Toolchain reachability inside the sandbox** (`src/gateway/toolchain-paths.js`): the lockdown
  denies reading all of HOME and re-allows only the work dir — and Claude Code implements that by
  tmpfs-masking HOME, so a per-user install of the agent's OWN runtime does not become unreadable,
  it stops EXISTING. On macOS this was invisible (Homebrew lives outside HOME); on Linux, where
  node/npm/npx/vercel/gh routinely sit in `~/.local/bin`, every Bash channel reported "this sandbox
  has no node/vercel" while `/usr/bin` tools kept working — and Settings still badged "Vercel:
  installed", because detection scans the DAEMON's filesystem, not the sandbox's. Write-capable and
  admin Claude runs and every confined Codex permission profile now re-allow READING the resolved
  toolchain: the Node install prefix (npm, npx and
  every globally-installed CLI are JS under `prefix/lib/node_modules` behind a `bin` shim) plus each
  baseline binary, each granted as both
  the PATH entry and its resolved PACKAGE ROOT — a globally-installed CLI's `bin` entry is a shim
  that reaches the rest of its package by relative import, so granting the shim alone resolves the
  binary and then dies on its first require. This matters only where npm's global root sits outside
  the Node prefix (`~/.local/lib/node_modules` rather than `<prefix>/lib/node_modules`); where it
  sits inside, the prefix grant already covered it — which is why the first cut looked correct on
  one machine and failed on another with the same code. The emitted list is minimized, so a
  directory grant absorbs everything under it and stays the minimal reviewable set. Surgical
  by design: never `~/.local` wholesale (`.local/share` holds app data), never anything inside the
  gateway root, and paths outside HOME are dropped as already-readable. Not gated on network —
  `node build.js` is useful with egress off, and the grant carries no credential. READ-only: `bin`
  and `.local` stay on SENSITIVE_HOME's write-deny list, so the delayed-escape protection
  (plant-a-binary-now, run-it-unsandboxed-later) is untouched. Codex also sets
  a run-private PATH directory containing only reviewed HOME-local CLI names as direct symlinks to
  their real package launchers. This preserves npm/npx relative-module resolution when Codex's
  permission profile would otherwise flatten a two-hop symlink into a broken copied file, without
  exposing the rest of `~/.local/bin`. Claude runs get the same remedy as a STABLE
  content-addressed launcher directory (`<gateway>/runtime/toolchain-bin/<digest>`, built by
  `run-grant-artifacts.js`): the Claude sandbox materializes per-file read grants as binds, and a
  SYMLINK entry cannot be bound — a host whose `~/.local/bin` shims are symlinks (node →
  `../node/bin/node`) loses every shim inside the sandbox while plain binaries survive, so `node`
  stopped existing in exactly the runs that were granted it (found live by the CLI-12 gateway
  parity case: one deployment's layout escaped by luck, another's fully-symlinked layout lost all five). The
  directory is granted as a DIRECTORY (symlink semantics survive a whole-dir bind), prepended to
  the child PATH by `buildClaudeEnv`, and content-addressed so settings digests and warm
  fingerprints stay stable until the host toolchain actually changes — which then retires warm
  processes, as a toolchain change should. Airtable acceptance: DRV-01, DRV-02, CLI-12.
  Codex also sets
  `NODE_USE_ENV_PROXY=1` so Node-based CLIs honor its destination-restricted network proxy; this
  changes proxy consumption, not the approved-domain boundary. → TEST-PLAN: CLI integrations.
- **Retired 2026-09-03 (Linux + containers only):** the tool, the card and `extraNetworkDomains` went with the host sandbox's allow-list — *Allow
  network* stays as a per-channel switch the engines are told about, with no domain filtering and,
  in this release, no egress cut-off in the container (every container is on the bridge network;
  a container-side egress proxy is the planned follow-up). **Per-channel domain approvals (`request_network_domain`)**: when a sandboxed command fails on a
  blocked host, the agent may request ONE named domain; the gateway posts an Approve/Deny card
  that ANY authorized user can approve (the human click is the control — injected content can
  request but never click). Approved domains persist in the channel meta, join that channel's
  engine sandbox lists on the next spawn, and are visible/prunable in the admin UI channel card.
  Input accepts bare domains, `*.wildcards`, or URLs (hostname extracted); IPs, localhost, and
  single-label hosts are refused; malformed stored values degrade to no extras rather than
  breaking spawns. Invalid or already-allowed requests skip the card entirely (no approval spam).
  → TEST-PLAN: CLI integrations.
- Engine-aware optional MCP picker: channel, DM, and access-template editors load the catalog for
  their effective Claude/Codex engine and retain each engine's selections independently. Claude
  keeps its configured-server catalog; Codex queries the active app-server inventory and exposes
  each runtime app family (Boost.space, GitHub, Sites, Skill Library, etc.) plus each configured
  server as its own checkbox. Codex launches default-deny optional apps, explicitly enable only
  the live connector IDs represented by selected families, and gates every discovered optional
  server; existing family selections therefore survive connector-ID changes without a re-save.
  The same policy applies to fresh/resumed and cross-engine failover runs, while clean mode enables
  none. Gateway MCP list/add/remove controls receive the active run engine and operate on that
  engine's independent selection set.
- Per-channel **Make MCP toolbox**: an admin can save one official Make/Celonis toolbox server URL
  and Bearer key from Conversations → Tools, test it with a read-only MCP `tools/list`, replace it,
  or clear it atomically. Normal Claude and Codex turns expose it as `make-toolbox`; clean mode
  removes it. Claude carries the key only in the mode-0600 temporary MCP config, while Codex uses a
  daemon-root 0600 secret bundle read by the local remote-MCP broker. The same broker protects
  signed gateway capability plus legacy Composio and Toolbox credentials: Codex argv carries only the bundle
  path + logical key, and the Codex process environment receives no connector secret. The global
  child-env boundary admits exact reviewed engine variables only, never broad vendor prefixes.
  → TEST-PLAN: MCP injection & tokens.
- Claude channel settings explicitly pre-approve every embedded `mcp__gateway__*` tool, so
  schedules, reminders, background jobs, Slack Lists, current-channel Slack reads, and channel admin
  controls do not need an interactive approval prompt. Clean mode still removes the gateway MCP
  entirely.
- **Schedules and reminders never ask for approval**: `create_schedule` and `delete_schedule` are
  deliberately outside the control-plane approval gate, so "remind me at 9" or "check the progress
  every hour" just works instead of stalling on an Approve card that refuses itself after four
  minutes. A schedule can't escalate — it fires with origin `schedule` (never the sandbox-off admin
  path), in the channel it was created in, as its creator, no more often than the configured minimum
  interval — announces itself in-channel when it runs, and stays inspectable and reversible through
  `list_schedules`/`delete_schedule`. Every other control-plane tool (modes, network, work dir, MCP
  allowlist, standing instructions, connector tokens, gateway guide, updater) still requires the
  human click and still fails closed. → TEST-PLAN: Reminders & schedules, Security checks.
- Both injected Composio MCP identities are pre-approved by default: Claude settings include
  `mcp__composio-user` and `mcp__composio-agent`; each emitted server sets
  `default_tools_approval_mode:"approve"`. Codex mirrors both named approval configurations.
  The lockdown's `allowedMcpServers` names every injected server AND lists each remote one by URL
  (Composio, Toolbox, the channel's Make toolbox; `*.composio.dev` in SDK mode):
  Claude Code matches remote servers by URL as soon as the list holds any `serverUrl` entry — a
  picked global server adds one — and a name entry alone then no longer admits them (2026-09-04:
  Composio silently "blocked by enterprise policy" in a channel with a picked server).
  → TEST-PLAN: MCP injection & tokens.
- Codex reasoning effort uses the same Runtime effort setting as Claude (set via the `/model`
  wizard or admin UI): effort options switch with the selected/inherited engine, and Codex runs
  receive `model_reasoning_effort`.
- Codex value is estimated, not billed spend: Settings exposes OpenAI Standard API-equivalent
  per-model `$/1M` rates. Root turns are priced from request-level rollout deltas and native child
  sessions are included without charging their copied fork prefix; Claude retains provider-reported
  cost. The actual runtime model wins when a configured Claude model falls back to Codex.
- Session recovery: Codex auth/session state uses a stable, grant-free `CODEX_HOME` while private
  skills remain per-run under synthetic `HOME/.agents/skills`, so Codex 0.147+'s persisted rollout
  paths survive cleanup without leaking grants. Resuming a session that no longer exists (including
  a legacy temporary rollout pathname) silently falls back to a fresh session
  rather than erroring.
- **Inactivity-based turn watchdog** (Claude + Codex): a turn is never killed for running long —
  every stdout/progress line re-arms the watchdog, and only `COMMAND_TIMEOUT` (default 10 min) of
  total SILENCE kills a wedged CLI ("stalled — no output for X minutes"). `sessionKeepalive` applies
  only BETWEEN turns for engines with warm sessions. → TEST-PLAN: Engines.
- **Failure auto-recovery**: a recoverable process death (stall kill, crashed warm session) gets ONE
  automatic resume within the same turn ("continue where you left off" mid-work; the original text
  when the send never started); boot recovery replays restart-interrupted turns attempt-capped at 2,
  reconnecting each replay to the same streamed answer/toolbox and temporary live-status controller
  as a foreground turn instead of staying silent until a whole answer is ready, then gives up loudly;
  an empty result (0 tokens + no output) is treated as a FAILURE, never posted as "(no output)".
  An ANSWERLESS turn — tools ran and tokens were spent, but the engine produced no text, which is
  how the CLI reports a turn it aborted itself (exit 0, `is_error` result line, error subtype) —
  is delivered as a notice naming that ending and the step count, and logged as `run_answerless`,
  instead of reaching the thread as a bare "(empty response)".
  Non-recoverable errors post a "session survived — send `continue`" hint when the session is
  resumable. A session HEAL (resume failed / resumed empty → fresh session) replays the
  Slack thread transcript into the healed session's prompt with a session-was-lost note, so the
  retried message keeps the conversation's context instead of running amnesiac. → TEST-PLAN: Engines.
- **Self-diagnosis on run errors**: a non-recovered failure opens a NEW thread in the channel named
  by Settings → `errorDiagnosisChannel` (slug, e.g. `gateway-slack`, whose folder is the gateway
  repo; "" = off) with the error + stderr tail + recent channel events, and runs Claude there to
  root-cause and PROPOSE a fix (never apply). 30-min global cooldown; a diagnosis thread's own
  failures are never re-diagnosed. → TEST-PLAN: Engines.

## Per-channel environment secrets
- **A channel's own CLI logins.** Each conversation can hold its own credentials — its own Supabase
  project, its own Vercel account — instead of every channel sharing whatever login the gateway
  host has. Stored per channel (`channel_meta.env`) and injected as process environment at spawn,
  so a CLI picks them up unaided: `supabase` and `vercel` read `SUPABASE_ACCESS_TOKEN` /
  `VERCEL_TOKEN` without being told to. Never written to a file the run can read, never visible to
  another channel, revocable per channel.
- **Write-only, by design.** Every surface — Slack modal, admin UI, API — returns the NAME, the
  provider, the last four characters, and who set it when. There is no reveal path anywhere, not
  even for an admin, and these deliberately do NOT join the `POST /api/secrets/reveal` allowlist
  (which resolves a named field to a getter precisely so it can never become "read any config
  key"). A lost token is re-issued at the provider. Add and update are the same blind write: no
  prefill, full value retyped, the last4 flips to confirm it changed.
- **Provider interface from day one.** A stored entry is a reference with a provider, so an
  external vault is a new provider rather than a rewrite. `local` ships; `vault` is on the
  enterprise roadmap. An unknown provider throws at resolve time — a turn that quietly ran without
  its credential looks like a deploy that did nothing.
- **The name rules are part of the security boundary.** Injecting an arbitrary name is code
  execution (`LD_PRELOAD`, `NODE_OPTIONS=--require`, `PATH`) and identity hijack
  (`ANTHROPIC_BASE_URL`), so a reserved set is enforced on write AND again at the runner boundary,
  where `safeSpawnEnv` re-filters inside `buildClaudeEnv`/`buildCodexEnv` rather than trusting the
  caller.
- **Case is the one thing that is forgiven.** Names are `UPPER_SNAKE` everywhere they are shown, so
  a name typed in lower case is the same variable, not an error: the admin card upper-cases it
  visibly as it is typed (and on blur, and before it is sent), and the store folds case itself, so
  the Slack modal and any API client store, list and remove the same canonical name — setting
  `supabase_token` over `SUPABASE_TOKEN` updates that entry rather than failing or duplicating it.
  Nothing else is forgiven: a dash, a space or a leading digit is still refused (quoting what was
  typed), and the reserved check runs on the folded name, so `path` cannot smuggle `PATH` past it.
- **Outbound value redaction.** Write-only in the UI is not write-only at runtime: the agent can
  read its own environment and a failing CLI will echo a token into its error line. Exact values
  are stripped from the reply, the live stream (holdback, so a value split across two deltas still
  matches) and background-job output.
- **Surfaces.** `/secrets` and a message shortcut in Slack, a 🔑 button on every authored reply
  footer (including when the channel has none, so users can add the first), and a card on the
  channel's admin page. Managing them needs the same privilege as running
  commands with them (`canEditChannelFiles`); everyone authorized in the channel can see that they
  exist.
- **Host credential suppression.** A channel supplying its own key for a catalog CLI stops getting
  the daemon's shared saved login linked in behind it, so it can never silently fall back to a
  different identity.
- **Not injected into OpenCode** (read-only, network-off): the credential would be pure exposure
  for zero use. Clean mode gets none either, like every other injected grant.

## Isolation & security
- **Current, progressively disclosed ChannelGate skill.** The repository's `channelgate` skill is
  now a concise router instead of a Claude-only lockdown recipe. Focused references cover the
  Linux/container trust boundary, per-channel HOME and write-only secrets, provider CLI/device
  login, Claude/Codex credentials, MCP identities, local skill catalog and materialization,
  catalog-first channel memory, automation/attachments/platform capabilities, and the low-level
  folder/headless MCP recipe. Its description names realistic administration/troubleshooting
  triggers while explicitly excluding ordinary tasks merely performed through ChannelGate.
  The same slice repairs the memory search/read tool registration so both use the gateway's MCP
  text-response adapter instead of failing with `text is not defined`.
  → TEST-PLAN: ChannelGate skill package.
- **Trustworthy release gate** (the macOS leg retired 2026-09-03 — Linux only): every pull request
  runs the complete coverage-gated suite on Ubuntu at the exact Node 22.13 minimum and Node 24, plus dependency-free syntax /
  whitespace checks, tracked-file secret scanning, production dependency audit, and independent
  coverage floors for authorization, access-grant isolation, sandbox policy, secret handling, and
  updater state. Claude
  and Codex stubs exercise Slack message→reply plus their engine-specific resume/MCP/cancellation
  contracts; a separate pinned nightly probes both real provider-free CLI command surfaces on Ubuntu.
  All third-party Actions are SHA-pinned with read-only repository permissions. → TEST-PLAN:
  Automated release gate (B2–B5).
- **Retired 2026-09-03 (Linux + containers only):** the filesystem-sandbox half — confinement is the channel's container (own HOME volume; only the
  work folder, clean workspace and artifact dir mounted), while memory-off and the MCP allowlist are
  unchanged. Per-conversation gated folder: filesystem sandbox confined to the folder, persistent memory
  off, MCP allowlist. → TEST-PLAN: Security (confinement, allowlist, memory).
- **2026-07 full-codebase review remediation**: engine children run with a
  minimal allowlisted env (`src/engines/child-env.js` — Slack tokens / approval secret never reach
  sandboxed processes; daemon-IPC creds ride a 0600 `internal-auth.json`); MCP tokens off argv
  (0600 temp file written only at spawn); admin UI binds loopback by default with a no-password
  lockdown and an allowlisted fs root enforced at write AND read time (`effectiveWorkDir`); model
  output escaped against `<!channel>`/`<@U…>` injection on every posting path (chunked, streamed,
  scheduled, background); Slack event dedupe on redelivery; per-thread turn serialization with
  durable queued-turn markers; warm-turn watchdog; stop aborts cold runs, queued runs, and whole
  process groups; transactional store writes (`patchChannelMeta`/`saveSettings`); login backoff +
  digest compare. → TEST-PLAN: Security checks + Review remediation (2026-07).
- Admin-selectable Composio provisioning: **Personal** preserves the existing user-token plus
  channel→organization shared-token paths; **SDK** uses one write-only organization key to lazily
  provision stable `slack:<workspace>:user:<id>` and `slack:<workspace>:channel:<id>` identities
  with reusable per-Slack-thread Composio sessions. Personal connection management belongs to the
  user; shared management follows the channel's existing `manageAccess`/`managers` policy. Mode
  changes never delete saved Personal-mode or SDK credentials, and clean mode injects neither.
- Dual Composio identities per non-clean run, named so every tool call says whose account it is:
  `composio-user` receives the active author's Personal-mode token or SDK user session;
  `composio-agent` — the agent's OWN account — receives the channel token (else the organization
  default) or the SDK channel session. Both may coexist; credentials are not persisted to channel
  folders or logged. SDK keys remain behind a local stdio bridge, so Claude/Codex receive only
  session endpoints. The injected operating guide teaches the model that `composio-agent` is simply
  *its* account (where the credential comes from is an admin detail it never surfaces) and resolves
  by pronoun across every app: “my” → `composio-user`, “your” → `composio-agent`, a named account →
  whichever has it, no pronoun → the only account with that app connected (named in the reply), ask
  when both have it; it reads each account's connected-app list before promising an action and never
  substitutes. A **DM** is personal-only: neither the channel token nor the organization default
  backs `composio-agent` there, and SDK mode mints no channel session for it, so a one-to-one
  conversation can only ever act as the requester's own account (mpim/group DMs and channels are
  unchanged). Which identities a run built is also stated IN the prompt: one line, prepended next to
  the fresh-session memory catalog and the caller's provenance note, from the same predicate that
  decides which servers the MCP config carries — so the note can never describe a server the run
  does not have.
  → TEST-PLAN: Security (Composio isolation) + MCP injection & tokens.
- Per-run MCP config: the **gateway control MCP** is always injected (scheduling + channel-admin
  tools, scoped to the channel/author, run outside the sandbox); personal/shared **Composio** and
  embedded **Toolbox** (`makeitfuture-toolbox`) are injected only when their tokens resolve. Skills
  are never an MCP server: they come from the gateway's own catalog as files (Skills platform
  below). → TEST-PLAN: MCP injection & tokens.
- Token resolution: Personal-mode Composio is two paths (**user only** plus **channel →
  org-default**); SDK mode replaces both active paths with stable user/channel identities without
  mutating saved tokens. Toolbox retains **channel → user → org-default**. Tokens can be
  set via `set_my_*_token` or the admin UI; org-default tokens and the write-only SDK key live in
  Settings → Integrations.
- Per-channel opt-out of the org-default token fallback (`meta.noDefaultTokens`): a sensitive channel
  refuses the broad gateway-wide tokens (channel/user tokens still apply).
- **Skills Manager integration retired (2026-09-05).** The `makeitfuture-skills` MCP injection, the
  organization/channel/user Skills Manager tokens (their tools, routes, UI fields and secret
  readers), the favorites stubs and the App Home favorites fetch are gone; Skills Manager remains a
  standalone product. Stub folders the old integration left in a channel folder are pruned on the
  channel's next message so they never shadow a catalog skill; the legacy `CLAUDE.md` favorites
  block is still stripped. `scripts/migrate-skills-manager.mjs` moves a deployment's Skills Manager
  data into the catalog (below). → TEST-PLAN: Skills platform (Core).
- Trusted bot apps allowlist (`settings.trustedBotApps`): lets a specific bot's posts (e.g. a Make.com
  scenario) trigger runs by bypassing the reply-loop guard **only** — the message must still carry an
  `@bot` mention and come from an approved author. → TEST-PLAN: Trusted bot apps.
- The Admin UI API reference includes the verified Make.com `slack:CreateMessage` blueprint for
  triggering the bot through Slack: the bot's member ID and the Make IDs, saved explicit mention, approved bot-user and
  trusted app/bot requirements, shared channel membership, Markdown settings, and root-thread
  timestamp fallback. README points operators to the canonical example. → TEST-PLAN: Trusted bot apps.
- Folder-scoped agent memory, **skill-packaged** (informed by Hermes + Claude Code auto-memory;
  design in the memory-improvement note (internal repo)): uncapped `MEMORY.md` and topic files are
  the portable canonical store, with one declarative fact per line under
  `People & preferences · Decisions · Environment & gotchas · Project state`) and
  `memory/<topic>.md` files carry depth, linked from index lines as `[[topic]]` — an
  Obsidian-style graph inside the sandbox, no cross-channel bleed, Claude's GLOBAL auto-memory
  stays off. A derived SQLite FTS5 index is rebuilt from Markdown for bounded retrieval.
  **Recall is catalogued, then requested:** each FRESH session gets source/topic names and directions
  to `search_channel_memory` and `read_channel_memory`, never the full memory body. Nothing
  memory-related is injected into `CLAUDE.md`: the protocol lives in a
  gateway-maintained **`channel-memory` skill** in each folder (what is in context, concrete save
  triggers, end-of-task checkpoint, the "stale in a week ⇒ not memory / declarative facts, not
  imperatives" rule, consolidation ritual — refreshed write-on-change, pruned when memory is off)
  and in the **`update_channel_memory`** gateway MCP tool, whose description re-states the save
  triggers every turn. **Saves are batched and atomic:** one call takes an `operations` array
  (`add` with optional `section`, whole-line `replace` on a unique substring, `remove`,
  `write_topic`), applied all-or-nothing with no storage cap; duplicate adds are no-ops; instruction-shaped or
  secret-shaped content is refused; after three failed saves in a row the tool tells the model to
  move on. The tool writes daemon-side, so saving works in EVERY mode — including `read` channels
  (which also keep the narrow direct `Write(MEMORY.md)` grant). Responses show a usage meter.
  **Background memory review** (`src/gateway/memory-review.js`): after a delivered foreground turn,
  a small reviewer run (Settings: model, default `haiku`; interval, default every 5 non-trivial
  turns per channel, 0 = off; a correction/preference/decision-shaped message reviews at once; a
  turn in which the model saved on its own resets the cadence) reads the thread transcript and the
  index inside the same gated folder with every mutating tool denied and a gateway MCP narrowed to
  the save tool, saves what the model did not, and posts "🧠 Memory updated — …" in the thread
  when it did (Settings toggle) so a wrong save is visible and correctable. Memory activity is
  measured: `memory_saved` (with a review flag), `memory_review`, `memory_review_error` audit
  events and usage rows with `task_kind = memory_review`. Memory saves never
  require an approval card, including when the channel uses a custom project working folder; signed
  capability/trusted-principal, allowed-root, action/path, and enablement checks still apply.
  The daemon injects its resolved filesystem + workspace roots into both Claude and Codex gateway
  MCP subprocesses (through Codex's secret broker too), so their isolated `HOME` directories cannot
  redirect default or custom-folder memory into disposable per-run state.
  → TEST-PLAN: Channel memory.
- **`gateway-usage` skill — the Slack operating manual, in every folder**: a gateway-managed skill
  (like `channel-memory`) materialized into each channel's `.claude/skills/` on every run, so the
  agent always knows how to operate inside Slack. The gateway also creates
  `.agents/skills → ../.claude/skills` so Codex discovers the exact same canonical tree (including
  granted skills and channel memory). Conflicting `.agents/skills` entries or a symlinked `.agents`
  parent are archived outside discovery before the canonical link is installed. `SKILL.md` carries the always-on description
  (“use at the start of every task”) + the core reply rules and explicit trigger vocabulary for
  tables, charts/graphs, and every other gateway capability; `references/*.md` hold the detail
  (streamed Markdown replies, @-mentions, inline/native/export/List tables, native charts,
  reminders/scheduled tasks, canvases, reading history/search, memory & standing rules, background
  jobs, channel/gateway admin, and host-side Claude/Codex authentication recovery) — progressive
  disclosure. Authentication guidance directs operators to log in or configure an API key on the
  gateway computer/VPS and never requests engine credentials in Slack. This **replaces** the always-on
  Slack-format guide that used to be baked
  into every `CLAUDE.md`. Source is a per-file **overlay**: the built-in default ships in the repo
  (`src/gateway/gateway-usage/`, in git — restorable) and admins can override any file live at
  `~/.channelgate/config/gateway-usage/` (override wins per file, so gateway updates still surface
  new/changed default files nobody edited). Injected in every mode incl. clean; marker-guarded so a
  real granted skill of the same name is never clobbered; write-on-change with stale-file pruning.
  Customized/restored via the **`get_gateway_guide`** (anyone) / **`update_gateway_guide`** /
  **`reset_gateway_guide`** (admins) gateway MCP tools — per-file or whole-guide restore-to-default.
  → TEST-PLAN: Gateway-usage skill.
- **Three base modes with independent options:** Read-only, Worker, and Admin. Read-only
  routes edits and commands to approval; Worker grants commands and file writes inside the channel
  container. Admin grants Worker to non-admin members and the permission bypass only to trusted
  admin authors. The shared settings file always disables bypass, even when it grants Worker tools.
  **Auto** and **Lean** are independent side toggles: Auto approves tool requests for every admitted
  member; Lean removes optional skills and connectors. In Admin mode, Lean applies to non-admins,
  while admins retain their configured tools and context. Changing Worker ↔ Admin preserves both
  toggles. Choosing Read-only clears Auto; enabling Auto on Read-only selects Worker. Existing Full
  access records gain the documented Worker fallback; existing Auto and Lean flags are preserved.
  Network remains a separate setting. → TEST-PLAN: Base modes and independent options.
- Read mode's filesystem contract is engine-neutral: ordinary runs get bounded gateway MCP tools
  to list, read, and literal-search the effective channel workdir. They realpath-check every target,
  refuse traversal and escaping symlinks, cap file/search output, and expose no write or shell
  operation. Claude may keep using its native Read/Glob/Grep; Codex uses these tools when its
  read-only permission profile intentionally withholds command execution. → TEST-PLAN: Engines.
- The web channel editor, custom DMs, and default templates share the three-mode picker and
  side toggles. The Slack reply's **Settings** button exposes Read-only/Worker/Admin plus Auto/Lean
  on its manager/admin-only Access tab for channels. DMs retain Runtime mode controls with
  Admin selection restricted to admins. Every click rechecks user
  authorization and channel membership, and every change is audited. `/mode read|worker|admin` changes the
  base while preserving applicable options (`bash` remains a compatibility alias). Legacy run-API
  presets remain accepted with their existing capability-reduction boundary.
- **Two-axis access model** (per channel, both editable in the admin UI): **Who can use** (`meta.access`:
  Approved members / Admins only / Locked) and **Who can manage** (`meta.manageAccess`: Org admins only /
  Channel members / Custom + `meta.managers[]`). The Slack Access page delegates channel mode (including Admin), Auto, Lean, network and use/manage policy to
  current managers. Work-dir stays org-admin-only. The gateway control MCP (`requireManage` vs
  `requireAdmin`) and in-thread `/mode` command retain their narrower admin checks; default `admins` means relaxing it is strictly opt-in. Settings →
  **Reset all channels' access to default** (confirm-gated, audit-logged) restores use/manage to defaults
  and clears custom guest + manager lists, leaving capability/skills/tokens untouched.
  → TEST-PLAN: channel access model.
- **Live three-tier skill and connector grants**: organization defaults, channel grants, and the
  authenticated active user's grants are unioned for each run, with the more specific tier
  replacing duplicate connector definitions. Admin editors can move among Org / This channel /
  This user without copying defaults into every record; new channels therefore inherit current org
  grants immediately. Claude and Codex selections remain engine-specific, OpenCode exposes no MCP
  tier, invalid skill identifiers fail closed, and user-effective settings/skills are provisioned
  through engine-specific synthetic homes and private per-run settings/skill views so host-global
  customizations and concurrent channel users cannot leak or race grants. Shared gateway skills use
  an immutable warm-safe plugin; optional personal/library overlays stay cold and private.
  Caller-supplied API identities never receive the user tier. → TEST-PLAN: channel access model.
- **Channel-scoped guest roster**: the Admin UI's **Guest access — named users** checklist loads
  only the selected Slack conversation's current human members, including Slack Connect/external
  guests, rather than every recorded MakeItFuture user. The server independently validates every
  submitted guest ID against a fresh live roster (bots, deleted accounts, stale and forged IDs are
  excluded); a shared per-channel mutation lock ensures `member_left_channel` removes a departed
  user's saved grant even when a validated Admin save is already in flight. Roster display uses
  Slack's bulk user directory with targeted Slack Connect fallbacks; saves resolve profiles only
  for submitted current candidates. If Slack is disconnected or its roster cannot be read, guest
  editing disables without falling back to the org directory or clearing existing grants, while
  unrelated channel settings remain saveable.
  → TEST-PLAN: Channel access model; Admin UI.
- Interactive permission approvals in Slack: a non-admin run that hits a non-allowlisted tool posts
  buttons in the thread — **Approve once**, **Approve for this thread**, **Approve forever** (persisted
  to `meta.approvedTools`), **Deny**. Only the run's author, an admin, or an approved user may click;
  no click within 4 minutes auto-denies. Driven by the `permission_prompt` MCP tool → the daemon's
  internal approval endpoint. → TEST-PLAN: Modes & approvals.
- Gateway control-MCP identity is authenticated with a daemon-signed, expiring run capability
  bound to the exact author, channel, slug, Slack thread, origin, and engine. The MCP server derives
  authority only from verified claims and revalidates every tool invocation; missing, expired, or
  tampered grants fail closed. Principal trust is itself signed, so an API caller cannot name a
  Slack admin and acquire gateway tools; engine fallback remints the claim for the engine that
  actually runs. Warm-session reuse fingerprints the stable authority scope and a bounded renewal
  bucket rather than the capability nonce, preserving pooling without reusing stale authority.
  Caller-controlled `CG_CHANNEL_ID` / `CG_AUTHOR_ID` identity fields no longer ride the generated
  MCP configuration. → TEST-PLAN: Modes & approvals.
- Agent-initiated approvals (Slack approval objects): the agent (Claude or Codex) can call the
  gateway `request_approval` tool to ask the user to sign off on a plan or proposed action instead
  of ending with a plain "shall I proceed?" It posts a Slack approval object in the thread with
  **Approve**, **Deny**, and **Comment** (request-changes, opens a modal) buttons — reusing the same
  `/internal/approval` endpoint and click-authorization as permission prompts — and returns
  `{ approved, feedback, decided_by }` to the agent so it continues, or addresses the feedback. The
  card shows the full `details` text (not the 60-char tool preview); documented in the
  `gateway-usage` skill (`references/approvals.md`). → TEST-PLAN: Modes & approvals.
- **Link-based approvals — the same card, as URLs, on every surface.** Native buttons are Slack's
  primitive; Teams and Google Chat do not have one the gateway drives, and automation cannot click
  anything at all. Every approval card (permission, control-plane, durable background-shell) and
  every busy-thread card can therefore ALSO be minted as short-lived, single-use, HMAC-signed links —
  one per action the recipient may actually take (*Approve once* / *Approve for this thread* /
  *Approve forever* / *Deny*, and *Steer* / *Queue* / *Cancel* for a busy thread) — and delivered
  **privately to the person who raised the request**: a Slack ephemeral in the same thread, or a
  DM on a surface with no ephemeral primitive. Never in the shared thread: a link is a bearer
  credential. `GET /approve/<token>` renders a confirmation page (tool, clipped command/plan
  preview, conversation, requester, expiry, and the one action this link performs) and **changes
  nothing** — link unfurlers, preview services and scanning proxies fetch these URLs, so a GET with
  a side effect would let the unfurler decide the request before a human saw it. `POST` (the page's
  single Confirm button) resolves it through the same `applyApprovalDecision` /
  `applyBusyThreadChoice` the buttons and the admin API use, so scope semantics, the durable
  compare-and-swap, the waiting MCP call and the in-thread card update are identical; the waiting
  agent reads `decided_by: "link"`. The signature covers id + action + scope + expiry, so a *Deny*
  link cannot be edited into an *Approve forever* one; the nonce is spent by one atomic UPDATE, so
  a link works exactly once; deciding a card retires every other link for it; and the requester's
  own authority is re-checked on every POST, so an admin-tier sign-off gets a Deny link and no
  Approve link at all. Unknown/used/expired → a plain page and 404/410 that says nothing about any
  other request, with per-IP backoff on bad tokens; responses are `no-store` + `noindex`. Settings →
  Connection → **Approval links**: `auto` (default — where there are no native buttons, plus selected
  Slack testers once `publicUrl` is set), `always` (eligible recipients, with loopback fallback), `off`.
  **Testing with AI** is a compact searchable Slack user selector (`aiTestingUsers`, empty by default).
  Search names or IDs, choose results with a click or arrow keys + Enter, and remove selected-user
  chips with ×. Results are bounded and scrollable; search alone does not mark Settings dirty.
  Saved users missing from the directory remain visible and removable. Only
  selected users receive supplemental permission, control-plane, durable-shell and busy-thread
  links; both `auto` and `always` enforce it, including for admins. Removing a user stops links
  on subsequent cards immediately. Native buttons and existing link expiry remain unchanged;
  membership grants no additional permissions. Surfaces without native buttons retain their links.
  Every link decision logs `approval_resolved_by_link` (ids, decision, scope — never a value).
  → TEST-PLAN: Modes & approvals.
- Admin-only dangerous permissions (admin author **and** adminMode channel); non-admins run the
  folder allowlist. → TEST-PLAN: Security (dangerous perms).
- **Retired 2026-09-03 (Linux + containers only):** the deny lists and the allowlisted domain set,
  and with them the sandbox-egress meaning of **Allow Network** (formerly: "sandbox egress to an
  allowlisted domain set, default GitHub" — that filtering no longer exists and is not coming back
  in this shape). Inside the container the gateway root, the sensitive home paths and other
  channels' folders are simply not mounted, and the former per-channel **Allow Bash** deny-list
  (Bash + Write/Edit with writes kept away from the gateway root, `.ssh`, `.aws`, `.config`,
  `.claude`, keychains and every other channel's folder) is the container boundary instead.
  → TEST-PLAN: Sandbox boundaries.
- **Allow Network is an ADVISORY per-channel switch, not an egress boundary.** Every channel's
  container runs on the default bridge network and the gateway polices no egress per channel, so
  "off" does not cut the container off — it states the channel's intent. That intent is now said
  out loud everywhere instead of being inferred from a missing suffix: the mode label carries the
  state in BOTH directions (`Read-only · network off` / `Bash · network on`), `/mode` and `/status`
  add the caveat (`network off (advisory — not enforced by the container yet)`), the gateway-managed
  block at the top of every conversation's instruction file states the mode and the network switch
  to the engine itself, and the `run_config` event records `networkEnforced: false` beside
  `networkPolicy` so an operator reading it after an incident cannot mistake `"off"` for "this turn
  could not reach the internet". A container-side egress proxy that actually enforces the switch is
  a later slice; `NETWORK_POLICY_ENFORCED` in `src/engines/network-policy.js` is the one flag every
  surface reads. → TEST-PLAN: Sandbox boundaries.
- **Retired 2026-09-03 (Linux + containers only):** nothing replaces it — with no host sandbox there is no user namespace for AppArmor to restrict,
  and rootless Podman brings its own uid mapping (`--userns=keep-id`, `/etc/subuid`). **Linux hosts keep their Bash sandbox under Ubuntu's AppArmor userns restriction**: Ubuntu 23.10+
  (24.04 LTS included) stacks any unconfined process that creates a user namespace into a
  capability-stripped profile, which kills Claude Code's sandbox on its first `setgroups` write.
  `scripts/apparmor/claude-code-userns` is a targeted mediating profile attached to the Claude
  version binaries (host hardening stays on; no sysctl flip), installed and live-verified by
  `scripts/apparmor/claude-userns-fix.sh`. The daemon names the condition at boot
  (`src/engines/linux-userns.js`) and `install-systemd.sh` prints the remedy when it detects the
  restriction. The same file carries a `codex-userns` block for the Codex standalone binaries:
  without it the capability strip spares Codex's filesystem sandbox but starves its
  approved-domain `network_proxy`, which then resets every tunnel (allowed domains included) —
  the boot assessment flags a stale pre-Codex install of the profile and says to re-run
  `--apply`. → TEST-PLAN: Security (Linux userns sandbox).
- **Retired 2026-09-03 (Linux + containers only):** the rationale only — the job runs inside the channel's container, and both gates stay. Background shell jobs have two independent gates: the channel must be auto-mode (or admin-mode
  with an admin author), then a gateway admin must click the durable exact-command Slack approval.
  The second gate is never auto-approved because the command runs outside the engine sandbox.
  → TEST-PLAN: Security (background gating).
- **Retired 2026-09-03 (Linux + containers only):** admin channels run in containers too — the admin author's live turn keeps the bypass flag, its
  work folder is bind-mounted read-write like any other's (a host directory used as the work folder
  is visible in full, nothing beside it), and nothing else of the host is reachable — unless the
  operator turns on **Full-access channels see the gateway home** (2026-09-06, Settings → Container
  runtime, `containerFullAccessHome`, off by default): then every Full-access channel's container
  also bind-mounts the gateway user's whole home read-write at its identical path (every channel's
  work folder + memory, every repo, the gateway root incl. logs/metadata/credential stores; only
  `~/.local/share/containers` masked), Claude's admin-run settings list it in
  `permissions.additionalDirectories` (derived from the resolved mount), the grant is part of the
  create-time fingerprint, no MCP tool can flip it, and it is per channel (every admitted author
  reads; an admin author's turn writes). → TEST-PLAN: Container runtime (operator-home grant). **Admin mode delivers its documented contract** — "full tools, sandbox off": an admin author's
  live foreground turn in an admin-mode channel runs with the bypass AND `sandbox.enabled: false`
  (the flag alone never lifts the sandbox), so it can genuinely reach the whole account — while
  the shared settings keep every other run fully sandboxed, and unattended admin runs stay at the
  sandboxed auto tier. → TEST-PLAN: Security (Admin sandbox-off).
- Approval-based authorization: admins + approved (MakeItFuture-list) users may talk in any
  channel they're in and in DMs; unknown users denied everywhere (incl. DMs) unless added as a
  per-channel guest. New users are recorded as un-approved pending an admin's approval.

## Container runtime (v0.8 P1)
- **Accurate container access instructions:** the shared operating guide states the default
  boundary and the optional Admin/Full-access operator-home grant. Each generated guide names the
  resolved runtime's `containerFullAccessHome` setting and operator-home mount, including a gateway
  with the switch on but a Worker channel without the mount. It distinguishes the channel's own
  `$HOME` from the mounted operator home, channel-wide reads from admin-author bypass tools, and
  a missing runtime target from a known absent grant. The same facts reach Claude and Codex skill
  discovery, including clean workspaces. Admin guide overrides keep their documented precedence.
  → TEST-PLAN: Container runtime (operator-home guide acceptance).
- **Current access facts on resumed turns:** every engine attempt also receives the resolved
  home-access setting/mount in its prompt, with explicit precedence over stale thread claims.
  Guide generation and attempt prompts share one access-note generator. Fresh/resumed, clean,
  model-retry, healed and fallback attempts retain these facts; an enabled gateway switch is
  distinguished from the current channel's actual grant and a proposed switch to Admin mode.
  Environment credentials are described as usable when injected, with masked listing/reveal
  surfaces and redacted outputs. → TEST-PLAN: Container runtime (resumed access facts).
**Since 2026-09-03 this is the ONLY runtime (Linux + containers only):** the `host` backend, the
gateway-wide kill switch, the per-channel runtime pin and the host↔container session carry below
are retired, bullet by bullet; everything else stands.
- **Where a turn runs is a declared backend, resolved once.** `src/runtimes/` is to WHERE an engine
  process runs what `src/engines/` is to WHICH engine runs and `src/platforms/` to which surface
  answers: a `RuntimeBackend` contract (`prepareTarget` · `ensureUp` · `spawn` · `probe` · `signal`
  · `acquireLease` · `destroy` · `fingerprint` · `describe` · `resumeCommand` · `helperCommand`)
  with two implementations — `host` (today's `child_process.spawn`, `kill(pid,0)`, negative-pid
  group kill, unchanged byte for byte) and `container`. Validation is fail-closed at load: a backend
  that omits a method, omits one of the four capabilities (`isolated`, `processGroups`,
  `detachedSurvivesDaemon`, `persistentHome`) or declares an unknown one does not load, an unknown
  capability KEY throws, and an undeclared capability reads as the least capable value. A new
  backend is a module plus a registry entry — never another `if (backend === "container")` branch.
  → TEST-PLAN: Container runtime (v0.8 P1).
- **One decision per turn, one target downstream.** `resolveRuntime()` runs once and hands the same
  RuntimeTarget to the folder generator, the MCP config builder, the engine runners, the artifact
  paths, background jobs, memory review and the session stamp. The target carries the backend id and
  object, the REASON it was chosen, slug/platform/meta, the `cwd` the run executes in, the durable
  `workDir` (the bind-mount source; equal to `cwd` outside clean mode), the `cleanWorkDir`, the
  `artifactDir` (null on the host), the container-runtime settings snapshot, and — for a container —
  the resolved container block. Nothing downstream asks "is this a container?"; it asks the target's
  declared capabilities. → TEST-PLAN: Container runtime (v0.8 P1).
- **Retired 2026-09-03 (Linux + containers only):** the kill switch, the per-channel `meta.runtime` pin and the admin-mode → host rung — every channel
  resolves to the container backend, there is no host to return to, and the daemon refuses to boot
  without a container CLI. **Backend precedence, stated once**: the gateway-wide kill switch `containerRuntimeEnabled:false`
  → `host` (reason `disabled`, the v0.8 rollback lever); a channel in **admin mode** → `host`
  (`admin-mode` — an admin channel is deliberately unconfined, so it is honest about it);
  `meta.runtime` = `host`|`container` → that (`channel`); otherwise the gateway
  `containerDefaultBackend` (`default`). An invalid pin falls through to the default rather than
  failing. A per-run override may only REDUCE capability, so the decision reads the CHANNEL's stored
  `adminMode`/`runtime` and never the overridden run view — `mode:"read"` cannot move a turn off its
  container. Clean mode changes the cwd, not the backend. → TEST-PLAN: Container runtime (v0.8 P1).
- **Retired 2026-09-03 (Linux + containers only):** the kill-switch clause only — a missing container CLI is now a refused BOOT rather than a refused
  turn; the rest of the bullet stands. **Fail closed, never a silent fallback.** No usable container CLI, no built image, or no engine
  login ends the turn with the sentence that names the remedy (`npm run build:image` on the gateway
  host; `claude setup-token`; `codex login`) — the backend never quietly demotes the channel to the
  host, because a confinement boundary that disappears without saying so is worse than a refused
  turn. Only the explicit kill switch returns channels to the host. A missing engine credential is
  raised as a CONFIGURATION failure (`details.runtimeCredential`), not a provider outage, so
  cross-engine failover cannot answer with the other harness and hide the one thing an operator has
  to fix; the existing rule that a user-PINNED harness/model never fails over is unchanged.
  → TEST-PLAN: Container runtime (v0.8 P1).
- **The container spec.** Rootless **Podman** is preferred (`auto` probes podman, then docker; the
  kind is detected from what `info` returned, not from the binary name, because `docker` may be a
  podman shim). Rootless podman gets `--userns=keep-id` so files the agent writes in a bind mount
  stay owned by the daemon user with no chown pass; everywhere else the uid is pinned with
  `--user <uid>:<gid>`, per container and per exec. Mounts, all at IDENTICAL absolute paths because
  transcripts, `/resume`, git worktrees and every path the model prints have to stay valid on both
  sides: the channel's resolved workdir, the clean workspace (so clean mode works in a container),
  and the per-channel artifact dir `~/ChannelGate/.runtime/<platform>/<slug>` (0700) that holds this
  run's engine-facing files. The channel's HOME is a **named volume** at `/home/agent`; the daemon's
  MCP socket directory is mounted **read-only** at `/run/channelgate`; the Codex `auth.json` is a
  single-FILE mount (the one deliberate exception to "mount directories, never single files" — see
  the credential bullet); `/tmp` and `/var/tmp` are per-channel bind mounts too, for durability (own
  bullet below). Hardening: tmpfs `/run` only (64m, noexec — pid files and the socket mount, which
  must be fresh at every start);
  `--cap-drop ALL` plus only `DAC_OVERRIDE`/`CHOWN`/`FOWNER`; `--security-opt no-new-privileges`;
  `--init`; `--pids-limit` (1024 by default), `--memory` and `--cpus`, all three dropped with a
  warning when the host does not delegate cgroup controllers (probed once with a throwaway
  container, so a whole fleet does not fail one spawn at a time). Every container carries
  `channelgate=1`, `cg.install`, `cg.platform`, `cg.channel`, `cg.fingerprint`, `cg.image` and
  `cg.created`; names are `cg-<install>-<platform>-<slug>` clamped to a DNS-safe length with a
  collision-proof digest tail, where `<install>` is a digest of the runtime root's real path — two
  gateways on one host (and one container daemon) never collide, and discovery is by name and then
  VERIFIED by the install label, so a container that merely answers to our name is never touched.
  → TEST-PLAN: Container runtime (v0.8 P1).
- **What a container can never see**: the gateway root, `config/`, `gateway.db`, the per-channel
  metadata folder, the daemon's own checkout, and the operator's `~/.claude` / `~/.codex`. The only
  sources under the gateway root are the clean workspace and the read-only socket directory. The
  per-run environment — which carries the channel's own provider logins — rides a 0600 `--env-file`
  under the channel's metadata folder (host side, never mounted) and never `-e KEY=VALUE`, because
  argv is world-readable in `ps`; the file is deleted when the child closes, and files a crashed
  daemon left behind are swept. Values a line-oriented env file cannot represent are DROPPED and
  their names logged rather than silently truncated. Host-only variables (`PATH`, `NODE_PATH`,
  `TMPDIR`, the XDG set, `SSH_AUTH_SOCK`, …) are stripped so the image's own values stand, and
  `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `CG_RUNTIME` are owned by the backend.
  → TEST-PLAN: Container runtime (v0.8 P1).
- **Lifecycle: created lazily, stopped when idle, removed almost never.** The container is created
  on the channel's first run (`tini` as PID 1, `cg-init` preparing the HOME volume on every start,
  then `sleep infinity`); an exited one is **started**, not recreated, which returns it in well under
  a second with its writable layer intact. Reuse is decided by a FINGERPRINT of the create-time
  configuration — resolved image ID (not the moving tag), mounts, network, uid strategy, applied
  limits, hardening flags, credential mode — carried in the `cg.fingerprint` label; everything
  per-exec (env, channel secrets, prompt, mode, model) is deliberately outside it, so rotating a
  channel secret retires the warm ENGINE process through the pool's own fingerprint and does not
  tear down a container that background jobs are living in. A stale fingerprint recreates only when
  nothing holds a lease; otherwise the turn uses the container it has, says so, and recreates at the
  next idle moment. A create/start slower than two seconds announces itself in-thread — silence that
  looks like death is the bug the gateway's heartbeat rules exist to prevent. → TEST-PLAN: Container
  runtime (v0.8 P1).
- **Idle is measured in leases, not in quiet.** Foreground runs, background jobs and memory-review
  runs each hold a lease for their whole life, and a container with any lease is never stopped no
  matter how quiet it looks; the idle clock starts when the last lease is released.
  `containerIdleMinutes` (default 10) stops — never removes — an unleased container.
  `containerMaxRunning` (default 8) makes room before a create or start by stopping the
  least-recently-used IDLE container; when every slot is leased it WAITS, announces the wait once,
  and after five minutes refuses with the remedy rather than killing someone's running job.
  `destroy()` removes the container, and the HOME volume ONLY on channel deletion — never on a
  rollback or a reconfiguration, so a channel switched back to the host and later returned to a
  container finds its CLI logins where it left them. → TEST-PLAN: Container runtime (v0.8 P1).
- **VS Code attaches to the channel, not a look-alike development container.** An operator runs
  `npm run vscode -- <channel id, slug, or exact name>` to start the existing channel container and
  open its identical mounted work directory through VS Code Dev Containers. The helper holds a
  signed cross-process editor lease for the lifetime of the window (including across a daemon
  restart), so neither the idle reaper nor
  the max-running eviction can stop it; stale markers are rejected by Linux process start identity
  and removed automatically. `/home/agent` is the same persistent volume the chat engines use, so
  installed tools, dotfiles and CLI logins remain identical. Codex keeps the gateway's shared
  read-write login mount. Claude keeps the safer no-copy design: the helper obtains the same normal
  subscription access-token relay as a chat turn, refreshes it while the window is open, and places
  it behind a channel-local `claude` wrapper which defers to any credential explicitly injected by
  a gateway run. Closing the window removes the live token and lease; the wrapper itself is inert.
  The lease record itself lives in daemon-owned metadata under the gateway root, never in the
  agent-writable artifact directory. → TEST-PLAN: Container runtime (v0.8 P1).
- **A stale container is rebuilt before it is used, not after.** The create-time fingerprint has two
  halves. `cg.mounts` covers only what decides what the container can SEE — the work directory, the
  clean workspace, the artifact directory, the HOME volume and every bind and mask — and a mismatch
  there is never deferred: the turn waits with an initial notice and a reminder every minute for
  the runs still inside to finish, then rebuilds and continues automatically. Stop cancels the wait
  and preparation lock before spawning; preparatory waiters do not count as occupants. Running
  against mounts that point at a directory the channel has moved or deleted is not an option. A
  mismatch that is only about behaviour (a rebuilt image, a limit, the network mode) keeps the old
  deferral: the container is used for this turn and replaced at the next idle moment. "Busy" means
  someone ELSE is inside — a caller that leased the container before asking for it (every turn does,
  so the idle reaper cannot stop the environment mid-spawn) passes its own lease handle and is not
  counted against itself. Rebuilding preserves the waiting turns’ leases until their owners release
  them. → TEST-PLAN: Container runtime (v0.8 P1).
- **Nothing a channel accumulates is ever lost — including its temp files.** A container is stopped
  as a matter of routine (the ten-minute idle sweep, the max-running cap) and recreated whenever its
  create-time fingerprint changes (an image rebuild, a limit change, a network-mode flip), so the
  durability question is not "does a rollback keep my data" but "does a Tuesday". Everything a
  channel accumulates lives in one of three places, none of which the daemon deletes: the
  per-channel HOME **volume** (`/home/agent` — engine sessions, CLI logins, `npm -g`, `pip --user`,
  `pipx`, `uv`/`cargo` installs, caches), the bind-mounted work directory, and — since image spec
  1.1.0 — `/tmp` and `/var/tmp`, which are bind mounts of
  `~/ChannelGate/.runtime/<platform>/<slug>/{tmp,var-tmp}` rather than tmpfs. As tmpfs they were the
  ONE thing a stop threw away, a regression against the host backend, where Claude Code's
  `/tmp/claude-<uid>/…` scratchpad survives between turns; as bind mounts they persist, are visible
  to the operator, and trade the tmpfs size cap for the disk (the same deal the work directory
  already had). `/run` stays a tmpfs on purpose. The image PATH puts every place a channel can
  install into ahead of the pinned toolchain — `~/.npm-global/bin`, `~/.local/bin`, `~/bin`, then
  `~/.cargo`/`~/.bun`/`~/.deno`/`~/go` — and ships `pip`/`venv`/`pipx` with `PIP_USER=1` +
  `PIP_BREAK_SYSTEM_PACKAGES=1` so a plain `pip install <cli>` lands in the volume instead of dying
  on Debian's externally-managed-environment marker. What a channel deliberately cannot do is
  `apt`/`sudo`: the toolchain is root-owned so a channel can never replace its own engines. The
  daemon compares the built image's spec label against the one this checkout expects and names
  `npm run build:image` at boot when they differ. → TEST-PLAN: Container runtime (v0.8 P1). A
  self-update rebuilds it automatically (see *The update rebuilds the channel image*).
- **Boot reconcile and out-of-band removal.** Every engine process inside a container that survived
  a daemon restart belonged to the previous daemon, which can no longer read its stdout — restart
  recovery records unknown executions for reconciliation — so the boot sweep terminates the `run-*` and `warm-*` process
  groups of every running container of THIS install and leaves detached `job-*` groups alone,
  because a background job is meant to outlive a restart. An exec that fails because the container
  vanished underneath it (an operator `podman rm`, a host reboot) re-runs `ensureUp` and retries
  exactly once, in one place, rather than failing the turn. → TEST-PLAN: Container runtime (v0.8 P1).
- **Engine logins: per-channel where it can be, shared only where the CLI forces it.** Claude is
  never copied into a container. A configured `claude setup-token` (write-only in Settings) is used
  when present; otherwise the mode is **relay** — the container receives the current ACCESS token of
  whichever login the gateway resolved, normally the host user's own `~/.claude`
  (`src/gateway/claude-login.js`), injected as `CLAUDE_CODE_OAUTH_TOKEN` at exec. No credential mount
  at all, and no forked refresh chain: an access token cannot rotate anything, whereas a copy that
  refreshes would log the gateway out (it did, live, on 2026-09-02). The daemon's own
  `ANTHROPIC_API_KEY` is the third mode, for service installs with no login. With none of them the
  mode is **missing** and a Claude turn fails closed. Codex is the opposite case — it rewrites `auth.json`
  IN PLACE, so a copy would fork the refresh chain and one side would eventually lose the race — and
  therefore gets a shared read-write FILE mount of the gateway's real auth file. What is ISOLATED
  per channel: the whole HOME volume — CLI logins, npm prefix, dotfiles, caches, the Claude config
  dir (transcripts, prompt history, todos, shell snapshots) and `CODEX_HOME` (sessions, history).
  What is SHARED: the Codex sign-in file, and nothing else; `describe()` compares its inode so a
  container still holding a login the host has since replaced is visible rather than silently stale,
  and `/status` carries the caveat in words. → TEST-PLAN: Container runtime (v0.8 P1).
- **Inside the container, each engine's OWN sandbox is off** — the vendor-sanctioned pattern, and the
  only correct one here: a second sandbox inside a cap-dropped rootless container would need the
  nested namespaces that container forbids, and every path it names (home, the gateway root, sibling
  channels, host toolchain binaries, credential stores) is a HOST path that does not exist on that
  side of the boundary, so it would deny and allow the wrong things. Concretely: an isolated target's
  `.claude/settings.json` carries **no `sandbox` key at all** (absent, not disabled), and with it the
  workspace scan, the channel listing and the toolchain/credential carve-outs that only existed to
  build it are skipped; Codex states `--sandbox danger-full-access` for write modes and `read-only`
  in read mode (as the `sandbox_mode=` config twin on resume, where the flag is rejected), with no
  permission profiles, no `network_proxy` compilation and no `sqlite_home`. A stated mode also
  states the MECHANISM that can enforce it in here — `features.use_legacy_landlock=true`: Codex's
  default is bubblewrap, which cannot start under `--cap-drop ALL` + no-new-privileges
  (`bwrap: Unexpected capabilities but not setuid`) and failed every command, so Read mode could not
  even read; Landlock gives the same posture in-container (reads succeed, writes get "Permission
  denied"). The flag is deprecated-but-functional in the pinned CLI (`containers/versions.json`) and
  is re-checked on every Codex bump; the admin bypass has no sandbox and states no mechanism. Everything that is
  POLICY rather than confinement is unchanged on both backends: `permissions.allow` +
  `permissions.ask` (the shell for any channel that did not grant it — never the admin-run variant,
  which grants it), the mode →
  tool/approval mapping, `disableBypassPermissionsMode`, `autoMemoryEnabled`/`autoDreamEnabled` off,
  the MCP allowlist, `--ignore-user-config`, and the admin-only bypass. The Stop hook and every
  helper an engine spawns come from the image's `/opt/channelgate` bundle, asked for through the
  backend's `helperCommand()` — a containerized run never names a path in this checkout.
  → TEST-PLAN: Container runtime (v0.8 P1).
- **The gateway control MCP reaches a container over a unix socket, not a mount and not a port.** A
  containerized run has no `gateway.db`, no config directory and no daemon port — the three things
  the stdio gateway MCP server depends on — so the daemon serves the control plane ITSELF on
  `<gateway root>/run/mcp.sock` (directory 0700, socket 0600), bind-mounted read-only at
  `/run/channelgate`, and the image ships a dependency-free stdio↔socket bridge the engine spawns as
  an ordinary MCP server. A socket rather than HTTP because it needs no address: it works for a
  `--network none` channel, behaves identically on rootful docker, rootless docker and podman, and
  needs no bearer in a URL — and because Codex cannot consume a header-bearing HTTP MCP server
  anyway (every remote MCP is already bridged to stdio for it), so an HTTP control plane would have
  needed a bridge regardless. → TEST-PLAN: Container runtime (v0.8 P1).
- **The socket's wire protocol is one line, then MCP.** The client writes a newline-terminated hello
  (`{channelgate:"hello", v:1, service:"gateway"|"composio-sdk", cap, engine, toolset,
  progressReport, args, framed}`) and the daemon answers on the same socket with the MCP stream,
  preceded — only for a client that opted into `framed` — by one `{channelgate:"ready"}` line. A
  refusal is ALWAYS announced as `{channelgate:"error", reason}` before the socket closes, so the
  engine's MCP startup log shows why instead of an unparseable JSON-RPC frame; the bridge prints it
  on stderr and writes nothing to stdout. A hello that is late (2 s), oversized (64 KB), malformed,
  names an unknown service, or carries a capability this daemon did not sign is refused. Each
  connection gets its own MCP server instance. → TEST-PLAN: Container runtime (v0.8 P1).
- **Identity on that socket is the signed capability and nothing else.** `toolset` and
  `progressReport` are SIGNED claims, so a container cannot widen its own tool surface by setting an
  environment variable — the memory reviewer's one-tool grant holds even though the bridge's env
  says nothing about it — and the capability is re-verified at every tool call, exactly as the stdio
  server does. Minting and verification now happen in ONE process, which permanently retires the
  aud/secret-skew class the child-process path had to defend against. `CG_APPROVAL_SECRET` and
  `CG_PORT` are deliberately absent from a container: the in-process server calls the daemon's own
  background/approval/restart handlers directly, so a container holds no loopback IPC credential and
  there is no `/internal/*` route for it to reach. Composio **SDK mode** is a second SERVICE on the
  same socket rather than a second process, because its organization key lives in gateway settings a
  container cannot see. An unbindable socket path (over the 100-byte `sockaddr_un` budget, a
  read-only root) logs one line and never fails the boot — container runs then fail closed with
  their own message. → TEST-PLAN: Container runtime (v0.8 P1).
- **Liveness crossed a pid namespace, so the watchdog learned a third answer.** A container child's
  pid names the host-side `exec` CLIENT, never the engine, so liveness and signals are asked of the
  backend: a probe execs `cg-probe <runId>` against the process-group leader `cg-exec` recorded
  inside, and a stop signals the whole in-container run through `cg-signal`. A stop is the whole
  RUN, not its process group: `cg-signal` walks `/proc` once before it signals anything and takes
  down every process in the run's session plus the leader's entire descendant tree, because Claude
  Code's Bash tool puts its shell in a session and a process group of its own and a group kill left
  it — and whatever it was running — alive after the turn was stopped. `cg-sweep` signals through
  the same helper, so a boot sweep reaches exactly what a stop reaches. The probe is
  therefore ASYNC and bounded by a timeout, and its result is three-valued — `true`, `false`, or
  **unknown**. A probe that throws, times out, or answers inconclusively reports UNKNOWN and the
  turn KEEPS WAITING; only a definite `false` ends it. The non-negotiable rule is intact: a quiet
  turn is reported, never killed, and a container-daemon hiccup must not look like a dead engine.
  → TEST-PLAN: Container runtime (v0.8 P1).
- **Background jobs live in the container and outlive the turn.** A shell job resolves WHERE it runs
  at its OWN spawn (a channel moved to a container between the turn and the job runs in the
  container), holds a `job` lease for its whole life so the idle reaper cannot stop the environment
  under it, and is a DETACHED `exec -d`: the client returns immediately, so there is no stdio to
  attach and no exit code to read from the child. Output goes to a log under the artifact mount — the
  same absolute path on both sides, so the daemon tails the very file the job writes — and the
  wrapper appends a `[cg-exit:N]` marker as its last act, so a finished job reports a real exit code
  (a missing marker is "unknown", never 0). The persisted row records `{backend, runId, container}`,
  so after a daemon restart a recovered job is probed and signalled BY ITS RUN ID through the
  backend, never by the stale pid of a client process that is long gone. The memory reviewer follows
  the same rule: it resolves its own target, takes a `review` lease, and runs in the channel's
  container with its config and settings under the mounted artifact dir. → TEST-PLAN: Container
  runtime (v0.8 P1).
- **Where a run happened is recorded and shown.** Migration 13 adds an additive `sessions.runtime`
  column — a JSON `{backend, fingerprint, image}` stamp with a `''` default, so older code still
  boots on the new schema, every pre-v0.8 row reads as a host row, and unreadable content reads as
  "unknown, therefore host" instead of crashing. `/status` gains a Runtime line (backend, container
  name, image, state, uptime, warm, credential caveats); the live heartbeat row appends
  ` · container` from the run's DECLARED capability, never from a backend id; the reply footer
  appends the image ref for a container turn (a rebuilt image is a different toolchain, which
  changes what an answer meant) and is byte-unchanged on the host; and `/resume` prints the
  container form — `podman exec -it -w <cwd> <name> <the engine's own resume command>` — with no
  redundant `cd`, while identical mount paths keep the transcript's recorded cwd valid so session
  adoption works unchanged in both directions. → TEST-PLAN: Container runtime (v0.8 P1).
- **Retired 2026-09-03 (Linux + containers only):** the container → host direction — a thread's history now lives in its channel's
  HOME volume and stays there; the only carry left is the one-time host → container copy for a
  thread that last ran on the host before the switch (`src/gateway/session-carry.js`; the heal
  stays the safety net behind it). **A thread's engine history follows it across runtime backends.** Stopping, starting or recreating
  a container loses nothing — the HOME volume and the workdir bind outlive it. The one real loss was
  a thread whose CHANNEL changed backend between two messages (host → container when a channel is
  containerized, container → host when it is set to admin mode, pinned back, or caught by the kill
  switch): the engine's state dir moved with it, the resume found no session, and the turn was
  HEALED instead — a fresh engine session with the chat transcript replayed, which keeps the
  conversation readable but throws away everything the transcript never held (compaction summaries,
  tool results, subagent transcripts, the model's own working state). Now, before the first resume
  attempt and only when the backend actually changed, that session's files are copied to the side
  about to run: lazily, one thread at its next message, in BOTH directions, overwriting the older
  copy and deleting nothing on either side. WHERE a harness keeps a session is a per-engine fact
  (`sessionState` in `src/engines/adapters.js`) — Claude's `projects/<cwd-key>/<id>.jsonl` plus the
  `<id>/` subagent directory, Codex's `sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`, whose date tree is
  what `codex exec resume` walks and therefore survives the copy intact; an engine that declares
  none (OpenCode) is skipped rather than guessed at. HOW state crosses the boundary is a per-backend
  fact (`copyIn`/`copyOut`, optional contract methods): the daemon cannot touch a HOME volume, so
  the container half stages through the bind-mounted artifact dir and runs ONE `sh -c` inside — and
  a file that container stages outside the requested state dirs is refused, never written. The
  read-only twin `inspectState` answers the same boundary problem for a LOOK rather than a move —
  `/resume` adoption asking "is this session in this channel, and where was it started?" — with one
  `sh -c` that globs the layout and returns each match's mtime plus its capped opening lines. The
  session row is re-stamped the moment a carry succeeds, so it always names the side holding the
  newest copy and the next turn can never carry a stale copy back over it. Every failure is one log
  line and the turn continues: the heal is still the safety net, it is just no longer the first
  resort. The `run_config` event records `sessionCarried` when it happened.
  → TEST-PLAN: Container runtime (v0.8 P1).
- **Retired 2026-09-03 (Linux + containers only):** the enable switch, the default-backend choice, the per-channel/DM **Runtime** select with its
  `runtimeEffective`, and `set_channel_runtime` — the container is the only runtime; the CLI choice,
  the image, idle minutes, max running, the caps and the Claude token stay. **Admin surface.** Settings → **Container runtime**: the gateway-wide enable switch, the default
  backend, the CLI choice (auto/podman/docker), the image reference, idle minutes, max running
  containers, the pids/memory/cpu caps, and the write-only Claude token from `claude setup-token`
  (listings return `has*`/`last4` only; the value is revealable one at a time through the named
  getter allowlist and is never echoed by a save). Every value that would reach the container CLI's
  argv is validated at the admin boundary and REFUSED with a 400 rather than sanitized — a flag, a
  space or a shell metacharacter in an image ref, a memory or a cpu value cannot become part of the
  run command, and a refusal writes nothing. Each channel and DM has a **Runtime** select
  (gateway default / host / container) whose listing carries `runtimeEffective` beside the stored
  pin, so the UI shows "host (kill switch)" without re-deriving the precedence table; in chat,
  `set_channel_runtime` does the same for admins and answers with the backend the next turn will
  actually use. `/api/health.containerRuntime` reports the CLI kind/version/rootlessness, the image,
  the control socket, and every running container with its leases and idle time — to authenticated
  callers only. → TEST-PLAN: Container runtime (v0.8 P1).
- **The image is built from the repo and pinned.** `npm run build:image` builds
  `containers/Containerfile` with the DAEMON user's real uid/gid baked into the image's `agent`
  user (so bind-mounted files are owned correctly on both sides and no chown pass exists), the CLI
  versions pinned in `containers/versions.json`, and a minimal in-image bundle resolved as the
  transitive IMPORT CLOSURE of the three helpers an engine spawns during a run — the checkout is
  never mounted and never copied, and staging into a temp context makes a `COPY . .` mistake
  impossible rather than merely discouraged. It refuses to build as root, and tags both
  `<repo>:<imageSpecVersion>` and `:latest`; because a tag is a moving pointer, the container
  fingerprint is built from the resolved image ID, so a rebuild retires containers on their next run
  instead of leaving channels on yesterday's toolchain. The image is never built inside a turn: a
  missing image fails the run closed with the one command that fixes it. → TEST-PLAN: Container
  runtime (v0.8 P1).
- **Built-in local video understanding (image spec 1.2.0).** Every conversation
  image includes `ffmpeg`/`ffprobe`, pinned `opencv-python-headless` + `faster-whisper`, and a
  root-owned pre-cached Whisper `small` model. The always-present `gateway-usage` skill owns the
  video workflow, sampling guidance, dependency diagnostics, and analyzer script, so it can extract representative frames, build contact sheets and transcribe timestamped
  speech without a per-channel install or first-use model download. `npm run setup` builds the
  image as part of a fresh install (`--skip-image` / `CG_BUILD_IMAGE=no` defers it and names
  `npm run build:image` as the remedy; a failed build never aborts the install), so a new gateway
  never reaches its first message without the toolchain. The former standalone catalog skill is
  excluded and removed from all durable grant tiers at boot. → TEST-PLAN: Container runtime (v0.8 P1).
- **Built-in browser automation (image spec 1.3.0).** Every conversation image ships a pinned
  Playwright chromium plus the `agent-browser` driver, so a channel can open, drive and screenshot a
  web page with no per-channel setup. Both halves are baked in: the browser itself AND the distro
  libraries it needs to start — a browser downloaded into a channel's own HOME volume used to die on
  `libnspr4.so`, and a container has no root with which to install it. The dependency set comes from
  `playwright install --with-deps` rather than a hand-copied library list, the browsers live under
  `/opt` so every channel shares one root-owned copy instead of paying ~400 MB per volume, and the
  build launches the binary once so a missing library fails the BUILD rather than the first
  navigation. `AGENT_BROWSER_EXECUTABLE_PATH` points every run at that stable path — never at a
  chromium revision, which changes with the Playwright pin. → TEST-PLAN: Container runtime (v0.8 P1).
- **Retired 2026-09-03 (Linux + containers only):** the daemon refuses every platform but Linux
  (`src/platform-gate.js`) and refuses to boot without a usable container CLI — Linux with rootless
  Podman is the only deployment target, so there is no "everywhere" left. **The daemon still runs
  everywhere; the containers do not.** A host with no container CLI boots exactly as before — the
  backend is imported dynamically, a failed probe is one legible log line plus a reason in
  `/api/health`, and the feature is simply off. The channel IMAGE and its helper scripts are
  Linux-only by design (the v0.8 decision drops the macOS DEPLOYMENT requirement for containers);
  macOS remains a supported development and daemon host on the `host` backend, which is unchanged.
  → TEST-PLAN: Container runtime (v0.8 P1).

## Performance
- Warm session pool: a thread's `claude` process stays alive (default 10 min idle) for fast
  follow-ups; relaunches on author/permission change. Shared catalog plugins contain immutable
  revision metadata without the generated `materializedAt` observation timestamp, so repeated
  materialization of identical skills keeps the same plugin path and warm process. Workspace skill
  manifests retain their real materialization times; content, revision, grant and permission changes
  still invalidate reuse. → TEST-PLAN: catalog plugin warm reuse.
- Claude runtime model attribution follows the primary assistant/provider stream, with the
  CLI's initialization model as a fallback. Both cold and warm runners preserve that identity
  ahead of terminal accounting that also includes auxiliary models: a short Opus reply cannot
  be relabeled Haiku because a title or child agent generated more tokens. Provider usage and
  total cost remain intact, and the footer continues to name the governing configured variant.
  → TEST-PLAN: primary model attribution.
- Clean mode (per channel / DM): run bare for the lowest token cost — no MCP servers injected
  (gateway control, Composio, Toolbox), no skills copied, no skills-favorites block, and no
  per-author tokens. The per-run `--mcp-config` is empty + `--strict-mcp-config` (so global servers
  are replaced by nothing) and the lockdown's `allowedMcpServers` is empty; Codex skips its gateway
  `-c mcp_servers.*` injection. Loads as close to the model's base prompt as the harness allows.
  → TEST-PLAN: Performance (clean mode).
- **`/clean` thread directive**: "@bot /clean <message>" applies clean-mode semantics to THIS thread
  only — plus no provenance line and no thread-context replay, so the model sees nothing but the
  user's message on top of Claude Code's own baseline (~27.5k input tokens measured; the CLI's
  hard floor). Sticky per thread (a session built bare must resume bare, mirroring the engine
  directive); `/clean off` reverts for the next message. Stored in
  `channels/<slug>/thread-clean.json`. → TEST-PLAN: Performance (clean mode).

## Administration
- Admin web UI + REST API: per-channel allowedUsers / allowedMcps / skills / adminMode.
- Admin web UI: per-user Composio token + admin flag.
- **Admin approvals API — an approval card no longer needs a chat client to resolve.**
  `GET /api/approvals` lists everything waiting on a human: permission prompts and control-plane
  sign-offs held open by their MCP call, durable `background_shell` requests that survive a restart,
  and busy-thread *Steer / Add to Queue / Cancel* cards — each with its conversation, requester,
  tool, a clipped command/plan preview (the same text the card already shows in the thread), its age
  and, for a card that times out, its expiry. Never a token or any other value.
  `POST /api/approvals/:id` with `{ decision: "approve" | "deny", scope?: "once" | "thread" |
  "forever" }` resolves one, and `POST /api/approvals/thread-choice/:id` with `{ choice: "steer" |
  "queue" | "cancel" }` resolves a busy-thread card. Both go through the SAME applier the buttons
  use — one function, not a re-implementation and not a faked chat payload — so the scope semantics
  (the per-thread allow-list, `meta.approvedTools` for *forever*), the durable compare-and-swap that
  stops an approved action from running twice, the release of the waiting MCP call, the requester
  binding and the card edit in the thread all behave exactly as a click does. Unknown or expired →
  404; already decided (by a click, an earlier call, or the state machine) → 409. The admin session
  IS the principal — the `/api/runs` API key never reaches these routes — so it satisfies an
  admin-tier request the way an admin's own click does, and every resolution writes an
  `approval_resolved_by_admin` audit event naming the principal (`admin UI`), the decision and the
  scope, never the command. The Overview page carries the same queue with Approve/Deny buttons and a
  scope picker. → TEST-PLAN: Modes & approvals.
- Reveal-able token fields: every gateway token input (Slack bot/app/signing, org-default
  Composio/Skills/Toolbox, per-channel and per-user tokens) shows its stored value masked (first
  few + last 4 chars) with an eye toggle (inline SVG) to reveal the full token. Token values are
  returned only to the authenticated admin session; on save a token is overwritten only when a new
  one is actually typed (an untouched masked field keeps the stored value). → TEST-PLAN: Admin UI.
- **One masker per record shape, and no dead field survives it.** Every channel read — the channel
  listing, the DM listing and a save's own echo — masks through the single `maskChannelMeta()`;
  the user listing is built field by field from an explicit allowlist and never spreads a stored
  record. That matters because a channel meta IS spread: a field belonging to a RETIRED integration
  is read by nothing, so it is masked by nothing, and it rides out in cleartext beside the fields
  that are masked (which is what `skillsToken` did until 2026-09-06). Retired fields are therefore
  listed in `src/config/dead-fields.js`, stripped from every record on the way into the store and
  on the legacy JSON import, and deleted from the rows that already carry one by schema migration
  20 — so the value stops existing rather than merely stopping being displayed.
  → TEST-PLAN: Admin UI.
- Auto-recording of Slack users (display name resolved) for the access picker.
- **MIF-branded design system** (2026-07 redesign): #makeitfuture. wordmark, self-hosted Poppins
  (`public/fonts/`, no CDN — works offline), orange `#fe3a02` + dark-teal token palette, inline-SVG
  icon set (no emoji chrome), branded login page. Orange is budgeted: primary actions, active nav,
  focus states. Capability level has a fixed color code (read/worker/auto/full/lean) used
  identically in list dots, header pills, and the capability picker. → TEST-PLAN: Admin UI (redesign).
- UI layout: a left sidebar with **Overview / Conversations / Users / Automations / Activity /
  Settings**. Every sidebar page has a stable route (`/overview`, `/conversations`, `/users`,
  `/automations`, `/activity`, `/api-docs`, `/settings`), so refresh and browser back/forward keep
  the selected page; the sidebar uses real links while same-tab navigation stays instant.
  Every selected conversation is deep-linked too (`/conversations/channel/<id>`,
  `/conversations/dm/<id>`, `/conversations/group/<id>`): refreshing restores the same detail,
  browser Back/Forward restores selection, and rows remain real links for new-tab use.
  Conversations is master-detail: ONE searchable list (segmented All/Channels/DMs
  filter) grouping **org templates + channels + DMs**, each row with a capability color dot and a
  fail-soft 30-day cost badge; the detail pane is split into **Access / Tools / Runtime /
  Instructions / Memory** tabs. Access holds the capability radio-cards (Full access red-treated,
  admin-tagged; Custom reveals the raw flags), the two access dropdowns with live help, the network
  switch and the guest-user checklist; Tools holds filterable MCP/skills checklists with
  "N of M enabled" counts + channel tokens; Runtime holds engine/model/effort, working folder,
  memory/nudges/org-token toggles. Edits are saved by ONE sticky dirty-state save bar
  (Discard / Save changes) — Instructions & Memory are visibly file editors with their own Save.
  → TEST-PLAN: Admin UI (redesign).
- **Authoritative Admin save reconciliation**: successful channel saves merge the complete
  validated `meta` returned by the PUT into the cached conversation model, so Codex app families,
  Claude MCPs, skills, flags, and token display state survive immediate SPA re-renders. Successful
  global Settings saves repaint from that PUT's complete settings representation—including a
  literal `showMessageCost:false`—instead of discarding it and issuing a second read.
  → TEST-PLAN: Admin UI.
- **Searchable, human-readable automation manager**: Automations filters live by conversation or
  person, title, prompt, friendly timing, or raw cron. DM groups resolve to the person's display
  name instead of exposing `dm-U…`, and common schedules lead with Daily / Weekdays / Weekly /
  Monthly / Hourly wording rather than cron syntax. Clicking a row opens a large, accessible editor
  for title, enabled state, guided common timing or advanced cron, one-time date, notification,
  delivery, and the complete prompt. One validated PUT saves the draft atomically; failures keep it
  visible without partially changing the record. Task delivery supports a direct channel result,
  a fresh thread per run, or one shared thread per day.
  → TEST-PLAN: Admin UI (redesign).
- **Overview** (was Dashboard): 7 KPIs (Token Est Cost — orange hero, separate Claude and Codex
  costs, runs + average value, users, live active sessions, tokens in/out) plus an All / Claude /
  Codex harness selector that re-scopes every KPI and chart. Active sessions opens a live modal with conversation, author, elapsed
  time, and the effective engine/model; DM conversations use the person's display name rather than
  their internal `dm-U…` slug. An authenticated event stream pushes complete active-run snapshots
  on start, runtime resolution/fallback, finish, and restart recovery; reconnects reconcile from
  SQLite, and elapsed times tick while the modal is open. The remaining dashboard includes
  an orange hero value chart with gridlines and dated peak, runs/tokens sparklines, top-users and
  channel runs+value bars (DM slugs resolved to people's names). **Activity** (was Audit): a
  one-line all-time totals strip + a real runs table with combinable text/channel/user/engine
  filters and 50-row "Show more" pagination over a cached 1000-row fetch, followed by an
  **Admin & security events** table over `GET /api/audit/events` — time, event, conversation, who,
  and what changed (a channel policy change renders as `key: before → after`). It opens on the
  admin/security kinds with a toggle for the whole feed and 25-row pagination; an unrecognized kind
  still renders, under its raw name with the underscores opened up, so a newly added event is
  readable the day it ships. → TEST-PLAN: Admin UI (redesign).
- **Overview KPI drill-downs**: value/runs/tokens jump to the **Activity** run history; live active
  sessions opens its modal (hover lift + orange edge, keyboard-focusable role="button"). Active users
  remains a plain read-only tile. On Activity, **clicking a run row opens a Session-detail modal**
  (reuses the `.modal` styles; Esc / backdrop / ✕ closes) showing that run's full ledger record —
  time, conversation (+slug), author (+id), engine · model, task kind, tokens in/out/total,
  provider-reported cost / estimated Standard API-equivalent value, and duration. Client-only.
  → TEST-PLAN: Admin UI (redesign).
- **Users** is a table (Name / Slack ID / role chips / enabled personal Skills count / C·T token state) with a
  wider right-side edit drawer (up to 640px; stacked above the table on narrower screens). It edits
  display name, Approved/Admin, personal grants and the two token fields with per-user Save
  (unchanged PUT semantics); "+ Add user" reveals the add form. A debounced search calls
  `GET /api/users?q=…` and matches case/accent-insensitively across name, Slack ID, visible role,
  and configured Composio/Toolbox token status. The browser keeps its full user directory separate
  from the server-filtered table so conversation access editors never inherit a search subset;
  out-of-order responses are ignored and filtering out the selected row closes its drawer.
  Skills counts match saved personal grants, including unavailable saved skills, and refresh after Save.
  → TEST-PLAN: Admin UI (redesign).
- Channel **Instructions** sub-tab: edit the channel's `CLAUDE.md` from the admin UI. Stored as a
  per-channel instruction override (`meta.instructions`) that the folder provisioner regenerates
  `CLAUDE.md`/`AGENTS.md` from each run — so it survives re-provisioning (a raw file edit wouldn't).
  Blank inherits the global default (Settings → Behavior). (Slack operating guidance is no longer
  appended here — it lives in the always-injected `gateway-usage` skill.) A custom-working-folder
  channel keeps its own project files (override is
  a no-op there, flagged in the UI). Saved with its own button via `GET`/`PUT
  /api/channels/:id/instructions`. → TEST-PLAN: Admin UI.
- Channel **Memory** sub-tab: view and edit the channel's folder-scoped `MEMORY.md` directly from the
  admin UI (lazy-loaded on first open, saved with its own button via `GET`/`PUT
  /api/channels/:id/memory`). Warns when folder memory is toggled off for the channel. → TEST-PLAN: Admin UI.
- Settings is **ONE long page** — every section stacked in reading order and always in the DOM,
  with a **sticky top bar** carrying only search and a **sticky left rail** carrying the section
  names as **jump links**
  (`/settings#set-<section>`, deep-linkable and restored on refresh/Back). The links scroll rather
  than swap panes, and a **scroll-spy** marks the section you are actually reading; a jump lands
  clear of the sticky bar (the offset is measured from the pinned bar, never assumed) and defers
  the spy until the smooth scroll settles, while any real scroll input takes the mark back.
  Sections: **Connection** (Slack bot tokens + status + the daemon's public URL), **Agent
  defaults** (enabled harnesses, engine, cross-engine failover, keepalive, context window, progress
  view, mention reactions, instructions, memory, schedule limits, nudges, codex rate),
  **Access Templates**, **Integrations** (Composio/Skills/Toolbox URLs + org-default tokens),
  **License**, **Access & security** (default channel access, trusted bot apps + network domains as
  chip editors), **System** (admin password, run-API token, Reconnect Slack, and a red **danger
  zone**: reset all channels' access, remove password, restart daemon, disconnect Slack).
  **Live search** (`/` or ⌘/Ctrl-K to focus, Esc to clear) filters every card as you type: terms are
  AND-ed, case- and typography-insensitive (curly quotes/dashes fold), a card is matched together
  with its section's title and description (so "connection" surfaces that whole section), empty
  sections recede in the left rail, the view lands on the first surviving section, and a query nothing
  matches says so with a one-click Clear. Cards are HIDDEN, never unmounted, so the single Save
  still persists every section — and the index is rebuilt per keystroke from `textContent` only, so
  asynchronously-loaded cards are searchable and no token value can enter it. Typing in the search
  box never marks settings dirty. Matching rules live in `public/admin-settings-search.js` (pure,
  DOM-free, unit-tested). ONE sticky save bar with dirty tracking ("Unsaved changes" → "All changes
  saved") persists everything; Slack reconnects only when a Slack token actually changed.
  Destructive actions use branded in-app confirm dialogs (danger-tinted confirm, Escape cancels)
  instead of native `confirm()`/`alert()`. Cross-page pointers (API docs → run-API token) scroll to
  the exact control and pulse it. → TEST-PLAN: Admin UI (redesign).
- A reusable **new-channel template** is copied into a channel's metadata only when the bot first
  registers it. It defaults to Autonomous mode with approved-domain network egress; edits affect
  future joins without silently changing existing channels.
- DM management with reusable **org templates** (User / Admin): edit a template's config (skills, MCPs,
  modes, model, effort) once and apply it to any DM, or give a DM its own custom config. A runtime
  pick made IN a template DM (the `/model` wizard) overrides the template's engine/model/effort for
  that DM (empty = inherit; the template's model/effort don't carry over across a harness flip).
- Working folders: each channel runs in a visible **`~/ChannelGate/<platform>/<slug>`** (metadata/settings stay in
  the hidden `~/.channelgate/channels/<platform>/<slug>`). The `<platform>` component — `slack`,
  `teams`, `google-chat` — comes from the platform registry's `folderName` fact and from the
  channel's own record, so adding a chat surface adds a folder without a `platform === "slack"`
  branch, and an unknown/missing platform fails closed to Slack. A per-channel **custom working folder** (any
  absolute path, validated) can be set via the admin UI folder picker or the `set_channel_workdir` MCP
  tool; an existing project's `CLAUDE.md`/`AGENTS.md` is respected and only the missing symlink is
  added and never namespaced. → TEST-PLAN: Working folders; ChannelGate rename.
- Per-channel agent instructions: the channel's `CLAUDE.md` (canonical, `AGENTS.md` symlinked so
  Codex reads the same file) IS the channel's own standing instructions — persistent, never
  regenerated. The gateway contributes one managed block on top (`<!-- GATEWAY-INSTRUCTIONS -->`:
  this conversation's switches, the gateway's **hard rules**, and the admin's global instructions —
  the rest of the operating manual lives in the `gateway-usage` skill, not this block), refreshed
  in place only when its content
  changes and self-repairing if a marker is damaged; everything below the end marker is
  user/agent-owned forever. The **hard rules** are the handful a run must never get wrong — the two
  Composio identities and the "ask, don't guess" stop when a request names neither; that a request
  phrased for the requester's own accounts ("my inbox", their own name) is served ONLY by
  `composio-user` and, when that identity is absent or lacks the app, is answered by saying so
  rather than by reading the shared identity that holds other people's accounts (and the mirror:
  "your X" never touches `composio-user`); that `COMPOSIO_MANAGE_CONNECTIONS` initiates connections
  rather than listing them; and that only the gateway's `run_in_background` /
  `run_agent_in_background` / `create_schedule` can report back after a turn ends — stated here
  because a skill body is read only when the model opens it, and one engine reliably did not
  (retest, 2026-09-06). They ride clean mode too, are engine-neutral,
  and stay under 4 KB with the switches so the always-on prompt weight is read rather than skimmed. Editable three ways: the admin UI Instructions tab (edits the real
  file; managed block shown read-only with a Settings link; hash-guarded against concurrent
  writes), by hand, or by asking the agent — the `update_channel_instructions` gateway MCP tool
  appends a rule in any mode (replace = admin-only). New sessions and `/clear` pick the file up
  natively on both engines. Custom (real-project) folders are never block-managed; legacy
  generated files migrate once (boilerplate collapses into the block, real channel text is kept);
  legacy AGENTS.md-first folders still migrate to CLAUDE.md-first automatically; the global
  Settings toggle (`agentsFile`) still governs the whole feature. → TEST-PLAN: Admin UI.
- Optional admin **password login** for the UI/API (httpOnly session cookie); set, change, or remove it
  from Settings → System (or `ADMIN_PASSWORD`). `/api/health` and the login routes stay open.
- Daemon controls (Settings → System): **Restart daemon** (polls health, reloads) and Slack
  disconnect/reconnect. The old "Stop daemon" button was removed as a footgun.
- **Transactional self-update**: Slack `/update`, the `update_gateway` gateway tool, the Admin UI,
  and `npm run update` all reserve one stale-safe global transaction. A second caller gets the
  active transaction instead of starting an overlapping updater. Before touching Git, the runner
  checks the attached/clean/fast-forward checkout and upstream access, Node/npm, parseable
  settings, an active systemd service (the launchd probe retired 2026-09-03 — Linux only),
  available disk, current daemon health, and a real isolated Claude turn. Missing Whisper assets
  add 2 GiB of required staging space to the 1 GiB base requirement (the extra macOS build staging
  retired 2026-09-03 — Linux only); the 1.5 GiB optional model is never downloaded silently when
  local Whisper is disabled.
- **Mode-aware MCP update authorization**: `update_gateway` remains admin-only. Its additional
  control-plane approval card is skipped in Auto/Admin channels and retained in Read/Worker
  channels; Claude and Codex share the same gateway MCP policy.
- **Candidate validation and automatic rollback**: the updater snapshots the exact revision,
  lockfile, local config, `.env`, and a consistent SQLite copy under mode-0700
  `~/.channelgate/update-backups/<transaction>/`; fast-forwards, runs exact `npm ci`, the
  production advisory gate, all tests, and optional provisioning; then restarts through the exact
  systemd `MainPID` (the launchd restart retired 2026-09-03 — Linux only). Success requires a new
  daemon instance on the expected revision,
  container runtime availability, Slack reconnect when it was previously connected, and another real
  container smoke for every engine that passed baseline. A post-checkout failure resets the old revision, reinstalls its lockfile, restarts,
  and proves the restored build with the same checks. Runtime snapshots are operator recovery
  material and are never auto-restored, so writes made while a candidate briefly ran are not
  discarded.
- **The update rebuilds the channel image**: with the container runtime on, the updater runs
  `scripts/build-image.mjs` itself — after dependencies, before the restart — whenever the candidate
  changed anything under `containers/`, moved `imageSpecVersion`, or no image is built at all
  (`needsImageBuild()` in `src/runtimes/container/image.js`; built version from the image's
  `cg.image.version` label, expected version from the CANDIDATE's `containers/versions.json`, never
  a constant the runner imported before the checkout moved). It is the one step that never blocks:
  a failed build reports `run \`npm run build:image\`` and the update continues to the restart,
  because the image already on disk still runs every container channel. Failed builds remain visible
  and digest drift triggers a retry even when the checkout revision is unchanged. → TEST-PLAN: Container runtime (v0.8 P1).
- **Truthful update status and final reporting**: atomic, non-secret phase/result state lives in
  `~/.channelgate/update-state.json`; logs live in `logs/update.log`; `/api/health` exposes the
  boot-captured serving revision plus the sanitized transaction. The dashboard follows the exact
  transaction across candidate and rollback restarts and renders `updated`, `rolled_back`,
  `refused`, or `failed`. Slack/MCP thread markers are transaction-bound and survive intermediate
  boots; only the matching terminal result is posted, with a deterministic Slack message id, then
  the marker is removed. → TEST-PLAN: Transactional self-update.
- **npm advisory policy**: candidate production dependencies are audited after `npm ci`.
  Critical/high findings block and roll back the update; moderate findings are reported and
  reviewed in the same development cycle. Weekly Dependabot discovery, exception policy, and the
  current reviewed transitive exception live in `SECURITY.md`.
- Settings page: set Slack tokens (write-only/masked) + keepalive + Composio URL from the UI,
  stored in `config/settings.json` (overrides `.env`); Slack connects/reconnects live with a
  status banner — no process restart. A bad token reports the error without crashing the daemon.
- **Settings save the CHANGE, not the page.** The one *Save changes* button sends only the fields
  that differ from what the page was painted from, and the server merges them — so a value written
  after this page loaded (another admin, the skills sync, a license write, the first-boot password
  upgrade) is not in the request and cannot be reverted by an unrelated save. `GET /api/settings`
  carries a `settingsVersion` the save echoes back: if anything wrote settings in between, the save
  is refused with `409` and NOTHING is written (the check runs inside the same lock as the merge),
  and the refusal carries the current settings — the page repaints from them and names the keys
  that moved, so the admin re-applies their change on top of the newer state. Sending no version is
  accepted and merged, so an older UI or a script keeps working. A repaint clears anything left
  pending (an armed *clear* toggle, a typed password or key), because a pending action captured as
  "already saved" would silently never run. → TEST-PLAN: Admin UI.
- **Google Drive two-way sync (scheduled)**: a per-channel Drive folder link (channel settings)
  is bisync'd on a timer into a dedicated `Drive/` subfolder of that channel's working folder —
  never the folder root, so the confinement scaffolding (`.claude/`, `CLAUDE.md`, `MEMORY.md`,
  `memory/`, `uploads/`) is never synced or overwritten. Auth is a Workspace service account
  (+ optional domain-wide-delegation subject), passed to `rclone bisync` via flags — no interactive
  `rclone config`, no per-user OAuth, no secret in the child env. The key is entered by **pasting
  the service-account JSON** into the settings page: stored write-only (validated as a real SA key,
  never echoed back — only `hasKey` + the parsed `client_email` are shown so the admin knows which
  address to share folders with), and materialized by the engine to a `chmod 600` file in the
  runtime config dir (outside every sandbox) so rclone gets a file path, not the raw key. An
  on-host key-file path is kept as an advanced fallback. Global settings (Settings → Google Drive
  sync): master enable, pasted key / key-file path, impersonate subject, interval, conflict policy,
  rclone binary path (absolute path sidesteps the service unit's minimal PATH). Dormant unless enabled + a
  key exists + rclone is installed. A per-channel **Test** button verifies the service account can
  see the folder before the first sync (`rclone lsf`). The update flow (`scripts/update.sh`, shared
  by the CLI / `/update` / admin button) auto-installs rclone when Drive sync is enabled and it's
  missing — the official installer (the Homebrew branch retired 2026-09-03 — Linux only) — gated on
  the setting, best-effort, and never aborting the update. The per-channel folder link can also be
  wired up **by asking the agent**
  (not only the admin UI): gateway control MCP tools `get_channel_drive_folder` (anyone — shows the
  link + whether sync is globally armed), `set_channel_drive_folder` (admins — validates/parses the
  link, saves it, runs the same read-only connection test, and reports the SA `client_email` to share
  the folder with), and `clear_channel_drive_folder` (admins — unlink/turn off). `src/gateway/drivesync.js`,
  `src/mcp/gateway-server.js`. → TEST-PLAN: Google Drive sync.

## Skills platform (Core) — the local skill catalog

- **The gateway owns skill content.** A SQLite **catalog** (migration 14: `skills`,
  `skill_revisions`, `skill_revision_files`, `skill_sources`, `skill_templates`, `skill_usage`,
  `skill_proposals`) holds every skill a conversation can be granted as immutable, content-hashed
  **revisions** of the exact bytes of every file — `SKILL.md` included, binaries base64-round-
  tripped, 2 MB/file and 400 files/skill caps, traversal/absolute/reserved paths refused at the
  boundary (`src/gateway/skills/files.js`). The parsed frontmatter columns (name, description,
  category, tags, version, `requires`) are a DERIVED index rebuilt from the activated revision
  (`frontmatter.js` — a YAML-subset reader that never rewrites), so an unmodelled key such as
  `allowed-tools` is never lost; a catalog read resolves them for the EFFECTIVE revision, so a skill
  pinned to an older one advertises that revision's text beside that revision's files. Ownership is explicit per slug (`bundled` / `folder` / `git` /
  `local`); a write from another owner is a reported **conflict**, never an overwrite. Removal is a
  **tombstone** (revisions kept, dependents readable, a returning source restores it); an admin's
  removal is a sticky **exclusion** (`excluded_at`) that no sync or import undoes until restored.
  → TEST-PLAN: Skills platform (Core).
- **Repository sections (`channel_scope`)**: the skills repository is one shared library plus
  `channels/<channel id>/<slug>/` per channel; a skill in a channel's section is in that channel's
  tier automatically (`channelSkillGrants` = template ∪ section ∪ own), derived from the synced
  path or the scope a local skill was created with. `create_skill` defaults to the library and
  takes `scope: "channel"` for customer-specific skills (the agent asks first); `set_skill_scope`,
  the admin *Section* control and `POST /api/skills/catalog/:slug/scope` move a skill either way —
  files move in the repository (`moveSkillFiles`), promotion leaves the channel an explicit grant.
  → TEST-PLAN: Skills platform (round two).
- **Channel profiles without tokens.** The existing organization → conversation → user grant union
  resolves against the catalog on every message (`resolve.js`): `requires:` dependencies load with
  the skill that requires them (resolved every message, never stored as grants of their own, so
  they stay attributed to their parent and leave with it), missing links, tombstones, staged
  (unapproved) skills, dependency cycles
  and near-duplicate trigger descriptions are reported, and the **always-on context** of the
  profile (each active skill's name + description) is estimated and flagged above a soft cap
  (`skillsContextWarnTokens`, default 6000). The materializer (`materialize.js`, wired into
  `enableSkills`) writes the effective revision as REAL files under `.claude/skills/<slug>/`
  (marker + `.gateway-skill.json` manifest, write-on-change, executables kept 0755), replaces a
  Skills Manager stub of the same name, archives unselected or displaced local copies, prunes stale
  managed copies, and falls back to the pre-catalog host-folder copy for a name the catalog does not know.
  Claude receives the tree through its plugin, Codex through the `.agents/skills` link — no stub,
  no mid-turn fetch, no token. → TEST-PLAN: Skills platform (Core).
- **Bundled + host-folder import at boot** (`import-folder.js`, `index.js`): the starter library in
  `src/gateway/skills/bundled/` (`skill-authoring`, `channelgate`, `headless-app-creator`) imports as `bundled`; the operator's
  `~/.claude/skills`, `~/.agents/skills` and `GATEWAY_SKILL_SOURCES` import as `folder`-owned
  skills under their directory names (symlinks followed, nested skills excluded), so every stored
  grant still resolves; a vanished folder tombstones its skill and a returning one restores it.
  → TEST-PLAN: Skills platform (Core).
- **GitHub sources** (`git-sync.js`, Skills Manager's tarball sync ported and hardened): one
  repository per source, following `main`, with an optional subfolder encoded in its
  `/tree/main/<path>` URL; head resolved via the commits API, the
  whole repository fetched as ONE tarball (own ustar/pax reader, no dependency), every `SKILL.md`
  directory a skill with its sibling files (a nested skill owns its own), lossless bytes,
  **review** mode (default) staging every new/changed revision for an admin vs **auto** mode,
  commit **pins**, enable/disable, per-source last-sync state + stats + error (never discarding
  last-good), removals tombstoned, conflicts reported. Runs at boot, on a settings interval
  (`skillsSyncIntervalMinutes`, default 60, 0 = off), from the admin UI and from chat
  (`sync_skill_sources`, admins). Each source carries its own optional write-only GitHub token for
  private repositories or API rate limits; it never
  enters a conversation folder or an MCP config. Folder sources import a host directory the same
  way. → TEST-PLAN: Skills platform (Core).
- **Templates as data, followed live** (`templates.js`): seeded **Development / Sales /
  Marketing / Management** (explicit skills + categories), edited under Settings → Access
  Templates → *Skill templates* with a catalog checklist, resolved live against the catalog
  (category match case-insensitive). A conversation is ASSIGNED a template (`meta.skillTemplate`;
  Conversations → Tools, the Skills view, `set_channel_skill_template`, or a DM template's own
  field): its channel tier is the template's current skills plus the skills added to the
  conversation (`meta.skills`), so a template edit reaches every follower and additions come on
  top; `none` stops following and keeps the additions. **Preview** shows gains / keeps / drops and
  the always-on context cost in labelled numbers — what this tier adds, what the organization tier
  costs in every conversation whatever the template says, and the effective union measured against
  the soft cap. (2026-09-05, replacing the earlier snapshot-copy apply.)
  → TEST-PLAN: Skills platform (Core).
- **Chat verbs** (`src/mcp/tools/skills.js`, in the lockdown allowlist and the control-plane
  approval map): `list_skills`, `show_channel_skills` (tiers, dependencies, missing/staged, context
  cost), `get_skill_file`, `list_skill_templates`, `preview_skill_template` (open);
  `add_channel_skills`, `remove_channel_skills`, `apply_skill_template` (managers, approval card —
  a grant answers with the conversation's resulting always-on cost and any warning it crossed, e.g.
  the context soft cap, so the person who caused it hears about it);
  `create_skill` (any approved member → a local skill granted in the conversation),
  `update_skill` (author / manager / admin, local skills only, partial files merge over the current
  revision), `propose_skill_change` (`change` with files, or `promote` organization-wide),
  `list_skill_proposals` / `decide_skill_proposal` (admins; an approved change on a source-owned
  skill becomes a **pinned local override** so the source keeps flowing and the pin holds until
  unpinned; an approved promotion adds the skill to the organization tier), `skill_usage_report`,
  `sync_skill_sources`. Documented for the model in `gateway-usage` → `references/skills.md`.
  → TEST-PLAN: Skills platform (Core).
- **Usage telemetry** (`usage.js`, on the run event stream in `run.js`): Claude's `Skill` tool call
  is an **exact** signal (the stream parser now names the skill as the tool target); a Codex/shell
  read of `…/skills/<slug>/SKILL.md` is **inferred** and labelled so; one row per run/skill/signal
  with skill, revision, conversation, user, engine, session, run and origin — never prompt text or
  content. A shell line that reads several skills at once records **every** one of them, through
  either skills directory, absolute or relative, quoted or `~`-relative (2026-09-06). Reports
  (chat + admin UI) list what fired, which granted skills **never** fired, and the notes that make
  the numbers readable (exact vs inferred, capture is not retroactive).
  → TEST-PLAN: Skills platform (Core).
- **Admin UI → Skills** (`public/admin-skills.js`, `src/web/routes/skills.js`): catalog (search,
  owner, source, category plus Enabled / Discoverable / Mandatory / Assigned state filters (Assigned means a direct
  organization, conversation, template, or channel-section grant), detail with
  files/frontmatter/revisions, pin/rollback, grant to a conversation,
  remove/restore, create a local skill), **Review** (staged source revisions and proposals with
  approve/reject), focused **Sources** (clickable source cards with sync status; each opens its own
  searchable skill list including disabled rows, with Enabled, organization-wide Discoverable and
  Mandatory switches; source credentials/mode/pin/removal are grouped in collapsible settings;
  Add source offers GitHub or another ChannelGate with kind-specific inputs), separate **Sync settings** (catalog timing,
  publishing, webhook) and **MCP** (endpoint + tokens),
  selection-first **Templates** with searchable skill/category controls and assignment preview,
  and searchable/alphabetic **Usage** with By skill / By channel rollups, compact comparison bars,
  detection provenance and explained context warnings instead of every profile's full skill dump.
  Catalog state filters are enforced in both the API and browser, so newly served static assets do
  not expose cosmetic controls while the long-running daemon is waiting to restart.
  → TEST-PLAN: Skills platform (Core).
- **Governed skill discovery and mandatory loading**: every catalog row can be disabled without
  disabling its source, approved for member/agent discovery, or made mandatory in every
  conversation. Mandatory implies enabled + discoverable; effective profiles remain mandatory ∪
  template ∪ channel ∪ personal ∪ dependencies. Catalog search includes source labels, category
  and source API filters; usage-led screens sort descending and Overview charts the top ten skills.
  Templates select explicit skills only. → TEST-PLAN: Skills platform (governance and usage).
- **Personal skills and self-service grants.** A skill created with `personal: true` (or switched in
  the admin UI) is visible and grantable only to its author (admins see everything) and is never
  published or exported; a `promote` proposal, once approved, makes it an organization skill.
  `add_my_skills` / `remove_my_skills` let any approved member carry catalog skills in their OWN
  runs (the user tier of the grant union — Skills Manager's "stars"), no card needed; `delete_skill`
  removes a skill you authored (tombstone). Proposals gain `kind: feedback` (a note without files).
  Admins get chat verbs for the organization tier (`add_org_skills` / `remove_org_skills`), the
  sources (`list_skill_sources`, `add_skill_source`, `set_skill_source`, `remove_skill_source`),
  exclusions (`set_skill_excluded`) and `get_skill_info`. → TEST-PLAN: Skills platform (round two).
- **Git publishing** (`src/gateway/skills/publish.js`): with a publish repository configured
  (Settings via the Skills view: repository, folder, mode, fixed `main`) and its own write-only GitHub token,
  every new revision of a local skill — create, update, approved change, promotion — is pushed
  through the GitHub Contents API (one commit per file under `<folder>/<slug>/`, dropped files
  deleted) and the revision records the commit. When the publish repository is also a git source,
  the published skill is ADOPTED by that source (owner git, same source), so the next sync sees its
  own files instead of a conflict — authored in chat, pushed to GitHub, part of the library.
  `publish_skill` (managers) and the admin UI push on demand; publishing is best effort and never
  blocks a turn. → TEST-PLAN: Skills platform (round two).
- **Webhook-triggered sync.** `POST /api/skills/webhook/github` (outside the admin session)
  verifies GitHub's `X-Hub-Signature-256` over the raw body against the write-only webhook secret,
  matches the pushed repository against the git sources, and schedules a debounced sync of each —
  seconds instead of the interval. `ping` events answer without syncing.
  → TEST-PLAN: Skills platform (round two).
- **The catalog's own MCP endpoint** (`POST /mcp/skills`, stateless Streamable HTTP,
  `src/web/skills-mcp.js`): any MCP client — laptop Claude Code, Codex, another gateway — uses the
  catalog with a bearer **access token** minted in the admin UI (`skill_access_tokens`: random,
  shown once, stored hashed, scoped `read` / `propose` / `manage` / `sync`, revocable, last-used
  tracked). Skills Manager's `library_*` surface is kept for the read/author subset
  (`library_search_skills` with facets + pagination, `library_get_skill_info`,
  `library_get_skill_file`, `library_list_templates`, `library_whoami`,
  `library_suggest_skill_change`, `library_create_skill`, `library_update_skill`) plus
  `library_export` / `library_export_skill` for peers. Personal skills never leave the gateway.
  → TEST-PLAN: Skills platform (round two).
- **Gateway-to-gateway sources** (`src/gateway/skills/peer-sync.js`): a source of kind `gateway`
  (a peer's URL + a token with the `sync` scope, stored write-only) pulls the peer's organization
  skills through that endpoint — staged in review mode, active in auto mode, tombstoned when the
  peer drops them, last-good kept on failure — so a second gateway (a follower gateway tracking a primary one) shares
  one library with nothing but a URL and a token. All source kinds (git / folder / gateway) sync
  through one dispatcher on the interval, from the UI and from chat.
  → TEST-PLAN: Skills platform (round two).
- **Compatibility declarations** (`compatibility:` in a skill's frontmatter: `engines`,
  `platforms`, `min_gateway`, `mcp`) are checked against the conversation's engine, platform,
  gateway version and MCP servers and reported as notes in `show_channel_skills` — advisory, never
  a refusal. → TEST-PLAN: Skills platform (round two).
- **Migration from Skills Manager** (`scripts/migrate-skills-manager.mjs`, idempotent, `--dry-run`):
  using the tokens the retired integration stored, every Skills Manager repository becomes a git
  source (auto mode) and is synced (the host's `gh auth token` is stored as the GitHub token when
  none is set); the organization token's effective favorites become the organization tier, a
  channel token's favorites that channel's grants, a user token's favorites that user's tier; with
  Skills Manager's Supabase service credentials, team favorites become templates (Development,
  Sales & Marketing → sales + marketing, Management, Admin), admin exclusions become tombstones,
  and each token user's personal skills become personal local skills.
  → TEST-PLAN: Skills platform (round two).

## Licensing (`src/ee/` — proprietary, source-visible)
- **Tiered license keys.** No key: 1 conversation per UTC month, 500 AI messages in it. Free key:
  every conversation, 500 AI messages per conversation per month. Enterprise key: unlimited.
  Limits are SERVER-defined and ride a signed payload, so the Licensor can change what a key is
  worth without shipping a release; the no-key floor is the only limit compiled in
  (`src/ee/tiers.js`). → TEST-PLAN: Licensing.
- **Key storage** in Settings (`licenseKey`), with `CHANNELGATE_LICENSE_KEY` as the bootstrap
  source. Listings return `hasLicenseKey` + `licenseKeyLast4` only; the value is fetched one at a
  time through the existing `POST /api/secrets/reveal` allowlist, behind a fresh admin password.
- **Verification** against `POST {platform}/v1/license/verify` at boot and every 24 h, with the
  response's Ed25519 signature verified locally against the key in
  `src/ee/license-public-key.js`. The compiled trust root matches the production platform at
  `https://channelgate.dev`; `CHANNELGATE_LICENSE_PUBLIC_KEY` overrides it for staging or a
  coordinated rotation. The
  boot path never awaits it — Slack connects while the check is in flight and the run gate reads
  the cached state, so a slow or dead platform costs the daemon nothing.
- **State machine** `no_key · valid · invalid · revoked · expired · grace · expired_grace`, all of
  them healthy daemon states. Unreachable keeps the last verified tier for 14 days (`grace`); past
  that the tier is STILL kept until the next UTC month boundary and only then falls back to the
  no-key limits — never mid-month, never silently. `invalid`/`revoked` drop immediately. So does
  `expired`: a licence that passed its own `expiresAt` ran out on its own terms — that is not a
  deployment that lost contact, and the date was known in advance — so it is resolved BEFORE the
  unreachable lane, grants the no-key limits, and reports no tier. That ordering is what makes the
  air-gapped promise true: an offline payload is stamped as verified at read time, so an expired one
  routed through grace would have looked freshly checked forever. A response whose signature does
  not verify changes nothing in either direction. An in-process event fires on every state change.
- **Two enforcement points**, both in `licenseAdmission()` (`src/ee/limits.js`), called from the
  run orchestrator before a turn provisions a folder, mints a session, or spawns an engine:
  conversation admission (the month's first N distinct conversations are the allowed set,
  persisted in `license_usage`) and the per-conversation monthly cap, counted AT SPAWN for every
  origin except memory-review runs, with a one-time 80 % warning prefixed to the answer the user
  is already getting. A refused turn returns a short, platform-degraded reply carrying the sign-up
  link — never an exception, never silence, and no run starts.
- **Admin License card** (Settings → License): state banner, tier, key last four, last and next
  verification, expiry, installation id, platform URL, *Verify now*, key set/clear via the shared
  reveal control, and this month's per-conversation usage bars against the limit line.
- **Gateway MCP tools**: `get_license_status` (any allowed user; never shows the key) and
  `set_license_key` / `clear_license_key` (admins only, behind the control-plane approval click,
  and the key value is never echoed — not even into the approval card).
- **Exactly two outbound payloads**, and nothing else: the verify request (key, installation id,
  version) and the daily/at-shutdown usage report (installation id, key **hash**, version, UTC
  month, per-conversation **hashes** + counts). Never message content, user ids, channel names, or
  credentials. The installation id is a random UUID, not derived from the host.
- **Air-gapped mode**: `CHANNELGATE_LICENSE_PAYLOAD` carries a signed license verified locally
  against the same public key; such an install makes no outbound request at all.

## Storage
- All operational data in one SQLite database (`~/.channelgate/gateway.db`, built-in
  `node:sqlite`, WAL): users, channels, per-channel meta, sessions, schedules, acks, followups,
  background jobs, in-flight interactive runs (`active_runs`, for restart recovery), the usage ledger,
  and the event log. Config that stays as JSON: `settings.json`,
  `mcp-catalog.json`, and each channel's `.claude/settings.json` lockdown file.
- Versioned, auto-applied schema migrations (`PRAGMA user_version`) — updating a machine and
  restarting brings its schema up to date with no manual step; no native build (portable to any
  Node 24+ host). One-time import of the pre-SQLite JSON/JSONL on first boot (old files kept as
  inert backups). Daemon + MCP-server processes share the DB safely via SQLite locking.
- **The legacy import reads the legacy layout.** The pre-SQLite tree keeps a channel's files at
  `channels/<slug>/{meta,sessions}.json` — it predates both SQLite and the per-platform channel
  folders — so the import spells that path out rather than going through the path helpers, which
  moved with the folder rename and now resolve to `channels/<platform>/<slug>/`. It has to: the
  boot migration reads its channel records from the store, which opens the database and runs this
  import, before it moves a single folder. The current layout is accepted as a fallback for a
  half-migrated tree, a platform folder is never mistaken for a slug, and both the one-time flag
  and the untouched source files are unchanged. → TEST-PLAN: Storage / SQLite (Slice 9).

## Observability
- Live streaming feedback in Slack + a width-conscious stats footer per reply:
  `Opus 4.8 1M · 14.4s · 34.8k/214 · $0.15 · 17%` (model · duration · tokens in/out compacted ·
  cost at 2 decimals · context% against the MODEL's own window — 1M variants use 1,000,000
  (read from the CONFIGURED model as well as the runtime one, and ahead of any runtime-reported
  window: the CLI does not echo the suffix back, reporting an `opus[1m]` run as plain
  `claude-opus-5` with the family's standard 200k, which measured a 1M run against a window five
  times too small),
  other Claude models 200k, Codex prefers the rollout's runtime-reported usable window (with the
  engine declaration as fallback), unknown models fall back to Settings →
  contextWindow; no icons/unit labels). The 💻 Resume button sits on the same row (section
  accessory). Model = the configured cascade that governed the turn (thread override → channel/DM
  model → gateway default) → CLI-reported runtime model (when nothing is configured) → engine name;
  context% and Codex cost rates still key on the CLI-reported runtime model, where multi-model
  Claude `modelUsage` maps use the model with dominant output tokens, and a reported
  `contextWindow` for that model overrides id-pattern guessing.
- Tool and plan history remains available in Slack's expandable native toolbox card; completed
  replies do not repeat its step count and elapsed time in a separate text recap line.
- **Global footer-cost visibility** (Settings → Behavior → Slack replies): administrators can hide
  exact/estimated dollar cost from every Slack run footer while keeping model, duration, tokens,
  and context percentage. Existing installs default on; the setting affects subsequent replies
  immediately, and the Admin form adopts the boolean returned by the successful write without a
  follow-up read. Usage accounting, Overview, Activity, conversation cost badges, and API results
  always retain cost independently of this display preference. → TEST-PLAN: Observability.
- Structured event log in the `events` table (no secrets), queryable by day/channel/user.
- **Channel policy audit (`channel_meta_changed`).** A conversation's meta record IS its security
  posture, so every successful change to it writes one event naming the conversation, the principal
  and the POLICY keys that actually moved, with before/after values. Every surface that can change
  it goes through the same diff helper (`src/config/channel-audit.js` → `policyDiff`): the admin
  API's channel and DM saves (actor `admin-ui` — the UI authenticates one shared password, so there
  is no personal identity to attribute), the gateway control MCP tools (`set_channel_admin_mode`,
  `set_channel_network`, `set_channel_bash`, `set_channel_auto_mode`, `set_channel_workdir` /
  `clear_channel_workdir`, `set_channel_drive_folder` / `clear_channel_drive_folder`,
  `add_channel_mcps` / `remove_channel_mcps`), the typed `/mode` command and the `/model` runtime
  picker (actor = the chat author's own id, also in the event's author column). The allowlist is
  curated — profile, the four capability flags, cleanMode, noDefaultTokens, engine/model/effort,
  runtime, workDir, the Drive sync link, access/manageAccess/managers/allowedUsers, the two MCP
  allowlists, the DM template, the skill template, and skills as a COUNT — so a token, a per-channel
  environment value or any other field can never reach an audit row. Only keys that changed are
  recorded, a save that moves no policy key writes nothing at all, list keys are compared by sorted
  name (a reorder is not a change), and one row's payload is bounded (over ~8 KB, list values
  collapse to counts). Chat-side skill grants write the same `skill_granted` / `skill_revoked` /
  `skill_template_assigned` rows the admin UI does. → TEST-PLAN: Observability.
- **Refused secret reveals are audited (`secret_reveal_rejected`).** `POST /api/secrets/reveal`
  answers 400 for any field off the reveal allowlist; it now logs the attempt — scope, field and id
  NAMES (clipped, never a value) plus the admin principal — BEFORE returning, so an enumeration
  sweep with a borrowed session leaves a trail instead of nothing. A wrong password still logs
  `secret_reveal_denied` and a granted reveal still logs `secret_revealed`, neither with the value —
  and all three now carry the admin principal (`admin-ui`) instead of an empty author, so no row
  reads as unattributed. → TEST-PLAN: Observability.
- Usage accounting preserves one immutable run/raw-evidence row in `usage` across interactive,
  scheduled, and background work. Canonical Codex root and native-child deltas live in
  `usage_components`, with per-request cache/context/model evidence in `usage_requests`; child
  components add tokens/value without pretending to be Slack runs. Dashboard and Activity use the
  canonical components when present and leave rotated/unverifiable rows explicitly legacy. A
  dry-run-first `npm run usage:repair` backfills surviving rollouts; `--apply` freezes its usage-id
  cutoff, makes a consistent SQLite backup, and applies an idempotent repair batch. The daemon
  also runs the same repair automatically at boot whenever un-repaired legacy codex rows exist
  beyond the last batch's cutoff (backup first; a batch is recorded even on zero matches so settled
  history is never rescanned) — updating + restarting another gateway recalculates its history with
  no manual command.
- **Per-model Codex Standard API-equivalent rates** (Settings → Behavior): Codex reports no dollar
  cost, so the ledger and reply footer estimate attribution value from an editable $/1M table —
  input / cached-input / output per model (gpt-5.6-sol / gpt-5.6 alias / gpt-5.6-terra /
  gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.3-codex; defaults =
  OpenAI's Standard pricing verified 2026-08-16). Cached reads are a subset of input and never
  double-counted; cache writes use 1.25× input, and eligible requests above 272K input use 2×
  input/cache plus 1.5× output. The threshold is evaluated per request, never against a turn
  aggregate. Official aliases/snapshots match on model boundaries; an unresolved CLI model remains
  unpriced instead of being guessed. Retired full-table Terra/Luna defaults migrate to current rates
  while genuine admin overrides survive. Claude runs are never priced with OpenAI rates. Legacy
  blended rate remains a hidden last-resort fallback for explicitly unknown models.
  → TEST-PLAN: Observability.
- Audit admin tab: monthly totals, per-channel rollups, and a recent-runs feed over the ledger +
  event log (`GET /api/audit`, `GET /api/audit/events`). No spend cap — visibility only.
- Dropped-write counters: best-effort persists (usage ledger, event log, bg jobs) count their
  failures (`src/util/drops.js`, rate-limited warn) and surface on `/api/health` as
  `droppedWrites` — silent ledger divergence under DB contention is now observable.
- **Automated tests**: `npm test` runs the node:test unit suites in `test/` (format escaping/
  chunking, run queue, TTL dedupe, child-env allowlist, path containment, login backoff, slugify,
  cron catch-up, followups store, semaphore, pool eviction — 100+ tests). CI-ready.
- **Fail-closed boundary hardening**: API file downloads revalidate DNS/SSRF policy on every
  redirect, CONNECT only to the exact addresses that passed the check (no second DNS resolution —
  the rebinding TOCTOU is closed), drop Authorization/Cookie headers when a redirect changes
  origin, and stop streaming at 25 MB; completion webhooks take the same pinned path.
  Bot-owned Slack List reads/writes require Slack `files.info` to show the List shared in the
  current channel. SQLite enforces globally unique channel slugs, allocated under a write
  transaction (with a v8 duplicate repair). Revoked managed skills remove only marker-owned
  gateway copies, never project skills or symlinks. Runtime-secret chmod/cleanup failures and a
  failed first-boot password write abort startup instead of opening the daemon insecurely. The
  first-boot password is minted whenever no OPERATOR key is in `settings.json` — the installer's
  own pre-boot `whisperEnabled` answer does not count, so `npm run setup` never skips it.
  → TEST-PLAN: A7 boundary hardening.
- Dashboard admin tab (default landing view): usage overview for a selectable **date range** and
  **harness** (All by default, Claude, or Codex) —
  Today, Last 7 days, Last 30 days, This month, Last month, This year, Last year
  (`GET /api/dashboard?range=…&harness=…`, SQL rollups). The bucket granularity adapts to the range: **hour**
  for a single day, **day** for weeks/months, **month** for years — series gap-filled so charts stay
  stable. KPI tiles (Token Est Cost, separate Claude and Codex costs, sessions, active users,
  active sessions, and total tokens), per-bucket sparklines for sessions/tokens/cost, a sessions-per-user bar list
  (descending), and a per-channel sessions+cost bar chart. Pure inline SVG + div bars — no chart
  library, no build step. → TEST-PLAN: Admin UI.
- Money display: smart currency formatter — whole dollars at $100+ (no "$359.3113" on totals),
  2 decimals for normal amounts, 4 for sub-dollar per-run costs.
- App Home tab: an orientation dashboard (your access level, connections, favourite skills, channels
  the bot works in, admin-UI link); never shows secrets.
- App Home → "Connect my Composio key": a user attaches (or replaces/disconnects) their PERSONAL
  Composio key from a private modal instead of pasting it into a Slack message — the value never
  enters Slack history or search, is never rendered back into the view, and the Home connection
  lines re-render on save. Hidden in Composio SDK mode, where the identity is minted per user at run
  time. → TEST-PLAN: MCP injection & tokens.
- `GET /api/health` reports claude availability, gateway root, and warm-session count to a session
  (or the same-machine internal secret the self-updater uses). Any caller — an operator's watchdog
  with no session — additionally gets the Slack CONNECTION STATE (`{status, connected}`: connected |
  connecting | disconnected | error) so a liveness probe can tell a healthy daemon from a wedged one
  without being handed the workspace/bot identity or the connect error text.
- Graceful shutdown disconnects Slack, performs a bounded active-run drain, then terminates every
  warm and cold process group on SIGINT/SIGTERM; a deadline path reports the forced recovery case.
- Scope self-check on boot: compares the installed app's live bot scopes (Slack's `x-oauth-scopes`
  header) against `slack-app-manifest.json` and, when a scope is missing, logs it and DMs admins the
  exact "add these + reinstall" list — once per change in the gap, so an upgrade that needs a new
  scope is self-announcing. → TEST-PLAN: Scope self-check.
## Phase F operational readiness

- **Renamed to ChannelGate** (formerly *Claude Gateway for Slack*): display name, npm package
  (`channelgate`), Slack app manifest, the launchd label (retired 2026-09-03 — Linux only), systemd
  unit `channelgate.service`, and the bundled lockdown skill `src/gateway/skills/bundled/channelgate`. The
  installer removes the pre-rename service before installing the new one, and self-update still
  finds a host running under the old unit. → TEST-PLAN: ChannelGate rename.
- **Renamed runtime + workspace roots**: `~/.channelgate/` (env `CHANNELGATE_DIR`,
  `CHANNELGATE_DB`; the pre-rename `CLAUDE_GATEWAY_DIR`/`CLAUDE_GATEWAY_DB` still work for one
  major behind a single deprecation warning) and `~/ChannelGate/<platform>/<slug>/` (env
  `CG_WORKSPACE_DIR` unchanged). Per-channel metadata and clean-mode workspaces are namespaced by
  platform the same way; a custom per-channel `workDir` is untouched. → TEST-PLAN: ChannelGate rename.
- **Boot migration `scripts/migrate-channelgate.mjs`**: runs once at boot — before the database
  opens and before Slack connects — and as the post-update step. Refuses while the pre-rename
  daemon (`gateway.lock`), a self-update transaction (`update.lock`), or a detached background job
  is still alive (`--dry-run` bypasses that gate and reports it as the first plan line instead,
  staying strictly read-only); prints the plan; moves the runtime root (`rename`, or copy + verify
  + remove across devices) — gated on STATE rather than existence, so a stray empty
  `~/.channelgate/` is merged into rather than mistaken for a finished migration, a new root that
  already holds state is never touched, and a merge collision leaves the old copy in place; moves each channel's metadata, clean workspace and work folder by its stored
  platform, never clobbering an existing destination; rewrites stored absolute paths in every JSON
  record and in `update-state.json` / backup manifests; regenerates every channel's
  `.claude/settings.json`; leaves a `MOVED.md` breadcrumb. **Every store that records a path
  follows the move**, not just the folders: database JSON blobs and typed columns,
  `config/mcp-catalog.json` and the pre-SQLite JSON backups, Claude Code's per-project session
  directories (renamed to the encoding of the NEW cwd — that is what keeps `-r` resume working) and
  the `cwd` inside every transcript, Codex's `threads` index `rollout_path`, rollout headers,
  `config.toml` and shell snapshots, the agent's own prose in `MEMORY.md`/`memory/*.md`/`CLAUDE.md`,
  and the installed systemd unit (with a reload marker the updater consumes, since systemd caches
  the definition; the launchd plist rewrite retired 2026-09-03 — Linux only). The
  content-addressed per-run caches under
  `channels/**/runtime/` are dropped rather than rewritten — their filename is a digest of their
  contents — and the historical `events` log is left untouched by design. `--verify` is a read-only
  audit of all of it that exits 1 while any STATE still points at a pre-rename root — decided per
  JSON key path (a `cwd` is state, a path quoted in a message or a tool result is history and is
  reported in its own bucket) and per existence (after the move, a recorded path that still resolves
  on disk names a folder that deliberately did not move) — while `--repath` re-runs every rewrite
  pass against the current roots, idempotently and without moving anything, to fix exactly what
  `--verify` counts; `--dry-run` ends with the same audit. `--repath --from <old> --to <new>`
  (repeatable) adds an operator-supplied rule for a folder moved by hand — the daemon's own checkout,
  a channel's custom `workDir` — applied by every pass (record, Claude project directory rename +
  transcripts, engine `.claude.json`, Codex `config.toml`/state, the folder's own memory prose, the
  service definition, the sandbox) and counted by `--verify` handed the same pair; a malformed or
  misplaced pair is refused with usage before anything is read. → TEST-PLAN: ChannelGate rename. A refusal or failure never fails the
  boot — the process pins `CHANNELGATE_DIR`/`CG_WORKSPACE_DIR` back to the old roots and serves
  from there. `--dry-run` prints the plan and writes nothing. → TEST-PLAN: ChannelGate rename.
- **Public-release repository layout**: product docs merged into `docs/WHY.md`, engine
  capabilities in `docs/ENGINE-CAPABILITIES.md`, the marketing site moved to its own
  repository, and internal names/paths scrubbed from the published tree.
- **Canonical repository `makeitfutureDev/channelgate`** (2026-09-03): development, the served
  `main` and the landing lock (`refs/channelgate/landing-lock`) live in the new repository, whose
  history starts from one fresh-start commit of the scrubbed tree; the pre-rename repository is a
  read-only archive of the full history. An existing checkout is repointed with three commands
  (INSTALL → *Upgrading*), and a renamed checkout directory is repathed in every store with
  `--repath --from/--to`. → TEST-PLAN: ChannelGate rename.
- **Source-available fair-code licensing (v1.2)**: ChannelGate ships under the Makeitfuture
  Sustainable Use License, modeled on n8n's fair-code policy. Internal business deployments may
  be used and modified; personal/noncommercial use is permitted; paid consulting and support are
  allowed for a customer's permitted internal deployment. Paid hosting, white-label/resale, or
  substantially derived commercial products require a separate agreement.
  **v1.1 (2026-08-20)** resolves the case v1.0 left ambiguous — *operating* a dedicated deployment
  for one customer is permitted service work under four stated conditions (§3.1: single customer,
  customer can take it over, fee is for services not access, not sold as the operator's product),
  while multi-tenant operation and de-branding become explicit restrictions (§4.2/§4.4/§5). It adds
  inbound contribution terms (§6 + `CLA.md`, DCO-style `Signed-off-by`, contributor keeps
  copyright, Licensor gets relicensing rights).
  **v1.2 (2026-08-25)** renames the Software to ChannelGate, adds **license keys and usage limits**
  (§3.2/§4.5: no key → one conversation; free key → unlimited conversations at 500 AI messages per
  conversation per month; enterprise → unlimited; end-user keys only, never pooled by a service
  provider; circumvention is a violation; tiers in `docs/LICENSE-KEYS.md`), makes any number of
  separate single-customer deployments permitted service work on the customer's key, names the
  Reseller / White-Label / Enterprise / optional Partner agreements, **removes the v1.1 Change Date**
  (no version is relicensed automatically), and sets Romanian law and Bucharest courts (§11).
  `TRADEMARK.md` states nominative use and the white-label boundary; `AUTHORS.md` records the
  original author and the IP assignment to MAKEITFUTURE S.R.L. Worked examples live in
  `docs/LICENSING-FAQ.md`; the rationale and the enterprise-tier boundary policy — security is
  never a paid tier, limits cap how much you run and never how safely — are in
  `docs/LICENSING-DECISION.md`.
  The bundled Poppins binaries retain the SIL Open Font License 1.1 and ship with its complete
  notice. The project is source-available, not OSI open source. → TEST-PLAN: Phase F operational
  readiness.
- **Retired 2026-09-03 (Linux + containers only):** the Bash-sandbox rationale only — there is no host sandbox to escape; the per-channel browser
  namespace is unchanged. **Browser automation with per-channel isolation**: browser MCP servers (`@playwright/mcp` and
  Vercel Labs' `agent-browser`) are spawned by the engine CLI, which places them outside the Bash
  sandbox — the only way Chrome can run at all, since that sandbox denies the `socket(AF_UNIX)`
  Chromium's Mojo IPC needs. `agent-browser` keeps a browser daemon alive across turns, so the
  gateway gives every channel its OWN daemon namespace (`AGENT_BROWSER_NAMESPACE`, derived from the
  channel's platform + slug) in the Claude and Codex spawn env and in background shell jobs. It is
  gateway-owned: the whole `AGENT_BROWSER_` family is reserved against per-channel secrets, and the
  namespace is merged after them so it cannot be renamed into another channel's browser. It is also
  part of the warm-pool isolation fingerprint. → TEST-PLAN: Per-channel browser isolation.
- **Portable serialized landing lock**: `npm run with-landing-lock -- <command> [args...]` guards
  the common Git repository across every worktree with an atomic compare-and-swap owner ref,
  refuses concurrent landings, safely recovers a dead same-host owner, and drains the complete
  child process group before releasing. → TEST-PLAN: Automated release gate.
- **Recoverable encrypted state**: live SQLite is snapshotted transactionally into encrypted
  backups; a disposable restore drill verifies decryption, contents, and database integrity.
- **Production service packaging**: hardened dedicated-account systemd installation with a matching
  uninstaller (`scripts/uninstall-systemd.sh`: system and user units, current and pre-rename names,
  never the runtime root) and a documented Linux operator contract. The private launchd packaging
  it used to complement retired 2026-09-03 (Linux only).
- **Linux only** (2026-09-03): the daemon targets Linux with systemd and rootless Podman.
  `src/start.js` refuses any other platform with one plain line (`src/platform-gate.js`, imported
  after the Node floor and before the server graph), `npm run setup` says so before touching
  anything, `npm run service:install` / `service:uninstall` wrap the systemd installer and
  uninstaller, and the self-updater probes systemd only (system scope, then user scope). → TEST-PLAN:
  Phase F operational readiness.
- **Lifecycle and release evidence**: configurable backup retention/log rotation, centralized log
  redaction, compatibility matrix, tag-built SBOM/provenance/checksums, canary/rollback checklist,
  and security/privacy/data-flow documentation.
- **Community and contribution files**: `CONTRIBUTING.md` (setup, checks, worktree + landing-lock
  flow, sign-off rules, what needs a discussion first), `CODE_OF_CONDUCT.md` (Contributor Covenant
  2.1), `SUPPORT.md` (community vs. commercial support and what a bug report must contain),
  `.github/CODEOWNERS`, issue forms for bug/feature/partner inquiries with blank issues disabled,
  and a pull-request template. A dependency-free `scripts/check-dco.mjs` (`npm run check:dco`)
  fails any commit range that lacks a well-formed `Signed-off-by` trailer, wired into CI as a
  pull-request job, and `test/dco-check.test.js` covers the pure trailer check.

- **Verified container updates:** update health probes run in a disposable confined container through each configured Claude/Codex runner; missing logins are explicit skips and no probes is a failure. Image source fingerprints detect stale CLI pins even when the image spec or checkout revision is unchanged, allowing Update to retry failed builds. Container status shows desired/built CLI versions and containers awaiting image adoption. Custom image refs require operator rebuilds and failed builds remain visible in update results.

### Real project skill synchronization and workspace reset

- The gateway-selected organization, channel and live-template skill set is authoritative in the
  real project `.claude/skills`; `.agents/skills` exposes that same directory to local Codex.
  Personal grants remain in isolated run artifacts. Gateway usage and enabled channel memory
  protocols are retained. Backups of displaced local entries live under
  `~/.channelgate/skill-backups/<workspace-hash>/`, outside engine discovery.
- Provisioning compares actual bytes, file modes and tree shape with the selected revision,
  repairing edited, missing or added files even when the revision marker has not changed. An
  unchanged tree keeps its files and timestamps. Clean runs stay bare while the normal project
  mirror remains current. Bundled source skills live in `src/gateway/skills/bundled/`.
- Skills admin saves refresh existing workspaces immediately. Boot and a five-second daemon
  reconciliation pass refresh changed catalog/template/grant state, including MCP changes. Failed
  writes are reported and retried; conflicting selections for a shared folder are reported.
- Runtime settings provide **Reset to default** beside **Browse**. It clears only the custom
  working folder through the normal Save/Discard flow; the default remains
  `~/ChannelGate/<platform>/<slug>/`. Existing files stay in their original location.
  → TEST-PLAN: Real project skill synchronization and workspace reset.

- **Recovery and Stop reliability (September 2026):** an explicit Codex `thread/resume failed:
  list_turns is not supported yet` response follows the existing fresh-session/transcript recovery.
  Unexpected Claude SIGKILL/137 never triggers blind automatic continuation; the error event keeps
  engine, runtime, exit code, signal and process/provider/Stop flags without raw process streams.
  Explicit Stop and AbortError also defeat legacy text-based continuation. Automatic-recovery and
  both-engine failure notices unwrap provider JSON into readable sentences.
- **Responsive Stop controls:** “stop the loop” and “Stop the check loop now” cancel through the
  early control path. Loop rows disappear synchronously before Slack calls; status clearing and
  unrelated acknowledgements cannot block another stopped thread’s notice. Stream cleanup gets a
  one-second foreground grace, continues draining afterward, and marks delivered text partial.
  Slack can still throttle the acknowledgement API itself. `run_stopped` records each affected
  active/queued turn once with its run ID/state; `run_stop_requested` records command-level totals.
- **Live numeric progress counts:** fraction/count details and outputs render in the replaceable
  task title, within Slack’s existing 240-character title budget. Changes such as `0/4` → `4/4`
  therefore show the latest count instead of accumulating old counts in append-only rich fields.
  Other rich prose retains the existing append/deduplication behavior.

### Codex usage inside the runtime

Codex resume baselines, live child identities, per-request root usage and final child usage are
read inside the channel container through the runtime's read-only `inspectUsage` seam. Rootless
HOME permissions do not require daemon access to the volume, new mounts or transcript copies.
The reducer is supplied by the running checkout, so this fix requires no image rebuild. Each
child retains its name/thread identity and final elapsed/token metrics; copied fork prefixes
remain excluded. A failed baseline stops a resumed turn before it can incur ambiguously attributed
usage. A failed live/final inspection preserves the answer and emits one visible incomplete
accounting notice. Claude's existing native child progress/accounting path is unchanged.


### Personal skill grants in Codex

Codex receives the current author's personal skill catalog on every normal turn, alongside its
native organization/channel repository skills. Catalog entries name the ephemeral `SKILL.md`
files and their descriptions; Codex reads those instructions and resolves supporting references
relative to each skill directory. This is prompt delivery, not native slash-command registration.
Fresh, resumed and fallback turns receive the current catalog; an empty catalog supersedes prior
personal grants. Clean mode omits it. Personal skill files stay in the existing per-run artifact
plugin and are removed after the run, never copied into shared project skills. HOME, CODEX_HOME,
CLI logins and provider sessions stay unchanged. A selected personal skill that cannot be
materialized fails with its name before engine launch. This provides per-run discovery isolation
within the channel's existing shared container boundary, not separate filesystem identities for
people admitted to the same channel.
