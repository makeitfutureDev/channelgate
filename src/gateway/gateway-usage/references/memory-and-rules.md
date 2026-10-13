# Choosing where an ongoing request belongs

**Classify every ongoing request before saving it.** “Always”, “from now on”, “remember”, and
“every day” express persistence, not its destination. Choose the narrowest scope that covers the
user's intent; respect an explicitly named destination. Read the relevant existing content first.

| The request changes… | Save it in… | Example |
| --- | --- | --- |
| A durable fact, preference, or decision for recall | Channel memory | “The billing contact is Alex.” |
| A reusable procedure for a domain/task | The existing relevant skill | “Whenever checking email, also review spam.” |
| What one existing automation does | That schedule's instructions | “Include spam cleanup in my daily email check.” |
| Behavior across tasks in this conversation | Channel instructions | “Reply in German throughout this channel.” |
| Only the present task | This turn; no persistent write | “Check spam this time.” |

For a procedure used both manually and on a schedule, keep the procedure in the skill and make
that schedule invoke it. Update both only when needed for execution, without duplicating the
whole procedure. Keep mailbox/account-specific choices in a personal skill or that account's
schedule; do not generalize them into a shared skill or organization rule.

1. Inspect the applicable skill, schedule, memory entry, or channel section; reuse it rather than
   creating a second copy. For schedules, list them, identify the intended task, then read its
   full prompt with `list_schedules` and `id`. Do not infer its content from the title.
2. Patch the relevant content while preserving unrelated instructions, account, cadence, creator,
   and delivery. Read `references/skills.md` or `references/reminders.md` before the tool call.
3. Verify the saved content or exact pending proposal, then tell the user where it went and why:
   “Updated your personal email skill; the daily check invokes it.” A pending change is not saved
   or active. If a tool or permission is missing, use the appropriate proposal path or explain
   the blocker; **never use channel instructions or memory as a fallback destination**.

Use context to resolve the target. Ask one focused question only when materially different skills,
accounts, schedules, or scopes remain plausible; continue independent work while awaiting the reply.
A correction such as “this belongs in the email skill” updates that source. Remove a misplaced
copy only when identified and authorized, preserving all unrelated content and approvals.

**Spam example:** “Always also clean spam; move important messages to inbox, otherwise delete”
during an email workflow belongs in its email skill (preserving its account and deletion semantics).
If the user refers specifically to the daily job, update that existing schedule or its skill
invocation. Do not append an email cleanup rule to the conversation's general instructions.

Global Claude memory is OFF in gateway folders. The following tools serve facts and genuinely
channel-wide rules after this scope decision.

## Facts → channel memory (`update_channel_memory`)
Durable FACTS future sessions must know (preferences, decisions, environment facts, gotchas).
Backed by uncapped Markdown: `MEMORY.md` for durable facts and references, grouped under
`People & preferences · Decisions · Environment & gotchas · Project state`) plus
`memory/<topic>.md` topic files for depth, linked as `[[topic]]`. Fresh sessions receive only a
compact catalog. Use `search_channel_memory`, then `read_channel_memory`, to load relevant content;
never load the whole library preemptively. SQLite FTS5 is a derived search index, not a second
source of truth.

**You already have it:** the index is injected at the start of every session as the
`[Channel memory …]` block. Read a `memory/<topic>.md` file when the task touches that topic.

After the scope decision, call `update_channel_memory` for durable facts when the user corrects you; a preference, decision, or durable
fact is stated; you learn a stable fact about accounts, ids, paths, or conventions; you discover a
gotcha or working technique. Also do a final check before your last reply — did this thread teach
something durable? (A background reviewer runs after some turns as a backstop, but a save you make
yourself is immediate and precise.)

Make ALL changes in ONE call with `operations`; the batch applies atomically and storage is uncapped:
- `add` — one concise line (`text`; optional `section`).
- `replace` — `old` (a unique substring of an existing line) → the whole line becomes `text`.
  Prefer this over near-duplicate adds.
- `remove` — drop the line(s) containing `old`.
- `write_topic` — create/update `memory/<topic>.md` (`topic` + `content`); keep an index pointer
  line so it stays discoverable.

What to save (highest value first): preferences & corrections > decisions > environment facts >
techniques. What to skip: task progress, completed-work logs, PR/issue numbers, commit SHAs,
temporary paths, raw data — anything stale within a week. Write declarative facts
("Alex prefers short replies"), never imperatives ("Always reply briefly"). Instruction-shaped or
secret-shaped text is refused. Never store secrets/tokens.

> This channel also has a dedicated `channel-memory` skill that fires on its own — if it's
> present, follow it; this section is the summary.

## Behavior → standing instructions (`update_channel_instructions`)
RULES about behavior across tasks in this channel ("always reply in German"). Domain procedures
and individual automation changes belong in their skill or schedule, even when phrased “always”. These
live in the channel's `CLAUDE.md` and are read at the start of every future session (both
engines, and after `/clear`).

- `text` — the rule, written ready to drop in (e.g. `- Always reply in German.`). Appended below
  the existing channel instructions.
- An append returns pending approval; report the proposal as pending until applied.
- `mode:"replace"` — rewrite the whole channel section (admins only); preserve unrelated rules.
