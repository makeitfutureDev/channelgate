// Email accounts as gateway tools: read, organize and send mail for the accounts connected to this
// conversation (channel scope) and to the person who sent the message (personal scope). The mail
// clients run in the daemon (src/gateway/email-client.js), so a container never holds a mailbox
// password, and the personal list is resolved for the VERIFIED author only — the HTTP run API's
// named author is attribution, not identity, so its runs see channel accounts alone.
//
// Accounts are connected on a settings surface (admin dashboard, Slack Settings → MCP / You,
// Teams and Google Chat settings), never through a tool: a password typed into chat would sit in
// the conversation's history. The tools here only USE what was connected there.
import path from "node:path";
import { z } from "zod";

import { effectiveWorkDir } from "../../gateway/folders.js";
import { openConfinedFile } from "../../gateway/confined-file.js";
import { ensureRealDir, writeStreamNoFollow } from "../../gateway/safe-fs.js";
import { getUser } from "../../config/store.js";
import { resolveEmailAccountsForRun, selectEmailAccount } from "../../gateway/email-accounts.js";
import * as mailClient from "../../gateway/email-client.js";
import { formatBytes } from "../../util/bounded-bytes.js";
import { logEvent } from "../../util/logger.js";

const MAX_ATTACHMENTS = 10;
const ATTACHMENT_TOTAL_MAX_BYTES = 25 * 1024 * 1024;

function clean(error) {
  return String(error?.message || error || "failed").replace(/\s+/g, " ").trim();
}

function safeFileName(name, fallback) {
  const base = path.basename(String(name || "")).replace(/[\0-\x1f\x7f/\\]/g, "_").replace(/^\.+/, "").trim();
  return (base || fallback).slice(0, 180);
}

function describeAccount(account) {
  return `${account.scope}/${account.name} (${account.address})`;
}

function renderMessages(result) {
  if (!result.messages.length) return `No messages matched in ${result.mailbox}.`;
  const rows = result.messages.map((m) => `• uid ${m.uid} · ${m.date ? m.date.slice(0, 16).replace("T", " ") : "no date"} · ${m.seen ? "" : "🆕 "}${m.flagged ? "🚩 " : ""}**${m.subject || "(no subject)"}** — from ${m.from || "?"}${m.attachments ? ` · 📎${m.attachments}` : ""}`);
  return `${result.mailbox}: ${result.messages.length} of ${result.total} matching, newest first\n${rows.join("\n")}`;
}

export function register(server, ctx) {
  const { createdBy, text, principalTrusted, loadMeta, slug } = ctx;
  const client = ctx.emailClient || mailClient;

  async function accountsForRun() {
    const meta = await loadMeta();
    const user = principalTrusted && createdBy ? await getUser(createdBy) : null;
    return resolveEmailAccountsForRun({ channelList: meta?.emailAccounts, userList: user?.emailAccounts, principalTrusted: Boolean(principalTrusted && createdBy) });
  }

  async function pick(selector) {
    return selectEmailAccount(await accountsForRun(), selector);
  }

  const accountArg = z.string().optional().describe("Which connected account: its name, \"personal/<name>\", \"channel/<name>\" or the email address. Optional when exactly one account is connected. list_email_accounts shows them.");
  const mailboxArg = z.string().optional().describe("Mailbox (folder) path; defaults to INBOX. email_mailboxes lists them.");

  server.registerTool(
    "list_email_accounts",
    {
      description:
        "List the email accounts this turn may use: the conversation's own (channel scope, shared by everyone here) and the " +
        "requester's personal ones (visible only in runs they author). Shows name, address, scope and whether sending is " +
        "enabled — never a password. Accounts are connected on a settings surface (admin dashboard, Slack Settings → MCP page " +
        "for the conversation's or the You page for your own; Teams/Google Chat Settings → MCPs), not through a tool: say so " +
        "when someone asks to connect one. A personal account used in a shared conversation posts its results into that " +
        "shared thread — mention that before reading personal mail in a channel.",
      inputSchema: {},
    },
    async () => {
      try {
        const accounts = await accountsForRun();
        if (!accounts.length) return text("No email account is connected here. Connect one under Settings → Email accounts (your own on the You page, or this conversation's on the MCP page).");
        const rows = accounts.map((a) => `• **${a.scope}/${a.name}** — ${a.displayName ? `${a.displayName} <${a.address}>` : a.address}${a.sendEnabled === false ? " · read-only (sending disabled)" : ""} · IMAP ${a.imap.host}:${a.imap.port} · SMTP ${a.smtp.host}:${a.smtp.port}`);
        return text(`Email accounts available in this turn:\n${rows.join("\n")}`);
      } catch (e) {
        return text(`❌ ${clean(e)}`);
      }
    },
  );

  server.registerTool(
    "email_mailboxes",
    {
      description: "List an email account's mailboxes (folders) with their roles (Inbox, Sent, Drafts, Archive, Trash, Junk).",
      inputSchema: { account: accountArg },
    },
    async ({ account }) => {
      try {
        const chosen = await pick(account);
        const boxes = await client.listMailboxes(chosen);
        const rows = boxes.filter((b) => !b.unselectable).map((b) => `• ${b.path}${b.specialUse ? ` (${b.specialUse.replace(/^\\/, "")})` : ""}`);
        return text(`Mailboxes of ${describeAccount(chosen)}:\n${rows.join("\n") || "(none)"}`);
      } catch (e) {
        return text(`❌ ${clean(e)}`);
      }
    },
  );

  server.registerTool(
    "email_search",
    {
      description:
        "Search an email account's mailbox and list matching messages newest first (uid, date, from, subject, unread/flag " +
        "marks, attachment count). Filters combine with AND; with none, the newest messages are listed. Use the uid with " +
        "email_read, email_move, email_set_flag and email_download_attachment.",
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
        query: z.string().optional().describe("Free text matched in headers and body (server-side search)."),
        from: z.string().optional(),
        to: z.string().optional(),
        subject: z.string().optional(),
        since: z.string().optional().describe("ISO date: only messages on/after this day."),
        before: z.string().optional().describe("ISO date: only messages before this day."),
        unseen: z.boolean().optional().describe("Only unread messages."),
        flagged: z.boolean().optional().describe("Only flagged/starred messages."),
        limit: z.number().int().min(1).max(mailClient.EMAIL_SEARCH_MAX).optional().describe("Max results (default 20)."),
      },
    },
    async ({ account, mailbox, since, before, ...filters }) => {
      try {
        const chosen = await pick(account);
        const parse = (value, name) => {
          if (!value) return undefined;
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) throw new Error(`${name} must be an ISO date such as 2026-10-01`);
          return date;
        };
        const result = await client.searchMessages(chosen, { mailbox, since: parse(since, "since"), before: parse(before, "before"), ...filters });
        return text(`${describeAccount(chosen)} · ${renderMessages(result)}`);
      } catch (e) {
        return text(`❌ ${clean(e)}`);
      }
    },
  );

  server.registerTool(
    "email_read",
    {
      description:
        "Read one message by uid: headers, the text body (plain text preferred; HTML is converted) and the list of " +
        "attachments with their part ids for email_download_attachment. Long bodies are truncated and say so.",
      inputSchema: {
        account: accountArg,
        uid: z.number().int().min(1).describe("Message uid from email_search."),
        mailbox: mailboxArg,
        max_chars: z.number().int().min(500).max(mailClient.EMAIL_BODY_MAX_CHARS * 5).optional().describe("Body character cap (default 20000)."),
      },
    },
    async ({ account, uid, mailbox, max_chars }) => {
      try {
        const chosen = await pick(account);
        const m = await client.readMessage(chosen, { mailbox, uid, maxChars: max_chars });
        const head = [
          `**${m.subject || "(no subject)"}**`,
          `From: ${m.from || "?"}`,
          `To: ${m.to || "?"}`,
          m.cc ? `Cc: ${m.cc}` : "",
          m.replyTo ? `Reply-To: ${m.replyTo}` : "",
          `Date: ${m.date || "?"} · ${m.mailbox} uid ${m.uid}${m.seen ? "" : " · unread"}${m.flagged ? " · flagged" : ""}`,
          m.messageId ? `Message-ID: ${m.messageId}` : "",
          m.attachments.length ? `Attachments: ${m.attachments.map((a) => `part ${a.part} "${a.filename}" (${a.type}, ${formatBytes(a.size)})`).join("; ")}` : "Attachments: none",
        ].filter(Boolean).join("\n");
        const body = m.bodyKind === "none" ? "(no text body)" : m.body || "(empty body)";
        return text(`${describeAccount(chosen)}\n${head}\n\n---\n${body}${m.truncated ? "\n\n[truncated — the body was longer than the cap]" : ""}`);
      } catch (e) {
        return text(`❌ ${clean(e)}`);
      }
    },
  );

  server.registerTool(
    "email_download_attachment",
    {
      description:
        "Save one attachment of a message into this conversation's working folder under uploads/email/<account>/ and " +
        "return its path (read it with the Read tool, or share it with slack_share_file). Capped at 50 MB.",
      inputSchema: {
        account: accountArg,
        uid: z.number().int().min(1),
        part: z.string().describe("Attachment part id from email_read (\"2\", \"1.2\")."),
        mailbox: mailboxArg,
      },
    },
    async ({ account, uid, part, mailbox }) => {
      try {
        const chosen = await pick(account);
        const meta = await loadMeta();
        const root = effectiveWorkDir(slug, { ...(meta || {}), _slug: slug });
        const saved = await client.downloadAttachment(chosen, { mailbox, uid, part }, async (stream, info) => {
          const dir = await ensureRealDir(root, "uploads", "email", chosen.name);
          const file = path.join(dir, `${uid}-${safeFileName(info.filename, `part-${info.part}`)}`);
          const { bytes } = await writeStreamNoFollow(file, stream, { maxBytes: mailClient.EMAIL_ATTACHMENT_MAX_BYTES });
          return { file, bytes, filename: info.filename, type: info.type };
        });
        const relative = path.relative(root, saved.file);
        return text(`Saved \`${relative}\` (${formatBytes(saved.bytes)}, ${saved.type || "unknown type"}) from ${describeAccount(chosen)} uid ${uid}.`);
      } catch (e) {
        return text(`❌ ${clean(e)}`);
      }
    },
  );

  server.registerTool(
    "email_move",
    {
      description: "Move a message to another mailbox (archive it, move to Trash, file it in a folder). email_mailboxes lists the destinations.",
      inputSchema: { account: accountArg, uid: z.number().int().min(1), to: z.string().describe("Destination mailbox path."), mailbox: mailboxArg },
    },
    async ({ account, uid, to, mailbox }) => {
      try {
        const chosen = await pick(account);
        const r = await client.moveMessage(chosen, { mailbox, uid, to });
        return text(`Moved uid ${r.uid} from ${r.from} to ${r.to}${r.newUid ? ` (now uid ${r.newUid})` : ""} on ${describeAccount(chosen)}.`);
      } catch (e) {
        return text(`❌ ${clean(e)}`);
      }
    },
  );

  server.registerTool(
    "email_set_flag",
    {
      description: "Mark a message seen, unseen, flagged, unflagged or answered.",
      inputSchema: { account: accountArg, uid: z.number().int().min(1), flag: z.enum(["seen", "unseen", "flagged", "unflagged", "answered"]), mailbox: mailboxArg },
    },
    async ({ account, uid, flag, mailbox }) => {
      try {
        const chosen = await pick(account);
        const r = await client.setMessageFlag(chosen, { mailbox, uid, flag });
        return text(`Marked uid ${r.uid} ${r.flag} in ${r.mailbox} on ${describeAccount(chosen)}.`);
      } catch (e) {
        return text(`❌ ${clean(e)}`);
      }
    },
  );

  server.registerTool(
    "email_send",
    {
      description:
        "Send an email from a connected account (the From address is the account's). Plain text by default; `html` adds " +
        "an HTML alternative. `attachments` are paths inside this conversation's working folder (10 files, 25 MB total). " +
        "To reply in a thread, pass the original's Message-ID as `in_reply_to`. A copy is saved to the account's Sent " +
        "mailbox when the server has one. Confirm recipients and content with the user before sending unless they " +
        "already gave them; personal accounts send as that person.",
      inputSchema: {
        account: accountArg,
        to: z.array(z.string()).min(1).describe("Recipient addresses (\"Name <a@b.c>\" allowed)."),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string(),
        text: z.string().describe("Plain-text body."),
        html: z.string().optional().describe("Optional HTML body (sent alongside the text)."),
        attachments: z.array(z.string()).max(MAX_ATTACHMENTS).optional().describe("Working-folder-relative file paths to attach."),
        in_reply_to: z.string().optional().describe("Message-ID being replied to (sets In-Reply-To and References)."),
        reply_to: z.string().optional().describe("Reply-To header, if answers should go elsewhere."),
      },
    },
    async ({ account, to, cc, bcc, subject, text: body, html, attachments = [], in_reply_to, reply_to }) => {
      const opened = [];
      try {
        const chosen = await pick(account);
        if (chosen.sendEnabled === false) return text(`❌ Sending is disabled on ${describeAccount(chosen)}; it can be enabled where the account was connected.`);
        const meta = await loadMeta();
        const root = effectiveWorkDir(slug, { ...(meta || {}), _slug: slug });
        const files = [];
        let total = 0;
        for (const relative of attachments) {
          const file = await openConfinedFile(root, relative, { protectedNames: "lenient" }); // the sender's own mail account
          opened.push(file);
          total += file.stat.size;
          if (total > ATTACHMENT_TOTAL_MAX_BYTES) throw new Error(`attachments exceed ${formatBytes(ATTACHMENT_TOTAL_MAX_BYTES)} in total`);
          files.push({ filename: file.name, content: await file.handle.readFile() });
        }
        const r = await client.sendMessage(chosen, {
          to, cc, bcc, subject, text: body, html, attachments: files,
          ...(in_reply_to ? { inReplyTo: in_reply_to, references: in_reply_to } : {}),
          ...(reply_to ? { replyTo: reply_to } : {}),
        });
        logEvent("email_sent", { slug, scope: chosen.scope, account: chosen.name, by: createdBy, recipients: r.accepted.length + r.rejected.length, attachments: files.length });
        const parts = [`Sent from ${describeAccount(chosen)} to ${r.accepted.join(", ") || to.join(", ")}.`];
        if (r.rejected.length) parts.push(`Rejected by the server: ${r.rejected.join(", ")}.`);
        if (r.messageId) parts.push(`Message-ID: ${r.messageId}`);
        parts.push(r.savedToSent ? `Copy saved to ${r.sentMailbox}.` : "No copy was saved to a Sent mailbox (the server exposes none, or the server keeps its own).");
        return text(parts.join(" "));
      } catch (e) {
        return text(`❌ ${clean(e)}`);
      } finally {
        for (const file of opened) await file.handle.close().catch(() => {});
      }
    },
  );
}

export const EMAIL_TOOL_NAMES = Object.freeze([
  "list_email_accounts",
  "email_mailboxes",
  "email_search",
  "email_read",
  "email_download_attachment",
  "email_move",
  "email_set_flag",
  "email_send",
]);
