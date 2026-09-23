// Channel access editor. Personal admin status and gateway-wide settings are never writable here.
import { canManage, isAuthorized, modeSettingsPatch, channelMode } from "../gateway/modes.js";

// Retained only for a Settings view opened before the access controls moved onto the page itself:
// the button repaints instead of pushing an editor, and a form left open answers with where its
// controls went. Nothing builds either of them any more.
export const ACCESS_EDIT_ACTION_ID = "cg_channel_settings_access_edit";
export const ACCESS_CALLBACK_ID = "cg_channel_settings_access_form";
// Every access control now lives on General Settings and saves on its own, so each one needs an
// action id the settings handler can route (CHANNEL_SETTINGS_ACTION_PATTERN matches the prefix).
export const ACCESS_FIELD_PREFIX = "cg_channel_settings_access_field_";
const selects = {
  mode: [["Read-only", "read"], ["Worker", "worker"], ["Admin (full access)", "admin"]],
  access: [["Approved members", "approved"], ["Admins only", "admins"], ["Locked — named users only", "none"]],
  manageAccess: [["Org admins only", "admins"], ["Approved channel members", "members"], ["Named managers", "custom"]],
};
const labels = { mode: "Mode", access: "Who can use it here", manageAccess: "Who can manage this channel" };
const flags = [["Auto — automatically approve tool requests", "autoMode"], ["Lean — bare model without skills or connectors", "cleanMode"], ["Network — tell the engine network use is allowed", "allowNetwork"]];
const userLists = [["allowedUsers", "Guest access — named users"], ["managers", "Named managers (when selected above)"]];

// The catalogs the Settings page renders its rows from. Exported rather than duplicated there so
// the options a user is offered and the values accessSettingsPatch accepts can never drift.
export const ACCESS_SELECTS = Object.freeze(Object.fromEntries(
  Object.entries(selects).map(([field, choices]) => [field, Object.freeze(choices.map(([label, value]) => Object.freeze({ label, value })))]),
));
export const ACCESS_FLAGS = Object.freeze(flags.map(([label, key]) => Object.freeze({ label, key })));
export const ACCESS_USER_LISTS = Object.freeze(userLists.map(([field, label]) => Object.freeze({ field, label })));
export const ACCESS_LABELS = Object.freeze({ ...labels });
export const ACCESS_FIELDS = Object.freeze([...Object.keys(selects), "flags", ...userLists.map(([field]) => field)]);

// Which access control dispatched, or "" for anything else on the page.
export function accessFieldTarget(actionId) {
  const id = String(actionId || "");
  if (!id.startsWith(ACCESS_FIELD_PREFIX)) return "";
  const field = id.slice(ACCESS_FIELD_PREFIX.length);
  return ACCESS_FIELDS.includes(field) ? field : "";
}

// One control's payload as the form fragment accessSettingsPatch validates. Only the field that
// dispatched is read: the rest of the form comes from the stored record, so a control repainted
// from a stale view cannot resubmit its own stale neighbours. The checkbox group reports its WHOLE
// selection, which is what makes an unchecked box a false rather than a missing key.
export function readAccessFieldValue(field, action = {}) {
  if (Object.hasOwn(selects, field)) {
    const value = action?.selected_option?.value;
    if (!selects[field].some(([, choice]) => choice === value)) throw new Error(`Invalid ${labels[field]}.`);
    return { [field]: value };
  }
  if (field === "flags") {
    const chosen = action?.selected_options;
    if (!Array.isArray(chosen)) throw new Error("Access option is incomplete. Reopen Settings and try again.");
    if (chosen.some((entry) => !flags.some(([, key]) => key === entry.value))) throw new Error("Unknown access option.");
    return Object.fromEntries(flags.map(([, key]) => [key, chosen.some((entry) => entry.value === key)]));
  }
  if (userLists.some(([name]) => name === field)) {
    const selected = action?.selected_users;
    if (!Array.isArray(selected)) throw new Error("Access option is incomplete. Reopen Settings and try again.");
    return { [field]: selected };
  }
  throw new Error("Unknown access control.");
}

export function accessSettingsSnapshot(meta = {}) {
  return {
    mode: channelMode(meta),
    autoMode: Boolean(meta.autoMode), cleanMode: Boolean(meta.cleanMode), allowNetwork: Boolean(meta.allowNetwork),
    access: meta.access || "approved", manageAccess: meta.manageAccess || "admins",
    allowedUsers: meta.allowedUsers || [], managers: meta.managers || [],
  };
}

export function assertAccessManager(meta, actor) {
  if (meta.isDM || !isAuthorized(meta, actor.authorId, false, actor) || !canManage(meta, actor)) {
    throw new Error("Only admins and current channel managers can change access settings.");
  }
}

// Validate both UI values and the latest policy inside the metadata transaction. A stale editor
// cannot restore its own revoked management grant or overwrite unrelated channel settings.
export function accessSettingsPatch(meta, form, actor) {
  assertAccessManager(meta, actor);
  for (const [key, choices] of Object.entries(selects)) {
    if (!choices.some(([, value]) => form[key] === value)) throw new Error(`Invalid ${labels[key]}.`);
  }
  for (const [, key] of flags) if (typeof form[key] !== "boolean") throw new Error("Invalid access option.");
  for (const key of ["allowedUsers", "managers"]) {
    if (!Array.isArray(form[key]) || form[key].length > 100 || form[key].some((id) => typeof id !== "string" || !/^[UW][A-Z0-9]+$/.test(id))) {
      throw new Error("Choose up to 100 valid users per list.");
    }
  }
  const patch = {
    ...modeSettingsPatch(meta, { mode: form.mode, autoMode: form.autoMode, cleanMode: form.cleanMode }, { canEnableAdmin: true }),
    allowNetwork: form.allowNetwork, access: form.access, manageAccess: form.manageAccess,
    allowedUsers: [...new Set(form.allowedUsers)], managers: [...new Set(form.managers)],
  };
  return patch;
}
