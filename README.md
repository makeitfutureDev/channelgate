# ChannelGate

**The governed AI agent gateway for your Slack, Microsoft Teams and Google Chat channels — Claude Code and Codex, a container per conversation, self-hosted.**

[![License: Sustainable Use License 1.2](https://img.shields.io/badge/license-Sustainable%20Use%20License%201.2-2f6f4e)](./LICENSE.md)
[![CI](https://github.com/makeitfutureDev/channelgate/actions/workflows/ci.yml/badge.svg)](https://github.com/makeitfutureDev/channelgate/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-3c873a)](./docs/COMPATIBILITY.md)
[![Platforms](https://img.shields.io/badge/platforms-Slack%20%C2%B7%20Teams%20%C2%B7%20Google%20Chat-4a154b)](./docs/COMPATIBILITY.md)
[![Engines](https://img.shields.io/badge/engines-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenCode-8a3ffc)](./docs/ENGINE-CAPABILITIES.md)

ChannelGate (formerly Claude Gateway for Slack) is a self-hosted daemon that runs a real
coding-grade agent — Claude Code or OpenAI Codex — inside the channels your team already talks in.
Every conversation gets its own gated folder: the filesystem is confined to it, only the MCP servers
that channel was granted are reachable, and the harness's global memory is off. Nothing sits between
your chat and the model except a process you run — no vendor platform in the middle, no per-seat
subscription, and no shared workspace where one channel can read another's files.

<!-- DEMO — PLACEHOLDER, do not commit a stand-in image.
     A 45-second screen capture (mention the bot → live checklist → streamed reply in the thread)
     belongs at docs/assets/demo.gif. When it exists, replace the note below with:
         ![ChannelGate answering in a Slack thread](docs/assets/demo.gif)
     Capture spec and the second expected asset: docs/assets/README.md. -->

> **Demo:** a 45-second GIF is expected at `docs/assets/demo.gif` and is not in the repository yet.
> The capture spec is in [`docs/assets/README.md`](./docs/assets/README.md).

## Running in 10 minutes

1. **Check the prerequisites.** Node.js ≥ 22.13 and the `claude` CLI installed *and* authenticated
   on the machine (`claude --version` must work). Codex is optional — details in
   [INSTALL.md](./INSTALL.md).
2. **Get the code and run the installer.**
   ```bash
   git clone https://github.com/makeitfutureDev/channelgate.git
   cd channelgate
   npm run setup            # add -- --without-whisper for a lightweight server install
   ```
   It checks prerequisites, installs dependencies, and scaffolds `.env`; then install the systemd
   service with `sudo bash scripts/install-systemd.sh`.
3. **Create the Slack app from the bundled manifest.** <https://api.slack.com/apps> → *Create New
   App* → *From a manifest* → paste [`slack-app-manifest.json`](./slack-app-manifest.json). Then
   generate an app-level token with `connections:write`, install the app, and copy the bot token and
   signing secret.
4. **Start it and open the admin UI** at <http://localhost:4747> (`npm start` if you skipped the
   service). It boots without Slack tokens.
5. **Paste the three tokens** in **Settings → Save & connect**. The gateway connects live — no
   restart, and no need to touch `.env`.
6. **Approve people and channels.** **Users** → approve who may talk to the bot; **Channels** →
   grant allowed users, MCP servers, skills, and the channel mode. New channels are fail-closed.
7. **Use it.** DM the bot, or `/invite` it to a channel and `@mention` it. The full walkthrough,
   including Linux service setup, backups and troubleshooting, is in [INSTALL.md](./INSTALL.md).

## What you get

| Capability | What it means |
| --- | --- |
| **Per-conversation container** | Each channel and DM runs in its own container with its own gated folder — its own home, only that folder mounted, the MCP allowlist enforced with `--strict-mcp-config`, persistent harness memory off. |
| **Dual Composio identities** | The message author's personal account is injected as `composio-user` and the channel/organization account separately as `composio`, resolved per run. User A's token never serves User B. |
| **Warm sessions** | A thread's agent process stays alive (default 10 min, `SESSION_KEEPALIVE`) so follow-ups answer without a cold start, and relaunches transparently when a different author replies. |
| **Threads are sessions** | A new thread starts a fresh session; replies resume it. The thread is the unit of context, and each thread can pin its own engine and model. |
| **Channel memory** | A budgeted `MEMORY.md` index plus `memory/<topic>.md` files inside the channel's own folder, injected at session start and reviewed after each reply. Folder-scoped, so nothing bleeds between channels. |
| **Schedules and background jobs** | Recurring cron and one-time "run at" schedules, acknowledgement reminders, and long jobs that run daemon-side and report back into the original thread — surviving a daemon restart. |
| **Native charts, Lists and canvases** | Charts, Slack Lists, file snippets and canvases are posted with the gateway's own bot token, hard-scoped to the current channel; broader Slack actions go through the Composio Slack toolkit. |
| **Three chat platforms** | Slack (GA), Microsoft Teams and Google Chat behind one declared capability contract. Replies are degraded per surface on the way out, so the model writes one dialect. |
| **Three harnesses** | Claude Code by default and OpenAI Codex behind the same gates, with an announced Claude → Codex fallback on usage limits. OpenCode is a proof third engine, restricted to a read-only, network-off profile. |
| **Admin UI and ledger** | A built-in web UI for channels, users, MCP grants, skills, modes, schedules and tokens, plus a per-run usage ledger (who, where, engine, model, tokens, cost). Changes apply on the next message. |

## How it works

```
Slack (Socket Mode)
  → gate: DM = no mention needed · channel/group/private = require @bot mention
  → authorize author against the channel's allowedUsers (fail-closed)
  → ensure ~/.channelgate/channels/<platform>/<slug>/ (MCP allowlist + memory off) and the channel's own container
  → resolve the thread's Claude session (warm process if alive, else resume)
  → spawn claude with --mcp-config (channel servers + personal/shared Composio identities),
    --strict-mcp-config, and --dangerously-skip-permissions only for admins
  → stream the reply back into the Slack thread
```

- **Per-conversation isolation** (the `channelgate` skill): each folder gets a
  `.claude/settings.json` that confines the filesystem to that folder, disables persistent
  memory, and allows only the channel's granted MCP tools.
- **Warm sessions**: a thread's `claude` process stays alive (default 10 min idle,
  `SESSION_KEEPALIVE`) so follow-ups reply fast without a cold restart. A different author
  posting in the same thread transparently relaunches with their own personal token while retaining
  the channel/org shared connection — User A's token never serves User B.
- **Thread = conversation**: a new Slack thread starts a fresh Claude session; replies resume it.

## How it compares

| | ChannelGate | Slack's built-in AI | Hosted AI bots | Build it yourself |
| --- | --- | --- | --- | --- |
| Data stays on your infrastructure | ✅ | ❌ | ❌ | ✅ |
| Container per conversation | ✅ | ➖ | ➖ | ❌ |
| Choice of agent harness | ✅ | ❌ | ➖ | ✅ |
| Works in Slack, Microsoft Teams and Google Chat | ✅ | ❌ | ➖ | ➖ |
| No per-seat SaaS fee | ✅ | ❌ | ❌ | ✅ |
| Needs a server you run | ✅ | ❌ | ❌ | ✅ |

✅ yes · ➖ partly, or vendor-defined · ❌ no. The last row is a cost, not a feature: ChannelGate
needs a machine you own and keep patched, which the hosted options do not.

> The three comparison columns are **generalisations** about categories of product, not claims about
> any specific one, and the category moves quickly. Check the current terms of the product you are
> actually evaluating. The longer, sourced comparison is in [`docs/WHY.md`](./docs/WHY.md).

## Security in five bullets

1. **A container per conversation.** Every channel runs its agent inside its own rootless
   container — its own home, only that channel's folder mounted — and the folder's lockdown
   (automatic memory and dreaming off, a curated permission allowlist) is generated before the
   agent starts. What happens in a client channel cannot read or write the finance channel.
2. **An explicit tool allowlist.** Only the MCP servers a channel was granted are reachable, passed
   per run with `--strict-mcp-config` — a runtime boundary, not a prompt instruction.
3. **Credentials are personal and never at rest in a channel.** Tokens are resolved per run and
   injected only into their named MCP connection; they are never written into a channel folder and
   never logged. Listing APIs return `has*`/`last4` only — a secret is revealed one at a time,
   behind a re-check of the admin password, and the reveal is audit-logged without the value.
4. **Authorization fails closed.** Unknown or un-approved people are denied everywhere, including
   DMs; channels start with nobody allowed. `--dangerously-skip-permissions` requires an admin
   author **and** an admin-mode channel — everyone else runs the folder's allowlist.
5. **Nothing in the middle.** Chat events arrive over Socket Mode, the prompt and any explicitly
   downloaded attachments go to the local CLI, and the CLI talks to its own model provider. Config,
   sessions, usage and audit events stay in local SQLite. Retention, backups and connected apps are
   the operator's to set — the full description is in
   [`docs/PRIVACY-AND-DATA-FLOW.md`](./docs/PRIVACY-AND-DATA-FLOW.md).

## Licensing & partners

**ChannelGate is source-available fair-code**, licensed under the
[Makeitfuture Sustainable Use License](./LICENSE.md) (v1.2) for internal business, personal, and
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
  infrastructure. Modify it however you like; there is no obligation to publish your changes.
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
[makeitfuture.com/channelgate](https://makeitfuture.com/channelgate/?utm_source=github&utm_medium=readme&utm_campaign=channelgate).

Agency or MSP deploying it for clients? The partner lanes — listing, co-marketing, reseller and
white-label — are described at
[makeitfuture.com/channelgate/partners](https://makeitfuture.com/channelgate/partners.html?utm_source=github&utm_medium=readme&utm_campaign=channelgate).

## Documentation

| Document | What it covers |
| --- | --- |
| [INSTALL.md](./INSTALL.md) | Installing on a fresh Linux host, the Slack app, backups, troubleshooting |
| [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) | The runbook: backup/restore, updates, health, incident handling |
| [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md) | Supported OS, Node, CLI and SQLite versions, and the release gates |
| [`docs/WHY.md`](./docs/WHY.md) | The product story: what it is, who it is for, how it compares, feature rationale |
| [`docs/PRIVACY-AND-DATA-FLOW.md`](./docs/PRIVACY-AND-DATA-FLOW.md) | What data moves where, and what the operator is responsible for |
| [`docs/LICENSING-SUMMARY.md`](./docs/LICENSING-SUMMARY.md) | Licensing in one page, in plain language |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to propose and land a change, and the sign-off requirement |
| [SUPPORT.md](./SUPPORT.md) | Where to ask, in order |
| [SECURITY.md](./SECURITY.md) | Reporting a vulnerability, and the dependency-advisory policy |

> Agent/contributor instructions live in **[AGENTS.md](./AGENTS.md)** (the canonical context
> file; `CLAUDE.md` / `GEMINI.md` / `HERMES.md` symlink to it). Shipped features are in
> **[FEATURES.md](./FEATURES.md)**, the build roadmap is maintained privately, and the
> regression in **[TEST-PLAN.md](./TEST-PLAN.md)**.

## Prerequisites

- **Node.js ≥ 22.13** (uses the built-in `node:sqlite`, stable from 22.13, plus
  `process.loadEnvFile`).
- **`claude` CLI installed and authenticated** on this machine (`claude --version` must work).
  The daemon spawns it directly; auth is whatever the CLI already uses (login or
  `ANTHROPIC_API_KEY`).
- **Rootless Podman** (Linux) — every channel's engines run in a container of that channel's own,
  and the daemon refuses to boot without a container CLI: `sudo apt install podman uidmap`, then
  `npm run build:image` once the code is in place (see
  [`docs/OPERATIONS.md`](./docs/OPERATIONS.md#container-runtime)).
- A **Slack app** in Socket Mode (below).

## Slack app setup (Socket Mode)

**Fastest path — create from the bundled manifest:**

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest** → pick your
   workspace → paste the contents of [`slack-app-manifest.json`](./slack-app-manifest.json)
   (it already has Socket Mode, all scopes, and all events) → Create.
2. **Basic Information** → **App-Level Tokens** → generate a token with `connections:write`
   → `SLACK_APP_TOKEN` (`xapp-…`).
3. **Install App** → install to the workspace → copy the **Bot User OAuth Token**
   → `SLACK_BOT_TOKEN` (`xoxb-…`).
4. **Basic Information** → copy the **Signing Secret** → `SLACK_SIGNING_SECRET`.
5. Invite the bot to channels (`/invite @channelgate`) or DM it directly.

When upgrading an existing Slack app, apply the latest `slack-app-manifest.json` and reinstall it
to activate newly registered commands/shortcuts such as `/files`. The in-message `@bot /files`
fallback works without registering the slash command.

> **You don't have to touch `.env` for the tokens.** Start the daemon, open the admin UI →
> **Settings** tab, paste the three tokens, and click **Save & connect** — they're stored in
> `~/.channelgate/config/settings.json` and the gateway connects to Slack live (no restart).
> `.env` still works and is handy for headless/server deploys.

<details>
<summary>Manual setup (equivalent to the manifest)</summary>

1. Create an app at <https://api.slack.com/apps> (from scratch).
2. **Socket Mode** → enable. Generate an **App-Level Token** with `connections:write`
   → `SLACK_APP_TOKEN` (`xapp-…`).
3. **OAuth & Permissions** → Bot Token Scopes:
   `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`,
   `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`.
4. **Event Subscriptions** → subscribe to bot events:
   `message.channels`, `message.groups`, `message.im`, `message.mpim`, `app_mention`.
5. Install to the workspace → copy the **Bot User OAuth Token** → `SLACK_BOT_TOKEN` (`xoxb-…`).
6. Copy the **Signing Secret** (Basic Information) → `SLACK_SIGNING_SECRET`.
7. Invite the bot to channels you want it in. DM it directly for 1:1 use.

</details>

## Install & run

> **Setting it up on a new machine?** See **[INSTALL.md](./INSTALL.md)** — or just clone and run
> `npm run setup` (checks prerequisites, installs dependencies, asks whether to provision local
> Whisper + its multilingual model, and scaffolds `.env`; the systemd service is one `sudo` step after).
> Choosing local Whisper downloads about 1.5 GiB for `large-v3-turbo`; server installs can skip it.

```bash
npm run setup            # one-command install (recommended)
npm run setup -- --without-whisper  # unattended/lightweight server install
# — or manually —
npm install
cp .env.example .env     # optional — or set tokens later in the admin Settings tab
npm start                # or: npm run dev  (watch mode)
```

- Admin UI + health: <http://localhost:4747> (set `PORT` to change).
- Without Slack tokens the daemon still boots and serves the admin UI — open **Settings** to
  paste tokens and connect. Settings saved in the UI live in
  `~/.channelgate/config/settings.json` and **override** `.env`.

## Updating safely

Admins can update from Slack `/update`, the `update_gateway` gateway tool, the dashboard, or:

```bash
npm run update
```

All paths use one locked transaction. Before changing the checkout, it verifies Git/upstream,
runtime/configuration, active systemd service, calculated free space, current health, and
a real Claude turn in a temporary gated folder. The candidate must pass exact dependency install,
the production security-advisory gate, all tests, restart on the expected revision, Slack reconnect
when applicable, and another isolated Claude turn.

If a post-change gate fails, the runner restores the prior Git revision and lockfile dependencies,
restarts, and checks the restored build. Status and recovery material:

- `~/.channelgate/update-state.json` — sanitized durable phase/result (`updated`,
  `rolled_back`, `refused`, or `failed`);
- `~/.channelgate/logs/update.log` — updater log;
- `~/.channelgate/update-backups/<transaction>/` — local config/SQLite/operator snapshot.

Snapshots are not automatically written back during rollback, because that could erase live
runtime writes. Dependency severity policy and reviewed exceptions are in [SECURITY.md](./SECURITY.md).

## Admin UI

Open the admin page and:

- **Channels** — every conversation the bot has seen. Per channel, grant **allowed users**,
  **allowed MCPs** (from the catalog), **skills**, and toggle **admin mode** (lets admin
  authors use dangerous permissions there). New channels are **fail-closed** — nobody outside a
  DM gets a reply until you add them. A channel Composio token backs the agent's own account
  (`composio-agent`) without replacing the active user's `composio-user`.
- **Users** — set each Slack user's **Composio token** (write-only; injected only into their own
  messages) and **admin** flag. Users are auto-recorded the first time they message the bot.

Changes are written to disk and take effect on the **next message** — no restart.

### Make.com automations

The Admin UI's **API** page documents both supported Make.com paths: call `POST /api/runs`
directly, or use `slack:CreateMessage` to post a visible Slack message that triggers the gateway bot. The
Slack path includes the verified module blueprint (member IDs are placeholders — use your own
workspace's). Its key requirements are a saved `<@BOT_MEMBER_ID>` mention of your bot, an approved Make bot user, a trusted Make app/bot identity,
both apps in the destination channel, and the root-thread fallback
`{{ifempty(62.thread_ts; 62.ts)}}` (with the source module number adjusted for the scenario).

## Engine: Claude or Codex

The gateway can drive either **Claude Code** (default) or the **OpenAI Codex CLI**, set globally
in the admin **Settings** tab (`engine: claude | codex`).

- **Claude** — full feature set: warm sessions (10-min keepalive), per-channel skills, exact $
  cost, `.claude` lockdown, `--mcp-config`.
- **Codex** — uses `codex exec --json` + `codex exec resume`. Works: thread resume, per-channel
  folder (`-C`), admin vs non-admin permissions (`--dangerously-bypass-approvals-and-sandbox` vs
  `-s read-only`), both Composio identities (bridged to stdio via `npx mcp-remote`), images (`-i`), token counts,
  stop, the progress animation/log. **Caveats for Codex:** no warm sessions (each message
  cold-resumes), no skills (Codex uses `AGENTS.md`, not `SKILL.md`), token counts but **no $
  cost**, and `codex` must be authenticated on the machine (`codex login` / `OPENAI_API_KEY`).

Per-channel settings (allowed users, workDir, shared Composio token, adminMode) and all Slack behaviour
apply to whichever engine is selected. The full per-engine capability matrix is in
[`docs/ENGINE-CAPABILITIES.md`](./docs/ENGINE-CAPABILITIES.md).

## Configuration (on disk, the single source of truth)

Everything lives under `~/.channelgate/` (override with `CHANNELGATE_DIR`):

```
~/.channelgate/
├── config/
│   ├── users.json            # { "<slackUserId>": { name, composioToken, isAdmin } }
│   ├── channels.json         # index: { "<channelId>": { slug, name, type, isDM } }
│   └── mcp-catalog.json       # shared MCP servers admins can grant per channel (see below)
├── channels/<platform>/<slug>/   # <platform> = slack | teams | google-chat
│   ├── .claude/settings.json # the gateway lockdown (generated)
│   ├── .claude/skills/       # granted skills, copied in
│   ├── meta.json             # { allowedUsers[], allowedMcps[], skills[], adminMode }
│   └── sessions.json         # thread_ts → claude session id
└── logs/runs-YYYY-MM-DD.log  # one JSON line per run (no secrets)
```

Each channel's **working folder** — where the agent actually runs — is the visible
`~/ChannelGate/<platform>/<slug>/` (override the root with `CG_WORKSPACE_DIR`), or a custom
per-channel folder when one is set. The platform component comes from the channel's own record,
so a Slack `#ops` and a Teams "Ops" never share a folder.

> Upgrading from *Claude Gateway for Slack*? The first boot migrates `~/.claude-gateway/` →
> `~/.channelgate/` and `~/Slack Agent/<slug>/` → `~/ChannelGate/<platform>/<slug>/`, rewrites the
> stored paths, and regenerates every channel's lockdown file. Preview it with
> `node scripts/migrate-channelgate.mjs --dry-run`. `CLAUDE_GATEWAY_DIR` / `CLAUDE_GATEWAY_DB` are
> still honoured (with a deprecation warning) for one major.

### Composio identities

Composio is built in with two stable MCP names, so no catalog entry is needed. Settings →
Integrations selects one organization-wide provisioning mode:

- **Personal:** `composio-user` uses only the active message author's personal token; `composio`
  uses the channel token, otherwise the organization default when allowed.
- **SDK:** one write-only organization SDK key provisions a stable Composio identity for each
  Slack user and channel. Each Slack thread gets a reusable Composio session for both identities.
  Users can manage their own personal connections; shared connection management follows the
  channel's existing managing-rights policy.

Both identities are resolved independently and the names are self-describing in every tool call:
`composio-agent` is the agent's OWN account (backed by the channel token, else the organization
default — the model is never told which), `composio-user` is the requester's personal account.
“Verify my email” → `composio-user`; “verify your email” → `composio-agent`. With no pronoun the
agent uses the only account that has the app connected (and says so), asks when both do, and never
silently substitutes the other account when an explicitly requested connection is unavailable. A
DM injects only `composio-user` — there is no agent account in a one-to-one conversation.
Switching modes never clears the saved personal, channel, organization, or SDK credentials.

To offer **additional shared**
MCP servers for channels to grant, add entries to `config/mcp-catalog.json`:

```json
{
  "my-http-server": {
    "label": "My API",
    "allowMatch": { "serverUrl": "https://api.example.com/mcp*" },
    "server": { "type": "http", "url": "https://api.example.com/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

Headless runs can't do interactive OAuth, so shared servers should use **non-interactive auth**
(a header token) — same as Composio's `x-consumer-api-key`.

## Security model

- **A container per conversation** (rootless Podman, required): every channel's engines run inside
  a long-lived container of that channel's own — its own HOME volume (CLI logins, installed tools,
  sessions), its own process namespace, and only the channel's work folder mounted from the host.
  The operator's home (`~/.ssh`, credentials), the gateway root (other channels, the token config)
  and other channels' folders do not exist on that side of the boundary. Admin channels run in
  containers too; an admin channel whose work folder is a host directory sees that directory and
  nothing beside it. The daemon refuses to boot without a container CLI; see
  [`docs/OPERATIONS.md`](./docs/OPERATIONS.md#container-runtime).
- **Network**: every container is on the bridge network. The per-channel *Allow network* switch
  tells the engines whether the channel is meant to have network (Codex read mode refuses it on
  its own); there is no per-domain filtering and, in this release, no egress cut-off — the boundary
  is the filesystem and the process namespace, not egress.
- **MCP**: only the channel's allowlist is reachable; the per-run config is passed with
  `--strict-mcp-config`. Verify with `claude mcp list` inside a channel folder.
- **Memory**: `autoMemoryEnabled` / `autoDreamEnabled` are off for every channel folder. The
  gateway's own channel memory (a budgeted `MEMORY.md` index + `memory/<topic>.md`, saved through
  the `update_channel_memory` tool, injected into every fresh session, backed by a post-reply
  background review) stays inside the folder — see FEATURES.md.
- **Composio credentials**: Personal-mode user/channel/org tokens are resolved per run and injected
  only into their named MCP connection. In SDK mode, the organization key stays in gateway settings;
  Claude and Codex receive only local bridge definitions for session-scoped MCP endpoints. Neither
  credentials nor session URLs are written into a channel folder or logged.
- **Dangerous permissions**: `--dangerously-skip-permissions` is passed only when the author is
  an admin **and** the channel has admin mode on. Non-admins run a read-only-ish allowlist
  (no Bash/Write auto-approval, and headless can't answer prompts).
- **Who can talk**: a user is allowed if they're an **admin** or **approved** (on the
  MakeItFuture list). Approved users can talk in any channel they're a member of and in their
  DM. Unknown/un-approved people are denied **everywhere, including DMs** — approve them in the
  admin UI → **Users** tab, or add them as a per-channel guest via that channel's allowed users.
  (Seeded MIF roster users are pre-approved.)
- **Images & files**: attach an image (or PDF/file) in Slack and the bot downloads it into the
  channel's gated folder and reads it (images render visually via Claude's Read tool).
- **Voice prompts**: attach a voice clip and trigger the bot normally—`@mention` it in a channel,
  react 🤖 to the message, or send it in a DM. With **Use local Whisper** enabled, the gateway tries
  pinned `whisper.cpp` + multilingual `large-v3-turbo` first. When disabled or unavailable, it reads
  Slack's completed transcript (including the full VTT for longer clips). If Slack has not generated
  one, click **Generate transcript**, then mention the bot again or react 🤖. Typed text remains the
  instructions; raw audio is never passed to Claude or Codex.
- **Browse channel files**: `/files` opens a native Slack modal for the channel's working folder;
  use the *Browse channel files* message shortcut (or `@bot /files`) to retain a specific thread.
  Protected gateway/credential/key paths are visible but read-only. A bounded preview never changes the real
  file. Sharing to the channel/thread or privately to your bot DM requires explicit confirmation and
  is capped at 25 MB. In Worker/Auto modes, *New file* exclusively creates a confined UTF-8 text
  file without replacing an existing item, and *New folder* creates a confined directory. With a
  configured public URL, the single *Upload files / folder* action opens a secured browser picker
  for up to 200 files / 250 MB total while preserving nested paths; files go directly into the
  gateway folder without using Slack file storage, and existing items are never overwritten.
  Eligible UTF-8 text files—including `.env*`, JSON/YAML/TOML, scripts, configs, and extensionless
  files—can open through the configured public gateway
  URL in a full browser editor (up to 250,000 characters / 1 MB, with a live Markdown preview and
  conflict check); binary/invalid UTF-8 and remaining protected paths stay read-only, while Full mode
  file changes remain admin-only. Browser links are short-lived, one-use,
  and scoped to the selected file or folder. With no public URL, the 3,000-character Slack editor remains.
- **Stopping a run**: three ways, all interrupt the in-flight answer (kill that thread's Claude
  process, clear the status; the next message resumes):
  - **`/stop`** slash command — works in channels and regular DMs.
  - **React** with 🛑 / ✋ / ❌ on any message in the thread — the reliable way in the **Assistant
    pane**, where the composer is locked while the bot is responding.
  - Type **`stop`** / `cancel` / `abort` — works wherever the composer isn't locked.
- **Assistant animation**: in the Slack **Assistant / AI-app** thread, the bot shows the native
  shimmering status ("is thinking…", "is using <tool>…", "is putting it all together…") via
  `assistant.threads.setStatus`. This needs the app's **Assistant** feature + `assistant:write`
  scope (in `slack-app-manifest.json`) — update the app manifest and reinstall to enable it.
  Elsewhere (plain channel mentions) the streamed placeholder message is the feedback.

Keep `.env` and `~/.channelgate/` private. For a tamper-proof lock see the `channelgate`
skill's notes on machine-wide managed settings.

## Environment variables

See `.env.example`. Key ones: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`,
`PORT` (default 4747), `SESSION_KEEPALIVE` (warm idle, default `10m`, `0` disables),
`COMMAND_TIMEOUT` (cold path, default `10m`), `CHANNELGATE_DIR`, `COMPOSIO_MCP_URL`,
`ADMIN_PASSWORD`. Local Whisper is controlled in **Settings → Runtime** and defaults on for existing
installs. Its transcription limit defaults to five minutes per clip; advanced overrides are
`WHISPER_TIMEOUT_MS`, `WHISPER_CLI_PATH`, `WHISPER_MODEL_PATH`, and `WHISPER_FFMPEG_PATH`. Run
`npm run whisper:install` to repair or provision the pinned runtime after enabling it.

## Admin password (required)

The admin UI + API hand over the stored Slack/Composio tokens, the filesystem browser and the
admin/workDir switches, so they always require sign-in. A new install generates a password on
first boot and prints it once; set your own with `ADMIN_PASSWORD` in `.env` (or `adminPassword`
in `~/.channelgate/config/settings.json`) and restart the daemon (Settings → Restart, or
`sudo systemctl restart channelgate`). The UI then shows a login
page and a "Logout" button in the header; sessions are in-memory (a restart signs everyone out).

Until a password exists, every privileged `/api` route refuses with instructions — **on every
bind, loopback included**. A loopback address is also what a reverse proxy, a tunnel and every
other process on the host present, so it is not evidence of who is calling. `/api/health` stays
open for monitoring (it volunteers nothing beyond liveness to an unauthenticated caller).
