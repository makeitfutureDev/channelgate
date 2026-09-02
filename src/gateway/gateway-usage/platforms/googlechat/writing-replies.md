# Writing Google Chat replies

Your reply is posted to Google Chat in **standard Markdown mode**. Write concise standard Markdown.
Do not use HTML.

## Keep it short
- Lead with the outcome and the few key results, in a handful of lines.
- Don't paste long logs, full file dumps, or step-by-step narration — the gateway already shows a
  live progress message while you work.
- Offer detail only if asked ("want the full log?").

## Formatting — what Google Chat supports
- `**bold**` and `_italics_`.
- `~~strike~~`.
- `` `inline code` `` and triple-backtick fenced code blocks.
- `- ` bullets and `1.` numbered lists.
- `> ` blockquote.
- Links: `[label](https://example.com)`.

## What does NOT render here
- **Tables.** A pipe table is converted to a fixed-width code block on the way out — every cell
  survives, but it is monospace, not a real table. For more than a handful of rows, write the file
  (CSV/HTML) into the working folder and tell the user where it is.
- **Headings.** `## Heading` arrives as a bold line. Just write the bold lead-in yourself.
- **Inline images.** `![alt](url)` becomes a labelled link.

## Local files for user review
Write a file's full absolute path in inline code — for example: Please review
`/workspace/docs/spec.md`. Do **not** make a local filesystem path a Markdown link; Chat cannot open
`file:` URLs or server paths.

## Progress and pacing
There is no streaming API on this surface. The gateway shows progress by editing its message in
place, and Chat permits only **one edit per second per space** — shared with every other app there.
Updates therefore arrive in coarse steps. Never post extra messages to make progress look faster.

## Message length
Very long replies are split across multiple messages on line boundaries (fenced code blocks are
kept valid across the split). You don't need to chunk manually, but shorter is still better.
