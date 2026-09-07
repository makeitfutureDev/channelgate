// Read-only Channel Settings modal for Slack. The web admin conversation editor has the same
// four groups; this compact Block Kit view lets a channel manager inspect the live channel record
// without leaving the thread. Values are snapshots only: changes still go through the established
// admin UI, /model, /secrets, or gateway control tools and their approval boundaries.
import { MIN_MASKABLE_LENGTH } from "../config/channel-env.js";

export const CHANNEL_SETTINGS_ACTION_ID = "cg_channel_settings";
export const CHANNEL_SETTINGS_TAB_PREFIX = "cg_channel_settings_tab_";
export const CHANNEL_SETTINGS_ACTION_PATTERN = /^cg_channel_settings(?:$|_tab_(?:runtime|mcp|skills|secrets))$/;
export const CHANNEL_SETTINGS_TABS = Object.freeze(["runtime", "mcp", "skills", "secrets"]);
const EXPIRED = "This channel settings view expired. Open it again from a recent reply.";
const MAX_LIST_ITEMS = 30;

function plain(text) {
  return { type: "plain_text", text: String(text).slice(0, 3000), emoji: true };
}

function mrkdwn(text) {
  return { type: "mrkdwn", text: String(text).slice(0, 3000) };
}

function escapeMrkdwn(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function inlineCode(value) {
  return `\`${escapeMrkdwn(value || "—").replaceAll("`", "'")}\``;
}

function normalizeTab(tab) {
  const value = String(tab || "").toLowerCase();
  return CHANNEL_SETTINGS_TABS.includes(value) ? value : "runtime";
}

export function actionValue(op, extra = {}) {
  return JSON.stringify({ o: op, ...extra });
}

export function parseActionValue(raw) {
  try {
    const value = JSON.parse(String(raw || ""));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function settingsMetadata(state = {}) {
  return JSON.stringify({
    c: state.channelId,
    s: state.slug,
    t: state.threadTs || "",
    u: state.ownerId,
    p: normalizeTab(state.tab),
  });
}

export function parseSettingsMetadata(raw) {
  let value;
  try {
    value = JSON.parse(String(raw || ""));
  } catch {
    throw new Error(EXPIRED);
  }
  if (!value || typeof value !== "object" || !value.c || !value.s || !value.u) throw new Error(EXPIRED);
  return {
    channelId: String(value.c),
    slug: String(value.s),
    threadTs: String(value.t || ""),
    ownerId: String(value.u),
    tab: normalizeTab(value.p),
  };
}

export function maskedCredential(value) {
  const text = String(value || "");
  return {
    configured: Boolean(text),
    last4: text.length >= MIN_MASKABLE_LENGTH ? text.slice(-4) : "",
  };
}

function credentialLabel(value = {}) {
  if (!value.configured) return "not configured";
  return value.last4 ? `configured · ${inlineCode(`••••${value.last4}`)}` : "configured · tail hidden";
}

function names(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const label = typeof value === "string"
      ? value
      : value?.name || value?.serverName || value?.id || value?.namespace || "";
    const clean = String(label || "").trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out;
}

function listLabel(values = []) {
  const all = names(values);
  if (!all.length) return "_none_";
  const shown = all.slice(0, MAX_LIST_ITEMS).map(inlineCode).join(", ");
  return all.length > MAX_LIST_ITEMS ? `${shown}  _(+${all.length - MAX_LIST_ITEMS} more)_` : shown;
}

function fieldBlock(label, value) {
  return { type: "section", text: mrkdwn(`*${label}*\n${value}`) };
}

function runtimeBlocks(snapshot = {}) {
  const runtime = snapshot.runtime || {};
  const configuredEngine = runtime.configuredEngine
    ? inlineCode(runtime.configuredEngine)
    : `_inherits gateway default (${inlineCode(runtime.effectiveEngine || "unknown")})_`;
  const configuredModel = runtime.configuredModel
    ? inlineCode(runtime.configuredModel)
    : `_inherits ${runtime.gatewayModel ? `gateway default (${inlineCode(runtime.gatewayModel)})` : "the CLI default"}_`;
  const effort = runtime.configuredEffort ? inlineCode(runtime.configuredEffort) : "_engine default_";
  return [
    fieldBlock("Engine", configuredEngine),
    fieldBlock("Model", configuredModel),
    fieldBlock("Reasoning effort", effort),
  ];
}

function mcpBlocks(snapshot = {}) {
  const c = snapshot.connections || {};
  const cloud = snapshot.cloudMcp || {};
  const composio = c.composioMode === "sdk"
    ? `${inlineCode("SDK")} · ${c.composioSdkReady ? "organization identity is ready" : "organization API key or entitlement is missing"}`
    : `${credentialLabel(c.composioChannel)}${c.composioChannel?.configured
      ? " · channel credential wins"
      : c.noDefaultTokens
        ? " · organization fallback refused here"
        : c.composioOrg?.configured
          ? " · using organization default"
          : " · no shared fallback"}`;
  const toolbox = c.toolboxChannel?.configured
    ? `${credentialLabel(c.toolboxChannel)} · channel credential wins`
    : c.noDefaultTokens
      ? "not configured here · organization fallback refused"
      : c.toolboxOrg?.configured
        ? "not configured here · falls back per-user, then organization default"
        : "not configured here · may fall back to each user's credential";
  const make = c.makeToolboxUrl
    ? `${inlineCode(c.makeToolboxUrl)} · key ${credentialLabel(c.makeToolboxKey)}`
    : "not configured";
  return [
    { type: "header", text: plain("MCP connections") },
    fieldBlock(`Composio shared · ${c.composioMode === "sdk" ? "SDK mode" : "Personal mode"}`, composio),
    fieldBlock("Toolbox", toolbox),
    fieldBlock("Make MCP toolbox", make),
    { type: "divider" },
    { type: "header", text: plain("Cloud MCP") },
    fieldBlock("Claude · configured for this channel", listLabel(cloud.claude?.channel)),
    fieldBlock("Claude · inherited from organization", listLabel(cloud.claude?.organization)),
    fieldBlock("Codex · configured for this channel", listLabel(cloud.codex?.channel)),
    fieldBlock("Codex · inherited from organization", listLabel(cloud.codex?.organization)),
    { type: "context", elements: [mrkdwn("Gateway, Composio, Toolbox, and Make toolbox are injected separately from the Cloud MCP picker.")] },
  ];
}

function skillsBlocks(snapshot = {}) {
  const skills = snapshot.skills || {};
  return [
    fieldBlock("Skill template", skills.template ? inlineCode(skills.template) : "_none_"),
    fieldBlock("Additional channel skills", listLabel(skills.additional)),
    fieldBlock("Channel tier now", listLabel(skills.channel)),
    fieldBlock("Inherited from organization", listLabel(skills.organization)),
    fieldBlock("Effective shared grants", listLabel(skills.effective)),
    { type: "context", elements: [mrkdwn("Personal skill grants are user-specific, so they are not channel settings and are not included here.")] },
  ];
}

function secretLine(entry = {}) {
  const tail = entry.last4 ? inlineCode(`••••${entry.last4}`) : "set · tail hidden";
  const date = entry.setAt && !Number.isNaN(new Date(entry.setAt).getTime())
    ? new Date(entry.setAt).toISOString().slice(0, 10)
    : "";
  const trail = [entry.setBy ? `by ${escapeMrkdwn(entry.setBy)}` : "", date].filter(Boolean).join(" · ");
  const provider = entry.resolvable === false ? ` · ⚠️ provider ${inlineCode(entry.provider || "unknown")} unavailable` : "";
  return `*${escapeMrkdwn(entry.name || "unnamed")}* — ${tail}${trail ? ` · ${trail}` : ""}${provider}`;
}

function secretsBlocks(snapshot = {}) {
  const vars = Array.isArray(snapshot.secrets) ? snapshot.secrets : [];
  if (!vars.length) {
    return [{ type: "section", text: mrkdwn("_No environment secrets are configured for this channel._") }];
  }
  const shown = vars.slice(0, MAX_LIST_ITEMS);
  const blocks = shown.map((entry) => ({ type: "section", text: mrkdwn(secretLine(entry)) }));
  if (vars.length > shown.length) {
    blocks.push({ type: "context", elements: [mrkdwn(`_+${vars.length - shown.length} more variables. Open /secrets for the complete manager._`)] });
  }
  blocks.push({
    type: "context",
    elements: [mrkdwn("Values are write-only. This view shows names and, only for long locally stored values, the last four characters.")],
  });
  return blocks;
}

const TAB_LABELS = Object.freeze({
  runtime: "Engine & model",
  mcp: "MCP",
  skills: "Skills",
  secrets: "Secrets",
});

function tabButtons(state, active) {
  return {
    type: "actions",
    block_id: "cg_channel_settings_tabs",
    elements: CHANNEL_SETTINGS_TABS.map((tab) => ({
      type: "button",
      action_id: `${CHANNEL_SETTINGS_TAB_PREFIX}${tab}`,
      text: plain(TAB_LABELS[tab]),
      ...(tab === active ? { style: "primary" } : {}),
      value: actionValue("tab", { c: state.channelId, u: state.ownerId, p: tab }),
    })),
  };
}

export function buildChannelSettingsView(snapshot = {}, state = {}, { channelName = "", tab = state.tab } = {}) {
  const active = normalizeTab(tab);
  const content = active === "mcp"
    ? mcpBlocks(snapshot)
    : active === "skills"
      ? skillsBlocks(snapshot)
      : active === "secrets"
        ? secretsBlocks(snapshot)
        : runtimeBlocks(snapshot);
  return {
    type: "modal",
    callback_id: "cg_channel_settings_modal",
    private_metadata: settingsMetadata({ ...state, tab: active }),
    title: plain("Channel settings"),
    close: plain("Done"),
    blocks: [
      { type: "context", elements: [mrkdwn(`Read-only settings for *#${escapeMrkdwn(channelName || "this channel")}*. Only channel managers can open this view.`)] },
      tabButtons(state, active),
      { type: "divider" },
      ...content,
    ],
  };
}

export function buildChannelSettingsErrorView(message) {
  return {
    type: "modal",
    callback_id: "cg_channel_settings_error",
    title: plain("Channel settings"),
    close: plain("Close"),
    blocks: [{ type: "section", text: mrkdwn(`⚠️ ${escapeMrkdwn(message || "Something went wrong.")}`) }],
  };
}
