// Skill usage capture and reporting. Claude fires a skill through its `Skill` tool, so a
// `tool_use` event named Skill is an EXACT signal; Codex has no such tool — it reads the
// SKILL.md file with a shell or file tool — so a read of `…/skills/<slug>/SKILL.md` is an
// INFERRED signal and is labelled that way everywhere it is shown. One row per (run, skill,
// signal); the recorder dedupes inside a run. Nothing here stores prompt text or skill content.
import { recordSkillUsage, getSkill, usageSummary, usageByChannel, effectiveRevisionFor } from "./catalog.js";
import { resolveSkillProfile } from "./resolve.js";

// `.claude/skills/<slug>/SKILL.md`, `.agents/skills/<slug>/SKILL.md`, or a plugin's
// `…/skills/<slug>/SKILL.md` — inside a path, a shell command, or a quoted argument.
const SKILL_FILE_RE = /(?:^|[\s"'`(=:/])skills\/([A-Za-z0-9][A-Za-z0-9._-]{0,119})\/SKILL\.md(?![A-Za-z0-9])/i;

export function skillSlugFromText(text) {
  const m = SKILL_FILE_RE.exec(String(text ?? ""));
  return m ? m[1] : "";
}

// Build a per-run observer. Feed it every engine event; it records catalog skills as they are
// used. Unknown names (a project-owned skill that is not in the catalog) are recorded by name so
// the report can still show them, with no skill/revision id.
export function createSkillUsageRecorder({
  channelSlug = "",
  conversationId = "",
  userId = "",
  engine = "",
  sessionId = "",
  runId = "",
  origin = "",
  record = recordSkillUsage,
  lookup = getSkill,
  revisionFor = effectiveRevisionFor,
} = {}) {
  const seen = new Map(); // lower-case slug → strongest signal recorded this run

  function note(nameOrSlug, signal) {
    const raw = String(nameOrSlug || "").trim();
    if (!raw) return;
    let skill = null;
    try {
      skill = lookup(raw);
    } catch {
      skill = null;
    }
    const slug = skill?.slug || raw;
    const key = slug.toLowerCase();
    const prior = seen.get(key);
    if (prior === "exact" || (prior === "inferred" && signal === "inferred")) return;
    seen.set(key, signal);
    let revisionId = null;
    if (skill) {
      try {
        revisionId = revisionFor(skill)?.id ?? null;
      } catch {
        revisionId = null;
      }
    }
    try {
      record({ slug, skillId: skill?.id ?? null, revisionId, channelSlug, conversationId, userId, engine, sessionId, runId, origin, signal });
    } catch {
      /* usage capture must never break a run */
    }
  }

  return {
    onEvent(event) {
      if (!event || event.kind !== "tool_use") return;
      if (event.name === "Skill") {
        note(event.target || event.skill || "", "exact");
        return;
      }
      const slug = skillSlugFromText([event.path, event.target, event.name].filter(Boolean).join(" "));
      if (slug) note(slug, "inferred");
    },
    seen() {
      return new Map(seen);
    },
  };
}

// The report a channel (or the whole gateway) asks for: what fired, how often, with what
// confidence, and — the more useful half — which granted skills never fired at all.
export function skillUsageReport({ channelSlug = "", days = 30, grants = null, limit = 200 } = {}) {
  const d = Math.max(1, Math.min(365, Number(days) || 30));
  const since = new Date(Date.now() - d * 86400000).toISOString();
  const rows = usageSummary({ channelSlug, since, limit });
  const used = rows.map((r) => {
    const skill = getSkill(r.slug);
    return {
      slug: r.slug,
      name: skill?.name || r.slug,
      inCatalog: Boolean(skill),
      exact: r.exact,
      inferred: r.inferred,
      total: r.total,
      lastTs: r.lastTs,
      users: r.users,
      channels: r.channels,
      byEngine: r.byEngine,
      confidence: r.exact > 0 ? "exact" : "inferred",
    };
  });
  let neverUsed = [];
  let profile = null;
  if (Array.isArray(grants)) {
    profile = resolveSkillProfile(grants);
    const fired = new Set(used.map((u) => u.slug.toLowerCase()));
    neverUsed = profile.active.filter((e) => !fired.has(e.slug.toLowerCase())).map((e) => ({ slug: e.slug, name: e.name, via: e.via }));
  }
  return {
    since,
    days: d,
    channelSlug,
    used,
    channels: usageByChannel({ channelSlug, since, limit }),
    neverUsed,
    notes: [
      "exact = Claude's Skill tool fired the skill; inferred = a Codex (or shell) read of the skill's SKILL.md — best effort, may miss uses.",
    ],
    ...(profile ? { contextTokens: profile.contextTokens } : {}),
  };
}
