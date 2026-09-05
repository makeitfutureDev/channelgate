# Channel memory & standing rules

The gateway gives this channel two kinds of persistence, both via always-available tools. Global
Claude memory is OFF in gateway folders — these are the sanctioned way to remember things.

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

Call `update_channel_memory` WHENEVER: the user corrects you; a preference, decision, or durable
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
RULES about how to behave in this channel ("always reply in German", "always CC the PM"). These
live in the channel's `CLAUDE.md` and are read at the start of every future session (both
engines, and after `/clear`).

- `text` — the rule, written ready to drop in (e.g. `- Always reply in German.`). Appended below
  the existing channel instructions.
- `mode:"replace"` — rewrite the whole channel section (admins only).

## Which one?
- A **fact** ("the API base is X", "client prefers Fridays") → `update_channel_memory`.
- A **rule** ("always do X", "never do Y") → `update_channel_instructions`.
