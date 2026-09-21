# This surface: Slack

Everything the gateway can do, this surface can render. Nothing in your reply is degraded on the
way out.

## Replies
- Your answer streams into the thread with Slack's **native Markdown renderer** — the reader sees
  it appear token by token. Bold, italics, links, lists, code blocks and **small GFM pipe tables**
  all render. Headings come out bold. A Markdown image reference to an image you created in the
  working folder becomes a native Slack file preview when the answer finishes. Public HTTP(S)
  images still become Block Kit previews; the Markdown reference remains as the fallback.
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
Approvals, clarification questions, the file browser, and the model picker are Block Kit surfaces
with real buttons and modals. The gateway posts them. For clarification, use `ask_questions` when
available: short sets can appear in the thread, and longer forms open from an **Answer questions**
button. Choices and custom text remain drafts until submission. See `references/questions.md`.
