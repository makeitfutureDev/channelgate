// The Activity dashboard's Skills page: which conversations a viewer may configure (the same rule
// as the Automations page — accessContext().allows, and only the viewer's OWN direct messages),
// the skill rows of one of them, and saving its direct grants. The rows and the save are the ones
// Slack Settings → Skills uses (skills/channel-picker.js), so both surfaces admit exactly the same
// people and skills. "Only me" is the viewer's personal tier (user-settings.js), which follows them
// into every conversation.
import { listChannels, getChannelMeta, patchChannelMeta } from "../config/store.js";
import { getOrgAccessGrants } from "../config/settings.js";
import { logChannelPolicyChange } from "../config/channel-audit.js";
import { platformOfConversation } from "../platforms/ids.js";
import { activityChannelName } from "../slack/home-threads.js";
import { logEvent } from "../util/logger.js";
import { sharedSkillGrants } from "./access-grants.js";
import { checkedChannel } from "./automations-view.js";
import { effectiveMeta } from "./effective-meta.js";
import { ensureChannelFolder } from "./folders.js";
import { getSkill } from "./skills/catalog.js";
import { applyChannelSkillSelection, channelSkillRows, skillSelectionDiff } from "./skills/channel-picker.js";
import { channelSkillGrants, templateOfMeta } from "./skills/templates.js";
import { UserSettingsError, personalSkillPicker, savePersonalSkills } from "./user-settings.js";

export const PERSONAL_SKILLS_ID = "me";
const isDM = (entry) => Boolean(entry?.isDM || entry?.type === "im" || /^D[A-Z0-9]+$/.test(entry?.channelId || ""));
const MAX_SELECTED = 500;

/**
 * A DM following an organization DM template (user/admin) takes its skills FROM the template
 * (effective-meta.js), so a direct edit would be a silent no-op. The first skill edit detaches it
 * to "custom" with the template's current values, exactly like Slack's DM mode switch does.
 */
export async function detachDmTemplateForSkills(entry, actor, source) {
  let before = null;
  const after = await patchChannelMeta(entry.slug, (current) => {
    if (!current?.isDM || current.workspaceLink || !["user", "admin"].includes(current.template)) return null;
    before = current;
    return { ...effectiveMeta(current), template: "custom" };
  });
  if (after && before) await logChannelPolicyChange({ channelId: entry.channelId, slug: entry.slug, actor, before, after, source });
  return after;
}

/** Every Slack conversation the viewer may configure: "Only me", their own DM, then channels. */
export async function skillChannels(access, userId) {
  const rows = [];
  const entries = (await listChannels()).filter((entry) => platformOfConversation(entry.channelId) === "slack");
  // Membership checks for private conversations are Slack calls: a few at a time.
  for (let i = 0; i < entries.length; i += 8) {
    const batch = await Promise.all(entries.slice(i, i + 8).map(async (entry) => {
      if (!await access.allows(entry)) return null;
      const meta = await getChannelMeta(entry.slug);
      const dm = isDM(entry);
      if (dm && meta?.dmUserId && meta.dmUserId !== userId) return null; // only the viewer's OWN DM
      const effective = effectiveMeta({ ...meta, channelId: entry.channelId });
      const name = dm ? "Your direct messages" : `#${String(await activityChannelName(entry)).replace(/^#+/, "")}`;
      return { channelId: entry.channelId, name, personal: dm, count: channelSkillGrants(effective).length, linked: Boolean(meta?.workspaceLink) };
    }));
    rows.push(...batch.filter(Boolean));
  }
  rows.sort((a, b) => Number(b.personal) - Number(a.personal) || a.name.localeCompare(b.name));
  const mine = await personalSkillPicker(userId, access.user?.isAdmin === true).catch(() => ({ selected: [] }));
  return [{ channelId: PERSONAL_SKILLS_ID, name: "Only me — every conversation", personal: true, count: mine.selected.length, linked: false }, ...rows];
}

function sourceOf(row) {
  if (row.direct) return "channel";
  if (row.inherited) return "organization";
  if (row.template) return "template";
  if (row.scoped) return "repository";
  return "";
}

/** The rows the page renders for one conversation the viewer may open (checkedChannel). */
export async function channelSkillsView(access, userId, entry) {
  const stored = (await getChannelMeta(entry.slug)) || {};
  const meta = { ...effectiveMeta(stored), channelId: entry.channelId };
  const userIsAdmin = access.user?.isAdmin === true;
  if (stored.workspaceLink) {
    // A linked conversation shares the source's setup: its skills are edited there.
    return { kind: "channel", editable: false, linked: { name: String(stored.workspaceLink.name || stored.workspaceLink.slug || "another conversation") }, skills: [] };
  }
  const template = templateOfMeta(meta);
  const organization = getOrgAccessGrants().skills || [];
  const notLoaded = sharedSkillGrants({ organization, channel: channelSkillGrants(meta), lookupSkill: getSkill }).skipped.map((item) => item.name);
  return {
    kind: "channel", editable: true, linked: null,
    template: template ? String(template.name || template.slug) : "",
    dmTemplate: Boolean(stored.isDM && ["user", "admin"].includes(stored.template)),
    notLoaded,
    skills: channelSkillRows(meta, { userId, userIsAdmin }).map((row) => ({
      key: row.key, name: row.name, description: String(row.description || "").slice(0, 600),
      selected: Boolean(row.active), locked: Boolean(row.active && !row.direct), source: sourceOf(row),
    })),
  };
}

export async function personalSkillsView(userId, isAdmin) {
  const picker = await personalSkillPicker(userId, isAdmin);
  const mine = new Set(picker.selected.map((slug) => slug.toLowerCase()));
  return {
    kind: "personal", editable: true, linked: null, template: "", notLoaded: picker.foreign,
    skills: picker.options.map((option) => ({ key: option.key, name: option.label, description: String(option.description || "").slice(0, 600),
      selected: mine.has(option.key.toLowerCase()), locked: false, source: mine.has(option.key.toLowerCase()) ? "personal" : "" }))
      .sort((a, b) => Number(b.selected) - Number(a.selected) || a.name.localeCompare(b.name)),
  };
}

const refuse = (message, status = 400) => Object.assign(new Error(message), { status, userFacing: true });

/**
 * Save the picked direct grants of one conversation (or the viewer's own tier for "me").
 * `selected` lists the skills that should be on and directly added; locked rows (organization,
 * template) are ignored. `authorize` re-checks the session right before writing.
 */
export async function saveSkillSelection(access, userId, channelId, selected, { authorize = async () => {} } = {}) {
  if (!Array.isArray(selected) || selected.length > MAX_SELECTED || !selected.every((slug) => typeof slug === "string" && slug.length <= 200)) throw refuse("Choose skills from the list.");
  const isAdmin = access.user?.isAdmin === true;
  if (channelId === PERSONAL_SKILLS_ID) {
    const { added, removed } = await savePersonalSkills(userId, isAdmin, selected, { authorize, via: "activity_skills" }).catch((error) => { throw error instanceof UserSettingsError ? refuse(error.message, error.status) : error; });
    return { added, removed };
  }
  const entry = await checkedChannel(access, userId, channelId);
  let meta = await getChannelMeta(entry.slug);
  if (!meta) throw refuse("This conversation isn't registered with the gateway yet.", 404);
  if (meta.workspaceLink) throw refuse("This conversation shares another conversation's setup. Change its skills there.", 409);
  const view = channelSkillRows({ ...effectiveMeta(meta), channelId: entry.channelId }, { userId, userIsAdmin: isAdmin });
  const locked = new Set(view.filter((row) => row.active && !row.direct).map((row) => row.key.toLowerCase()));
  const picked = [...new Map(selected.filter((slug) => !locked.has(slug.toLowerCase())).map((slug) => [slug.toLowerCase(), slug])).values()];
  const pending = skillSelectionDiff(effectiveMeta(meta).skills || [], picked);
  if (!pending.added.length && !pending.removed.length) return { added: [], removed: [] };
  await authorize();
  const detached = await detachDmTemplateForSkills(entry, userId, "activity-skills");
  if (detached) meta = detached;
  let result;
  try {
    result = await applyChannelSkillSelection(entry.slug, { ...meta, channelId: entry.channelId }, picked, { userId, userIsAdmin: isAdmin });
  } catch (error) { throw error.refused ? refuse(error.message) : error; }
  const after = await getChannelMeta(entry.slug);
  await ensureChannelFolder(entry.slug, effectiveMeta(after));
  if (result.added.length) await logEvent("skill_granted", { channel: entry.channelId, slug: entry.slug, skills: result.added, author: userId, via: "activity_skills" });
  if (result.removed.length) await logEvent("skill_revoked", { channel: entry.channelId, slug: entry.slug, skills: result.removed, author: userId, via: "activity_skills" });
  return result;
}
