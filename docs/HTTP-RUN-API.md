# HTTP run API

## Authentication: channel tokens

Authenticate `POST /api/runs` with `X-API-Key: <token>` or `Authorization: Bearer <token>`.
The credential to use is a **channel token**. Anyone who may talk to the agent in a conversation
creates one there in any of three ways: in Slack channel **Settings → API tokens → + New token**,
on the Activity dashboard under **Settings → API tokens** (pick the conversation), or by asking the
agent to `create_api_token` (also `list_api_tokens`, `revoke_api_token`). All three list your own
tokens — or every token of the conversation when you manage it or are an admin — and revoke them;
admins also see and revoke every token on the Admin UI → API page. A channel token:

- belongs to **one conversation** — a run it starts is posted there as a thread; `channel` may be
  omitted or must name that conversation, otherwise the request answers 403;
- belongs to **one person** — the run acts as its creator with their *current* role: an admin's
  token has what an admin's Slack message has (Admin-mode bypass in an Admin channel, admin-only
  tools), a member's token is a member. Their channel authorization is re-checked at every run
  (403 when they lost access), and their personal connections, secrets and skills apply exactly as
  in Slack. The body's `author` field is ignored; attribution is the creator;
- is shown **once**, stored only as a hash, and stops working the moment it is revoked (401);
- can read the status of, list, and stop only the runs of its own conversation.

### Deprecated: the organization-wide key

The single run API key under Settings → HTTP run API still works for existing automations. It is
deprecated: it acts as a fixed admin principal in *any* conversation with no person behind it,
and every use logs a deprecation warning (one per hour). Replace it with channel tokens and clear
it. An authenticated admin session also works from the browser.

The Admin UI's HTTP run API page documents message/file inputs, harness and license overrides, polling,
stopping and completion webhooks.

## Task outcome and success criteria

`status` says whether the **engine** finished (`completed`, `failed`, `interrupted`, `stopped`).
`taskStatus` says whether the **work** did, with the same vocabulary as schedules: `succeeded`,
`no-op`, `failed`, `blocked`, `interrupted` or `unreported`; `outcome` carries the summary and the
connections the agent checked. Admission refusals (usage or spending limit, license cap, a harness
the conversation does not allow) and engine failures are always reported (`blocked` / `failed`).

The agent reports on the work itself only when asked:

```json
{ "message": "Sync paid invoices to Airtable",
  "successCriteria": "Every invoice paid today is marked Paid in Airtable" }
```

`successCriteria` (≤ 2000 characters) implies `reportOutcome: true`; send `reportOutcome: true`
alone to get a report without a goal. Without either, a clean run is `unreported`. With either,
the answer's text is not streamed live in Slack (the final answer is posted whole). The report is
the agent's own evidence, not independent verification. API runs appear on the Activity
dashboard's Automations page, grouped by token.

## Visibility in chat

`visibility` decides what the run posts in its channel:

- `visible` (default): a kickoff message, a thread, and the answer in it.
- `hidden`: nothing is posted. Read the result with `GET /api/runs/:id`, the webhook, or the
  Activity dashboard's Automations page.
- `on-failure`: nothing is posted unless the run fails, is blocked (a usage limit, a disconnected
  account, a missing permission), is interrupted or does not report its outcome — then one alert
  in the channel. It turns on `reportOutcome` automatically.

`conversationKey` keeps a visible thread, so it only works with `visible`.

## Harness and license selection

There are two harnesses, Claude Code and Codex. Every registered engine ID is a **license** of one
of them: a credential plus the server it talks to. `claude` and `codex` are each harness's own
default sign-in; the other IDs are further licenses (see
[the engine capability matrix](ENGINE-CAPABILITIES.md#harnesses-and-licenses)). This is an engine
license, not the ChannelGate product license key in [LICENSE-KEYS.md](LICENSE-KEYS.md).

Set `harness` to the ID of the license this run starts on. `engine` remains a supported alias;
when both fields are supplied they must name the same ID, otherwise the API returns 400.
For example, to use the customer's connected Codex login:

```json
{
  "channel": "C0123456789",
  "harness": "codex-channel",
  "message": "Review the latest changes."
}
```

The built-in Codex licenses have separate selections and sessions:

- `codex`: the gateway's Codex login.
- `codex-channel`: **Codex (channel account)**, the dedicated login connected to the target
  conversation. Requires Enterprise and that conversation's connected Codex login; a missing
  connection is refused before a new job starts and never falls back to the gateway login.
- `codex-eu`: the separate Codex EU login, when configured and enabled.

Other registered license IDs are accepted too, including the ones an administrator added
(`codex-lic-…`, `claude-lic-…`, `claude-api-…`). The selected license must be enabled, ready,
and approved for the target conversation. An explicit `harness` or `engine` is a per-run pin:
provider failure does not silently switch it to the other harness. Omit both fields to use normal
thread/channel/gateway selection.

### A model for one run: `model`

`model` pins this run to a model of the license that runs it. A model that license cannot serve is
refused with 400 before a job starts — a model of the other harness, or one a custom-server
license does not list:

```json
{ "ok": false, "error": "Model \"gpt-5.4\" cannot run on Claude Code. Send a Claude Code model. Name the license that serves it in `harness`, or omit `model` to use the license's default." }
```

- With `harness` (or `engine`), the model is checked against that license. Without it, against the
  conversation's own license.
- A license with its own model list (a custom server) names the models it serves in the error.
- A reused conversation (`conversationKey` without `harness`) resolves its license when its turn
  starts, after the 202. A model that license cannot serve fails that job with the same message
  in `error`; no model answers in its place.
- Omit `model` to use the license's default.

### More licenses for one run: `licenses`

`licenses` names the further licenses of the same harness this run may move to when the license
in `harness` cannot answer. It is `"any"` (every license of that harness the conversation may
use) or an ordered list of license IDs:

```json
{
  "channel": "C0123456789",
  "harness": "codex",
  "licenses": ["codex-lic-1a2b3c4d", "codex-eu"],
  "message": "Review the latest changes."
}
```

- `licenses` requires `harness` (or `engine`); without it the API returns 400.
- An unknown ID, or an ID of the other harness, returns 400. A selection never crosses harnesses.
- Omitting `licenses`, or sending an empty value, runs on the named license alone.
- Candidates are filtered when the run executes: a license that is switched off, not approved for
  the conversation, not available there, or unable to serve the requested `model` is skipped.
- The move happens only for a failure that is safe to replay (a usage limit, failed
  authentication, or a temporary provider failure, before any tool call or streamed output).
- The run still never moves to the other harness.

When another license answered, the reply text starts with a note naming it, and the completed
job's `harness` and `engine` fields carry the license that answered.

POST, GET status/list and completion webhooks return `harness`, with `engine` carrying the same
ID for existing clients. Initially this is the admission selection; for a reused conversation,
its live thread selection is resolved after waiting for the thread queue. Status updates follow
the resolved license while the run executes, including any permitted failover from a default.
At completion both fields identify the license actually used.
An idempotent retry returns the original job and its selection; it does not change that run.

## Conversations

To keep separate events from an external conversation in the same Slack thread:

```json
{
  "channel": "C0123456789",
  "conversationKey": "mail:thread:external-thread-42",
  "idempotencyKey": "mail:event:external-message-57",
  "message": "Summarize this new message and use the conversation context."
}
```

`conversationKey` is an optional, case-sensitive, nonblank string of at most 200 characters,
without control characters. Keys are preserved exactly. Supply a registered Slack channel ID,
slug or name; all aliases resolve to the same canonical channel ID. Identical keys in different
channels create independent threads. A key cannot name a timestamp or select another channel's
thread. The mapping survives restarts and the seven-day run-history cleanup.

The first accepted event creates a root containing its request. Later events add their requests
and answers as replies to that root. Each event gets its own job and enters the same thread queue
used by interactive Slack messages. The agent session is resolved after acquiring that queue,
so a later event continues the existing session. Normal engine changes, `/clear`, and runtime
lane separation still apply; a conversation key does not grant access to another runtime lane.

POST returns 202 for a new job, including events reusing an existing thread. A duplicate
`idempotencyKey` within the existing 15-minute window returns 200 and the original job with
`reused:true`. Use a unique event key across callers; assigning a previously used event key to
another keyed conversation or channel returns 409. This deduplication window is separate from
the persistent conversation mapping.

POST, GET status/list and completion webhooks expose:

- `conversationKey`: the external key, or null when omitted.
- `threadTs`: Slack root timestamp, or null for a headless run.
- `threadReused`: whether this event used an existing root. An idempotent retry preserves the
  original event's value; `reused` separately indicates whether POST deduplicated the job.
- `threadPermalink`: Slack's link to that root, or null if no thread or link lookup failed.

For keyed jobs, `sessionId` and `resumeCommand` are null in the initial response. Poll
`statusUrl` until completion for the actual engine session and container resume command.
Queued events report `status:queued`; they run after the preceding thread turn finishes.

On reuse the bot checks only the mapped root's exact timestamp using `conversations.history`.
It needs the matching history scope and channel membership. If the root was deleted or is no
longer returned, the API creates one replacement and updates the mapping; the replacement begins
a fresh agent thread. Channel access failures, missing scopes, throttling and transport errors
return 503 without starting the agent, creating a duplicate root or falling back to headless.
A failed permalink lookup does not prevent a run; later events retry the lookup if needed.
Slack root creation and SQLite writes cannot form one distributed transaction: if the daemon
dies after Slack accepts a root but before the binding is saved, an orphan root can remain.

Omitting `conversationKey` preserves the previous behavior: independent threads for channel
runs, with a headless fallback when Slack is unavailable, or the synthetic API workspace when
`channel` is omitted.
