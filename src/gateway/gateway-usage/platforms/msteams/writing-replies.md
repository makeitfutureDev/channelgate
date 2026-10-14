# Writing Microsoft Teams replies

Your reply is posted to Teams as a bot message using its **narrow Markdown subset**. This is the
most restrictive surface the gateway supports — write plainly and the reply will look right.

## Keep it short
- Lead with the outcome and the few key results, in a handful of lines.
- Don't paste long logs, full file dumps, or step-by-step narration — the gateway already shows a
  live progress message while you work.
- Offer detail only if asked ("want the full log?").

## Formatting — what Teams supports
- `**bold**` and `_italics_`.
- `~~strike~~`.
- `` `inline code` `` and triple-backtick fenced code blocks.
- Links: `[label](https://example.com)`.

## What does NOT render here
- **Tables.** Converted to a fixed-width code block on the way out. Prefer prose or a short list;
  for real datasets write a file into the working folder and say where it is.
- **Headings.** They arrive as bold lines.
- **Inline images.** They become labelled links.
- **Lists render on desktop only.** The gateway converts bullets and numbers to literal `•` / `1.`
  lines so mobile readers keep the structure — but keep lists short and never nest them deeply.
- **Block quotes.** Flattened to plain lines; don't rely on `>` for emphasis.

## Local files for user review
When asked to send or attach a file here, use `gateway` → `share_file` with its workspace-relative
path. It posts **Open file** in this conversation; the requester opens a private Teams window
with a text preview and download/edit controls. No Composio account or public link is needed.
Do not use Slack tools in Teams or promise automatic file buttons from a path in your reply.
For manual browsing, send `@bot /files` in channels/groups or `/files` in personal chat;
`/sendfile <workspace-relative path>` opens a selected file.
Text/Markdown previews show up to 2,600 bytes, and **Edit file** opens a browser editor for text
files up to 250,000 characters. A `.docx` shows a read-only text preview without formatting and
cannot be edited there; PDF and other binary files download for opening in their own application. Native Accept/Decline file sending is available through
`/sendfile` only in an existing personal bot chat (nonempty files up to 10 MB).
Do **not** make a local filesystem path a Markdown link.

## Progress and pacing
The gateway shows progress by editing its message in place, paced to about one edit per second per
thread (Teams also caps edits per hour, so long runs update coarsely). Never post extra messages to
make progress look faster.

## Privacy
There are **no ephemeral messages** on this surface. Anything you post in a channel is visible to
everyone in that channel — never assume a reply is private to the person who asked.

## Message length
Very long replies are split across multiple messages on line boundaries (fenced code blocks are
kept valid across the split). You don't need to chunk manually, but shorter is still better.
