// Channel access editor. Personal admin status and gateway-wide settings are never writable here.
import { canManage, isAuthorized, PROFILE_FLAGS, channelProfile } from "../gateway/modes.js";

export const ACCESS_EDIT_ACTION_ID = "cg_channel_settings_access_edit";
export const ACCESS_CALLBACK_ID = "cg_channel_settings_access_form";
export const ACCESS_MODE_BLOCK_ID = "settings_access_mode";
const text = (value) => ({ type: "plain_text", text: value });
const option = (label, value) => ({ text: text(label), value });
const selects = {
  mode: [["Read-only", "read"], ["Worker", "worker"], ["Autonomous", "auto"]],
  access: [["Approved members", "approved"], ["Admins only", "admins"], ["Locked — named users only", "none"]],
  manageAccess: [["Org admins only", "admins"], ["Approved channel members", "members"], ["Named managers", "custom"]],
};
const labels = { mode: "Mode", access: "Who can use it here", manageAccess: "Who can manage this channel" };
const flags = [["Full access — permission bypass for admin authors", "adminMode"], ["Lean — bare model without skills or connectors", "cleanMode"], ["Network — tell the engine network use is allowed", "allowNetwork"]];

export function accessSettingsSnapshot(meta = {}) {
  return {
    mode: meta.autoMode ? "auto" : meta.allowBash ? "worker" : "read",
    adminMode: Boolean(meta.adminMode), cleanMode: Boolean(meta.cleanMode), allowNetwork: Boolean(meta.allowNetwork),
    access: meta.access || "approved", manageAccess: meta.manageAccess || "admins",
    allowedUsers: meta.allowedUsers || [], managers: meta.managers || [],
  };
}

export function assertAccessManager(meta, actor) {
  if (meta.isDM || !isAuthorized(meta, actor.authorId, false, actor) || !canManage(meta, actor)) {
    throw new Error("Only admins and current channel managers can change access settings.");
  }
}

export function buildAccessEditorView(meta, privateMetadata) {
  const current = accessSettingsSnapshot(meta);
  const flagOptions = flags.map(([label, value]) => option(label, value));
  const initialFlags = flagOptions.filter((entry) => current[entry.value]);
  return {
    type: "modal", callback_id: ACCESS_CALLBACK_ID, private_metadata: privateMetadata,
    title: text("Channel access"), submit: text("Save"), close: text("Cancel"),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "Changes apply to this channel's next runs. Full access bypasses permissions only for admin authors. If the operator enabled whole-home access, Full access also exposes the gateway home to this channel. Network is advisory; the container stays on its bridge network." } },
      ...Object.entries(selects).map(([key, choices]) => {
        const options = choices.map(([label, value]) => option(label, value));
        return { type: "input", block_id: `settings_access_${key}`, label: text(labels[key]), element: {
          type: "static_select", action_id: key, options,
          initial_option: options.find((entry) => entry.value === current[key]) || options[0],
        } };
      }),
      { type: "input", block_id: "settings_access_flags", optional: true, label: text("Special modes & network"), element: {
        type: "checkboxes", action_id: "flags", options: flagOptions,
        ...(initialFlags.length ? { initial_options: initialFlags } : {}),
      } },
      ...[["allowedUsers", "Guest access — named users"], ["managers", "Named managers (when selected above)"]].map(([key, label]) => ({
        type: "input", block_id: `settings_access_${key}`, optional: true, label: text(label),
        hint: text("Select current human members of this channel. Membership is checked when you save."),
        element: { type: "multi_users_select", action_id: key, max_selected_items: 100,
          ...(current[key].length ? { initial_users: current[key] } : {}),
        },
      })),
    ],
  };
}

export function readAccessForm(view = {}) {
  const values = view.state?.values || {};
  const form = {};
  for (const key of Object.keys(selects)) form[key] = values[`settings_access_${key}`]?.[key]?.selected_option?.value;
  const chosen = values.settings_access_flags?.flags?.selected_options;
  if (!Array.isArray(chosen)) throw new Error("Access form is incomplete. Reopen Settings and try again.");
  if (chosen.some((entry) => !flags.some(([, key]) => key === entry.value))) throw new Error("Unknown access option.");
  for (const [, key] of flags) form[key] = chosen.some((entry) => entry.value === key);
  for (const key of ["allowedUsers", "managers"]) {
    const selected = values[`settings_access_${key}`]?.[key];
    if (!selected || !Array.isArray(selected.selected_users)) throw new Error("Access form is incomplete. Reopen Settings and try again.");
    form[key] = selected.selected_users;
  }
  return form;
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
    ...PROFILE_FLAGS[form.mode], adminMode: form.adminMode, cleanMode: form.cleanMode,
    allowNetwork: form.allowNetwork, access: form.access, manageAccess: form.manageAccess,
    allowedUsers: [...new Set(form.allowedUsers)], managers: [...new Set(form.managers)],
  };
  patch.profile = Object.entries(PROFILE_FLAGS).find(([, preset]) => Object.keys(preset).every((key) => patch[key] === preset[key]))?.[0] || "custom";
  return patch;
}

export function accessSummary(meta) {
  const current = accessSettingsSnapshot(meta);
  return `*Mode:* ${channelProfile(meta)}\n*Full access:* ${current.adminMode ? "on" : "off"} · *Lean:* ${current.cleanMode ? "on" : "off"} · *Network:* ${current.allowNetwork ? "on" : "off"}\n*Who can use:* ${current.access} · *Who can manage:* ${current.manageAccess}\n*Named users:* ${current.allowedUsers.length} · *Named managers:* ${current.managers.length}`;
}
