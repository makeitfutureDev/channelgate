// The ROI page: automations, API sources and skills side by side, each with the inputs a person
// gave it (minutes saved per successful run or use, hourly rate) and what they add up to in the
// window. Scope is the Automations board's own (automationBoard) for automations and API
// sources; skill uses follow the same conversations — every one for an admin, otherwise only
// those the viewer may open. Skill inputs and the default hourly rate are organization-wide, so
// only an admin sets them.
import { listChannels, getChannelMeta } from "../config/store.js";
import { logEvent } from "../util/logger.js";
import { automationBoard } from "./automations-view.js";
import { getSkill } from "./skills/catalog.js";
import { ROI_WINDOWS, roiOf, roiTotals, roiAssignments, setRoiAssignment, setDefaultRoiRate, roiMinutes, roiRate, skillUsesSince, skillUsageSlugsSince } from "./roi.js";

const isDM = (entry) => Boolean(entry?.isDM || entry?.type === "im" || /^D[A-Z0-9]+$/.test(entry?.channelId || ""));
const SKILL_SLUG = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

// The conversations (by slug) whose skill uses a non-admin viewer may count: the ones that had a
// skill use in the window and that the viewer may open — their own DM, never someone else's.
async function viewerSlugs(access, userId, sinceIso) {
  const used = new Set(skillUsageSlugsSince(sinceIso));
  const candidates = (await listChannels()).filter((entry) => used.has(entry.slug));
  await access.prefetch?.(candidates);
  const out = [];
  for (const entry of candidates) {
    if (!await access.allows(entry)) continue;
    if (isDM(entry)) {
      const meta = await getChannelMeta(entry.slug);
      if (meta?.dmUserId && meta.dmUserId !== userId) continue;
    }
    out.push(entry.slug);
  }
  return out;
}

const section = (items) => ({ totals: roiTotals(items.map((i) => i.roi)), items });
const byValue = (a, b) => b.roi.valueUsd - a.roi.valueUsd || b.roi.counted - a.roi.counted || a.title.localeCompare(b.title);

export async function roiOverview(access, userId, { days = 30, now = new Date(), adminConsole = false } = {}) {
  const board = await automationBoard(access, userId, { days: ROI_WINDOWS.includes(Number(days)) ? Number(days) : 30, now, adminConsole, windows: ROI_WINDOWS });
  const everything = adminConsole || access.user?.isAdmin === true;
  const row = (a) => ({ channelId: a.channelId, id: a.id, title: a.title, kind: a.kind, conversation: a.conversation, createdByName: a.createdByName, enabled: a.enabled, canEditRoi: a.canEditRoi, runs: a.stats.runs, roi: a.roi });
  const automations = board.automations.filter((a) => a.trigger !== "api").map(row).sort(byValue);
  const api = board.automations.filter((a) => a.trigger === "api").map(row).sort(byValue);
  const since = board.roi.since;
  const inputs = roiAssignments("skill");
  const uses = skillUsesSince(since, everything ? null : await viewerSlugs(access, userId, since));
  const seen = new Set(uses.map((u) => u.slug));
  // A skill with inputs but no use in the window still shows: its inputs are what an admin edits.
  if (everything) for (const key of inputs.keys()) { const slug = key.slice(1); if (!seen.has(slug)) uses.push({ slug, uses: 0, people: 0, channels: 0, lastUsedAt: null }); }
  const skills = uses.map((u) => {
    const input = inputs.get(`\n${u.slug}`) || { minutes: 0, rate: 0 };
    // The AI cost of a skill use is part of its run's cost and is not split out: no net, no multiple.
    return { id: u.slug, title: String(getSkill(u.slug)?.name || u.slug), kind: "Skill", people: u.people, channels: u.channels, lastUsedAt: u.lastUsedAt, canEditRoi: everything,
      runs: u.uses, roi: roiOf({ minutes: input.minutes, rate: input.rate, defaultRate: board.roi.defaultRate, counted: u.uses, costUsd: null }) };
  }).sort(byValue);
  const sections = { automations: section(automations), api: section(api), skills: section(skills) };
  const worked = [sections.automations.totals, sections.api.totals];
  const cost = worked.reduce((n, t) => n + t.costUsd, 0);
  const value = worked.reduce((n, t) => n + t.valueUsd, 0) + sections.skills.totals.valueUsd;
  const round = (n) => Math.round(n * 100) / 100;
  return {
    viewer: { isAdmin: everything, adminConsole, userId: userId || "" },
    windowDays: board.windowDays, generatedAt: board.generatedAt, since, limited: board.roi.limited, defaultRate: board.roi.defaultRate,
    // Value from all three; spend only where it is attributed (automations and API runs).
    totals: { hoursSaved: round(worked.reduce((n, t) => n + t.hoursSaved, 0) + sections.skills.totals.hoursSaved), valueUsd: round(value), costUsd: round(cost), netUsd: round(value - cost),
      multiple: cost > 0 ? Math.round(((value - cost) / cost) * 10) / 10 : null,
      configured: worked.reduce((n, t) => n + t.configured, 0) + sections.skills.totals.configured, items: worked.reduce((n, t) => n + t.items, 0) + sections.skills.totals.items },
    ...sections,
  };
}

const adminOnly = (access) => { if (access.user?.isAdmin !== true) throw Object.assign(new Error("Only an organization admin can change this."), { status: 403, userFacing: true }); };

export async function setSkillRoi(access, userId, body = {}) {
  adminOnly(access);
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  if (!SKILL_SLUG.test(slug)) throw Object.assign(new Error("Choose a skill."), { status: 400, userFacing: true });
  const input = { minutes: roiMinutes(body.minutesSaved), rate: roiRate(body.hourlyRate) };
  setRoiAssignment("skill", "", slug, input, userId);
  await logEvent("skill_roi_set", { skill: slug, by: String(userId || "").slice(0, 64), minutes: input.minutes, rate: input.rate }).catch(() => {});
  return { ok: true, minutesSaved: input.minutes, hourlyRate: input.rate };
}

export async function setDefaultRate(access, userId, body = {}) {
  adminOnly(access);
  const rate = setDefaultRoiRate(roiRate(body?.hourlyRate), userId);
  await logEvent("roi_default_rate_set", { by: String(userId || "").slice(0, 64), rate }).catch(() => {});
  return { ok: true, hourlyRate: rate };
}
