// The daemon-side mail client behind email accounts (email-accounts.js): ImapFlow for IMAP and
// Nodemailer for SMTP, both running in the daemon process so a mailbox password never enters a
// container. Every connection resolves the configured host through the same public-address check
// as custom MCP relays (src/web/security.js) and then dials the VETTED address with the real host
// name as the TLS server name — a user-supplied mail host cannot be a way into loopback, the
// private network or cloud metadata, and a rebinding answer between check and connect cannot
// redirect it. Transport is TLS or a mandatory STARTTLS upgrade; a server that stays in cleartext
// fails the connection.
//
// Everything here takes an account RECORD (with passwords) and returns plain data; the tools in
// src/mcp/tools/email.js own the authorization and the reply shape. `createClients` is injectable
// so tests run without a mail server.
import { Readable } from "node:stream";
import { resolvePublicHttpUrl } from "../web/security.js";

export const EMAIL_CONNECT_TIMEOUT_MS = 20_000;
export const EMAIL_SOCKET_TIMEOUT_MS = 90_000;
export const EMAIL_BODY_MAX_BYTES = 2 * 1024 * 1024;
export const EMAIL_BODY_MAX_CHARS = 20_000;
export const EMAIL_SEARCH_MAX = 50;
export const EMAIL_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

let libraries = null;
async function loadLibraries() {
  if (!libraries) {
    const [{ ImapFlow }, nodemailer, MailComposer] = await Promise.all([
      import("imapflow"),
      import("nodemailer"),
      import("nodemailer/lib/mail-composer").then((m) => m.default || m).catch(() => null),
    ]);
    libraries = { ImapFlow, nodemailer: nodemailer.default || nodemailer, MailComposer };
  }
  return libraries;
}

/** Resolve `host` to vetted public addresses; the first one is dialled. */
export async function resolveMailAddress(host, port, { lookup } = {}) {
  let resolved;
  try {
    resolved = await resolvePublicHttpUrl(`https://${host.includes(":") ? `[${host}]` : host}:${port}/`, lookup ? { lookup } : {});
  } catch (e) {
    throw new Error(`${host}: ${e.message}`);
  }
  return resolved.addresses[0];
}

const defaultClients = {
  async imap(endpoint, { lookup } = {}) {
    const { ImapFlow } = await loadLibraries();
    const target = await resolveMailAddress(endpoint.host, endpoint.port, { lookup });
    const client = new ImapFlow({
      host: target.address,
      servername: endpoint.host,
      port: endpoint.port,
      secure: endpoint.security === "tls",
      auth: { user: endpoint.user, pass: endpoint.password },
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
      connectionTimeout: EMAIL_CONNECT_TIMEOUT_MS,
      greetingTimeout: EMAIL_CONNECT_TIMEOUT_MS,
      socketTimeout: EMAIL_SOCKET_TIMEOUT_MS,
      tls: { servername: endpoint.host, minVersion: "TLSv1.2" },
    });
    await client.connect();
    if (!client.secureConnection) {
      await client.logout().catch(() => {});
      throw new Error(`${endpoint.host} did not upgrade the IMAP connection to TLS (STARTTLS); refusing to send a password in cleartext`);
    }
    return client;
  },
  async smtp(endpoint, { lookup } = {}) {
    const { nodemailer } = await loadLibraries();
    const target = await resolveMailAddress(endpoint.host, endpoint.port, { lookup });
    const secure = endpoint.security === "tls";
    return nodemailer.createTransport({
      host: target.address,
      port: endpoint.port,
      secure,
      requireTLS: !secure,
      auth: { user: endpoint.user, pass: endpoint.password },
      connectionTimeout: EMAIL_CONNECT_TIMEOUT_MS,
      greetingTimeout: EMAIL_CONNECT_TIMEOUT_MS,
      socketTimeout: EMAIL_SOCKET_TIMEOUT_MS,
      tls: { servername: endpoint.host, minVersion: "TLSv1.2" },
      name: "channelgate",
    });
  },
};

function describeError(error) {
  const message = String(error?.responseText || error?.response || error?.message || error || "").replace(/\s+/g, " ").trim();
  return message.length > 300 ? `${message.slice(0, 297)}…` : message || "unknown error";
}

/**
 * Log in to IMAP and SMTP (no message is sent) and report each side separately — a successful
 * SMTP login does not prove a later message is accepted, but it does prove host, port, security,
 * user and password. Throws naming the failing side.
 */
export async function verifyEmailAccount(account, { clients = defaultClients, lookup } = {}) {
  const [imap, smtp] = await Promise.allSettled([
    (async () => {
      const client = await clients.imap(account.imap, { lookup });
      try { await client.list(); } finally { await client.logout().catch(() => {}); }
    })(),
    (async () => {
      const transport = await clients.smtp(account.smtp, { lookup });
      try { await transport.verify(); } finally { transport.close?.(); }
    })(),
  ]);
  const problems = [];
  if (imap.status === "rejected") problems.push(`IMAP login failed (${account.imap.host}:${account.imap.port}): ${describeError(imap.reason)}`);
  if (smtp.status === "rejected") problems.push(`SMTP login failed (${account.smtp.host}:${account.smtp.port}): ${describeError(smtp.reason)}`);
  if (problems.length) throw new Error(problems.join(" · "));
  return { imap: true, smtp: true };
}

async function withImap(account, fn, { clients = defaultClients, lookup } = {}) {
  const client = await clients.imap(account.imap, { lookup });
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

async function withMailbox(account, mailbox, fn, options) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(mailbox || "INBOX");
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  }, options);
}

function addressList(list) {
  return (Array.isArray(list) ? list : []).map((a) => (a?.name ? `${a.name} <${a.address || ""}>` : a?.address || "")).filter(Boolean);
}

// Walk a BODYSTRUCTURE: the best text part to show and every attachment a person could download.
function inspectStructure(node, out = { text: null, html: null, attachments: [] }, inherited = "") {
  if (!node) return out;
  const type = String(node.type || "").toLowerCase();
  const part = node.part || inherited || (type.startsWith("multipart/") ? "" : "1");
  const disposition = String(node.disposition || "").toLowerCase();
  const filename = node.dispositionParameters?.filename || node.parameters?.name || "";
  if (type.startsWith("multipart/")) {
    for (const child of node.childNodes || []) inspectStructure(child, out);
    return out;
  }
  if (disposition === "attachment" || (filename && !type.startsWith("text/")) || (!type.startsWith("text/") && !type.startsWith("multipart/") && type !== "message/rfc822" && part)) {
    if (filename || disposition === "attachment") {
      out.attachments.push({ part, filename: String(filename || `part-${part}`), type, size: Number(node.size) || 0 });
      return out;
    }
  }
  if (type === "text/plain" && !out.text && disposition !== "attachment") out.text = { part, charset: node.parameters?.charset || "utf-8" };
  else if (type === "text/html" && !out.html && disposition !== "attachment") out.html = { part, charset: node.parameters?.charset || "utf-8" };
  else if (type === "message/rfc822" && node.childNodes) for (const child of node.childNodes) inspectStructure(child, out);
  return out;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] === "#") {
        const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
      }
      return Object.hasOwn(ENTITIES, code.toLowerCase()) ? ENTITIES[code.toLowerCase()] : match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function readStreamBounded(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    if (truncated) continue; // drain so the IMAP session stays in sync
    total += chunk.length;
    if (total > maxBytes) {
      chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (total - maxBytes))));
      truncated = true;
      continue;
    }
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

function decodeText(buffer, charset) {
  const label = String(charset || "utf-8").toLowerCase();
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

/** The account's mailboxes (folders) with their special-use roles. */
export async function listMailboxes(account, options) {
  return withImap(account, async (client) => {
    const boxes = await client.list();
    return boxes.map((box) => ({ path: box.path, name: box.name, specialUse: box.specialUse || "", unselectable: Boolean(box.flags?.has?.("\\Noselect")) }));
  }, options);
}

function searchCriteria({ query, from, to, subject, since, before, unseen, flagged }) {
  const criteria = {};
  if (query) criteria.text = String(query);
  if (from) criteria.from = String(from);
  if (to) criteria.to = String(to);
  if (subject) criteria.subject = String(subject);
  if (since) criteria.since = since instanceof Date ? since : new Date(since);
  if (before) criteria.before = before instanceof Date ? before : new Date(before);
  if (unseen === true) criteria.seen = false;
  if (flagged === true) criteria.flagged = true;
  if (!Object.keys(criteria).length) criteria.all = true;
  return criteria;
}

/** Newest-first envelopes matching the filters; `limit` ≤ EMAIL_SEARCH_MAX. */
export async function searchMessages(account, { mailbox = "INBOX", limit = 20, ...filters } = {}, options) {
  const cap = Math.max(1, Math.min(EMAIL_SEARCH_MAX, Number(limit) || 20));
  return withMailbox(account, mailbox, async (client) => {
    const uids = (await client.search(searchCriteria(filters), { uid: true })) || [];
    const picked = uids.slice(-cap).reverse();
    if (!picked.length) return { mailbox: client.mailbox?.path || mailbox, total: uids.length, messages: [] };
    const messages = [];
    for await (const msg of client.fetch(picked, { uid: true, envelope: true, flags: true, size: true, bodyStructure: true, internalDate: true }, { uid: true })) {
      const structure = inspectStructure(msg.bodyStructure);
      messages.push({
        uid: msg.uid,
        date: (msg.envelope?.date || msg.internalDate)?.toISOString?.() || "",
        from: addressList(msg.envelope?.from).join(", "),
        to: addressList(msg.envelope?.to).join(", "),
        subject: msg.envelope?.subject || "",
        seen: Boolean(msg.flags?.has?.("\\Seen")),
        flagged: Boolean(msg.flags?.has?.("\\Flagged")),
        size: Number(msg.size) || 0,
        attachments: structure.attachments.length,
        messageId: msg.envelope?.messageId || "",
      });
    }
    messages.sort((a, b) => picked.indexOf(a.uid) - picked.indexOf(b.uid));
    return { mailbox: client.mailbox?.path || mailbox, total: uids.length, messages };
  }, options);
}

/** One message: headers, the text body (plain preferred, HTML stripped otherwise) and attachments. */
export async function readMessage(account, { mailbox = "INBOX", uid, maxChars = EMAIL_BODY_MAX_CHARS } = {}, options) {
  const id = Number(uid);
  if (!Number.isInteger(id) || id < 1) throw new Error("uid must be a positive message id from email_search");
  return withMailbox(account, mailbox, async (client) => {
    const msg = await client.fetchOne(String(id), { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true }, { uid: true });
    if (!msg) throw new Error(`No message with uid ${id} in ${mailbox}`);
    const structure = inspectStructure(msg.bodyStructure);
    const choice = structure.text || structure.html;
    let body = "";
    let truncated = false;
    if (choice) {
      const { content } = await client.download(String(id), choice.part, { uid: true });
      const read = await readStreamBounded(content, EMAIL_BODY_MAX_BYTES);
      const text = decodeText(read.buffer, choice.charset);
      body = structure.text ? text : htmlToText(text);
      truncated = read.truncated;
      const cap = Math.max(500, Math.min(EMAIL_BODY_MAX_CHARS * 5, Number(maxChars) || EMAIL_BODY_MAX_CHARS));
      if (body.length > cap) {
        body = `${body.slice(0, cap)}…`;
        truncated = true;
      }
    }
    return {
      mailbox: client.mailbox?.path || mailbox,
      uid: id,
      date: (msg.envelope?.date || msg.internalDate)?.toISOString?.() || "",
      from: addressList(msg.envelope?.from).join(", "),
      to: addressList(msg.envelope?.to).join(", "),
      cc: addressList(msg.envelope?.cc).join(", "),
      replyTo: addressList(msg.envelope?.replyTo).join(", "),
      subject: msg.envelope?.subject || "",
      messageId: msg.envelope?.messageId || "",
      inReplyTo: msg.envelope?.inReplyTo || "",
      seen: Boolean(msg.flags?.has?.("\\Seen")),
      flagged: Boolean(msg.flags?.has?.("\\Flagged")),
      size: Number(msg.size) || 0,
      bodyKind: structure.text ? "text" : structure.html ? "html-as-text" : "none",
      body,
      truncated,
      attachments: structure.attachments,
    };
  }, options);
}

/**
 * Stream one attachment part into `sink` (an async function receiving a web ReadableStream and
 * the declared metadata; the caller owns the destination and its byte cap). Resolves the sink's
 * result.
 */
export async function downloadAttachment(account, { mailbox = "INBOX", uid, part } = {}, sink, options) {
  const id = Number(uid);
  if (!Number.isInteger(id) || id < 1) throw new Error("uid must be a positive message id from email_search");
  const partId = String(part || "").trim();
  if (!/^\d+(?:\.\d+)*$/.test(partId)) throw new Error("part must be an attachment part id from email_read (\"2\", \"1.2\")");
  return withMailbox(account, mailbox, async (client) => {
    const msg = await client.fetchOne(String(id), { uid: true, bodyStructure: true }, { uid: true });
    if (!msg) throw new Error(`No message with uid ${id} in ${mailbox}`);
    const attachment = inspectStructure(msg.bodyStructure).attachments.find((a) => a.part === partId);
    if (!attachment) throw new Error(`Message ${id} has no attachment part ${partId}`);
    const { content, meta } = await client.download(String(id), partId, { uid: true });
    return sink(Readable.toWeb(content), { ...attachment, filename: meta?.filename || attachment.filename, type: meta?.contentType || attachment.type });
  }, options);
}

/** Move a message to another mailbox; returns the destination uid when the server reports it. */
export async function moveMessage(account, { mailbox = "INBOX", uid, to } = {}, options) {
  const id = Number(uid);
  if (!Number.isInteger(id) || id < 1) throw new Error("uid must be a positive message id from email_search");
  const destination = String(to || "").trim();
  if (!destination) throw new Error("to (the destination mailbox) is required");
  return withMailbox(account, mailbox, async (client) => {
    const result = await client.messageMove(String(id), destination, { uid: true });
    if (!result) throw new Error(`Could not move message ${id} to ${destination}`);
    const mapped = result.uidMap?.get?.(id);
    return { from: client.mailbox?.path || mailbox, to: result.destination || destination, uid: id, newUid: mapped || null };
  }, options);
}

const FLAG_NAMES = Object.freeze({ seen: "\\Seen", unseen: "\\Seen", flagged: "\\Flagged", unflagged: "\\Flagged", answered: "\\Answered" });

/** Mark a message seen / unseen / flagged / unflagged / answered. */
export async function setMessageFlag(account, { mailbox = "INBOX", uid, flag } = {}, options) {
  const id = Number(uid);
  if (!Number.isInteger(id) || id < 1) throw new Error("uid must be a positive message id from email_search");
  const key = String(flag || "").trim().toLowerCase();
  if (!Object.hasOwn(FLAG_NAMES, key)) throw new Error("flag must be one of seen, unseen, flagged, unflagged, answered");
  return withMailbox(account, mailbox, async (client) => {
    const remove = key === "unseen" || key === "unflagged";
    const ok = remove
      ? await client.messageFlagsRemove(String(id), [FLAG_NAMES[key]], { uid: true })
      : await client.messageFlagsAdd(String(id), [FLAG_NAMES[key]], { uid: true });
    if (!ok) throw new Error(`Could not update flags on message ${id}`);
    return { mailbox: client.mailbox?.path || mailbox, uid: id, flag: key };
  }, options);
}

function fromHeader(account) {
  return account.displayName ? { name: account.displayName, address: account.address } : account.address;
}

/**
 * Send a message as the account and append a copy to its Sent mailbox when the server exposes one
 * (Gmail and Outlook save their own copy; a plain IMAP server does not). `attachments` are
 * `{ filename, content (Buffer) | path, contentType? }` the CALLER already opened within the
 * channel's folder — this module never opens a path itself.
 */
export async function sendMessage(account, { to, cc, bcc, subject, text, html, attachments = [], inReplyTo, references, replyTo } = {}, { clients = defaultClients, lookup, saveToSent = true } = {}) {
  if (account.sendEnabled === false) throw new Error(`Sending is disabled on the ${account.scope || ""} email account "${account.name}"`);
  const recipients = [to, cc, bcc].flat().filter(Boolean);
  if (!recipients.length) throw new Error("At least one recipient (to, cc or bcc) is required");
  if (!String(subject || "").trim() && !String(text || "").trim() && !String(html || "").trim()) throw new Error("A subject or a body is required");
  const message = {
    from: fromHeader(account),
    to, cc, bcc,
    subject: String(subject || ""),
    ...(text ? { text: String(text) } : {}),
    ...(html ? { html: String(html) } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
    attachments: attachments.map((a) => ({ filename: a.filename, ...(a.content ? { content: a.content } : { path: a.path }), ...(a.contentType ? { contentType: a.contentType } : {}) })),
    headers: { "X-Mailer": "ChannelGate" },
  };
  const { MailComposer } = await loadLibraries();
  const transport = await clients.smtp(account.smtp, { lookup });
  let info;
  let raw = null;
  try {
    if (MailComposer && saveToSent) {
      raw = await new MailComposer(message).compile().build();
      info = await transport.sendMail({ envelope: { from: account.address, to: recipients }, raw });
    } else {
      info = await transport.sendMail(message);
    }
  } finally {
    transport.close?.();
  }
  const result = {
    messageId: info?.messageId || "",
    accepted: Array.isArray(info?.accepted) ? info.accepted.map((a) => (typeof a === "string" ? a : a?.address || "")).filter(Boolean) : [],
    rejected: Array.isArray(info?.rejected) ? info.rejected.map((a) => (typeof a === "string" ? a : a?.address || "")).filter(Boolean) : [],
    savedToSent: false,
    sentMailbox: "",
  };
  if (raw && saveToSent) {
    try {
      await withImap(account, async (client) => {
        const boxes = await client.list();
        const sent = boxes.find((box) => box.specialUse === "\\Sent") || boxes.find((box) => /^sent(\s|$)/i.test(box.name));
        if (!sent) return;
        await client.append(sent.path, raw, ["\\Seen"]);
        result.savedToSent = true;
        result.sentMailbox = sent.path;
      }, { clients, lookup });
    } catch {
      /* the message is sent; a missing Sent copy is reported, never fatal */
    }
  }
  return result;
}

export const __private = { inspectStructure, searchCriteria, addressList, readStreamBounded, decodeText, defaultClients };
