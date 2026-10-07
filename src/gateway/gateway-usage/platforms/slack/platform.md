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
Sortable data tables (with link, formatted, mention and row-button cells), charts, Slack Lists,
file snippets, and canvases — see `references/tables.md`, `references/charts.md`,
`references/canvases.md`. Prefer these over ASCII art whenever the data is genuinely tabular or
visual. A chart, a table, cards, link buttons or a collapsible details panel can also ride
**inside your final answer** through `slack_compose_reply` (`references/composed-replies.md`), so
a takeaway and its visuals arrive as one message.

## While you work, and after
- Slack shows its native loading state and a **Stop** button on the thread while a turn runs (the
  thread's agent session is `processing`); pressing it cancels the run exactly like a `stop`
  message or a 🛑 reaction. You need do nothing for it.
- Every reply ends with the run footer, the 📂 🔑 ⚙️ menu and native 👍/👎 feedback controls. A 👎
  is recorded and the reader is invited to say what was off in the thread — treat that follow-up
  as a correction request.

## Mentions and broadcasts
Write `@Name` and the gateway turns it into a real ping. `@channel`, `@here` and `@everyone` are
real Slack broadcasts — use them sparingly. Full rules: `references/mentions.md`.

## Interactive controls
Approvals, clarification questions, the file browser, and the model picker are Block Kit surfaces
with real buttons and modals. The gateway posts them. For clarification, use `ask_questions` when
available: short sets can appear in the thread, and longer forms open from an **Answer questions**
button. Choices and custom text remain drafts until submission. See `references/questions.md`.
