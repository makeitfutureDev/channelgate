# ChannelGate — Self-hosted AI agents for Slack, Teams and Google Chat

**Run Claude Code and OpenAI Codex in team chat, with a container per conversation and control over tools, credentials and memory.**

[![License: Sustainable Use License 1.4](https://img.shields.io/badge/license-Sustainable%20Use%20License%201.4-2f6f4e)](./LICENSE.md)
[![CI](https://github.com/makeitfutureDev/channelgate/actions/workflows/ci.yml/badge.svg)](https://github.com/makeitfutureDev/channelgate/actions/workflows/ci.yml)
[![Node.js minimum version](https://img.shields.io/badge/node-%E2%89%A5%2022.13-3c873a)](./docs/COMPATIBILITY.md)
[![Chat platforms and support status](https://img.shields.io/badge/platforms-Slack%20%C2%B7%20Teams%20%C2%B7%20Google%20Chat-4a154b)](#supported-platforms-and-ai-engines)
[![AI engines and support status](https://img.shields.io/badge/engines-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenCode-8a3ffc)](#supported-platforms-and-ai-engines)

ChannelGate is a **self-hosted AI agent gateway** that brings coding, research and workflow
automation into your team's conversations. Use it as a Slack AI bot, or connect Microsoft Teams
and Google Chat. Agents can work with files, run code, use connected business apps through the
**Model Context Protocol (MCP)** and Composio, and deliver results back to the thread, within the
access you configure.

Your team works in chat. You choose the AI engine, who can use it, which tools and accounts it can
access, and where its files and persistent memory live. ChannelGate runs on your Linux host using
rootless Podman containers. Model providers still receive prompt/context, and connected apps use
their external services; see [privacy and data flow](./docs/PRIVACY-AND-DATA-FLOW.md).

**Support status:** Slack is the primary supported surface. **Microsoft Teams and Google Chat are
Beta. Composio SDK mode is Enterprise-only and Beta**; standard Composio MCP mode is available in
every tier. OpenCode is experimental and restricted to its documented read profile.

[Get started](#getting-started) · [Team benefits](#what-you-get) · [Full feature list](#full-feature-list) ·
[Use cases](#use-cases) · [License and tiers](#licensing--partners) · [Documentation](#documentation)

Formerly Claude Gateway for Slack.

## What you get

| Your team needs to… | ChannelGate provides |
| --- | --- |
| Put AI to work where decisions happen | Claude Code and Codex in chat threads, with file access, code execution and connected tools according to the channel's permissions. |
| Keep project work organized | A container, working folder, conversation history and persistent memory for each channel or DM, with separate sessions per thread. |
| Control access to tools and accounts | Approved users and channel guests, selectable permissions, MCP grants, and separate personal and shared connector identities. |
| Turn repeated requests into automation | Reusable skills, scheduled agent runs, reminders, follow-ups and background work that reports to the originating conversation. |
| Operate and inspect the deployment | A built-in admin UI, usage and cost reporting, audit history, backups and verified updates on infrastructure you control. |

## Getting started

**Requirements:** Linux, Node.js ≥ 22.13, rootless Podman, and credentials for the engine you will
use. The default Claude setup uses the daemon user's host login, a configured setup token or
`ANTHROPIC_API_KEY`; Codex requires its own authentication. See the
[installation guide](./INSTALL.md) for prerequisites and service-account setup.

```bash
git clone https://github.com/makeitfutureDev/channelgate.git
cd channelgate
npm run setup -- --without-whisper  # omit the flag to choose local voice transcription
npm start
```

The installer checks prerequisites, installs dependencies, scaffolds `.env` and builds the
container image with the engine CLIs and media tools. If the image build fails, fix the reported
prerequisite and run `npm run build:image` before sending the first prompt.

1. Open the admin UI at <http://localhost:4747>. On a new install, use the admin password printed
   once at first boot, or your configured password. The UI starts without Slack credentials.
2. Create a Slack app at <https://api.slack.com/apps> using the bundled
   [Slack app manifest](./slack-app-manifest.json). Generate an app-level token with
   `connections:write`, install the app, and copy its bot token and signing secret.
3. Paste those three values into **Settings → Save & connect**. The connection applies live.
4. In **Users**, approve the people who may talk to the bot. In **Channels**, configure the working
   folder, permissions, MCP connections and skills. Choose whether a channel admits approved members, admins only or nobody by default;
   explicit channel guest grants admit additional users. DMs require approval or admin status.
5. DM the bot, or invite it to a channel and mention it: `@channelgate summarize the files in this folder`.

For a service that starts at boot, follow the [systemd installation steps](./INSTALL.md#the-systemd-service-starts-at-boot-restarts-on-failure).
The service uses its own account and needs credentials configured for that account. For other
chat surfaces, follow the [Microsoft Teams and Google Chat setup guide](./docs/PLATFORMS.md).

## Full feature list

These are the shipped product capabilities, grouped by the work they enable. Availability depends
on the selected engine, chat platform and permissions; the [support matrix](#supported-platforms-and-ai-engines)
below makes those differences explicit. [FEATURES.md](./FEATURES.md) is the detailed engineering
catalog, including edge cases and links to regression coverage.

### Conversations and AI engines

- **Threaded sessions:** start a fresh session in a new thread and resume context in replies.
  Choose an engine and model for a thread, channel or gateway default.
- **Claude Code and OpenAI Codex:** use either engine with the same channel authorization,
  container boundary and personal/shared connector separation.
- **Model and reasoning controls:** select models and effort using Codex's live model catalog and
  Claude's rolling aliases.
  Explicit thread/run pins are respected; a pinned engine failure reports its own error.
- **Automatic fallback:** eligible failures on a default engine can fall back to the other engine with
  an announcement when replay is safe. A user's explicit engine/model pin prevents that switch.
- **Warm Claude sessions:** reuse a live process for faster follow-ups; changes to the author,
  credentials or configuration retire stale processes. Codex resumes through a new process.
- **Visible progress:** streamed answers, tool activity, subagent progress, elapsed-time
  heartbeats and queue positions keep long turns visible. Quiet stretches report their status.
- **Run controls:** stop an active turn with `/stop`, supported stop reactions or a stop message;
  steer supported active Claude sessions, queue follow-ups with `/next`, and resume afterward.
- **Session handoff:** `/resume` connects an eligible local engine session to a Slack thread
  in the same channel workspace; Claude also supports explicit context compaction.
- **Slack Assistant support:** native assistant status, a persistent progress toolbox and
  a separate answer stream keep results readable during long tasks.

### Permissions, isolation and credentials

- **A container per conversation:** every engine run, including scheduled and background agents,
  executes inside that conversation's rootless Podman container with its own persistent home.
- **Read-only, Worker and Admin modes:** choose the base permission level. Auto review and Lean
  context are separate options; permission bypass requires both an admin author and Admin mode.
- **Approval controls:** interactive approvals and automatic review apply according to mode;
  tool permissions remain separate from the container's filesystem boundary.
- **User and guest access:** select approved-member access, admins only or locked access,
  with separate use/manage controls and channel guest grants. DMs require admin or approved status.
- **Scoped MCP access:** grant external tool servers per channel and select optional engine
  integrations. A channel can opt out of inherited organization tokens.
- **Channel environment secrets:** configure credentials for tools such as provider CLIs through
  write-only settings. Names are validated, rotations retire warm sessions, and known values are
  redacted from replies and job output. Runtime access and limits are documented below.
- **Protected administration:** password sign-in, masked secret listings, password-confirmed
  reveal for eligible settings, audit records and separately scoped API access.

### MCP integrations and Composio accounts

- **Connect business apps:** use Composio's connected tools for workflows involving email,
  calendars, CRM, project management and other services available to your selected account.
- **Separate personal and shared accounts:** `composio-user` is the requester's account and
  `composio-agent` is the channel/organization account. They resolve independently on each run. DMs use only the requester's personal Composio account.
- **Explicit account selection:** “my” selects the requester's account; “your” selects the shared
  agent account. When both have the requested app and the account is ambiguous, the agent asks.
- **Custom MCP servers:** maintain an admin catalog of granted servers and non-interactive
  credentials; supported transports and optional integrations depend on the engine.
- **Enterprise SDK provisioning (Beta):** an organization Composio SDK key provisions separate
  Slack user/channel identities and reusable thread sessions. Standard MCP mode remains available
  without Enterprise entitlement.

### Persistent memory and reusable skills

- **Channel memory:** portable `MEMORY.md` and topic files retain preferences, decisions and
  project knowledge. New sessions receive a bounded catalog and retrieve relevant memory on demand.
- **Memory search and review:** full-text search with a plain-scan fallback, explicit memory
  read/write tools and a post-reply background reviewer support recall without loading every note.
- **Standing instructions:** maintain persistent channel rules alongside memory and task-specific
  skills, so recurring preferences do not depend on a single thread's context.
- **Shared skill catalog:** create, edit, import and organize reusable instructions, with
  organization, channel and personal grants plus live templates.
- **Skills in both engines:** granted skills are available to Claude and Codex. Organization and
  channel skills synchronize into the project; personal skills stay scoped to the requesting user.
- **Skill maintenance:** version history, rollback, source-revision review, change proposals,
  usage reporting, Git publishing and optional
  GitHub synchronization support repeatable team workflows. Import from GitHub, folders or peer
  gateways, and expose the catalog through its MCP endpoint. See the [skills guide](./docs/SKILLS.md).
- **Lean context:** start with reduced optional context and integrations when a task needs a
  simpler workspace; the gateway's operating guide remains available.

### Files, documents, voice and video

- **Attachments:** download supported images and documents into the channel's uploads folder;
  retrieve earlier Slack attachments on demand. Large downloads stream to disk, with a 500 MB ceiling.
- **File explorer in Slack:** the 📂 reply button opens the channel workspace with bounded previews,
  folder navigation and permission-checked editing, creation and sharing.
- **Browser editor and uploads:** with a configured public URL, open larger text files in a
  browser editor with Markdown preview and conflict checks, or upload nested folders directly
  to the workspace through short-lived, scoped links.
- **Voice prompts:** optional local Whisper transcription with Slack transcript fallback turns
  supported voice clips into text instructions. Raw audio is not passed to the coding engines.
- **Video and screen recordings:** bundled media tools and a video-analysis workflow extract
  frames and speech for the agent to inspect inside the channel workspace.
- **Browser automation:** bundled Playwright, Chromium and Chrome DevTools tooling support
  web interaction and screenshots when the channel grants the required tools.
- **Google Drive synchronization:** optionally schedule two-way synchronization between a
  channel workspace and its configured Drive folder using the connected account.
- **Deliverables:** create reports, scripts and other files in permitted modes, then browse or
  explicitly share them into the conversation. Outbound file support varies by platform.

### Scheduled automation and background work

- **Scheduled agent runs:** recurring cron and one-time schedules run tasks in the configured
  conversation and deliver results through its chat connector.
- **Reminders and follow-ups:** plain reminders can post without an AI call; acknowledgement
  reminders, pending-response digests and
  no-response nudges help teams track work that needs a reply.
- **Claude conversation loops:** `/loop` repeats a task in the same thread with configurable pacing
  and controls to inspect or cancel it.
- **Background agents and shell jobs:** delegate work beyond the foreground turn, inspect
  status and logs, and receive the result in the originating thread.
- **Recovery with explicit status:** schedules and job records persist. Detached shell jobs can
  be recovered; background agents interrupted by a daemon restart are marked interrupted.
  Completed results can retry delivery without replaying unknown tool work.
- **HTTP run API and Make.com:** trigger agent work through `POST /api/runs` or an approved,
  trusted bot posting a mention in Slack. The admin API page includes the Make.com module example,
  credential requirements and thread mapping. API runs support idempotency, status polling,
  cancellation, attachments and completion webhooks, including headless execution.

### Slack reports and collaboration

- **Native charts and data tables:** post charts and sortable/filterable tables directly in the
  current Slack conversation using the gateway bot.
- **Slack Lists and snippets:** create structured trackers and share CSV/TSV or text snippets
  through bot tools restricted to the current channel.
- **Canvases and broader Slack actions:** use the Composio Slack toolkit with the selected
  personal or shared account; these are separate from the gateway's native bot tools.
- **Channel history and thread retrieval:** read the current channel through scoped bot tools;
  broader search uses an explicitly selected connector account.
- **In-chat settings:** authorized users can manage supported conversation settings from Slack;
  each action rechecks access, and administrative capabilities retain their own checks.

### Administration, monitoring and operations

- **Built-in web admin UI:** manage users, conversations, permissions, models, MCP connections,
  secrets, skills, schedules, runtime settings and licenses. Supported connection settings apply live.
- **Usage and costs:** inspect runs by user, channel, engine and model, with tokens, Claude's
  reported cost and Codex estimates from configured rates. Estimates are not provider invoices.
- **Audit and health:** inspect event history, activity, queue state, engine availability and
  health checks, with operational detail protected by authentication.
- **Local SQLite storage:** operational records live in one WAL database; bootstrap settings
  and the MCP catalog stay in JSON, and work files and memory stay in channel folders.
- **Container lifecycle management:** persistent channel homes, image version pinning,
  idle-container reaping and configuration-aware recreation support ongoing operation.
- **Backups and maintenance:** backup/restore commands, restore drills, retention controls and
  runtime maintenance tools cover local state. See the [operations runbook](./docs/OPERATIONS.md).
- **Verified updates:** the admin UI, Slack `/update` and `npm run update` use the same locked
  update transaction with preflight checks, tests, restart verification and rollback on failure.

## Use cases

Start with the relevant files, skills and connectors enabled in a channel. These are example
requests; available accounts and permissions determine what the agent can do.

| Team workflow | Example request |
| --- | --- |
| Engineering | “Review the changes in this repository, run the relevant tests, and explain any regressions.” |
| Operations and reporting | “Read this CSV, summarize overdue items, and post a chart in this thread.” |
| Customer and project work | “Use my connected CRM account to summarize this deal and draft a follow-up for review.” |
| Recurring team updates | “Every Monday at 09:00, summarize the project files and post an update here.” |
| Process documentation | “Review this screen recording and write a step-by-step guide in the workspace.” |

## Supported platforms and AI engines

| Chat platform | Status | Connection and scope |
| --- | --- | --- |
| **Slack** | Primary supported surface | Socket Mode; channels, private channels, DMs and group DMs, native streaming, Assistant UI, file browser and bot artifacts. |
| **Microsoft Teams** | Beta | Bot Framework over public HTTPS; core conversations with a smaller in-chat feature set and attachment limits. |
| **Google Chat** | Beta | Outbound Pub/Sub pull; spaces and DMs, with platform-specific threading and attachment limits. |

Teams and Google Chat transports have automated coverage; live-tenant validation remains a
release gate. They do not provide every Slack interaction or artifact. See
[what works where and setup requirements](./docs/PLATFORMS.md#what-works-where).

| AI engine | Status | Session and feature differences |
| --- | --- | --- |
| **Claude Code** | Default engine | Warm processes, thread resume, steering, skills, MCP tools and provider-reported cost. |
| **OpenAI Codex** | Supported engine | Fresh process per turn with thread resume, skills, MCP tools, token usage and configured cost estimates. |
| **OpenCode** | Experimental | Restricted workspace read profile; shell, edits, external tools/MCP and bypass modes are unavailable. |

Claude and Codex versions are pinned in the runtime image. Check the [compatibility matrix](./docs/COMPATIBILITY.md),
[engine capabilities](./docs/ENGINE-CAPABILITIES.md) and [OpenCode restrictions](./docs/OPENCODE-ADAPTER.md)
before choosing a deployment profile.

## How it works

```text
Chat message or API/scheduled task
  → authenticate, authorize and resolve the conversation
  → select the engine, model, permissions and tool identities
  → start or reuse the conversation's rootless Podman container
  → resume the thread's agent session with scoped files, skills and memory tools
  → stream progress and deliver a chat reply or API result
  → record usage and outcome locally
```

The **conversation owns the workspace and container**; the **thread owns the agent session**.
Channels on different chat platforms have distinct identifiers and folder paths. Every foreground,
background and scheduled engine run uses the same runtime boundary.

## Security and data privacy

1. **Containers establish the default boundary.** Each conversation gets its own home and declared
   work/runtime mounts. Other channel workspaces and the operator's home are excluded by default.
   An explicit, off-by-default Full-access home-sharing option exposes the operator's whole home
   to admitted authors in those channels; choose shared work folders and this option deliberately.
2. **Network access is not an egress firewall.** Containers use bridge networking. The
   *Allow network* switch communicates policy to the engines; there is no domain filtering or
   container-level egress cut-off in this release.
3. **Usable credentials have runtime exposure.** Claude's host credentials file is never copied
   or mounted; runs receive a relay of its access token or a configured credential. Codex's host
   sign-in file is shared with its containers while sessions stay per channel. Protected transient
   MCP artifacts can contain credentials. Channel environment secrets have no reveal endpoint,
   but an agent using them can access their runtime values; masking and redaction are not a vault.
4. **Authorization is checked before a run.** Channel use/manage policies and guest grants are
   enforced; unknown users without a guest grant are denied, and DMs require approval or admin status. Admin bypass needs an admin author and Admin mode. API callers cannot
   claim personal connector identities or widen a channel's durable tool permissions.
5. **Self-hosted storage still uses external AI services.** Configuration, sessions, work files,
   usage and audit records are local. Prompt/context goes to the selected model provider; enabled
   chat and connector services receive their requests/content. License verification sends the key.

Read the [privacy and data-flow guide](./docs/PRIVACY-AND-DATA-FLOW.md) for the full boundary and
operator responsibilities, and [SECURITY.md](./SECURITY.md) for vulnerability reporting.

## Deployment tradeoffs

ChannelGate fits teams that want control over their agent workspaces, tool access and operational
records and can run a Linux host. You maintain the host, rootless Podman, backups and credentials.
Model subscriptions/API charges and connected-service terms are separate from ChannelGate's
license. See [why teams choose a self-hosted agent gateway](./docs/WHY.md) for more context.

## Licensing & partners

**ChannelGate is source-available fair-code**, licensed under the
[Makeitfuture Sustainable Use License](./LICENSE.md) (v1.4) for internal business, personal, and
noncommercial use. It is not OSI open-source software, and no version
is relicensed automatically.

| | Conversations | AI messages per conversation per month |
| --- | --- | --- |
| **No key** — install and run | 1 | 500 |
| **Free key** — an account with your email | unlimited | 500 |
| **Enterprise key** — agreement with Makeitfuture | unlimited | unlimited |

A free key (an account with your email) lifts the one-conversation limit; the ceiling then stays at
500 AI messages per conversation per month, and an enterprise key removes both. A key belongs to the
organization that operates the deployment, and security features are identical in every tier.
Definitions, the offline grace period, and exactly what a deployment reports are in
[`docs/LICENSE-KEYS.md`](./docs/LICENSE-KEYS.md).

- **Free — run it yourself.** Any team size, any number of channels with a free key, on your own
  infrastructure. Modify SUL-covered code within the license; the EE directory has separate contribution and
  redistribution conditions. There is no obligation to publish internal modifications.
- **Partner — operate it for clients.** Installing, configuring, supporting or running a **dedicated
  deployment for one client** and charging for that work is permitted with no agreement, for any
  number of clients, as long as each deployment runs on **that client's own key**. An optional
  *Partner Agreement* adds listing, co-marketing and priority support.
- **Reseller, white-label, enterprise — sell it.** Paid hosting, one deployment serving several
  customers, rebranding it as your own or a client's product, reselling it or its keys, per-seat
  fees, or a commercial product whose value derives substantially from the gateway each require a
  written agreement with Makeitfuture: `contact@makeitfuture.com`.

Worked examples — including the agency and managed-service cases — are in the
[licensing FAQ](./docs/LICENSING-FAQ.md); the one-page plain-language summary is
[`docs/LICENSING-SUMMARY.md`](./docs/LICENSING-SUMMARY.md); trademark guidance is in
[`TRADEMARK.md`](./TRADEMARK.md). Contributions are accepted under [`CLA.md`](./CLA.md) with a
`Signed-off-by` trailer (`git commit -s`).

## Want it installed and operated for you?

**Makeitfuture builds and runs ChannelGate deployments** — the chat app, the channels, the
containers, the tool allowlist and the admin handover, on infrastructure you own.
[**Book a discovery call**](mailto:contact@makeitfuture.com?subject=ChannelGate%20discovery%20call)
or read the product pages at
[channelgate.dev](https://channelgate.dev/?utm_source=github&utm_medium=readme&utm_campaign=channelgate).

Agency or MSP deploying it for clients? The partner lanes — listing, co-marketing, reseller and
white-label — are described at
[channelgate.dev/partners](https://channelgate.dev/partners?utm_source=github&utm_medium=readme&utm_campaign=channelgate).

## Documentation

| Guide | What it covers |
| --- | --- |
| [Installation](./INSTALL.md) | Prerequisites, Slack app setup, engine credentials and systemd service installation |
| [Full engineering feature catalog](./FEATURES.md) | Shipped capabilities, detailed behavior and regression references |
| [Operations runbook](./docs/OPERATIONS.md) | Containers, updates, backups, restore, retention and troubleshooting |
| [Chat platforms](./docs/PLATFORMS.md) | Slack, Teams and Google Chat setup, support status and feature differences |
| [Engine capabilities](./docs/ENGINE-CAPABILITIES.md) | Claude and Codex execution, permissions, integrations and usage reporting |
| [Compatibility](./docs/COMPATIBILITY.md) | Linux, Node.js, CLI versions and release gates |
| [Skills](./docs/SKILLS.md) | Catalog, grants, templates, importing and publishing reusable workflows |
| [Privacy and data flow](./docs/PRIVACY-AND-DATA-FLOW.md) | Storage, external requests, credentials and trust boundaries |
| [Licensing summary](./docs/LICENSING-SUMMARY.md) | License terms and commercial deployment options |
| [Changelog](./CHANGELOG.md) | Release history |
| [Contributing](./CONTRIBUTING.md) | Isolated worktrees, checks, pull requests and commit sign-offs |
| [Test plan](./TEST-PLAN.md) | Automated regression coverage and reproducible live acceptance cases |
| [Support](./SUPPORT.md) | Where to ask questions and report issues |

Contributor and coding-agent instructions live in [AGENTS.md](./AGENTS.md).

## Configuration and local storage

Operational data lives in `~/.channelgate/gateway.db`: users, channels, sessions, schedules,
background jobs, usage and events. Settings in `~/.channelgate/config/settings.json` override
`.env`; `mcp-catalog.json` holds the admin's MCP catalog. Legacy user/channel JSON files are
import-only backups, not live stores.

Work files live in `~/ChannelGate/<platform>/<slug>/` or the channel's custom working folder.
Generated channel configuration lives under `~/.channelgate/channels/<platform>/<slug>/`, and container homes
persist in per-channel Podman volumes. `CHANNELGATE_DIR` and `CG_WORKSPACE_DIR` override the
runtime and workspace roots. Keep runtime credentials and bootstrap configuration private.

See [.env.example](./.env.example) for environment settings and the
[operations runbook](./docs/OPERATIONS.md) for migration, maintenance and recovery. `SESSION_KEEPALIVE`
controls idle warm-session reuse; `COMMAND_TIMEOUT` controls quiet-run reporting cadence, not a
maximum runtime. Upgrades from the former gateway layout migrate at first boot; preview with
`node scripts/migrate-channelgate.mjs --dry-run`.
