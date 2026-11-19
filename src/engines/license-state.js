// Harnesses and licenses — the dependency-free facts.
//
// A HARNESS is a coding CLI the gateway drives: Claude Code or Codex. There are only those. A
// LICENSE is one credential + server a harness can run on: the operator's own sign-in, a second
// ChatGPT workspace, a separate Claude subscription, an API key for an Anthropic-compatible
// endpoint. An administrator adds as many as they hold; a channel picks a harness, then one
// license, several, or any (src/gateway/license-pool.js), and the gateway moves to the next one
// when a license fails.
//
// Every license is an engine adapter (src/engines/license-adapters.js), so sessions, usage rows,
// thread pins and approved-harness policies keep naming it by one stable id. The harnesses the
// gateway ships with — `claude`, `codex`, the dedicated logins and the provider table — are the
// BUILT-IN licenses of their harness; what an admin adds is a record in settings.json under
// `engineLicenses`, mirrored here.
//
// This module holds no settings import on purpose: the egress rules, the Codex login paths and
// the credential gate read it synchronously, and src/config/settings.js imports the engine
// registry. settings.js pushes the stored records in (`setLicenseRecords`) whenever it reads a
// changed list, so both processes that open settings.json converge without a restart.
import path from "node:path";
import { gatewayRoot } from "../config/paths.js";

export const HARNESSES = Object.freeze([
  Object.freeze({ id: "claude", label: "Claude Code" }),
  Object.freeze({ id: "codex", label: "Codex" }),
]);
export const HARNESS_IDS = Object.freeze(HARNESSES.map((harness) => harness.id));
export const isHarnessId = (value) => HARNESS_IDS.includes(value);
export const harnessLabel = (id) => HARNESSES.find((harness) => harness.id === id)?.label || String(id || "");

// What a license IS, commercially. Declared by the admin and checked against what the sign-in
// itself reports wherever the provider says (see licenseTypeFromPlan); an API key reports no plan.
export const LICENSE_TYPES = Object.freeze([
  Object.freeze({ id: "subscription", label: "Subscription (personal plan)" }),
  Object.freeze({ id: "business", label: "Business / Team plan" }),
  Object.freeze({ id: "enterprise", label: "Enterprise plan" }),
  Object.freeze({ id: "education", label: "Education plan" }),
  Object.freeze({ id: "api", label: "API (pay per token)" }),
]);
export const LICENSE_TYPE_IDS = Object.freeze(LICENSE_TYPES.map((type) => type.id));
export const licenseTypeLabel = (id) => LICENSE_TYPES.find((type) => type.id === id)?.label || String(id || "");

// HOW a license authenticates. The id prefix names the kind — and therefore the harness — so a
// stored reference to a license that was deleted since can still be read for what it was.
export const LICENSE_KINDS = Object.freeze({
  "codex-login": Object.freeze({
    id: "codex-login", harness: "codex", prefix: "codex-lic-", label: "ChatGPT sign-in",
    description: "A separate ChatGPT sign-in for Codex, kept in its own directory on the gateway host.",
    types: Object.freeze(["subscription", "business", "enterprise", "education"]),
  }),
  "claude-login": Object.freeze({
    id: "claude-login", harness: "claude", prefix: "claude-lic-", label: "Claude sign-in",
    description: "A separate Claude sign-in for Claude Code, kept in its own directory on the gateway host.",
    types: Object.freeze(["subscription", "business", "enterprise"]),
  }),
  "claude-api": Object.freeze({
    id: "claude-api", harness: "claude", prefix: "claude-api-", label: "API key",
    description: "An API key for the Anthropic API or an Anthropic-compatible endpoint, run through Claude Code.",
    types: Object.freeze(["api", "business", "enterprise"]),
  }),
});
export const LICENSE_KIND_IDS = Object.freeze(Object.keys(LICENSE_KINDS));
export const API_AUTH_SCHEMES = Object.freeze(["bearer", "x-api-key"]);
export const MAX_LICENSE_MODELS = 40;

const LICENSE_ID_RE = /^(codex-lic|claude-lic|claude-api)-[a-f0-9]{8}$/;
export const isLicenseShapedId = (value) => typeof value === "string" && LICENSE_ID_RE.test(value);
export function licenseKindOfId(id) {
  if (!isLicenseShapedId(id)) return null;
  return Object.values(LICENSE_KINDS).find((kind) => id.startsWith(kind.prefix)) || null;
}
// The harness a license-shaped id belongs to, whether or not that license still exists.
export const harnessOfLicenseId = (id) => licenseKindOfId(id)?.harness || "";

// An endpoint is dialed with the license's key, so it is held to the same shape as every other
// provider endpoint the admin API stores: https, a plain host, an optional port and path.
export const LICENSE_BASE_URL_RE = /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[\w./-]*)?$/i;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,127}$/;
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

export function normalizeLicenseModels(value) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const id = clean(typeof raw === "string" ? raw : raw?.value, 128);
    if (!id || seen.has(id) || !MODEL_ID_RE.test(id)) continue;
    seen.add(id);
    out.push(Object.freeze({ value: id, label: clean(typeof raw === "string" ? raw : raw?.label, 80) || id }));
    if (out.length >= MAX_LICENSE_MODELS) break;
  }
  return Object.freeze(out);
}

// One stored record → the frozen shape every reader gets, or null when it cannot be a license (a
// hand-edited entry never becomes an adapter that would fail every turn in an unexplained way).
export function normalizeLicenseRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kind = licenseKindOfId(raw.id);
  if (!kind || raw.kind !== kind.id) return null;
  const label = clean(raw.label, 60);
  if (!label) return null;
  const type = kind.types.includes(raw.type) ? raw.type : kind.types[0];
  const base = { id: raw.id, kind: kind.id, harness: kind.harness, label, type, createdAt: clean(raw.createdAt, 40) };
  if (kind.id !== "claude-api") return Object.freeze(base);
  const baseUrl = clean(raw.baseUrl, 300).replace(/\/+$/, "");
  return Object.freeze({
    ...base,
    baseUrl: LICENSE_BASE_URL_RE.test(baseUrl) ? baseUrl : "",
    apiKey: typeof raw.apiKey === "string" && !/\s/.test(raw.apiKey.trim()) ? raw.apiKey.trim().slice(0, 4096) : "",
    authScheme: API_AUTH_SCHEMES.includes(raw.authScheme) ? raw.authScheme : "x-api-key",
    models: normalizeLicenseModels(raw.models),
    verification: normalizeLicenseVerification(raw.verification),
  });
}

// The last answer the endpoint gave to this license's key (src/config/engine-licenses.js). It is
// a record of a check, never a credential: when, whether the endpoint was reached, and its verdict.
function normalizeLicenseVerification(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const at = clean(raw.at, 40);
  if (!at) return null;
  return Object.freeze({ at, ok: raw.ok === true, verified: raw.verified === true, detail: clean(raw.detail, 300) });
}

export function normalizeLicenseRecords(value) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const record = normalizeLicenseRecord(raw);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    out.push(record);
  }
  return out;
}

// ── License selections ───────────────────────────────────────────────────────────────────────
// Beside the license a channel, thread or the gateway runs on first, a selection may name MORE
// licenses of the same harness to move to when that one fails: "" (none — just the one license),
// "any" (every license of the harness the conversation may use) or an ordered list of ids. This
// is the lenient READER of a stored value (settings.json, channel meta, a thread override row,
// where a list is JSON text); writers validate through src/gateway/license-pool.js.
export const LICENSE_POOL_ANY = "any";
export function readLicensePool(value) {
  if (value === LICENSE_POOL_ANY) return LICENSE_POOL_ANY;
  let list = value;
  if (typeof value === "string" && value.startsWith("[")) {
    try { list = JSON.parse(value); } catch { return ""; }
  }
  if (!Array.isArray(list)) return "";
  const ids = [...new Set(list.filter((id) => typeof id === "string" && id && id.length <= 64))].slice(0, 64);
  return ids.length ? ids : "";
}
export const storeLicensePool = (pool) => (Array.isArray(pool) ? JSON.stringify(pool) : pool === LICENSE_POOL_ANY ? LICENSE_POOL_ANY : "");

// ── The live snapshot ─────────────────────────────────────────────────────────────────────────
let records = new Map();
export function setLicenseRecords(value) {
  const list = normalizeLicenseRecords(value);
  records = new Map(list.map((record) => [record.id, record]));
  return list;
}
export const licenseRecords = () => [...records.values()];
export const licenseRecord = (id) => records.get(String(id || "")) || null;

// ── Where a sign-in license keeps its login ───────────────────────────────────────────────────
// On the gateway host, one 0700 directory per license; never mounted into a channel container.
export function licenseLoginHome(id) {
  if (!isLicenseShapedId(id)) throw new Error("not a license id");
  return path.join(gatewayRoot(), "engine-state", "licenses", id);
}
// Inside a container, a directory in the channel's own HOME volume: the license's session
// transcripts live there, apart from every other license's, and nothing of the host login does.
export function licenseContainerDir(id, containerHome = "/home/agent") {
  if (!isLicenseShapedId(id)) throw new Error("not a license id");
  return `${String(containerHome || "/home/agent").replace(/\/+$/, "")}/.cg-licenses/${id}`;
}

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
// The command an operator runs on the gateway host, as the service user, to sign a license in.
export function licenseLoginCommand(record) {
  if (!record || record.kind === "claude-api") return "";
  const home = shellQuote(licenseLoginHome(record.id));
  return record.kind === "codex-login"
    ? `install -d -m 700 ${home} && CODEX_HOME=${home} codex -c cli_auth_credentials_store='"file"' login --device-auth`
    : `install -d -m 700 ${home} && CLAUDE_CONFIG_DIR=${home} claude`;
}

// ── Relay names (src/gateway/egress/) ─────────────────────────────────────────────────────────
// A proxy-mode container holds a placeholder per license, keyed by a relay name that carries the
// license id, so two licenses of one harness can never be swapped for each other's credential.
const RELAY_PREFIX = Object.freeze({ "codex-login": "CODEX_LICENSE_ACCESS_TOKEN:", "claude-login": "CLAUDE_LICENSE_OAUTH_TOKEN:", "claude-api": "CLAUDE_LICENSE_API_KEY:" });
export function licenseRelaySecretName(id) {
  const kind = licenseKindOfId(id);
  if (!kind) throw new Error("not a license id");
  return `${RELAY_PREFIX[kind.id]}${id}`;
}
// → { id, kind } for a license relay name, else null. The id is shape-checked against the prefix.
export function licenseOfRelaySecret(secretName) {
  const name = String(secretName || "");
  for (const [kind, prefix] of Object.entries(RELAY_PREFIX)) {
    if (!name.startsWith(prefix)) continue;
    const id = name.slice(prefix.length);
    return licenseKindOfId(id)?.id === kind ? { id, kind } : null;
  }
  return null;
}

// The host an API license's requests go to, or "" (no endpoint stored, or not a URL).
export function licenseApiHost(record) {
  try {
    return record?.kind === "claude-api" && record.baseUrl ? new URL(record.baseUrl).hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}
// Every API license's endpoint host: destinations the engine itself needs, with network off too.
export const licenseApiHosts = () => [...new Set(licenseRecords().map(licenseApiHost).filter(Boolean))];

// ── Plan → type ───────────────────────────────────────────────────────────────────────────────
// What the provider's own sign-in says the plan is, as one of LICENSE_TYPE_IDS; "" when the plan
// is absent or not one this table knows (reported as "could not be verified", never as a match).
export function licenseTypeFromPlan(harness, plan) {
  const value = String(plan || "").trim().toLowerCase();
  if (!value) return "";
  if (/enterprise/.test(value)) return "enterprise";
  if (/^(?:edu|education|k12)/.test(value)) return "education";
  if (/^(?:team|business)/.test(value)) return "business";
  if (harness === "codex" && /^(?:free|go|plus|pro|prolite|pro_lite)$/.test(value)) return "subscription";
  if (harness === "claude" && /^(?:free|pro|max)/.test(value)) return "subscription";
  return "";
}

// The verdict the admin sees beside a license's declared type.
export function describeLicensePlan({ harness, declared, plan }) {
  const detected = licenseTypeFromPlan(harness, plan);
  if (!plan) return { detectedType: "", plan: "", matches: null, detail: "The sign-in reports no plan, so the type could not be verified." };
  if (!detected) return { detectedType: "", plan: String(plan), matches: null, detail: `The sign-in reports the plan "${plan}", which the gateway cannot map to a type.` };
  if (detected === declared) return { detectedType: detected, plan: String(plan), matches: true, detail: `Verified: the sign-in reports the plan "${plan}".` };
  return {
    detectedType: detected, plan: String(plan), matches: false,
    detail: `This license is declared as ${licenseTypeLabel(declared)}, but its sign-in reports the plan "${plan}" (${licenseTypeLabel(detected)}). Sign in with the intended account, or correct the license type.`,
  };
}
