import { getEngine, getDmTemplate, ENGINES } from "../config/settings.js";
import { modelBelongsToEngine, effortBelongsToEngine } from "../engines/registry.js";
import { normalizeModeMeta } from "./modes.js";

// For a DM that selected an org template (user/admin), overlay the template's knobs onto its
// meta. "custom" DMs and regular channels use their own meta unchanged. Engine/model/effort are
// the exception: a runtime pick made IN the DM (the /model wizard writes meta.engine/model/effort)
// wins over the template's — otherwise the wizard would be a silent no-op in every template-managed
// DM. Empty = inherit the template, as before. Model/effort are engine-specific, so each resolves
// to the first candidate (own, then template) that actually belongs to the resolved engine — a
// stale value written under the other harness (own or template) is skipped, not spawned.
export function effectiveMeta(meta) {
  if (meta?.isDM && !meta.workspaceLink && (meta.template === "user" || meta.template === "admin")) {
    const t = getDmTemplate(meta.template);
    const engine = (ENGINES.includes(meta.engine) ? meta.engine : "") || (ENGINES.includes(t.engine) ? t.engine : "") || getEngine() || "claude";
    return normalizeModeMeta({
      ...meta,
      skills: t.skills,
      skillTemplate: typeof t.skillTemplate === "string" ? t.skillTemplate : "",
      allowedMcps: t.allowedMcps,
      allowedCodexMcps: t.allowedCodexMcps,
      model: [meta.model, t.model].find((m) => m && modelBelongsToEngine(m, engine)) || "",
      effort: [meta.effort, t.effort].find((e) => e && effortBelongsToEngine(e, engine)) || "",
      adminMode: t.adminMode,
      allowBash: t.allowBash,
      allowNetwork: t.allowNetwork,
      autoMode: t.autoMode,
      cleanMode: t.cleanMode,
      engine: meta.engine || t.engine,
    });
  }
  return normalizeModeMeta(meta);
}

