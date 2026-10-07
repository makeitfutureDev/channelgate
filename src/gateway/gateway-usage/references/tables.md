# Tables in Slack

The gateway's normal answer path uses Slack native streaming with `markdown_text`, which renders
small GFM pipe tables cleanly inside the answer. The gateway also offers native data tables, file
exports, and editable Lists. Choose by what the reader needs to do with the data.

## 1. Small table inside the explanation → streamed Markdown

Write a GFM pipe table directly in the final reply when it is a small part of the explanation and
the surrounding prose matters. This is the shape used by answers such as a short comparison or a
four-row list of commands. Keep it narrow enough for Slack's mobile clients—usually no more than
about 4–5 short columns and 10 rows. Use Markdown styling such as `code` or **bold** inside cells
only when it improves scanning.

```markdown
| # | Way to stop | How to trigger |
|---:|---|---|
| 1 | `/stop` command | Type `/stop` |
| 2 | Stop word | `@bot stop` (DM: `stop`) |
```

Do not call a tool for this case: output the table as part of the answer. If Slack native streaming
is unavailable, the gateway's classic fallback converts it to an aligned monospace block, so the
information survives but the polished table appearance does not.

Do not use a pipe table for a large/wide export or imitate one with a hand-aligned code block.

## 2. Sortable/filterable read-only results → native data table (`slack_post_table`)

Use this when the rows are the result—not merely a small illustration inside prose—and the reader
benefits from sorting, filtering, or pagination. Slack renders a separate Block Kit data table with
a header row, pagination, sorting, and filtering.

`slack_post_table` (gateway, always available; posts as the bot into THIS thread):

- `caption` — a short accessible table title.
- `headers` — 1–20 column names (plain text; Slack allows no formatting in header cells).
- `rows` — 1–200 rows; each row must contain exactly one cell per header. A cell is:
  - a **number** — pass numbers as numbers, not strings, so Slack sorts the column numerically
    (a column sorts numerically only when every cell in it is a number);
  - a **string** — plain text, or lightweight Markdown that becomes a formatted cell:
    `[label](https://…)` and bare `https://` URLs become clickable links, `**bold**`, `` `code` ``,
    `~~strike~~` style the text (a raw `<@U…>` stays text). Use `"—"` for deliberately empty values;
  - an **object**, when you want to be explicit: `{text, url}` a link, `{text, bold|italic|strike|
    code: true}` formatting, `{user: "U…"}` a mention, `{button: {label, url}}` a **row button**
    that opens the URL (*Open task*, *View invoice*, *Inspect run*). Buttons take public https
    URLs only.
- `page_size` — optional visible rows per page, 1–100; defaults to up to 10.
- `row_header_column` — optional zero-based column index that identifies each row for screen
  readers; defaults to the first column.
- `summary` — optional top-level notification/accessibility text. Keep it to one sentence.

Slack caps the aggregate cell content at 20,000 characters (readable text; link URLs and markup
do not count). Do not silently truncate data to fit: switch to `slack_upload_snippet`, split only
when the user asked for separate tables, or ask which slice they want. After the tool succeeds,
reply with only a short takeaway; do not paste the table again.

To put the table **inside your final answer** (takeaway + table in one message) use
`slack_compose_reply` with a `table` section instead — see `references/composed-replies.md`.

Example — supplier configuration status:

`slack_post_table` with `caption:"Suppliers in space 6"`,
`headers:["ID","Name","Tier 1 CZ","Tier 2 B2B","Tier 3 EN","Status","Record"]`, and rows such as
`[2,"HansGrohe","✅","✅","✅","Fully configured",{button:{label:"Open",url:"https://erp.example/suppliers/2"}}]`.

## 3. Big or wide read-only exports → file snippet (`slack_upload_snippet`)

Use this for many rows/columns, a report, or an “all records” export. Give the data as CSV or TSV;
Slack renders a scrollable spreadsheet grid instead of cramming it into a message.

- `content` — CSV or TSV body with a header row.
- `title` — file label shown in Slack.
- `filename` — optional; `.csv`/`.tsv` renders as a spreadsheet grid, while `.md`/`.txt`/code
  extensions render as text. Defaults to `<title>.csv`.
- `comment` — optional one-line summary posted with the file.

Prefer TSV when values contain commas. Do not also paste the exported rows into the reply.

A file that already exists in the working folder — a report, a PDF, `.json`, `.html` — is not
re-typed into this tool: send it with `slack_share_file` (see `references/writing-replies.md`).

Example — all duplicate drafts: call `slack_upload_snippet` with
`title:"107 duplicate drafts — cleanup list"`, `filename:"cleanup.tsv"`, a one-line `comment`,
and TSV `content` containing the full header and rows.

## 4. A tracker people edit over time → Slack List (`slack_list_*`)

Use a native Slack List for a task list, checklist, or small shared database people update. Lists
have typed columns and persist independently from the message thread.

- `slack_list_create` — create a List. Defaults to `Name` + `Status`; `todo_mode:true` enables
  Slack's built-in to-do fields, while `columns` accepts a custom schema. Save the returned
  `list_id`; ChannelGate grants the current conversation write access automatically.
- `slack_list_add_item` — add a row using `list_id`, `name`, and optional `fields`.
- `slack_list_update_item` — update a row using `list_id` + `item_id`.
- `slack_list_items` — read rows and their item ids.
- `slack_list_info` — inspect columns before editing a List you did not create.

## Quick rule

- Small table embedded in the answer, about ≤10 rows / ≤5 short columns → **GFM pipe table in the reply**.
- Standalone read-only dataset users should sort/filter, within 200 rows / 20 columns / 20,000
  characters → **`slack_post_table`** (or a `table` section of `slack_compose_reply` when it
  belongs inside the final answer).
- Larger or wider read-only export → **`slack_upload_snippet`** (CSV/TSV file).
- People will edit it over time → **Slack List**.
- Only a couple of facts → use bullets.
