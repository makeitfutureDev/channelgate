// Native Slack manager for a channel's environment secrets (config/channel-env.js).
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

export const SECRETS_ACTION_ID = "cg_channel_secrets";
export const SECRETS_ADD_ACTION_ID = "cg_channel_secrets_add";
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
  return JSON.stringify({ c: state.channelId, s: state.slug, t: state.threadTs || "", u: state.ownerId, n: state.editName || "", ...(state.returnTo === "settings" ? { r: "settings" } : {}) });
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

export function buildSecretsView(vars = [], state = {}, { channelName = "", mayEdit = false, notice = "" } = {}) {
  const blocks = [];
  if (notice) blocks.push({ type: "section", text: mrkdwn(notice) });
  blocks.push({
    type: "context",
    elements: [mrkdwn(
      `Environment variables injected into every run in *#${channelName || "this channel"}* — this channel's own CLI logins. ` +
      `Values can never be read back here, or anywhere else. To replace one, set it again.`,
    )],
  });
  blocks.push({ type: "divider" });
  if (vars.length === 0) {
    blocks.push({ type: "section", text: mrkdwn("_No variables set. This channel uses whatever login the gateway host has._") });
  }
  for (const [index, entry] of vars.entries()) {
    blocks.push({
      type: "section",
      text: mrkdwn(describeSecret(entry)),
      ...(mayEdit
        ? {
            accessory: {
              type: "button",
              action_id: `${SECRETS_REMOVE_ACTION_PREFIX}${index}`,
              style: "danger",
              text: plain("Remove"),
              // Confirmation, because removal is silent until the next run fails somewhere else.
              confirm: {
                title: plain("Remove this variable?"),
                text: mrkdwn(`*${entry.name}* will stop being passed to runs in this channel. The value cannot be recovered — you would have to issue a new one.`),
                confirm: plain("Remove"),
                deny: plain("Keep"),
              },
              value: actionValue("remove", { c: state.channelId, u: state.ownerId, n: entry.name }),
            },
          }
        : {}),
    });
  }
  if (mayEdit) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "actions",
      elements: [{
        type: "button",
        style: "primary",
        action_id: SECRETS_ADD_ACTION_ID,
        text: plain("Add or update a variable"),
        value: actionValue("add", { c: state.channelId, u: state.ownerId }),
      }],
    });
  } else {
    blocks.push({ type: "context", elements: [mrkdwn("_You can see which variables exist, but only someone who can run commands in this channel may change them._")] });
  }
  return {
    type: "modal",
    callback_id: "cg_channel_secrets_modal",
    private_metadata: secretsMetadata(state),
    title: plain("Channel secrets"),
    close: plain("Done"),
    blocks,
  };
}

// The add/update form. `suggested` are the env names the catalog CLIs actually read
// (config/cli-catalog.js envKeys) — the difference between someone guessing "SUPABASE_TOKEN"
// and typing the name the CLI looks for.
export function buildSecretFormView(state = {}, { channelName = "", name = "", suggested = [] } = {}) {
  const hint = suggested.length
    ? `Names this channel's enabled integrations read: ${suggested.map((s) => `\`${s}\``).join(", ")}.`
    : "Use the exact variable name the CLI reads, e.g. `SUPABASE_ACCESS_TOKEN`.";
  return {
    type: "modal",
    callback_id: SECRETS_FORM_CALLBACK_ID,
    private_metadata: secretsMetadata({ ...state, editName: name }),
    title: plain(name ? "Update variable" : "Add variable"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      { type: "context", elements: [mrkdwn(`Stored for *#${channelName || "this channel"}* and passed to every run here. ${hint}`)] },
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
