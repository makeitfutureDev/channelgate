// Email accounts on the Slack Settings modal (src/slack/channel-settings.js + app.js): the
// "Email accounts" section on the MCP page (the conversation's, managers and admins) and on You
// (the viewer's own), the one-form IMAP+SMTP connect/edit specs with their write-only passwords,
// the field reader, the controller's authority, pre-checks, save, refusal and remove paths, and
// that a password never leaves the store in any rendered view, snapshot or reply.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  buildChannelSettingsView,
  readSettingsForm,
  settingsCommand,
  settingsFieldBlockId,
  settingsFormSpec,
  SETTINGS_DRAFT_FIELDS,
  SETTINGS_SECRET_FIELDS,
} = await import("../src/slack/channel-settings.js");
const {
  channelSettingsEditOptions,
  fieldForEmailError,
  handleSettingsFormSubmission,
  localSettingsFormProblem,
  removeSettingsForm,
  saveSettingsForm,
  EMAIL_SETTINGS_FORM_TIMEOUT_MS,
  SETTINGS_FORM_TIMEOUT_MS,
} = await import("../src/slack/app.js");
const store = await import("../src/config/store.js");
const { listEmailAccounts } = await import("../src/gateway/email-accounts.js");
const { listUserEmailAccounts, setEmailAccountVerifierForTests } = await import("../src/gateway/email-account-store.js");

const CHANNEL_ID = "C_SLACK_EMAIL";
const VIEWER = "U_MAILER";
const entry = await store.upsertChannelEntry(CHANNEL_ID, { name: "slack-email", type: "channel", isDM: false });
await store.saveChannelMeta(entry.slug, { ...store.defaultChannelMeta({ channelId: CHANNEL_ID, name: "slack-email", type: "channel", isDM: false }), manageAccess: "admins" });
await store.setUser(VIEWER, { name: "Mailer", approved: true });
const state = { channelId: CHANNEL_ID, slug: entry.slug, threadTs: "", ownerId: VIEWER };
const meta = async () => store.getChannelMeta(entry.slug);
const ctx = async (overrides = {}) => ({ entry, meta: await meta(), clicker: VIEWER, userIsAdmin: false, userIsApproved: true, ...overrides });
const flat = (value) => JSON.stringify(value);
const buttons = (view, actionId) => view.blocks.flatMap((block) => [...(block.elements || []), ...(block.accessory ? [block.accessory] : [])])
  .filter((element) => element?.action_id === actionId);
const forms = (view) => buttons(view, "cg_channel_settings_form_open").map((button) => settingsCommand(button).f);
const inputs = (view) => view.blocks.filter((block) => block.type === "input");

const PASSWORD = "imap-secret-pw-2026";
const SMTP_PASSWORD = "smtp-other-pw-2026";
const endpoint = (host, port, user) => ({ host, port, security: port === 993 || port === 465 ? "tls" : "starttls", user, hasPassword: true });
const masked = {
  channel: [{ name: "support", scope: "channel", address: "support@example.com", displayName: "Support", imap: endpoint("imap.example.com", 993, "support@example.com"), smtp: endpoint("smtp.example.com", 587, "support@example.com"), sendEnabled: true, setBy: "", setAt: "", verifiedAt: "" }],
  personal: [{ name: "me", scope: "personal", address: "me@example.net", displayName: "", imap: endpoint("mail.example.net", 143, "me"), smtp: endpoint("mail.example.net", 465, "me-smtp"), sendEnabled: true, setBy: "", setAt: "", verifiedAt: "" }],
};
const formValues = (key, fields, secretId = "") => Object.fromEntries(Object.entries(fields).map(([field, value]) => [settingsFieldBlockId(key, field, secretId), { v: { value } }]));
const good = {
  address: "work@example.com", displayName: "Work", imapHost: "imap.example.com", imapPort: "", imapUser: "work@example.com", imapPassword: PASSWORD,
  smtpHost: "smtp.example.com", smtpPort: "", smtpUser: "", smtpPassword: "",
};

test.afterEach(() => setEmailAccountVerifierForTests(null));

test("the MCP page lists the conversation's accounts and You the viewer's, masked, with Connect only for who may", () => {
  const manager = buildChannelSettingsView({ emailAccounts: masked }, { ...state, tab: "mcp" }, { tab: "mcp", canManageCustomMcp: true });
  assert.match(flat(manager), /Email accounts/);
  assert.match(flat(manager), /`support` · support@example\.com · IMAP imap\.example\.com:993 · SMTP smtp\.example\.com:587/);
  assert.doesNotMatch(flat(manager), /me@example\.net/, "the viewer's own accounts live on You");
  assert.ok(forms(manager).includes("em:c:support") && forms(manager).includes("em-add:c"));
  assert.ok(buttons(manager, "cg_channel_settings_form_open").some((button) => button.text.text === "+ Connect email account"));

  const member = buildChannelSettingsView({ emailAccounts: masked }, { ...state, tab: "mcp" }, { tab: "mcp" });
  assert.match(flat(member), /support@example\.com/, "a member still sees what is connected");
  assert.equal(forms(member).some((key) => key.startsWith("em")), false, "a member cannot connect or edit the conversation's accounts");
  assert.match(flat(member), /Managers change these\. Connect your own under \*You\*/);
  const empty = buildChannelSettingsView({ emailAccounts: { channel: [] } }, { ...state, tab: "mcp" }, { tab: "mcp" });
  assert.match(flat(empty), /_None\._ Managers connect them here/);

  const you = buildChannelSettingsView({ emailAccounts: masked }, { ...state, tab: "you" }, { tab: "you" });
  assert.match(flat(you), /`me` · me@example\.net · IMAP mail\.example\.net:143 · SMTP mail\.example\.net:465/);
  assert.ok(forms(you).includes("em:p:me") && forms(you).includes("em-add:p"), "anyone connects and edits their own");
  assert.doesNotMatch(flat(you), /support@example\.com/);
});

test("the connect form asks for everything on one page; the edit form prefills all but the passwords", () => {
  const add = settingsFormSpec("em-add:c");
  assert.equal(add.title, "Connect email account");
  assert.equal(add.removable, false);
  assert.deepEqual(add.fields.map((field) => [field.name, Boolean(field.optional)]), [
    ["name", false], ["address", false], ["displayName", true], ["imapHost", false], ["imapPort", true], ["imapUser", false], ["imapPassword", false],
    ["smtpHost", false], ["smtpPort", true], ["smtpUser", true], ["smtpPassword", true],
  ]);
  assert.equal(add.fields.find((field) => field.name === "imapPort").hint, "993 TLS · 143 STARTTLS");
  assert.equal(add.fields.find((field) => field.name === "smtpPort").hint, "465 TLS · 587 STARTTLS");
  assert.match(add.fields.find((field) => field.name === "smtpUser").placeholder, /same as IMAP/i);
  assert.match(add.fields.find((field) => field.name === "smtpPassword").placeholder, /same as IMAP/i);
  assert.ok(add.fields.every((field) => !field.initial), "nothing is prefilled on a new account");
  assert.ok(SETTINGS_SECRET_FIELDS.includes("imapPassword") && SETTINGS_SECRET_FIELDS.includes("smtpPassword"));
  assert.ok(SETTINGS_DRAFT_FIELDS.every((field) => !SETTINGS_SECRET_FIELDS.includes(field)), "a draft never carries a secret");
  assert.ok(["name", "address", "displayName", "imapHost", "imapPort", "imapUser", "smtpHost", "smtpPort", "smtpUser"].every((field) => SETTINGS_DRAFT_FIELDS.includes(field)));

  const edit = settingsFormSpec("em:p:me", { emailAccounts: masked });
  assert.equal(edit.title, "Edit email account me");
  assert.equal(edit.removable, true);
  assert.equal(edit.fields.some((field) => field.name === "name"), false, "the name is the key, not a field");
  const byName = Object.fromEntries(edit.fields.map((field) => [field.name, field]));
  assert.equal(byName.address.initial, "me@example.net");
  assert.equal(byName.imapHost.initial, "mail.example.net");
  assert.equal(byName.imapPort.initial, 143);
  assert.equal(byName.imapUser.initial, "me");
  assert.equal(byName.smtpPort.initial, 465);
  assert.equal(byName.smtpUser.initial, "me-smtp");
  assert.equal(byName.imapPassword.optional, true);
  assert.equal(byName.smtpPassword.optional, true);
  assert.match(byName.imapPassword.placeholder, /Leave blank to keep/);
  assert.equal(byName.imapPassword.initial, undefined);
  assert.equal(byName.smtpPassword.initial, undefined);

  assert.equal(settingsFormSpec("em:c:nope", { emailAccounts: masked }), null, "an unknown account opens nothing");
  assert.equal(settingsFormSpec("em-add:o"), null, "there is no organization scope for mailboxes");
  assert.equal(settingsFormSpec("em:o:support", { emailAccounts: masked }), null);

  // Rendered in place: the modal gains Save, the password boxes are empty, Remove asks first.
  const editing = buildChannelSettingsView({ emailAccounts: masked }, { ...state, tab: "you", form: "em:p:me" }, { tab: "you" });
  assert.equal(editing.submit.text, "Save");
  const rendered = inputs(editing);
  assert.equal(rendered.length, 10);
  assert.equal(rendered.find((block) => block.label.text === "IMAP server").element.initial_value, "mail.example.net");
  assert.equal(rendered.find((block) => block.label.text === "IMAP password").element.initial_value, undefined);
  assert.equal(rendered.find((block) => block.label.text === "SMTP password").element.initial_value, undefined);
  const remove = buttons(editing, "cg_channel_settings_form_remove")[0];
  assert.match(remove.confirm.title.text, /Remove email account me\?/);
  assert.match(flat(remove.confirm), /reading and sending mail/);
  const adding = buildChannelSettingsView({ emailAccounts: masked }, { ...state, tab: "you", form: "em-add:p" }, { tab: "you" });
  assert.equal(forms(adding).includes("em-add:p"), false, "the Connect button gives way to its open form");
  assert.equal(inputs(adding).length, 11);
  assert.ok(inputs(adding).every((block) => !block.element.initial_value), "a new account's form is never prefilled");
});

test("the reader takes every field; a refused save rotates only the password boxes and refills only the rest", () => {
  const key = "em-add:p";
  const typed = { name: " Work ", ...good, imapPort: " 993 ", smtpUser: "" };
  const read = readSettingsForm({ state: { values: formValues(key, typed) } }, key);
  assert.deepEqual(read, { name: "Work", address: "work@example.com", displayName: "Work", imapHost: "imap.example.com", imapPort: "993", imapUser: "work@example.com", imapPassword: PASSWORD, smtpHost: "smtp.example.com", smtpPort: "", smtpUser: "", smtpPassword: "" });
  const secretId = "11111111-2222-4333-8444-555555555555";
  assert.notEqual(settingsFieldBlockId(key, "imapPassword", secretId), settingsFieldBlockId(key, "imapPassword"));
  assert.notEqual(settingsFieldBlockId(key, "smtpPassword", secretId), settingsFieldBlockId(key, "smtpPassword"));
  assert.equal(settingsFieldBlockId(key, "imapHost", secretId), settingsFieldBlockId(key, "imapHost"));
  assert.notEqual(settingsFieldBlockId("em-add:p", "address"), settingsFieldBlockId("em-add:c", "address"), "a value typed into one scope's form never lands in the other's");
  assert.equal(readSettingsForm({ state: { values: formValues(key, typed, secretId) } }, key, secretId).imapPassword, PASSWORD);

  const draft = Object.fromEntries(Object.entries(read).filter(([field]) => SETTINGS_DRAFT_FIELDS.includes(field)));
  const reopened = buildChannelSettingsView({ emailAccounts: { personal: [] } }, { ...state, tab: "you", form: key, formError: { field: "imapPassword", error: "IMAP login failed (imap.example.com): invalid credentials" }, formDraft: { ...draft, imapPassword: PASSWORD, smtpPassword: PASSWORD } }, { tab: "you" });
  const boxes = inputs(reopened);
  assert.equal(boxes.find((block) => block.label.text === "IMAP server").element.initial_value, "imap.example.com");
  assert.equal(boxes.find((block) => block.label.text === "IMAP password").element.initial_value, undefined, "a password in a draft is ignored");
  assert.ok(!flat(reopened).includes(PASSWORD));
  assert.match(flat(reopened), /⚠️ IMAP login failed/);
});

test("refusals land under the field they are about, before Slack is answered where the syntax tells", () => {
  assert.equal(fieldForEmailError("IMAP server must be a host name such as mail.example.com"), "imapHost");
  assert.equal(fieldForEmailError("IMAP port must be a number between 1 and 65535"), "imapPort");
  assert.equal(fieldForEmailError("IMAP user name is required"), "imapUser");
  assert.equal(fieldForEmailError("IMAP password is required for a new account"), "imapPassword");
  assert.equal(fieldForEmailError("SMTP server refuses a loopback address"), "smtpHost");
  assert.equal(fieldForEmailError("SMTP port must be a number between 1 and 65535"), "smtpPort");
  assert.equal(fieldForEmailError("SMTP user name is not valid"), "smtpUser");
  assert.equal(fieldForEmailError("SMTP password is too long"), "smtpPassword");
  assert.equal(fieldForEmailError("IMAP login failed (imap.example.com): invalid credentials"), "imapPassword");
  assert.equal(fieldForEmailError("SMTP login failed (smtp.example.com): 535 bad auth"), "smtpPassword");
  assert.equal(fieldForEmailError("Email address must look like name@example.com"), "address");
  assert.equal(fieldForEmailError("Account name must be 1–32 lowercase letters, digits or hyphens"), "name");
  assert.equal(fieldForEmailError("Display name must be at most 120 characters"), "displayName");
  assert.equal(fieldForEmailError("At most 5 email accounts here — remove one first"), "name");
  assert.equal(fieldForEmailError("Something else", "imapHost"), "imapHost");

  assert.equal(localSettingsFormProblem("em-add:p", { name: "work", ...good }), null);
  assert.equal(localSettingsFormProblem("em-add:p", { name: "Work Mail", ...good }).field, "name");
  assert.equal(localSettingsFormProblem("em-add:p", { name: "work", ...good, address: "not-an-address" }).field, "address");
  assert.equal(localSettingsFormProblem("em-add:p", { name: "work", ...good, imapHost: "localhost" }).field, "imapHost");
  assert.equal(localSettingsFormProblem("em-add:p", { name: "work", ...good, imapPort: "70000" }).field, "imapPort");
  assert.equal(localSettingsFormProblem("em-add:p", { name: "work", ...good, smtpHost: "127.0.0.1" }).field, "smtpHost");
  assert.equal(localSettingsFormProblem("em-add:p", { name: "work", ...good, imapPassword: "" }).field, "imapPassword", "a new account needs its password");
  const problem = localSettingsFormProblem("em-add:p", { name: "work", ...good, imapPassword: "" });
  assert.ok(!flat(problem).includes(PASSWORD));
  assert.equal(localSettingsFormProblem("em:p:work", { ...good, imapPassword: "", smtpPassword: "" }), null, "blank passwords on an update keep the saved ones");
  assert.equal(localSettingsFormProblem("em:p:work", { ...good, imapPassword: "", smtpPort: "abc" }).field, "smtpPort");
});

test("the conversation's accounts follow the manage policy; the organization scope does not exist", async () => {
  const policy = { manageAccess: "admins" };
  // The conversation's email accounts share the custom MCP gate: the channel's manage policy, admins always.
  assert.equal(channelSettingsEditOptions(policy, true, { authorId: VIEWER }).canManageCustomMcp, true);
  assert.equal(channelSettingsEditOptions(policy, false, { authorId: VIEWER, isApprovedUser: true }).canManageCustomMcp, false);
  assert.equal(channelSettingsEditOptions({ manageAccess: "members" }, false, { authorId: VIEWER, isApprovedUser: true }).canManageCustomMcp, true);

  setEmailAccountVerifierForTests(async () => ({ imap: true, smtp: true }));
  await assert.rejects(saveSettingsForm("em-add:c", { name: "support", ...good }, await ctx()), /managers or an admin can change its email accounts/);
  await assert.rejects(removeSettingsForm("em:c:support", await ctx()), /managers or an admin/);
  await assert.rejects(saveSettingsForm("em-add:o", { name: "support", ...good }, await ctx({ userIsAdmin: true })), /expired/);
  await assert.rejects(saveSettingsForm("em:o:support", { ...good }, await ctx({ userIsAdmin: true })), /expired/);
  await assert.rejects(removeSettingsForm("em:o:support", await ctx({ userIsAdmin: true })), /expired/);
  assert.equal((await meta()).emailAccounts, undefined, "nothing was written");
});

test("an admin connects a conversation account: the store keeps the password, every view shows it masked", async () => {
  const verified = [];
  setEmailAccountVerifierForTests(async (record) => { verified.push(record); return { imap: true, smtp: true }; });
  const result = await saveSettingsForm("em-add:c", { name: "Support", ...good, address: "support@example.com", smtpPassword: SMTP_PASSWORD }, await ctx({ userIsAdmin: true }));
  assert.equal(result.notice, "✅ Email account `support` connected (IMAP and SMTP logins verified).");
  assert.equal(verified.length, 1, "the save logged in first");
  assert.equal(verified[0].imap.password, PASSWORD);
  assert.equal(verified[0].smtp.password, SMTP_PASSWORD);
  const stored = (await meta()).emailAccounts;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].imap.password, PASSWORD);
  assert.equal(stored[0].imap.port, 993, "a blank IMAP port defaults");
  assert.equal(stored[0].smtp.port, 587, "a blank SMTP port defaults");
  assert.equal(stored[0].smtp.user, "work@example.com", "a blank SMTP user is the IMAP one");
  assert.equal(stored[0].setBy, `<@${VIEWER}>`);

  // The snapshot the controller builds, and every page drawn from it, is password-free.
  const snapshot = { emailAccounts: { channel: listEmailAccounts(stored, "channel"), personal: await listUserEmailAccounts(VIEWER) } };
  assert.ok(!flat(snapshot).includes(PASSWORD) && !flat(snapshot).includes(SMTP_PASSWORD));
  for (const tab of ["mcp", "you"]) {
    for (const form of ["", "em-add:c", "em:c:support", "em-add:p"]) {
      const view = buildChannelSettingsView(snapshot, { ...state, tab, form }, { tab, canManageCustomMcp: true });
      assert.ok(!flat(view).includes(PASSWORD) && !flat(view).includes(SMTP_PASSWORD), `${tab} ${form || "(no form)"}`);
    }
  }
  const page = buildChannelSettingsView(snapshot, { ...state, tab: "mcp" }, { tab: "mcp", canManageCustomMcp: true });
  assert.match(flat(page), /`support` · support@example\.com · IMAP imap\.example\.com:993 · SMTP smtp\.example\.com:587/);

  // An update with blank passwords keeps both saved ones; Remove takes the account out.
  const updated = await saveSettingsForm("em:c:support", { ...good, address: "support@example.com", displayName: "Support desk", imapPassword: "", smtpPassword: "", smtpPort: "465" }, await ctx({ userIsAdmin: true }));
  assert.equal(updated.notice, "✅ Email account `support` updated (IMAP and SMTP logins verified).");
  const after = (await meta()).emailAccounts[0];
  assert.equal(after.displayName, "Support desk");
  assert.equal(after.smtp.port, 465);
  assert.equal(after.smtp.security, "tls");
  assert.equal(after.imap.password, PASSWORD);
  assert.equal(after.smtp.password, SMTP_PASSWORD);
  assert.match(await removeSettingsForm("em:c:support", await ctx({ userIsAdmin: true })), /Removed email account `support`/);
  assert.deepEqual((await meta()).emailAccounts, []);
});

// The root view's submission, end to end: the modal's own Save, the "Saving…" answer, the write to
// the viewer's record, the masked repaint — and a failed login that reopens the form with the
// error under the password, the other fields refilled, the password boxes rotated and empty.
test("the You page's form connects the viewer's own account through the modal submit; a failed login stores nothing", async () => {
  const context = async () => ({ entry, meta: await meta(), userIsAdmin: false, userIsApproved: true });
  const rootView = async (_entry, _meta, nextState, _admin, { notice } = {}) => {
    const snapshot = { emailAccounts: { channel: listEmailAccounts((await meta()).emailAccounts, "channel"), personal: await listUserEmailAccounts(VIEWER) } };
    return { ...buildChannelSettingsView(snapshot, nextState, { tab: nextState.tab, notice }), notice, form: nextState.form, formError: nextState.formError, formDraft: nextState.formDraft };
  };
  const submit = async (key, fields, options = {}) => {
    const view = buildChannelSettingsView({ emailAccounts: { personal: await listUserEmailAccounts(VIEWER) } }, { ...state, tab: "you", form: key }, { tab: "you" });
    const acks = [];
    const updates = [];
    const client = { views: { update: async (args) => { updates.push(args); } } };
    await handleSettingsFormSubmission({ ack: async (a) => { acks.push(a); }, body: { user: { id: VIEWER } }, view: { id: "V_ROOT", blocks: view.blocks, private_metadata: view.private_metadata, state: { values: formValues(key, fields) } }, client }, { context, rootView, ...options });
    return { acks, updates };
  };

  // A syntax refusal is answered at once under its field, before any login attempt.
  let logins = 0;
  setEmailAccountVerifierForTests(async () => { logins++; return { imap: true, smtp: true }; });
  let r = await submit("em-add:p", { name: "work", ...good, address: "nope" });
  assert.equal(r.acks[0].response_action, "errors");
  assert.ok(r.acks[0].errors[settingsFieldBlockId("em-add:p", "address")]);
  assert.equal(logins, 0);
  assert.equal(r.updates.length, 0);

  // A valid save: Slack hears "Saving…" first, then the page repaints with the masked row.
  r = await submit("em-add:p", { name: "work", ...good });
  assert.equal(r.acks[0].response_action, "update");
  assert.equal(r.acks[0].view.notice, "⏳ Saving…");
  assert.equal(logins, 1);
  assert.equal(r.updates.at(-1).view_id, "V_ROOT");
  assert.equal(r.updates.at(-1).view.notice, "✅ Email account `work` connected (IMAP and SMTP logins verified).");
  assert.match(flat(r.updates.at(-1).view), /`work` · work@example\.com · IMAP imap\.example\.com:993 · SMTP smtp\.example\.com:587/);
  const mine = (await store.getUser(VIEWER)).emailAccounts;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].imap.password, PASSWORD);
  assert.equal(mine[0].smtp.password, PASSWORD, "a blank SMTP password is the IMAP one");
  assert.equal(mine[0].setBy, VIEWER);
  assert.ok(!flat([...r.acks, ...r.updates]).includes(PASSWORD), "no reply ever echoes the password");
  assert.equal(((await meta()).emailAccounts || []).length, 0, "the viewer's account never lands on the conversation");

  // A login the servers refuse: nothing is stored, the form reopens with the error under the
  // password box, the typed servers refilled, and a fresh password box.
  setEmailAccountVerifierForTests(async () => { throw new Error("SMTP login failed (smtp.example.com): 535 authentication rejected"); });
  r = await submit("em-add:p", { name: "second", ...good, address: "second@example.com", smtpPassword: SMTP_PASSWORD });
  assert.equal(r.acks[0].response_action, "update");
  const reopened = r.updates.at(-1).view;
  assert.equal(reopened.form, "em-add:p");
  assert.deepEqual(reopened.formError, { field: "smtpPassword", error: "SMTP login failed (smtp.example.com): 535 authentication rejected" });
  assert.deepEqual(reopened.formDraft, { name: "second", address: "second@example.com", displayName: "Work", imapHost: "imap.example.com", imapPort: "", imapUser: "work@example.com", smtpHost: "smtp.example.com", smtpPort: "", smtpUser: "" });
  const secretId = JSON.parse(reopened.private_metadata).fs;
  assert.match(secretId, /^[0-9a-f-]{36}$/, "the password boxes were rotated");
  assert.ok(inputs(reopened).some((block) => block.block_id === settingsFieldBlockId("em-add:p", "smtpPassword", secretId)));
  assert.equal(inputs(reopened).find((block) => block.label.text === "IMAP server").element.initial_value, "imap.example.com");
  assert.match(flat(reopened), /⚠️ SMTP login failed/);
  assert.ok(!flat([...r.acks, ...r.updates]).includes(PASSWORD) && !flat([...r.acks, ...r.updates]).includes(SMTP_PASSWORD));
  assert.equal((await store.getUser(VIEWER)).emailAccounts.length, 1, "the refused account was not stored");

  // The viewer edits their own with blank passwords (kept), then removes it.
  setEmailAccountVerifierForTests(async () => ({ imap: true, smtp: true }));
  r = await submit("em:p:work", { ...good, imapPassword: "", smtpPassword: "", imapPort: "143" });
  assert.match(r.updates.at(-1).view.notice, /`work` updated/);
  const edited = (await store.getUser(VIEWER)).emailAccounts[0];
  assert.equal(edited.imap.port, 143);
  assert.equal(edited.imap.security, "starttls");
  assert.equal(edited.imap.password, PASSWORD);
  assert.match(await removeSettingsForm("em:p:work", await ctx()), /Removed email account `work`/);
  assert.deepEqual((await store.getUser(VIEWER)).emailAccounts, []);
});

test("an email save gets the longer budget the mailbox logins need; other forms keep theirs", () => {
  assert.equal(SETTINGS_FORM_TIMEOUT_MS, 15_000);
  assert.equal(EMAIL_SETTINGS_FORM_TIMEOUT_MS, 45_000);
});
