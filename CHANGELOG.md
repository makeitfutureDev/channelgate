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
> | Makeitfuture Sustainable Use License 1.2 | 2026-08-25 | 2026-09-06 (with ChannelGate 0.5.0) |
> | Makeitfuture Sustainable Use License 1.1 | 2026-08-20 | never published |
> | Makeitfuture Sustainable Use License 1.0 | 2026-08-06 | never published |

## Unreleased

- Addressed the release audit: isolated runtime credentials and daemon metadata, tightened SDK/API
  authorization and admin reauthentication, serialized memory saves, and separated interrupted
  execution from result-delivery recovery. Google Chat intake is durable and bounded; non-Slack
  automation no longer requires Slack connectivity.
- Composio SDK is now **Enterprise-only, Beta**. Google Chat and Microsoft Teams are **Beta**.
- Runtime hardening: editor leases live in daemon-owned state, container bind sources reject
  symlinked path components, shell background jobs no longer inherit engine service credentials,
  and service credentials are redacted from replies and job output. The Claude login relay and
  the shared Codex sign-in mount are unchanged.
- License 1.3 clarifies no-key/free-key use of unchanged bundled EE enforcement and authorized
  redistribution. Provider agreements and legal review remain separate release requirements.
- Patched transitive qs, corrected fresh-service provisioning, and expanded release history scans,
  built-image inventory/model hashes and signed artifact evidence. Public instructions no longer
  require private contributor accounts; unused generic skill/UI scaffolding was removed.


- Automations are searchable by conversation/person or automation content, resolve DM display
  names, and describe common schedules in plain language. The enlarged editor now updates timing,
  title, notifications, delivery, state, and prompt atomically, including a new direct-to-channel
  task delivery alongside per-run and per-day threads.

## [0.5.0] — first public release (2026-09-06)

> **Versioning.** 0.5.0 is the first published version of ChannelGate; the repository became public
> on 2026-09-06. The internal iteration labels used below the first public entry (the container
> runtime work labelled "v0.8", and the June 2026 "v1.0.0 (foundation)" milestone) were names for
> private milestones, never publications — the public version series starts here. Everything under
> this heading is what 0.5.0 contains, accumulated since the foundation.

### Highlights
- Container-per-channel runtime (rootless Podman, Linux + systemd only) as the sole confinement
  boundary, with a per-channel HOME volume, image-shipped toolchain and durable channel state.
- Claude Code and OpenAI Codex as interchangeable harnesses with per-thread choice, transient
  failover, warm sessions and the operator's own login relayed into every run.
- Slack in full (threads, streaming progress, approvals as buttons and as links, native charts,
  Lists, file explorer and editor, attachments to 500 MB), with Microsoft Teams and Google Chat
  transports behind the same capability-declared platform layer.
- Skills platform: local catalog, channel and personal tiers, templates followed live, Git and
  folder sources with review, publishing, a catalog MCP endpoint and peer-gateway sync.
- Uncapped channel memory with on-demand retrieval, schedules, background jobs, follow-ups,
  video understanding, VS Code attach, and an admin UI for all of it.
- Licensing: free tier with limits, license keys issued by the platform at channelgate.dev,
  Ed25519-signed entitlements with a 14-day offline grace, and privacy-bounded usage reports.


### Added
- **Approvals as links, so every chat surface can answer one.** Native buttons are Slack's
  primitive: Teams and Google Chat have none the gateway drives, and automation cannot click
  anything at all. Every approval card (permission, control-plane, durable background-shell) and
  every busy-thread card is now ALSO minted as short-lived, single-use, HMAC-signed URLs — one per
  action the recipient may actually take — and delivered **privately to the person who raised the
  request**: a Slack ephemeral in the same thread, a DM on a surface with no ephemeral primitive,
  never the shared thread (a link is a bearer credential). `GET /approve/<token>` renders a
  confirmation page and changes nothing, because Slack, Teams and corporate proxies prefetch and
  unfurl links; `POST` — the page's single Confirm button — resolves the request through the same
  `applyApprovalDecision` / `applyBusyThreadChoice` the buttons and the admin API use, so scope
  semantics, the durable compare-and-swap, the waiting MCP call and the card update in the thread
  are identical to a click. The waiting agent reads `decided_by: "link"`. The signature covers id +
  action + scope + expiry (a *Deny* link cannot be edited into an *Approve forever* one), the nonce
  is spent by one atomic UPDATE (a link works exactly once), deciding a card retires its other
  links, and the requester's own authority is re-checked on every POST — so an admin-tier sign-off
  is handed a Deny link and no Approve link. Unknown/used/expired answer 404/410 with a page that
  reveals nothing about any other request, bad tokens get per-IP backoff, and every response is
  `no-store` + `noindex`. New setting Settings → Connection → **Approval links**: `auto` (default —
  where there are no native buttons, plus Slack once a public URL is set), `always`, `off`. Every
  link decision logs `approval_resolved_by_link` (ids, decision, scope — never a value). Slack's
  buttons are unchanged.
- **Approvals can be resolved from the admin UI and over HTTP, not only by a chat click.** A
  pending approval used to be answerable only by clicking its card in a real Slack client, which
  blocked every automated and QA path that has to get past a permission prompt, a control-plane
  sign-off or a durable background-shell request. `GET /api/approvals` now lists what is waiting
  (conversation, requester, tool, a clipped command/plan preview, age, expiry — no values),
  `POST /api/approvals/:id` takes `{ decision: "approve" | "deny", scope?: "once" | "thread" |
  "forever" }`, and `POST /api/approvals/thread-choice/:id` takes `{ choice: "steer" | "queue" |
  "cancel" }` for a busy-thread card. The decision half of the button handler was factored into one
  shared applier both callers use, so scope semantics, the durable compare-and-swap, the waiting MCP
  call, the requester binding and the in-thread card update are identical either way. Unknown or
  expired is 404, already decided is 409, and every resolution logs
  `approval_resolved_by_admin` with the principal and decision (never the command). Overview shows
  the same queue with Approve/Deny buttons. Admin session only — the run-API key cannot reach it.
- **Full-access channels can see the whole gateway home.** A new gateway-wide switch in Settings →
  Container runtime (`containerFullAccessHome`, off by default). While it is on, every channel in
  Full access gets the gateway user's whole home directory bind-mounted read-write at its identical
  path inside its container — every channel's work folder and memory, every repository under that
  home, the gateway root with its logs, metadata and credential stores — with only the container
  engine's own storage masked out (a write into a running container's layers would corrupt it;
  the mask is a `notmpcopyup` tmpfs — podman's default would copy the whole store into it).
  That is an overseer channel: one agent that can see every other agent and every repo, without
  leaving the container. Until 2026-09-02 admin channels ran on the host, "honestly unconfined";
  containers-only (2026-09-03) confined them to their own work folder; this restores "admin sees
  everything" as an explicit operator choice. It is a boolean, never a path; it is part of the
  container's create-time fingerprint (recreate at the next turn, HOME volume intact); no MCP tool
  can flip it; and it is per channel — every admitted author can read the home through the file
  tools, only an admin author's turn writes with the bypass tools. Claude's admin-run settings
  variant lists the home in `permissions.additionalDirectories`, derived from the resolved mount so
  the file can never name a path the container does not have; Codex admin turns already bypass
  their sandbox. Other Linux users' homes stay unreadable (no `sudo` in the image) and system
  directories are the image's own.
- **Deterministic personal/shared Composio discovery.** Both bundled skills now define
  `composio-user` as the active requester's identity and `composio-agent` as the shared agent
  identity, select them by pronoun or connection alias, ask when an app is connected to both,
  recognize underscore-normalized MCP tool prefixes, and verify connection status before reporting
  an app unavailable—without silent fallback or initiating a connection during inventory.
- **Source-specific Skills Git credentials.** GitHub catalog sources now use their own optional
  write-only token, while publishing has a separate write-only token and follows `main`. The Add
  source dialog offers only GitHub or Other ChannelGate, reveals type-specific fields, and takes a
  `/tree/main/<path>` URL instead of separate branch/subfolder controls.
- **Usage-led skill governance.** Skills now opens on the top 20 skills used in the last 30 days,
  Templates is second, usage displays one harness-neutral total, and Catalog defaults to usage
  order with category/source filters plus source-aware description search. Per-skill Enabled,
  Discoverable, and Mandatory controls govern source imports; mandatory skills load everywhere.
  Templates contain explicit skills only, agents can search by source and admins can change the
  governance flags through `set_skill_governance`, and Overview charts the top ten skills.
- **Skill repository sections.** The skills repository is one shared library plus one folder per
  channel (`channels/<channel id>/`); a skill in a channel's section is granted to that channel
  automatically. New skills go to the library by default; `create_skill` takes `scope: "channel"`
  for customer-specific ones (the agent asks first), and `set_skill_scope`, the Skills view's
  *Section* control or the admin API move a skill either way — files move in the repository, and a
  promoted skill stays with its former channel as an explicit grant. `.` as the publish folder
  means the repository root.
- **The bundled ChannelGate skill now matches the product.** Its small entrypoint routes to focused
  references for containers/security, write-only secrets and durable CLI/device logins,
  Claude/Codex credentials, MCP identities and the local skill platform, catalog-first channel
  memory, conversation operations, and manual folder/headless configuration. Package validation
  guards frontmatter and progressive-disclosure links. Memory search/read registration also keeps
  the gateway text-response adapter in scope, fixing the live `text is not defined` failure.
- **Video understanding is part of the main gateway skill.** `gateway-usage` now ships the complete
  synchronized visual/audio workflow, sampling and dependency guidance, and local analyzer script
  to every conversation. The former standalone catalog skill is excluded and removed from durable
  grants at boot, while stale gateway-managed copies are pruned on the channel's next turn.
- **Live Slack progress no longer splits the answer.** Native task/tool/thinking rows stream in a
  dedicated first message, while the Markdown answer streams contiguously in a separate message
  beneath it. Both streams retain their independent long-run rollover and terminal/fallback
  handling; text-only turns still remain a single answer message.
- **Uncapped channel memory with on-demand local recall.** Markdown remains canonical, fresh
  sessions receive only a compact catalog, and new channel-scoped search/read tools use a derived
  SQLite FTS5 index. The former 8,000-character write ceiling and prompt-body injection are gone.
- **Conversation Settings now follows the operator workflow.** Access emphasizes the three normal
  modes and separates Full access/Lean; Tools has Connections, MCP servers, Environment tokens,
  and Skills categories; inherited guest access is visible; enabled skills sort first.
- **The Skills admin workflow is organized around the operator's task.** Sources use an Add source
  modal; synchronization/publishing and MCP access have separate tabs; templates have a searchable
  selection editor; and Usage has searchable By skill / By channel views, compact bars, detection
  provenance, and plain-language context-warning explanations.
- **Organization-wide local video analysis.** The shared conversation-container image now includes
  `ffmpeg`/`ffprobe`, pinned OpenCV and faster-whisper, plus a pre-cached Whisper `small` model, so
  the built-in `gateway-usage` video workflow works without per-channel installs or first-use downloads (image
  spec 1.2.0).
- **`slack_download_file` — an agent can fetch a file shared earlier in this channel.** The pre-run
  downloader only ever delivered the files on the triggering message, so a recording posted on a
  thread's first message was unreachable from a later "try again" reply and the bot could only ask
  for a re-upload. The new gateway tool fetches a file by id (from `slack_channel_history` /
  `slack_thread_replies` metadata or a pasted Slack link) with the bot token into the current
  thread's `uploads/` folder and returns the local path — fail-closed to files Slack reports as
  shared in THIS channel, the same 500 MB cap and streaming writer, a file already in the folder
  reused. Alongside it, a thread ROOT's attachment is carried into a later reply automatically and
  downloaded while its bytes are still missing from the folder (never re-attempted when its
  declared size is over the cap — that refusal was already reported at the root).
- **Inbound attachments up to 500 MB, streamed to disk.** A Slack, Google Chat, Teams or Run API
  (`fileUrl`) attachment may now be up to 500 MB (was 30 MB, or 25 MB for the Run API); the one
  shared cap lives in `src/util/bounded-bytes.js`. The bytes no longer pass through the daemon's
  memory: every sink streams the body straight into the channel's `uploads/` folder through an
  exclusive no-follow temp file with the running total checked per chunk, and renames it into
  place only when complete. A refusal names the actual size against the limit (`263.4 MB exceeds
  the 500 MB attachment limit`) instead of `too large`; a large Slack download announces itself
  in the assistant status before the run starts.
- **The installer builds the channel image.** `npm run setup` now runs `npm run build:image` after
  the dependencies and the Whisper step, so a fresh gateway has the whole shared toolchain
  (engine CLIs, `ffmpeg`, OpenCV, `faster-whisper` + model) before its first message instead of
  failing the first run closed. `--skip-image` / `CG_BUILD_IMAGE=no` defers it; a failed build is
  reported with the manual remedy and never aborts the install.
- **Skill templates are followed live, and edited in Settings.** A conversation is assigned a
  template (Conversations → Tools → *Skill template*, the Skills view, `set_channel_skill_template`,
  or a DM template) and gets the template's current skills plus whatever is added to the
  conversation itself; editing the template under Settings → Access Templates → *Skill templates*
  (a catalog checklist plus categories) reaches every conversation that follows it. Replaces the
  one-time copy of the day before.
- **Skills platform, round two: Skills Manager migrated in, Git publishing, an MCP endpoint of its
  own, peer gateways.** Skills authored or approved in chat are pushed to a configured GitHub
  repository (one commit per file) and adopted by the matching source; a GitHub push webhook
  triggers a debounced sync; `POST /mcp/skills` serves the catalog to laptop Claude Code, Codex and
  any MCP client with scoped, revocable access tokens (the `library_*` tool names kept); a source
  of kind `gateway` lets a second gateway follow another's library; personal (author-only) skills,
  self-service personal grants (`add_my_skills`), feedback proposals, `delete_skill`, organization-
  tier and source administration from chat, compatibility notes, and
  `scripts/migrate-skills-manager.mjs`, which moves a deployment's Skills Manager repositories,
  favorites, team favorites, exclusions and personal skills into the catalog.
- **Skills platform (Core): the gateway owns its skill library.** A local catalog in the gateway
  database stores every skill a conversation can be granted as immutable, content-hashed revisions
  of the exact bytes of every file (`SKILL.md` included), with explicit ownership per slug
  (bundled / host folder / git source / local), tombstones instead of deletes, pins for rollback,
  and a review queue. Conversations get token-free skill profiles: the existing organization →
  conversation → user grants resolve against the catalog with `requires:` dependencies, a context
  cost estimate, and real files materialized write-on-change (Claude via its plugin, Codex via
  `.agents/skills`) — the Skills Manager stub and its mid-turn fetch are no longer needed for
  catalog skills. **GitHub sources** (Skills Manager's tarball sync ported and hardened: branch
  names with `/` resolve correctly, review vs auto mode, commit pins, last-good state on failure)
  and host folders feed the catalog; **templates** (Development / Sales / Marketing / Management,
  editable) apply a snapshot of skills to a conversation; **chat verbs** cover listing, granting,
  templates, `create_skill`, `update_skill`, proposals with admin approval (an approved change to a
  source-owned skill becomes a pinned local override), usage reports and source sync; **usage
  telemetry** records exact (Claude `Skill` tool) and inferred (Codex `SKILL.md` read) signals and
  lists never-used grants; the admin UI gains a **Skills** view (catalog, review, sources,
  templates, usage). `src/gateway/skills/`, `src/mcp/tools/skills.js`, `src/web/routes/skills.js`,
  `public/admin-skills.js`, migration 14, `docs/SKILLS.md`, `gateway-usage` → `references/skills.md`.

### Removed
- **The Skills Manager runtime integration.** Skills now come from the gateway's own catalog as
  files, so the `makeitfuture-skills` MCP injection, the organization/channel/user Skills Manager
  tokens (with their tools, routes, admin UI fields and secret readers), the favorites stubs and
  the App Home favorites fetch are gone. Stub folders left in older channel folders are pruned on
  the next message. Skills Manager itself remains a standalone product; Toolbox is unchanged.

### Changed
- **Skill exclusions stick.** A skill an admin removes from the catalog (the Skills view,
  `set_skill_excluded`, a Skills Manager exclusion carried over by the migration) now stays out when
  its source delivers it again; before, the next sync silently restored it. Only a skill its source
  dropped still comes back on its own. Restore brings an excluded skill back on its newest revision.
- **Production license verification is live by default.** The gateway now ships the Ed25519 public
  key published by the ChannelGate licensing platform and uses `https://channelgate.dev` as
  its default platform URL. Fresh installs can verify platform-issued keys without an environment
  override; `CHANNELGATE_LICENSE_PUBLIC_KEY` remains available for staging and coordinated rotation.
- **Small text files now offer both editing surfaces.** When a Public URL is configured, eligible
  files up to 3,000 characters retain the native Slack *Edit* popup alongside *Edit in browser*;
  larger eligible files remain browser-only. Slack does not expose a modal-size setting, so the
  browser editor remains the larger workspace.

### Security
- **The approval-link and admin-login backoffs count the real client, not the tunnel in front of
  it.** The daemon binds `127.0.0.1` and is reached from outside through cloudflared or a reverse
  proxy on the same host, so every public caller arrives on a LOOPBACK socket — and both per-IP
  backoffs keyed on that address, which made them one bucket for the entire internet. A handful of
  bad approval tokens from anywhere put every legitimate approval link into 429 (verified live: a
  429 raised through the public URL also refused a link opened from the machine itself), and the
  same shape let one stranger's failed password guesses lock the admin out of the login form —
  exactly the outcome the backoff exists to prevent. Both limiters now key on the FORWARDED client
  through one shared helper: `CF-Connecting-IP` (which the tunnel overwrites, so it cannot be
  prepended to), then the first hop of `X-Forwarded-For`, honoured **only when the socket itself is
  loopback** — from a non-loopback socket those headers are whatever the client typed and are
  ignored, unless the operator declares a trusted proxy elsewhere on the network with
  `CG_TRUST_PROXY` — and only when the value parses as an address, so a header can neither pick a
  bucket for someone else nor fill the limiter's map. Express's app-wide `trust proxy` was
  deliberately not used: it would also re-point `req.secure` / `req.protocol` / `req.hostname` at
  client-supplied headers, which the DNS-rebinding Host/Origin guard and the session cookie's
  `Secure` flag read for themselves on purpose, and it knows nothing about `CF-Connecting-IP`. New
  runbook section in `docs/OPERATIONS.md` → *Reverse proxies and tunnels*.
- **"My inbox" is never answered from the shared Composio identity.** A requester with no
  personal Composio token asked, in their own words, for their own mailbox. The run had only the
  shared agent identity (`composio-agent`) — which holds OTHER people's connected accounts — used it
  without saying so, and reported a third person's email address and recent subject lines as the
  requester's. Ambiguity was already a hard stop; substitution was not, because the rule against it
  lived only in the `gateway-usage` skill body, which one harness never opened (the other refused
  correctly). The always-injected managed block now carries it as a hard rule: a request phrased for
  the person asking ("my inbox", "my calendar", their own name) is served ONLY by `composio-user`;
  when `composio-user` is absent from the run or has no connection for that app, the answer is to
  say so and stop — never a read of the shared identity, "not even to check" — and the mirror holds
  too ("your X" never touches the requester's identity). The block stays inside its 4 KB budget.
- **Channel policy changes are audited, and a refused secret reveal leaves a trace.** Two gaps in
  the audit trail, both confirmed live. (1) A channel's meta record IS its security posture, and
  changing it wrote nothing: turning *Allow network* off, repointing the working folder and
  switching a conversation to Full access through `PUT /api/channels/:channelId/meta` all persisted
  with zero rows in `events` — only the per-channel environment secrets were audited — and the chat
  twins (`set_channel_admin_mode`, `set_channel_network`, `set_channel_bash`, `set_channel_auto_mode`,
  `set_channel_workdir`, `set_channel_drive_folder`, the MCP allowlist tools, the typed `/mode`
  command and the `/model` runtime picker) wrote nothing either. Every one of them now emits a
  single `channel_meta_changed` event naming the conversation, the principal (`admin-ui` for the
  admin UI's one shared password, the chat author's own id for anything typed or clicked in Slack)
  and the POLICY keys that actually moved, with their before/after values. The diff is one helper
  (`src/config/channel-audit.js` → `policyDiff`) shared by every surface, over a curated allowlist —
  so a token, a per-channel environment value or any other non-policy field can never reach an audit
  row, an unchanged key writes nothing, and a save that touches no policy key (a nudge toggle, a
  re-submitted form, a token rotation) writes no event at all. Skill grants made from chat now write
  the same `skill_granted` / `skill_revoked` / `skill_template_assigned` rows the admin UI already
  did. (2) `POST /api/secrets/reveal` answered 400 for any field off the reveal allowlist BEFORE it
  logged anything, so someone holding a stolen session could sweep the endpoint for revealable field
  names — probing `adminPassword`, `__proto__`, every config key they could think of — and leave the
  audit completely empty; only a wrong password logged (`secret_reveal_denied`). A refusal now logs
  `secret_reveal_rejected` with the requested scope/field/id NAMES (clipped, never a value) before
  the 400. All three outcomes of that endpoint — granted, wrong password, refused field — now also
  name the admin principal (`admin-ui`, the same spelling the skills audit has always written; the
  UI's sessions carry no personal identity); they used to be written with an empty author, so an
  audit row read as if nobody had asked for the secret. The revealed value is still never logged.
- **The admin UI shows the events trail.** `GET /api/audit/events` existed but nothing rendered it,
  so every audit row above was invisible to an operator. **Activity** now carries an *Admin &
  security events* table under the run history — time, event, conversation, who, and what changed
  (for a policy change: `key: before → after`) — defaulting to the admin/security kinds with a
  toggle for the full feed and 25-row pagination. An unrecognized kind still renders, with its raw
  name opened up, so a newly added event is readable the day it ships.
- **A retired integration's token is no longer served in cleartext by the admin API.**
  `GET /api/channels` masked the Composio, Toolbox and Make toolbox secrets by name and then spread
  the rest of each channel's stored record into the response. `skillsToken` — the Skills Manager MCP
  token, dead since the local skills catalog replaced that integration — was in neither set: no code
  read it, so no masker named it, and every channel whose stored meta still carried one handed the
  full value to anyone who could reach the admin API. **Operators should rotate any Skills Manager
  token that was ever stored on this deployment**, in the issuing system; the gateway itself no
  longer uses it, so nothing needs re-entering afterwards. Three changes, because masking alone was
  what failed: every channel read (the channel list, the DM list and the save response) now goes
  through the ONE masker instead of three drifted copies of it — which also closes the DM listing's
  unmasked Make toolbox key; the dead field is stripped from every record on the way into the store
  and on the legacy JSON import; and a schema migration deletes it from the channel and user records
  that already hold one, so the value stops existing rather than merely stopping being displayed.
  The users listing was never affected — it is built from an explicit allowlist, which is now the
  documented reason it is written that way. Retiring an integration means adding its field to
  `src/config/dead-fields.js` in the same change.

### Fixed
- **A busy-thread approval link names the conversation, in the page and in the audit row.** An
  approval card is minted with its conversation slug, but a busy-thread card is built from a raw
  chat event and carries only a channel id — so the *Conversation* row on its confirmation page
  read `C0123456789`, a string the person deciding has never seen, and every
  `approval_resolved_by_link` row for a steer/queue/cancel decision was written with an empty
  `slug`, which is the field the other approval events are queryable by. The slug is now resolved
  from the channels index (the same place the admin approvals list reads it) once per request, in
  the shared resolution both verbs use, so the page and the audit row always agree.
- **A shell turn that reads two skills in one command now records both.** Codex has no Skill tool:
  a skill is "used" when the run reads its `SKILL.md`, and the whole shell line arrives as one tool
  event. The matcher stopped at the FIRST `…/skills/<slug>/SKILL.md` in that line, so the routine
  shape `sed -n '1,240p' …/gateway-usage/SKILL.md && sed -n '1,320p' …/<granted>/SKILL.md` recorded
  the always-on guide and silently dropped the granted skill the turn was about — two identical
  runs of the same skill, one row. Every match in the text is now recorded (deduped per run), and
  the path pattern accepts a read through either skills directory (`.claude/skills`, the
  `.agents/skills` symlink Codex follows), absolute or relative, quoted, `~`-relative, or anywhere
  inside a compound command, while still refusing look-alikes such as `myskills/…`.
- **The Usage panel explains how it counts.** The report has always carried the notes that make its
  numbers readable — exact (Claude's Skill tool fired) versus inferred (a shell read of `SKILL.md`,
  best effort), and that capture is not retroactive — and the admin UI dropped them on the floor, so
  a total with no context looked like a measurement rather than a lower bound. They now render as a
  help line under the Usage header. One total per skill is unchanged.
- **An over-the-cap warning reaches the person who caused it.** Granting a skill resolves the
  conversation's whole always-on profile, warnings included ("always-on skill descriptions cost
  about N tokens per turn (soft cap M)", a skill still awaiting review, a missing dependency) — and
  both grant paths computed them and threw them away. Whoever pushed a conversation over the cap was
  the one person who never heard about it; the warning surfaced only later, in the admin Usage
  panel, to somebody else. `POST /api/skills/profile/:channel/grant` now answers with `warnings` and
  `contextTokens` (resolved over the conversation's whole durable tier: organization + template +
  its own grants) and the admin UI appends them to the grant confirmation; `add_channel_skills`
  appends them to its chat reply and reports the same durable-tier cost it warns against.
- **The Container runtime card describes the runtime the gateway actually has.** Its copy still
  offered containers as an alternative to "the daemon's host sandbox" and promised that "admin-mode
  channels always stay on the host" — both untrue since the containers-only change: there is no host
  sandbox, and an admin-mode channel runs in its own container with the permission bypass applied
  inside it.
- **The template skill search filters again, and the Add-source dialog shows one kind of field.**
  Both hide elements by setting the `hidden` property, and the admin stylesheet was quietly
  overriding it: an author `display` declaration beats the user-agent sheet's
  `[hidden] { display: none }` whatever its specificity, so `.skills-picker-row { display: flex }`
  and `.field { display: block }` kept every row and every field on screen. Typing in Skills →
  Templates' skill search filtered nothing at all, and choosing GitHub or Other ChannelGate in the
  Add source dialog left both kinds' fields visible at once. Both classes now carry a `[hidden]`
  companion rule.
- **A skill pinned to an older revision describes THAT revision.** The `skills` row's frontmatter
  columns (name, description, category, tags, requires, version) are a derived index rebuilt from
  the newest ACTIVATED revision, so a rollback — or the pinned override an approved proposal writes
  — kept advertising the newest revision's name and description beside the pinned revision's files,
  in the catalog table, the skill detail, the chat listings and the peer-sync manifest. Every
  catalog read now overlays the pinned revision's own `SKILL.md` frontmatter, exactly as the file
  list already followed the pin; an unpinned skill is returned untouched.
- **A template preview says what the conversation will actually pay in context.** The always-on
  estimate counted only the template's own skills and their dependencies, while the organization
  tier loads in EVERY conversation whatever the template says — with a few dozen mandatory skills
  configured, the number an admin sizes a template against was short by most of the real cost.
  `preview_skill_template`, `set_channel_skill_template` and `GET /api/skills/templates/:slug/preview`
  now report labelled numbers instead of one: what this tier adds, what the organization tier costs,
  and the effective union (dependencies included, a skill in both tiers counted once), measured
  against the configured context soft cap.
- **Saving a channel environment secret no longer claims the conversation card has unsaved edits.**
  The card marks itself dirty on any input or change inside it, and the Environment tokens pane is
  inside that card — so typing a variable name or value, and storing it with its own request, left
  an "Unsaved changes" bar hanging over a card with nothing to save. Controls that save through
  their OWN request (a write-only value must never round-trip through the card's Save) are now
  exempt in all three dirty-trackers: the conversation card, the DM/template card and the Settings
  page. Nothing else about the bar changed.
- **A container whose workspace moved is rebuilt before the next turn, never reused.** A channel's
  work folder was pointed at a subfolder, used for a few turns, then restored and the subfolder
  deleted. The warm container had been created with that subfolder bind-mounted as its workspace;
  the create-time fingerprint mismatched, but the rebuild was DEFERRED as "runs are active" and
  three more turns were exec'd into the container anyway — each dying on `Append system prompt file
  not found: …/CLAUDE.md`, because the directory it was bound to no longer existed. Two things were
  wrong. Containers now carry a second label, `cg.mounts`, covering only the create-time inputs that
  decide what the container can SEE (work dir, clean workspace, artifact dir, HOME volume, every
  bind and mask): when that half of the fingerprint moves, the turn never runs against the old
  mounts — it waits, bounded and announced in the thread, for the runs still inside to finish and
  then rebuilds, or fails with a message naming the pending rebuild. A mismatch that is only about
  behaviour (a rebuilt image, a limit, the network mode) is still deferred to the next idle moment
  exactly as before. And the deferral no longer fires spuriously: the asking turn takes its own
  container lease before the environment is brought up, and that lease was being counted as "a run
  is active inside", so every turn looked busy to itself — a caller now passes its own lease handle
  and the backend asks whether anyone ELSE is inside.
- **Saving Settings no longer reverts what someone else changed.** The Settings page's single Save
  re-submitted the WHOLE form from the snapshot the page had loaded with, so any value written
  after that load — by a second admin, by the skills sync, by a license write, by the first-boot
  password upgrade — was silently reverted by an unrelated save minutes later (a restored
  `channelTemplate.effort` lost to a save of `scheduleMaxPerChannel` is what surfaced it). Save now
  sends only the fields that actually differ from what the page was painted from, and the server
  merges them exactly as it always did — a field nobody touched is not in the request and cannot
  revert anything. On top of that, `/api/settings` carries a `settingsVersion` that a save may echo
  back: if anything wrote settings in between, the save is refused with 409 and NOTHING is written
  (the check runs inside the same lock as the merge, so it cannot be raced), and the refusal
  carries the current settings — the page repaints from them and names the keys that moved, so the
  admin re-applies their change on top instead of over. A caller that sends no version (an older
  UI, a script) is merged in exactly as before. A repaint also clears anything left pending — an
  armed *clear* toggle, a typed password or service-account key — because a pending action captured
  as "already saved" would silently never run.
- **A channel environment variable typed in lower case is the variable you meant.** The admin card
  sent the name exactly as typed and the store rejected anything but `A–Z0–9_`, so `supabase_token`
  was a validation error instead of `SUPABASE_TOKEN`. The name is now upper-cased visibly as it is
  typed (and on blur, and before it is sent), and the store folds case itself, so the Slack modal
  and any API client get the same canonical name — an update of an existing variable rather than a
  refusal or a duplicate. Nothing else is forgiven: a dash, a space or a leading digit is still
  refused (quoting what was typed), and the reserved-name check runs on the folded name, so `path`
  cannot smuggle `PATH` past it.
- **A pre-SQLite upgrade no longer loses every channel's lockdown record and thread→session map.**
  The one-time JSON→SQLite import listed the legacy channel slugs from `channels/`, then read each
  one's `meta.json` / `sessions.json` through the path helpers — which moved with the per-platform
  folder rename and now resolve to `channels/<platform>/<slug>/`. On an authentic legacy tree those
  files are at `channels/<slug>/`, so the import found none of them: it logged `meta=0 sessions=0`
  and completed successfully, and the upgraded install came up with every channel's capability
  settings and every thread's engine session gone. Nothing failed; the data was simply not there.
  It cannot be avoided by migrating the folders first, either — the boot migration reads its channel
  records from the store, which opens the database and runs this import, before it moves anything.
  The legacy paths are now spelled out, with the current layout accepted as a fallback for a
  half-migrated tree; the import stays one-time and still leaves every source file byte-identical.
- **An expired licence stops granting its tier.** A licence whose `expiresAt` had passed was routed
  into the "platform unreachable" grace lane, which keeps the last verified tier for 14 days from
  the last successful check. For an OFFLINE (air-gapped) payload that check is stamped at read time,
  so it always looked freshly verified and the 14-day window never closed: an expired enterprise
  payload kept reporting tier `enterprise` with unlimited conversations indefinitely, and the run
  gate admitted accordingly. Expiry is now resolved before the unreachable lane, as its own `expired`
  state: the no-key limits apply from the moment the licence runs out, no tier is reported, and the
  admin card says on which date it expired. An expiry date is not a network condition — unlike a
  platform outage it is known in advance — so it gets neither the 14-day window nor the month-boundary
  courtesy, exactly like `invalid`/`revoked`. The genuine case those courtesies exist for is
  unchanged: a still-in-date licence that could not be re-checked keeps its tier for 14 days and then
  until the next UTC month boundary. A licence with no end date, or an unreadable one, never expires.
- **A daily-thread schedule starts a fresh session on every fire again.** A scheduled run's session
  key was built from the message its result is threaded under, which is a different message per
  fire only for `standard` delivery. `delivery:"daily-thread"` reuses one anchor for the whole
  server-local day, so the day's second and later fires landed on the same key and RESUMED the
  previous fire's engine session — carrying context between runs the schedule contract explicitly
  promises are independent. The session key is now derived per fire and never from the delivery
  thread; the anchor still groups the day's results exactly as before. Known limitation, unchanged
  and now documented in the code: the scheduler starts only after restart recovery finishes and its
  first tick lands a minute later, so a cron matching a minute that passed during boot is skipped
  until its next match — firing that minute would need a durable per-minute fire record, because
  the in-memory one cannot tell it apart from a minute that already fired before the restart.
- **A Claude run's skill uses now land on the skill they name.** Claude names a plugin-provided
  skill as `<plugin>:<slug>` in its `Skill` tool call, and the usage recorder looked that whole
  string up in the catalog — it matched nothing, so every exact signal Claude produced was stored
  as an off-catalog name with no skill or revision id, and the usage report marked the skill it had
  just fired as not in the catalog. The recorder now strips a leading `<plugin>:` prefix before the
  lookup, so a plugin-qualified use attributes to the catalog skill (and its effective revision)
  exactly like a bare one; a plugin skill the catalog does not know is still recorded, under its
  bare slug so repeats aggregate together.
- **The audit feed's attachment count is what the turn actually received.** `run_start` logged the
  number of files on the Slack event, not the filtered set that reaches the engine, so a reply whose
  only attachment was carried in from the thread root and is already on disk logged `files: 1` while
  nothing was downloaded. It now logs the filtered count and, when the event carried root files at
  all, a `carried` count beside it, so the difference is visible instead of misreported.
- **The guide no longer promises a bare `stop` works in a channel.** `/help`, the `/stop` reply, the
  README/INSTALL notes and the guide's loop and table references all said to "type `stop` in that
  thread"; in a channel the mention gate drops an un-mentioned message before the stop word is ever
  read, so only `@bot stop` (or a 🛑 reaction) stops a channel thread — a bare `stop` works in a DM.
  Every one of those sentences now says which is which. The gate itself is unchanged.
- **A bounded repeat-check is a schedule, not an in-turn poll loop.** The managed block's
  "only the gateway can report back" rule named the durable tools but left "check every 10 minutes,
  6 times" ambiguous, so a run could read an in-turn sleep loop as compliant while the turn is held
  open. The rule now says a finite repeat-check is `create_schedule` (or `run_agent_in_background`
  for a self-contained watcher) and never an in-turn sleep/poll loop, a `Monitor`-style wait, or a
  harness background task — even when the loop would finish inside the turn.
- **The rules a run must never get wrong are now in the context every run receives.** Guidance that
  lived only in the `gateway-usage` skill reached one engine and not the other: the skill body is
  read when the model chooses to open it, and across a retest wave of failing transcripts the string
  `gateway-usage` appeared only in the skills catalog listing while none of the rule text appeared at
  all — the other engine, reading the identical text through the `AGENTS.md` symlink, followed it and
  passed. The cost was not stylistic: a personal calendar read into a shared channel without asking
  whose it was, an "inventory" call that quietly raised a fresh authorization request, remote
  execution run against the requester's own identity unasked, and follow-ups promised on background
  processes that die with the turn and never report. The gateway-managed block at the top of every
  conversation's instruction file — appended to the system prompt of every run, in every mode, clean
  mode included — now carries a compact **Hard rules** section beside this conversation's switches:
  the two Composio identities and the stop that makes an unnamed request a question rather than a
  tool call, that `COMPOSIO_MANAGE_CONNECTIONS` initiates connections for any action (`list`
  included) rather than listing them, and that only the gateway's `run_in_background`,
  `run_agent_in_background` and `create_schedule` can report back after a turn ends. It is
  engine-neutral, applies wherever the named tools exist, and the gateway-owned part of the block
  stays under 4 KB so the always-on prompt weight is read rather than skimmed; the full reasoning,
  tool shapes and examples stay in the skill.
- **A Codex thread keeps its Composio tools on every turn, not just the first.** The second message
  in a Codex thread came back without `composio-user` or `composio-agent` at all — the registry
  showed only the `gateway` family, so Workbench and every connected app vanished mid-conversation
  while the cold turn had them. Neither the argv nor the CLI was at fault: `codex exec resume`
  carries and honours the same `-c mcp_servers.*` overrides a fresh `codex exec` does. Codex simply
  does not BLOCK a turn on MCP startup — it takes whichever servers have finished by the time it
  builds the first request, and `startup_timeout_sec` only caps the handshake instead of extending
  that wait. A fresh run assembles instructions, skills and workspace state first and leaves
  roughly two to five seconds of room; a resumed run reaches the request in about two. The two
  Composio servers were bridged to stdio through `mcp-remote`, which needed ~2.4s to answer
  `tools/list` (two Node bootstraps, an OAuth-discovery round trip that a static-header server
  never needs, then a duplicated initialize) — inside the cold window, outside every warm one,
  while the local gateway server always made both. Header-bearing remote MCP servers (both Composio
  identities and both toolboxes) are now dialled by Codex itself over its native streamable-HTTP
  transport, which answers in about 1.2s, and their credential is produced by a per-run
  `http_headers_helper` script that reads the run's existing 0600 secret bundle — so the token is
  still absent from Codex's argv and environment, and never reaches the shell snapshots Codex
  writes into the channel's home volume.
- **Read-only conversations no longer run shell commands without asking.** A read-mode channel said
  "no shell" only by leaving `Bash` out of the lockdown file's `permissions.allow`, and that is not
  what Claude Code enforces: for a simple command whose argv head is on the CLI's own built-in
  read-only list (`id`, `cat`, `head`, `tail`, `wc`, `stat`, `strings`, `readlink`, `uname`, `df`,
  `diff`, …) it answers "allowed" before it ever consults `--permission-prompt-tool`. So a cold
  read-mode turn executed `id -un` inside the conversation's container in a tenth of a second — no
  approval card, no approval record — and could read any file that container user can read,
  sidestepping the folder scoping the Read tool applies. Every conversation that does not grant the
  shell (read, lean, and the shared file an admin conversation's non-admin authors run under) now
  names `Bash` in `permissions.ask`, which is evaluated ahead of that layer: every command, simple
  or compound, routes to the approval card, which is what Read mode always promised. Conversations
  that DO grant the shell are untouched (an `ask` rule outranks `allow`, so listing it there would
  card every command they exist to run), the narrow `MEMORY.md` write grant is untouched, and an
  admin author's escalated turn still bypasses prompts through its own settings variant.
- **Codex subagent work is visible on the task card again.** The mapping built child rows only from
  a collab tool call's `agents_states`, and Codex's multi-agent v2 mode reports children somewhere
  else entirely: the spawn arrives as a `collaboration` function call, the child's start and finish
  as `SubAgentActivity` items, and the only collab tool call it emits — the wait — carries no
  receivers and no states at all. A turn where two children really ran therefore showed nothing.
  Every shape is now read: `agents_states`, `receiver_agents` and `receiver_thread_ids`; the
  `SubAgentActivity` lifecycle, keyed on the child's THREAD id so its start (the spawning call id)
  and its finish (a synthetic completion id) merge into one row; and the spawn call itself, whose
  requested task name titles the row while its encrypted message never can. Item types match in
  both spellings the CLI uses (`collab_tool_call` in the exec stream, `CollabAgentToolCall` in the
  session stream), and a collab call that names no child now renders the coordination step itself
  instead of nothing. Note the remaining CLI limit: under multi-agent v2 (CLI 0.152/0.153)
  `codex exec --json` forwards no per-child lifecycle at all, so such a turn shows its wait step;
  per-child rows appear wherever the CLI reports child identity.
- **Codex answers no longer run their segments together.** Codex reports each assistant message as
  its own completed item — a stage narration, then the answer — and the native Slack stream shows
  exactly what the runner streamed, so the last word of one segment was glued to the first word of
  the next ("…isolates conversations.ChannelGate isolates each…"). A new message item now opens a
  new paragraph; deltas inside one streamed item are still concatenated untouched (the break marks
  a boundary, it does not reformat prose), and the authoritative final message read from Codex's
  `-o` file is unchanged.
- **A skill's dependencies are no longer stored as grants of their own.** Granting a skill through
  the chat verbs, the admin API or a newly authored skill wrote the RESOLVED `requires:` closure
  into the tier's stored grant list, so the dependency reported as a direct channel (or personal,
  or organization) grant instead of *required by* its parent, showed up checked in the
  conversation's skill list, and stayed behind as an orphan grant when the parent was revoked. A
  grant list now holds only what was explicitly granted; dependencies keep being resolved at every
  materialization and in every effective profile, so nothing that used to load stops loading, the
  skills and usage views attribute them to the skill that requires them, and revoking a parent
  takes its dependencies with it. Granting a dependency by name is still an ordinary grant that
  outlives its parent. The grant surfaces now report the dependencies a grant pulls in, and a
  revoke of something that is only a dependency says which skill keeps it active instead of
  claiming a removal that changed nothing.
- **The Allow-network switch is now a two-state fact everywhere, and honest about being advisory.**
  The mode label appended a network suffix only when the switch was ON, so "off" and "nobody ever
  configured it" rendered identically — in `/mode`, in the channel list, everywhere. `/status`
  carried no network state at all, and the engines were told nothing either way: asked whether it
  was allowed on the network, a run could truthfully answer that neither its system context nor its
  channel instructions nor its session config mentioned it. The label now states the switch in both
  directions (`Bash · network off` / `Bash · network on`), `/mode` and `/status` add the caveat
  (`network off (advisory — not enforced by the container yet)`), and the gateway-managed block at
  the top of every conversation's instruction file — the file both harnesses read — states the mode
  and the network switch to the engine itself. The honesty matters: under the container runtime the
  switch is advisory (every container is on the bridge network and no egress is policed per
  channel), so a run told "you have no network" would call the switch broken the first time a
  request succeeded. The stale header in `src/engines/network-policy.js` claiming "off" ran the
  container with no network at all is gone, and every `run_config` event now records
  `networkEnforced: false` beside `networkPolicy` so an operator reading it after an incident
  cannot mistake `"off"` for "this turn could not reach the internet".
- **The agent no longer promises follow-ups nothing will deliver.** Claude Code's own
  `Bash(run_in_background: true)` is reachable inside a gateway turn and was being used to say
  "I'll report back when it finishes"; Codex faked a watch loop with sequential sleeps. Both die
  with the headless turn, so the report never came. The bundled `gateway-usage` guide now names the
  harness's own backgrounding (`run_in_background: true`, `nohup`, `at`, `screen`/`tmux`) and
  in-turn sleep loops as dead ends, states that only `run_in_background`, `run_agent_in_background`
  and `create_schedule`/loops survive the turn, and requires the agent to say plainly that it
  cannot follow up when the channel's mode allows none of them.
- **The skills docs no longer promise an auto-mode bypass that does not exist.** `docs/SKILLS.md`
  and the guide's skills reference said the skill chat verbs show an approval card "unless the
  conversation is in auto mode". Auto-approval covers tool permission prompts only: control-plane
  changes (`add_channel_skills`, `set_channel_skill_template`, …) always post a card and block for
  a click, which is the product contract. Both now say so, and the reads
  (`list_skill_templates`, `preview_skill_template`, `show_channel_skills`) are correctly
  described as open.
- **Stopping a turn now stops everything the turn started.** A container run was signalled by
  process GROUP, and Claude Code's Bash tool puts its shell in a session and a process group of its
  own — so `kill -- -<leader>` reported success, the tool's shell survived, and a loop it was
  running went on to completion minutes after the turn was reported stopped. `cg-signal` now walks
  `/proc` once before it signals anything and takes down every process in the run's session plus
  the leader's whole descendant tree (deduped by process group, then by pid), keeping its "0 when
  something was delivered" status; `cg-sweep` signals through the same helper so a boot sweep and a
  stop can never drift apart. Nothing outside the run can be in either set: the leader is its own
  session leader and a detached background job is a separate leader with its own session. Image
  spec 1.2.1 — `npm run build:image` (an update rebuilds it).
- **Connection inventory no longer starts connections, and an ambiguous account is no longer
  guessed.** Both bundled skills told the agent to confirm a toolkit through
  `COMPOSIO_MANAGE_CONNECTIONS` with `action: "list"`. That call is not side-effect-free: on a
  toolkit with no connection on the selected identity it CREATES a pending authorization request
  and answers "All connections have been initiated and are pending completion"
  (`status: "initiated"`), so a plain "what is connected?" question left pending auth requests
  behind on both identities. The side-effect-free existence check is now the identity's own
  `COMPOSIO_SEARCH_TOOLS` — `toolkit_connection_statuses[].has_active_connection` plus the entry's
  `accounts[]` aliases — and `COMPOSIO_MANAGE_CONNECTIONS` is reserved for a toolkit already known
  to be connected there or for a connection the user asked for. In the same pass, the ambiguous
  identity rule became a MUST with its reason stated: when neither a pronoun nor a single
  connection settles the account, the first response is the question and never a tool call, because
  reading a calendar, inbox, chat or CRM on a guess exposes the requester's or a third party's
  private data to the whole conversation — a bare "check the calendar" had gone straight to a
  personal calendar read.
- **A stopped run stops answering.** "🛑 Stopped." is now the last thing the thread receives.
  The live answer message is created lazily by the first append that Slack accepts, so answer text
  still queued behind the rate limiter was created and posted by the stop path's own drain — the
  full reply landed underneath the stop card, unmarked, on both engines. Queued text is now dropped
  once a run is stopped, and the stop flag is re-read immediately before every delivery call (the
  streamed finalize and the chunked fallback) instead of being sampled once several awaits earlier.
  Text that had already reached Slack stays, closed with a `🛑 _Stopped — partial answer._` marker so a
  cut-off stream is never mistaken for a finished answer.
- **Codex Read mode works inside a container again.** Codex's default sandbox mechanism is
  bubblewrap, which cannot start under the container's `--cap-drop ALL` + no-new-privileges
  (`bwrap: Unexpected capabilities but not setuid`) and failed EVERY command — so a Read-mode
  channel could not even read. Runs that state a sandbox mode now also state
  `features.use_legacy_landlock=true`, the mechanism that does work under those caps: reads
  succeed, writes get "Permission denied". The admin bypass, which has no sandbox, is unchanged.
  The flag is deprecated-but-functional in the pinned CLI (`containers/versions.json`) and is
  re-checked on every Codex bump.
- **`/context` and reply footers report the real window for 1M models.** The `[1m]` suffix names a
  configured variant the CLI does not echo back (an `opus[1m]` run reports plain `claude-opus-5`),
  and the window was read off the runtime id alone — so a 1M run was measured against 200,000, five
  times too small, inflating every context percentage by the same factor. The suffix is now read
  from the configured model as well as the runtime one, and ahead of any runtime-reported window.
- **`/resume <command or id>` can adopt a session again.** Under the container runtime a thread's
  engine transcripts live in the channel's own HOME volume, but the lookup behind `/resume` only
  ever searched the daemon's own state dirs — so pasting back the very command `/resume` had just
  printed was answered with "I can't find … on the gateway machine", and no channel had ever
  adopted a session. The lookup is now runtime-aware: it walks the stores this channel can actually
  reach, cheapest first — the daemon's engine dirs (a legacy, pre-container session), the HOME
  volume read straight off the host where that is traversable, and otherwise the container itself
  through a new read-only runtime method, `inspectState` (one `sh -c` that globs the engine's
  layout and returns each match's mtime and capped opening lines; nothing is copied out, and the
  volume is never mounted). Rootless Podman is why the last step exists: it owns the volume's own
  directory as the mapped sub-uid with mode 0700, so the daemon cannot traverse into it even though
  the transcripts inside belong to its uid. The same-channel rule is unchanged and still decides on
  the cwd the transcript itself recorded. A refusal now also names the harness the PASTED command
  named rather than the thread's (a `claude --resume` line pasted into a Codex thread was reported
  as a missing "Codex session") and says where the gateway looked.
- **Schedules are stated in a named time zone, and containers run on the gateway's clock.** The
  daemon matches cron schedules against its own local time while a channel container was built on
  `Etc/UTC`, and nothing carried the daemon's zone across that boundary — so an agent asked what
  `15 9 * * 1-5` means read its own clock and answered "9:15 UTC" for a schedule that fires 09:15
  local. The container runtime now exports the daemon's IANA zone as `TZ` into every container and
  every exec (`process.env.TZ` first, otherwise the platform's resolved zone), so `date` and both
  engines see the same wall clock as the scheduler. `create_schedule` and `list_schedules` also
  NAME the zone rather than trusting any clock: a one-time schedule reports
  "2026-09-08 09:15 Europe/Bucharest (06:15 UTC)", a recurring one adds the resolved next fire
  time, and the bundled reminder guidance tells the agent to quote that zone back instead of
  converting it.
- **A reminder no longer stutters its own label.** A reminder whose text already began
  "Reminder: …" rendered as "⏰ *Reminder:* Reminder: review the QA results". One leading label is
  now stripped before the renderer adds its own — in the posted message, the unacknowledged 2nd
  notice and the creator's DM alike; a deliberate double, or a sentence that merely mentions the
  word, is left alone.
- **API runs report what a Codex run cost instead of "free".** `GET /api/runs/:id`, the
  `api_run_done` event and the completion webhook published `costUSD: null` whenever the engine
  reported no dollar amount — which Codex never does — while the usage ledger was independently
  storing a priced estimate for the very same run. The run now publishes the figure the ledger
  settled on (the canonical component rollup where a run reported one, so the API and the Audit
  view cannot quote two different costs), marked with a new `costEstimated` flag, and keeps `null`
  only when nothing anywhere knows. A stopped-mid-flight run is billed the same way.
- **A sentence before the first tool call no longer costs the turn its toolbox.** The live progress
  card is its own message posted above the answer, so once answer text starts a card that does not
  exist yet can only be created underneath it. The guard that protected that ordering latched the
  whole card OFF for the rest of the turn, and a model that wrote one preamble line before its
  first tool call therefore lost every tool, subagent and failed-tool row — the same run with
  tools first showed the full toolbox. Only the content-free liveness pulse is suppressed now: a
  tool, subagent, notice or progress-report row still opens (or keeps) the card at any point in the
  turn, while a text-only answer still stays a single message.
- **A progress stage no longer repeats its output two or three times.** Slack replaces a task row's
  title and status on every chunk but APPENDS its rich `details`/`output`, so a stage that carried
  its output when it was published, again when it flipped to complete, and once more in the
  snapshot that seals the card rendered the same paragraph three times over. Each row now remembers
  what it has already delivered to the current message and sends a rich field only when it actually
  changed — just the added tail when the value grew (an interrupted step's note), nothing at all
  when it is unchanged. A stream rollover reseeds its successor in full, since that message has
  rendered nothing yet.
- **A rate-limited stream finalization leaves one reply, not four.** When Slack rejected
  `chat.stopStream`, the classic recovery posted the complete answer as a new message while the
  partial streamed one stayed in the thread (truncated mid-sentence, no footer) and the run-stats
  footer arrived as yet another message — four bot replies for one turn. The recovery now deletes
  that partial copy first and attaches the footer and its controls to the answer it posts, so a
  failed finalization ends with the progress card and exactly one complete answer.
- **Fresh installs get their first-boot admin password again.** `npm run setup` answers the
  voice-transcription question before the daemon has ever booted and saves it through the settings
  writer, so a brand-new install already had a `settings.json` at first boot — and the first-boot
  check, keyed on that file's existence, treated it as a configured install and never minted the
  password. Every fresh install came up with `WARNING: no admin password` and the whole privileged
  API refused. The decision now keys on what the file holds: the installer's own keys
  (`whisperEnabled`) do not count as configuration; any operator-written key still does, so an
  existing install is never handed a password behind its operator's back. Found while installing a
  third gateway on the development host.
- **The daemon boots on the documented Node floor again.** Migration 17 created the channel-memory
  search index as an FTS5 virtual table; Node 22.13's bundled SQLite has no FTS5, so the migration
  threw and the whole database refused to open. The index is now optional per engine build
  (`src/db/fts.js` probes once per handle), the migration skips it with a warning, every open
  re-attempts the creation so a later Node upgrade gains the index without a new migration, and
  `search_channel_memory` answers from a plain scan (same AND semantics, diacritic folding and
  bracketed excerpts) until then.
- **CI's settings-generator coverage floor is met again.** The skills catalog reshaped the grant
  and listing paths in `src/gateway/folders.js`; `test/folders-generator-paths.test.js` now reaches
  work-folder containment, instruction updates, the host-folder grant fallback and the legacy
  managed-skill rename, and is part of the security-coverage gate.
- **Resumed Codex replies show the current message's cost, not the whole session's.** On a cold
  runtime probe the daemon learned Podman's host-side HOME-volume path only after run artifacts
  were materialized. Codex accounting then had no rollout baseline and treated its cumulative
  terminal counter as one reply. The settled read path is now refreshed immediately after the
  container starts, before the resumed turn snapshots usage; Claude's provider-reported per-turn
  cost and the canonical descendant-aware ledger are unchanged.
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
