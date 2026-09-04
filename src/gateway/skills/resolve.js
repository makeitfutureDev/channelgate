// A conversation's skill PROFILE: the grant names the org/channel/user tiers union into
// (access-grants.js), resolved against the catalog into concrete skills + revisions, with every
// `requires` dependency pulled in automatically, cycles and missing links reported, and an
// estimate of what the profile costs in always-on context (the name + description of every
// active skill rides in every prompt — the bodies do not). Pure: takes lookups, returns a report.
import { getSkill, effectiveRevisionFor } from "./catalog.js";

// Roughly how many prompt tokens one skill's always-on discovery line costs. Claude Code lists
// each skill as its name plus description; ~3.7 characters per token for English prose plus the
// framing around each entry. An estimate, not an accounting — the point is to compare profiles.
export function estimateSkillTokens({ name = "", description = "" } = {}) {
  const chars = String(name).length + String(description).length + 24;
  return Math.ceil(chars / 3.7);
}

export const DEFAULT_CONTEXT_WARN_TOKENS = 6000;

// Word-set similarity of two descriptions; two skills whose triggers overlap heavily compete for
// the same request and one of them will rarely fire.
function similarity(a, b) {
  const words = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const A = words(a);
  const B = words(b);
  if (A.size < 4 || B.size < 4) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

export function findOverlaps(entries, threshold = 0.6) {
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const s = similarity(entries[i].description, entries[j].description);
      if (s >= threshold) out.push({ a: entries[i].slug, b: entries[j].slug, similarity: Number(s.toFixed(2)) });
    }
  }
  return out;
}

// Dependency cycles among the active entries: a depth-first walk over `requires` edges that
// stay inside the profile; an edge back onto the current path is one cycle (reported once).
export function findCycles(entries) {
  const bySlug = new Map(entries.map((e) => [e.slug.toLowerCase(), e]));
  const state = new Map(); // key → 1 (on path) | 2 (done)
  const cycles = [];
  const seen = new Set();
  const visit = (key, pathKeys) => {
    state.set(key, 1);
    const entry = bySlug.get(key);
    for (const dep of entry?.skill?.requires || []) {
      const depKey = String(dep).toLowerCase();
      if (!bySlug.has(depKey)) continue;
      if (state.get(depKey) === 1) {
        const pair = [entry.slug, bySlug.get(depKey).slug];
        const id = [...pair].sort().join("→");
        if (!seen.has(id)) {
          seen.add(id);
          cycles.push(pair);
        }
        continue;
      }
      if (!state.has(depKey)) visit(depKey, [...pathKeys, depKey]);
    }
    state.set(key, 2);
  };
  for (const key of bySlug.keys()) if (!state.has(key)) visit(key, [key]);
  return cycles;
}

// Resolve grant names into the profile. `lookup(name)` returns a catalog skill or null; a name
// that is not in the catalog at all is `unknown` (the materializer may still find it in a host
// folder — that is the pre-catalog path, kept working), a catalog skill with no active revision is
// `staged`, a tombstoned one is `removed`.
export function resolveSkillProfile(grantNames = [], { lookup = getSkill, revisionFor = effectiveRevisionFor, warnTokens = DEFAULT_CONTEXT_WARN_TOKENS } = {}) {
  const active = [];
  const byKey = new Map(); // lower-case slug → entry
  const unknown = [];
  const staged = [];
  const removed = [];
  const missingDependencies = [];
  const cycles = [];
  const queue = [];

  const enqueue = (name, via, requiredBy) => {
    const key = String(name).toLowerCase();
    if (byKey.has(key)) {
      const e = byKey.get(key);
      if (requiredBy && !e.requiredBy.includes(requiredBy)) e.requiredBy.push(requiredBy);
      return;
    }
    queue.push({ name, via, requiredBy });
  };
  for (const name of grantNames || []) if (name) enqueue(name, "grant", "");

  while (queue.length) {
    const { name, via, requiredBy } = queue.shift();
    const skill = lookup(name);
    const key = String(skill?.slug || name).toLowerCase();
    if (byKey.has(key)) {
      const e = byKey.get(key);
      if (requiredBy && !e.requiredBy.includes(requiredBy)) e.requiredBy.push(requiredBy);
      continue;
    }
    if (!skill) {
      if (via === "dependency") missingDependencies.push({ slug: name, requiredBy });
      else unknown.push(name);
      byKey.set(key, { slug: name, via, requiredBy: requiredBy ? [requiredBy] : [], state: "unknown" });
      continue;
    }
    if (skill.deleted) {
      removed.push({ slug: skill.slug, via, requiredBy, deletedAt: skill.deletedAt });
      byKey.set(key, { slug: skill.slug, via, requiredBy: requiredBy ? [requiredBy] : [], state: "removed" });
      continue;
    }
    const revision = revisionFor(skill);
    if (!revision) {
      staged.push({ slug: skill.slug, via, requiredBy, stagedCount: skill.stagedCount });
      byKey.set(key, { slug: skill.slug, via, requiredBy: requiredBy ? [requiredBy] : [], state: "staged" });
      continue;
    }
    const entry = {
      slug: skill.slug,
      name: skill.name || skill.slug,
      description: skill.description,
      via,
      requiredBy: requiredBy ? [requiredBy] : [],
      state: "active",
      skill,
      revision,
      tokens: estimateSkillTokens(skill),
    };
    byKey.set(key, entry);
    active.push(entry);
    for (const dep of skill.requires || []) enqueue(dep, "dependency", skill.slug);
  }
  cycles.push(...findCycles(active));

  const contextTokens = active.reduce((n, e) => n + e.tokens, 0);
  const overlaps = findOverlaps(active);
  const warnings = [];
  if (contextTokens > warnTokens) warnings.push(`always-on skill descriptions cost about ${contextTokens} tokens per turn (soft cap ${warnTokens})`);
  for (const m of missingDependencies) warnings.push(`"${m.requiredBy}" requires "${m.slug}", which is not in the catalog`);
  for (const s of staged) warnings.push(`"${s.slug}" has no approved revision yet${s.stagedCount ? ` (${s.stagedCount} staged for review)` : ""}`);
  for (const r of removed) warnings.push(`"${r.slug}" was removed from its source and is tombstoned`);
  for (const c of cycles) warnings.push(`dependency cycle between "${c[0]}" and "${c[1]}"`);
  for (const o of overlaps) warnings.push(`"${o.a}" and "${o.b}" have very similar trigger descriptions (${Math.round(o.similarity * 100)}% overlap)`);

  return {
    active,
    slugs: active.map((e) => e.slug),
    unknown,
    staged,
    removed,
    missingDependencies,
    cycles,
    overlaps,
    contextTokens,
    warnTokens,
    warnings,
  };
}

// The names a grant list should carry so every dependency is included: the input names plus the
// resolved dependency slugs, in a stable order. Used when a template is applied or a skill added.
export function withDependencies(grantNames = [], opts = {}) {
  const profile = resolveSkillProfile(grantNames, opts);
  const out = [...new Set([...(grantNames || []).map(String), ...profile.active.filter((e) => e.via === "dependency").map((e) => e.slug)])];
  return { names: out, profile };
}
