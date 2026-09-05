// Native Slack tools (workspace bot token, hard-scoped to the current channel) for the gateway
// control MCP server: Slack Lists, file snippets, Block Kit tables and charts, and this-channel
// history/thread reads. Split out of gateway-server.js — registered via register(server, ctx);
// the tool contracts are unchanged.
import { z } from "zod";
import { parseListId, createList, addItem, updateItem, listItems, describeSchema } from "../../slack/lists.js";
import { uploadSnippet } from "../../slack/upload.js";
import { postTable } from "../../slack/tables.js";
import { postChart } from "../../slack/charts.js";
import { channelHistory, threadReplies } from "../../slack/read.js";
import { downloadChannelFile, formatBytes, uploadsSubFor } from "../../slack/download.js";
import { resolveSlackConfig } from "../../config/settings.js";
import { effectiveWorkDir } from "../../gateway/folders.js";
import { slackThreadFor } from "../../slack/thread-keys.js";

// ctx.threadKey is the RUN's session key, not necessarily a Slack thread_ts: a scheduled run uses
// `sched-<id>-<ts>` and a background agent `<realTs>::agent-<id>`. Passing one straight to Slack
// returned invalid_thread_ts, so every table/chart/snippet from a scheduled or background run
// failed. Resolve it to the launching thread when there is one, or "" to post top-level.

export function register(server, ctx) {
  const { channelId, text, threadKey, slug, loadMeta } = ctx;
  const currentThreadTs = () => slackThreadFor(threadKey) || "";

  // ── Slack Lists (any allowed user) ──────────────────────────────────────────────
  // Create and edit Slack "Lists" (the native table/tracker in a channel) via the workspace bot
  // token — Composio has no Lists tools. `list_id` accepts a raw F-id or a pasted List URL.
  server.registerTool(
    "slack_list_create",
    {
      description:
        "Create a new Slack List (the native table/tracker). By default makes a tasklist with a " +
        "'Name' text column + a 'Status' select (New / In progress / Done). Pass `todo_mode:true` for " +
        "Slack's built-in to-do fields instead, or a custom `columns` schema (each: {key, name, type, " +
        "is_primary_column?, options?}). Returns the new list_id — save it to add/update items. The " +
        "current conversation receives write access automatically so members can see the tracker.",
      inputSchema: {
        name: z.string(),
        description: z.string().optional(),
        todo_mode: z.boolean().optional(),
        columns: z.array(z.any()).optional(),
      },
    },
    async ({ name, description, todo_mode, columns }) => {
      try {
        const { listId, schema } = await createList({ name, description, todoMode: todo_mode, columns, channelId });
        const cols = (schema || []).map((c) => `${c.name} (${c.type})`).join(", ");
        return text(`✅ Created List "${name}" — list_id \`${listId}\`.${cols ? `\nColumns: ${cols}` : ""}\nThe current conversation has write access. Add rows now with slack_list_add_item / slack_list_update_item.`);
      } catch (e) {
        return text(`Couldn't create the List: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "slack_list_add_item",
    {
      description:
        "Add a row (item) to a Slack List. `list_id` is the List's F-id or a pasted List URL. `name` " +
        "sets the primary/title column. `fields` is an optional map of other columns keyed by column " +
        "name, key, or id → value (e.g. {\"Status\":\"In progress\"}; select values accept the option " +
        "label). Use slack_list_info first if you're unsure of the columns.",
      inputSchema: {
        list_id: z.string(),
        name: z.string().optional(),
        fields: z.record(z.string(), z.any()).optional(),
      },
    },
    async ({ list_id, name, fields }) => {
      try {
        const listId = parseListId(list_id);
        const { itemId } = await addItem({ listId, name, fields, channelId });
        return text(`✅ Added item${name ? ` "${name}"` : ""}${itemId ? ` (id \`${itemId}\`)` : ""} to List \`${listId}\`.`);
      } catch (e) {
        return text(`Couldn't add the item: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "slack_list_update_item",
    {
      description:
        "Update an existing row in a Slack List. Needs `list_id` and the item's `item_id` (the Rec-id " +
        "from slack_list_items). Pass `name` to change the title and/or `fields` (map of column " +
        "name/key/id → value, e.g. {\"Status\":\"Done\"}) to change other cells.",
      inputSchema: {
        list_id: z.string(),
        item_id: z.string(),
        name: z.string().optional(),
        fields: z.record(z.string(), z.any()).optional(),
      },
    },
    async ({ list_id, item_id, name, fields }) => {
      try {
        const listId = parseListId(list_id);
        await updateItem({ listId, itemId: item_id, name, fields, channelId });
        return text(`✅ Updated item \`${item_id}\` in List \`${listId}\`.`);
      } catch (e) {
        return text(`Couldn't update the item: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "slack_list_items",
    {
      description:
        "Read the rows of a Slack List. `list_id` is the F-id or a pasted List URL. Returns each item's " +
        "id (needed to update it), its title, and its other column values.",
      inputSchema: { list_id: z.string(), limit: z.number().optional() },
    },
    async ({ list_id, limit }) => {
      try {
        const listId = parseListId(list_id);
        const { items } = await listItems({ listId, limit: limit || 100, channelId });
        if (!items.length) return text(`List \`${listId}\` has no items yet.`);
        const lines = items.map((it) => {
          const extra = Object.entries(it.cols).map(([k, v]) => `${k}: ${v}`).join(" · ");
          return `• \`${it.id}\` — ${it.title || "(untitled)"}${extra ? `  [${extra}]` : ""}`;
        });
        return text(`List \`${listId}\` (${items.length} item${items.length === 1 ? "" : "s"}):\n${lines.join("\n")}`);
      } catch (e) {
        return text(`Couldn't read the List: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "slack_list_info",
    {
      description:
        "Show a Slack List's columns — name, key, id, type, and (for select columns) the available " +
        "choices. Use this to learn the exact fields before adding/updating items on a List you didn't " +
        "create.",
      inputSchema: { list_id: z.string() },
    },
    async ({ list_id }) => {
      try {
        const listId = parseListId(list_id);
        const cols = await describeSchema(listId, channelId);
        if (!cols.length) return text(`Couldn't read columns for List \`${listId}\` — check the id and that the List is shared with the bot.`);
        return text(`List \`${listId}\` columns:\n${cols.map((c) => `• ${c}`).join("\n")}`);
      } catch (e) {
        return text(`Couldn't read the List: ${e.message}`);
      }
    }
  );

  // ── Slack file snippets — post a big table as a file (any allowed user, bot token) ──
  // Upload text (CSV/TSV/markdown/code) as a FILE into THIS channel + thread. Slack renders a
  // CSV/TSV file as a scrollable spreadsheet grid — the right shape for a large/wide table that a
  // message code block would cram or a Slack List would bloat. Hard-scoped to the current channel.
  server.registerTool(
    "slack_upload_snippet",
    {
      description:
        "Post a FILE/snippet into THIS thread — the way to share a big or wide TABLE. Give `content` " +
        "as CSV or TSV and Slack renders it as a scrollable spreadsheet grid (with a header row and a " +
        "'see it in full' expander) — far better than a cramped message code block, and lighter than a " +
        "100-row Slack List (use a List only for a tracker people edit; use THIS for a read-only " +
        "table/export). The filename EXTENSION drives rendering: `.csv`/`.tsv` → spreadsheet preview; " +
        "`.md`/`.txt`/a code extension → a text snippet. `title` names the file; `filename` overrides " +
        "the name/extension (default derived from the title, `.csv`); `comment` is an optional message " +
        "posted with it. It's uploaded to the current channel/thread by the bot — no Bash or network " +
        "needed. For a large export, prefer TSV (tab-separated) so values containing commas stay clean.",
      inputSchema: {
        content: z.string(),
        title: z.string().optional(),
        filename: z.string().optional(),
        comment: z.string().optional(),
      },
    },
    async ({ content, title, filename, comment }) => {
      if (!channelId) return text("No channel context — can't upload a snippet here.");
      if (!String(content || "").trim()) return text("Nothing to upload — pass the table/text as `content`.");
      try {
        const { permalink } = await uploadSnippet({
          content,
          title: title || "",
          filename: filename || "",
          channelId,
          threadTs: currentThreadTs(),
          comment: comment || "",
        });
        return text(`✅ Posted the snippet to this thread${permalink ? ` (${permalink})` : ""}. It's a Slack file — don't also paste the table into a message.`);
      } catch (e) {
        return text(`Couldn't upload the snippet: ${e.message}`);
      }
    }
  );

  // ── Native Slack tables — post a Block Kit data table in THIS thread ──────────
  // Slack renders the structured rows with headers, pagination, sorting, and filtering. The table is
  // hard-scoped to the current channel + thread; use file snippets for exports over Slack's limits.
  server.registerTool(
    "slack_post_table",
    {
      description:
        "Post a native Slack DATA TABLE into THIS thread. Use for a compact read-only result that " +
        "should stay inline and scan cleanly; Slack renders headers, pagination, sorting, and " +
        "filtering. Pass a `caption`, 1–20 `headers`, and 1–100 `rows`; every row must have exactly " +
        "one string/number cell per header. Numeric values remain numeric for correct sorting. " +
        "`page_size` is 1–100 (default up to 10 visible rows), and `row_header_column` identifies the " +
        "row-label column for screen readers (default 0). All cells together are capped at Slack's " +
        "10,000-character limit. Use `slack_upload_snippet` instead for a big/wide export, or a Slack " +
        "List for an editable tracker. `summary` is optional notification/accessibility fallback text. " +
        "After this succeeds, reply with only a short takeaway — don't paste the table again.",
      inputSchema: {
        caption: z.string().min(1).max(300),
        headers: z.array(z.string().min(1).max(200)).min(1).max(20),
        rows: z.array(z.array(z.union([z.string(), z.number().finite()])).min(1).max(20)).min(1).max(100),
        page_size: z.number().int().min(1).max(100).optional(),
        row_header_column: z.number().int().min(0).max(19).optional(),
        summary: z.string().max(3000).optional(),
      },
    },
    async ({ caption, headers, rows, page_size, row_header_column, summary }) => {
      if (!channelId) return text("No channel context — can't post a table here.");
      try {
        await postTable({
          channelId,
          threadTs: currentThreadTs(),
          caption,
          headers,
          rows,
          pageSize: page_size,
          rowHeaderColumn: row_header_column,
          summary,
        });
        return text("✅ Posted the native Slack table to this thread. Don't also paste the table into the reply.");
      } catch (e) {
        return text(`Couldn't post the table: ${e.message}`);
      }
    }
  );

  // ── Native Slack charts — post a Block Kit data visualization in THIS thread ──
  // Slack renders the structured data itself (line/bar/area/pie), so there is no image renderer,
  // public URL, or external chart service. Hard-scoped to the current channel + thread.
  server.registerTool(
    "slack_post_chart",
    {
      description:
        "Post a native Slack CHART into THIS thread. Use for a compact visual comparison or trend, " +
        "not as decoration and not instead of a large exact table. `chart_type` is line, bar, area, " +
        "or pie. For line/bar/area pass 1–12 `series`, each with a unique `name` and 1–20 `{label, " +
        "value}` data points; every series must use the same labels (the first series defines axis " +
        "order). For pie pass 1–12 positive `{label,value}` `segments`. Titles/axis labels are short. " +
        "`summary` is optional accessible fallback text; when omitted it is generated from the data. " +
        "Slack renders the chart as a Block Kit data visualization using the bot's existing " +
        "`chat:write` scope. After this succeeds, reply with only a short takeaway — don't redraw or " +
        "paste the chart data unless the user asked for it.",
      inputSchema: {
        chart_type: z.enum(["line", "bar", "area", "pie"]),
        title: z.string().min(1).max(50),
        series: z.array(z.object({
          name: z.string().min(1).max(20),
          data: z.array(z.object({ label: z.string().min(1).max(20), value: z.number() })).min(1).max(20),
        })).min(1).max(12).optional(),
        segments: z.array(z.object({ label: z.string().min(1).max(20), value: z.number().positive() })).min(1).max(12).optional(),
        x_label: z.string().max(50).optional(),
        y_label: z.string().max(50).optional(),
        summary: z.string().max(3000).optional(),
      },
    },
    async ({ chart_type, title, series, segments, x_label, y_label, summary }) => {
      if (!channelId) return text("No channel context — can't post a chart here.");
      try {
        await postChart({
          channelId,
          threadTs: currentThreadTs(),
          chartType: chart_type,
          title,
          series,
          segments,
          xLabel: x_label,
          yLabel: y_label,
          summary,
        });
        return text(`✅ Posted the native ${chart_type} chart to this thread. Don't also redraw or paste the chart data in the reply.`);
      } catch (e) {
        return text(`Couldn't post the chart: ${e.message}`);
      }
    }
  );

  // ── Slack reads — THIS channel (any allowed user, bot token) ────────────────────
  // Tier 1: read the CURRENT channel's history / a thread using the workspace bot token, hard-scoped
  // to this channel id. Safe without a per-user login: the requester is a member here (they're
  // posting) and so is the bot, so it exposes nothing they couldn't already scroll to. Cross-channel
  // or workspace search is done via the Slack toolkit in Composio instead.
  function fmtMessages(rows) {
    return rows
      .map((m) => {
        const when = m.ts ? new Date(Number(m.ts) * 1000).toISOString().replace("T", " ").slice(0, 16) : "";
        const thread = m.replyCount ? ` (${m.replyCount} repl${m.replyCount === 1 ? "y" : "ies"}, thread_ts ${m.ts})` : "";
        const files = (m.files || []).map((file) => {
          const clean = (value) => String(value || "").replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
          const details = [
            file.id ? `id ${clean(file.id)}` : "",
            file.mimetype ? clean(file.mimetype) : "",
            Number.isFinite(file.size) ? `${file.size} bytes` : "",
          ].filter(Boolean);
          return `[file: ${clean(file.name) || clean(file.id) || "unnamed"}${details.length ? ` · ${details.join(" · ")}` : ""}]`;
        });
        return `[${when}] ${m.name}: ${m.text}${files.length ? `\n${files.join("\n")}` : ""}${thread}`;
      })
      .join("\n");
  }

  server.registerTool(
    "slack_channel_history",
    {
      description:
        "Read recent messages from THIS channel (the one you're replying in) using the bot token — for " +
        "'catch me up' / 'summarize this channel'. Scoped to this channel only; it can't read other " +
        "channels (use the Slack toolkit in Composio for cross-channel search). `limit` defaults to 30 " +
        "(max 100). Returns messages oldest→newest with author + timestamp, safe attachment metadata, " +
        "and thread_ts for threaded messages.",
      inputSchema: { limit: z.number().optional() },
    },
    async ({ limit }) => {
      if (!channelId) return text("No channel context here.");
      try {
        const rows = await channelHistory(channelId, limit || 30);
        return text(rows.length ? fmtMessages(rows) : "No recent messages in this channel.");
      } catch (e) {
        return text(`Couldn't read this channel: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "slack_thread_replies",
    {
      description:
        "Read all replies in a thread in THIS channel (bot token, this channel only). Pass the " +
        "`thread_ts` (the parent message's ts — e.g. from slack_channel_history). `limit` defaults to " +
        "50 (max 200). Includes safe file id/name/MIME/size metadata. Note: the thread you're currently " +
        "replying in is already in your context.",
      inputSchema: { thread_ts: z.string(), limit: z.number().optional() },
    },
    async ({ thread_ts, limit }) => {
      if (!channelId) return text("No channel context here.");
      try {
        const rows = await threadReplies(channelId, thread_ts, limit || 50);
        return text(rows.length ? fmtMessages(rows) : "No messages in that thread.");
      } catch (e) {
        return text(`Couldn't read that thread: ${e.message}`);
      }
    }
  );

  // ── On-demand attachment download (this channel only) ──────────────────────────
  // The pre-run downloader delivers the files on the TRIGGERING message. A file the person posted
  // earlier in the thread, or elsewhere in this channel, is visible in history (id + name + size)
  // but was never handed to a run — this fetches it by id with the bot token into the current
  // thread's uploads/ folder, under the same 500 MB cap and the same no-follow streaming writer.
  // Fail-closed scope: Slack must report the file as shared in THIS channel; the model gets a
  // local path, never a private URL or the token.
  server.registerTool(
    "slack_download_file",
    {
      description:
        "Download a Slack file that was shared in THIS channel into this thread's uploads/ folder and " +
        "return its local path — for an attachment on an earlier message (the thread's first message, " +
        "a file shared before you were mentioned) that no run delivered to you. Pass the `file_id` " +
        "(an id like F0BV4TU6T5L, from slack_channel_history / slack_thread_replies, or a pasted Slack " +
        "file link). Scoped to this channel: a file not shared here is refused. Files up to 500 MB; a " +
        "file already in the folder is reused without downloading again.",
      inputSchema: { file_id: z.string() },
    },
    async ({ file_id }) => {
      if (!channelId || !slug) return text("No channel context here.");
      const botToken = resolveSlackConfig().botToken;
      if (!botToken) return text("Slack bot token isn't configured — an admin must set it in the gateway Settings (admin UI).");
      try {
        const meta = await loadMeta();
        const root = effectiveWorkDir(slug, { ...(meta || {}), _slug: slug });
        const sub = uploadsSubFor(currentThreadTs() || threadKey);
        const result = await downloadChannelFile({ channelId, fileId: file_id, root, sub, botToken });
        if (result.skipped) {
          return text(`Couldn't download ${result.name}: ${result.skipped}. Do NOT pretend to have seen it — tell the user this reason verbatim.`);
        }
        const kind = result.mimetype ? ` (${result.mimetype})` : "";
        return text(
          `${result.reused ? "Already in the folder" : "Downloaded"}: ${result.path}${kind}, ${formatBytes(result.bytes)}. ` +
          "Read it with your Read tool (images render visually; a video goes through the video-understanding skill)."
        );
      } catch (e) {
        return text(`Couldn't download that file: ${e.message}`);
      }
    }
  );
}
