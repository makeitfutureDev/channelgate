# Writing Slack replies

Your normal reply is posted through Slack's native streaming API as `markdown_text`. Write concise
standard Markdown for that renderer. If native streaming fails, the gateway converts the same
answer to Slack mrkdwn and posts it normally, so simple Markdown degrades safely. Do not use HTML.

## Keep it short
- Lead with the outcome and the few key results, in a handful of lines. Long messages get folded
  behind a "Show more" that's annoying to expand.
- Don't paste long logs, full file dumps, or step-by-step narration. The gateway already shows a
  live progress status while you work, so skip "now I'll do X" play-by-play — just send the final
  answer.
- Offer detail only if asked ("want the full log?").

## Formatting — what Slack supports
- `**bold**` and `_italics_`.
- `~~strike~~`.
- `` `inline code` `` and triple-backtick fenced code blocks.
- `- ` bullets and `1.` numbered lists.
- `> ` blockquote.
- Links: `[label](https://example.com)`.
- Small GFM pipe tables when the rows belong directly in the explanation. See
  `references/tables.md` before choosing a table shape.

## Naming a local file — write the path in inline code

Any time your reply points at a file in the working folder — a report you wrote, a file you
changed, a log worth reading — put its path in inline code. Write it **relative to the working
folder**; that is the short, readable form, and it keeps the host's home directory out of the
Slack message:

```
✅ Done. `work/acme-sow/ACME_SOW.pdf` — 10 pages, branded template.
✅ Full write-up in `csv-import/REPORT.md`, mapping in `csv-import/MAPPING.md`.
✅ `REPORT.md`                                  ← a file at the folder root
✅ `/Users/you/ChannelGate/slack/acme/REPORT.md`      ← absolute works too, just noisier
❌ [REPORT.md](/csv-import/REPORT.md)           ← Slack can't open server paths
```

Why it matters: the gateway scans your reply for inline-code paths, resolves each one against the
working folder, and for every candidate that turns out to be an existing regular file inside that
folder it adds a requester-bound `📄 REPORT.md` button to the reply footer — up to five, in
first-mentioned order. The button opens the channel file explorer straight to that file's preview,
so the user reads it in one click instead of hunting for it.

Practical rules:

- A relative path needs a `/` or a file extension to be recognized (`work/out.pdf`, `REPORT.md`).
  A bare word with neither — `main`, `staging` — is treated as ordinary inline code, never a file.
- Point at the **landed** file, not a temporary copy. If you worked in `.worktrees/<slug>/…` and
  then removed the worktree, that path no longer exists at reply time and silently yields no
  button — name the file at its final location instead.
- Only files inside this run's working folder become buttons. Paths outside it, directories, and
  files that don't exist are ignored, so a path you invented produces silence rather than an error.
- Mention only the files that genuinely warrant opening. Five buttons is the cap; a wall of paths
  is worse than the two that matter.
- A trailing `:line` or `:line:col` is fine — the gateway strips it before resolving.
- Never make a local path a Markdown link. Slack cannot open `file:` URLs or server paths. Normal
  HTTPS links for web resources are unaffected.

## Avoid these
- Long heading hierarchies. Use a short bold label for compact Slack answers.
- HTML and images-by-Markdown.
- Markdown links whose target is a local filesystem path; use the inline-code form above.
- Wide pipe tables or hand-aligned fenced-code tables; both wrap badly on narrow Slack clients.
  Use `slack_post_table` for a sortable/filterable dataset and `slack_upload_snippet` for a large
  or wide export.

## Bold the label, not the whole sentence
Prefer a compact native shape: one bold outcome line, then 2–4 short bullets only when they add
scan value. Bold the label: `**Fixed:** restart now stops old processes` — not a fully-bolded
sentence.

## Safety net (don't rely on it)
If streaming is unavailable, the gateway's Markdown→mrkdwn backstop converts bold, links, headings,
and lists; a pipe table becomes an aligned monospace block. That preserves the information but not
the native table appearance. Choose the table shape deliberately rather than relying on fallback.

## Message length
Very long replies are automatically split into multiple messages on line boundaries (fenced code
blocks are kept valid across the split). You don't need to chunk manually, but shorter is still
better.
