# Composed replies — a chart, a table or a details panel INSIDE the final answer

`slack_compose_reply` (gateway, always available) attaches native Slack Block Kit to **your final
answer message**, so one polished message carries the takeaway and its visuals instead of a
separate post per chart or table. The blocks render **under your streamed answer text and above
the run footer**, in the order you pass them.

Use it when the answer is a short takeaway plus one or two visuals: a spending report (takeaway →
chart → sortable table → *Export CSV* link), a research result (summary → cards → collapsible
sources), a generated file (card with *Open* button). Keep using `slack_post_chart` /
`slack_post_table` when the visual should be its own message (several tables, an interim result
while work continues, a scheduled post with no prose).

## Tool shape

`sections` — 1–12 ordered items. Each is one of:

| `type` | Fields | Renders as |
| --- | --- | --- |
| `text` | `markdown` (≤ 3000 chars) | a Markdown section (bold, links, lists) |
| `chart` | `chart_type`, `title`, `series` or `segments`, `x_label?`, `y_label?` | the same native chart as `slack_post_chart` — same rules and limits (`references/charts.md`) |
| `table` | `caption`, `headers`, `rows`, `page_size?`, `row_header_column?` | the same native data table as `slack_post_table` — link, formatted, mention and button cells included (`references/tables.md`) |
| `collapsible` | `title` (≤ 150), `markdown` (≤ 3000), `collapsed?` (default true) | an expandable panel — sources, validation detail, a long explanation |
| `card` | `title` (≤ 150), `subtitle?`, `body?` (≤ 200), `subtext?`, `image_url?` (public https), `buttons?` ≤ 3 `{label, url}` | a card — a product, a result, a generated file |
| `links` | `buttons` 1–5 `{label, url}` | a row of link buttons (*Export CSV*, *Open preview*, *View PR*) |
| `divider` | — | a horizontal rule |

Rules:

- **Call it once, with every section**, before you write the final text. A later call replaces the
  earlier snapshot entirely (it does not append).
- Then write the short answer as usual. **Do not repeat the chart or table data in prose.**
- Buttons and card actions take **public https URLs only**. A local file is named in inline code
  instead (it becomes a `📄` footer button — see `references/writing-replies.md`); a file to hand
  over is sent with `slack_share_file`.
- At most 40 blocks in total; a `card` and a `links` row count as one block each.
- The tool refuses a section that breaks a Slack limit and says which — fix it and call again.
- If Slack rejects the composed blocks when the answer is finalized, the gateway still delivers
  the answer text with its footer; the visuals are dropped from that message, never the answer.

## Example

```
slack_compose_reply
  sections: [
    { type: "chart", chart_type: "bar", title: "Spend by month",
      series: [{ name: "EUR", data: [{ label: "Jul", value: 8200 }, { label: "Aug", value: 9100 }, { label: "Sep", value: 10400 }] }] },
    { type: "table", caption: "Top vendors in Q3", headers: ["Vendor", "EUR", "Invoice"],
      rows: [["Acme", 4200, { button: { label: "Open", url: "https://billing.example/inv/1042" } }],
             ["Globex", 3100, { button: { label: "Open", url: "https://billing.example/inv/1051" } }]] },
    { type: "collapsible", title: "Sources", markdown: "- Ledger export of 2026-10-01\n- [Invoice archive](https://billing.example/archive)" },
    { type: "links", buttons: [{ label: "Export CSV", url: "https://billing.example/q3.csv" }] }
  ]
```

Then the final text: **Q3 spend rose 27%**, driven by Acme's September invoices.
