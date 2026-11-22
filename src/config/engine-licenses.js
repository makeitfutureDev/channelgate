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
import { ENGINE_IDS, adapterFor, engineRegistry, harnessOf, isDefaultLicense, isGatewayWideLicense, isRemovableBuiltinLicense, isRemovedLicense, licenseLabel, removedBuiltinLicenses } from "../engines/registry.js";
import {
  API_AUTH_SCHEMES, API_VERSION_RE, DEFAULT_LICENSE_NAME, GCP_PROJECT_RE, LICENSE_BASE_URL_RE, LICENSE_KINDS, LICENSE_KIND_IDS, LICENSE_TYPES, HARNESSES,
  MAX_LICENSE_MODELS, MAX_LICENSE_NAME_LENGTH, MAX_SERVICE_ACCOUNT_BYTES, cleanLicenseName, harnessLabel, isLicenseRegion, isProviderKind, licenseApiHost, licenseEndpoint, licenseIsVendorApi,
  licenseKindOfId, licenseLoginCommand, licenseLoginHome, licenseTypeLabel, normalizeLicenseChannelId, normalizeLicenseModels, normalizeLicenseRecord,
  normalizeLicenseNames, normalizeLicenseRecords, normalizeRemovedLicenses, normalizeServiceAccount, serviceAccountFacts,
} from "../engines/license-state.js";
import { licenseDefaultEffortKey, licenseDefaultModelKey, verifyProviderLicense } from "../engines/license-adapters.js";
import { assertChannelLimitedLicensesEntitled } from "../gateway/channel-engines.js";
import { publicPinnedFetch } from "../mcp/public-fetch.js";

// A ceiling, not a product limit: every license is an adapter the pickers and the health probe
// walk, and a settings file is read on every turn. Nobody holds this many; a runaway script might.
export const MAX_ENGINE_LICENSES = 200;

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
      return {
        id, harness: kind.harness, label: kind.label, description: kind.description, types: [...kind.types],
        // What the form asks for, in order, and how: the same facts the validation below reads.
        provider: kind.provider, credential: kind.credential, fields: [...kind.fields], authSchemes: [...kind.authSchemes],
        defaultBaseUrl: kind.defaultBaseUrl, modelsOptional: kind.modelsOptional, hints: { ...kind.hints },
      };
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
    // The one conversation this license is limited to ("" = every conversation). A stored limit
    // that names no conversation reads as limited and unusable, never as unlimited.
    channelId: normalizeLicenseChannelId(record.channelId),
    channelLimited: Boolean(record.channelId),
  };
  if (!kind.provider) return out;
  const has = (field) => kind.fields.includes(field);
  const account = has("serviceAccount") ? serviceAccountFacts(record.serviceAccount) : null;
  return {
    ...out,
    provider: kind.provider, endpoint: licenseEndpoint(record),
    ...(has("baseUrl") ? { baseUrl: record.baseUrl } : {}),
    ...(has("authScheme") ? { authScheme: record.authScheme } : {}),
    ...(has("region") ? { region: record.region } : {}),
    ...(has("projectId") ? { projectId: record.projectId } : {}),
    ...(has("apiVersion") ? { apiVersion: record.apiVersion } : {}),
    ...(has("apiKey") ? { hasApiKey: Boolean(record.apiKey), apiKeyLast4: record.apiKey ? record.apiKey.slice(-4) : "" } : {}),
    // Of a service-account key, only who it is — the address Google shows in its own console.
    ...(account ? { hasServiceAccount: Boolean(record.serviceAccount), serviceAccountEmail: account.email } : {}),
    models: record.models.map((model) => ({ ...model })),
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
const cleanLabel = cleanLicenseName;

// A name is unique across the added licenses AND everything the gateway ships with — under both
// names a shipped license answers to (its engine label, and what a picker calls it, which for a
// harness's own sign-in is "Default sign-in" or the name an administrator gave it). `names` is the
// `licenseNames` map as it will be stored, so a rename is checked against the state it writes.
function assertLabel(label, records, selfId = "", names = null) {
  if (!label) refuse("Give the license a name.");
  if (label.length > MAX_LICENSE_NAME_LENGTH) refuse(`A license name is at most ${MAX_LICENSE_NAME_LENGTH} characters.`);
  const wanted = label.toLowerCase();
  const pickerName = (id) => (names ? names[id] || (isDefaultLicense(id) ? DEFAULT_LICENSE_NAME : adapterFor(id)?.label) : licenseLabel(id));
  // "Default sign-in" stays reserved even while both harnesses' sign-ins carry another name:
  // clearing a name puts it back.
  const taken = wanted === DEFAULT_LICENSE_NAME.toLowerCase()
    || records.some((record) => record.id !== selfId && record.label.toLowerCase() === wanted)
    || engineRegistry.builtinIds.some((id) => id !== selfId && [adapterFor(id)?.label, pickerName(id)].some((name) => String(name || "").toLowerCase() === wanted));
  if (taken) refuse(`Another license is already called "${label}".`, 409);
}

// The provider fields of one license, validated against what its KIND asks for (license-state.js
// `fields`). A blank credential on an edit keeps the stored one — the form never has it to send back.
const urlHost = (value) => { try { return new URL(value).host.toLowerCase(); } catch { return ""; } };
const PROVIDER_NAMES = Object.freeze({ custom: "server", bedrock: "Amazon Bedrock", vertex: "Google Vertex AI", azure: "Azure" });
function providerFields(kind, input, previous = null) {
  const has = (field) => kind.fields.includes(field);
  const text = (name) => String(input[name] ?? previous?.[name] ?? "").trim();
  const out = {};
  if (has("baseUrl")) {
    out.baseUrl = (text("baseUrl") || kind.defaultBaseUrl).replace(/\/+$/, "");
    if (!LICENSE_BASE_URL_RE.test(out.baseUrl)) refuse("Enter the endpoint as an https:// URL (host, optional port and path).");
  }
  if (has("region")) {
    out.region = text("region").toLowerCase();
    if (!isLicenseRegion(kind.provider, out.region)) {
      refuse(kind.provider === "vertex" ? "Enter the Vertex AI location, e.g. global or europe-west1." : "Enter the AWS region, e.g. eu-central-1.");
    }
  }
  if (has("apiVersion")) {
    out.apiVersion = text("apiVersion");
    if (out.apiVersion && !API_VERSION_RE.test(out.apiVersion)) refuse("An API version holds letters, digits and . _ - only, e.g. 2025-04-01-preview.");
  }
  if (has("apiKey")) {
    const typed = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (typed && (/\s/.test(typed) || typed.length > 4096 || typed.length < 8)) refuse("That does not look like an API key.");
    out.apiKey = typed || previous?.apiKey || "";
    if (!out.apiKey) refuse(kind.provider === "bedrock" ? "Enter the Bedrock API key." : "Enter the API key.");
    // A stored key is only ever sent to the server it was saved for. An edit that moves the
    // endpoint to another host — including a cleared box falling back to the kind's default
    // server — has to bring the key with it, or the old server's key would silently start going
    // to the new one.
    if (!typed && previous?.apiKey && has("baseUrl") && previous.baseUrl && urlHost(out.baseUrl) !== urlHost(previous.baseUrl)) {
      refuse(`Re-enter the API key to move this license to ${urlHost(out.baseUrl)}: the stored key is only sent to ${urlHost(previous.baseUrl)}.`);
    }
  }
  if (has("serviceAccount")) {
    const typed = typeof input.serviceAccount === "string" ? input.serviceAccount.trim() : "";
    if (typed.length > MAX_SERVICE_ACCOUNT_BYTES) refuse("That service-account key file is too large.");
    const parsed = typed ? normalizeServiceAccount(typed) : "";
    if (typed && !parsed) refuse("Paste the whole service-account key file (the JSON with \"type\": \"service_account\", client_email and private_key).");
    out.serviceAccount = parsed || previous?.serviceAccount || "";
    if (!out.serviceAccount) refuse("Paste the service-account key file (JSON).");
  }
  if (has("projectId")) {
    // Blank takes the project the key file itself names — the usual case, one project, one key.
    out.projectId = text("projectId") || (has("serviceAccount") ? serviceAccountFacts(out.serviceAccount).projectId : "");
    if (!GCP_PROJECT_RE.test(out.projectId)) refuse("Enter the Google Cloud project ID (6–30 lowercase letters, digits and hyphens).");
  }
  out.authScheme = input.authScheme === undefined || !has("authScheme") ? previous?.authScheme || kind.authSchemes[0] : input.authScheme;
  if (!kind.authSchemes.includes(out.authScheme)) refuse(`Choose how the key is sent: ${kind.authSchemes.join(" or ")}.`);
  const rawModels = input.models === undefined ? previous?.models || [] : input.models;
  if (!Array.isArray(rawModels)) refuse("List the models as an array.");
  const listed = new Set(rawModels.map((entry) => String(typeof entry === "string" ? entry : entry?.value ?? "").trim()).filter(Boolean));
  if (listed.size > MAX_LICENSE_MODELS) refuse(`A license lists at most ${MAX_LICENSE_MODELS} models; this list has ${listed.size}.`);
  const models = normalizeLicenseModels(rawModels);
  if (models.length !== rawModels.filter((entry) => String(typeof entry === "string" ? entry : entry?.value ?? "").trim()).length) {
    refuse("A model id may hold letters, digits and . _ : / @ [ ] - only, and each may be listed once.");
  }
  // Only the harness vendor's own API — and the cloud routes Claude Code maps its aliases for —
  // can be asked for "the default model"; any other server has to be told which ids it serves.
  const candidate = { kind: kind.id, ...out };
  const optional = kind.modelsOptional && (kind.provider !== "custom" || licenseIsVendorApi(candidate));
  if (!models.length && !optional) {
    refuse(kind.provider === "custom" ? "List at least one model id this server serves." : `List at least one model id to use on ${PROVIDER_NAMES[kind.provider]}.`);
  }
  // A changed credential or destination is an unverified one: yesterday's verdict says nothing about it.
  const unchanged = previous && sameCredential(previous, out);
  return { ...out, models: models.map((model) => ({ ...model })), verification: unchanged ? previous.verification : null };
}
// The members a verification verdict is ABOUT.
const CREDENTIAL_MEMBERS = Object.freeze(["baseUrl", "apiKey", "authScheme", "region", "projectId", "serviceAccount", "apiVersion"]);
const sameCredential = (a, b) => CREDENTIAL_MEMBERS.every((name) => (a?.[name] ?? "") === (b?.[name] ?? ""));

// `onSaved` receives the settings as this write stored them (its `settingsRev` is the version this
// write produced), for a caller that reports which version its own write moved the settings to.
const writeLicenses = (mutate, onSaved = null) => {
  let result;
  const saved = saveSettings((current) => {
    const records = stored(current).map((record) => ({ ...record }));
    const patch = mutate(records, current);
    result = patch.result;
    return patch.settings;
  });
  onSaved?.(saved);
  return result;
};

// The conversation a form limits the license to (engines/license-state.js): "" for every
// conversation, else one conversation id. Not sent = unchanged. Whether that conversation EXISTS
// is the caller's question (web/routes/licenses.js asks the channel index); the id's shape is ours.
function channelLimit(input, previous = null) {
  if (input.channelId === undefined) return previous?.channelId || "";
  if (input.channelId === null || input.channelId === "") return "";
  const id = normalizeLicenseChannelId(input.channelId);
  if (!id) refuse("Choose the conversation this license is limited to.");
  return id;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────────────────────
export function createLicense(input = {}) {
  const kind = LICENSE_KINDS[input.kind];
  if (!kind) refuse("Choose what kind of license this is.");
  const type = input.type === undefined || input.type === "" ? kind.types[0] : input.type;
  if (!kind.types.includes(type)) refuse(`A ${kind.label} license is one of: ${kind.types.map(licenseTypeLabel).join(", ")}.`);
  const label = cleanLabel(input.label);
  const channelId = channelLimit(input);
  if (channelId) assertChannelLimitedLicensesEntitled();
  return writeLicenses((records, current) => {
    if (records.length >= MAX_ENGINE_LICENSES) refuse(`A gateway holds at most ${MAX_ENGINE_LICENSES} added licenses.`, 409);
    assertLabel(label, records);
    let id = "";
    do { id = `${kind.prefix}${randomBytes(4).toString("hex")}`; } while (records.some((record) => record.id === id));
    const record = normalizeLicenseRecord({
      id, kind: kind.id, label, type, createdAt: new Date().toISOString(),
      ...(channelId ? { channelId } : {}),
      ...(kind.provider ? providerFields(kind, input) : {}),
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
  return writeLicenses((records, current) => {
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) refuse("That license no longer exists.", 404);
    const previous = records[index];
    const kind = LICENSE_KINDS[previous.kind];
    const label = input.label === undefined ? previous.label : cleanLabel(input.label);
    assertLabel(label, records, id);
    const type = input.type === undefined ? previous.type : input.type;
    if (!kind.types.includes(type)) refuse(`A ${kind.label} license is one of: ${kind.types.map(licenseTypeLabel).join(", ")}.`);
    const channelId = channelLimit(input, previous);
    // Limiting a license (or moving its limit) takes it away from everywhere else. Clearing a
    // limit needs nothing: it is the way out after a downgrade.
    const limiting = Boolean(channelId) && channelId !== (previous.channelId || "");
    let defaults = {};
    if (limiting) {
      assertChannelLimitedLicensesEntitled();
      if (!previous.channelId) {
        // The gateway must be left with something every conversation can run on, exactly as when
        // a license is deleted — and whatever named this one as the GATEWAY's default moves on.
        const survivors = ENGINE_IDS.filter((other) => other !== id && isGatewayWideLicense(other) && isEngineEnabled(other));
        if (isEngineEnabled(id) && !survivors.length) {
          refuse(`${previous.label} is the only license switched on for the whole gateway. Switch another one on (and save) before limiting it to one conversation.`, 409);
        }
        const pool = Array.isArray(current.enginePool) ? current.enginePool.filter((entry) => entry !== id) : current.enginePool;
        defaults = current.engine === id ? { engine: previous.harness, enginePool: "" } : pool !== current.enginePool ? { enginePool: pool } : {};
      }
    }
    const { channelId: _limit, ...kept } = previous;
    const record = normalizeLicenseRecord({
      ...kept, label, type,
      ...(channelId ? { channelId } : {}),
      ...(kind.provider ? providerFields(kind, input, previous) : {}),
    });
    if (!record) refuse("The license could not be stored.");
    const next = [...records];
    next[index] = record;
    // A default model this license no longer lists goes with the listing (and the effort chosen
    // for it): it would never reach a run, but every picker would keep showing it as the default.
    const defaultModel = String(current[licenseDefaultModelKey(id)] || "").trim().toLowerCase();
    const listed = Array.isArray(record.models) ? record.models.map((model) => String(model.value || "").toLowerCase()) : [];
    const staleDefault = Boolean(defaultModel && listed.length && !listed.includes(defaultModel));
    return {
      result: record,
      settings: { engineLicenses: next, ...defaults, ...(staleDefault ? { [licenseDefaultModelKey(id)]: "", [licenseDefaultEffortKey(id)]: "" } : {}) },
    };
  });
}

// Removes the record and everything that named it as a DEFAULT. Channels and threads that still
// reference the id fall through to their next level: the id no longer resolves to an engine,
// exactly like a retired one. The readers that make that true are the conversation projection
// (gateway/effective-meta.js), the thread pin (gateway/thread-engine.js) and the session stamp
// (gateway/sessions.js) — a thread whose live session this license minted continues on the
// conversation's current selection in a fresh session with the chat transcript replayed.
export async function deleteLicense(id) {
  const removed = writeLicenses((records, current) => {
    const record = records.find((entry) => entry.id === id);
    if (!record) refuse("That license no longer exists.", 404);
    // The gateway must be left with something to run, exactly as for a shipped license
    // (removeBuiltinLicense): the read-time rescue (settings.js isEngineEnabled) would otherwise
    // switch the default harnesses back on behind the administrator's back.
    // A license limited to one conversation is not something the gateway can run on, so it is
    // neither a survivor nor ever the last one.
    const survivors = ENGINE_IDS.filter((other) => other !== id && isGatewayWideLicense(other) && isEngineEnabled(other));
    if (isGatewayWideLicense(id) && isEngineEnabled(id) && !survivors.length) {
      refuse(`${record.label} is the only license switched on. Switch another one on (and save) before deleting it.`, 409);
    }
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
  // The license's own directory goes with it: a sign-in's login, or a provider license's sessions
  // from direct-host runs. The path is built from a shape-checked id only.
  if (licenseKindOfId(id)) {
    await rm(licenseLoginHome(id), { recursive: true, force: true }).catch(() => {});
  }
  if (removed.serviceAccount) (await import("../gateway/vertex-token.js")).forgetVertexToken(removed.serviceAccount);
  return removed;
}

// ── The licenses the gateway ships with ───────────────────────────────────────────────────────
// They are not records, so they are not edited or deleted like one. Two things can be done to
// them, and which one depends on what the license is (engines/registry.js):
//   • a harness's own sign-in (`claude`, `codex`) can be RENAMED — and never removed, because it
//     is what every selection falls back to;
//   • every other shipped license (the dedicated logins, the provider table) can be REMOVED, and
//     RESTORED later. Removed means switched off for good, listed nowhere and its own credential
//     deleted; the id stays registered so stored sessions, usage rows and locks keep reading.
const enabledMap = (current) => ({ ...(current.engineEnabled && typeof current.engineEnabled === "object" ? current.engineEnabled : {}) });

export function builtinLicenseForApi(id) {
  const adapter = adapterFor(id);
  if (!adapter || !engineRegistry.isBuiltin(id)) return null;
  const harness = harnessOf(id);
  return {
    id, builtin: true, harness, harnessLabel: harnessLabel(harness), label: licenseLabel(id), engineLabel: adapter.label,
    // What it is called with no stored name: "Default sign-in", or the label it ships with.
    shippedLabel: isDefaultLicense(id) ? DEFAULT_LICENSE_NAME : adapter.label,
    defaultLicense: isDefaultLicense(id), removable: isRemovableBuiltinLicense(id), removed: isRemovedLicense(id),
  };
}
// The shipped licenses an administrator removed, for the list that offers to restore them.
export const listRemovedBuiltinLicenses = () => removedBuiltinLicenses().map(builtinLicenseForApi).filter(Boolean);

// Names a shipped license. A blank name goes back to what it ships as: "Default sign-in" for a
// harness's own sign-in, the shipped label for any other.
export function renameBuiltinLicense(id, label) {
  if (!engineRegistry.isBuiltin(id)) refuse("That license no longer exists.", 404);
  if (isRemovedLicense(id)) refuse("That license was removed. Restore it before renaming it.", 409);
  const shipped = isDefaultLicense(id) ? DEFAULT_LICENSE_NAME : adapterFor(id).label;
  const name = cleanLabel(label);
  let previous = "";
  saveSettings((current) => {
    const names = normalizeLicenseNames(current.licenseNames);
    previous = names[id] || "";
    // Typing the shipped name back is the same as clearing the box.
    const custom = name.toLowerCase() === shipped.toLowerCase() ? "" : name;
    if (custom) {
      names[id] = custom;
      // Checked against the map being written, so the other harness's sign-in is compared under
      // the name it will have.
      assertLabel(custom, stored(current), id, names);
    } else delete names[id];
    return { licenseNames: names };
  });
  return { ...builtinLicenseForApi(id), previousLabel: previous || shipped };
}

// Removes a shipped license: off, unlisted, and what it stored for itself deleted — its settings
// keys in the same write, its sign-in directory right after. Like deleteLicense, everything that
// named it as a DEFAULT moves on; a channel or thread that still names it falls through to its
// next level, exactly as it does for a license that is switched off.
export async function removeBuiltinLicense(id) {
  const adapter = adapterFor(id);
  if (!adapter || !engineRegistry.isBuiltin(id)) refuse("That license no longer exists.", 404);
  if (isDefaultLicense(id)) refuse(`${harnessLabel(harnessOf(id))}'s own sign-in cannot be removed. Rename it, or switch it off.`, 400);
  const own = adapter.ownCredential || null;
  saveSettings((current) => {
    const removed = normalizeRemovedLicenses(current.removedLicenses);
    if (removed.includes(id)) refuse("That license is already removed.", 409);
    // The gateway must be left with something to run. A removed license cannot count, and the
    // read-time rescue (settings.js isEngineEnabled) would otherwise switch a default harness
    // back on behind the administrator's back.
    const survivors = ENGINE_IDS.filter((other) => other !== id && isGatewayWideLicense(other) && isEngineEnabled(other));
    if (!adapter.channelScoped && isEngineEnabled(id) && !survivors.length) {
      refuse(`${adapter.label} is the only license switched on. Switch another one on (and save) before removing it.`, 409);
    }
    const enabled = enabledMap(current);
    enabled[id] = false;
    const pool = Array.isArray(current.enginePool) ? current.enginePool.filter((entry) => entry !== id) : current.enginePool;
    return {
      removedLicenses: [...removed, id],
      engineEnabled: enabled,
      [adapter.defaultModelKey]: "",
      [adapter.defaultEffortKey]: "",
      ...Object.fromEntries((own?.settingsKeys || []).map((key) => [key, ""])),
      ...(current.engine === id ? { engine: harnessOf(id), enginePool: "" } : pool !== current.enginePool ? { enginePool: pool } : {}),
    };
  });
  // The dedicated sign-in goes with it. The path comes from the adapter's own fact, never from
  // the request.
  if (typeof own?.directory === "function") await rm(own.directory(), { recursive: true, force: true }).catch(() => {});
  return { ...builtinLicenseForApi(id), ownCredential: own?.kind || "" };
}

// Lists a removed shipped license again, in the state a fresh install has it: an opt-in license
// comes back switched OFF and without a credential — restoring one never starts routing turns.
export function restoreBuiltinLicense(id) {
  if (!adapterFor(id) || !isRemovableBuiltinLicense(id)) refuse("That license no longer exists.", 404);
  saveSettings((current) => {
    const removed = normalizeRemovedLicenses(current.removedLicenses);
    if (!removed.includes(id)) refuse("That license is not removed.", 409);
    const enabled = enabledMap(current);
    delete enabled[id];
    return { removedLicenses: removed.filter((entry) => entry !== id), engineEnabled: enabled };
  });
  return builtinLicenseForApi(id);
}

// ── Verification ──────────────────────────────────────────────────────────────────────────────
// A sign-in license is verified by reading what its own login reports (plan vs declared type), so
// its verdict is always live. A provider license is verified by asking its server (or, for Vertex,
// Google's token endpoint), on demand, and the answer is stored beside the record.
export async function verifyLicense(id, { fetchImpl = publicPinnedFetch } = {}) {
  const record = getLicenseRecord(id);
  if (!record) refuse("That license no longer exists.", 404);
  if (!isProviderKind(record.kind)) {
    const status = await licenseStatusFor(id);
    return { license: licenseForApi(record), status, verification: { ok: status.ready, verified: status.plan?.matches === true, detail: status.plan?.detail || status.detail || "" } };
  }
  const verdict = await verifyProviderLicense(record, { fetchImpl });
  const verification = { at: new Date().toISOString(), ok: verdict.ok, verified: verdict.verified, detail: verdict.detail };
  // Storing the verdict moves the settings version by exactly one. The admin page echoes the
  // version it was painted from on Save, so it is told which step was this check's own: a page
  // holding unsaved edits can then follow it instead of having its next Save refused as "changed
  // elsewhere" by a button it pressed itself.
  let settingsVersion = null;
  const noteVersion = (stored_) => {
    const to = Number(stored_?.settingsRev);
    if (Number.isFinite(to) && to >= 1) settingsVersion = { from: String(to - 1), to: String(to) };
  };
  const saved = writeLicenses((records) => {
    const index = records.findIndex((entry) => entry.id === id);
    if (index < 0) refuse("That license no longer exists.", 404);
    // Only stamp the credential that was actually checked: an edit that landed meanwhile keeps
    // its own (empty) verdict rather than inheriting one for a key it no longer holds.
    const current = records[index];
    if (!sameCredential(current, record)) return { result: current, settings: {} };
    const next = [...records];
    next[index] = normalizeLicenseRecord({ ...current, verification });
    return { result: next[index], settings: { engineLicenses: next } };
  }, noteVersion);
  return { license: licenseForApi(saved), status: await licenseStatusFor(id), verification, ...(settingsVersion ? { settingsVersion } : {}) };
}

export { licenseApiHost };
