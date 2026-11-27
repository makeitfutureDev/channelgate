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
//
// A SIGN-IN kind keeps a login directory on the gateway host. A PROVIDER kind (`provider` set) is a
// server plus a credential the gateway stores write-only: the harness is pointed at that server
// and a container holds the credential only as a placeholder the egress proxy swaps on that
// server's hosts. What a provider kind asks of the admin is declared here once (`fields`), so the
// form, the validation, the egress rule and the adapter all read the same facts:
//   • custom  — a base URL + key: the vendor's own API or any compatible server
//   • bedrock — Amazon Bedrock: a region + a Bedrock API key (a bearer token; request-signing AWS
//               keys cannot be relayed, because a placeholder cannot be substituted after signing)
//   • vertex  — Google Vertex AI: project + location + a service-account key the DAEMON turns into
//               short-lived access tokens; the key itself never leaves the gateway
//   • azure   — Microsoft Azure: the resource endpoint + key (Foundry for Claude, Azure OpenAI for Codex)
const SIGN_IN_TYPES = Object.freeze(["subscription", "business", "enterprise"]);
const PROVIDER_TYPES = Object.freeze(["api", "business", "enterprise"]);
const kindFacts = (facts) => Object.freeze({
  provider: "", credential: "login", fields: Object.freeze([]), authSchemes: Object.freeze([]), relayHeaders: Object.freeze([]),
  defaultBaseUrl: "", modelsOptional: false, hints: Object.freeze({}),
  ...facts,
  types: Object.freeze([...facts.types]),
  ...(facts.fields ? { fields: Object.freeze([...facts.fields]) } : {}),
  ...(facts.authSchemes ? { authSchemes: Object.freeze([...facts.authSchemes]) } : {}),
  ...(facts.relayHeaders ? { relayHeaders: Object.freeze([...facts.relayHeaders]) } : {}),
  ...(facts.hints ? { hints: Object.freeze({ ...facts.hints }) } : {}),
});
export const LICENSE_KINDS = Object.freeze({
  "codex-login": kindFacts({
    id: "codex-login", harness: "codex", prefix: "codex-lic-", relay: "CODEX_LICENSE_ACCESS_TOKEN:", label: "ChatGPT sign-in",
    description: "A separate ChatGPT sign-in for Codex, kept in its own directory on the gateway host.",
    types: [...SIGN_IN_TYPES, "education"],
  }),
  "codex-api": kindFacts({
    id: "codex-api", harness: "codex", prefix: "codex-api-", relay: "CODEX_LICENSE_API_KEY:", label: "API key or custom server",
    description: "An API key for the OpenAI API, or for any server that speaks the OpenAI Responses API. Codex is pointed at that server with this key.",
    types: PROVIDER_TYPES, provider: "custom", credential: "key",
    fields: ["baseUrl", "apiKey", "models"], authSchemes: ["bearer"], relayHeaders: ["authorization"],
    defaultBaseUrl: "https://api.openai.com/v1", modelsOptional: true,
    hints: { baseUrl: "https://api.openai.com/v1", models: "Optional for api.openai.com. Any other server: the model ids it serves." },
  }),
  "codex-aws": kindFacts({
    id: "codex-aws", harness: "codex", prefix: "codex-aws-", relay: "CODEX_LICENSE_AWS_KEY:", label: "Amazon Bedrock",
    description: "OpenAI models on Amazon Bedrock, through Codex's own Bedrock provider. Needs a Bedrock API key (not an AWS access key) and the region.",
    types: PROVIDER_TYPES, provider: "bedrock", credential: "key",
    fields: ["region", "apiKey", "models"], authSchemes: ["bearer"], relayHeaders: ["authorization"],
    hints: { region: "eu-central-1", models: "The Bedrock model ids to offer, e.g. openai.gpt-5.6-sol." },
  }),
  "codex-gcp": kindFacts({
    id: "codex-gcp", harness: "codex", prefix: "codex-gcp-", relay: "CODEX_LICENSE_GCP_TOKEN:", label: "Google Vertex AI",
    description: "OpenAI models on Google Vertex AI, through Codex's own Vertex provider. Needs the project, the location and a service-account key.",
    types: PROVIDER_TYPES, provider: "vertex", credential: "service-account",
    fields: ["projectId", "region", "serviceAccount", "models"], authSchemes: ["bearer"], relayHeaders: ["authorization"],
    hints: { region: "global", models: "The Vertex model ids to offer, e.g. gpt-6.2-sol." },
  }),
  "codex-azure": kindFacts({
    id: "codex-azure", harness: "codex", prefix: "codex-azure-", relay: "CODEX_LICENSE_AZURE_KEY:", label: "Microsoft Azure",
    description: "Azure OpenAI through Codex. Needs the resource's OpenAI v1 endpoint, its key and the deployment names.",
    types: PROVIDER_TYPES, provider: "azure", credential: "key",
    fields: ["baseUrl", "apiKey", "authScheme", "apiVersion", "models"], authSchemes: ["api-key", "bearer"], relayHeaders: ["authorization", "api-key"],
    hints: { baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/v1", models: "Your deployment names, one per line." },
  }),
  "claude-login": kindFacts({
    id: "claude-login", harness: "claude", prefix: "claude-lic-", relay: "CLAUDE_LICENSE_OAUTH_TOKEN:", label: "Claude sign-in",
    description: "A separate Claude sign-in for Claude Code, kept in its own directory on the gateway host.",
    types: SIGN_IN_TYPES,
  }),
  "claude-api": kindFacts({
    id: "claude-api", harness: "claude", prefix: "claude-api-", relay: "CLAUDE_LICENSE_API_KEY:", label: "API key or custom server",
    description: "An API key for the Anthropic API, or for any server that speaks the Anthropic Messages API. Claude Code is pointed at that server with this key.",
    types: PROVIDER_TYPES, provider: "custom", credential: "key",
    fields: ["baseUrl", "apiKey", "authScheme", "models"], authSchemes: ["x-api-key", "bearer"], relayHeaders: ["authorization", "x-api-key"],
    defaultBaseUrl: "https://api.anthropic.com", modelsOptional: true,
    hints: { baseUrl: "https://api.anthropic.com", models: "Optional for api.anthropic.com. Any other server: the model ids it serves." },
  }),
  "claude-aws": kindFacts({
    id: "claude-aws", harness: "claude", prefix: "claude-aws-", relay: "CLAUDE_LICENSE_AWS_KEY:", label: "Amazon Bedrock",
    description: "Claude on Amazon Bedrock. Needs a Bedrock API key (not an AWS access key) and the region.",
    types: PROVIDER_TYPES, provider: "bedrock", credential: "key",
    fields: ["region", "apiKey", "models"], authSchemes: ["bearer"], relayHeaders: ["authorization"], modelsOptional: true,
    hints: { region: "eu-central-1", models: "Optional: Bedrock model or inference-profile ids. Blank offers Opus, Sonnet and Haiku as Claude Code maps them." },
  }),
  "claude-gcp": kindFacts({
    id: "claude-gcp", harness: "claude", prefix: "claude-gcp-", relay: "CLAUDE_LICENSE_GCP_TOKEN:", label: "Google Vertex AI",
    description: "Claude on Google Vertex AI. Needs the project, the location and a service-account key.",
    types: PROVIDER_TYPES, provider: "vertex", credential: "service-account",
    fields: ["projectId", "region", "serviceAccount", "models"], authSchemes: ["bearer"], relayHeaders: ["authorization"], modelsOptional: true,
    hints: { region: "global", models: "Optional: Vertex model ids. Blank offers Opus, Sonnet and Haiku as Claude Code maps them." },
  }),
  "claude-azure": kindFacts({
    id: "claude-azure", harness: "claude", prefix: "claude-azure-", relay: "CLAUDE_LICENSE_AZURE_KEY:", label: "Microsoft Azure",
    description: "Claude in Microsoft Foundry on Azure. Needs the resource's Anthropic endpoint and its key.",
    types: PROVIDER_TYPES, provider: "azure", credential: "key",
    fields: ["baseUrl", "apiKey", "authScheme", "models"], authSchemes: ["x-api-key", "bearer"], relayHeaders: ["authorization", "x-api-key"], modelsOptional: true,
    hints: { baseUrl: "https://YOUR-RESOURCE.services.ai.azure.com/anthropic", models: "Optional: your deployment names. Blank offers Opus, Sonnet and Haiku as Claude Code maps them." },
  }),
});
export const LICENSE_KIND_IDS = Object.freeze(Object.keys(LICENSE_KINDS));
// Every way a key can be sent, across kinds; each kind lists the ones ITS server accepts.
export const API_AUTH_SCHEMES = Object.freeze(["bearer", "x-api-key", "api-key"]);
export const MAX_LICENSE_MODELS = 40;
export const MAX_SERVICE_ACCOUNT_BYTES = 16 * 1024;
// A provider kind stores a credential and a server; a sign-in kind stores neither.
export const isProviderKind = (kindId) => Boolean(LICENSE_KINDS[kindId]?.provider);
export const isProviderLicense = (record) => isProviderKind(record?.kind);

const LICENSE_ID_RE = new RegExp(`^(?:${Object.values(LICENSE_KINDS).map((kind) => kind.prefix.slice(0, -1)).join("|")})-[a-f0-9]{8}$`);
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

// ── Licenses limited to one conversation ──────────────────────────────────────────────────────
// A license is normally usable wherever its harness is. An administrator can LIMIT one to a single
// conversation — a customer's own account for the customer's channel: it then runs there (and in
// the code channels opened from it) and nowhere else, is offered in no other picker, and can be
// neither the gateway default nor part of the gateway's pool. Any kind can be limited, on both
// harnesses; the limit is one more fact of the record (`channelId`, a stored conversation id —
// Slack's bare, the other surfaces' namespaced, src/platforms/ids.js). Who enforces it is
// src/gateway/channel-engines.js; this file only says what the limit IS.
export const MAX_LICENSE_CHANNEL_ID_LENGTH = 300;
// A limit that was stored but cannot name a conversation. It matches none, so the license runs
// nowhere until an administrator picks a conversation again — never everywhere.
export const UNUSABLE_LICENSE_CHANNEL = "\u0000invalid";
export function normalizeLicenseChannelId(value) {
  if (typeof value !== "string") return "";
  const id = value.trim();
  return id && id.length <= MAX_LICENSE_CHANNEL_ID_LENGTH && !/[\s\u0000-\u001f\u007f]/.test(id) ? id : "";
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
  // The ONE conversation this license may run in, or absent for every conversation (see "Licenses
  // limited to one conversation" below). A stored value that is not an id never widens the license.
  const channelId = normalizeLicenseChannelId(raw.channelId);
  const base = {
    id: raw.id, kind: kind.id, harness: kind.harness, label, type, createdAt: clean(raw.createdAt, 40),
    ...(channelId ? { channelId } : raw.channelId ? { channelId: UNUSABLE_LICENSE_CHANNEL } : {}),
  };
  if (!kind.provider) return Object.freeze(base);
  const has = (field) => kind.fields.includes(field);
  const baseUrl = clean(raw.baseUrl, 300).replace(/\/+$/, "");
  const region = clean(raw.region, 40).toLowerCase();
  return Object.freeze({
    ...base,
    // A BLANK address means the vendor's own API. One that is stored but unusable never does: a
    // key issued by some other server must not be sent to the vendor because its address broke.
    ...(has("baseUrl") ? { baseUrl: LICENSE_BASE_URL_RE.test(baseUrl) ? baseUrl : baseUrl ? "" : kind.defaultBaseUrl } : {}),
    ...(has("apiKey") ? { apiKey: typeof raw.apiKey === "string" && !/\s/.test(raw.apiKey.trim()) ? raw.apiKey.trim().slice(0, 4096) : "" } : {}),
    authScheme: kind.authSchemes.includes(raw.authScheme) ? raw.authScheme : kind.authSchemes[0],
    ...(has("region") ? { region: isLicenseRegion(kind.provider, region) ? region : "" } : {}),
    ...(has("projectId") ? { projectId: GCP_PROJECT_RE.test(clean(raw.projectId, 40)) ? clean(raw.projectId, 40) : "" } : {}),
    ...(has("serviceAccount") ? { serviceAccount: normalizeServiceAccount(raw.serviceAccount) } : {}),
    ...(has("apiVersion") ? { apiVersion: API_VERSION_RE.test(clean(raw.apiVersion, 40)) ? clean(raw.apiVersion, 40) : "" } : {}),
    models: normalizeLicenseModels(raw.models),
    verification: normalizeLicenseVerification(raw.verification),
  });
}

// ── Provider fields ───────────────────────────────────────────────────────────────────────────
// Each value below ends up in a URL, an environment variable or a `-c` override of a CLI, so each
// is held to the provider's own published shape rather than "anything without spaces".
const AWS_REGION_RE = /^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:[a-z]+-)*[a-z]+-\d+$/;
const GCP_LOCATION_RE = /^(?:global|[a-z]+-[a-z]+\d+)$/;
export const GCP_PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const API_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const isLicenseRegion = (provider, value) => (provider === "bedrock" ? AWS_REGION_RE : provider === "vertex" ? GCP_LOCATION_RE : /^$/).test(String(value || ""));

// A Google service-account key file → the compact JSON the gateway keeps (only the members a
// token request needs), or "" when the text is not one. Accepts the stored compact form too.
export function normalizeServiceAccount(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_SERVICE_ACCOUNT_BYTES) return "";
  let parsed;
  try { parsed = JSON.parse(text); } catch { return ""; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  if (parsed.type !== undefined && parsed.type !== "service_account") return "";
  const email = typeof parsed.client_email === "string" ? parsed.client_email.trim() : "";
  const key = typeof parsed.private_key === "string" ? parsed.private_key : "";
  if (!/^[a-z0-9._-]{1,100}@[a-z0-9.-]{1,150}$/i.test(email) || !/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]{200,}-----END (?:RSA )?PRIVATE KEY-----/.test(key)) return "";
  return JSON.stringify({
    type: "service_account", client_email: email, private_key: key,
    private_key_id: clean(parsed.private_key_id, 80), project_id: GCP_PROJECT_RE.test(String(parsed.project_id || "")) ? parsed.project_id : "",
  });
}
// The non-secret facts of a stored service-account key (what a listing may show).
export function serviceAccountFacts(stored) {
  try {
    const parsed = JSON.parse(String(stored || ""));
    return { email: String(parsed.client_email || ""), projectId: String(parsed.project_id || ""), keyId: String(parsed.private_key_id || "") };
  } catch {
    return { email: "", projectId: "", keyId: "" };
  }
}
// Does this provider license hold the credential its kind runs on?
export function licenseCredentialStored(record) {
  const kind = LICENSE_KINDS[record?.kind];
  if (!kind?.provider) return false;
  return Boolean(kind.credential === "service-account" ? record.serviceAccount : record.apiKey);
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
// The conversation a license is limited to ("" = every conversation). Only an administrator-added
// license can carry one; an id that names no record is not limited by this.
export const licenseChannelOf = (id) => records.get(String(id || ""))?.channelId || "";
export const isChannelLimitedLicense = (id) => Boolean(licenseChannelOf(id));

// ── The licenses the gateway ships with: renamed, removed ─────────────────────────────────────
// A harness's own sign-in (`claude`, `codex`) is the one license that cannot be removed. Every
// shipped license can be NAMED by an administrator — "Default sign-in" or "Codex (channel
// account)" says little once three logins sit beside it. Every other shipped license (the dedicated logins, the provider table) can be REMOVED: it
// stays a registered engine id, so sessions, usage rows, thread pins and approved-harness policies
// that name it keep reading, but it is switched off for good, listed nowhere, and its credential is
// deleted (src/config/engine-licenses.js). Both are stored in settings.json (`licenseNames`,
// `removedLicenses`) and pushed in here beside the records, for the same reason they are.
export const DEFAULT_LICENSE_NAME = "Default sign-in";
export const MAX_LICENSE_NAME_LENGTH = 60;
export const cleanLicenseName = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
// Any shipped license may carry a stored name (a harness's own sign-in instead of "Default
// sign-in", another one instead of its shipped label). This file cannot know which ids are shipped,
// so it keeps id-shaped keys only and the registry reads a name for a built-in id alone.
export function normalizeLicenseNames(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const id of Object.keys(value).filter((key) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(key)).slice(0, 64)) {
    const name = typeof value[id] === "string" ? cleanLicenseName(value[id]) : "";
    if (name && name.length <= MAX_LICENSE_NAME_LENGTH) out[id] = name;
  }
  return out;
}
// Ids only, and never a harness's own sign-in: a hand-edited file cannot remove the last resort.
export function normalizeRemovedLicenses(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && !HARNESS_IDS.includes(id)))].slice(0, 64);
}
let licenseNames = {};
let removedLicenses = new Set();
export function setBuiltinLicenseState({ names, removed } = {}) {
  licenseNames = normalizeLicenseNames(names);
  removedLicenses = new Set(normalizeRemovedLicenses(removed));
}
export const builtinLicenseName = (id) => licenseNames[String(id || "")] || "";
export const isRemovedLicenseId = (id) => removedLicenses.has(String(id || ""));
export const removedLicenseIds = () => [...removedLicenses];

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
  if (!record || isProviderKind(record.kind)) return "";
  const home = shellQuote(licenseLoginHome(record.id));
  return record.kind === "codex-login"
    ? `install -d -m 700 ${home} && CODEX_HOME=${home} codex -c cli_auth_credentials_store='"file"' login --device-auth`
    : `install -d -m 700 ${home} && CLAUDE_CONFIG_DIR=${home} claude`;
}

// ── Relay names (src/gateway/egress/) ─────────────────────────────────────────────────────────
// A proxy-mode container holds a placeholder per license, keyed by a relay name that carries the
// license id, so two licenses of one harness can never be swapped for each other's credential.
const RELAY_PREFIX = Object.freeze(Object.fromEntries(Object.values(LICENSE_KINDS).map((kind) => [kind.id, kind.relay])));
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

// The base URL a provider license's harness is pointed at, or "" (nothing usable stored). For
// Bedrock and Vertex it follows from the region: the admin never types a hostname for them.
export function licenseEndpoint(record) {
  const kind = LICENSE_KINDS[record?.kind];
  if (!kind?.provider) return "";
  if (kind.provider === "bedrock") {
    if (!record.region) return "";
    return kind.harness === "codex" ? `https://bedrock-mantle.${record.region}.api.aws/openai/v1` : `https://bedrock-runtime.${record.region}.amazonaws.com`;
  }
  if (kind.provider === "vertex") {
    if (!record.region || !record.projectId) return "";
    const host = record.region === "global" || kind.harness === "codex" ? "aiplatform.googleapis.com" : `${record.region}-aiplatform.googleapis.com`;
    return kind.harness === "codex"
      ? `https://${host}/v1/projects/${record.projectId}/locations/${record.region}/publishers/openai/v1`
      : `https://${host}/v1`;
  }
  return record.baseUrl || "";
}
// The hosts a provider license's credential is sent to: where its placeholder is swapped, and what
// the egress proxy admits as an engine destination with the network switch off.
export function licenseHosts(record) {
  try {
    const endpoint = licenseEndpoint(record);
    return endpoint ? [new URL(endpoint).hostname.toLowerCase()] : [];
  } catch {
    return [];
  }
}
// Is this the harness vendor's OWN API (Anthropic's for Claude Code, OpenAI's for Codex)? Only
// there does the harness know the model catalog and the prices without being told.
const VENDOR_API_HOSTS = Object.freeze({ claude: "api.anthropic.com", codex: "api.openai.com" });
export function licenseIsVendorApi(record) {
  const kind = LICENSE_KINDS[record?.kind];
  return kind?.provider === "custom" && licenseHosts(record)[0] === VENDOR_API_HOSTS[kind.harness];
}
// The first of them, or "" (kept for callers that name one endpoint host).
export const licenseApiHost = (record) => licenseHosts(record)[0] || "";
// Every provider license's hosts: destinations the engine itself needs, with network off too.
export const licenseApiHosts = () => [...new Set(licenseRecords().flatMap(licenseHosts))];

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
