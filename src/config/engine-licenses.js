// Engine licenses — the admin-managed list (Settings → Engines → Licenses).
//
// A license is one credential + server a harness can run on (src/engines/license-state.js). The
// built-in ones ship with the gateway; this module owns the ones an administrator ADDS: as many as
// they hold, each with a declared type that is checked against what the credential itself reports.
// A record lives in settings.json under `engineLicenses`; saving it makes the license a live
// engine adapter in every process on its next settings read (src/config/settings.js).
//
// "License" here is an ENGINE license. The ChannelGate product license is src/ee/license.js and
// has nothing to do with this list.
//
// An API license's key is write-only: every reader below returns `hasApiKey` + `apiKeyLast4`, and
// there is deliberately no reveal path (it is not in the src/web/secrets.js allowlist).
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { getSettings, saveSettings, isEngineEnabled } from "./settings.js";
import { adapterFor, engineRegistry, licenseLabel } from "../engines/registry.js";
import {
  API_AUTH_SCHEMES, LICENSE_BASE_URL_RE, LICENSE_KINDS, LICENSE_KIND_IDS, LICENSE_TYPES, HARNESSES,
  harnessLabel, licenseApiHost, licenseKindOfId, licenseLoginCommand, licenseLoginHome, licenseTypeLabel,
  normalizeLicenseModels, normalizeLicenseRecord, normalizeLicenseRecords,
} from "../engines/license-state.js";
import { licenseDefaultEffortKey, licenseDefaultModelKey, verifyApiLicense } from "../engines/license-adapters.js";
import { publicPinnedFetch } from "../mcp/public-fetch.js";

// A ceiling, not a product limit: every license is an adapter the pickers and the health probe
// walk, and a settings file is read on every turn. Nobody holds this many; a runaway script might.
export const MAX_ENGINE_LICENSES = 200;
const ANTHROPIC_API_HOST = "api.anthropic.com";

export class EngineLicenseError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "EngineLicenseError";
    this.status = status;
  }
}
const refuse = (message, status = 400) => { throw new EngineLicenseError(message, status); };

const stored = (settings = getSettings()) => normalizeLicenseRecords(settings.engineLicenses);
export const listLicenseRecords = () => stored();
export function getLicenseRecord(id) {
  return stored().find((record) => record.id === id) || null;
}

// What the "add a license" form needs: the harnesses, how each can be licensed, and the types.
export function licenseCatalog() {
  return {
    harnesses: HARNESSES.map((harness) => ({ ...harness })),
    kinds: LICENSE_KIND_IDS.map((id) => {
      const kind = LICENSE_KINDS[id];
      return { id, harness: kind.harness, label: kind.label, description: kind.description, types: [...kind.types] };
    }),
    types: LICENSE_TYPES.map((type) => ({ ...type })),
    authSchemes: [...API_AUTH_SCHEMES],
    max: MAX_ENGINE_LICENSES,
  };
}

// One record as a browser may see it. Never the key.
export function licenseForApi(record) {
  if (!record) return null;
  const kind = LICENSE_KINDS[record.kind];
  const out = {
    id: record.id, kind: record.kind, kindLabel: kind.label, harness: record.harness, harnessLabel: harnessLabel(record.harness),
    label: record.label, type: record.type, typeLabel: licenseTypeLabel(record.type), createdAt: record.createdAt,
    enabled: isEngineEnabled(record.id), loginCommand: licenseLoginCommand(record),
    defaultModel: String(getSettings()[licenseDefaultModelKey(record.id)] || ""),
    defaultEffort: String(getSettings()[licenseDefaultEffortKey(record.id)] || ""),
  };
  if (record.kind !== "claude-api") return out;
  return {
    ...out,
    baseUrl: record.baseUrl, authScheme: record.authScheme, models: record.models.map((model) => ({ ...model })),
    hasApiKey: Boolean(record.apiKey), apiKeyLast4: record.apiKey ? record.apiKey.slice(-4) : "",
    verification: record.verification ? { ...record.verification } : null,
  };
}

// The live verdict for one license: is it usable, and does the declared type hold up?
export async function licenseStatusFor(id) {
  const adapter = adapterFor(id);
  if (typeof adapter?.licenseStatus !== "function") return { ready: false, signedIn: false, method: "", plan: null, detail: "This license is not registered." };
  try {
    const { fingerprint: _fingerprint, ...status } = await adapter.licenseStatus();
    return status;
  } catch (error) {
    return { ready: false, signedIn: false, method: "", plan: null, detail: `The license could not be checked: ${String(error?.message || error).slice(0, 200)}` };
  }
}

export async function listLicensesForApi() {
  const records = stored();
  return Promise.all(records.map(async (record) => ({ ...licenseForApi(record), status: await licenseStatusFor(record.id) })));
}

// ── Validation ────────────────────────────────────────────────────────────────────────────────
const cleanLabel = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

function assertLabel(label, records, selfId = "") {
  if (!label) refuse("Give the license a name.");
  if (label.length > 60) refuse("A license name is at most 60 characters.");
  const wanted = label.toLowerCase();
  const taken = records.some((record) => record.id !== selfId && record.label.toLowerCase() === wanted)
    || engineRegistry.builtinIds.some((id) => [adapterFor(id)?.label, licenseLabel(id)].some((name) => String(name || "").toLowerCase() === wanted));
  if (taken) refuse(`Another license is already called "${label}".`, 409);
}

function apiFields(input, previous = null) {
  const baseUrl = String(input.baseUrl ?? previous?.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!LICENSE_BASE_URL_RE.test(baseUrl)) refuse("Enter the endpoint as an https:// URL (host, optional port and path).");
  const typedKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (typedKey && (/\s/.test(typedKey) || typedKey.length > 4096 || typedKey.length < 8)) refuse("That does not look like an API key.");
  // A blank key on an edit keeps the stored one — the form never has it to send back.
  const apiKey = typedKey || previous?.apiKey || "";
  if (!apiKey) refuse("Enter the API key.");
  const authScheme = input.authScheme === undefined ? previous?.authScheme || "x-api-key" : input.authScheme;
  if (!API_AUTH_SCHEMES.includes(authScheme)) refuse("Choose how the key is sent: x-api-key or bearer.");
  const rawModels = input.models === undefined ? previous?.models || [] : input.models;
  if (!Array.isArray(rawModels)) refuse("List the models as an array.");
  const models = normalizeLicenseModels(rawModels);
  if (models.length !== rawModels.filter((entry) => String(typeof entry === "string" ? entry : entry?.value ?? "").trim()).length) {
    refuse("A model id may hold letters, digits and . _ : / @ [ ] - only, and each may be listed once.");
  }
  let host = "";
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { /* shape already checked */ }
  if (!models.length && host !== ANTHROPIC_API_HOST) refuse("List at least one model id this endpoint serves.");
  // A changed key or endpoint is an unverified one: yesterday's verdict says nothing about it.
  const unchanged = previous && previous.baseUrl === baseUrl && previous.apiKey === apiKey && previous.authScheme === authScheme;
  return { baseUrl, apiKey, authScheme, models: models.map((model) => ({ ...model })), verification: unchanged ? previous.verification : null };
}

const writeLicenses = (mutate) => {
  let result;
  saveSettings((current) => {
    const records = stored(current).map((record) => ({ ...record }));
    const patch = mutate(records, current);
    result = patch.result;
    return patch.settings;
  });
  return result;
};

// ── CRUD ──────────────────────────────────────────────────────────────────────────────────────
export function createLicense(input = {}) {
  const kind = LICENSE_KINDS[input.kind];
  if (!kind) refuse("Choose what kind of license this is.");
  const type = input.type === undefined || input.type === "" ? kind.types[0] : input.type;
  if (!kind.types.includes(type)) refuse(`A ${kind.label} license is one of: ${kind.types.map(licenseTypeLabel).join(", ")}.`);
  const label = cleanLabel(input.label);
  return writeLicenses((records, current) => {
    if (records.length >= MAX_ENGINE_LICENSES) refuse(`A gateway holds at most ${MAX_ENGINE_LICENSES} added licenses.`, 409);
    assertLabel(label, records);
    let id = "";
    do { id = `${kind.prefix}${randomBytes(4).toString("hex")}`; } while (records.some((record) => record.id === id));
    const record = normalizeLicenseRecord({
      id, kind: kind.id, label, type, createdAt: new Date().toISOString(),
      ...(kind.id === "claude-api" ? apiFields(input) : {}),
    });
    if (!record) refuse("The license could not be stored.");
    return {
      result: record,
      settings: {
        engineLicenses: [...records, record],
        // An added license is opt-in like every non-default engine; adding one is the opt-in.
        engineEnabled: { ...(current.engineEnabled && typeof current.engineEnabled === "object" ? current.engineEnabled : {}), [id]: true },
      },
    };
  });
}

export function updateLicense(id, input = {}) {
  return writeLicenses((records) => {
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) refuse("That license no longer exists.", 404);
    const previous = records[index];
    const kind = LICENSE_KINDS[previous.kind];
    const label = input.label === undefined ? previous.label : cleanLabel(input.label);
    assertLabel(label, records, id);
    const type = input.type === undefined ? previous.type : input.type;
    if (!kind.types.includes(type)) refuse(`A ${kind.label} license is one of: ${kind.types.map(licenseTypeLabel).join(", ")}.`);
    const record = normalizeLicenseRecord({
      ...previous, label, type,
      ...(kind.id === "claude-api" ? apiFields(input, previous) : {}),
    });
    if (!record) refuse("The license could not be stored.");
    const next = [...records];
    next[index] = record;
    return { result: record, settings: { engineLicenses: next } };
  });
}

// Removes the record and everything that named it as a DEFAULT. Channels and threads that still
// reference the id simply fall through to their next level (src/gateway/run.js): the id no longer
// resolves to an engine, exactly like a retired one.
export async function deleteLicense(id) {
  const removed = writeLicenses((records, current) => {
    const record = records.find((entry) => entry.id === id);
    if (!record) refuse("That license no longer exists.", 404);
    const enabled = { ...(current.engineEnabled && typeof current.engineEnabled === "object" ? current.engineEnabled : {}) };
    delete enabled[id];
    const pool = Array.isArray(current.enginePool) ? current.enginePool.filter((entry) => entry !== id) : current.enginePool;
    return {
      result: record,
      settings: {
        engineLicenses: records.filter((entry) => entry.id !== id),
        engineEnabled: enabled,
        [licenseDefaultModelKey(id)]: "",
        [licenseDefaultEffortKey(id)]: "",
        ...(current.engine === id ? { engine: record.harness, enginePool: "" } : pool !== current.enginePool ? { enginePool: pool } : {}),
      },
    };
  });
  // The sign-in itself goes with the license. The path is built from a shape-checked id only.
  if (licenseKindOfId(id) && removed.kind !== "claude-api") {
    await rm(licenseLoginHome(id), { recursive: true, force: true }).catch(() => {});
  }
  return removed;
}

// ── Verification ──────────────────────────────────────────────────────────────────────────────
// A sign-in license is verified by reading what its own login reports (plan vs declared type), so
// its verdict is always live. An API license is verified by asking its endpoint, on demand, and
// the answer is stored beside the record.
export async function verifyLicense(id, { fetchImpl = publicPinnedFetch } = {}) {
  const record = getLicenseRecord(id);
  if (!record) refuse("That license no longer exists.", 404);
  if (record.kind !== "claude-api") {
    const status = await licenseStatusFor(id);
    return { license: licenseForApi(record), status, verification: { ok: status.ready, verified: status.plan?.matches === true, detail: status.plan?.detail || status.detail || "" } };
  }
  const verdict = await verifyApiLicense(record, { fetchImpl });
  const verification = { at: new Date().toISOString(), ok: verdict.ok, verified: verdict.verified, detail: verdict.detail };
  const saved = writeLicenses((records) => {
    const index = records.findIndex((entry) => entry.id === id);
    if (index < 0) refuse("That license no longer exists.", 404);
    // Only stamp the credential that was actually checked: an edit that landed meanwhile keeps
    // its own (empty) verdict rather than inheriting one for a key it no longer holds.
    const current = records[index];
    if (current.apiKey !== record.apiKey || current.baseUrl !== record.baseUrl || current.authScheme !== record.authScheme) return { result: current, settings: {} };
    const next = [...records];
    next[index] = normalizeLicenseRecord({ ...current, verification });
    return { result: next[index], settings: { engineLicenses: next } };
  });
  return { license: licenseForApi(saved), status: await licenseStatusFor(id), verification };
}

export { licenseApiHost };
