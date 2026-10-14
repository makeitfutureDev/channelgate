// The redesigned Slack Settings (2026-10): inline forms saved through the modal's own submit, the
// variables' ⋯ menu (Replace value · Allowed servers · Make readable/secret · Remove) with its
// in-place confirmations, connection edits and removals per scope, and who may do which.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { applySettingsConfirm, applyVariableMenu, handleSettingsFormSubmission, removeSettingsForm, saveSettingsForm } = await import("../src/slack/app.js");
const { buildChannelSettingsView, readSettingsForm, settingsFieldBlockId, settingsFormSpec, parseSettingsMetadata } = await import("../src/slack/channel-settings.js");
const store = await import("../src/config/store.js");
const { listChannelEnv } = await import("../src/config/channel-env.js");
const { listUserEnv, listOrgEnv } = await import("../src/config/scoped-env.js");

const entry = await store.upsertChannelEntry("C_REDESIGN", { name: "redesign", type: "channel", isDM: false });
await store.saveChannelMeta(entry.slug, { ...store.defaultChannelMeta({ channelId: "C_REDESIGN", name: "redesign", type: "channel", isDM: false }), manageAccess: "admins" });
await store.setUser("U_MEMBER", { name: "Member", approved: true });
const meta = async () => store.getChannelMeta(entry.slug);
const ctx = async (overrides = {}) => ({ entry, meta: await meta(), clicker: "U_MEMBER", userIsAdmin: false, userIsApproved: true, ...overrides });
const channelVar = async (name) => listChannelEnv(await meta()).find((row) => row.name === name);

test("the variable ⋯ menu: add, allowed servers, replace value, readable/secret and remove all do what they say", async () => {
  assert.deepEqual(await saveSettingsForm("var-add:c", { name: "acme_api_key", value: "acme-secret-value-1111", secret: true }, await ctx()), { notice: "✅ Added *ACME_API_KEY*." });
  let row = await channelVar("ACME_API_KEY");
  assert.equal(row.protected, true, "a ticked Secret is hidden");
  assert.equal(row.last4, "1111");

  // Allowed servers: opens a form prefilled with the current list, then replaces it.
  assert.deepEqual(await applyVariableMenu({ s: "c", n: "ACME_API_KEY", a: "hosts" }, await ctx()), { form: "var-hosts:c:ACME_API_KEY" });
  const saved = await saveSettingsForm("var-hosts:c:ACME_API_KEY", { hosts: "api.acme.example, *.acme.example" }, await ctx());
  assert.match(saved.notice, /only to api\.acme\.example, \*\.acme\.example/);
  row = await channelVar("ACME_API_KEY");
  assert.deepEqual(row.hosts, ["api.acme.example", "*.acme.example"]);
  assert.equal(row.approval, false, "declared servers need no approval card");
  assert.equal(settingsFormSpec("var-hosts:c:ACME_API_KEY", { secrets: [row] }).fields[0].initial, "api.acme.example, *.acme.example");
  assert.equal((await saveSettingsForm("var-hosts:c:ACME_API_KEY", { hosts: "not a host!" }, await ctx())).field, "hosts");

  // Replace value keeps the type and the allowed servers.
  assert.deepEqual(await applyVariableMenu({ s: "c", n: "ACME_API_KEY", a: "value" }, await ctx()), { form: "var-val:c:ACME_API_KEY" });
  assert.match((await saveSettingsForm("var-val:c:ACME_API_KEY", { value: "acme-secret-value-2222" }, await ctx())).notice, /Same type and allowed servers/);
  row = await channelVar("ACME_API_KEY");
  assert.equal(row.last4, "2222");
  assert.deepEqual(row.hosts, ["api.acme.example", "*.acme.example"]);
  assert.equal(row.protected, true);

  // Make readable asks first; confirming hands programs the real value.
  assert.deepEqual(await applyVariableMenu({ s: "c", n: "ACME_API_KEY", a: "readable" }, await ctx()), { confirm: "var-read:c:ACME_API_KEY" });
  assert.equal((await channelVar("ACME_API_KEY")).protected, true, "nothing changes before the confirmation");
  assert.match(await applySettingsConfirm("var-read:c:ACME_API_KEY", await ctx()), /readable/);
  assert.equal((await channelVar("ACME_API_KEY")).protected, false);
  // Make secret applies at once, and its declared servers come back into force.
  assert.match((await applyVariableMenu({ s: "c", n: "ACME_API_KEY", a: "secret" }, await ctx())).notice, /secret again/);
  assert.equal((await channelVar("ACME_API_KEY")).protected, true);

  // Emptying the allowed servers falls back to "an admin approves each server".
  await saveSettingsForm("var-hosts:c:ACME_API_KEY", { hosts: "" }, await ctx());
  row = await channelVar("ACME_API_KEY");
  assert.equal(row.approval, true);
  assert.deepEqual(row.hosts, []);

  // A duplicate add is refused under the name, pointing at Replace value.
  const duplicate = await saveSettingsForm("var-add:c", { name: "ACME_API_KEY", value: "x".repeat(20) }, await ctx());
  assert.equal(duplicate.field, "name");
  assert.match(duplicate.error, /Replace value/);

  // Remove asks first, then removes.
  assert.deepEqual(await applyVariableMenu({ s: "c", n: "ACME_API_KEY", a: "remove" }, await ctx()), { confirm: "var-rm:c:ACME_API_KEY" });
  assert.ok(await channelVar("ACME_API_KEY"));
  await applySettingsConfirm("var-rm:c:ACME_API_KEY", await ctx());
  assert.equal(await channelVar("ACME_API_KEY"), undefined);
  await assert.rejects(applyVariableMenu({ s: "c", n: "ACME_API_KEY", a: "value" }, await ctx()), /no longer exists/);
});

test("an unticked Secret is readable; a password stays readable even when made secret, and says why", async () => {
  await saveSettingsForm("var-add:c", { name: "PLAIN_REGION", value: "eu-central-1-value", secret: false }, await ctx());
  assert.equal((await channelVar("PLAIN_REGION")).protected, false);
  await saveSettingsForm("var-add:c", { name: "SMTP_PASSWORD", value: "smtp-password-value-9", secret: true }, await ctx());
  const result = await applyVariableMenu({ s: "c", n: "SMTP_PASSWORD", a: "secret" }, await ctx());
  assert.match(result.notice, /stays readable/);
  assert.match(result.notice, /Add allowed servers to hide it/);
});

test("organization variables are admin-only; personal ones belong to the viewer", async () => {
  await assert.rejects(applyVariableMenu({ s: "o", n: "ANY", a: "value" }, await ctx()), /Only admins/);
  await assert.rejects(saveSettingsForm("var-add:o", { name: "ORG_KEY", value: "org-value-123456" }, await ctx()), /Only admins/);
  await saveSettingsForm("var-add:o", { name: "ORG_KEY", value: "org-value-123456" }, await ctx({ userIsAdmin: true }));
  assert.ok(listOrgEnv().some((row) => row.name === "ORG_KEY"));
  await saveSettingsForm("var-add:p", { name: "MY_TOKEN", value: "my-token-value-77", secret: true }, await ctx());
  assert.ok((await listUserEnv("U_MEMBER")).some((row) => row.name === "MY_TOKEN"));
  assert.equal(await channelVar("MY_TOKEN"), undefined, "a personal variable never lands on the channel");
});

test("connections save and remove per scope, never echo a token, and refuse what is wrong under its field", async () => {
  assert.equal((await saveSettingsForm("composio:c", { label: "Team", token: "" }, await ctx())).field, "token", "a first save needs the token");
  assert.match((await saveSettingsForm("composio:c", { label: "Team", token: "ck_channel_secret_1234" }, await ctx())).notice, /Composio account/);
  assert.equal((await meta()).composioToken, "ck_channel_secret_1234");
  assert.equal((await meta()).composioTokenLabel, "Team");
  // A label-only save keeps the token.
  await saveSettingsForm("composio:c", { label: "Ops", token: "" }, await ctx());
  assert.equal((await meta()).composioToken, "ck_channel_secret_1234");
  assert.equal((await meta()).composioTokenLabel, "Ops");
  assert.match(await removeSettingsForm("composio:c", await ctx()), /Removed the channel's Composio token/);
  assert.equal((await meta()).composioToken, "");

  const badMake = await saveSettingsForm("make:c", { url: "https://evil.example/mcp", token: "make-key-123456" }, await ctx());
  assert.equal(badMake.field, "url");
  await saveSettingsForm("make:c", { url: "https://eu1.make.com/mcp/server/abc-1", token: "make-key-123456" }, await ctx());
  assert.equal((await meta()).makeToolboxKey, "make-key-123456");
  await removeSettingsForm("make:c", await ctx());
  assert.equal((await meta()).makeToolboxUrl, "");

  await saveSettingsForm("toolbox:p", { token: "tb-personal-123456" }, await ctx());
  assert.equal((await store.getUser("U_MEMBER")).toolboxToken, "tb-personal-123456");
  await removeSettingsForm("toolbox:p", await ctx());
  assert.equal((await store.getUser("U_MEMBER")).toolboxToken, "");
  assert.equal((await saveSettingsForm("toolbox:c", { token: "abc" }, await ctx())).field, "token", "too short");
});

test("a conversation's custom MCP servers need a manager; the viewer's own do not", async () => {
  await assert.rejects(saveSettingsForm("cm-add:c", { name: "linear", url: "https://93.184.215.14/mcp", token: "lin-token-123456" }, await ctx()), /managers or an admin/);
  assert.match((await saveSettingsForm("cm-add:c", { name: "linear", url: "https://93.184.215.14/mcp", token: "lin-token-123456" }, await ctx({ userIsAdmin: true }))).notice, /custom-linear/);
  // Editing keeps the token when the box is left empty; a private URL is refused under the URL.
  await saveSettingsForm("cm:c:linear", { url: "https://93.184.215.14/v2", token: "" }, await ctx({ userIsAdmin: true }));
  assert.equal((await meta()).customMcps[0].token, "lin-token-123456");
  assert.equal((await saveSettingsForm("cm:c:linear", { url: "https://127.0.0.1/", token: "" }, await ctx({ userIsAdmin: true }))).field, "url");
  assert.match((await saveSettingsForm("cm-add:p", { name: "notes", url: "https://93.184.215.14/mcp", token: "notes-token-123456" }, await ctx())).notice, /my-notes/);
  assert.match(await removeSettingsForm("cm:p:notes", await ctx()), /my-notes/);
  await removeSettingsForm("cm:c:linear", await ctx({ userIsAdmin: true }));
  assert.deepEqual((await meta()).customMcps, []);
});

test("an open form turns the footer into Save, and the submission saves it or puts the refusal under its field", async () => {
  const state = { channelId: "C_REDESIGN", slug: entry.slug, threadTs: "", ownerId: "U_MEMBER", tab: "you", form: "var-add:p" };
  const view = buildChannelSettingsView({ personalSecrets: [] }, state, { tab: "you" });
  assert.equal(view.submit.text, "Save");
  assert.equal(view.close.text, "Close");
  assert.equal(parseSettingsMetadata(view.private_metadata).form, "var-add:p");
  const nameBlock = settingsFieldBlockId("var-add:p", "name");
  assert.ok(view.blocks.some((block) => block.block_id === nameBlock));
  // Field ids are keyed by the form, so Slack cannot carry a typed value from one form into another.
  assert.notEqual(settingsFieldBlockId("var-add:p", "value"), settingsFieldBlockId("var-add:c", "value"));

  const values = (name, value) => ({
    [settingsFieldBlockId("var-add:p", "name")]: { v: { value: name } },
    [settingsFieldBlockId("var-add:p", "value")]: { v: { value } },
    [settingsFieldBlockId("var-add:p", "secret")]: { v: { selected_options: [{ value: "secret" }] } },
  });
  assert.deepEqual(readSettingsForm({ state: { values: values("A_B", "c") } }, "var-add:p"), { name: "A_B", value: "c", secret: true });
  const context = async () => ({ entry, meta: await meta(), userIsAdmin: false, userIsApproved: true });
  const rootView = async (_entry, _meta, nextState, _admin, { notice }) => ({ type: "modal", notice, form: nextState.form });

  let acked;
  await handleSettingsFormSubmission({ ack: async (a) => { acked = a; }, body: { user: { id: "U_MEMBER" } }, view: { private_metadata: view.private_metadata, state: { values: values("1BAD", "value-123456") } } }, { context, rootView });
  assert.equal(acked.response_action, "errors");
  assert.ok(acked.errors[nameBlock], "the refusal sits under Name");

  await handleSettingsFormSubmission({ ack: async (a) => { acked = a; }, body: { user: { id: "U_MEMBER" } }, view: { private_metadata: view.private_metadata, state: { values: values("FROM_FORM", "form-value-123456") } } }, { context, rootView });
  assert.equal(acked.response_action, "update");
  assert.match(acked.view.notice, /FROM_FORM/);
  assert.equal(acked.view.form, "", "the form closes after saving");
  assert.ok((await listUserEnv("U_MEMBER")).some((row) => row.name === "FROM_FORM"));

  // Someone else's modal is refused without writing; a submission with no form just closes.
  await handleSettingsFormSubmission({ ack: async (a) => { acked = a; }, body: { user: { id: "U_OTHER" } }, view: { blocks: view.blocks, private_metadata: view.private_metadata, state: { values: values("NOPE", "nope-value-123456") } } }, { context, rootView });
  assert.equal(acked.response_action, "errors");
  assert.match(Object.values(acked.errors)[0], /isn't yours/, "the refusal is visible under the first field");
  assert.equal((await listUserEnv("U_MEMBER")).some((row) => row.name === "NOPE"), false);
  let closed = false;
  await handleSettingsFormSubmission({ ack: async (a) => { closed = a === undefined; }, body: { user: { id: "U_MEMBER" } }, view: { private_metadata: JSON.stringify({ c: "C_REDESIGN", s: entry.slug, u: "U_MEMBER", p: "you" }) } }, { context, rootView });
  assert.equal(closed, true);
});

// Slack rejects a whole view when ONE limit is broken, so every page — in every role, and with
// every inline form open — is checked against the Block Kit rules this modal leans on.
function blockKitProblems(view) {
  const problems = [];
  const text = (value, max, where) => { if (String(value ?? "").length > max) problems.push(`${where} longer than ${max}`); };
  if (view.blocks.length > 100) problems.push("more than 100 blocks");
  text(view.title.text, 24, "title");
  if (view.submit) text(view.submit.text, 24, "submit");
  text(view.close?.text, 24, "close");
  text(view.private_metadata, 3000, "private_metadata");
  if (view.blocks.some((block) => block.type === "input") && !view.submit) problems.push("input blocks without a submit button");
  const blockIds = new Set();
  const optionProblems = (element, where) => {
    const options = element.options || [];
    for (const option of options) {
      text(option.text?.text, 75, `${where} option text`);
      text(option.value, 150, `${where} option value`);
      if (option.description) text(option.description.text, 75, `${where} option description`);
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (element.initial_option && !options.some((option) => same(option, element.initial_option))) problems.push(`${where} initial_option is not one of its options`);
    for (const initial of element.initial_options || []) if (!options.some((option) => same(option, initial))) problems.push(`${where} initial_options entry is not one of its options`);
    if (element.type === "overflow" && (options.length < 2 || options.length > 5)) problems.push(`${where} overflow needs 2-5 options`);
    if (element.type === "checkboxes" && options.length > 10) problems.push(`${where} more than 10 checkboxes`);
    if (/select/.test(element.type) && options.length > 100) problems.push(`${where} more than 100 options`);
    if (element.initial_options && !element.initial_options.length) problems.push(`${where} empty initial_options`);
  };
  view.blocks.forEach((block, index) => {
    const where = `block ${index} (${block.type})`;
    if (block.block_id) {
      if (blockIds.has(block.block_id)) problems.push(`${where} duplicate block_id ${block.block_id}`);
      blockIds.add(block.block_id);
      text(block.block_id, 255, `${where} block_id`);
    }
    if (block.type === "header") text(block.text.text, 150, where);
    if (block.type === "section" && block.text) text(block.text.text, 3000, where);
    if (block.type === "context" && block.elements.length > 10) problems.push(`${where} more than 10 context elements`);
    const elements = [...(block.accessory ? [block.accessory] : []), ...(block.type === "actions" ? block.elements : []), ...(block.type === "input" ? [block.element] : [])];
    if (block.type === "actions" && block.elements.length > 25) problems.push(`${where} more than 25 elements`);
    const actionIds = new Set();
    for (const element of elements) {
      if (element.action_id) {
        if (actionIds.has(element.action_id)) problems.push(`${where} duplicate action_id ${element.action_id}`);
        actionIds.add(element.action_id);
        text(element.action_id, 255, `${where} action_id`);
      }
      if (element.type === "button") { text(element.text.text, 75, `${where} button text`); text(element.value, 2000, `${where} button value`); }
      optionProblems(element, where);
    }
  });
  return problems;
}

test("every page, in every role and with every inline form open, is valid Block Kit", () => {
  const masked = (last4) => ({ configured: true, last4 });
  const long = "X".repeat(64);
  const snapshot = {
    runtime: { scopes: {
      channel: { values: { engine: "", model: "", effort: "" }, inherited: { engine: "Claude", model: "Opus", effort: "high" }, options: { engines: [{ label: "Claude", value: "claude" }], models: [{ label: "Opus", value: "opus" }], efforts: [{ label: "High", value: "high" }] } },
      thread: { values: { engine: "claude", model: "", effort: "" }, pinned: true, inherited: {}, options: { engines: [{ label: "Claude", value: "claude" }], models: [], efforts: [] } },
    } },
    mode: { autoMode: true, allowNetwork: true },
    access: { access: "approved", manageAccess: "custom", managers: ["U2"] },
    members: Array.from({ length: 60 }, (_, i) => ({ id: `U${i}`, approved: i % 2 === 0, use: i % 3 === 0, manage: i === 2, isAdmin: i === 0 })),
    vpn: { configured: false, state: "unconfigured" },
    resume: { inThread: true, command: "codex resume 019a7c2e" },
    connections: { composioMode: "personal", composioChannel: masked("t5zq"), composioTokenLabel: "Team", toolboxChannel: { configured: false }, toolboxOrg: masked("aaaa"), makeToolboxUrl: "https://eu1.make.com/mcp/server/x", makeToolboxKey: masked("mkey"), toolboxUrl: "https://toolbox.example/mcp" },
    my: { composio: masked("9f2a"), composioLabel: "me", toolbox: { configured: false } },
    customMcps: { channel: [{ name: "linear", serverName: "custom-linear", url: "https://mcp.linear.app/mcp", tokenLast4: "ABCD" }], personal: [{ name: "notes", serverName: "my-notes", url: "https://notes.example/mcp", tokenLast4: "WXYZ" }] },
    cloudMcp: { claude: { ready: true, options: Array.from({ length: 120 }, (_, i) => ({ key: `srv-${i}`, label: `Server ${i}` })), selected: ["srv-1"], inherited: ["drive"] }, codex: { ready: false } },
    secrets: [{ name: long, last4: "beef", protected: true, hosts: ["a.example", "b.example"] }, { name: "GMAIL_APP_PASSWORD", last4: "rzhb", protected: false }],
    orgSecrets: [{ name: "ORG_KEY", last4: "o123", protected: true, approval: true, hosts: [] }],
    personalSecrets: [{ name: "MY_TOKEN", last4: "p123", protected: true, approval: true, hosts: [] }],
    skills: { template: "Development", templateSlug: "development", templates: [{ slug: "development", name: "Development" }], additional: ["pdf"], channel: ["pdf", "review"], organization: ["gateway-usage"] },
    skillPicker: { options: Array.from({ length: 130 }, (_, i) => ({ key: `skill-${i}`, label: `skill-${i}`, description: "d".repeat(200) })), selected: ["skill-3"] },
    mySkillPicker: { options: [{ key: "email-triage", label: "email-triage" }], selected: [] },
    automations: [
      { id: "rec1", cron: "0 9 * * 1-5", description: "Daily", enabled: true, kind: "task", lastStatus: "ok" },
      { id: "once1", once: true, runAt: "2026-10-01T07:30:00.000Z", description: "Ping", enabled: true, kind: "reminder" },
    ],
  };
  const state = { channelId: "C_KIT", slug: "kit", threadTs: "1.2", ownerId: "U_OWNER" };
  const roles = [
    { canEditAccess: false, canEditSecrets: true },
    { canEditAccess: true, canEditSecrets: true, canManageCustomMcp: true, canManageVpn: true },
    { canEditAccess: true, canEditSecrets: true, canManageCustomMcp: true, canManageVpn: true, canEditOrgSecrets: true, canManageCloudMcp: true, canEnableAdmin: true },
  ];
  const forms = ["composio:c", "make:c", "toolbox:c", "cm-add:c", "cm:c:linear", `var-add:c`, `var-val:c:${long}`, `var-hosts:c:${long}`, "var-add:o", "composio:p", "toolbox:p", "cm-add:p", "cm:p:notes", "var-add:p", "var-val:p:MY_TOKEN"];
  const formPage = (key) => (key.startsWith("var") ? (key.includes(":p") ? "you" : "variables") : key.includes(":p") ? "you" : "mcp");
  for (const options of roles) {
    for (const tab of ["agent", "access", "mcp", "variables", "skills", "schedules", "you"]) {
      for (const extra of [{}, { confirm: `var-rm:c:${long}` }, { confirm: "sched-rm:rec1" }]) {
        const view = buildChannelSettingsView(snapshot, { ...state, ...extra }, { ...options, tab, notice: "✅ Saved." });
        assert.deepEqual(blockKitProblems(view), [], `${tab} ${JSON.stringify(options)} ${JSON.stringify(extra)}`);
      }
    }
    for (const form of forms) {
      const view = buildChannelSettingsView(snapshot, { ...state, form }, { ...options, tab: formPage(form) });
      assert.deepEqual(blockKitProblems(view), [], form);
    }
  }
  // A DM, too.
  assert.deepEqual(blockKitProblems(buildChannelSettingsView({ ...snapshot, isDM: true, mode: { adminMode: true } }, state, { tab: "agent", canEnableAdmin: true })), []);
});
