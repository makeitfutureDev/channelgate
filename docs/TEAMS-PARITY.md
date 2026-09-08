# Slack-to-Teams parity audit

This is an implementation audit for the unmerged `teams-ms` development branch. It is not a
release claim or evidence that Xavier has been deployed. Baseline means the code before this
branch's event/control work; branch work requires the tests and live acceptance in `TEST-PLAN.md`.
Microsoft capability declarations describe what a surface can support; they do not prove that
ChannelGate has implemented the corresponding connector or UI.

## Already shared or available in the baseline

| Slack feature | Teams state and practical limits | Implementation anchor |
| --- | --- | --- |
| DM, group and channel conversations | Supported; DM is continuous, group messages get separate sessions, quotes resume, channels retain native threads | `platforms/ingest.js`, `platforms/reply-sessions.js`, `platforms/msteams/activity.js` |
| Mention and user approval gates | Shared authorization, registration, channel access and namespaced Teams identity; Slack approval does not approve a different Teams identity | `platforms/ingest.js`, `gateway/modes.js` |
| Claude/Codex sessions, model settings and fallback | Shared runner and stores; chat controls and interactive escalation have separate surface integration requirements | `gateway/run.js`, `engines/registry.js` |
| Containers, modes, network policy and secrets | Shared runtime boundary and per-conversation settings; Teams must not inherit Slack-only foreground escalation | `runtimes/`, `gateway/modes.js` |
| Channel memory, instructions and skill grants | Same stores and managed instruction materialization; mutations requiring explicit approval still depend on an approval delivery path | `gateway/folders.js`, `gateway/channel-memory.js` |
| Personal/shared MCP routing | Shared standard MCP configuration; enterprise Composio SDK identity support remains Slack-only | `gateway/mcp.js`, `ee/` |
| Usage, engine health, event logs and admin pages | Shared backend and browser administration | `gateway/usage.js`, `web/`, `config/` |
| Formatted replies and long-answer splitting | Supported with Teams Markdown degradation and matched mention entities | `platforms/format/teams.js` |
| User name mentions | Conversation-roster lookup; unavailable roster degrades to literal text rather than invented pings | `platforms/msteams/connector.js` |
| Edit/delete bot messages | Connector methods exist; this does not mean deletion of other users' messages or Slack's whole-thread delete flow | `platforms/msteams/api.js` |
| Inbound images/files | Partial: direct downloadable attachments, Microsoft-host restrictions, bounded streaming into channel folder; not general SharePoint history retrieval | `platforms/msteams/activity.js`, `platforms/attachments.js` |
| Reminders/schedules and background results | Destination-based connector routing exists independently of Slack; actual per-surface live delivery still needs validation | `platforms/notify.js`, `gateway/scheduler.js`, `gateway/background.js` |
| Private notices | Proactive DM primitive exists; `postPrivately` refuses public fallback for sensitive links. Installation and available conversation identity can prevent DM delivery | `platforms/notify.js`, `platforms/msteams/connector.js` |
| Configured public URL and live connection controls | Shared settings with Teams endpoint generation, masked credentials, health and connect/disconnect | `config/settings.js`, `platforms/boot.js`, `web/` |

All implementation anchors in this audit are relative to `src/` unless a path explicitly names
`docs/`, `public/` or `TEST-PLAN.md`.

## This branch's requested scope

These entries describe the requested work, not a blanket assertion that every item has passed.
Consult the implementation and recorded checks before treating a row as complete.

| Feature | Intended Teams behavior | Required evidence |
| --- | --- | --- |
| Edit trigger | An actual mention in the current edited content triggers the edited message's session, with duplicate delivery suppressed | Add-first-mention and edit-existing-mention live tests; removed mentions and duplicate events do not run |
| Robot reaction | Robot reaction asks Xavier to handle the target message; reacting to its answer resumes that answer's session | Actor authorization, target scope, cached/fetched target, correct session and no duplicate execution |
| Events for user messages as well as bot replies | Explicitly installed/consented conversations only; Bot Framework coverage and Graph subscriptions are separate paths | User-authored message reaction and edit fixtures; subscription setup/renewal/failure visibility; real tenant acceptance |
| Core chat commands | Bring useful command behavior to Teams through shared stores and authority checks | Exact supported command list and regression/live tests; unsupported commands must not imply completed changes |
| Visible long-run progress | Ticking, bounded edit-based status and explicit queue/wait state | Slow and quiet Claude/Codex cases, rate-limited edits, failure/final replacement and no orphan heartbeat |

A Teams event subscription can make an event observable; it does not authorize an agent run.
The requester remains the person editing or reacting, not the target message's original author.
The current channel policy, bot installation scope and selected-account permissions still apply.

## Native additions implemented on this branch

These paths have automated fixture coverage; Microsoft tenant/client and both-engine live
acceptance remain unexecuted. They are not deployed by keeping work on `teams-ms`.

| Feature | Implemented behavior | Boundary |
| --- | --- | --- |
| Approval cards | Native Approve/Deny/Request changes with optional comment, supported scope choices, Execute and Submit fallback, verified actor identity | A changes comment refuses the current action even with Approve; escalation policy is separate |
| Session form | `/settings` opens private engine/model/effort choices through existing controls | Runtime-change authorization and active-session safeguards still apply |
| Settings and secrets | `/secrets` and the session card link to the existing authenticated admin website | No secret values or new secret-entry form in Teams |
| Workspace browser | `/files [folder]` provides private pagination and browser download/upload/text-edit links | Source workspace and current Teams membership are rechecked; no public fallback |
| Native file sending | `/sendfile <relative-path>` asks for personal-chat Accept/Decline and sends the approved file snapshot | Nonempty files up to 10 MB; ten-minute consent; bounded pending pool; manifest `supportsFiles: true` |
| Group/channel file reading | Optional Graph resolution of canonical SharePoint paths inside explicitly allowed drives | External selected-site read grants; no `/shares` route or shortlinks; redirects blocked and token isolated |
| Voice | Local Whisper transcription, cancellable work, text fallback with explicit failure notes | No Slack transcript service; unavailable downloads/Whisper do not become raw-audio engine requests |
| Concurrent attachments | A unique intake directory preserves each message/revision's bytes | Storage IDs do not change reply/session identity |

## Remaining feasible adaptations

| Slack feature | Teams gap | Next implementation slice |
| --- | --- | --- |
| Busy-thread steer/queue choice | Slack posts authenticated decision controls and handles active-run steering | Port explicit choices to text/private links or cards; preserve author checks, session identity and queue ordering |
| Background status button | Job execution/delivery is shared; Slack button callback is not | Add text status access or safe authenticated browser status links |
| Restart recovery presentation | Durable run state exists; some recovery orchestration and notification hooks remain Slack-owned | Audit and route recovery through the connector while preserving queue reservations and uncertain-outcome rules |
| On-demand history/thread reads | Built-in MCP history tools are Slack-specific | Add conversation-scoped Teams reads through a separately authorized Graph route; expose safe metadata and respect explicit message scope |
| Re-download a historical file | `slack_download_file` requires Slack file descriptors and channel membership proof | Teams-specific descriptor lookup and scoped Graph/SharePoint retrieval, using the existing confined streaming sink |
| Follow-up digests, done/reopen reactions and nudges | Delivery plumbing is shared but Slack reaction and history ingestion drive parts of tracking | Audit the tracking inputs and map explicit Teams reactions; avoid treating robot activation as digest acknowledgement |
| Scheduling acknowledgements | Shared schedules and private posts do not automatically provide Slack's interaction lifecycle | Port acknowledgement inputs, actor checks and expiry behavior independently of reaction triggering |
| App Home onboarding and channel visibility | Slack App Home has no implemented Teams home surface | Personal app/tab or concise DM onboarding backed by the same user/channel authorization |
| Membership changes and conversation metadata refresh | Slack has join/leave handlers and home refresh logic | Handle Teams membership/install/remove events to refresh safe metadata and retire subscriptions; do not infer approval from membership |
| Message shortcut/context menu actions | Slack exposes file-browser and selected-message shortcuts | A Teams message action extension would require a manifest/UI/verified invoke handler; text/quote/reaction triggers cover the immediate need |
| In-thread loop, pending tasks, context and resume controls | Stores/engine capabilities exist, but each Slack control has explicit behavior | Port controls incrementally with session-scoped tests, including synthetic keys and author permissions |

## Microsoft integration constraints and separate permission work

| Capability | Boundary to preserve |
| --- | --- |
| All-message observation | Default bot delivery is not equivalent to Slack history/reaction coverage. Declare exact installation/RSC/Graph permission prerequisites and subscription scope. No tenant-wide feed by default |
| Group/channel files | Files may live in SharePoint/OneDrive and require a distinct Graph permission path; a bot message credential is not proof of file access |
| Native file sending | Implemented personal-chat consent path requires manifest `supportsFiles: true`; this does not provide direct arbitrary group/channel uploads |
| Proactive DMs | Conversation creation can fail when installation, identity or tenant policy prevents it. Private approval links must never fall back into the group |
| Reaction shape/coverage | Validate the robot reaction's real payload and availability on desktop/mobile and user/bot messages. Unknown reactions are ignored; reaction removal is not an implicit new request |
| External/federated chats | Acceptance must include a group containing external members; successful same-tenant tests alone do not prove this works |
| Cards and dialogs | Teams supports different primitives from Block Kit; declare native capability separately from implemented dispatch/actions |
| Streaming | Existing strategy is bounded message editing. Do not replace it with a limited native streaming mode without testing long turns and each conversation kind |

Microsoft API availability and consent requirements should be verified against the current official
references linked from `docs/PLATFORMS.md` during implementation; this source-code audit is not an
independent API compatibility certification.

## Slack-specific features and useful substitutes

| Slack feature | Teams treatment |
| --- | --- |
| Ephemeral channel messages | No equivalent in the current adapter; use private DM with explicit failure, or non-sensitive public notice |
| Native Slack charts and sortable data tables | No port of Slack payloads; use generated artifacts, browser views or purpose-built cards |
| Slack Lists and canvas documents | Different Microsoft products/data models; require an explicit integration, permission and ownership decision rather than reusing Slack tools |
| Slack CSV/TSV snippet grid | Offer a downloadable artifact or separately authorized Microsoft file; not a fake native snippet |
| Slack assistant shimmering status/App Home/Block Kit modal stack | Teams-specific presentation work; edit-based status, text commands and authenticated browser flows are useful initial substitutes |
| Slack broadcasts (`@here`, `@channel`, `@everyone`) | Do not promise broad Teams mentions from plain text. No broadcast entity construction exists in the current formatter |
| Delete entire Slack thread | Teams connector can delete bot activities; do not generalize to deleting arbitrary users' messages |

## Capability descriptor accuracy checks

The branch declares native buttons/cards and file sending only alongside their implemented
handlers. `modals: false` is intentional: forms render inline in Adaptive Cards, not task-module
dialogs. `broadcast: false` remains intentional: no broad mention entity builder exists.
Reaction trigger support is separate from general reaction capability, and observing an event
never substitutes for gateway authorization. Validate capability changes against guide
materialization and the actual connector, not Microsoft platform possibilities alone.

This branch also corrects `supportsThreads()` to recognize channel ID suffixes without treating
flat `@thread.v2` group chats as native threads. Inbound normalization still uses conversation kind.

## Completion and release evidence

1. Keep this branch isolated; no beta merge, production restart or stable promotion is implied.
2. Automated fixtures must cover unauthorized events, cross-conversation IDs, webhook replay,
   duplicate Bot/Graph delivery, expired subscriptions, malformed targets and unsupported commands.
3. Live acceptance uses both Claude and Codex in personal chat, a channel and an external-member
   group: new message, quote, edit with a newly added real mention, robot reaction on user message,
   robot reaction on bot answer, repeated notification and quiet long run.
4. Record exact observed reply/session identity and event source. A fixture pass is not a live pass.
5. Remaining rows stay gaps until code, documentation and acceptance evidence substantiate them.
