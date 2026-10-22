// Email accounts (src/gateway/email-accounts.js + email-account-store.js + mcp/tools/email.js):
// a mailbox's IMAP + SMTP settings connected once per person or per conversation, used by the
// agent through daemon-side tools. Proves the rules (validation, defaults, password merging,
// masking, selection), the store (connection test before every save, audit without passwords),
// the agent tools (personal scope only for a verified author, never a password in a reply,
// attachments confined to the working folder) and the admin routes (write-only listings).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
process.env.CG_APPROVAL_SECRET = "email-account-signing-secret";
after(() => rmSync(scratch, { recursive: true, force: true }));

const rules = await import("../src/gateway/email-accounts.js");
const {
  EMAIL_ACCOUNT_LIMIT, emailAccountSecrets, listEmailAccounts, normalizeEmailAccountInput, normalizeMailHost,
  patchEmailAccounts, resolveEmailAccountsForRun, selectEmailAccount,
} = rules;

const PASSWORD = "imap-secret-password-1";
const SMTP_PASSWORD = "smtp-secret-password-2";
const form = (over = {}) => ({
  name: "Work", address: "ana@example.com", displayName: "Ana Pop",
  imapHost: "imap.example.com", imapUser: "ana@example.com", imapPassword: PASSWORD,
  smtpHost: "smtp.example.com",
  ...over,
});

// ── Rules ────────────────────────────────────────────────────────────────────────────────────────
test("one form: defaults, security by port, SMTP falls back to the IMAP credentials", () => {
  const record = normalizeEmailAccountInput(form());
  assert.equal(record.name, "work");
  assert.deepEqual(record.imap, { host: "imap.example.com", port: 993, security: "tls", user: "ana@example.com", password: PASSWORD });
  assert.deepEqual(record.smtp, { host: "smtp.example.com", port: 587, security: "starttls", user: "ana@example.com", password: PASSWORD });
  assert.equal(record.sendEnabled, true);
  const explicit = normalizeEmailAccountInput(form({ imapPort: "143", smtpPort: "465", smtpUser: "relay-user", smtpPassword: SMTP_PASSWORD, sendEnabled: "false" }));
  assert.equal(explicit.imap.security, "starttls");
  assert.equal(explicit.smtp.security, "tls");
  assert.equal(explicit.smtp.user, "relay-user");
  assert.equal(explicit.smtp.password, SMTP_PASSWORD);
  assert.equal(explicit.sendEnabled, false);
});

test("validation refuses bad names, addresses, ports, internal hosts and a missing password", () => {
  assert.throws(() => normalizeEmailAccountInput(form({ name: "Work Mail!" })), /Account name/);
  assert.throws(() => normalizeEmailAccountInput(form({ address: "not-an-address" })), /Email address/);
  assert.throws(() => normalizeEmailAccountInput(form({ imapPort: "70000" })), /IMAP port/);
  assert.throws(() => normalizeEmailAccountInput(form({ imapPassword: "" })), /IMAP password is required/);
  assert.throws(() => normalizeEmailAccountInput(form({ imapUser: "" })), /IMAP user/);
  for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "169.254.169.254", "[::1]", "mail.internal.localhost", "not a host"]) {
    assert.throws(() => normalizeMailHost(host, "IMAP"), new RegExp("IMAP server"), host);
  }
  assert.equal(normalizeMailHost("IMAP.Example.com.", "IMAP"), "imap.example.com");
});

test("an update keeps the stored passwords when the form leaves them blank, and follows a shared password", () => {
  const stored = patchEmailAccounts([], { set: form(), actor: "U1" });
  // Host change, no passwords typed: both stored passwords survive.
  const moved = patchEmailAccounts(stored, { set: form({ imapHost: "imap2.example.com", imapPassword: "", smtpPassword: "" }), actor: "U1" });
  assert.equal(moved[0].imap.host, "imap2.example.com");
  assert.equal(moved[0].imap.password, PASSWORD);
  assert.equal(moved[0].smtp.password, PASSWORD);
  // New IMAP password with a shared SMTP one: both rotate together.
  const rotated = patchEmailAccounts(stored, { set: form({ imapPassword: "new-shared-password", smtpPassword: "" }), actor: "U1" });
  assert.equal(rotated[0].smtp.password, "new-shared-password");
  // A distinct SMTP password is kept when only IMAP rotates.
  const distinct = patchEmailAccounts([], { set: form({ smtpPassword: SMTP_PASSWORD }), actor: "U1" });
  const rotatedImap = patchEmailAccounts(distinct, { set: form({ imapPassword: "another-imap-password", smtpPassword: "" }), actor: "U1" });
  assert.equal(rotatedImap[0].smtp.password, SMTP_PASSWORD);
  assert.equal(rotatedImap[0].imap.password, "another-imap-password");
});

test("patch upserts by name, enforces the limit, removes, and the masked list never carries a password", () => {
  let list = [];
  for (let i = 0; i < EMAIL_ACCOUNT_LIMIT; i += 1) list = patchEmailAccounts(list, { set: form({ name: `acct-${i}` }), actor: "U1" });
  assert.throws(() => patchEmailAccounts(list, { set: form({ name: "one-too-many" }) }), /At most/);
  list = patchEmailAccounts(list, { set: form({ name: "acct-0", displayName: "Renamed" }) });
  assert.equal(list.length, EMAIL_ACCOUNT_LIMIT);
  assert.equal(list.find((e) => e.name === "acct-0").displayName, "Renamed");
  list = patchEmailAccounts(list, { remove: "acct-1" });
  assert.equal(list.length, EMAIL_ACCOUNT_LIMIT - 1);
  assert.throws(() => patchEmailAccounts(list, { remove: "ghost" }), /No email account named/);
  const masked = listEmailAccounts(list, "channel");
  const json = JSON.stringify(masked);
  assert.ok(!json.includes(PASSWORD), "masked list carries no password");
  assert.equal(masked[0].scope, "channel");
  assert.equal(masked[0].imap.hasPassword, true);
  assert.deepEqual(Object.keys(masked[0].smtp).sort(), ["hasPassword", "host", "port", "security", "user"]);
  assert.deepEqual(emailAccountSecrets(list), list.map((e) => e.imap.password));
  assert.deepEqual(listEmailAccounts([{ name: "broken" }, null, "x"], "user"), [], "malformed rows are dropped, never thrown on");
  assert.throws(() => listEmailAccounts(list, "organization"), /Unknown email account scope/);
});

test("a run sees the channel's accounts, plus the author's own only for a trusted principal; selection is explicit", () => {
  const channel = patchEmailAccounts([], { set: form({ name: "support", address: "support@example.com" }) });
  const user = patchEmailAccounts([], { set: form({ name: "work" }) });
  const both = resolveEmailAccountsForRun({ channelList: channel, userList: user, principalTrusted: true });
  assert.deepEqual(both.map((a) => `${a.scope}/${a.name}`), ["channel/support", "personal/work"]);
  const untrusted = resolveEmailAccountsForRun({ channelList: channel, userList: user, principalTrusted: false });
  assert.deepEqual(untrusted.map((a) => a.scope), ["channel"]);

  assert.throws(() => selectEmailAccount(both, ""), /Several email accounts/);
  assert.equal(selectEmailAccount(both, "work").scope, "personal");
  assert.equal(selectEmailAccount(both, "support@example.com").name, "support");
  assert.equal(selectEmailAccount(both, "channel/support").scope, "channel");
  assert.equal(selectEmailAccount(both, "my/work").scope, "personal");
  assert.equal(selectEmailAccount(untrusted, "").name, "support", "one account needs no selector");
  assert.throws(() => selectEmailAccount([], ""), /No email account is connected/);
  const clash = resolveEmailAccountsForRun({ channelList: patchEmailAccounts([], { set: form({ name: "work" }) }), userList: user });
  assert.throws(() => selectEmailAccount(clash, "work"), /both a personal and a channel account/);
  assert.equal(selectEmailAccount(clash, "personal/work").scope, "personal");
});

// ── Store ────────────────────────────────────────────────────────────────────────────────────────
const store = await import("../src/config/store.js");
const { defaultChannelMeta, getChannelMeta, getUser, saveChannelMeta, setUser, upsertChannelEntry } = store;
const accountStore = await import("../src/gateway/email-account-store.js");
const { listUserEmailAccounts, removeChannelEmailAccount, removeUserEmailAccount, saveChannelEmailAccount, saveUserEmailAccount, setEmailAccountVerifierForTests } = accountStore;

const entry = await upsertChannelEntry("C_EMAIL", { name: "email-routes", type: "channel", isDM: false });
await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: "C_EMAIL", name: "email-routes", type: "channel", isDM: false }));
await setUser("U_EMAIL", { name: "Ana Pop", approved: true });
const verified = [];
setEmailAccountVerifierForTests(async (record) => {
  verified.push(record);
  if (record.imap.password === "wrong-password-xyz") throw new Error(`IMAP login failed (${record.imap.host}:${record.imap.port}): Invalid credentials`);
  return { imap: true, smtp: true };
});

test("the store tests the full record (merged passwords) before every save and stores nothing on failure", async () => {
  const bad = await saveChannelEmailAccount(entry.slug, form({ imapPassword: "wrong-password-xyz" }), { actor: "<@U1>" }).catch((e) => e);
  assert.match(bad.message, /IMAP login failed/);
  assert.equal((await getChannelMeta(entry.slug)).emailAccounts, undefined);

  let authorized = 0;
  const listed = await saveChannelEmailAccount(entry.slug, form(), { actor: "<@U1>", authorize: async () => { authorized += 1; } });
  assert.equal(authorized, 1, "the interactive re-check runs after the connection test");
  assert.equal(listed[0].name, "work");
  assert.equal(verified.at(-1).smtp.password, PASSWORD, "the verifier saw the merged SMTP password");
  const meta = await getChannelMeta(entry.slug);
  assert.equal(meta.emailAccounts[0].imap.password, PASSWORD);

  // Update without passwords: the verifier receives the STORED passwords, not blanks.
  await saveChannelEmailAccount(entry.slug, form({ imapHost: "imap-b.example.com", imapPassword: "", smtpPassword: "" }), { actor: "<@U1>" });
  assert.equal(verified.at(-1).imap.password, PASSWORD);
  assert.equal((await getChannelMeta(entry.slug)).emailAccounts[0].imap.host, "imap-b.example.com");

  await assert.rejects(removeChannelEmailAccount(entry.slug, "ghost"), /No email account named/);
  assert.deepEqual(await removeChannelEmailAccount(entry.slug, "work", { actor: "<@U1>" }), []);
});

test("personal accounts live on the user record, listed masked, removable", async () => {
  await assert.rejects(saveUserEmailAccount("", form()), /No user to change/);
  const listed = await saveUserEmailAccount("U_EMAIL", form({ name: "mine" }), { actor: "U_EMAIL" });
  assert.equal(listed[0].scope, "personal");
  assert.equal((await getUser("U_EMAIL")).emailAccounts[0].imap.password, PASSWORD);
  assert.ok(!JSON.stringify(await listUserEmailAccounts("U_EMAIL")).includes(PASSWORD));
  assert.deepEqual(await removeUserEmailAccount("U_EMAIL", "mine"), []);
});

// ── Agent tools ──────────────────────────────────────────────────────────────────────────────────
const { register } = await import("../src/mcp/tools/email.js");
const { ctxFromClaims } = await import("../src/mcp/gateway-server.js");
const { GATEWAY_TOOL_NAMES } = await import("../src/gateway/mcp-catalog.js");
const { EMAIL_TOOL_NAMES } = await import("../src/mcp/tools/email.js");

const calls = [];
const fakeClient = {
  EMAIL_SEARCH_MAX: 50, EMAIL_BODY_MAX_CHARS: 20000, EMAIL_ATTACHMENT_MAX_BYTES: 1024 * 1024,
  async listMailboxes(account) { calls.push(["list", account.scope, account.name]); return [{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox" }, { path: "Sent", name: "Sent", specialUse: "\\Sent" }]; },
  async searchMessages(account, query) {
    calls.push(["search", account.name, query]);
    return { mailbox: "INBOX", total: 1, messages: [{ uid: 7, date: "2026-10-20T09:00:00.000Z", from: "Bob <bob@example.com>", to: account.address, subject: "Invoice", seen: false, flagged: false, size: 1200, attachments: 1, messageId: "<m7@example.com>" }] };
  },
  async readMessage(account, { uid }) {
    calls.push(["read", account.name, uid]);
    return { mailbox: "INBOX", uid, date: "2026-10-20T09:00:00.000Z", from: "Bob <bob@example.com>", to: account.address, cc: "", replyTo: "", subject: "Invoice", messageId: "<m7@example.com>", inReplyTo: "", seen: false, flagged: false, size: 1200, bodyKind: "text", body: `Hello — password is ${PASSWORD}`, truncated: false, attachments: [{ part: "2", filename: "../../evil.pdf", type: "application/pdf", size: 10 }] };
  },
  async downloadAttachment(account, { uid, part }, sink) {
    calls.push(["download", account.name, uid, part]);
    return sink(new Blob([Buffer.from("%PDF-1.4 fake")]).stream(), { part, filename: "../../evil.pdf", type: "application/pdf", size: 13 });
  },
  async moveMessage(account, { uid, to }) { calls.push(["move", account.name, uid, to]); return { from: "INBOX", to, uid, newUid: 3 }; },
  async setMessageFlag(account, { uid, flag }) { calls.push(["flag", account.name, uid, flag]); return { mailbox: "INBOX", uid, flag }; },
  async sendMessage(account, message) { calls.push(["send", account.scope, account.name, message]); return { messageId: "<out-1@example.com>", accepted: message.to, rejected: [], savedToSent: true, sentMailbox: "Sent" }; },
};

function toolsFor(authorId, { trusted = true } = {}) {
  const tools = new Map();
  const ctx = ctxFromClaims({ channelId: "C_EMAIL", slug: entry.slug, authorId, threadKey: "1700000000.000400", principalTrusted: trusted, engine: "claude" });
  register({ registerTool: (name, def, handler) => tools.set(name, { def, handler }) }, { ...ctx, emailClient: fakeClient });
  return tools;
}
const reply = async (tools, name, args = {}) => (await tools.get(name).handler(args)).content[0].text;

test("every email tool is registered and allowlisted for the engine", () => {
  const tools = toolsFor("U_EMAIL");
  for (const name of EMAIL_TOOL_NAMES) {
    assert.ok(tools.has(name), `${name} registered`);
    assert.ok(GATEWAY_TOOL_NAMES.includes(name), `${name} in GATEWAY_TOOL_NAMES`);
  }
});

test("tools see the channel's accounts and the verified author's own, never an untrusted author's", async () => {
  await saveChannelEmailAccount(entry.slug, form({ name: "support", address: "support@example.com" }), { actor: "<@U1>" });
  await saveUserEmailAccount("U_EMAIL", form({ name: "work" }), { actor: "U_EMAIL" });
  const own = await reply(toolsFor("U_EMAIL"), "list_email_accounts");
  assert.match(own, /channel\/support/);
  assert.match(own, /personal\/work/);
  assert.ok(!own.includes(PASSWORD));
  const api = await reply(toolsFor("U_EMAIL", { trusted: false }), "list_email_accounts");
  assert.match(api, /channel\/support/);
  assert.ok(!api.includes("personal/work"), "an unauthenticated author gets no personal scope");
  const other = await reply(toolsFor("U_OTHER"), "list_email_accounts");
  assert.ok(!other.includes("personal/work"), "another person never sees Ana's account");
  assert.match(await reply(toolsFor("U_EMAIL"), "email_mailboxes", {}), /Several email accounts/);
  assert.match(await reply(toolsFor("U_EMAIL"), "email_mailboxes", { account: "work" }), /Sent \(Sent\)/);
  assert.deepEqual(calls.at(-1), ["list", "personal", "work"]);
});

test("search, read, move and flag render compactly and pass the account through", async () => {
  const tools = toolsFor("U_EMAIL");
  const search = await reply(tools, "email_search", { account: "support", unseen: true, since: "2026-10-01" });
  assert.match(search, /uid 7 .*Invoice/);
  assert.ok(calls.at(-1)[2].since instanceof Date);
  assert.match(await reply(tools, "email_search", { account: "support", since: "not-a-date" }), /❌ since must be an ISO date/);
  const read = await reply(tools, "email_read", { account: "support", uid: 7 });
  assert.match(read, /From: Bob/);
  assert.match(read, /part 2 "\.\.\/\.\.\/evil\.pdf"/);
  assert.match(await reply(tools, "email_move", { account: "support", uid: 7, to: "Archive" }), /Moved uid 7 from INBOX to Archive \(now uid 3\)/);
  assert.match(await reply(tools, "email_set_flag", { account: "support", uid: 7, flag: "seen" }), /Marked uid 7 seen/);
});

test("attachments land under uploads/email/<account>/ with a sanitized name", async () => {
  const { effectiveWorkDir } = await import("../src/gateway/folders.js");
  const root = effectiveWorkDir(entry.slug, { ...(await getChannelMeta(entry.slug)), _slug: entry.slug });
  mkdirSync(root, { recursive: true });
  const tools = toolsFor("U_EMAIL");
  const saved = await reply(tools, "email_download_attachment", { account: "support", uid: 7, part: "2" });
  assert.match(saved, /Saved `uploads\/email\/support\/7-evil\.pdf`/);
  assert.ok(!saved.includes(".."));
});

test("email_send attaches only files inside the working folder and reports the outcome", async () => {
  const { effectiveWorkDir } = await import("../src/gateway/folders.js");
  const root = effectiveWorkDir(entry.slug, { ...(await getChannelMeta(entry.slug)), _slug: entry.slug });
  mkdirSync(path.join(root, "out"), { recursive: true });
  writeFileSync(path.join(root, "out", "report.txt"), "quarterly numbers");
  mkdirSync(path.join(scratch, "elsewhere"), { recursive: true });
  writeFileSync(path.join(scratch, "elsewhere", "secret.txt"), "operator secret");
  symlinkSync(path.join(scratch, "elsewhere", "secret.txt"), path.join(root, "out", "link.txt"));
  const tools = toolsFor("U_EMAIL");
  const sent = await reply(tools, "email_send", { account: "personal/work", to: ["bob@example.com"], subject: "Report", text: "See attached", attachments: ["out/report.txt"], in_reply_to: "<m7@example.com>" });
  assert.match(sent, /Sent from personal\/work \(ana@example.com\) to bob@example.com/);
  assert.match(sent, /Copy saved to Sent/);
  const [, scope, name, message] = calls.at(-1);
  assert.equal(scope, "personal");
  assert.equal(name, "work");
  assert.equal(message.attachments[0].filename, "report.txt");
  assert.equal(message.attachments[0].content.toString(), "quarterly numbers");
  assert.equal(message.inReplyTo, "<m7@example.com>");
  const escaped = await reply(tools, "email_send", { account: "work", to: ["bob@example.com"], subject: "x", text: "y", attachments: ["out/link.txt"] });
  assert.match(escaped, /❌/);
  const outside = await reply(tools, "email_send", { account: "work", to: ["bob@example.com"], subject: "x", text: "y", attachments: ["../../etc/passwd"] });
  assert.match(outside, /❌/);
  // Sending disabled on the account is refused before any client call.
  await saveChannelEmailAccount(entry.slug, form({ name: "readonly", address: "ro@example.com", sendEnabled: false }), { actor: "<@U1>" });
  const before = calls.length;
  assert.match(await reply(tools, "email_send", { account: "readonly", to: ["bob@example.com"], subject: "x", text: "y" }), /Sending is disabled/);
  assert.equal(calls.length, before);
});

test("a run's output redactor carries every email password", async () => {
  const { resolveRunIntegrations } = await import("../src/gateway/run-integrations.js");
  const meta = await getChannelMeta(entry.slug);
  const trusted = await resolveRunIntegrations({ meta, channelId: "C_EMAIL", authorId: "U_EMAIL", threadKey: "t", workspaceId: "", clean: true, untrustedPrincipal: false });
  assert.ok(trusted.emailSecrets.includes(PASSWORD));
  assert.equal(trusted.emailSecrets.length, 3, "channel (support, readonly) + personal (work)");
  const untrusted = await resolveRunIntegrations({ meta, channelId: "C_EMAIL", authorId: "U_EMAIL", threadKey: "t", workspaceId: "", clean: false, untrustedPrincipal: true });
  assert.equal(untrusted.emailSecrets.length, 2, "no personal passwords for an unauthenticated author");
});

// ── Admin routes ─────────────────────────────────────────────────────────────────────────────────
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;
async function call(route, { method = "GET", body } = {}) {
  const response = await fetch(base + route, { method, headers: body ? { "content-type": "application/json" } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() };
}

test("channel and user routes save write-only, surface the connection test's error, mask every listing and remove", async () => {
  const saved = await call("/channels/C_EMAIL/email-accounts/Sales", { method: "PUT", body: { ...form(), name: undefined, sendEnabled: false } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const sales = saved.json.accounts.find((a) => a.name === "sales");
  assert.equal(sales.sendEnabled, false);
  assert.equal(sales.imap.hasPassword, true);
  assert.ok(!JSON.stringify(saved.json).includes(PASSWORD));

  const listed = await call("/channels");
  const channel = listed.json.channels.find((item) => item.channelId === "C_EMAIL");
  assert.ok(channel.meta.emailAccounts.some((a) => a.name === "sales"));
  assert.ok(!JSON.stringify(listed.json).includes(PASSWORD), "the channel list never carries a password");
  assert.ok(!JSON.stringify(await call("/channels/C_EMAIL/email-accounts")).includes(PASSWORD));

  const failed = await call("/channels/C_EMAIL/email-accounts/broken", { method: "PUT", body: { ...form(), imapPassword: "wrong-password-xyz" } });
  assert.equal(failed.status, 400);
  assert.match(failed.json.error, /IMAP login failed/);
  assert.ok(!failed.json.error.includes("wrong-password-xyz"));
  const internal = await call("/channels/C_EMAIL/email-accounts/evil", { method: "PUT", body: { ...form(), imapHost: "127.0.0.1" } });
  assert.equal(internal.status, 400);
  assert.match(internal.json.error, /loopback/);

  const removed = await call("/channels/C_EMAIL/email-accounts/sales", { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.ok(!removed.json.accounts.some((a) => a.name === "sales"));
  assert.equal((await call("/channels/C_NOPE/email-accounts")).status, 404);

  const user = await call("/users/U_EMAIL/email-accounts/Home", { method: "PUT", body: form({ address: "ana@home.example" }) });
  assert.equal(user.status, 200, JSON.stringify(user.json));
  assert.equal(user.json.accounts.find((a) => a.name === "home").scope, "personal");
  const users = await call("/users");
  const ana = users.json.users.U_EMAIL;
  assert.ok(ana.emailAccounts.some((a) => a.name === "home"));
  assert.ok(!JSON.stringify(users.json).includes(PASSWORD), "the user list never carries a password");
  assert.equal((await call("/users/U_EMAIL/email-accounts/home", { method: "DELETE" })).status, 200);
});
