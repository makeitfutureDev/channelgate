import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { setUser, getUser } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { getDb } = await import("../src/db/index.js");
const catalog = await import("../src/gateway/skills/catalog.js");
const authoring = await import("../src/gateway/skills/authoring.js");
const { setEmailAccountVerifierForTests } = await import("../src/gateway/email-account-store.js");
const { applyUserSettingsChange, userSettingsSnapshot, personalSkillPicker, UserSettingsError } = await import("../src/gateway/user-settings.js");

const PUBLIC_URL = "https://93.184.215.14/mcp"; // a literal public address: no DNS needed offline
const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJGL94yuutmsHOUH3doi4E7xZXvtMROqyt4ckprx0On+ test@example";
const COMPOSIO = "composio-token-value-0001";
const md = (name, description, extra = "") => ({ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n` });
const verified = [];
setEmailAccountVerifierForTests(async (record) => { verified.push(record.name); });
after(() => setEmailAccountVerifierForTests(null));

beforeEach(async () => {
  getDb().exec("DELETE FROM ssh_keys");
  saveSettings({ composioMode: "personal" });
  await setUser("U_ME", { name: "Me", approved: true, isAdmin: false, composioToken: "", composioTokenLabel: "", toolboxToken: "", customMcps: [], emailAccounts: [], env: {}, skills: [], nudges: false, replyMentions: false });
  await setUser("U_OTHER", { name: "Other", approved: true, isAdmin: false, composioToken: "other-token-1234567890", env: {}, skills: [] });
  verified.length = 0;
});

const change = (body, options) => applyUserSettingsChange("U_ME", body, options);
async function refused(body, pattern, field) {
  await assert.rejects(change(body), (error) => {
    assert.ok(error instanceof UserSettingsError, error.message);
    assert.equal(error.status, 400);
    assert.match(error.message, pattern);
    if (field !== undefined) assert.equal(error.field, field);
    return true;
  });
}

test("snapshot is masked: secrets are reported as configured/last4, never as values", async () => {
  await change({ action: "composio.save", token: COMPOSIO, label: "Work" });
  await change({ action: "toolbox.save", token: "toolbox-secret-abcdef123456" });
  await change({ action: "variable.save", name: "MY_API_KEY", value: "sk-very-secret-value-9876" });
  await change({ action: "mcp.save", name: "notion", url: PUBLIC_URL, token: "mcp-bearer-secret-0000" });
  await change({ action: "email.save", name: "work", address: "me@example.com", imapHost: "imap.example.com", imapUser: "me", imapPassword: "mail-password-1111", smtpHost: "smtp.example.com" });
  const snapshot = await userSettingsSnapshot("U_ME");
  const json = JSON.stringify(snapshot);
  for (const secret of [COMPOSIO, "toolbox-secret-abcdef123456", "sk-very-secret-value-9876", "mcp-bearer-secret-0000", "mail-password-1111"]) {
    assert.ok(!json.includes(secret), `snapshot leaked ${secret}`);
  }
  assert.deepEqual(snapshot.account, { id: "U_ME", name: "Me", role: "member" });
  assert.deepEqual(snapshot.connections.composio, { configured: true, last4: "0001", label: "Work" });
  assert.equal(snapshot.connections.toolbox.last4, "3456");
  assert.equal(snapshot.variables[0].name, "MY_API_KEY");
  assert.equal(snapshot.variables[0].exposure, "hidden");
  assert.equal(snapshot.mcps.servers[0].serverName, "my-notion");
  assert.equal(snapshot.mcps.servers[0].tokenLast4, "0000");
  assert.equal(snapshot.connections.email[0].address, "me@example.com");
  assert.deepEqual(verified, ["work"], "the mail logins are tested before saving");
  assert.equal((await getUser("U_OTHER")).composioToken, "other-token-1234567890", "another person is untouched");
});

test("every change targets only the owner; caller-supplied owners, roles and fields are ignored", async () => {
  await change({ action: "nudges", enabled: true, userId: "U_OTHER", ownerId: "U_OTHER", isAdmin: true, approved: false });
  const me = await getUser("U_ME"), other = await getUser("U_OTHER");
  assert.equal(me.nudges, true);
  assert.equal(me.isAdmin, false);
  assert.equal(me.approved, true);
  assert.equal(other.nudges, undefined);
  await refused({ action: "nudges", enabled: "yes" }, /on or off/);
  assert.equal((await userSettingsSnapshot("U_ME")).general.replyMentions, false, "new users start with reply mentions off");
  await change({ action: "replyMentions", enabled: true, userId: "U_OTHER" });
  assert.equal((await getUser("U_ME")).replyMentions, true);
  assert.notEqual((await getUser("U_OTHER")).replyMentions, true);
  assert.equal((await userSettingsSnapshot("U_ME")).general.replyMentions, true);
  await refused({ action: "replyMentions", enabled: 1 }, /on or off/);
  await refused({ action: "isAdmin", value: true }, /Unknown setting/);
  await refused({}, /Unknown setting/);
  await assert.rejects(applyUserSettingsChange("", { action: "nudges", enabled: true }), (error) => error.status === 403);
});

test("Composio and Toolbox: save, keep-token label edits, removal, and SDK mode refusal", async () => {
  await refused({ action: "composio.save", token: "" }, /Enter the token/, "token");
  await refused({ action: "composio.save", token: "abc" }, /valid Composio token/, "token");
  assert.match((await change({ action: "composio.save", token: COMPOSIO })).notice, /Composio/);
  await change({ action: "composio.save", label: "Renamed" });
  assert.equal((await getUser("U_ME")).composioToken, COMPOSIO, "a label-only save keeps the token");
  assert.equal((await getUser("U_ME")).composioTokenLabel, "Renamed");
  await change({ action: "composio.remove" });
  assert.equal((await getUser("U_ME")).composioToken, "");
  await refused({ action: "toolbox.save", token: "" }, /Enter the token/);
  await change({ action: "toolbox.save", token: "toolbox-secret-abcdef123456" });
  await change({ action: "toolbox.remove" });
  assert.equal((await getUser("U_ME")).toolboxToken, "");
  saveSettings({ composioMode: "sdk" });
  await refused({ action: "composio.save", token: COMPOSIO }, /SDK mode/);
  assert.equal((await userSettingsSnapshot("U_ME")).connections.composioMode, "sdk");
});

test("variables: hidden by default, readable on request, replace keeps the type, remove, and validation", async () => {
  await refused({ action: "variable.save", name: "my-token", value: "x" }, /not a valid name/, "name");
  await refused({ action: "variable.save", name: "PATH", value: "x" }, /./, "name");
  await refused({ action: "variable.save", name: "LD_PRELOAD", value: "x" }, /./, "name");
  await refused({ action: "variable.save", name: "GOOD_NAME", value: "" }, /Enter a value/, "value");
  await change({ action: "variable.save", name: "DB_URL", value: "postgres://user:pw@db.example.com/x", readable: true });
  await change({ action: "variable.save", name: "API_TOKEN", value: "first-value-123456" });
  let rows = (await userSettingsSnapshot("U_ME")).variables;
  assert.deepEqual(rows.map((r) => [r.name, r.exposure]), [["API_TOKEN", "hidden"], ["DB_URL", "readable"]]);
  const replaced = await change({ action: "variable.save", name: "DB_URL", value: "postgres://user:pw2@db.example.com/x" });
  assert.match(replaced.notice, /Replaced DB_URL/);
  rows = (await userSettingsSnapshot("U_ME")).variables;
  assert.equal(rows.find((r) => r.name === "DB_URL").exposure, "readable", "a replaced value keeps its type");
  await change({ action: "variable.remove", name: "API_TOKEN" });
  await refused({ action: "variable.remove", name: "API_TOKEN" }, /no longer exists/);
  assert.deepEqual((await userSettingsSnapshot("U_ME")).variables.map((r) => r.name), ["DB_URL"]);
});

test("custom MCP servers: add, edit keeping the token, refuse private URLs, remove", async () => {
  await refused({ action: "mcp.save", name: "local", url: "https://127.0.0.1/mcp", token: "tok-123456" }, /refused/i, "url");
  await refused({ action: "mcp.save", name: "new", url: PUBLIC_URL, token: "" }, /token is required/i, "token");
  await refused({ action: "mcp.save", name: "x", url: PUBLIC_URL, token: "tok-123456", authType: "custom" }, /Bearer token or Composio/, "authType");
  await change({ action: "mcp.save", name: "Notion", url: PUBLIC_URL, token: "Bearer mcp-bearer-secret-0000" });
  await change({ action: "mcp.save", name: "notion", url: "https://93.184.215.14/v2/mcp" });
  const [server] = (await userSettingsSnapshot("U_ME")).mcps.servers;
  assert.equal(server.url, "https://93.184.215.14/v2/mcp");
  assert.equal(server.tokenLast4, "0000", "an edit without a token keeps the stored one");
  await change({ action: "mcp.remove", name: "notion" });
  await refused({ action: "mcp.remove", name: "notion" }, /No custom MCP/);
});

test("email accounts: logins are tested, updates keep stored passwords, removal works", async () => {
  setEmailAccountVerifierForTests(async () => { throw new Error("IMAP login failed: authentication rejected"); });
  await refused({ action: "email.save", name: "work", address: "me@example.com", imapHost: "imap.example.com", imapUser: "me", imapPassword: "bad", smtpHost: "smtp.example.com" }, /IMAP login failed/);
  assert.deepEqual((await userSettingsSnapshot("U_ME")).connections.email, []);
  setEmailAccountVerifierForTests(async (record) => { verified.push(record.imap.password); });
  await change({ action: "email.save", name: "work", address: "me@example.com", imapHost: "imap.example.com", imapUser: "me", imapPassword: "mail-password-1111", smtpHost: "smtp.example.com" });
  await change({ action: "email.save", name: "work", address: "me@example.com", imapHost: "imap2.example.com", imapUser: "me", smtpHost: "smtp.example.com" });
  assert.deepEqual(verified, ["mail-password-1111", "mail-password-1111"], "a blank password keeps the stored one");
  assert.equal((await userSettingsSnapshot("U_ME")).connections.email[0].imap.host, "imap2.example.com");
  await change({ action: "email.remove", name: "work" });
  assert.deepEqual((await userSettingsSnapshot("U_ME")).connections.email, []);
});

test("skills: only offered skills can be added; another person's personal skill is never offered", async () => {
  catalog.putSkillRevision({ files: [md("Shared Writer", "org skill")], ownerKind: "local", createdBy: "U_ADMIN" });
  await authoring.createLocalSkill({ files: [md("Their Notes", "theirs")], createdBy: "U_OTHER", personal: true, publish: false });
  const picker = await personalSkillPicker("U_ME", false);
  assert.ok(picker.options.some((o) => o.key === "shared-writer"));
  await change({ action: "skills.save", selected: ["Shared-Writer"] });
  assert.deepEqual((await getUser("U_ME")).skills, ["shared-writer"]);
  assert.deepEqual((await userSettingsSnapshot("U_ME")).skills.selected, ["shared-writer"]);
  assert.equal(picker.options.some((o) => o.key === "their-notes"), false);
  await refused({ action: "skills.save", selected: ["their-notes"] }, /not available to you/);
  await refused({ action: "skills.save", selected: "shared-writer" }, /Choose skills/);
  await change({ action: "skills.save", selected: [] });
  assert.deepEqual((await getUser("U_ME")).skills, []);
});

test("SSH keys: add, refuse private keys and duplicates owned by someone else, remove", async () => {
  await refused({ action: "ssh.add", publicKey: "" }, /Paste your public key/, "publicKey");
  await refused({ action: "ssh.add", publicKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----" }, /./, "publicKey");
  const added = await change({ action: "ssh.add", publicKey: ED25519, label: "laptop" });
  assert.match(added.notice, /Registered SHA256:/);
  const [key] = (await userSettingsSnapshot("U_ME")).ssh.keys;
  assert.equal(key.label, "laptop");
  await assert.rejects(applyUserSettingsChange("U_OTHER", { action: "ssh.add", publicKey: ED25519 }), /another account/);
  await assert.rejects(applyUserSettingsChange("U_OTHER", { action: "ssh.remove", id: key.id }), /no longer registered/);
  await change({ action: "ssh.remove", id: key.id });
  assert.deepEqual((await userSettingsSnapshot("U_ME")).ssh.keys, []);
});

test("authorize runs before every write and a failed recheck writes nothing", async () => {
  const denied = Object.assign(new Error("Activity access ended"), { status: 403 });
  const authorize = async () => { throw denied; };
  for (const body of [
    { action: "nudges", enabled: true },
    { action: "replyMentions", enabled: true },
    { action: "composio.save", token: COMPOSIO },
    { action: "toolbox.save", token: "toolbox-secret-abcdef123456" },
    { action: "variable.save", name: "API_TOKEN", value: "value-123456" },
    { action: "mcp.save", name: "notion", url: PUBLIC_URL, token: "tok-123456" },
    { action: "email.save", name: "work", address: "me@example.com", imapHost: "imap.example.com", imapUser: "me", imapPassword: "pw-123456", smtpHost: "smtp.example.com" },
    { action: "ssh.add", publicKey: ED25519 },
  ]) await assert.rejects(change(body, { authorize }), (error) => error === denied, body.action);
  const me = await getUser("U_ME");
  assert.equal(me.nudges, false);
  assert.notEqual(me.replyMentions, true);
  assert.equal(me.composioToken, "");
  assert.equal(me.toolboxToken, "");
  assert.deepEqual((await userSettingsSnapshot("U_ME")).variables, []);
  assert.deepEqual((await userSettingsSnapshot("U_ME")).mcps.servers, []);
  assert.deepEqual((await userSettingsSnapshot("U_ME")).connections.email, []);
  assert.deepEqual((await userSettingsSnapshot("U_ME")).ssh.keys, []);
});
