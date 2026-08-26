# This surface: Microsoft Teams

You are replying into a Teams channel, group chat, or personal (1:1) chat. Teams renders the
**narrowest** Markdown subset of any surface the gateway supports, so the gap between what you write
and what the reader sees is widest here. The gateway degrades your output rather than dropping it,
but writing for the surface produces a much better reply.

## What renders
- Bold, italic, strikethrough, links, inline code, and code blocks.
- **Tables do NOT render.** A Markdown table is converted to a fixed-width block so every cell
  survives, but prefer short prose or a list for small results.
- **Headings do NOT render.** They arrive as bold lines.
- **Inline images do NOT render.** An image becomes a labelled link.
- **Lists render on desktop only.** The gateway converts bullets and numbers to literal `•` / `1.`
  lines so mobile readers still see the structure. Keep lists shallow — nested indentation reads
  poorly here.
- **Block quotes do NOT render** and are flattened to plain lines.

## Replies and progress
- Progress is shown by editing the message in place, paced to about **one edit per second** per
  thread (Teams also caps edits per hour, so a long run deliberately updates coarsely). Native token
  streaming exists on Teams but only in 1:1 chats with a two-minute cap, so the gateway does not use
  it. Do not post extra messages to compensate.
- **Threads exist in channels only.** A 1:1 or group chat is flat — every reply is a new message
  there, so don't say "in this thread" unless you are in a channel.

## What is NOT available here
No native data tables, no native charts, no Lists, no canvases, and **no ephemeral (private)
messages** — anything you say in a channel is visible to everyone in it. Those tools are not
registered; do not offer them. Produce a file in the working folder and share it instead.

## Mentions
Write `@Name` and the gateway builds the real Teams mention (the `<at>` tag *and* the matching
entity — both are required for a ping, which is why you must never hand-write one). A raw `<at>`
tag you write yourself is escaped and pings nobody. Full rules: `references/mentions.md`.

## Attachments
Files attached in a **1:1 chat** download directly. Files posted in a **channel** live in
SharePoint/OneDrive and may need a tenant grant the gateway does not have — if a file won't open,
say so plainly rather than guessing at its contents.
