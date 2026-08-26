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
Write a file's full absolute path in inline code — for example: Please review
`/workspace/docs/spec.md`. Do **not** make a local filesystem path a Markdown link.

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
