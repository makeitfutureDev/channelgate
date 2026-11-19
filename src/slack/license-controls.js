// The license step every Slack engine picker shares: the Settings modal's runtime rows, the /model
// wizard and the engine words typed in a message. All of them ask the one picker shape in
// src/gateway/license-pool.js — harness → license → model → effort — and store what it returns:
// `engine` (the first license) plus the pool of further licenses of the same harness. Nothing here
// lists licenses by hand; a harness with a single usable license has no license step at all.
import { engineLabel, harnessOf } from "../engines/registry.js";
import { harnessLabel, isHarnessId } from "../engines/license-state.js";
import {
  LICENSE_POOL_ANY, describeSelectionText, harnessSelection, licensePicker, readLicensePool, resolveLicensePick, selectableHarnesses, selectableLicenses,
} from "../gateway/license-pool.js";

export const ANY_LICENSE_LABEL = "Any license";
export const ALSO_USE_LABEL = "If it fails, also use";
export const LICENSE_HELP_TEXT = "When a license cannot answer, the turn moves to the next one.";

// Slack caps an option's or a button's text at 75 characters and a select at 100 options. A
// license label is typed by an admin, so it is clipped on a code point, never mid-surrogate.
const MAX_LABEL = 75;
const MAX_OPTIONS = 100;
export function clipLabel(text, max = MAX_LABEL) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  let out = "";
  for (const char of value) {
    if (out.length + char.length > max - 1) break;
    out += char;
  }
  return `${out}…`;
}

// Keep the entries that are in force when a list has to be cut to Slack's option limit.
function capped(entries, keep, max) {
  if (entries.length <= max) return entries;
  const pinned = entries.filter((entry) => keep.includes(entry.value));
  return [...pinned, ...entries.filter((entry) => !keep.includes(entry.value))].slice(0, Math.max(max, pinned.length));
}

export const samePool = (a, b) => JSON.stringify(readLicensePool(a)) === JSON.stringify(readLicensePool(b));

// One line naming a stored selection: "Codex", "Codex · any license", "Codex · Work, then Second".
// A reference to a license removed since falls back to its plain label so the line is never blank.
export function selectionLabel({ engine, pool = "", meta = {} } = {}) {
  return describeSelectionText({ engine, pool, meta }) || engineLabel(engine);
}

// The first control: the harnesses this conversation can run on.
export function harnessChoices(meta = {}) {
  return selectableHarnesses(meta).map((harness) => ({ label: harnessLabel(harness), value: harness }));
}

// The license step for the selection stored at one level, or null when there is nothing to choose
// (no explicit harness at this level, or the harness has one usable license here). `selected` is
// what the License control holds ("any" or a license id); `others` is what "also use" may offer
// beside it — empty for "any" — and `also` its stored value.
export function licenseChoices({ engine = "", pool = "", meta = {} } = {}) {
  const harness = harnessOf(engine);
  if (!engine || !isHarnessId(harness)) return null;
  const picker = licensePicker({ harness, meta, engine, pool });
  if (!picker.show) return null;
  const entry = ({ id, label }) => ({ label: clipLabel(label), value: id });
  const also = picker.also.slice(0, MAX_OPTIONS);
  return {
    harness,
    options: [{ label: ANY_LICENSE_LABEL, value: LICENSE_POOL_ANY }, ...capped(picker.licenses.map(entry), [picker.selected], MAX_OPTIONS - 1)],
    selected: picker.selected,
    others: capped(picker.others.map(entry), also, MAX_OPTIONS),
    also,
  };
}

// What an engine NAME pins: a harness (`claude`, `codex` — a directive word, a harness button, the
// Harness dropdown) is a bare harness pick, so the license and pool this conversation already
// chose for that harness keep applying (license-pool.js harnessSelection). Any other engine id
// names exactly one license, with nothing to move to. `meta` is the conversation's effective meta.
export function namedSelection(name, meta = {}) {
  if (isHarnessId(name)) {
    const selection = harnessSelection(name, meta);
    // No usable license: keep the harness's own id so the selectability checks say why.
    if (selection.engine) return selection;
  }
  return { engine: String(name || ""), licensePool: "" };
}

// The selection a level already stores for `harness`, re-read against what is usable now, or null
// when that level is on another harness (or on a license this conversation may no longer use).
export function storedSelectionFor(harness, { engine = "", licensePool = "" } = {}, meta = {}) {
  if (harnessOf(engine) !== harness || !selectableLicenses(harness, meta).includes(engine)) return null;
  const picker = licensePicker({ harness, meta, engine, pool: licensePool });
  if (picker.selected === LICENSE_POOL_ANY) return { engine, licensePool: LICENSE_POOL_ANY };
  return resolveLicensePick({ harness, meta, license: engine, also: picker.also });
}

// One dispatched License / "also use" control → the `engine` + `licensePool` to store. `current`
// is the selection stored at that level; the harness is read from it, so a control left on screen
// after the level went back to its default is refused rather than guessed at.
export function nextLicenseSelection({ field, value = "", also = [], current = {}, meta = {} } = {}) {
  const harness = harnessOf(current.engine);
  if (!current.engine || !isHarnessId(harness)) throw new Error("Choose a harness before choosing its license.");
  if (field === "also") return resolveLicensePick({ harness, meta, license: current.engine, also });
  if (!value) throw new Error("Choose a license.");
  if (value === LICENSE_POOL_ANY) return resolveLicensePick({ harness, meta, license: LICENSE_POOL_ANY });
  // Moving the first license keeps the others already chosen, minus the one that became first.
  const kept = licensePicker({ harness, meta, engine: current.engine, pool: current.licensePool }).also.filter((id) => id !== value);
  return resolveLicensePick({ harness, meta, license: value, also: kept });
}
