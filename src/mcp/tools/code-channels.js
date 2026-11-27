// Slack code channels as gateway tools. `open_code_channel` is a durable control-plane card: the
// model may only ASK (the person's own words are the request), a human clicks Approve, and the
// daemon then creates the channel, the task worktree and the first turn. `update_code_channel`
// keeps a code channel's artifact tabs, context bar and title current from inside it;
// `archive_code_channel` ends it behind a card anyone working in the channel can approve.
import { z } from "zod";
import { slackThreadFor } from "../../slack/thread-keys.js";
import { platformOfConversation } from "../../platforms/ids.js";
import { platformSupports } from "../../platforms/registry.js";
import { effectiveWorkDir } from "../../gateway/folders.js";
import { getChannelEntry } from "../../config/store.js";
import { isCodeChannelMeta, normalizeCodeChannelMode, sanitizeTask } from "../../gateway/code-channels.js";
import {
  archiveCodeChannel, isCodeChannelEligibilityError, openCodeChannel, refreshCodeChannelDiff, renameCodeChannel,
  setCodeChannelContext, setCodeChannelView, normalizeContextItems, CONTEXT_BAR_ICONS, defaultContextItems,
} from "../../slack/code-channels.js";

const MODE_HELP = "\"auto\" (default: a task branch in a git worktree when the folder is a repository, else the channel's own files), \"worktree\" or \"in_place\".";

export function register(server, ctx) {
  const { channelId, slug, createdBy, threadKey, text, loadMeta, daemon } = ctx;
  if (!platformSupports(platformOfConversation(channelId), "codeChannels")) return;
  const open = ctx.openCodeChannel || openCodeChannel;
  // Tests inject a fake Slack API; production uses the bot-token client.
  const api = ctx.codeChannelApi ? { api: ctx.codeChannelApi } : {};

  server.registerTool(
    "open_code_channel",
    {
      description:
        "Open a Slack CODE CHANNEL for the task in this thread — a dedicated channel where this agent works on one task, " +
        "with a Code tab (the task branch's diff), artifact tabs and a context bar, and where teammates can join. Call it ONLY " +
        "when the requester explicitly asks for a code channel (\"open a code channel\", \"work on this in a code channel\"): a human " +
        "must click Approve on the card before anything is created. The new channel inherits this channel's folder, access, " +
        "secrets and skills; the work happens on a new branch in a git worktree inside the folder when it is a repository. " +
        "Not available from a DM or from inside another code channel. `mode`: " + MODE_HELP,
      inputSchema: {
        task: z.string().min(3).max(2000).describe("The task the code channel is for, in one or two sentences (becomes the session's purpose)."),
        name: z.string().max(80).optional().describe("Channel name. Omit to let Slack name it after the request."),
        mode: z.enum(["auto", "worktree", "in_place"]).optional(),
        private: z.boolean().optional().describe("Force a private channel. Default: same as this channel."),
      },
    },
    async ({ task, name = "", mode = "auto", private: isPrivate }) => {
      const meta = await loadMeta();
      if (!meta) return text("No channel configuration found for this conversation.");
      if (meta.isDM) return text("🚫 Code channels can only be opened from a channel, not from a DM.");
      if (isCodeChannelMeta(meta)) return text("🚫 This is already a code channel. Finish the task here, or ask in the origin channel for another one.");
      const originThreadTs = slackThreadFor(threadKey) || "";
      if (!originThreadTs) return text("🚫 A code channel starts from a message in this channel; this run has no originating message (scheduled or background work cannot open one).");
      const entry = await getChannelEntry(channelId);
      if (!entry) return text("No channel configuration found for this conversation.");
      try {
        const result = await open({
          originChannelId: channelId,
          originSlug: slug,
          originEntry: entry,
          originMeta: meta,
          originDir: effectiveWorkDir(slug, { ...meta, cleanMode: false }),
          originThreadTs,
          originMessageTs: originThreadTs,
          requesterId: createdBy,
          name,
          task: sanitizeTask(task),
          mode: normalizeCodeChannelMode(mode),
          isPrivate,
        }, api);
        let kickoff = "";
        try {
          if (daemon?.available?.("code-channel")) {
            await daemon.call("code-channel", { action: "kickoff", channelId: result.channelId, requesterId: createdBy, task: result.meta?.codeChannel?.task || task });
            kickoff = " I have started working there.";
          }
        } catch (error) {
          kickoff = ` The first turn could not be started automatically (${error.message}); say hello in the channel to begin.`;
        }
        const files = result.mode === "worktree" && result.branch
          ? `branch \`${result.branch}\` in a worktree inside the channel folder`
          : result.mode === "worktree"
            ? `the channel folder (the task worktree could not be created: ${result.worktreeError || "unknown reason"}; the agent will open it itself)`
            : "the channel's own files";
        return text(`✅ Opened code channel <#${result.channelId}> for: ${result.meta?.codeChannel?.task || task}\nFiles: ${files}.${result.note ? ` Note: ${result.note}.` : ""}${kickoff}`);
      } catch (error) {
        const prefix = isCodeChannelEligibilityError(error.code) ? "Couldn't open a code channel — " : "Couldn't open the code channel: ";
        return text(`${prefix}${error.message}`);
      }
    }
  );

  server.registerTool(
    "update_code_channel",
    {
      description:
        "Inside a Slack code channel: publish or refresh an artifact tab (`view`: an html preview, a block_kit view, a canvas by " +
        "id, or a pull_request by URL; the Code diff tab refreshes automatically after every turn, `refresh_diff:true` forces it), " +
        "add context-bar items (`context_items`, up to 5 incl. the defaults; icons: " + CONTEXT_BAR_ICONS.join(", ") + "), or " +
        "retitle the session (`title`). Each field is independent; omit what should not change. Only works in a code channel.",
      inputSchema: {
        title: z.string().max(200).optional(),
        context_items: z.array(z.object({ key: z.string().max(64), label: z.string().max(128), icon: z.string().optional(), url: z.string().optional() })).max(5).optional(),
        view: z.object({
          type: z.enum(["html", "block_kit", "canvas", "pull_request"]),
          key: z.string().max(255).optional().describe("Stable tab key (a file name such as preview.html); later calls with the same key replace the tab."),
          name: z.string().max(80).optional().describe("Tab label."),
          content: z.string().optional().describe("html: a complete self-contained HTML document (rendered sandboxed)."),
          blocks: z.array(z.any()).max(50).optional().describe("block_kit: the blocks."),
          canvas_id: z.string().optional(),
          pr_url: z.string().optional().describe("pull_request: the https pull-request URL."),
        }).optional(),
        refresh_diff: z.boolean().optional(),
      },
    },
    async ({ title, context_items, view, refresh_diff }) => {
      const meta = await loadMeta();
      if (!isCodeChannelMeta(meta)) return text("🚫 This tool only works inside a Slack code channel.");
      if (meta.codeChannel.archivedAt) return text("🚫 This code channel is archived.");
      const lines = [];
      if (title) {
        try { await renameCodeChannel(meta.channelId, title, api); lines.push(`✔️ Title: ${title.trim()}`); }
        catch (error) { lines.push(`❌ Title: ${error.message}`); }
      }
      if (Array.isArray(context_items) && context_items.length) {
        try {
          const defaults = await defaultContextItems(meta.codeChannel, effectiveWorkDir(meta.codeChannel.originSlug, { ...meta, cleanMode: false }));
          const merged = normalizeContextItems([...context_items, ...defaults]);
          await setCodeChannelContext(meta.channelId, merged, api);
          lines.push(`✔️ Context bar: ${merged.map((i) => i.label).join(" · ")}`);
        } catch (error) { lines.push(`❌ Context bar: ${error.message}`); }
      }
      if (view) {
        try {
          const data = await setCodeChannelView(meta.channelId, view, api);
          lines.push(`✔️ ${view.type} tab ${view.name || view.key || view.pr_url || ""} published (version ${data.content_version ?? "?"}).`);
          if (view.type === "pull_request") {
            const defaults = await defaultContextItems(meta.codeChannel, effectiveWorkDir(meta.codeChannel.originSlug, { ...meta, cleanMode: false }));
            await setCodeChannelContext(meta.channelId, normalizeContextItems([...defaults, { key: "pr", label: "Pull request", icon: "link", url: view.pr_url }]), api).catch(() => {});
          }
        } catch (error) { lines.push(`❌ ${view.type} tab: ${error.message}`); }
      }
      if (refresh_diff) {
        const result = await refreshCodeChannelDiff(meta, { force: true, ...api });
        lines.push(result.ok ? (result.skipped ? "✔️ Code tab: no changes to publish." : `✔️ Code tab refreshed (${result.files} file${result.files === 1 ? "" : "s"}).`) : `❌ Code tab: ${result.error || "not available"}`);
      }
      return text(lines.length ? lines.join("\n") : "Nothing to update — pass title, context_items, view or refresh_diff.");
    }
  );

  server.registerTool(
    "archive_code_channel",
    {
      description:
        "Archive this Slack code channel when its task is done and the requester agreed. Posts `summary` as the wrap-up message " +
        "(shared back into the origin thread), closes the session and archives the channel; history and artifact tabs stay readable " +
        "and searchable, the task branch stays on disk. A human clicks Approve on the card first. Only works in a code channel.",
      inputSchema: { summary: z.string().max(3900).optional().describe("The wrap-up to post before archiving (what was done, where the branch/PR is).") },
    },
    async ({ summary = "" }) => {
      const meta = await loadMeta();
      if (!isCodeChannelMeta(meta)) return text("🚫 This tool only works inside a Slack code channel.");
      if (meta.codeChannel.archivedAt) return text("This code channel is already archived.");
      try {
        const result = await archiveCodeChannel({ slug, meta, summary }, api);
        return text(`✅ Archived <#${result.channelId}>.${result.summaryTs ? " The wrap-up was shared back into the origin thread." : ""}`);
      } catch (error) {
        return text(`Couldn't archive the code channel: ${error.message}`);
      }
    }
  );
}
