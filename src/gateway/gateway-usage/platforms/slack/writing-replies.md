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
- Images you create: save the image inside the working folder and write
  `![descriptive alt text](reports/chart.png)`. When the answer finishes, the gateway uploads up to
  five unique referenced images into the thread as native Slack files, giving the reader Slack's
  inline thumbnail, download control, and full preview. Paths with spaces use angle brackets, for
  example `![Revenue](<reports/revenue chart.png>)`. Only regular image files contained by the
  working folder are eligible; escaping symlinks, missing files, and fenced examples are ignored.
- Public image previews: `![descriptive alt text](https://example.com/image.png)`. The URL must be a
  publicly reachable HTTP(S) image. The gateway appends it as a Block Kit image preview and keeps
  the Markdown reference as a clickable fallback.
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

## Sending the file itself — when they ask for it

Naming the path gives the reader a 📄 button to open. When they ask for the **file**, not a pointer
to it — "send it here", "share the file", "can you just attach it", "put it in the thread" — upload
it with `slack_upload_snippet` (gateway control tool, bot token, always available). Read the file
and pass its text as `content`, keeping the real name in `filename`:

```
slack_upload_snippet
  filename: "REPORT.md"
  title:    "Migration report"
  comment:  "Full write-up — 3 blockers, all fixed."
  content:  <the file's full text>
```

- **Any UTF-8 text file works** — `.md`, `.txt`, `.json`, `.html`, `.csv`/`.tsv`, `.yaml`, `.sql`,
  `.py`, a diff, a log. The extension decides the preview: `.csv`/`.tsv` render as a scrollable
  spreadsheet grid, `.md`/`.txt`/code extensions as a text snippet Slack shows inline behind a
  "see it in full" expander. Keep the file's own extension — renaming `.json` to `.txt` only loses
  the syntax highlighting.
- **`.html` uploads and downloads fine, but Slack previews the source, not the rendered page.** Say
  that in one line and tell the reader to download it and open it in a browser. Never promise a
  rendered preview in Slack.
- **Images are already handled.** Reference them as `![alt](reports/chart.png)` (above) and the
  gateway uploads them as native files with inline thumbnails. Don't snippet an image.
- **Binaries can't ride this tool** — `.pdf`, `.pptx`, `.xlsx`, `.zip`, anything not text. `content`
  is a string, so the bytes would be mangled. Name the path in inline code instead and point the
  user at the 📄 footer button, whose file explorer can share the real file into the channel.
- **Big files stay buttons.** The whole file passes through your context to become `content`, so a
  multi-megabyte upload is slow and expensive. Above roughly 1 MB, name the path and offer to send
  it rather than uploading by reflex.
- **Send what was asked for** — the file they named, or the few they named, not the whole folder.
- **Don't do both.** After the upload succeeds, reply with a one-line summary; never paste the same
  content into the message as well.

## Avoid these
- Long heading hierarchies. Use a short bold label for compact Slack answers.
- HTML, data-URI images, local image paths, and private/non-public image URLs. Use standard Markdown
  image syntax only with a public HTTP(S) asset that Slack can fetch.
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
