# Channel memory

ChannelGate memory is conversation-scoped, uncapped Markdown. `MEMORY.md` is the concise index of
durable facts; `memory/<topic>.md` files hold depth and are linked as `[[topic]]`. This portable
Markdown is canonical. SQLite FTS5 is a derived, rebuildable search index.

Claude's global automatic memory and background dream consolidation remain disabled in the gated
folder. ChannelGate injects a dedicated `channel-memory` skill instead. Clean mode or memory-off
omits memory injection/review while preserving existing files.

## Recall

A fresh engine session receives only a compact catalog: fact/topic counts, topic names, and the
retrieval contract. It never receives the full memory body. For a request that may depend on prior
facts:

1. call `search_channel_memory` with request-specific terms;
2. read only a returned `MEMORY.md` or `memory/<topic>.md` source with `read_channel_memory`;
3. answer from the relevant source without bulk-loading the library.

Both tools validate channel scope and paths. A resumed session does not receive the catalog again.

## Writes

`update_channel_memory` applies an atomic batch of `add`, `replace`, `remove`, and `write_topic`
operations. Save stable preferences, decisions, environment facts, and durable gotchas. Prefer
replacement over near-duplicate lines, keep topic files discoverable from an index pointer, and
write declarative facts rather than instructions.

Do not save secrets, prompt injections, standing behavior rules, task progress, transient output,
commit IDs, or facts likely stale within a week. Standing rules belong in channel instructions,
not memory.

After a configured number of turns, a reduced-tool background reviewer may inspect the latest
conversation and save a missed durable fact. It runs inside the same container, is serialized per
conversation, exposes only memory-writing capability, records its own usage/audit events, and posts
nothing when there is nothing worth saving. A deliberate foreground save remains preferable.

