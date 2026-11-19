// What a person TYPES to choose licenses on a surface without a picker: the numbered list a text
// command prints, and the reading of the answer. `/license` and the typed settings commands share
// it, so both accept the same words. `licenses` is always `licensePicker(...).licenses` — the
// licenses this conversation may choose between (src/gateway/license-pool.js), never a list made
// up here.
import { LICENSE_POOL_ANY } from '../gateway/license-pool.js';

const named = item => `${item.label} (${item.id})`;
const quoted = word => `“${String(word).slice(0, 60)}”`;

// One line, because every surface renders it as plain message text: "1) Default sign-in (codex);
// 2) Work ChatGPT (codex-lic-1a2b3c4d)".
export const licenseListText = licenses => licenses.map((item, index) => `${index + 1}) ${named(item)}`).join('; ');

// A list number, an id, or a name — a whole label first, then its beginning, then any part of it.
// A name that fits several licenses is refused rather than guessed.
function matchLicense(word, licenses) {
  const wanted = word.toLowerCase();
  if (/^\d{1,3}$/.test(wanted) && licenses[Number(wanted) - 1]) return { id: licenses[Number(wanted) - 1].id };
  const byId = licenses.find(item => item.id.toLowerCase() === wanted);
  if (byId) return { id: byId.id };
  for (const fits of [label => label === wanted, label => label.startsWith(wanted), label => label.includes(wanted)]) {
    const hits = licenses.filter(item => fits(String(item.label).toLowerCase()));
    if (hits.length === 1) return { id: hits[0].id };
    if (hits.length > 1) return { error: `${quoted(word)} fits more than one license (${hits.map(named).join(', ')}). Use its number or id.` };
  }
  return { error: `No license here is called ${quoted(word)}.` };
}

// "any", or a comma-separated list: the first is the license to run on, the rest are the ones to
// move to when it fails, in the order typed. → { license: "any" | id, also: [ids] } or { error }.
export function readLicenseChoice(text, licenses) {
  const words = String(text || '').split(',').map(word => word.trim()).filter(Boolean);
  if (!words.length) return { error: 'Name a license.' };
  if (words.length === 1 && words[0].toLowerCase() === LICENSE_POOL_ANY) return { license: LICENSE_POOL_ANY, also: [] };
  const ids = [];
  for (const word of words) {
    const found = matchLicense(word, licenses);
    if (found.error) return found;
    if (!ids.includes(found.id)) ids.push(found.id);
  }
  return { license: ids[0], also: ids.slice(1) };
}
