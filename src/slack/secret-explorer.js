// Native Slack manager for the environment secrets a run receives, across all THREE scopes
// (config/scoped-env.js): the organization's, the viewer's own, and this conversation's.
//
// Deliberately a sibling of file-explorer.js, not a section of it: files are content, these are
// credentials, and the whole point of this surface is that it can LIST and WRITE but never READ.
// Every view below is built from the masked shape (name + last4 + who + when); a value exists in
// this module only for the few milliseconds between Slack handing us a submitted input and
// channel-env.js storing it. Nothing here ever renders one.
//
// Slack has no secure text input — a typed value travels through Slack's API like any other
// message. That is unavoidable for any in-chat secret entry, and it is exactly why the value is
// never echoed BACK: an un-echoed secret is exposed once, at entry; an echoed one is exposed on
// every render, to everyone who can screenshot the modal.
import { MIN_MASKABLE_LENGTH } from "../config/channel-env.js";

// The three scopes, in PRECEDENCE order — organization is the broadest and the most easily
// overridden, the conversation's own is the most specific and wins. The view renders them in this
// order so the list reads the way resolution works.
export const SECRET_SCOPES = Object.freeze(["organization", "personal", "channel"]);
// One letter per scope, so a row's action_id stays unique ACROSS scopes: Slack rejects a modal
// when any two controls share an id, and three lists can each have an index 0.
const SCOPE_LETTER = Object.freeze({ organization: "o", personal: "p", channel: "c" });
const LETTER_SCOPE = Object.freeze({ o: "organization", p: "personal", c: "channel" });
export function scopeFromActionId(actionId = "") {
  const suffix = String(actionId).slice(SECRETS_REMOVE_ACTION_PREFIX.length);
  return LETTER_SCOPE[suffix[0]] || "channel";
}
export function normalizeSecretScope(value) {
  return SECRET_SCOPES.includes(String(value)) ? String(value) : "channel";
}

export const SECRETS_ACTION_ID = "cg_channel_secrets";
export const SECRETS_ADD_ACTION_ID = "cg_channel_secrets_add";
export const SECRETS_ADD_ORG_ACTION_ID = "cg_channel_secrets_add_organization";
export const SECRETS_ADD_PERSONAL_ACTION_ID = "cg_channel_secrets_add_personal";
export const SECRETS_REFRESH_ACTION_ID = "cg_channel_secrets_refresh";
// Row buttons need per-view-unique action ids (Slack rejects a modal when any two controls share
// one), so removals are `cg_channel_secrets_remove_<row>` and the RegExp below catches them all.
export const SECRETS_REMOVE_ACTION_PREFIX = "cg_channel_secrets_remove_";
export const SECRETS_ACTION_PATTERN = /^cg_channel_secrets(?:$|_)/;
export const SECRETS_SHORTCUT_ID = "cg_manage_channel_secrets";
export const SECRETS_FORM_CALLBACK_ID = "cg_channel_secrets_form";
export const SECRETS_NAME_BLOCK_ID = "secret_name";
export const SECRETS_NAME_INPUT_ACTION_ID = "cg_channel_secrets_name_value";
export const SECRETS_VALUE_BLOCK_ID = "secret_value";
export const SECRETS_VALUE_INPUT_ACTION_ID = "cg_channel_secrets_value_value";
const EXPIRED = "This secrets manager expired. Open it again with `/secrets`.";

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

export function secretsMetadata(state = {}) {
  return JSON.stringify({
    c: state.channelId, s: state.slug, t: state.threadTs || "", u: state.ownerId, n: state.editName || "",
    // Which scope a submitted form writes into. Absent = the channel's, so a form opened by an
    // older build still means what it meant then.
    ...(state.scope && state.scope !== "channel" ? { p: SCOPE_LETTER[state.scope] } : {}),
    ...(state.returnTo === "settings" ? { r: "settings" } : {}),
  });
}

export function parseSecretsMetadata(raw) {
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
    editName: String(value.n || ""),
    scope: LETTER_SCOPE[value.p] || "channel",
    ...(value.r === "settings" ? { returnTo: "settings" } : {}),
  };
}

function plain(text) {
  return { type: "plain_text", text: String(text).slice(0, 3000), emoji: true };
}

function mrkdwn(text) {
  return { type: "mrkdwn", text: String(text).slice(0, 3000) };
}

// "•••• 4f2a" for a value long enough to afford a tail, "•••••••" for one that isn't — four
// characters of a short secret is a third of it.
export function maskLabel(entry = {}) {
  return entry.last4 ? `\`••••${entry.last4}\`` : `\`•••••••\` _(too short to show a tail)_`;
}

function whenLabel(setAt) {
  if (!setAt) return "";
  const date = new Date(setAt);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export function describeSecret(entry = {}) {
  const who = entry.setBy ? `by ${entry.setBy}` : "";
  const when = whenLabel(entry.setAt);
  const trail = [who, when].filter(Boolean).join(" · ");
  // An entry whose provider this build has no resolver for is SHOWN, not hidden — it is why runs
  // in this channel are failing, and hiding it would leave that unexplained.
  const unresolvable = entry.resolvable === false ? `  ·  ⚠️ provider \`${entry.provider}\` can't be resolved by this build — runs here will fail until it is removed or the build supports it` : "";
  return `*${entry.name}* — ${maskLabel(entry)}${trail ? `  ·  set ${trail}` : ""}${unresolvable}`;
}

// Per-scope copy. Kept in one table so a scope cannot ship with a heading that says one thing and
// a removal confirmation that says another.
const SCOPE_COPY = Object.freeze({
  organization: {
    heading: "🏢 Organization — every conversation",
    blurb: "Shared by every conversation in this deployment. Admins only.",
    empty: "_No organization variables._",
    emptyLocked: "_No organization variables._",
    addLabel: "Add organization variable",
    locked: "_Only organization admins can change these._",
    removeText: (name) => `*${name}* will stop being passed to runs in EVERY conversation. The value cannot be recovered — you would have to issue a new one.`,
  },
  personal: {
    heading: "👤 Yours — only runs you author",
    blurb: "Injected only into runs you author, in any conversation. Nobody else's turn receives them, and nobody else can see them here.",
    empty: "_You have no personal variables._",
    emptyLocked: "_You have no personal variables._",
    addLabel: "Add personal variable",
    locked: "",
    removeText: (name) => `*${name}* will stop being passed to runs you author, everywhere. The value cannot be recovered — you would have to issue a new one.`,
  },
  channel: {
    heading: "💬 This conversation",
    blurb: "This conversation's own CLI logins. Overrides a personal or organization variable of the same name.",
    empty: "_No variables set. This conversation uses whatever login the gateway host has, plus any organization variable above._",
    emptyLocked: "_No variables set._",
    addLabel: "Add or update a variable",
    locked: "_You can see which variables exist, but only someone who can run commands in this channel may change them._",
    removeText: (name) => `*${name}* will stop being passed to runs in this channel. The value cannot be recovered — you would have to issue a new one.`,
  },
});

function scopeBlocks(scope, vars, state, mayEdit) {
  const copy = SCOPE_COPY[scope];
  const blocks = [
    { type: "divider" },
    { type: "section", text: mrkdwn(`*${copy.heading}*`) },
    { type: "context", elements: [mrkdwn(copy.blurb)] },
  ];
  if (vars.length === 0) blocks.push({ type: "section", text: mrkdwn(mayEdit ? copy.empty : copy.emptyLocked) });
  for (const [index, entry] of vars.entries()) {
    blocks.push({
      type: "section",
      text: mrkdwn(describeSecret(entry)),
      ...(mayEdit
        ? {
            accessory: {
              type: "button",
              // The scope letter keeps this unique across the three lists in one view.
              action_id: `${SECRETS_REMOVE_ACTION_PREFIX}${SCOPE_LETTER[scope]}${index}`,
              style: "danger",
              text: plain("Remove"),
              // Confirmation, because removal is silent until the next run fails somewhere else.
              confirm: {
                title: plain("Remove this variable?"),
                text: mrkdwn(copy.removeText(entry.name)),
                confirm: plain("Remove"),
                deny: plain("Keep"),
              },
              value: actionValue("remove", { c: state.channelId, u: state.ownerId, n: entry.name, s: SCOPE_LETTER[scope] }),
            },
          }
        : {}),
    });
  }
  if (mayEdit) {
    blocks.push({
      type: "actions",
      elements: [{
        type: "button",
        ...(scope === "channel" ? { style: "primary" } : {}),
        action_id: scope === "organization" ? SECRETS_ADD_ORG_ACTION_ID : scope === "personal" ? SECRETS_ADD_PERSONAL_ACTION_ID : SECRETS_ADD_ACTION_ID,
        text: plain(copy.addLabel),
        value: actionValue("add", { c: state.channelId, u: state.ownerId, s: SCOPE_LETTER[scope] }),
      }],
    });
  } else if (copy.locked) {
    blocks.push({ type: "context", elements: [mrkdwn(copy.locked)] });
  }
  return blocks;
}

// All three scopes in one view, in resolution order. `scopes.personal` is always the VIEWER's own
// — the modal is bound to one owner and refuses a different clicker, so there is no way to render
// somebody else's here.
export function buildSecretsView(scopes = {}, state = {}, { channelName = "", mayEdit = false, canEditOrg = false, notice = "" } = {}) {
  const lists = {
    organization: Array.isArray(scopes.organization) ? scopes.organization : [],
    personal: Array.isArray(scopes.personal) ? scopes.personal : [],
    // A single array is the pre-three-scope call shape: it meant the channel's variables.
    channel: Array.isArray(scopes) ? scopes : Array.isArray(scopes.channel) ? scopes.channel : [],
  };
  const editable = { organization: Boolean(canEditOrg), personal: true, channel: Boolean(mayEdit) };
  const blocks = [];
  if (notice) blocks.push({ type: "section", text: mrkdwn(notice) });
  blocks.push({
    type: "context",
    elements: [mrkdwn(
      `Environment variables injected into runs in *#${channelName || "this channel"}*, from three scopes. ` +
      `Where the same name exists in more than one, *this conversation's wins*, then yours, then the organization's. ` +
      `Values can never be read back here, or anywhere else. To replace one, set it again.`,
    )],
  });
  for (const scope of SECRET_SCOPES) blocks.push(...scopeBlocks(scope, lists[scope], state, editable[scope]));
  return {
    type: "modal",
    callback_id: "cg_channel_secrets_modal",
    private_metadata: secretsMetadata(state),
    title: plain("Secrets"),
    close: plain("Done"),
    blocks,
  };
}

// The add/update form. `suggested` are the env names the catalog CLIs actually read
// (config/cli-catalog.js envKeys) — the difference between someone guessing "SUPABASE_TOKEN"
// and typing the name the CLI looks for.
export function buildSecretFormView(state = {}, { channelName = "", name = "", suggested = [], scope = "channel" } = {}) {
  const where = normalizeSecretScope(scope);
  const hint = suggested.length
    ? `Names this channel's enabled integrations read: ${suggested.map((s) => `\`${s}\``).join(", ")}.`
    : "Use the exact variable name the CLI reads, e.g. `SUPABASE_ACCESS_TOKEN`.";
  // Say plainly who will receive it — the three scopes look identical in this form otherwise, and
  // the difference between "my token" and "every conversation's token" is the whole decision.
  const reach = where === "organization"
    ? "Stored for the *whole organization* and passed to every run in *every conversation*."
    : where === "personal"
      ? "Stored for *you* and passed only to runs *you* author, in any conversation."
      : `Stored for *#${channelName || "this channel"}* and passed to every run here.`;
  return {
    type: "modal",
    callback_id: SECRETS_FORM_CALLBACK_ID,
    private_metadata: secretsMetadata({ ...state, editName: name, scope: where }),
    title: plain(name ? "Update variable" : "Add variable"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      { type: "context", elements: [mrkdwn(`${reach} ${hint}`)] },
      {
        type: "input",
        block_id: SECRETS_NAME_BLOCK_ID,
        label: plain("Name"),
        element: {
          type: "plain_text_input",
          action_id: SECRETS_NAME_INPUT_ACTION_ID,
          initial_value: name || "",
          placeholder: plain("SUPABASE_ACCESS_TOKEN"),
          max_length: 64,
        },
      },
      {
        type: "input",
        block_id: SECRETS_VALUE_BLOCK_ID,
        label: plain("Value"),
        // Never pre-filled, even when updating: there is nothing to pre-fill it WITH, and a form
        // that appears to hold the old value invites someone to read it out of the box.
        element: {
          type: "plain_text_input",
          action_id: SECRETS_VALUE_INPUT_ACTION_ID,
          placeholder: plain("Paste the token — it is stored, never shown again"),
          max_length: 3000,
        },
        hint: plain(`Values shorter than ${MIN_MASKABLE_LENGTH} characters are listed without a visible tail.`),
      },
    ],
  };
}

export function buildSecretsErrorView(message) {
  return {
    type: "modal",
    callback_id: "cg_channel_secrets_error",
    title: plain("Channel secrets"),
    close: plain("Close"),
    blocks: [{ type: "section", text: mrkdwn(`⚠️ ${String(message || "Something went wrong.")}`) }],
  };
}

// Pull the submitted pair out of a view_submission payload. Returns the raw value — the ONLY place
// in this module that touches one, and it is handed straight to channel-env.js by the caller.
export function readSecretForm(view = {}) {
  const values = view?.state?.values || {};
  return {
    name: String(values[SECRETS_NAME_BLOCK_ID]?.[SECRETS_NAME_INPUT_ACTION_ID]?.value || "").trim(),
    value: String(values[SECRETS_VALUE_BLOCK_ID]?.[SECRETS_VALUE_INPUT_ACTION_ID]?.value || "").trim(),
  };
}
