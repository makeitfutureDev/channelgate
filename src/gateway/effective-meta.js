import { getEngine, getDmTemplate, ENGINES } from "../config/settings.js";
import { modelBelongsToEngine, effortBelongsToEngine } from "../engines/registry.js";
import { isLicenseShapedId } from "../engines/license-state.js";
import { normalizeModeMeta } from "./modes.js";
import { licenseFitsConversation } from "./channel-engines.js";

// A conversation default naming a LICENSE an administrator has since deleted reads as "no default
// here": the conversation follows the gateway default again, and the pool chosen beside that
// license goes with it. The stored record is left alone (nothing is rewritten on a read), so this
// is the one projection every settings surface, policy check and picker shares — a deleted id
// reaching the registry lookups behind them throws, which is what stopped the Slack settings
// modal from opening and refused every approved-harness edit on such a channel.
// A license that was since LIMITED to another conversation (engines/license-state.js) is the same
// case from here: it no longer exists in this one. A thread someone pinned to it is different — a
// pin is an explicit ask, and is refused by name instead of being answered by another account.
const usableDefault = (meta, id) => ENGINES.includes(id) && licenseFitsConversation(meta, id);
function withoutDeletedLicense(meta) {
  if (!meta || typeof meta.engine !== "string" || !meta.engine) return meta;
  if (ENGINES.includes(meta.engine) ? licenseFitsConversation(meta, meta.engine) : !isLicenseShapedId(meta.engine)) return meta;
  const { engine: _engine, licensePool: _pool, ...rest } = meta;
  return rest;
}

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
    const engine = (usableDefault(meta, meta.engine) ? meta.engine : "") || (usableDefault(meta, t.engine) ? t.engine : "") || getEngine() || "claude";
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
      // Only a harness this build ships: a template (or DM) still naming a retired one follows
      // the gateway default instead of projecting an id no adapter answers to.
      engine: [meta.engine, t.engine].find((id) => usableDefault(meta, id)) || "",
      // The pool travels with the license: from the DM when the DM named it, else the template's.
      licensePool: usableDefault(meta, meta.engine) ? meta.licensePool || "" : t.licensePool || "",
    });
  }
  return normalizeModeMeta(withoutDeletedLicense(meta));
}
