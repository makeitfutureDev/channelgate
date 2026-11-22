// A channel's Approved harnesses list — which harnesses and licenses it may run on
// (`meta.approvedEngines`, Enterprise) — changed from chat. ONE implementation behind both chat
// surfaces of it: the `set_channel_approved_harnesses` / `get_channel_approved_harnesses` control
// tools (src/mcp/tools/channel-admin.js) and the typed `/harnesses` command (Slack's in-thread
// commands, and the Teams / Google Chat text controls). The Settings controls keep their own
// pickers, but every rule is the same function call: the Enterprise entitlement and the stored
// shape (assertApprovedEnginesUpdate), never a list that excludes the license the channel runs on
// (assertChannelEngineApproved), and one `channel_meta_changed` audit row naming the admin.
import { getChannelMeta, patchChannelMeta } from "../config/store.js";
import { logChannelPolicyChange } from "../config/channel-audit.js";
import { getEngine } from "../config/settings.js";
import { engineLabel, harnessOf, licenseLabel, listedEngineIds } from "../engines/registry.js";
import { HARNESS_IDS, harnessLabel } from "../engines/license-state.js";
import { assertApprovedEnginesUpdate, assertChannelEngineApproved, describeApprovedEngines, harnessPolicyEntry, licenseFitsConversation } from "./channel-engines.js";
import { effectiveMeta } from "./effective-meta.js";

// What a channel's approved list can hold, as Settings offers it: a whole harness (every license
// of it, including ones added later) or single licenses, each named with its harness.
// `meta` is the channel the list is for: a license limited to another conversation
// (engines/license-state.js) can never run here, so it is not something to approve here.
export function approvedHarnessOptions(meta = null) {
  return [
    ...HARNESS_IDS.map((harness) => ({ value: harnessPolicyEntry(harness), label: `${harnessLabel(harness)} (any license)` })),
    ...listedEngineIds().filter((id) => licenseFitsConversation(meta || {}, id)).map((id) => ({ value: id, label: harnessOf(id) ? `${harnessLabel(harnessOf(id))} · ${licenseLabel(id)}` : engineLabel(id) })),
  ];
}

// One submitted entry → the stored policy entry: its id, or a name that fits exactly one option
// (the full "Codex · Team seat", or the license's own name). Anything else is refused by the
// caller with the list, never guessed at — an approved list decides which account pays.
export function resolveApprovedHarnessEntry(entry, options = approvedHarnessOptions()) {
  const wanted = String(entry || "").trim().toLowerCase();
  if (!wanted) return "";
  const byValue = options.find((o) => o.value.toLowerCase() === wanted);
  if (byValue) return byValue.value;
  const byLabel = options.filter((o) => o.label.toLowerCase() === wanted || o.label.toLowerCase().split(" · ").slice(1).join(" · ") === wanted);
  return byLabel.length === 1 ? byLabel[0].value : "";
}

export const describeApprovedPolicy = (policy) =>
  (policy == null ? "every harness and license (no restriction)" : describeApprovedEngines(policy) || "nothing this gateway still offers");

const optionLines = (options) => options.map((o) => `- \`${o.value}\` — ${o.label}`);

// The typed command's argument → what the tool takes: "" (show), "all", or the entries. Entries
// are separated by commas or new lines, because a license name may hold spaces ("Team seat").
export function parseApprovedHarnessesArg(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (/^(all|any|none|unrestricted|everything)$/i.test(value)) return "all";
  return value.split(/[,\n]+/).map((part) => part.trim()).filter(Boolean);
}

// The read: the channel's current list for anyone allowed in it. Only an admin also sees every
// entry that can be approved — the gateway's whole license inventory is not a member's business.
export function describeChannelApprovedHarnesses(meta, { isAdmin = false, setHint = "set_channel_approved_harnesses" } = {}) {
  if (!meta) return "Channel isn't set up yet — send a normal message first.";
  const lines = [`Approved here: ${describeApprovedPolicy(meta.approvedEngines)}.`];
  if (isAdmin) lines.push(`Entries an admin can approve (pass them to ${setHint}):`, ...optionLines(approvedHarnessOptions(meta)));
  else lines.push("Only an organization admin can change this list.");
  return lines.join("\n");
}

/**
 * The write. `approved` is "all" (no restriction) or a list of entries, each an option value or a
 * name that fits exactly one option. Authorization is the caller's CURRENT admin check, passed in
 * as `isAdmin`; nothing is resolved or written without it. Returns `{ ok, text }`: the sentence to
 * answer with, already worded for the person who asked.
 */
export async function setChannelApprovedHarnesses({ slug, channelId = "", actor = "", source = "", isAdmin = false, approved }) {
  if (!isAdmin) return { ok: false, text: "Only organization admins can change this channel's approved harnesses." };
  const options = approvedHarnessOptions(slug ? await getChannelMeta(slug) : { channelId });
  let value = null;
  if (approved !== "all") {
    const entries = Array.isArray(approved) ? approved : [];
    if (!entries.length) return { ok: false, text: `Nothing was changed: name at least one entry, or \`all\`. Use one of:\n${optionLines(options).join("\n")}` };
    const unknown = [];
    value = [];
    for (const entry of entries) {
      const resolved = resolveApprovedHarnessEntry(entry, options);
      if (!resolved) unknown.push(entry);
      else if (!value.includes(resolved)) value.push(resolved);
    }
    if (unknown.length) {
      return { ok: false, text: `Nothing was changed: ${unknown.map((entry) => `"${entry}"`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not an entry I can approve (unknown, or a name more than one license carries). Use one of:\n${optionLines(options).join("\n")}` };
    }
  }
  let replaced = null;
  let next;
  try {
    next = await patchChannelMeta(slug, (meta) => {
      if (!meta) return null; // channel isn't set up yet — nothing written, nothing audited
      const approvedEngines = assertApprovedEnginesUpdate(meta, value);
      const after = { ...meta, approvedEngines };
      // Same rule as Settings: a list that excludes what the channel runs on would refuse its
      // very next turn, so the channel's license is changed first.
      assertChannelEngineApproved(after, effectiveMeta(after).engine || getEngine());
      replaced = meta;
      return { approvedEngines };
    });
  } catch (error) {
    if (error?.code === "channel_engine_not_approved") {
      return { ok: false, text: `Nothing was changed: this channel currently runs on ${engineLabel(error.details?.engine)}, which that list leaves out. Include it, or change the channel's license with /model first.` };
    }
    if (error?.statusCode) return { ok: false, text: `Nothing was changed: ${error.message}` };
    throw error;
  }
  if (!next) return { ok: false, text: "Channel isn't set up yet — send a normal message first." };
  await logChannelPolicyChange({ channelId, slug, actor, before: replaced, after: next, source });
  return { ok: true, text: `✅ Approved for this channel: ${describeApprovedPolicy(next.approvedEngines)}. Applies to future engine launches, including fallback.` };
}

// The typed `/harnesses [all | entry, entry…]` command, shared by every chat surface. Bare shows
// the list; anything else sets it (admin only). `isAdmin` must be the author's CURRENT role.
export async function runApprovedHarnessesCommand({ arg, meta, slug, channelId, actor, source, isAdmin }) {
  const parsed = parseApprovedHarnessesArg(arg);
  // The list as stored NOW, not as it was when the message arrived (another admin, or Settings).
  if (!parsed) return describeChannelApprovedHarnesses((await getChannelMeta(slug)) || meta, { isAdmin, setHint: "`/harnesses <entry>, <entry>…` or `/harnesses all`" });
  return (await setChannelApprovedHarnesses({ slug, channelId: channelId || meta?.channelId || "", actor, source, isAdmin, approved: parsed })).text;
}
