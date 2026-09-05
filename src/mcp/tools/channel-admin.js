// Channel-admin tools for the gateway control MCP server: the channel's MCP allowlist, the
// mode switches (admin/bash/network/auto), working folder, Google Drive sync link, standing
// instructions + memory, the gateway updater, and the gateway-usage guide. Split out of
// gateway-server.js — registered via register(server, ctx); the tool contracts are unchanged.
import { z } from "zod";
import { statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { getChannelMeta, patchChannelMeta } from "../../config/store.js";
import { effectiveWorkDir, updateChannelInstructions } from "../../gateway/folders.js";
import { memoryEnabled, applyMemoryOperations, MEMORY_SECTIONS } from "../../gateway/channel-memory.js";
import { searchChannelMemory, readChannelMemorySource } from "../../gateway/memory-search.js";
import { logEvent } from "../../util/logger.js";
import { persistedSelectionForEngine, selectionFieldForEngine } from "../../gateway/mcp-discovery.js";
import { engineLabel, requireAdapter } from "../../engines/registry.js";
import { getDriveSyncEnabled, getDriveSyncKeyJson, getDriveSyncKeyFile, getDriveSyncKeyEmail } from "../../config/settings.js";
import { parseDriveFolderId, testChannelSync } from "../../gateway/drivesync.js";
import { allowedFsRoot, resolveWithinRoot } from "../../web/security.js";
import { formatUpdateResult, startUpdate } from "../../gateway/updater.js";
import { updateGatewayGuide, resetGatewayGuide, readGatewayGuide } from "../../gateway/guide.js";
import { slackThreadFor } from "../../slack/thread-keys.js";

export function register(server, ctx) {
  const { channelId, slug, createdBy, threadKey, activeEngine, text, daemon, requireAdmin, requireManage, loadMeta } = ctx;

  server.registerTool(
    "list_available_mcps",
    { description: "List the MCP servers available to allow in this channel (from the host's configured servers).", inputSchema: {} },
    async () => {
      const servers = await requireAdapter(activeEngine).discoverMcps();
      if (!servers.length) return text("No MCP servers available on the host.");
      return text(servers.map((s) => `• ${s.name}${s.connected ? "" : " (offline)"}`).join("\n"));
    }
  );

  server.registerTool(
    "list_channel_mcps",
    { description: "List the MCP servers currently allowed in this channel.", inputSchema: {} },
    async () => {
      const meta = await loadMeta();
      const field = selectionFieldForEngine(activeEngine);
      const names = (meta?.[field] || []).map((m) => m.name);
      return text(names.length ? `Allowed here for ${engineLabel(activeEngine)}: ${names.join(", ")}` : `No extra ${engineLabel(activeEngine)} MCP servers are allowed in this channel (personal/shared Composio + gateway controls are built in when configured).`);
    }
  );

  server.registerTool(
    "add_channel_mcps",
    {
      description: "ADMINS / CHANNEL MANAGERS. Allow one or more MCP servers in this channel (by their names from list_available_mcps). Takes effect on the next message.",
      inputSchema: { names: z.array(z.string()) },
    },
    async ({ names }) => {
      if (!(await requireManage())) return text("Only this channel's managers (or an admin) can change its MCP servers.");
      const available = await requireAdapter(activeEngine).discoverMcps();
      const field = selectionFieldForEngine(activeEngine);
      const added = [];
      const unknown = [];
      // Atomic merge: the current list is re-read inside the store's write transaction, so a
      // concurrent add/remove (daemon or another run) can't be clobbered by a stale whole-record save.
      const next = await patchChannelMeta(slug, (meta) => {
        if (!meta) return null; // channel isn't set up yet — nothing written
        added.length = unknown.length = 0; // fresh pass over the current list
        const current = [...(meta[field] || [])];
        const have = new Set(current.map((m) => m.name));
        for (const n of names) {
          const s = available.find((x) => x.name === n || x.name.toLowerCase() === String(n).toLowerCase());
          if (!s) unknown.push(n);
          else if (!have.has(s.name)) {
            const selection = persistedSelectionForEngine(activeEngine, s);
            if (!selection) {
              unknown.push(n);
              continue;
            }
            current.push(selection);
            have.add(s.name);
            added.push(s.name);
          }
        }
        return { [field]: current };
      });
      if (!next) return text("Channel isn't set up yet — send a normal message first.");
      return text(`✅ Allowed: ${added.join(", ") || "(nothing new)"}${unknown.length ? `\nUnknown (ignored): ${unknown.join(", ")}` : ""}\nActive on the next message in this channel.`);
    }
  );

  server.registerTool(
    "remove_channel_mcps",
    {
      description: "ADMINS / CHANNEL MANAGERS. Stop allowing one or more MCP servers in this channel. Takes effect on the next message.",
      inputSchema: { names: z.array(z.string()) },
    },
    async ({ names }) => {
      if (!(await requireManage())) return text("Only this channel's managers (or an admin) can change its MCP servers.");
      const drop = new Set(names.map((n) => String(n).toLowerCase()));
      const field = selectionFieldForEngine(activeEngine);
      let removed = 0;
      // Atomic: filter the CURRENT list inside the store's write transaction (see add_channel_mcps).
      const next = await patchChannelMeta(slug, (meta) => {
        if (!meta) return null;
        const selected = meta[field] || [];
        const kept = selected.filter((m) => !drop.has(m.name.toLowerCase()));
        removed = selected.length - kept.length;
        return { [field]: kept };
      });
      if (!next) return text("Channel isn't set up yet.");
      return text(`🗑️ Removed ${removed} server(s). Now allowed: ${(next[field] || []).map((m) => m.name).join(", ") || "(none)"}.\nActive on the next message.`);
    }
  );

  // ── Channel admin mode / full permissions (admins only) ─────────────────────────
  server.registerTool(
    "set_channel_admin_mode",
    {
      description:
        "ADMIN ONLY. Turn this channel's ADMIN MODE (full access) on or off. With it ON, ADMIN authors " +
        "run with NO sandbox and NO permission prompts (--dangerously-skip-permissions): full filesystem " +
        "+ network access, runs anything. Non-admin authors are unaffected (restricted + sandboxed). " +
        "Takes effect on the next message.",
      inputSchema: { enabled: z.boolean() },
    },
    async ({ enabled }) => {
      if (!(await requireAdmin())) return text("Only admins can change this channel's admin mode.");
      // Atomic partial patch: only this flag changes (no whole-record save from a stale read).
      if (!(await patchChannelMeta(slug, (meta) => (meta ? { adminMode: Boolean(enabled) } : null)))) {
        return text("Channel isn't set up yet — send a normal message first.");
      }
      return text(
        enabled
          ? "✅ Admin mode ON — admin authors now have ALL permissions in this channel (effective on the next message). Non-admins remain restricted."
          : "✅ Admin mode OFF — this channel is back to the restricted tool allowlist (effective on the next message)."
      );
    }
  );

  server.registerTool(
    "set_channel_bash",
    {
      description:
        "ADMINS / CHANNEL MANAGERS. Turn shell access on or off for this channel. With it ON, the agent can use Bash " +
        "and the file-edit tools. Reads stay confined to the working folder; for writes, secrets, the " +
        "gateway config and other channels are protected, but the agent CAN also write elsewhere in the " +
        "host's home dir (writes are not confined to the folder alone). Network is blocked. This is NOT " +
        "full admin mode. Takes effect on the next message.",
      inputSchema: { enabled: z.boolean() },
    },
    async ({ enabled }) => {
      if (!(await requireManage())) return text("Only this channel's managers (or an admin) can change its shell access.");
      if (!(await patchChannelMeta(slug, (meta) => (meta ? { allowBash: Boolean(enabled) } : null)))) {
        return text("Channel isn't set up yet — send a normal message first.");
      }
      return text(
        enabled
          ? "✅ Bash + file edits ON for this channel — sandboxed to the working folder (effective on the next message)."
          : "✅ Bash OFF — back to read-only tools (Read/Glob/Grep) + allowed MCPs (effective on the next message)."
      );
    }
  );

  server.registerTool(
    "set_channel_network",
    {
      description:
        "ADMIN ONLY. Turn network access on or off for this channel (needs Bash on to be useful). " +
        "With it ON, sandboxed commands can reach the configured domains (GitHub by default) so " +
        "`git push` / `gh` / `curl` work; the git/gh credential files become readable so the existing " +
        "login authenticates. All other domains stay blocked. Takes effect on the next message.",
      inputSchema: { enabled: z.boolean() },
    },
    async ({ enabled }) => {
      if (!(await requireAdmin())) return text("Only admins can change this channel's network access.");
      if (!(await patchChannelMeta(slug, (meta) => (meta ? { allowNetwork: Boolean(enabled) } : null)))) {
        return text("Channel isn't set up yet — send a normal message first.");
      }
      return text(
        enabled
          ? "✅ Network ON for this channel. Make sure Bash is also on. Effective on the next message."
          : "✅ Network OFF for this channel (effective on the next message)."
      );
    }
  );

  server.registerTool(
    "set_channel_auto_mode",
    {
      description:
        "ADMINS / CHANNEL MANAGERS. Turn AUTO MODE on or off for this channel. With it ON, the agent works " +
        "autonomously: permission prompts are auto-approved (no Slack buttons) and it can read/write " +
        "its working folder — still sandboxed (secrets, gateway config, other channels and the network " +
        "stay off-limits unless separately allowed). This is NOT full admin mode. Effective next message.",
      inputSchema: { enabled: z.boolean() },
    },
    async ({ enabled }) => {
      if (!(await requireManage())) return text("Only this channel's managers (or an admin) can change its auto mode.");
      if (!(await patchChannelMeta(slug, (meta) => (meta ? { autoMode: Boolean(enabled) } : null)))) {
        return text("Channel isn't set up yet — send a normal message first.");
      }
      return text(
        enabled
          ? "✅ Auto mode ON — the agent runs autonomously here (prompts auto-approved, folder writable), still sandboxed. Effective on the next message."
          : "✅ Auto mode OFF — back to asking for approval on tool permissions (effective on the next message)."
      );
    }
  );

  // ── Channel working folder (admins only) ────────────────────────────────────────
  server.registerTool(
    "get_channel_workdir",
    { description: "Show the working folder this channel's agent runs in (or the default if none is set).", inputSchema: {} },
    async () => {
      const meta = await loadMeta();
      const wd = (meta?.workDir || "").trim();
      return text(wd ? `This channel runs in: ${wd}` : "This channel uses the default gateway working folder (~/ChannelGate/<platform>/<channel>).");
    }
  );

  server.registerTool(
    "set_channel_workdir",
    {
      description:
        "ADMIN ONLY. Set the working folder this channel's agent runs in — an ABSOLUTE path to an " +
        "existing directory (e.g. a real project at /Users/me/Code/my-project). The agent reads/writes " +
        "there instead of the default gateway folder. Takes effect on the next message. Use " +
        "clear_channel_workdir to revert to the default.",
      inputSchema: { path: z.string() },
    },
    async ({ path: dir }) => {
      if (!(await requireAdmin())) return text("Only admins can change this channel's working folder.");
      const p = (dir || "").trim();
      if (!p || !path.isAbsolute(p)) return text("Provide an ABSOLUTE path, e.g. /Users/me/Code/my-project.");
      // Same containment as the admin UI's workDir field (src/web/security.js): the sandbox and
      // admin-mode runs execute in this folder, so it must realpath-resolve (symlinks followed)
      // inside the allowlisted root — an out-of-root or nonexistent path is refused.
      const root = allowedFsRoot();
      const real = resolveWithinRoot(root, p);
      if (!real) return text(`That path doesn't exist or is outside the allowed root (${root}).`);
      // Existence was proven by resolveWithinRoot; the catch only guards a delete race.
      let isDir = false;
      try {
        isDir = statSync(real).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) return text(`That path is not a directory:\n${real}`);
      if (!(await patchChannelMeta(slug, (meta) => (meta ? { workDir: real } : null)))) {
        return text("Channel isn't set up yet — send a normal message first.");
      }
      return text(`✅ This channel now runs in:\n${real}\nActive on the next message. (Dangerous tools still also require admin mode + an admin author.)`);
    }
  );

  server.registerTool(
    "clear_channel_workdir",
    { description: "ADMIN ONLY. Revert this channel to the default gateway working folder.", inputSchema: {} },
    async () => {
      if (!(await requireAdmin())) return text("Only admins can change this channel's working folder.");
      if (!(await patchChannelMeta(slug, (meta) => (meta ? { workDir: "" } : null)))) {
        return text("Channel isn't set up yet.");
      }
      return text("✅ Reverted to the default gateway working folder (on the next message).");
    }
  );

  server.registerTool(
    "list_folders",
    {
      description:
        "ADMIN ONLY. Browse folders on the host machine to find one to use with set_channel_workdir. " +
        "Pass an absolute `path` to list its sub-folders (defaults to the home directory). Returns the " +
        "resolved path, its parent (to go up), and each sub-folder's full path (to go down or to set).",
      inputSchema: { path: z.string().optional() },
    },
    async ({ path: dir }) => {
      if (!(await requireAdmin())) return text("Only admins can browse the host filesystem.");
      // Browsing is confined to the same allowlisted root as set_channel_workdir / the admin UI.
      const root = allowedFsRoot();
      const target = resolveWithinRoot(root, dir && dir.trim() ? dir.trim() : root);
      if (!target) return text(`That path doesn't exist or is outside the allowed root (${root}).`);
      try {
        const entries = await readdir(target, { withFileTypes: true });
        const folders = entries
          .filter((e) => e.isDirectory() || e.isSymbolicLink())
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
        const parent = path.dirname(target);
        const head = `📂 ${target}\n${parent !== target ? `↑ up: ${parent}` : "(filesystem root)"}`;
        const body = folders.length ? folders.map((f) => `📁 ${path.join(target, f)}`).join("\n") : "(no sub-folders)";
        return text(`${head}\n\n${body}`);
      } catch (e) {
        return text(`Couldn't list ${target}: ${e.message}`);
      }
    }
  );

  // ── Channel Google Drive sync link (get: anyone; set/clear: admins only) ────────
  // A per-channel Drive folder link (meta.syncDriveFolder) two-way-syncs into the folder's Drive/
  // subdir on a timer (src/gateway/drivesync.js). Until now it was settable only from the admin UI;
  // these tools let an admin wire it up by asking. The global enable switch and the service-account
  // key are separate admin-only Settings — the folder link alone does nothing until those are set.

  // Advisory one-liner: is the scheduled sync actually armed right now? (folder link aside.)
  function driveSyncStatusLine() {
    const enabled = getDriveSyncEnabled();
    const hasKey = Boolean((getDriveSyncKeyJson() || "").trim() || (getDriveSyncKeyFile() || "").trim());
    if (enabled && hasKey) return "Drive sync is enabled and a service-account key is configured — this folder will sync on the next sweep.";
    const missing = [];
    if (!enabled) missing.push("the global switch is OFF");
    if (!hasKey) missing.push("no service-account key is configured");
    return `⚠️ Not syncing yet — ${missing.join(" and ")} (an admin sets these in Settings → Google Drive sync).`;
  }

  server.registerTool(
    "get_channel_drive_folder",
    { description: "Show this channel's Google Drive sync folder link (the Drive folder two-way-synced into the channel's Drive/ subfolder), or that none is set.", inputSchema: {} },
    async () => {
      const meta = await loadMeta();
      const link = (meta?.syncDriveFolder || "").trim();
      if (!link) return text(`No Google Drive folder is linked to this channel (sync off).\n${driveSyncStatusLine()}`);
      const id = parseDriveFolderId(link);
      return text(`This channel syncs with: ${link}${id ? ` (folder id ${id})` : ""}\nSynced into the channel folder's Drive/ subfolder.\n${driveSyncStatusLine()}`);
    }
  );

  server.registerTool(
    "set_channel_drive_folder",
    {
      description:
        "ADMIN ONLY. Link a Google Drive folder to THIS channel so it two-way-syncs (rclone bisync) on a " +
        "timer into a dedicated Drive/ subfolder of the channel's working folder — never the folder root, " +
        "so the confinement scaffolding stays untouched. Pass `link` as a Drive folder URL " +
        "(https://drive.google.com/drive/folders/<id>), an ?id=<id> open link, or a bare folder id. " +
        "Runs a read-only connection test and reports the result. NOTE: also needs Drive sync enabled " +
        "globally + a service-account key configured in Settings, and the folder shared with the service " +
        "account. Takes effect on the next sync. Use clear_channel_drive_folder to turn it off.",
      inputSchema: { link: z.string() },
    },
    async ({ link }) => {
      if (!(await requireAdmin())) return text("Only admins can set this channel's Google Drive sync folder.");
      const raw = (link || "").trim();
      const folderId = parseDriveFolderId(raw);
      if (!folderId) return text("That doesn't look like a Google Drive folder link. Paste the folder URL (…/folders/<id>), an ?id=<id> link, or the bare folder id.");
      if (!(await patchChannelMeta(slug, (meta) => (meta ? { syncDriveFolder: raw } : null)))) {
        return text("Channel isn't set up yet — send a normal message first.");
      }
      const lines = [`✅ Linked this channel to Google Drive folder id ${folderId}. It syncs into the channel folder's Drive/ subfolder on the next sweep.`];
      const email = (getDriveSyncKeyEmail() || "").trim();
      if (email) lines.push(`Make sure the folder is shared (Editor) with the service account: ${email}`);
      // Same read-only `rclone lsf` check the admin UI's Test button uses — proves the service account
      // authenticates AND can see the folder. Never throws; returns a clean message when no key/rclone.
      try {
        const t = await testChannelSync({ syncDriveFolder: raw });
        lines.push(t.ok ? "✔️ Connection test passed — the service account can see the folder." : `⚠️ Connection test failed:\n${t.output}`);
      } catch (e) {
        lines.push(`⚠️ Couldn't run the connection test: ${e.message}`);
      }
      lines.push(driveSyncStatusLine());
      return text(lines.join("\n"));
    }
  );

  server.registerTool(
    "clear_channel_drive_folder",
    { description: "ADMIN ONLY. Unlink this channel's Google Drive folder (turns the scheduled two-way sync off). The already-synced Drive/ subfolder is left in place.", inputSchema: {} },
    async () => {
      if (!(await requireAdmin())) return text("Only admins can change this channel's Google Drive sync folder.");
      if (!(await patchChannelMeta(slug, (meta) => (meta ? { syncDriveFolder: "" } : null)))) {
        return text("Channel isn't set up yet.");
      }
      return text("✅ Unlinked — this channel's Google Drive sync is off (on the next sweep). The existing Drive/ folder is left as-is.");
    }
  );

  // ── Channel standing instructions (any allowed user; replace = admins) ──────────
  server.registerTool(
    "update_channel_instructions",
    {
      description:
        "Add a STANDING rule/instruction to THIS channel's CLAUDE.md — the channel's persistent " +
        "instructions that every future session (both engines, and after /clear) reads at start. " +
        "Use when someone asks to 'always do X', 'remember this rule', or 'add this to the channel " +
        "instructions'. `text` is appended below the existing content as-is (write it as a ready " +
        "instruction, e.g. '- Always reply in German.'). Durable per-channel FACTS still belong in " +
        "MEMORY.md — this file is for RULES about how to behave. mode:'replace' rewrites the whole " +
        "channel section (admins only).",
      inputSchema: {
        text: z.string(),
        mode: z.enum(["append", "replace"]).optional(),
      },
    },
    async ({ text: body, mode }) => {
      if (!slug) return text("No channel context — can't update instructions here.");
      const t = String(body || "").trim();
      if (!t) return text("Nothing to add — pass the rule text.");
      if (mode === "replace" && !(await requireAdmin())) {
        return text("Only admins can replace the whole channel instructions — use append (the default).");
      }
      try {
        const meta = (await getChannelMeta(slug)) || {};
        const { path: file } = await updateChannelInstructions(slug, meta, { text: t, replace: mode === "replace" });
        return text(
          `✅ ${mode === "replace" ? "Replaced" : "Added to"} this channel's standing instructions (${file}). ` +
            "Every new session in this channel starts with it from now on."
        );
      } catch (e) {
        return text(`Couldn't update the channel instructions: ${e.message}`);
      }
    }
  );

  registerMemoryTool(server, ctx);
  registerMemoryReadTools(server, ctx);

  // ── Update the gateway (admins only) ─────────────────────────────────────────────
  server.registerTool(
    "update_gateway",
    {
      description:
        "ADMIN ONLY. Update the gateway to the latest version: git pull, install deps, migrate working " +
        "folders, and restart the service. The bot goes offline for a few seconds while it restarts. " +
        "Runs detached so it survives the restart; progress is logged to ~/.channelgate/logs/update.log. " +
        "Auto/Admin channels start immediately; Read/Worker channels require a Slack approval click.",
      inputSchema: {},
    },
    async () => {
      if (!(await requireAdmin())) return text("Only admins can update the gateway.");
      try {
        const started = startUpdate({
          source: "mcp",
          context: {
            channelId,
            // The run's session key is not always a Slack thread_ts (scheduled/background runs); resolve
            // it or the update result post is rejected with invalid_thread_ts.
            threadTs: slackThreadFor(threadKey) || "",
            userId: createdBy,
          },
        });
        if (!started.ok) {
          if (started.conflict) {
            return text(`An update is already active (${started.transaction?.phase || "starting"}, transaction ${started.transaction?.id || "unknown"}).`);
          }
          return text(formatUpdateResult(started.transaction));
        }
        return text(
          `🚀 Update transaction ${started.transaction.id} started. Preflight, snapshot, dependency audit/tests, restart, Slack + isolated Claude health checks, and automatic rollback are enabled. The final result will be posted in this thread. Details: ~/.channelgate/logs/update.log.`,
        );
      } catch (e) {
        return text(`Couldn't start the update: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "restart_gateway",
    {
      description:
        "ADMIN ONLY. Safely restart the gateway daemon. The daemon lets this requesting turn finish, " +
        "checks foreground turns, background jobs, API runs, and update transactions, then rechecks " +
        "every 30 seconds for up to five minutes. It restarts only after work is idle; if work remains, " +
        "the restart is cancelled and reported in this thread. Admin mode starts without another click; " +
        "Auto/Read/Worker modes require a Slack approval.",
      inputSchema: {},
    },
    async () => {
      if (!(await requireAdmin())) return text("Only admins can restart the gateway.");
      if (!daemon.available("restart")) return text("Safe restart is unavailable right now.");
      try {
        const result = await daemon.call("restart", {
          channelId,
          threadKey,
          requestedBy: createdBy,
          reason: "Slack admin restart",
        }, { timeoutMs: 15_000 });
        if (!result.ok) return text(result.message || `Couldn't queue the safe restart: ${result.error || "unknown error"}`);
        return text(
          `🔄 Safe restart queued (${result.id}). END YOUR TURN now. The daemon will wait up to ${Math.round((result.waitMs || 0) / 60_000)} minutes for ongoing work, recheck automatically, and post here before restarting or if it cancels.`,
        );
      } catch (e) {
        return text(`Couldn't queue the safe restart: ${e.message}`);
      }
    },
  );

  // ── The gateway-usage guide (read: anyone; edit/restore: admins) ────────────────
  // The `gateway-usage` skill is the Slack operating manual injected into every channel folder. Its
  // built-in default ships in the repo (git — restorable); admins can override any file live and it
  // propagates to every channel on the next message. See src/gateway/guide.js.
  server.registerTool(
    "get_gateway_guide",
    {
      description:
        "Show the gateway-usage guide (the Slack operating manual injected into every channel). With " +
        "no args, lists its files and flags whether the active version is the built-in default or a " +
        "customized override. Pass `file` (e.g. \"SKILL.md\" or \"references/reminders.md\") to read " +
        "that file's current content.",
      inputSchema: { file: z.string().optional() },
    },
    async ({ file }) => {
      try {
        const r = await readGatewayGuide({ file: file || "" });
        if (r.content !== undefined) {
          return text(`📄 ${r.file}${r.overridden ? " (customized override)" : " (built-in default)"}:\n\n${r.content}`);
        }
        const lines = r.files.map((f) => `• ${f.file}${f.overridden ? "  — customized" : ""}`);
        const head = r.overridden ? "This guide has admin customizations (override active)." : "This guide is the built-in default (no customizations).";
        return text(`${head}\n${lines.join("\n")}\n\nRead one with get_gateway_guide file:"references/<name>.md".`);
      } catch (e) {
        return text(`Couldn't read the gateway guide: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "update_gateway_guide",
    {
      description:
        "ADMIN ONLY. Customize the gateway-usage guide (the Slack operating manual every channel " +
        "reads). Replaces one file's content in the override overlay on top of the built-in default; " +
        "it propagates to every channel on the next message. `file` is the path within the skill — " +
        "\"SKILL.md\" (the always-on overview; default) or \"references/<name>.md\" (a reference page; " +
        "creating a new reference name is allowed). `content` is the full new Markdown for that file. " +
        "Keep it GENERAL (how to operate the gateway in Slack) — org-specific facts belong in channel " +
        "memory/instructions. Use reset_gateway_guide to restore the built-in default.",
      inputSchema: { file: z.string().optional(), content: z.string() },
    },
    async ({ file, content }) => {
      if (!(await requireAdmin())) return text("Only admins can edit the gateway-usage guide.");
      try {
        const r = await updateGatewayGuide({ file: file || "SKILL.md", content });
        return text(
          `✅ Updated the gateway-usage guide file \`${r.file}\`. It applies in every channel on the next message. ` +
            `Restore the built-in default with reset_gateway_guide (file:"${r.file}" for just this file, or no file for the whole guide).`
        );
      } catch (e) {
        return text(`Couldn't update the guide: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "reset_gateway_guide",
    {
      description:
        "ADMIN ONLY. Restore the gateway-usage guide to its built-in default (the version shipped in " +
        "the repo). Pass `file` (e.g. \"SKILL.md\" or \"references/reminders.md\") to reset just that " +
        "file; omit `file` to drop ALL customizations and restore the entire guide. Takes effect in " +
        "every channel on the next message.",
      inputSchema: { file: z.string().optional() },
    },
    async ({ file }) => {
      if (!(await requireAdmin())) return text("Only admins can restore the gateway-usage guide.");
      try {
        const r = await resetGatewayGuide({ file: file || "" });
        return text(
          r.file
            ? `✅ Restored the built-in default for \`${r.file}\`. Active in every channel on the next message.`
            : "✅ Restored the entire gateway-usage guide to its built-in default (all customizations dropped). Active in every channel on the next message."
        );
      } catch (e) {
        return text(`Couldn't restore the guide: ${e.message}`);
      }
    }
  );
}

export function registerMemoryReadTools(server, ctx) {
  const { slug } = ctx;
  server.registerTool(
    "search_channel_memory",
    {
      description: "Search THIS channel's uncapped persistent memory. Use request-relevant terms; returns ranked source paths and excerpts without loading the whole memory library.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(20).optional() },
    },
    async ({ query, limit }) => {
      if (!slug) return text("No channel context — can't search memory here.");
      const meta = (await getChannelMeta(slug)) || {};
      if (!memoryEnabled(meta)) return text("Channel memory is disabled here.");
      try {
        const hits = await searchChannelMemory(effectiveWorkDir(slug, meta), slug, query, limit);
        if (!hits.length) return text(`No channel memory matched “${String(query).slice(0, 120)}”.`);
        return text(hits.map((hit) => `• ${hit.source} — ${hit.excerpt}`).join("\n"));
      } catch (error) {
        return text(`Couldn't search channel memory: ${error.message}`);
      }
    }
  );
  server.registerTool(
    "read_channel_memory",
    {
      description: "Read one source returned by search_channel_memory. Accepts MEMORY.md or memory/<topic>.md; never use it to load every source preemptively.",
      inputSchema: { source: z.string() },
    },
    async ({ source }) => {
      if (!slug) return text("No channel context — can't read memory here.");
      const meta = (await getChannelMeta(slug)) || {};
      if (!memoryEnabled(meta)) return text("Channel memory is disabled here.");
      try {
        const body = await readChannelMemorySource(effectiveWorkDir(slug, meta), source);
        return body == null ? text(`Memory source not found: ${source}`) : text(body);
      } catch (error) {
        return text(`Couldn't read channel memory: ${error.message}`);
      }
    }
  );
}

// ── Channel memory (any allowed user) ────────────────────────────────────────────
// Registered on its own so the background memory review (CG_TOOLSET=memory-review, see
// gateway/memory-review.js) can expose ONLY this tool. Never approval-gated (policy 2026-08-07).
//
// After a few failed saves in a row this process stops asking for a retry and tells the model to
// move on (Hermes' consolidation-failure cap): a fragile replace/add must never loop a turn to
// repeated validation failures and swallow the user's reply.
const MAX_MEMORY_FAILURES = 3;
let memoryFailures = 0;
const MEMORY_ACTIONS = ["add", "replace", "remove", "write_topic"];
const memoryOpShape = {
  action: z.enum(MEMORY_ACTIONS),
  text: z.string().optional(),
  old: z.string().optional(),
  section: z.string().optional(),
  topic: z.string().optional(),
  content: z.string().optional(),
};
export function registerMemoryTool(server, ctx) {
  const { channelId, slug, createdBy, origin, text } = ctx;
  server.registerTool(
    "update_channel_memory",
    {
      description:
        "Save to THIS channel's PERSISTENT memory — durable facts future sessions must know. The " +
        "memory is stored as uncapped Markdown and is retrieved on demand; memory/<topic>.md files " +
        "carry depth, referenced from MEMORY.md as [[topic]].\n" +
        "HOW: make ALL changes in ONE call via `operations` (each {action, text?, old?, section?, " +
        "topic?, content?}). The batch applies atomically and has no character ceiling. The bare " +
        "action/text/old fields are for a single change. Actions: 'add' (one concise declarative " +
        "line in `text`; optional `section`: " + MEMORY_SECTIONS.join(" | ") + "), 'replace' (a " +
        "unique `old` substring → the WHOLE line becomes `text`; prefer this over near-duplicate " +
        "adds), 'remove' (drop lines containing `old`), 'write_topic' (`topic` + `content` → " +
        "memory/<topic>.md for depth; keep an index pointer line \"… → [[topic]]\").\n" +
        "WHEN: the user corrects you or states a preference or decision; you learn a stable fact " +
        "about accounts, ids, paths, conventions, or the environment; you find a gotcha or technique " +
        "that will matter again. Priority: preferences & corrections > decisions > environment facts " +
        "> techniques. Do a final check before your last reply: did this thread teach something " +
        "durable?\n" +
        "SKIP: task progress, completed-work logs, PR/issue numbers, commit SHAs, temporary paths, " +
        "raw data — anything stale within a week. Write declarative facts ('Alex prefers X'), not " +
        "imperatives. RULES about behavior belong in update_channel_instructions. Never store secrets.",
      inputSchema: {
        action: z.enum(MEMORY_ACTIONS).optional(),
        text: z.string().optional(),
        old: z.string().optional(),
        section: z.string().optional(),
        topic: z.string().optional(),
        content: z.string().optional(),
        operations: z.array(z.object(memoryOpShape)).optional(),
      },
    },
    async (args = {}) => {
      if (!slug) return text("No channel context — can't save memory here.");
      const ops = Array.isArray(args.operations) && args.operations.length
        ? args.operations
        : args.action
          ? [{ action: args.action, text: args.text || "", old: args.old || "", section: args.section || "", topic: args.topic || "", content: args.content || "" }]
          : [];
      if (!ops.length) return text("Memory not saved: pass an action (add, replace, remove, write_topic) or an `operations` array.");
      try {
        const meta = (await getChannelMeta(slug)) || {};
        if (!memoryEnabled(meta)) return text("Channel memory is disabled for this channel (enable it in the admin UI).");
        const r = await applyMemoryOperations(effectiveWorkDir(slug, meta), meta, ops);
        memoryFailures = 0;
        // The save itself is the metric: the Audit feed reads these rows to show how much memory
        // activity a channel really has (review-driven saves are labelled).
        await logEvent("memory_saved", { channel: channelId, author: createdBy, slug, actions: r.counts, review: origin === "memory_review", indexChars: r.usage.used });
        const what = r.indexChanged && r.topics.length ? "updated (index + topic)" : r.topics.length ? "topic saved" : r.indexChanged ? "updated" : "unchanged";
        const meter = r.meter ? ` — ${r.meter}` : "";
        return text(`✅ Memory ${what} (${r.path})${meter}. ${r.note || ""}`.trim());
      } catch (e) {
        memoryFailures += 1;
        if (memoryFailures >= MAX_MEMORY_FAILURES) {
          memoryFailures = 0;
          return text(`Memory not saved: ${e.message} That is ${MAX_MEMORY_FAILURES} failed saves in a row — skip saving for now and answer the user; consolidate the index next time.`);
        }
        return text(`Memory not saved: ${e.message}`);
      }
    }
  );
}
