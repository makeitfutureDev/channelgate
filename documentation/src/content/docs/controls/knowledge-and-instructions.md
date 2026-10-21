---
title: Memory and instruction controls
description: Search, read, and update channel knowledge and request standing rules.
---

Memory stores declarative facts for later retrieval. Instructions govern behavior. Memory and
instruction controls use the current conversation only. Agent discovery returns a separately
authorized directory projection; it never reads another conversation's memory or history.

## search_agents

Find an existing specialist channel agent by purpose, example tasks or active shared skills.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `query` | No | Up to 500 characters; empty lists eligible agents. |
| `limit` | No | Integer 1–50; default 20. |
| `offset` | No | Integer 0–10000; default 0. Use the previous page's `nextOffset`. |

**Authority and scope:** Authenticated conversation member with current gateway access. Live
platform checks protect the requester and reply audience; API/untrusted principals are refused.
Slack currently supplies the metadata/membership provider. Unsupported or offline providers fail
closed. DMs/group DMs never appear as agents; personal skills never contribute. Private targets
cannot appear in public/shared sources. Other results require the complete current source roster
to belong to the target; a real one-to-one bot DM uses the requester's membership.

**Result:** `agents`, `returned`, `hasMore` and `nextOffset`. Entries include the channel link,
purpose, examples, current shared skill summaries and platform verification time. Summaries
prioritize query matches; `skillsTotal` and `skillsTruncated` identify shortened skill lists.
Pages are bounded to 64 KiB. Continue with the same query and returned offset.

**Restrictions:** No messages, invitations, delegated runs or file transfers. Cached metadata
narrows search but never authorizes a result. Channel metadata reconciles on startup and nightly
at 03:00 host-local time without an engine turn; platform-purpose keyword updates may wait for
that refresh. Curated profiles and shared skill changes participate immediately. See
[set_channel_agent_profile](/docs/controls/conversation-settings/#set_channel_agent_profile).

## search_channel_memory

Search request-relevant persistent memory in this conversation.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `query` | Yes | Search terms. |
| `limit` | No | Integer 1–20; default 8. |

**Authority and scope:** Current conversation, memory enabled. No cross-conversation search.

**Result:** Ranked source paths and excerpts using FTS5 when available, otherwise a bounded document scan.

**Restrictions:** Retrieve only relevant sources. Disabled memory returns a diagnostic rather than loading files.

## read_channel_memory

Read a source identified by memory search.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `source` | Yes | `MEMORY.md` or `memory/<topic>.md`. |

**Authority and scope:** Current conversation, memory enabled.

**Result:** Source text or a not-found/refusal message.

**Restrictions:** Only recognized memory source paths are accepted; no traversal, arbitrary file reads, or preemptive loading of all topics.

## update_channel_memory

Save durable facts as one validated batch.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `operations` | No | Preferred array of `{action,text?,old?,section?,topic?,content?}` operations. |
| `action` | No | Single-operation fallback: `add`, `replace`, `remove`, `write_topic`. |
| `text` | No | Concise fact for add, or complete replacement line for replace. |
| `old` | No | Unique existing substring for replace; matching substring for remove. |
| `section` | No | For add: People & preferences, Decisions, Environment & gotchas, or Project state; optional. Omitted or unknown section appends to the index end. |
| `topic` | No | Topic slug for write_topic. |
| `content` | No | Full topic Markdown for write_topic. |

**Authority and scope:** Current admitted conversation; memory enabled. No human approval gate. Background memory review exposes a restricted save context.

**Result:** Changed/unchanged state, affected memory path, topic/index result and diagnostics.

**Restrictions:** Use a nonempty operations batch or a single action. Action-specific fields are required semantically. Facts only: never secrets, transient progress, or behavioral rules. Files are uncapped in aggregate but bounded to 8 MiB each and 32 MiB per batch. Validation precedes writes; concurrent saves serialize, each file replaces atomically, a crash can interrupt a multi-file batch. After three consecutive validation failures the tool asks the agent to stop retrying.

## update_channel_instructions

Request a durable change to this conversation’s standing behavior rules.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `text` | Yes | Ready-to-use instruction, maximum 2,400 characters, no triple-backtick fences. |
| `mode` | No | `append` (default) or `replace`. |

**Authority and scope:** Admitted conversation author for append; administrator for replace. Exact text requires the durable human approval path.

**Result:** Pending approval ID; the daemon applies exactly that change after approval, even after restart.

**Restrictions:** Nothing changes on a pending response. Deny or Comment cancels. Whole-section replacement is admin-only. Durable facts use memory; instructions apply to future sessions and survive /clear.

## Related guides

[Memory](/docs/features/memory), [channel instructions](/docs/features/channel-instructions), [approvals](/docs/features/approvals), and [gateway guide](/docs/features/gateway-operating-guide).
