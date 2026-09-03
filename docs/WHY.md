# Why ChannelGate

> The product story in one document: what this is, who it is for, why it is self-hosted and
> governed, what it is worth to each audience, and how it compares to the alternatives. Merged
> from the former `PRODUCT.md`, `VALUE-PROPOSITION.md` and `FEATURES-VALUE.md`, this is the raw
> material for the public intro page. Pair with `FEATURES.md` (the terse engineering catalog),
> `docs/ENGINE-CAPABILITIES.md` (what each harness can do) and `CHANGELOG.md` (history).

---

## 1. What it is

**Bring Claude into Slack — isolated per channel, governed by you.**

Mention the bot in a channel or just DM it. It runs a real, headless Claude Code session inside a
per-conversation container, with each teammate's own tools and tokens, and posts back in the thread.
Self-hosted. No data leaves your machine except the model calls you already make.

A local daemon that turns Claude Code (and optionally OpenAI Codex) into a Slack agent — with the
isolation, observability, and governance a team actually needs.

### Why it is different

Most "AI in Slack" bots are a thin proxy to a hosted assistant. ChannelGate runs **the real
Claude Code agent** — tools, skills, MCP, multi-step work, background jobs — on **your own
infrastructure**, with a hard **confinement boundary around every conversation**. Confinement is
the product: each channel is its own container with its own folder and an explicit tool allowlist,
so what happens in one channel can't read or write another.

### The one-sentence pitch

**ChannelGate puts a real, working AI agent inside the place your team already collaborates —
Slack — while keeping every conversation in its own container, every credential personal, and
every token of spend on a ledger you own.**

### What it can do

**Talk where your team already works.** Three native surfaces: **@mention** it in any channel,
**DM** it (no mention needed), or use the **Slack Assistant panel** with live shimmer status and
context-aware suggested prompts. Replies stream into the thread and land as clean Slack-formatted
messages with a time · tokens · cost footer.

**Real work, not just chat.** It uses tools and skills, reads attached images and files, edits
code, and runs shell commands — all inside the channel's container. **Background jobs** hand
long-running work (builds, transcriptions, test suites) to the daemon, which continues the thread
automatically when the job finishes — and **survives a restart**: an interrupted job still reports
back instead of vanishing.

**Shows its plan and its work.** The agent's own to-do plan renders as a **live ✓/◐/○ checklist**
that stays in the thread as a record. An optional activity log shows each step and collapses to a
one-line summary when done.

**Remembers — safely.** Each channel keeps a **`MEMORY.md` inside its own folder** that
the agent reads and updates across that channel's threads, so understanding carries forward.
Crucially, this is **folder-scoped**: there is no cross-channel memory bleed, and the harness's
global auto-memory stays off by design.

**Schedules and follows up.** Ask it to do something **every weekday at 9am** or **once in two
hours** — recurring cron and one-time "run at" schedules, announced and threaded in the channel.
Runaway schedules are rejected by a minimum-interval floor. Opt-in, single-thread **no-response
nudges** gently check back on a quiet thread.

**Per-person tools, never shared.** Each teammate's **Composio / Skills / Toolbox tokens** are
injected only into their own messages and re-resolved every turn — so when someone else replies in
a shared thread, the work runs with *their* access, not the starter's. Sensitive channels can
refuse the org-wide default tokens entirely.

**Governed and observable.** A **usage ledger** records every run — interactive, scheduled, and
background — with engine, model, tokens, cost, and duration. An **Audit tab** rolls it up by month
and channel and lists recent runs. Everything is daemon-side and secret-free; history is retained
for later review.

### How it works

```
Slack (Socket Mode)
  → gate:   DM = no mention · elsewhere = require @bot mention
  → authz:  admins + approved users only (fail-closed; unknown users denied everywhere)
  → confine: ensure ~/.channelgate/channels/<slug>/  (MCP allowlist, persistent memory off,
             curated permissions) and the channel's own container (own home, only its folder mounted)
  → session: resolve the thread's session (warm process if alive, else resume)
  → spawn:  claude -p  with --mcp-config (channel servers + THIS author's tokens),
            --strict-mcp-config, and --dangerously-skip-permissions for admins only
  → stream: post / edit the reply in the Slack thread
```

A small **admin web UI** (served by the same process) configures per-channel access, tools,
skills, modes, schedules, and the audit view — applied live, no restart.

### At a glance

| | |
|---|---|
| **Runs** | Headless Claude Code (or OpenAI Codex) as a local daemon |
| **Surfaces** | Channel @mention · DM · Slack Assistant panel · App Home |
| **Isolation** | A container per conversation (own home, only its folder mounted), MCP allowlist, memory off |
| **Tools** | Per-author Composio / Skills / Toolbox tokens; per-channel MCP + skills |
| **Automation** | Background jobs (restart-durable), recurring + one-time schedules |
| **Memory** | Folder-scoped `MEMORY.md` per channel (no cross-channel bleed) |
| **Observability** | Usage ledger + Audit view; streaming progress; live to-do checklist |
| **Governance** | Approval-based access, per-channel modes, audit trail, no spend leaks |
| **Hosting** | Self-hosted on Linux; config under `~/.channelgate/`; systemd service |

---

## 2. Who it is for

- **Consultancies and agencies** running one channel per client: hard isolation between client
  workspaces, per-client audit trails, per-person credentials.
- **Ops-heavy teams** (RevOps, delivery, support) that want CRM/task/email automation triggered
  conversationally and scheduled recurrently, with results visible in-channel.
- **Engineering-adjacent orgs** that already pay for Claude Code and want to multiply its reach
  from "developers with terminals" to "everyone in Slack" without multiplying risk.

### The problem it solves

Organizations that want AI leverage today face a gap between two bad options:

1. **Chat-only AI bots in Slack** — thin proxies to a hosted assistant. They can talk, but they
   can't *do*: no file system, no shell, no real tools, no long-running work. Every answer ends
   with "here's what you could do", and a human still has to go do it.
2. **Full agents on individual laptops** — Claude Code in a terminal is enormously capable, but
   it's single-player. The work is invisible to the team, ungoverned by the org, and the
   capability concentrates in whoever happens to be comfortable in a terminal.

ChannelGate closes that gap: the **full Claude Code agent** (tools, skills, MCP integrations,
multi-step plans, background jobs, scheduling) delivered **as a shared team surface** in Slack,
under **centralized governance** the organization controls.

---

## 3. Why self-hosted and governed

### Trust and security in four rules

- **Confinement is the product.** Every channel runs in its own container with only its own
  folder mounted, an explicit MCP allowlist, and global persistent memory off.
- **Per-author secrets.** Tokens are injected at spawn, scoped to the message author, never
  shared, never persisted to channel settings, never logged.
- **Least privilege by default.** Non-admins run a read-only tool allowlist; shell, network, and
  full access are explicit per-channel opt-ins, and dangerous permissions require both an admin
  author and an admin-mode channel.
- **Self-hosted.** Config and conversation folders live under `~/.channelgate/` on your
  machine. No third-party platform sits between Slack and the model.

### 3.1 Real work happens where the team already is

The bot is not a Q&A toy. It reads attached files and images, edits code, runs shell commands,
calls the org's actual systems (CRM, task trackers, mail, drive, automation platforms — anything
reachable via MCP/Composio), executes multi-hour background jobs, and schedules its own recurring
work. A teammate @mentions the bot in a channel — or DMs it — and the *result* lands back in the
thread, visible to everyone, with a live checklist of what the agent set out to do and a
time/tokens/cost footer when it's done.

**Benefit to the organization:** AI stops being an individual productivity trick and becomes a
piece of shared infrastructure. Work is delegated, executed, and reviewed in the same threads the
team already uses — no new tool to adopt, no context lost to a separate app.

### 3.2 Confinement is the product, not a feature

Every Slack conversation runs inside its **own container** with only its own folder mounted, an
explicit MCP tool allowlist, and the harness's global persistent memory switched off. What happens
in a client channel physically cannot read or write the finance channel's files.
Channel memory exists (`MEMORY.md`), but it is folder-scoped by design — no cross-channel bleed.

**Benefit to the organization:** you can safely give an autonomous agent to *many teams and
clients at once*. The blast radius of any one conversation — a bad prompt, a confused agent, a
malicious message — is one folder. This is the property that makes org-wide rollout defensible to
a security review.

### 3.3 Credentials are personal, access is governed

Each teammate's integration tokens (Composio, Skills, Toolbox) are injected **per message, scoped
to that message's author**, and re-resolved every turn — when a colleague replies in the same
thread, the work runs with *their* access, not the thread-starter's. Tokens are never written into
channel folders, never shared, never logged. On top of that sits an approval-based access model:
only admins and explicitly approved users can talk to the bot at all (fail-closed, including DMs),
four graduated channel modes (`read` → `bash` → `auto` → `admin`) control what the agent may do,
and dangerous permissions require an admin author *and* an admin-designated channel.

**Benefit to the organization:** the AI never becomes a privilege-escalation path. Everyone
operates the agent with exactly the access they already have in the underlying systems, and the
org's existing permission boundaries survive the introduction of AI instead of dissolving into a
shared super-user bot.

### 3.4 Your data, your policy, your spend

The gateway is a local daemon on the organization's own machine. There is **no third-party
platform between Slack and the model** — no vendor storing your conversations, no per-seat SaaS
fee, no new data-processing agreement. Conversation folders, config, and the usage database all
live under `~/.channelgate/` where you can inspect, back up, or delete them. The only data that
leaves the machine is the model calls you already make as a Claude Code / API customer.

**Benefit to the organization:** the shortest possible path through procurement, legal, and
security review — and full exit optionality. You are never locked into a middleman's pricing or
availability.

### 3.5 Every run is on the ledger

Every run — interactive, scheduled, or background — writes one normalized row to a usage ledger:
who, where, which engine and model, tokens, cost, duration. An Audit view rolls it up by month and
by channel and lists recent runs. A structured, secret-free event log records what happened when.

**Benefit to the organization:** AI spend and AI activity are *observable from day one*. You can
answer "what did we spend on AI last month, on what, and for whom?" without instrumenting
anything, catch runaway usage early, and build chargeback or ROI cases per team or per client
channel.

### Secondary benefits that compound

- **Resilience against provider limits.** If Claude hits a usage limit mid-day, the gateway
  transparently answers with the Codex engine (clearly flagged) instead of going dark — the team's
  workflow doesn't stop because one vendor throttled.
- **Automation without babysitting.** Background jobs survive daemon restarts and re-inject their
  results into the original thread; scheduled work runs on cron with sane rate floors; reminders
  can demand an acknowledgment and escalate to a DM if ignored. The agent closes loops instead of
  leaving "I'll get back to you" dead-ends.
- **Institutional memory per workspace.** Each channel folder accumulates durable, reviewable
  context (`MEMORY.md`, working files, instructions) that persists across threads — a client
  channel gets *better over time* without any individual having to maintain a prompt library.
- **Low operational surface.** One Node.js process, SQLite storage with auto-applied migrations,
  a built-in admin web UI, and self-update from Slack (`/update`). Upgrading a machine is
  `git pull` + restart.
- **Team-legible AI.** Live to-do checklists, streamed progress, and per-reply cost footers make
  the agent's behavior — and its price — visible to the whole team, which builds calibrated trust
  far faster than a black-box bot.

---

## 4. Value by audience

| Audience | What they get | The property that makes it work |
| --- | --- | --- |
| **Consultancy / agency** | One channel per client, results in the client's own thread, per-client audit trail | Per-conversation confinement: client A's folder cannot read client B's |
| **Ops / RevOps / delivery** | Conversational and scheduled automation over the org's real systems, visible in-channel | Per-author tokens: every action is attributable to a real person in the downstream system |
| **Engineering org** | The full coding agent reachable from Slack — background builds, test runs, repo work | Channel modes + the container boundary: bash and network are explicit, scoped grants |
| **Security / compliance reviewer** | Fail-closed authorization, no third-party processor, a secret-free event log | Self-hosting plus the approval model: nothing is implicit and nothing leaves the machine |
| **Finance / accountable exec** | One ledger row per run: who, where, engine, model, tokens, cost, duration | Daemon-side metering that no channel or user can opt out of |
| **Non-engineer administrator** | A web UI that governs access, modes, skills, tokens and schedules — live, no restart | Governance that does not require a terminal is governance that actually happens |

### Cost model

- **Software:** open codebase, self-hosted — no per-seat fee.
- **Inference:** the Claude (and optionally Codex) usage you already pay for, now metered per run
  in the ledger. Clean mode and reminder-type schedules exist specifically to keep token cost at
  zero or near-zero where a full agent isn't needed.
- **Infrastructure:** one always-on machine (a small server or desktop) running one daemon.
- **Administration:** a web UI a non-engineer can operate; approval and access changes take
  effect live, without restarts.

---

## 5. How it compares

| | Chat-only Slack AI bot | Agent on a personal laptop | Hosted "AI in Slack" products | **ChannelGate** |
| --- | --- | --- | --- | --- |
| Runs a real agent (tools, shell, files) | No | Yes | Partly | **Yes** |
| Shared team surface | Yes | No | Yes | **Yes** |
| Isolation between conversations | n/a | n/a | Vendor-defined | **A container per conversation** |
| Credentials | Shared bot token | Personal, unmanaged | Vendor-brokered | **Per-author, injected per message** |
| Long-running / background work | No | Only while the terminal is open | Limited | **Daemon-side, restart-durable** |
| Where data lives | Vendor | The laptop | Vendor | **Your machine** |
| Spend visibility | Vendor invoice | None | Vendor invoice | **Per-run ledger you own** |
| Cross-channel memory | Vendor-defined | n/a | Often global | **Deliberately folder-scoped** |

Against the first-party "Claude in Slack" style of product, ChannelGate is the **self-hosted,
governance-first** take on the same idea. It matches the core surfaces (channel, DM, assistant
panel), agent self-scheduling, and finish-then-continue automation — and **exceeds** them on
background-job continuation. It deliberately **diverges** on persistent cross-channel memory:
per-channel confinement is the whole point, so memory stays folder-scoped. You own the data, the
tokens, and the policy.

### The bottom line

ChannelGate converts an individual developer tool into **organizational capability**: the full
power of an autonomous coding-grade agent, multiplied across every team in Slack, with the
isolation, personal credentials, access governance, and spend observability that make an org-wide
AI rollout something a CTO can approve — and audit — rather than something that spreads as shadow
IT.

---

## 6. Feature rationale — what, value, why

Every shipped capability with the value it delivers and the failure mode that motivated it. The
terse catalog of what exists lives in `FEATURES.md`; this is the argument for it.

### 6.1 Conversation gateway

#### Slack Socket Mode listener (DM / group DM / public / private channels)
- **What:** the daemon connects outbound to Slack over Socket Mode and receives message events
  from every conversation type.
- **Value:** works behind NAT/firewalls with no public URL, no inbound port, no webhook
  infrastructure — a laptop or small server can host it.
- **Reason:** self-hosting is a core promise; requiring a public HTTPS endpoint would have made
  the "runs on your own machine" story impractical for most orgs.

#### Mention gating (DM = no mention · elsewhere = require @bot)
- **What:** in channels the bot only reacts when explicitly @mentioned; in a DM every message is
  for the bot.
- **Value:** the bot can sit in busy channels without firing on every message — no accidental
  runs, no token burn, no noise.
- **Reason:** an agent that answers unprompted in a team channel is both expensive and socially
  intolerable; explicit summoning keeps intent (and spend) unambiguous.

#### Thread-scoped sessions (new thread = new session, replies resume)
- **What:** each Slack thread maps to one persistent engine session; replying resumes it with
  full context.
- **Value:** natural multi-turn work — "now change X" just works — while separate topics stay in
  separate contexts.
- **Reason:** Slack's own conversational unit is the thread; mirroring it means users never learn
  a session model, they just use Slack.

#### First-turn thread context replay
- **What:** when the bot is first pulled into an *existing* human thread, it fetches the earlier
  messages and prepends them (as named, readable lines) to the prompt.
- **Value:** "@bot can you summarize this?" works — the bot knows what "this" is.
- **Reason:** Slack only delivers the single triggering message; without replay, the bot's first
  turn in a pre-existing discussion was blind, which read as stupidity to users.

#### Attachments (files/images downloaded into the channel folder)
- **What:** files attached to a message are downloaded into the channel folder's `uploads/` and
  their paths handed to the agent (images render visually via the Read tool).
- **Value:** screenshots, CSVs, PDFs, and code files become first-class inputs — "here's the
  error, fix it" with a screenshot just works.
- **Reason:** real requests come with artifacts; an agent that can't see what users paste would
  force lossy re-typing.

#### Slack Assistant surface (native status, suggested prompts, thread titles)
- **What:** in Slack's AI-assistant panel the bot shows the native shimmering status with
  progress phrases, seeds context-aware suggested prompts, and auto-titles threads.
- **Value:** the bot feels like a first-party Slack AI feature, and the assistant timeline stays
  navigable.
- **Reason:** Slack shipped a dedicated AI surface; meeting users there — with its native
  affordances rather than plain messages — removes adoption friction.

#### Streaming placeholder → final reply with time · tokens · cost footer
- **What:** the bot posts a placeholder immediately, streams/updates progress, then lands the
  final Slack-formatted answer with a footer of duration, tokens, and cost.
- **Value:** instant feedback that the request was heard; a per-reply price tag builds cost
  literacy across the team.
- **Reason:** headless agent runs can take minutes; silence reads as failure. And per-reply cost
  visibility is the cheapest possible spend-governance tool.

#### Live TODO checklist (agent's plan rendered as ✓/◐/○, edited in place)
- **What:** the agent's own TodoWrite plan renders as a live checklist message that stays in the
  thread afterwards.
- **Value:** everyone can see what the agent intends, watch progress, and later audit what it set
  out to do vs. what it did.
- **Reason:** trust in autonomous work requires legibility; a visible plan converts a black box
  into something a team can supervise.

#### Selectable in-progress view (`status` / `log` / `both` / `stream`)
- **What:** admins choose how progress renders: native shimmer, an activity-log message, both, or
  Slack's native text streaming (`chat.startStream`) with live task cards.
- **Value:** each workspace picks its noise/detail trade-off; the `stream` mode uses Slack's
  recommended API and avoids `chat.update` rate limits.
- **Reason:** teams disagreed on how chatty a working bot should be, and Slack's streaming API
  (the platform's forward path) deserved first-class support with graceful fallback.

#### Provenance line per turn
- **What:** each turn tells the agent who requested it and where — as metadata, explicitly not an
  instruction; tool access still re-resolves to the actual sender.
- **Value:** the agent addresses the right person in shared threads and multi-user channels.
- **Reason:** without it the agent conflated thread participants; with it marked as metadata, a
  prompt-injection vector ("the requester says do X dangerous") is deliberately blunted.

#### `@bot status` / `/status`
- **What:** a compact report of a channel's live background jobs, schedules, and warm/in-flight
  sessions.
- **Value:** "is it doing anything right now?" answered without checking a server.
- **Reason:** autonomous background work is invisible by nature; a status surface is the minimum
  viable operability for non-admin users.

#### In-thread commands (`/help`, `/clear`, `/context`, `/model`, `/effort`, `/compact`, `/mode`, `/update`)
- **What:** plain typed messages that control the session (reset, inspect token usage, switch
  model or effort, compact context, change mode, self-update the gateway).
- **Value:** power controls exist where the work happens — no admin-UI round-trip for everyday
  session management; `/update` makes ops a Slack message.
- **Reason:** Slack forbids slash commands in threads, so the gateway parses these as normal
  messages; users needed session control in place, and admins needed a zero-SSH upgrade path.

#### Stop in-flight runs (stop words · stop emoji · `/stop`)
- **What:** a plain "stop"/"cancel", a 🛑/❌/✋ reaction, or the slash command aborts the running
  turn and posts a resume hint.
- **Value:** a misdirected or runaway run is halted in seconds — by anyone watching, from any
  device.
- **Reason:** an agent that cannot be interrupted is an agent people won't trust with real work;
  reactions matter because Slack disallows slash commands inside threads (and reactions work
  one-handed on mobile).

#### Mention-by-reaction (configurable emoji, default 🤖)
- **What:** reacting to a message with the configured emoji treats it as an @mention; the
  *reactor* becomes the author for authz and tokens.
- **Value:** delegate any existing message to the bot without quoting or retyping it.
- **Reason:** "have the bot handle that ↑" is a constant desire in channels; scoping it to the
  bot's own surfaces prevents hijacking other bots' threads, and reactor-as-author keeps the
  credential model intact.

#### Background jobs with auto-continue
- **What:** the `run_in_background` MCP tool hands long shell commands to the daemon; on
  completion the daemon re-injects a turn into the same thread and session, which continues with
  full context.
- **Value:** builds, test suites, transcriptions, and long pipelines don't tie up a subprocess or
  a human — the thread simply resumes itself when the work is done.
- **Reason:** a headless `claude -p` process can't outlive its turn; without daemon-side jobs the
  agent produced "I'll continue automatically" promises that never fired — the single worst
  trust-breaker observed in practice.

#### Background jobs survive restarts
- **What:** jobs persist to disk; on boot, still-running jobs are re-watched and jobs that died
  while the daemon was down trigger a forced "interrupted by restart" continuation.
- **Value:** a daemon upgrade or crash never silently strands a thread mid-job.
- **Reason:** the daemon self-updates and machines reboot; durability is what turns background
  jobs from a demo into infrastructure.

#### One-time ("run at") schedules
- **What:** `create_schedule` accepts `in_minutes`/`run_at` for fire-once-then-delete tasks
  alongside recurring cron.
- **Value:** "remind this channel in 2 hours" / "run this after the deploy window" — natural
  deferred work.
- **Reason:** cron alone forced awkward create-then-delete dances for one-shots; a first-class
  one-time schedule matches how people actually phrase deferred requests.

#### Reminder schedules with acknowledgment + escalation
- **What:** `kind:"reminder"` posts a single message with **zero** engine run/token cost; with
  `ack:true` it demands a ✅ reaction, re-posts after a timeout, then DMs the creator and closes.
- **Value:** recurring nags cost nothing to run, and important ones can't be silently ignored —
  the escalation chain guarantees a human either acks or hears about it directly.
- **Reason:** running a full agent session to say "submit your timesheet" was pure waste; and a
  reminder nobody acknowledges is indistinguishable from no reminder at all.

#### Opt-in no-response nudges
- **What:** per-channel opt-in: the bot posts one gentle follow-up in a thread quiet past a
  window (default 24h). Strictly single-thread.
- **Value:** dropped threads resurface themselves instead of dying in scrollback.
- **Reason:** deliberately narrow (opt-in, one nudge, no cross-channel scanning) because an
  over-eager nagging bot is worse than none.

#### Personal pending-response digests
- **What:** the bot passively tracks who spoke last in AI threads (only threads it was mentioned
  in or posted in) and DMs each approved user, twice a day, a permalink list of threads awaiting
  *their* reply. ✅ marks done; new activity re-opens.
- **Value:** a personal, automatic follow-up inbox — commitments made in AI threads stop slipping.
- **Reason:** limited to AI threads and member channels on purpose: a bot that surveils all human
  conversation would be creepy and unacceptable; one that tracks its own threads is a colleague
  keeping minutes.

#### Slack Lists tools
- **What:** gateway MCP tools (`slack_list_create/add/update/items/info`) that create and edit
  native Slack Lists via the Web API, including a ready-made To-do layout.
- **Value:** the agent's outputs can be *structured trackers* teammates edit natively in Slack —
  not just prose that goes stale.
- **Reason:** Composio has no Lists coverage, so the gateway calls `slackLists.*` directly;
  built because "turn this plan into a tracked task list" was a recurring ask.

### 6.2 Engines

#### Two engines: Claude (default) + Codex
- **What:** runs headless Claude Code or the OpenAI Codex CLI, selected per
  thread-directive → channel → global default; a "claude"/"codex" message prefix switches a
  thread persistently.
- **Value:** engine choice per context (cost, availability, preference) and a second vendor as a
  pressure valve; users compare engines on real work by typing one word.
- **Reason:** single-vendor dependence is an availability and negotiation risk; the abstraction
  also keeps the gateway honest about what is Slack-plumbing vs. engine-specific.

#### Automatic Claude→Codex fallback on usage limits
- **What:** a Claude turn that returns a limit notice with zero work is detected; the turn is
  re-answered by Codex (flagged with a ⚠️ note) and Claude is skipped for a ~15-minute cooldown.
- **Value:** the team's AI doesn't go dark when a plan limit hits mid-afternoon — degraded
  gracefully, transparently labeled.
- **Reason:** subscription limits are a real operational event; the cooldown avoids hammering a
  limited account with doomed probes on every message.

#### Codex permissions mirror channel mode
- **What:** inside the channel's container, Codex runs read-only in read mode (which also refuses
  network on its own) and with writes enabled when the channel allows bash/auto; full bypass only
  for admin author + admin mode.
- **Value:** switching engines never weakens the channel's security posture.
- **Reason:** the confinement contract must be engine-independent, or the second engine becomes an
  escape lever — which is why the boundary is the container, not either engine's own sandbox.

#### Codex cost estimation
- **What:** a blended $/1M-token rate (Settings) produces `costEstimated` in the ledger; Claude
  reports exact cost.
- **Value:** the audit view stays meaningful across engines instead of showing $0 for Codex runs.
- **Reason:** Codex doesn't report billing per run; an estimate clearly marked as such beats a
  hole in the spend data.

#### Session recovery
- **What:** resuming a session that no longer exists silently mints a fresh session and retries
  once, instead of erroring.
- **Value:** old threads always answer — nobody sees "No conversation found with session ID".
- **Reason:** session stores expire; leaking an engine-internal error into a user thread over
  something recoverable is unacceptable UX.

### 6.3 Isolation and security

#### Per-conversation gated folder (the core contract)
- **What:** every conversation gets its own container and its own folder: only that folder is
  mounted, and `.claude/settings.json` turns persistent memory off and carries the MCP allowlist.
- **Value:** hard blast-radius containment — one channel's agent physically can't touch another
  channel's (or the host's) files; client channels are isolated from each other by construction.
- **Reason:** this is the founding thesis ("confinement is the product"): org-wide agent rollout
  is only defensible if any single conversation going wrong is contained by design.

#### Per-author token injection (never shared, never on disk, never logged)
- **What:** Composio/Skills/Toolbox tokens are resolved per message author and injected at spawn
  via `--mcp-config`; a different author replying re-resolves with *their* token.
- **Value:** everyone acts in downstream systems as themselves — audit trails in the connected
  systems stay truthful, and no one inherits a colleague's access by replying in a thread.
- **Reason:** a shared bot token would collapse the org's entire permission model into one
  super-user; per-author injection preserves existing boundaries through the AI layer.

#### Token chain channel → user → org-default, with per-channel opt-out
- **What:** token resolution falls back from channel-specific to the user's own to an org-wide
  default; sensitive channels can set `noDefaultTokens` to refuse the org fallback.
- **Value:** frictionless onboarding (org default works day one) with per-channel tightening
  where data is sensitive.
- **Reason:** pure per-user tokens stalled adoption (nobody had set one up); pure org tokens
  destroyed attribution. The chain gives both, and the opt-out keeps high-sensitivity channels
  clean.

#### Gateway control MCP (always injected, channel/author-scoped)
- **What:** a purpose-built MCP server giving the agent gateway powers — schedules, background
  jobs, channel admin, token self-setup, workdir changes, permission prompts — scoped to the
  calling channel/author and running on the daemon's side of the container boundary.
- **Value:** users configure the gateway *by talking to it* ("schedule this daily", "set my
  Composio token") instead of visiting an admin UI.
- **Reason:** daemon-side powers (cron, jobs outliving the subprocess) must cross the container
  boundary somewhere; one audited, narrowly-scoped MCP server is that single controlled door.

#### Skills Manager favorites injection
- **What:** the author's starred skills are written into the channel's instruction file as a
  managed, delimited block (refreshed each run, stripped when the token is gone, cached ~10 min).
- **Value:** the org's curated skill library actually gets used in Slack runs — the agent knows
  the user's preferred workflows at session start.
- **Reason:** skills only deliver value if the agent knows they exist; injecting favorites at
  the folder level made the library self-propagating instead of relying on users to mention it.

#### Trusted bot apps allowlist
- **What:** posts from specific allowlisted Slack apps (e.g. an automation-platform scenario) may
  trigger runs — bypassing only the bot-reply-loop guard; mention + approved author are still
  required.
- **Value:** external automations can drive the agent safely.
- **Reason:** the blanket "ignore all bots" rule (which prevents reply loops) also blocked
  legitimate machine-initiated work; a narrow allowlist re-enables it without opening loops.

#### Folder-scoped channel memory (`MEMORY.md`)
- **What:** each channel folder holds a `MEMORY.md` the agent reads and updates across that
  channel's threads; global auto-memory stays off; non-bash channels get only a narrow
  `Write(MEMORY.md)` permission.
- **Value:** channels get smarter over time (preferences, decisions, state of work) without any
  cross-channel information bleed.
- **Reason:** memory is where isolation usually leaks — a global memory would carry client A's
  facts into client B's channel. Folder-scoping delivers continuity *inside* the confinement
  boundary instead of through it.

#### Four channel modes (`read` / `bash` / `auto` / `admin`)
- **What:** a graduated capability ladder: read-only tools → shell+writes →
  autonomous approval → full access (which also requires an admin author). Changing modes is
  admin-only.
- **Value:** risk posture per channel matches the work: a client-facing channel stays read-only
  while an ops channel automates; one mental model for admins.
- **Reason:** one-size permissions were wrong everywhere — too tight for power users, too loose
  for guests. Coupling `admin` mode to an admin *author* prevents a channel setting alone from
  granting anyone dangerous powers.

#### Interactive permission approvals in Slack
- **What:** when a non-admin run hits a non-allowlisted tool, buttons appear in the thread —
  Approve once / for this thread / forever / Deny — clickable only by the author, an admin, or an
  approved user; 4-minute auto-deny.
- **Value:** headless runs stop dying on prompts they can't answer, and each approval is a
  visible, attributable decision in the thread; "approve forever" lets channels converge to
  friction-free steady state.
- **Reason:** headless `claude -p` cannot answer interactive prompts, so the choice was
  deny-everything (useless), allow-everything (unsafe), or route the prompt to the humans in the
  thread — the only option that is both safe and usable.

#### Admin-only dangerous permissions
- **What:** `--dangerously-skip-permissions` requires an admin author AND an admin-mode channel;
  everyone else runs the folder's curated allowlist.
- **Value:** full-power runs exist (admins doing ops on the gateway machine) without ever being
  reachable by a non-admin or by an admin ambushed in a random channel.
- **Reason:** the escape hatch is legitimate but must be double-keyed — neither a person nor a
  place alone is sufficient.

#### Per-channel Allow-Bash / Allow-Network
- **What:** opt-in shell+writes inside the channel's container (which mounts only the channel's
  own folder — the gateway root, the operator's `.ssh`/`.aws`/keychain paths and other channels'
  folders are simply absent) and an opt-in network switch that tells the engines whether the
  channel is meant to have network (enables git push / gh / deploy CLIs). Every container is on
  the bridge network; the switch does no per-domain filtering and, in this release, no egress
  cut-off — the boundary is filesystem and process isolation, with a container-side egress proxy
  as the planned follow-up.
- **Value:** real development workflows (clone, edit, test, push) in channels that need them,
  while the daemon's own config and the host's secrets remain out of reach.
- **Reason:** bash and network are the two big escape vectors; making each an explicit, separately
  scoped grant keeps the default posture tight without banning the workflows that justify the
  gateway.

#### Background jobs gated to auto/admin channels
- **What:** `run_in_background` is refused in channels where bash would require per-command Slack
  approval.
- **Value:** closes an approval-bypass hole — no unattended shell in channels that demand
  human-in-the-loop.
- **Reason:** background jobs run un-prompted on the daemon; allowing them in approval-required
  channels would have made "run it in the background" a one-line policy bypass.

#### Approval-based user authorization (fail-closed)
- **What:** only admins and approved users may talk to the bot — in channels *and* DMs; unknown
  users are denied everywhere, recorded pending admin approval; per-channel guest grants are the
  only exception.
- **Value:** workspace membership ≠ AI access; contractors and multi-tenant Slack realities don't
  silently expand who can spend tokens and reach org tools.
- **Reason:** fail-closed with an explicit approve step is the only stance that survives a
  security review; the guest mechanism handles the "one external collaborator in one channel"
  case without widening the default.

### 6.4 Performance

#### Warm session pool
- **What:** a thread's engine process stays alive (default 10 min idle) for instant follow-ups;
  it relaunches transparently when the author or permissions change.
- **Value:** follow-up latency drops from cold-start (many seconds) to near-instant — the
  difference between "conversation" and "batch job".
- **Reason:** cold-spawn per message was the top UX complaint; the author-change relaunch rule
  exists so warmth never compromises the per-author token contract.

#### Clean mode
- **What:** per channel/DM: run bare — no MCP servers at all (not even the gateway control), no
  skills, no favorites block, no tokens; empty `--strict-mcp-config`.
- **Value:** the cheapest, fastest, closest-to-base-model configuration for channels that just
  want chat/writing — every MCP tool schema not loaded is context and money saved.
- **Reason:** tool schemas cost thousands of tokens per turn; channels doing pure thinking work
  were paying an integration tax for tools they never called.

### 6.5 Administration

#### Admin web UI + REST API
- **What:** a vanilla-JS UI (same process) managing channels, DMs, users, schedules, audit, and
  settings; master-detail layout; channel detail split into General / Users / MCP & tokens /
  Skills.
- **Value:** a non-engineer can govern the whole system — no SSH, no JSON editing; changes apply
  live.
- **Reason:** if governance requires a terminal, governance won't happen; the UI is what makes
  the security model actually operable by the people responsible for it.

#### DM org templates (User / Admin)
- **What:** reusable named configs (skills, MCPs, modes, model, effort) applied to any DM; edit
  the template once, every templated DM follows; DMs can still go custom.
- **Value:** consistent, one-step provisioning of personal assistants for every teammate.
- **Reason:** per-DM hand-configuration didn't scale past a handful of users and drifted
  immediately; templates make the default posture a managed object.

#### Visible working folders + custom workdir
- **What:** channel work happens in visible `~/ChannelGate/<platform>/<slug>/` folders (metadata stays in
  the hidden gateway root); a channel can point at any validated absolute path, and an existing
  project's `CLAUDE.md`/`AGENTS.md` is respected.
- **Value:** users can open the agent's workspace in a file browser — artifacts are *theirs*; a
  channel can operate directly on a real project repo.
- **Reason:** hidden dot-folders made output feel trapped; and pointing a channel at an existing
  repo turned the gateway into a genuine dev tool rather than a toy.

#### Per-channel agent instructions (CLAUDE.md canonical, AGENTS.md symlink)
- **What:** each folder gets a generated instruction file, canonical for Claude and symlinked for
  Codex; legacy folders migrate automatically.
- **Value:** both engines read the same operating instructions — behavior stays consistent across
  engine switches.
- **Reason:** two instruction files drifted the moment they existed; a symlink makes divergence
  impossible rather than merely discouraged.

#### Optional admin password login
- **What:** password-gated UI/API with an httpOnly session cookie; set/change/remove in Settings
  or `ADMIN_PASSWORD`; health + login routes stay open.
- **Value:** the admin plane (tokens! permissions!) isn't wide open to anyone on the LAN.
- **Reason:** localhost-only was the original assumption, but real deployments put the UI on
  reachable networks; optional keeps single-user setups frictionless.

#### Daemon controls + self-update
- **What:** restart (with health polling), Slack disconnect/reconnect, and `/update` /
  `update_gateway` (git pull → install → restart, detached). The old "Stop daemon" button was
  deliberately removed.
- **Value:** the gateway operates itself from Slack or the UI — upgrades are a message, not an
  SSH session.
- **Reason:** ops friction is adoption friction on a self-hosted product; "Stop daemon" was
  removed because a remote kill with no remote start is a footgun, not a feature.

#### Live Slack token management
- **What:** Slack tokens are set in the UI (write-only, masked), stored in `settings.json`
  (overriding `.env`), and the connection is rebuilt live; a bad token reports an error without
  crashing.
- **Value:** initial setup and token rotation never require a restart or shell access.
- **Reason:** token typos during setup used to crash-loop the daemon — the worst possible
  first-run experience for the exact user (a non-engineer admin) the UI targets.

### 6.6 Storage

#### One SQLite database for operational data
- **What:** users, channels, meta, sessions, schedules, acks, followups, background jobs, usage,
  and events in `~/.channelgate/gateway.db` (built-in `node:sqlite`, WAL); config-shaped rows
  keep a full-record JSON blob; hand-editable bootstrap config stays as JSON files.
- **Value:** concurrent access from the daemon and the spawned MCP-server process is safe
  (SQLite locking) — the shared-JSON-file era's lost-write races are gone; the dashboard queries
  indexed columns instead of scanning JSONL.
- **Reason:** two processes writing the same JSON files was a real corruption source; built-in
  `node:sqlite` gives transactions with zero native-build burden. JSON blobs in config rows mean
  new fields don't need a migration.

#### Versioned auto-applied migrations + one-time legacy import
- **What:** schema versioned via `PRAGMA user_version`, applied on open (append-only migration
  rule); first boot imports the pre-SQLite JSON/JSONL once, leaving originals as inert backups.
- **Value:** upgrading any machine is `git pull` + restart — schema catches up by itself;
  existing deployments migrated with zero manual steps and a rollback path.
- **Reason:** a self-hosted fleet has no DBA; any migration requiring human action would fail
  somewhere, some day, silently.

### 6.7 Observability

#### Usage ledger (one row per run)
- **What:** every run — interactive, scheduled, background — writes engine, model, tokens, cost
  (estimated for Codex), duration; indexed for day/week/month/channel/user rollups; daemon-side
  only.
- **Value:** the org's entire AI spend and activity is queryable from one table it owns —
  chargeback, ROI, and anomaly detection become SQL.
- **Reason:** ungoverned token spend is the fastest way for an org-wide AI rollout to get shut
  down; measurement had to be automatic and universal, not opt-in.

#### Structured event log
- **What:** secret-free events in an indexed `events` table, queryable by day/channel/user.
- **Value:** "what happened in that client channel yesterday?" is answerable after the fact —
  incident review without guesswork.
- **Reason:** console logs die with the process and can't be filtered per channel; an autonomous
  system needs a durable, queryable account of its own actions.

#### Audit admin tab
- **What:** monthly totals, per-channel rollups, recent-runs feed over ledger + events. No spend
  cap — visibility only.
- **Value:** the accountable human sees spend and activity without writing SQL.
- **Reason:** visibility-first (no hard caps yet) was deliberate: a surprise mid-task cutoff is
  worse for trust than a surprising-but-visible bill; caps can layer on later.

#### App Home dashboard
- **What:** a read-only Home tab: your access level, the channels the bot works in, the admin-UI
  link; never shows secrets.
- **Value:** self-serve orientation — "what can I do with this bot?" answered without asking an
  admin.
- **Reason:** every new user clicks the bot's profile first; an empty Home tab wasted the
  product's single best onboarding surface.

#### Health endpoint + graceful shutdown
- **What:** `GET /api/health` reports engine availability, gateway root, warm-session count;
  SIGINT/SIGTERM terminate warm sessions cleanly.
- **Value:** the service manager and monitoring can supervise the daemon, and restarts don't
  strand orphan engine processes.
- **Reason:** a long-running daemon that can't be probed can't be operated; and warm pools leak
  processes on kill unless shutdown is explicit.
