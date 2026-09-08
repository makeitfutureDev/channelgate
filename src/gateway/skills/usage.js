// Skill usage capture and reporting. Claude fires a skill through its `Skill` tool, so a
// `tool_use` event named Skill is an EXACT signal; Codex has no such tool — it reads the
// SKILL.md file with a shell or file tool — so a read of `…/skills/<slug>/SKILL.md` is an
// INFERRED signal and is labelled that way everywhere it is shown. One row per (run, skill,
// signal); the recorder dedupes inside a run. Nothing here stores prompt text or skill content.
import { recordSkillUsage, getSkill, usageSummary, usageByChannel, usageByAuthor, effectiveRevisionFor } from "./catalog.js";
import { resolveSkillProfile } from "./resolve.js";

// `.claude/skills/<slug>/SKILL.md`, `.agents/skills/<slug>/SKILL.md`, or a plugin's
// `…/skills/<slug>/SKILL.md` — inside a path, a shell command, or a quoted argument. The
// lookbehind is what keeps `myskills/…` and `agent-skills/…` out while still accepting every
// separator a shell puts in front of a path (`/`, a space, a quote, `=`, `(`, `;`, `&&`, `|`, `,`).
const SKILL_FILE_RE = /(?<![A-Za-z0-9_.-])skills\/([A-Za-z0-9][A-Za-z0-9._-]{0,119})\/SKILL\.md(?![A-Za-z0-9])/gi;

// EVERY skill named in the text, in order, deduped. Codex reads skills with the shell, and one
// `bash -lc` line routinely reads two of them
// (`sed -n '1,240p' …/gateway-usage/SKILL.md && sed -n '1,320p' …/<granted>/SKILL.md`,
// `wc -l a/SKILL.md b/SKILL.md`). Matching only the first occurrence recorded the gateway guide
// and silently dropped the granted skill the run actually came for.
export function skillSlugsFromText(text) {
  const out = [];
  const seen = new Set();
  SKILL_FILE_RE.lastIndex = 0;
  for (const m of String(text ?? "").matchAll(SKILL_FILE_RE)) {
    const key = m[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m[1]);
  }
  return out;
}

export function skillSlugFromText(text) {
  return skillSlugsFromText(text)[0] || "";
}

// Claude names a plugin-provided skill as `<plugin>:<slug>` (e.g.
// `gateway-shared-skills:code-review`) in its Skill tool call; the catalog only knows the bare
// slug, so strip the prefix before looking it up — without it every Claude run recorded an
// unmatched name with no skill/revision id.
const PLUGIN_QUALIFIED_RE = /^[^:\s]+:([A-Za-z0-9][A-Za-z0-9._-]{0,119})$/;

export function unqualifySkillName(name) {
  const m = PLUGIN_QUALIFIED_RE.exec(String(name ?? "").trim());
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
    const bare = unqualifySkillName(raw);
    let skill = null;
    for (const candidate of bare ? [raw, bare] : [raw]) {
      try {
        skill = lookup(candidate);
      } catch {
        skill = null;
      }
      if (skill) break;
    }
    // A plugin-qualified name that matches nothing is still recorded by its bare slug, so repeats
    // of the same skill aggregate together in the report.
    const slug = skill?.slug || bare || raw;
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
      // Codex puts the WHOLE shell command in `name`, so a compound command can name several
      // skills at once — record each of them, not just the first.
      for (const slug of skillSlugsFromText([event.path, event.target, event.name].filter(Boolean).join(" "))) note(slug, "inferred");
    },
    seen() {
      return new Map(seen);
    },
  };
}

// The report a channel (or the whole gateway) asks for: what fired, how often, with what
// confidence, and — the more useful half — which granted skills never fired at all.
export function skillUsageReport({ channelSlug = "", days = 30, grants = null, limit = 200, includeAttribution = false } = {}) {
  const d = Math.max(1, Math.min(365, Number(days) || 30));
  const until = new Date().toISOString();
  const since = new Date(Date.parse(until) - d * 86400000).toISOString();
  const rows = usageSummary({ channelSlug, since, until, limit });
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
    // `via`/`requiredBy` keep a dependency's provenance in the report: it was never granted here,
    // it loads because something granted requires it.
    neverUsed = profile.active.filter((e) => !fired.has(e.slug.toLowerCase())).map((e) => ({ slug: e.slug, name: e.name, via: e.via, requiredBy: [...e.requiredBy] }));
  }
  return {
    since,
    until,
    days: d,
    channelSlug,
    used,
    channels: usageByChannel({ channelSlug, since, until, limit }),
    ...(includeAttribution ? { attribution: usageByAuthor({ channelSlug, since, until, slugs: used.map((u) => u.slug) }) } : {}),
    neverUsed,
    notes: [
      "exact = Claude's Skill tool fired the skill; inferred = a Codex (or shell) read of the skill's SKILL.md — best effort, may miss uses.",
      "Capture is not retroactive: turns that ran before usage capture shipped leave no rows here, and the report covers the selected range only.",
    ],
    ...(profile ? { contextTokens: profile.contextTokens } : {}),
  };
}

const reportCell = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").replace(/`/g, "\\`");

// The chat report has ONE usage total. Signal provenance qualifies that total in prose;
// exact/inferred counters remain available in the structured API for diagnostics.
export function formatSkillUsageReport(report, { conversationId = "", conversationName = "", userNames = new Map() } = {}) {
  const authors = new Map();
  for (const row of report.attribution?.rows || []) {
    const name = row.userId ? userNames.get(row.userId) : "";
    const user = row.userId ? `${name ? `${name} ` : ""}(${row.userId})` : "unrecorded user";
    const source = row.conversationId || `unrecorded conversation ID; workspace ${row.channelSlug || "unknown"}`;
    const lines = authors.get(row.slug) || [];
    lines.push(`${user}: ${row.total} (recorded conversation ${source})`);
    authors.set(row.slug, lines);
  }
  const lines = [
    "Skill usage report. Present one Usage total per skill; keep signal provenance as text, never separate Exact/Inferred columns.",
    `Conversation: ${JSON.stringify({ id: conversationId || null, name: conversationName || null, workspaceSlug: report.channelSlug })}. The workspace slug is not a channel name.`,
    `Window: ${report.since} through ${report.until} (rolling ${report.days} days, UTC).`,
    "Attribution below is from recorded usage events, not the current requester. Unrecorded identities are unknown.",
    ...(report.attribution?.truncated ? [`Author attribution is partial: only the first ${report.attribution.rows.length} groups are shown; usage totals remain complete for each listed skill.`] : []),
    "", "| Skill | Usage total | Recorded authors | Evidence | Last recorded |", "| --- | ---: | --- | --- | --- |",
  ];
  for (const skill of report.used) {
    const evidence = skill.exact && skill.inferred ? "Mixed invocation and inferred file-read signals; not all invocations"
      : skill.exact ? "Exact Skill-tool invocation signals" : "Inferred SKILL.md file reads; not confirmed invocations";
    lines.push(`| ${reportCell(skill.slug)} | ${skill.total} | ${reportCell((authors.get(skill.slug) || ["Attribution unavailable in this report"]).join("; "))} | ${evidence} | ${reportCell(skill.lastTs)} |`);
  }
  for (const skill of report.neverUsed) {
    const via = skill.via === "dependency" ? `Dependency required by ${skill.requiredBy.join(", ")}` : "Granted";
    lines.push(`| ${reportCell(skill.slug)} | 0 | No usage recorded | ${reportCell(via)}; never used in this window | — |`);
  }
  if (!report.used.length && !report.neverUsed.length) lines.push("No skill usage or unused grants in this report.");
  lines.push("", "Totals count recorded signals, not unique runs: one run can produce both an invocation and a file-read signal.", ...report.notes);
  return lines.join("\n");
}
