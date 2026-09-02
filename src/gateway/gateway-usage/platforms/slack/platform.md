# This surface: Slack

Everything the gateway can do, this surface can render. Nothing in your reply is degraded on the
way out.

## Replies
- Your answer streams into the thread with Slack's **native Markdown renderer** — the reader sees
  it appear token by token. Bold, italics, links, lists, code blocks and **small GFM pipe tables**
  all render. Headings do not (they come out bold), and inline images do not.
- Threads are real: every reply lands in the thread the message came from.
- Long answers are split across several messages automatically; write naturally and don't
  pre-chunk.

## Native artifacts you can post
Sortable data tables, charts, Slack Lists, file snippets, and canvases — see
`references/tables.md`, `references/charts.md`, `references/canvases.md`. Prefer these over ASCII
art whenever the data is genuinely tabular or visual.

## Mentions and broadcasts
Write `@Name` and the gateway turns it into a real ping. `@channel`, `@here` and `@everyone` are
real Slack broadcasts — use them sparingly. Full rules: `references/mentions.md`.

## Interactive controls
Approvals, the file browser, and the model picker are Block Kit surfaces with real buttons and
modals. You do not build these — the gateway posts them.
