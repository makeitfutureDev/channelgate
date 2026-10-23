// Slack rejects a whole modal (`views.open` → `invalid_arguments`) when ONE block breaks a Block
// Kit rule, and the person just sees "An API error occurred". The first live open after the
// Enterprise harness picker landed did exactly that: a channel whose approved-harness list was
// empty (or named an engine the build no longer offers) rendered a multi-select with an EMPTY
// `initial_options`. This renders every Settings page for several viewer/channel/policy variants
// and checks the limits Slack enforces, so the next such drift fails here instead of in Slack.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { buildChannelSettingsView, CHANNEL_SETTINGS_TABS } = await import("../src/slack/channel-settings.js");

const len = (t) => (typeof t === "string" ? t : t?.text || "").length;
function validateElement(e, where, problems) {
  const bad = (msg) => problems.push(`${where}: ${msg}`);
  if (!e) return bad("missing element");
  if (e.action_id && e.action_id.length > 255) bad("action_id too long");
  if (e.type === "button") {
    if (!(len(e.text) > 0 && len(e.text) <= 75)) bad(`button text length ${len(e.text)}`);
    if (e.value !== undefined && String(e.value).length > 2000) bad("button value too long");
    if (e.confirm && !(len(e.confirm.title) <= 100 && len(e.confirm.text) <= 300 && len(e.confirm.confirm) <= 30 && len(e.confirm.deny) <= 30)) bad("confirm texts too long");
  }
  if (e.type === "plain_text_input") {
    if (e.placeholder && !(len(e.placeholder) > 0 && len(e.placeholder) <= 150)) bad(`placeholder length ${len(e.placeholder)}`);
    if (e.max_length !== undefined && !(e.max_length >= 1 && e.max_length <= 3000)) bad(`max_length ${e.max_length}`);
    if (e.initial_value !== undefined && !(typeof e.initial_value === "string" && e.initial_value.length > 0)) bad(`initial_value ${JSON.stringify(e.initial_value)}`);
  }
  if (["static_select", "multi_static_select", "overflow", "checkboxes", "radio_buttons"].includes(e.type)) {
    const opts = e.options || (e.option_groups || []).flatMap((g) => g.options) || [];
    if (!(opts.length >= 1 && opts.length <= 100)) bad(`${opts.length} options`);
    if (e.type === "overflow" && opts.length > 5) bad("overflow has more than 5 options");
    for (const o of opts) {
      if (!(len(o.text) > 0 && len(o.text) <= 75)) bad(`option text length ${len(o.text)}`);
      if (String(o.value).length > 150) bad("option value too long");
      if (o.description && len(o.description) > 75) bad("option description too long");
    }
    if (e.placeholder && len(e.placeholder) > 150) bad("placeholder too long");
    if (e.initial_option && !opts.some((o) => o.value === e.initial_option.value)) bad(`initial_option ${e.initial_option.value} not among the options`);
    if (e.initial_options !== undefined) {
      if (!Array.isArray(e.initial_options) || !e.initial_options.length) bad("initial_options is empty — Slack refuses the view");
      for (const o of e.initial_options || []) if (!opts.some((x) => x.value === o.value)) bad(`initial option ${o.value} not among the options`);
    }
  }
}
export function blockKitProblems(view, where) {
  const problems = [];
  const bad = (msg) => problems.push(`${where}: ${msg}`);
  if (len(view.title) > 24) bad("title too long");
  if (view.submit && len(view.submit) > 24) bad("submit too long");
  if (view.close && len(view.close) > 24) bad("close too long");
  if (view.blocks.length > 100) bad(`${view.blocks.length} blocks`);
  const ids = new Set();
  view.blocks.forEach((b, i) => {
    const p = `${where}#${i}(${b.type})`;
    if (b.block_id) {
      if (ids.has(b.block_id)) problems.push(`${p}: duplicate block_id ${b.block_id}`);
      ids.add(b.block_id);
      if (b.block_id.length > 255) problems.push(`${p}: block_id too long`);
    }
    if (b.type === "header" && !(len(b.text) > 0 && len(b.text) <= 150)) problems.push(`${p}: header length ${len(b.text)}`);
    if (b.type === "section") {
      if (!((b.text && len(b.text) > 0 && len(b.text) <= 3000) || b.fields)) problems.push(`${p}: section text length ${len(b.text)}`);
      if (b.accessory) validateElement(b.accessory, `${p}.accessory`, problems);
    }
    if (b.type === "context") {
      if (!(b.elements?.length >= 1 && b.elements.length <= 10)) problems.push(`${p}: context elements`);
      for (const e of b.elements || []) if (!(len(e) > 0 && len(e) <= 2000)) problems.push(`${p}: context text length ${len(e)}`);
    }
    if (b.type === "actions") {
      if (!(b.elements?.length >= 1 && b.elements.length <= 25)) problems.push(`${p}: actions elements`);
      (b.elements || []).forEach((e, j) => validateElement(e, `${p}.el${j}`, problems));
    }
    if (b.type === "input") {
      if (!(len(b.label) > 0 && len(b.label) <= 2000)) problems.push(`${p}: label`);
      if (b.hint && len(b.hint) > 2000) problems.push(`${p}: hint too long`);
      validateElement(b.element, `${p}.element`, problems);
    }
  });
  return problems;
}

const harnessOptions = [{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }];
const base = {
  isDM: false, access: {}, mode: {},
  runtime: { harnessOptions, scopes: {}, configuredEngineId: "", configuredEngine: "", effectiveEngineId: "claude", effectiveEngine: "Claude Code", gatewayEngineId: "claude", gatewayEngineLabel: "Claude Code", configuredModel: "", gatewayModel: "sonnet", configuredEffort: "" },
  connections: { composioMode: "token" }, cloudMcp: { claude: { channel: [], organization: [] }, codex: { channel: [], organization: [] } },
  skills: {}, secrets: [], resume: {}, automations: [], orgSecrets: [], personalSecrets: [],
  customMcps: { channel: [], personal: [] },
  emailAccounts: { channel: [], personal: [{ name: "work", scope: "personal", address: "me@example.com", displayName: "", imap: { host: "imap.example.com", port: 993, security: "tls", user: "me@example.com", hasPassword: true }, smtp: { host: "smtp.example.com", port: 587, security: "starttls", user: "me@example.com", hasPassword: true }, sendEnabled: true, setBy: "U1", setAt: "", verifiedAt: "" }] },
  my: {}, vpn: { configured: false, state: "unconfigured" }, mySkillPicker: {}, skillPicker: {},
};
const everything = { canEditRuntime: true, canApproveHarnesses: true, canEnableAdmin: true, canEditSecrets: true, canEditOrgSecrets: true, canManageCloudMcp: true, canManageCustomMcp: true, canEditAccess: true, canManageVpn: true };
const nothing = {};

test("every Settings page respects Slack's Block Kit limits for admins and members, channels and DMs", () => {
  const problems = [];
  for (const [who, opts] of [["admin", everything], ["member", nothing]]) {
    for (const [kind, extra] of [["channel", {}], ["dm", { isDM: true }]]) {
      for (const [policy, approvedEngines] of [["all", null], ["empty", []], ["claude", ["claude"]], ["retired", ["qwen"]]]) {
        const snapshot = { ...base, ...extra, runtime: { ...base.runtime, approvedEngines } };
        for (const tab of CHANNEL_SETTINGS_TABS) {
          const view = buildChannelSettingsView(snapshot, { tab, c: "C1", u: "U1", slug: "chan" }, { ...opts, tab });
          problems.push(...blockKitProblems(view, `${who}/${kind}/${policy}/${tab}`));
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("an empty or retired approved-harness policy renders the picker unselected rather than with empty initial options", () => {
  for (const approvedEngines of [[], ["qwen"]]) {
    const view = buildChannelSettingsView({ ...base, runtime: { ...base.runtime, approvedEngines } }, { tab: "agent", c: "C1", u: "U1" }, everything);
    const select = view.blocks.flatMap((b) => b.elements || []).find((e) => e.type === "multi_static_select");
    assert.ok(select, "the picker is rendered for an admin");
    assert.equal(select.initial_options, undefined);
  }
  const all = buildChannelSettingsView({ ...base, runtime: { ...base.runtime, approvedEngines: null } }, { tab: "agent", c: "C1", u: "U1" }, everything);
  const select = all.blocks.flatMap((b) => b.elements || []).find((e) => e.type === "multi_static_select");
  assert.equal(select.initial_options.length, 1);
});
