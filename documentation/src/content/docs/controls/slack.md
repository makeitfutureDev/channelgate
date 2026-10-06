---
title: Native Slack controls
description: Reference for Slack Lists, file snippets, sharing, tables, charts, history, and downloads.
---

These tools use the gateway’s Slack bot token and trusted current conversation/thread destination, not a personal Composio connection. A signed current-run capability is required. Effective Clean turns omit them; Teams and Google Chat do not acquire equivalent native Slack surfaces. Unattended artifacts resolve to the launching Slack thread when one exists, otherwise the channel timeline. See [report formats](/docs/features/report-artifacts) and [Slack history](/docs/features/slack-history).

## slack_list_create

**Required:** `name` (string). **Optional:** `description` (string), `todo_mode` (boolean; default false), `columns` (array of custom Slack schema objects).

```json
{
  "name": "Launch actions",
  "description": "Reviewed actions for the next release"
}
```

**Scope and result:** Creates a List with the bot and shares write access with the current conversation. Returns the `list_id` and a column summary.

**Limits:** Default columns are primary Name text and Status select (New / In progress / Done). `todo_mode:true` selects built-in to-do fields; custom columns use Slack’s schema (`key`, `name`, `type`, optional `is_primary_column` and `options`). The app needs Lists scopes and Slack service support. No arbitrary destination channel parameter is accepted.

## slack_list_add_item

**Required:** `list_id` (raw List ID or pasted List URL). **Optional:** `name` (primary/title value), `fields` (map of column name/key/ID to value).

```json
{
  "list_id": "FEXAMPLELIST",
  "name": "Review deployment",
  "fields": {
    "Status": "In progress"
  }
}
```

**Scope and result:** Adds one record to a List shared with the current conversation and accessible to the bot. Returns the new record’s item ID when provided by Slack.

**Limits:** Inspect schema first when fields are unknown. Select fields accept visible option labels. This changes a shared tracker; it is not a read-only report export.

## slack_list_update_item

**Required:** `list_id` (ID or URL), `item_id` (record ID from the List read). **Optional:** `name`, `fields` (column-name/key/ID map).

```json
{
  "list_id": "FEXAMPLELIST",
  "item_id": "RecExample",
  "fields": {
    "Status": "Done"
  }
}
```

**Scope and result:** Updates the identified record on a List shared with the current conversation. Returns an acknowledgement naming the List and item.

**Limits:** Requires an existing item ID; a title is not an item identifier. The bot must have List access. Verify the target record instead of creating a duplicate when an update is refused.

## slack_list_items

**Required:** `list_id` (ID or URL). **Optional:** `limit` (number; handler default 100).

```json
{
  "list_id": "FEXAMPLELIST",
  "limit": 50
}
```

**Scope and result:** Reads one result page of List rows and returns each item ID, title, and other field values. Empty Lists return an explicit notice.

**Limits:** List must be shared with the current conversation and accessible to the bot. The MCP schema does not enforce a numeric maximum here; Slack applies its own API limit. This wrapper does not exhaustively paginate a large tracker.

## slack_list_info

**Required:** `list_id` (ID or URL).

```json
{
  "list_id": "FEXAMPLELIST"
}
```

**Scope and result:** Returns column names, keys, IDs, types, primary-column status, and select choices for a List accessible here.

**Limits:** It reads schema, not records. An unreadable schema can return a no-columns/access notice; do not guess field IDs or assume an inaccessible List is empty.

## slack_upload_snippet

**Required:** `content` (nonblank string). **Optional:** `title`, `filename`, `comment` (strings; default empty). Filename defaults to a sanitized title-derived name with `.csv` when no extension is supplied.

```json
{
  "content": "Task\tHours\nReview\t2\nTest\t3\n",
  "title": "Task hours",
  "filename": "task-hours.tsv"
}
```

**Scope and result:** Uploads generated text as a file to the current conversation/thread and returns an acknowledgement with a permalink when available. CSV/TSV extensions produce spreadsheet previews; text/code/Markdown extensions produce snippets.

**Limits:** Use for generated text, not to relay an existing binary file through the prompt. Slack upload/service limits apply; the schema itself has no explicit content-length bound. After success, do not duplicate the complete dataset in another message.

## slack_share_file

**Required:** `path` (nonempty workspace-relative string). **Optional:** `comment` (string, maximum 3,000 characters; default empty).

```json
{
  "path": "deliverables/report.pdf",
  "comment": "Reviewed report"
}
```

**Scope and result:** Sends the unchanged bytes of a confined workspace file into the current conversation/thread with the bot. Returns filename and a permalink when available. No personal account selection is needed.

**Limits:** Maximum 25 MiB. Files outside the current working folder and symlink file routes are refused. PDF, office documents, archives, images, and text are supported as file bytes. Do not paste file contents or re-upload through Composio after success.

## slack_post_table

**Required:** `caption` (1–300 characters), `headers` (1–20 strings, each 1–200 characters), `rows` (1–100 arrays, with 1–20 string or finite-number cells each). **Optional:** `page_size` (integer 1–100; default up to 10 visible rows), `row_header_column` (integer 0–19; default 0), `summary` (string, maximum 3,000).

```json
{
  "caption": "Task hours",
  "headers": [
    "Task",
    "Hours"
  ],
  "rows": [
    [
      "Review",
      2
    ],
    [
      "Tests",
      3
    ]
  ],
  "page_size": 10
}
```

**Scope and result:** Posts a native Slack table with the current conversation/thread destination. Returns a posted acknowledgement. Numeric cells remain numeric for sorting.

**Limits:** Each row must match the header count; row-header index must identify an actual column. Combined cell content is capped at 10,000 characters. Use CSV/TSV for larger datasets and Lists for editable records.

## slack_post_chart

**Required:** `chart_type` (`line`, `bar`, `area`, `pie`), `title` (1–50 characters). **Required by type:** `series` for line/bar/area (1–12 objects with `name` 1–20 and `data` 1–20 `{label,value}` points); `segments` for pie (1–12 `{label,value}` objects). Labels are 1–20 characters, values finite numbers; pie values must be positive. **Optional:** `x_label`, `y_label` (maximum 50), `summary` (maximum 3,000).

```json
{
  "chart_type": "bar",
  "title": "Tasks completed",
  "series": [
    {
      "name": "Tasks",
      "data": [
        {
          "label": "Mon",
          "value": 3
        },
        {
          "label": "Tue",
          "value": 5
        }
      ]
    }
  ],
  "y_label": "Count"
}
```

**Scope and result:** Posts a native chart using the bot’s `chat:write` scope in the current conversation/thread. Returns a posted acknowledgement. A accessible summary is generated when omitted.

**Limits:** Series names and point labels must be unique. All series must use the same category set; the first series determines display order and subsequent series are normalized to it. Pie segment labels must be unique. No external renderer or public image URL is required.

## slack_channel_history

**Optional:** `limit` (number; default 30, clamped to 1–100).

```json
{
  "limit": 50
}
```

**Scope and result:** Reads recent top-level messages in the current Slack conversation and returns oldest-to-newest author/timestamp/text, safe file metadata, and thread information.

**Limits:** Cannot select a different channel. One Slack result page is read, so this is not an exhaustive history archive. The bot needs membership and appropriate history scopes. Returned attachment metadata excludes private URLs.

## slack_thread_replies

**Required:** `thread_ts` (parent Slack timestamp string). **Optional:** `limit` (number; default 50, clamped to 1–200).

```json
{
  "thread_ts": "1700000000.000001",
  "limit": 100
}
```

**Scope and result:** Reads replies to the given parent in the current Slack conversation, in chronological order. Returns author/timestamp/text and safe attachment metadata.

**Limits:** This wrapper reads one bounded result page, not an unlimited thread. No other conversation ID can be supplied. The current thread already contributes normal context; use an extra read for a specific evidence need.

## slack_download_file

**Required:** `file_id` (Slack file ID or supported pasted file link).

```json
{
  "file_id": "FEXAMPLEFILE"
}
```

**Scope and result:** Asks Slack for a file descriptor, proves sharing in the current conversation, and downloads into this thread’s uploads folder. Returns a local path, MIME type when available, and size. A existing confined download is reused.

**Limits:** At most 500 MiB per attachment. The bot must have file access and Slack must report the file shared here. It returns no private URL/token. Download refusals and unavailable metadata do not count as content inspection.
