// License selections: which licenses of a harness a conversation runs on.
//
// A conversation picks a HARNESS (Claude Code or Codex), then the license to run on — and,
// optionally, more licenses of the same harness to move to when that one fails
// (src/engines/license-state.js). The first license is the ordinary `engine` every level already
// stores (gateway default, channel default, thread pin, per-run override); the rest is the POOL
// stored beside it: "" (just that license), "any" (every license of the harness this conversation
// may use) or an ordered list.
//
// Moving inside a pool is not cross-harness failover. The person chose every license in it, the
// harness — its tools, its session format, its instruction file — stays the same, and so does the
// model when one was picked: a license that cannot serve the picked model is skipped. That is why
// a pool applies to a PINNED thread too, where cross-harness failover never does.
import { adapterFor, coherentLicensePool, harnessOf, isEngineId, licenseLabel, licensesOfHarness, modelBelongsToEngine } from "../engines/registry.js";
import { HARNESS_IDS, LICENSE_POOL_ANY, harnessLabel, isHarnessId, readLicensePool } from "../engines/license-state.js";
import { getEngine, getEnginePool, isEngineEnabled } from "../config/settings.js";
import { isChannelEngineApproved } from "./channel-engines.js";

export { LICENSE_POOL_ANY, readLicensePool };

const invalid = (message) => Object.assign(new Error(message), { status: 400, statusCode: 400, code: "invalid_license_pool" });

// A channel-account license exists only in the conversation that signed it in.
const availableHere = (meta, id) => {
  const adapter = adapterFor(id);
  return Boolean(adapter) && (!adapter.channelScoped || meta?.codexAuthSource === "channel");
};

// Every license of `harness` this conversation may run on right now: registered, switched on in
// Settings, admitted by the channel's approved-harness policy, and available in this conversation.
export function selectableLicenses(harness, meta = {}) {
  return licensesOfHarness(harness).filter((id) => isEngineEnabled(id) && isChannelEngineApproved(meta, id) && availableHere(meta, id));
}

// The license a harness runs on when a selection names the harness and no license: its own
// default sign-in when that is usable here, else the first license that is.
export function primaryLicenseOf(harness, meta = {}) {
  const usable = selectableLicenses(harness, meta);
  return usable.includes(harness) ? harness : usable[0] || "";
}

// Writers: a submitted pool → what is stored. `engine` is the license it sits beside. Refuses a
// list that names an unknown license or one of another harness — a pool never crosses harnesses.
export function normalizeLicensePool(value, engine) {
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return "";
  const harness = harnessOf(engine);
  if (!harness) throw invalid("Choose a license before choosing more licenses to fall back to.");
  if (value === LICENSE_POOL_ANY) return LICENSE_POOL_ANY;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !isEngineId(id))) {
    throw invalid(`A license selection is "any" or a list of ${harnessLabel(harness)} licenses.`);
  }
  if (value.some((id) => harnessOf(id) !== harness)) throw invalid(`Every license in one selection must be a ${harnessLabel(harness)} license.`);
  const rest = [...new Set(value)].filter((id) => id !== engine);
  return rest.length ? rest : "";
}

// Run time: the licenses to try, in order, after `engine` failed. Filtered against the live state
// on every call — a license removed, switched off or no longer approved since the selection was
// saved is simply not a candidate. `model` is a model somebody PICKED for this turn (not a gateway
// default): a license that cannot serve it is skipped rather than answered by a different model.
export function licensePoolCandidates({ engine, pool, meta = {}, model = "" } = {}) {
  const harness = harnessOf(engine);
  const selection = readLicensePool(pool);
  if (!isHarnessId(harness) || !selection) return [];
  const ids = selection === LICENSE_POOL_ANY ? licensesOfHarness(harness) : selection;
  return [...new Set(ids)].filter((id) => id !== engine && isEngineId(id) && harnessOf(id) === harness
    && isEngineEnabled(id) && isChannelEngineApproved(meta, id) && availableHere(meta, id)
    && (!model || modelBelongsToEngine(model, id)));
}

// What a picker shows for a stored selection: the harness, the first license, and the rest.
export function describeLicenseSelection({ engine, pool } = {}) {
  const stored = coherentLicensePool(pool, engine);
  // A license removed since the selection was saved is not something a picker can show.
  return { harness: harnessOf(engine), license: isEngineId(engine) ? engine : "", pool: Array.isArray(stored) ? stored.filter(isEngineId) : stored || [] };
}

// ── What a picker shows ───────────────────────────────────────────────────────────────────────
// Every surface (the Slack modal and /model wizard, the Teams card, the Google Chat command, the
// admin UI through the engine manifest) offers the same three steps: harness → license → model.
// The license step exists only when there is something to choose between.

// The harnesses this conversation can run on at all: at least one usable license each.
export function selectableHarnesses(meta = {}) {
  return HARNESS_IDS.filter((harness) => selectableLicenses(harness, meta).length > 0);
}

// The license step for one harness. `show` is false when the harness has a single usable license
// here — then there is no control, and the harness alone is the whole choice. `selected` is what
// the License control holds ("any" or a license id) and `also` the further licenses the stored
// selection moves to; `others` is what the "also use" control may offer beside `selected`.
export function licensePicker({ harness, meta = {}, engine = "", pool = "" } = {}) {
  const ids = selectableLicenses(harness, meta);
  const onHarness = harnessOf(engine) === harness && ids.includes(engine);
  const stored = onHarness ? describeLicenseSelection({ engine, pool }).pool : [];
  const selected = stored === LICENSE_POOL_ANY ? LICENSE_POOL_ANY : onHarness ? engine : primaryLicenseOf(harness, meta);
  const also = Array.isArray(stored) ? stored.filter((id) => ids.includes(id)) : [];
  return {
    show: ids.length > 1,
    licenses: ids.map((id) => ({ id, label: licenseLabel(id) })),
    selected,
    also,
    others: selected === LICENSE_POOL_ANY ? [] : ids.filter((id) => id !== selected).map((id) => ({ id, label: licenseLabel(id) })),
  };
}

// A submitted pick → the `engine` + `licensePool` every level stores. `license` is "any", a
// license id, or "" (no license step was shown: the harness's own license); `also` the further
// licenses to move to. Refuses a license this conversation may not use.
export function resolveLicensePick({ harness, meta = {}, license = "", also = [] } = {}) {
  const ids = selectableLicenses(harness, meta);
  if (!ids.length) throw invalid(`${harnessLabel(harness) || "That harness"} has no license this conversation can use.`);
  if (!license || license === LICENSE_POOL_ANY) {
    return { engine: primaryLicenseOf(harness, meta), licensePool: license === LICENSE_POOL_ANY && ids.length > 1 ? LICENSE_POOL_ANY : "" };
  }
  if (!ids.includes(license)) throw invalid(`That ${harnessLabel(harness)} license is not available in this conversation.`);
  const rest = (Array.isArray(also) ? also : []).filter((id) => id !== license);
  if (rest.some((id) => !ids.includes(id))) throw invalid(`Every license in one selection must be a ${harnessLabel(harness)} license this conversation can use.`);
  return { engine: license, licensePool: normalizeLicensePool(rest, license) };
}

// A bare harness pick ("codex" typed at the start of a message, a harness button): the selection
// this conversation already has for that harness when its own default is on it — the license and
// pool somebody chose keep applying — else the harness's own license and nothing more. "Any" is
// never implied.
export function harnessSelection(harness, meta = {}) {
  const usable = selectableLicenses(harness, meta);
  const inherited = isEngineId(meta?.engine) ? { engine: meta.engine, pool: meta.licensePool } : { engine: getEngine(), pool: getEnginePool() };
  if (harnessOf(inherited.engine) === harness && usable.includes(inherited.engine)) {
    const stored = describeLicenseSelection(inherited).pool;
    return { engine: inherited.engine, licensePool: stored === LICENSE_POOL_ANY ? LICENSE_POOL_ANY : normalizeLicensePool(stored.filter((id) => usable.includes(id)), inherited.engine) };
  }
  return { engine: primaryLicenseOf(harness, meta), licensePool: "" };
}

// One line for a summary: "Codex", "Codex · Work ChatGPT", "Codex · any license",
// "Codex · Work ChatGPT, then Second seat". The license part is left out when the harness has a
// single usable license here — the same rule that hides the control.
export function describeSelectionText({ engine, pool = "", meta = {} } = {}) {
  const harness = harnessOf(engine);
  if (!harness || !isEngineId(engine)) return "";
  const picker = licensePicker({ harness, meta, engine, pool });
  if (!picker.show) return harnessLabel(harness);
  if (picker.selected === LICENSE_POOL_ANY) return `${harnessLabel(harness)} · any license`;
  const then = picker.also.map((id) => licenseLabel(id));
  return `${harnessLabel(harness)} · ${licenseLabel(engine)}${then.length ? `, then ${then.join(", ")}` : ""}`;
}
