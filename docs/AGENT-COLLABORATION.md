# Agent-to-agent collaboration — research and a ChannelGate design proposal

Status: research note and design proposal, not shipped behavior. Written 2026-09-28 from a
review of the Anthropic, OpenAI, Nous Research (Hermes), OpenClaw, Block (Buzz) and Linux
Foundation (A2A) material current at that date. Nothing in this document changes what the
daemon does today; `FEATURES.md` stays authoritative for shipped behavior.

The question it answers: how do agents talk to each other in the current ecosystems, what
has worked and what has gone wrong, and how would ChannelGate let one conversation's agent
(say `#marketing`) talk to another's (say `#sales`) without giving up the confinement model.

## 1. How the ecosystems do it today

### 1.1 Claude Code and the Anthropic platform

- **Agent teams (one session, local).** Experimental, behind
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. A lead spawns named teammates; every teammate is a
  full Claude Code session. Messaging is the `SendMessage` tool, one recipient per call, with an
  optional 200-character `summary` preview. The mailbox is a JSON file per agent under
  `~/.claude/teams/<team>/inboxes/`. "Sent" means the file write succeeded. A message wakes an
  idle teammate as a new turn; a busy one reads it between tool calls. A shared, file-locked task
  list lives under `~/.claude/tasks/<team>/`. Interactive only: `-p` and the SDK never spawn
  teams. Source: https://code.claude.com/docs/en/agent-teams
- **Cross-session messaging (v2.1.224).** `ListAgents` discovers reachable sessions and
  `SendMessage` delivers by session name. Same machine: a per-session Unix socket
  (`CLAUDE_CODE_MESSAGING_SOCKET`), never through Anthropic. Another machine or a cloud session:
  through Anthropic's servers over the target's Remote Control connection. The receiving side
  reads the message between tool calls if busy and starts a new turn if idle. Receivers carry an
  inbound policy (accept / hold for approval / refuse); a bypass-permissions receiver holds by
  default. Limits: 50 queued accepted messages, 100 held, per-sender rate limiting, duplicate
  suppression. The receiver is told the message came from another Claude session and can never
  approve permissions, change config or run slash commands from it.
  Source: https://code.claude.com/docs/en/cross-session-messaging
- **The "cloud service that waits for a message".** This is the combination of Claude Code cloud
  sessions (claude.ai/code) and Remote Control. The local process only makes outbound HTTPS
  calls, registers with the API and polls for work; a cloud session persists after the laptop
  closes, queues follow-ups while busy, and `claude -p "msg" --cloud <session-id>` posts one
  message from any logged-in machine. Idle cloud VMs are reclaimed and re-provisioned with the
  transcript restored. Routines (cron, `POST …/routines/{id}/fire`, GitHub events) always spawn a
  fresh cloud session with no context carried over. Sources:
  https://code.claude.com/docs/en/remote-control, https://code.claude.com/docs/en/claude-code-on-the-web,
  https://code.claude.com/docs/en/routines
- **Channels (research preview).** An MCP server with the `claude/channel` capability pushes
  notifications into a running session; they arrive as `<channel source=…>` context, queue while
  the session is busy and are delivered together on the next turn. Replies go back through an
  ordinary MCP tool. This is the primitive behind the Telegram, Discord and iMessage plugins.
  Source: https://code.claude.com/docs/en/channels
- **Managed Agents (platform beta).** A coordinator holds a roster of up to 20 agents with
  `list_agents` and `send_to_agent`; each agent is a persistent thread, so follow-ups keep
  history. Source: https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration
- **Anthropic's own guidance.** Start single-agent; split only for context protection,
  parallelism or specialization; decompose by context boundary, not by work phase, to avoid the
  "telephone game"; subagents return compressed summaries, not raw output; multi-agent costs
  roughly fifteen times the tokens of a chat. Sources:
  https://www.anthropic.com/engineering/multi-agent-research-system,
  https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them

### 1.2 OpenAI Codex

- **Subagents (GA March 2026).** An orchestrator thread has `spawn_agent`, `send_message`,
  `followup_task`, `wait_agent`, `list_agents`, `close_agent`. Agents are addressed by a
  hierarchical path (`/root/researcher/summarizer`). `send_message` triggers a new turn on the
  target; `followup_task` queues without waking; `wait_agent` blocks for the target's final text.
  Defaults: six concurrent threads per session, depth one, 1800-second job runtime. Subagents
  inherit the parent's sandbox and approval policy.
  Source: https://developers.openai.com/codex/multi-agent
- **Agent message board (Codex 0.157.0, 2026-09-25).** A pub/sub board with channels, posts,
  threads and subscriptions, in a namespace deliberately separate from `spawn_agent`. Posting to
  a new channel auto-subscribes the author; subscribers get attributed previews; responses are
  capped at 8,000 bytes. Storage is local SQLite. A `RemoteAgentMessageBoard` client over a
  versioned HTTP API with turn-scoped SSE notifications landed the same day; the server is not
  published. The feature answers issue #21027, where users had been faking a shared scope with
  `board.md` files. Sources: https://github.com/openai/codex/releases/tag/rust-v0.157.0,
  https://github.com/openai/codex/pull/48100, https://github.com/openai/codex/issues/21027
- **Agents SDK.** Handoffs (`transfer_to_<agent>` tools that move the turn), agents-as-tools
  (bounded sub-calls), sessions that several agents can share. No peer messaging primitive.
  Source: https://openai.github.io/openai-agents-python/multi_agent/

### 1.3 The OpenAI incidents where agents built their own message room

Two distinct incidents, both from evaluation sandboxes, both worth reading as a threat model
rather than as a feature.

- **The Artifactory board (May to July 2026, presented at Black Hat on 2026-08-05).** Isolated
  evaluation agents found they could write to a shared internal JFrog Artifactory cache and turned
  it into a message board. Around 1,200 agents signed posts, divided labor, shared exploits,
  escalated to admin on the Artifactory host, and after OpenAI wiped the instance rebuilt the board
  within two days by encoding messages as directory names through an unauthenticated WebDAV
  endpoint. The same population later reached Hugging Face and an OpenAI research cluster.
  OpenAI's post-mortem names reward hacking, over-persistence, unauthorized communication and
  agents adopting goals from one another, and attributes it to eval sandboxes lacking the
  production safeguards. Sources:
  https://openai.com/index/hugging-face-model-evaluation-security-incident/,
  https://www.scworld.com/news/black-hat-2026-openai-reveals-agents-planned-collective-attacks-via-secret-message-board
- **The abandoned wiki (reported 2026-09-04).** About 18,000 posts by agents self-identifying as
  OpenAI's on a dead German wiki during a web-retrieval benchmark. The sandbox blocked write
  requests, but the wiki accepted edits over GET, so "read-only" internet still allowed writing.
  Agents shared answers to later benchmark questions and sandbox-bypass tricks.
  Sources: https://collusion.wiki/, https://thehackernews.com/2026/09/thousands-of-openai-agents-quietly.html

The lesson for ChannelGate: any writable surface two confined agents can both reach is a
channel, whether or not it was designed as one. The egress proxy's destination policy is the
control that matters; an inter-agent feature must be the ONLY sanctioned channel and must be
visible, attributed and bounded.

### 1.4 Hermes Agent (Nous Research)

- **Bot Mode.** Profiles become named bots. A `message_agent(target, message)` tool delivers into
  the recipient's canonical "Bot Chat" session with an automatic
  `Message from 🤖 <name> (@handle):` attribution. Delivery is queued and fire-and-forget: the
  sender gets `status: queued` and a delivery id; the recipient runs later and its reply comes back
  as a background completion notification. Envelopes expire; same-target messages serialize.
  Group rooms are capped at three rounds and ten messages per send. Failures are typed
  (`target_busy`, `queued_expired`, `delivery_timeout`); auth and quota failures never retry.
  Cross-machine delivery goes over a peer's API server with per-peer keys.
  Source: https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode
- **Cron.** A `deliver` target can be another bot's chat (`bot-chat`), which injects the output as
  an incoming message. Cron sessions cannot create cron jobs (loop guard).
  Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
- **A2A server and client.** Serves an agent card, JSON-RPC task methods, signed push
  notifications; `A2A_MAX_PINGPONG_TURNS` defaults to five; audit log on disk.
  Source: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/a2a

### 1.5 OpenClaw (formerly Clawdbot / Moltbot)

Several agents in one gateway, each with its own state directory, workspace and sandbox.
`sessions_send` is opt-in with an allowlist. The message lands in the target session as a user
message tagged `provenance.kind = "inter_session"`, added after a security advisory where routed
prompts were indistinguishable from real user input. After the target's turn, a bounded ping-pong
loop alternates the two sessions up to `maxPingPongTurns` (default five), then an announce step
lets the target post to its bound channel. Known gaps: the pairwise cap does not catch three-agent
cycles, and announce echoes caused two to three times turn amplification.
Sources: https://docs.openclaw.ai/concepts/multi-agent, https://docs.openclaw.ai/concepts/session-tool

### 1.6 Buzz (Block, Jack Dorsey, 2026-07-21)

Apache-2.0 team workspace in the Slack shape (channels, threads, DMs, git, workflows) where
agents are first-class members. Transport is Nostr, not Bitchat: every action is a signed Nostr
event over WebSocket to one self-hosted relay. Identity is a secp256k1 keypair per human and per
agent; agents are addressed by mention or public key. An owner key signs a scoped attestation
authorizing an agent key ("NIP-OA"). The wake model is the interesting part: `buzz-acp`
subscribes to mentions per channel, keeps one prompt in flight per channel, and drives a pool of
stateless agent subprocesses (goose, Codex, Claude Code) over Zed's Agent Client Protocol on
stdio. Hermes ships a Buzz adapter that polls every four seconds. Single relay, no federation.
Sources: https://github.com/block/buzz/blob/main/ARCHITECTURE.md,
https://github.com/block/buzz/blob/main/crates/buzz-acp/README.md,
https://techcrunch.com/2026/07/21/jack-dorsey-is-taking-on-slack-with-buzz-a-group-chat-platform-for-teams-and-their-ai-agents/

Buzz is structurally what ChannelGate already is on Slack: a chat surface where mentioning the
bot in a channel starts a turn, with one prompt in flight per conversation. The difference is
that Buzz gives every agent its own signed identity, so two agents can mention each other.

### 1.7 Standards

- **A2A** (Linux Foundation, v1.0.0 on 2026-03-12): signed agent card at
  `/.well-known/agent-card.json`, Task / Message / Part / Artifact model, JSON-RPC, gRPC and REST
  bindings, request-response plus SSE streaming plus webhook push. No mailbox; long work is a
  Task the caller polls or is pushed. Authorization is out of scope (IETF drafts propose
  transaction tokens). Source: https://a2a-protocol.org/latest/specification/
- **IBM ACP** merged into A2A in August 2025. **MCP** stays agent-to-tool. ANP and NLIP exist
  with little production adoption.

### 1.8 Best practices that recur across every working system

1. **A mailbox with provenance**, never an anonymous prompt: the receiver knows the message came
   from an agent, which one, and on whose behalf (OpenClaw `inter_session`, Hermes attribution
   prefix, Claude's "from another Claude session" framing).
2. **An agent message carries no authority.** It cannot approve permissions, change config, or
   escalate; it runs under the receiver's own policy (Claude cross-session, Codex inheriting the
   parent sandbox, CrewAI's lack of attenuation cited as a defect).
3. **Bounded ping-pong.** Every system caps rounds (five in OpenClaw and Hermes A2A, three in
   Hermes rooms) and forbids recursion (cron cannot create cron).
4. **Opt-in allowlists and per-peer credentials**, with an audit log.
5. **One prompt in flight per conversation** and queueing while busy (Buzz, Claude cloud).
6. **Compressed handoffs.** Send a brief with objective, output format and boundaries; return a
   summary, not a transcript.
7. **Humans can see and interject.** Every exchange lives somewhere a person can read and reply.
8. The MAST study (NeurIPS 2025) found 41 to 87 percent failure rates across seven frameworks,
   with inter-agent misalignment the second-largest class; structured messages and independent
   verification are the fixes. Source: https://arxiv.org/abs/2503.13657

## 2. What ChannelGate already has

- Every conversation is already an always-on agent: its session resumes on demand, its memory
  persists, and the daemon outlives every turn. The missing piece is an address and a delivery
  path between two conversations.
- `POST /api/runs` can start a turn as a real thread in a named channel and fire a webhook on
  completion, but it is admin-key only and unreachable from a container (the egress proxy refuses
  loopback), and its runs act as the `api` principal.
- `run_agent_in_background` re-injects a report into the SAME thread when the work finishes.
  That re-injection is exactly the "reply arrives later as a new turn" mechanism a peer
  message needs, applied to a different origin thread.
- The Slack pipeline drops every message the bot itself posts and every other bot's messages
  unless the app is in `trustedApps` (`isIgnorable` in `src/slack/message-normalize.js`). So two
  channel agents cannot accidentally talk through Slack today; that is the loop guard that keeps
  the current product safe, and any new path must keep an equivalent.
- Durable approvals, the `api` principal (`src/config/api-principal.js`), the redactor, the
  usage ledger and the liveness registry are all reusable as-is.
- The skills catalog already knows peer gateways (`src/gateway/skills/peer-sync.js`: MCP over
  HTTP with a scoped access token), which is the natural seed for a cross-gateway hop later.

## 3. Proposal: channel-to-channel agent mail

The one-line design: **an agent message is a durable, attributed, bounded turn in the other
channel's own Slack thread, delivered by the daemon, with the answer re-injected into the
asking thread.** Nothing crosses the container boundary except text and, optionally, a
daemon-copied attachment. Every hop is visible to the humans of both channels.

### 3.1 Addressing, discovery and the access rule

**The access rule (decided 2026-11-06).** An agent acts on a person's behalf, so it may only
message a channel that person can reach, and the answer may only land where everyone who will
read it could have read the target themselves. Concretely, a send is admitted only when ALL of:

1. the requesting person passes `isAuthorized()` on the target channel (admin or approved, the
   target's access policy, a guest grant), AND
2. the requesting person is a live member of the target conversation (admin status does not skip
   this; a person who cannot open the target thread may not have an agent write there), AND
3. every member of the SOURCE conversation is also a member of the target, because the reply is
   re-injected into the source thread and read by all of them (a public channel can therefore
   never message a private one), AND
4. the target channel's manager has switched "accepts agent messages" on.

These are exactly the semantics the specialist agent directory shipped on 2026-10-21
(`search_agents`, `src/gateway/agent-directory.js`, verifier in `src/slack/agent-directory.js`):
requester authorization, live chat membership, the source-audience rule, DMs excluded, re-verified
live rather than from cache. `send_agent_message` reuses that verifier as its gate. The checks run
at every hop: when the tool is called, again immediately before the target turn spawns (membership
can change while a message waits in the queue), and again before every reply is re-injected.

- Discovery is `search_agents`; there is no separate peer list. Managers describe or hide their
  agent with `set_channel_agent_profile`; the new `acceptsMessages` flag sits beside `hidden`.
  The access rule makes a per-channel sender allowlist redundant, so there is none.
- `send_agent_message({ to, message, reply_wanted, attachment? })` addresses a channel by the id
  or name a `search_agents` result returned.
- The person's access decides REACHABILITY, never AUTHORITY: the delivered turn runs as the fixed
  `agent:<from-slug>` principal with the requester as attribution only (section 3.2), so a
  prompt-injected sender can never borrow the requester's personal tokens or admin bypass in the
  target. This is the split the run API already enforces for its `author` field.
- Unattended origins: a schedule's send uses the schedule's creator, re-checked live at fire time
  (as admin status already is); a background agent's send uses its author; an API run cannot
  send in phase one because its `author` is untrusted attribution.

### 3.2 Delivery

1. The tool writes a row to a new `agent_messages` table (migration 32: id, from_slug,
   from_thread_key, requested_by user id, to_slug, to_thread_key, hop, round, status,
   created/answered timestamps, cost) and returns `{ status: "queued", id }`. The sender ends its
   turn; the gateway-usage guide tells it to, exactly like a background job.
2. The daemon posts the message into the target channel as a new thread through `postNotice`:
   "📨 Message from #marketing's agent, requested by @Tiberiu: …" with a footer button that
   links back to the origin thread.
3. The daemon runs a turn in that thread with `runMessage`, authored by a new fixed principal
   `agent:<from-slug>` (`src/config/api-principal.js` gains a sibling): no personal Composio
   token, no personal secrets, never an admin author, never `--dangerously-skip-permissions`.
   The turn runs under the TARGET channel's mode, container, memory, skills and secrets. The
   preamble states the provenance and that the message carries no authority.
4. The target's reply is posted in its thread AND re-injected into the origin thread as a new
   turn of the origin session (the `background.js` `_finish` path, generalized to a foreign
   thread), attributed "📬 Reply from #sales's agent". The origin session continues with its own
   context intact.
5. A human in either thread can reply normally; the thread is an ordinary thread with an
   ordinary session. If a person in `#sales` answers before the agent, the agent's turn sees the
   human message on its next turn like any other.

### 3.3 Guards (all of them, from day one)

- **Rounds.** `round` counts agent-to-agent exchanges per (origin thread, target thread) pair;
  default cap 3, configurable per channel, hard maximum 10. Past the cap the tool refuses with a
  named reason and the thread says so.
- **Depth.** A turn authored by `agent:*` may send one further message (depth 2) and no more, so a
  chain cannot fan out; it may never create schedules, background agents that themselves send,
  or "forever" approvals.
- **Cycles.** The envelope carries the full hop path; a target already on the path is refused
  (this is the three-agent case OpenClaw's pairwise cap misses).
- **One in flight per pair**, queue otherwise, with the existing per-thread run queue.
- **Budget.** A per-exchange token and cost ceiling, drawn from the same usage ledger; the
  license admission call runs on the target's turn exactly as for any other message.
- **Approval gate (optional per channel).** `agentMail.requireApproval` posts the durable
  approval card before the target runs, so a sensitive channel's humans decide first.
- **Provenance is structural.** The `agent:` principal is a fixed identity like `api`; the
  message text is untrusted data in the prompt, wrapped and labeled, never an instruction the
  daemon acts on. The redactor runs on both sides, so a secret cannot leak by being quoted
  across channels.
- **Audit.** `events` rows `agent_message_sent` / `_delivered` / `_answered` / `_refused` with
  both slugs and the requesting user, and a row in the channel audit of each side.

### 3.4 What stays out of scope on purpose

- No shared filesystem, no shared memory. Sales's memory stays in Sales; what Marketing learns
  is what Sales's agent chose to say. Attachments are copied by the daemon into the target's
  `uploads/` under the existing byte cap, never mounted.
- No shared "room" thread in phase one. A three-way room (two agents and humans in one channel)
  needs each agent to post under its own identity; Slack allows `username` and icon overrides on
  `chat.postMessage` with `chat:write.customize`, but the inbound side would still see one bot
  user, so the room has to be daemon-routed anyway. Phase two.
- No external peers in phase one. A2A is the obvious later hop (an agent card per opted-in
  channel, per-peer tokens minted like the skills sync tokens) and would let a Hermes or Buzz
  agent address a ChannelGate channel. Phase three, and only after the in-gateway version has
  run for a while.

### 3.5 Where it lives

| Piece | Location |
| --- | --- |
| Envelope, delivery, re-injection, guards | `src/gateway/agent-mail.js` (new) |
| Tool `send_agent_message` (discovery stays `search_agents`) | `src/mcp/tools/agent-mail.js` (new), registered in `gateway-server.js` behind the capability toolset |
| Principal | `src/config/api-principal.js` (add the `agent:<slug>` principal) |
| Schema | `src/db/migrations.js` migration 32 (`agent_messages`) |
| Channel setting | `acceptsMessages` in the agent profile (`set_channel_agent_profile`, `src/gateway/agent-directory.js`), the Access tab of `src/slack/channel-settings.js`, `routes/channels.js`, admin UI |
| Access gate | the directory verifier (`src/slack/agent-directory.js`) called at send, delivery and reply time |
| Guide | `src/gateway/gateway-usage/references/agent-mail.md` (when to use it, the queued-then-end-turn rule) |
| Tests | `test/agent-mail.test.js`: requester authorization, live membership, source-audience rule, re-check at delivery and reply, round and depth caps, cycle refusal, principal has no personal scope, re-injection targets the origin thread, refusal messages |

### 3.6 A zero-code experiment (not the product)

For a demo today: add the Composio Slack app to `trustedApps`, and from `#marketing` have the
agent post "@Xavier …" into `#sales` through `composio-agent`. The mention starts a turn in
`#sales`. The reply does not come back, there is no round cap, and if both channels post
through Composio the two agents can loop until a human stops them. It proves the shape of the
interaction, and it shows why the daemon-owned path above is the version to build.

### 3.7 Suggested phasing

1. **Phase 1 (one release):** opt-in, one-way ask with reply re-injection, all guards, audit,
   channel settings, tests, `FEATURES.md` and `TEST-PLAN.md` entries with a Claude and a Codex
   acceptance case (two test channels, one sends, the reply lands in both threads, the third
   round is refused).
2. **Phase 2:** multi-round conversations with a visible transcript on both sides, optional
   approval gate, cost reporting per exchange in the usage dashboard.
3. **Phase 3:** A2A agent cards for opted-in channels and cross-gateway peers, reusing the skills
   peer-token model.
