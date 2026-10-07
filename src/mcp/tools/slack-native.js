// Native Slack tools (workspace bot token, hard-scoped to the current channel) for the gateway
// control MCP server: Slack Lists, file snippets, Block Kit tables and charts, and this-channel
// history/thread reads. Split out of gateway-server.js — registered via register(server, ctx);
// the tool contracts are unchanged.
import { z } from "zod";
import { parseListId, createList, addItem, updateItem, listItems, describeSchema } from "../../slack/lists.js";
import { uploadSnippet, uploadOpenedFile, MAX_FILE_UPLOAD_BYTES } from "../../slack/upload.js";
import { openConfinedFile } from "../../gateway/confined-file.js";
import { logEvent } from "../../util/logger.js";
import { postTable } from "../../slack/tables.js";
import { postChart } from "../../slack/charts.js";
import { buildReplyBlocks, composeReplyInputSchema, describeReplyBlocks, chartFieldsSchema, tableFieldsSchema } from "../../slack/reply-blocks.js";
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
  const { channelId, text, threadKey, slug, loadMeta, createdBy } = ctx;
  // Injectable only so the tests can observe what reaches Slack; production uses the real upload.
  const uploadFile = ctx.uploadOpenedFile || uploadOpenedFile;
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
        "Post TEXT YOU GENERATE as a file/snippet into THIS thread — above all a big or wide TABLE as " +
        "CSV or TSV, which Slack renders as a scrollable spreadsheet grid (header row + a 'see it in full' " +
        "expander) — far better than a " +
        "cramped message code block, and lighter than a 100-row Slack List (use a List only for a " +
        "tracker people edit; use THIS for a read-only table/export). The filename EXTENSION drives " +
        "rendering: `.csv`/`.tsv` → spreadsheet preview; `.md`/`.txt`/a code extension → a text " +
        "snippet. To send a file that already EXISTS in the working folder (any type, PDF included), use " +
        "`slack_share_file` instead — don't re-type it into `content`. `title` names the file; `filename` overrides the name/extension (default derived " +
        "from the title, `.csv`); `comment` is an optional message posted with it. It's uploaded to " +
        "the current channel/thread by the bot — no Bash or network needed. For a large export, " +
        "prefer TSV (tab-separated) so values containing commas stay clean.",
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

  // ── Share a workspace file into THIS thread (any file type, bot token) ──────────
  // The agent-side twin of the file explorer's Share button: the same confinement (the path must
  // be a regular file inside this channel's working folder, never through a symlink), the same
  // 25 MB cap, the same bot-token upload and the same audit event. Unlike slack_upload_snippet it
  // carries the file's real BYTES, so a PDF, a spreadsheet or an archive arrives intact — and
  // unlike a Composio upload it needs no personal account, so it never has to ask "which account?".
  server.registerTool(
    "slack_share_file",
    {
      description:
        "Share a FILE from this channel's working folder into THIS thread as a real Slack file, posted by " +
        "the bot. Use it whenever the user asks for a file here — 'send it', 'share the file', 'attach the " +
        "PDF', 'trimite fișierul' — for ANY type: PDF, DOCX, XLSX, PPTX, ZIP, images, HTML, Markdown. The " +
        "bytes are sent unchanged, so nothing passes through your context. `path` is relative to the working " +
        "folder (the same path you would name in inline code); `comment` is an optional message posted with " +
        `it. Limit ${Math.round(MAX_FILE_UPLOAD_BYTES / 1024 / 1024)} MB. Only files inside this channel's folder qualify: ` +
        "not the operator home, not through a symlink. Prefer this over a Composio Slack upload for this " +
        "thread — no account choice is needed. After it succeeds, reply with one line; do not paste the content.",
      inputSchema: {
        path: z.string().min(1).describe("File path relative to this channel's working folder."),
        comment: z.string().max(3000).optional().describe("Optional message posted with the file."),
      },
    },
    async ({ path: relative, comment = "" }) => {
      if (!channelId) return text("No channel context — can't share a file here.");
      let opened;
      try {
        const meta = await loadMeta();
        opened = await openConfinedFile(effectiveWorkDir(slug, { ...(meta || {}), _slug: slug }), relative);
      } catch (e) {
        return text(`Sharing refused: ${String(e?.message || e)}`);
      }
      try {
        const threadTs = currentThreadTs();
        const { permalink, bytes } = await uploadFile({
          handle: opened.handle,
          filename: opened.name,
          title: opened.name,
          channelId,
          threadTs,
          comment,
        });
        await logEvent("channel_file_shared", {
          channel: channelId,
          author: createdBy || "",
          slug,
          file: opened.relative,
          bytes,
          via: "agent",
        });
        return text(
          `✅ Shared \`${opened.name}\` ${threadTs ? "in this thread" : "in the channel"}${permalink ? ` (${permalink})` : ""}. ` +
          "It's a Slack file — don't also paste its content or re-send it through Composio.",
        );
      } catch (e) {
        return text(`Couldn't share the file: ${String(e?.message || e)}`);
      } finally {
        await opened.handle.close().catch(() => {});
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
        "filtering. Pass a `caption`, 1–20 `headers`, and 1–200 `rows`; every row must have exactly " +
        "one cell per header. A cell is a string, a number (kept numeric for correct sorting), or an " +
        "object: `{text, url}` for a clickable link, `{text, bold|italic|strike|code:true}` for " +
        "formatting, `{user:\"U…\"}` for a mention, `{button:{label, url}}` for a row button that " +
        "opens a URL. Plain strings may also carry `[label](url)`, bare https URLs, `**bold**`, " +
        "`code`, `~~strike~~` and `<@U…>` — they render as rich cells. Header cells are plain text. " +
        "`page_size` is 1–100 (default up to 10 visible rows), and `row_header_column` identifies the " +
        "row-label column for screen readers (default 0). All cells together are capped at Slack's " +
        "20,000-character limit. Use `slack_upload_snippet` instead for a big/wide export, or a Slack " +
        "List for an editable tracker. `summary` is optional notification/accessibility fallback text. " +
        "To put the table INSIDE your final answer instead of a separate message, use " +
        "`slack_compose_reply`. After this succeeds, reply with only a short takeaway — don't paste " +
        "the table again.",
      inputSchema: {
        ...tableFieldsSchema,
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
        ...chartFieldsSchema,
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

  // ── Composed replies — Block Kit attached to the FINAL answer ──────────────────
  // The handler validates and acknowledges; the daemon reads the call from the engine stream
  // (engines/stream.js, engines/codex.js → slack/reply-blocks.js) and progress.js appends the
  // blocks under the answer text on chat.stopStream. Same ack-only posture as report_progress —
  // and the same gate: only a run with a live Slack progress writer (a foreground turn, a visible
  // API run) is offered the tool, so a scheduled, background or clean run never stages blocks
  // that nothing would render.
  if (ctx.progressReport) server.registerTool(
    "slack_compose_reply",
    {
      description:
        "Attach native Slack Block Kit to YOUR FINAL ANSWER so one polished message carries the " +
        "takeaway and its visuals (instead of a separate post per chart/table). Pass 1–12 ordered " +
        "`sections`: `{type:\"chart\", chart_type, title, series|segments, x_label?, y_label?}` (same " +
        "rules as slack_post_chart), `{type:\"table\", caption, headers, rows, page_size?, " +
        "row_header_column?}` (same rules as slack_post_table, incl. link/formatted/button cells), " +
        "`{type:\"text\", markdown}` (≤3000 chars), `{type:\"collapsible\", title, markdown, " +
        "collapsed?}` for sources/details/long explanations, `{type:\"card\", title, subtitle?, body?, " +
        "subtext?, image_url?, buttons?:[{label,url}]≤3}` for a product/result/file card, " +
        "`{type:\"links\", buttons:[{label,url}]≤5}` for action links, `{type:\"divider\"}`. The blocks " +
        "render under your streamed answer text and above the run footer, in this order. Call it " +
        "once with every section (a later call replaces the earlier snapshot), then write the short " +
        "answer text as usual — don't repeat the chart/table data in prose. The call is refused with " +
        "the reason when a section breaks a Slack limit; fix and retry.",
      inputSchema: { sections: composeReplyInputSchema.shape.sections },
    },
    async ({ sections }) => {
      if (!channelId) return text("No channel context — can't compose a reply here.");
      try {
        const blocks = buildReplyBlocks(sections);
        return text(
          `✅ Staged ${blocks.length} block${blocks.length === 1 ? "" : "s"} (${describeReplyBlocks(sections)}) for the final ` +
          "answer: they render under your reply text automatically. Now write the short takeaway — " +
          "don't paste the same chart/table data again.",
        );
      } catch (e) {
        const reason = e?.issues?.length
          ? e.issues.map((issue) => `${issue.path?.join(".") || "sections"}: ${issue.message}`).join("; ")
          : String(e?.message || e);
        return text(`Couldn't compose the reply: ${reason}`);
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
          "Read it with your Read tool (images render visually; for video, follow gateway-usage/references/video-understanding.md)."
        );
      } catch (e) {
        return text(`Couldn't download that file: ${e.message}`);
      }
    }
  );
}
