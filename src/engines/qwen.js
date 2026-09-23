// Anthropic-compatible third-party providers, driven through the Claude Code CLI.
//
// QwenCloud and Alibaba Model Studio publish an ANTHROPIC-COMPATIBLE endpoint (`<base>/v1/messages`),
// so the `claude` binary the image already ships is the harness: same stream-json protocol, same
// tool loop, same `--mcp-config` / `--resume` / permission-prompt flags. This module owns the one
// thing that differs — WHICH provider the CLI talks to and WITH WHAT credential — so that the
// Claude adapter keeps its single meaning ("the operator's Anthropic login") and never learns
// about a second one.
//
// Why each provider is a separate ENGINE and not a per-channel environment override:
//   • `ANTHROPIC_*` is a reserved prefix in config/channel-env.js because a base-URL override is
//     identity hijack. A channel secret must never be able to redirect a run.
//   • The gateway relays the operator's Anthropic OAuth access token into every Claude run
//     (gateway/claude-token-relay.js). Pointing that run at a third-party host would ship the
//     operator's Anthropic credential to it. `qwenProviderEnv()` is applied through
//     buildClaudeEnv's `providerEnv` channel, which DELETES every inherited Anthropic credential
//     before setting the provider's own — see claude.js applyProviderEnv.
//   • Model ids, catalogs, cost semantics and failover all differ, and the runtime-identity
//     preamble tells the model to quote its configured model exactly. Smuggling `qwen3.8-max` in
//     under the `opus` alias would make that preamble lie.
//
// Why a TABLE rather than one module per provider: every entry below differs only in endpoint,
// credential keys and shipped model list. Everything that carries risk — stripping the Anthropic
// credential family, dropping the CLI's fabricated cost, staying out of the failover graph,
// staying opt-in — is written once and shared, so adding a provider cannot accidentally ship with
// one of those guarantees missing. Each entry generates exactly one adapter (see adapters.js).
//
// Settings live on the gateway (admin UI), never in a channel folder: each provider's `apiKey` is
// write-only (has*/last4 like every other credential) beside its own `baseUrl`.

// The QwenCloud Token Plan endpoint. Pay-as-you-go deployments override it in Settings.
export const QWEN_DEFAULT_BASE_URL = "https://token-plan.maas.qwencloudapi.com/apps/anthropic";

// A provider's model id, as a person reads it. Declared here (above the table) because the table's
// shipped catalogs are labelled at module load.
const VENDOR_LABELS = [[/^qwen/, "Qwen"], [/^glm-/, "GLM"], [/^deepseek-/, "DeepSeek"], [/^kimi-/, "Kimi"], [/^minimax-/, "MiniMax"]];

export function qwenModelLabel(id) {
  const value = String(id || "").trim();
  if (value === "auto") return "Auto (provider routing)";
  const vendor = VENDOR_LABELS.find(([re]) => re.test(value));
  if (!vendor) return value;
  const rest = value.slice(value.match(vendor[0])[0].length).replace(/^[-.]/, "");
  const pretty = rest.split("-").filter(Boolean).map((part) => (/^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part)).join(" ");
  return pretty ? `${vendor[1]} ${pretty}` : vendor[1];
}

// ── The provider table ────────────────────────────────────────────────────────────────────────

/**
 * One Anthropic-compatible provider.
 *
 * `id`              engine id (and the name typed in a thread to switch harness)
 * `label`           what every picker shows
 * `harnessLabel`    the short name a provider failure is attributed to (see claude.js)
 * `settings`        the gateway settings keys holding this provider's credential and endpoint
 * `defaultModelKey` the settings key holding this provider's gateway default model
 * `defaultBaseUrl`  shipped endpoint, or "" when only the operator can know it
 * `models`          the catalog offered until the account's own list is read
 * `endpointHint`    admin-UI copy: what a valid endpoint for this provider looks like
 */
const provider = (entry) => Object.freeze({
  ...entry,
  models: Object.freeze(entry.models.map((value) => Object.freeze({
    label: qwenModelLabel(value), value, description: `${entry.catalogName} ${value}.`,
  }))),
});

export const QWEN_PROVIDERS = Object.freeze([
  provider({
    id: "qwen",
    label: "Qwen (Claude Code)",
    harnessLabel: "Qwen",
    catalogName: "QwenCloud",
    settings: Object.freeze({ apiKey: "qwenApiKey", baseUrl: "qwenBaseUrl" }),
    defaultModelKey: "defaultQwenModel",
    defaultBaseUrl: QWEN_DEFAULT_BASE_URL,
    description: "The same Claude Code CLI, pointed at QwenCloud's Anthropic-compatible endpoint.",
    endpointHint: "Token Plan keys use token-plan.maas.qwencloudapi.com; pay-as-you-go keys use maas.qwencloudapi.com.",
    models: ["qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash", "glm-5.3", "deepseek-v4-pro", "deepseek-v4.1-flash", "auto"],
  }),
  provider({
    id: "qwen-eu",
    label: "Qwen EU (Claude Code)",
    harnessLabel: "Qwen EU",
    catalogName: "Model Studio",
    settings: Object.freeze({ apiKey: "qwenEuApiKey", baseUrl: "qwenEuBaseUrl" }),
    defaultModelKey: "defaultQwenEuModel",
    // Deliberately EMPTY. An EU Model Studio endpoint is per-WORKSPACE
    // (`https://ws-<workspace>.eu-central-1.maas.aliyuncs.com/apps/anthropic`), so there is no
    // value this repository could ship that is correct for anyone but the account it was copied
    // from. The provider stays unconfigured — and the harness keeps failing closed with the remedy
    // named — until the operator pastes their own.
    defaultBaseUrl: "",
    description: "Alibaba Cloud Model Studio's EU (Frankfurt) region, over the same Anthropic-compatible protocol. Data stays in the EU region the workspace was created in, and the catalog is the region's own — Qwen, Kimi, GLM and DeepSeek families.",
    endpointHint: "Your workspace's own EU endpoint, e.g. https://ws-<workspace>.eu-central-1.maas.aliyuncs.com/apps/anthropic — copy it from the Model Studio console.",
    models: ["qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3-coder-plus", "qwen3-max", "kimi-k2.7-code", "glm-5.2", "deepseek-v4-pro"],
  }),
]);

export const QWEN_PROVIDER_IDS = Object.freeze(QWEN_PROVIDERS.map((p) => p.id));

/** The entry for an engine id. Unknown ids resolve to the first provider — never to Claude. */
export function qwenProvider(id = QWEN_PROVIDER_IDS[0]) {
  return QWEN_PROVIDERS.find((p) => p.id === String(id || "")) || QWEN_PROVIDERS[0];
}
export const isQwenProviderId = (id) => QWEN_PROVIDER_IDS.includes(String(id || ""));

// ── Endpoints ─────────────────────────────────────────────────────────────────────────────────

// The Anthropic-compatible path answers `/v1/messages` and NOTHING else — `/v1/models` is a
// documented 404 ("Not support"). The OpenAI-compatible sibling on the same host does serve a
// model list, and it is the only way to discover what an account may actually call, so the
// discovery hook derives it from the configured base URL rather than asking for a second setting.
// Both providers follow the same `/apps/anthropic` → `/compatible-mode/v1` shape.
export function qwenModelsUrl(baseUrl = QWEN_DEFAULT_BASE_URL) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  const swapped = base.replace(/\/apps\/anthropic$/, "/compatible-mode/v1");
  // A base URL that does not follow the documented `/apps/anthropic` shape (a proxy, a gateway of
  // the operator's own) gets the sibling appended rather than guessed at.
  return `${swapped === base ? `${base}/compatible-mode/v1` : swapped}/models`;
}

// settings.js imports the engine registry, which imports the adapters, which import this file — a
// static settings import would close that cycle. Same lazy pattern claude-login.js is read with.
async function qwenSettings(providerId) {
  const { getQwenConfig } = await import("../config/settings.js");
  return getQwenConfig(providerId);
}

/**
 * The resolved provider: `{ id, label, apiKey, baseUrl, configured, error }`. `configured` is the
 * only thing callers should branch on; `apiKey` never appears in a log, a reply or a health payload.
 */
export async function resolveQwenProvider(providerId = QWEN_PROVIDER_IDS[0]) {
  const entry = qwenProvider(providerId);
  const { apiKey = "", baseUrl = "" } = (await qwenSettings(entry.id)) || {};
  const url = String(baseUrl || entry.defaultBaseUrl).trim().replace(/\/+$/, "");
  const base = { id: entry.id, label: entry.label, harnessLabel: entry.harnessLabel, apiKey: "", baseUrl: url, configured: false };
  const where = `Settings → ${entry.harnessLabel}`;
  // Both halves are named in ONE message: a provider with no shipped endpoint needs two values,
  // and reporting them one save apart makes the second one look like a new failure.
  if (!apiKey && !url) return { ...base, error: `no API key or endpoint is configured (${where})` };
  if (!apiKey) return { ...base, error: `no API key is configured (${where})` };
  if (!url) return { ...base, error: `no endpoint is configured (${where})` };
  return { ...base, apiKey: String(apiKey), configured: true, error: "" };
}

/**
 * The environment that redirects the `claude` CLI at the provider. Applied LAST and gateway-owned
 * (claude.js), after every inherited Anthropic credential has been removed.
 */
export function qwenProviderEnv({ apiKey, baseUrl }) {
  return {
    ANTHROPIC_BASE_URL: String(baseUrl || ""),
    // The CLI sends this verbatim as the bearer credential.
    ANTHROPIC_AUTH_TOKEN: String(apiKey || ""),
  };
}

// Opaque, non-reversible, and stable for one (key, endpoint) pair: the warm pool retires a process
// whose provider changed, and the orchestrator only ever COMPARES a credential fingerprint.
export function qwenProviderFingerprint({ apiKey = "", baseUrl = "", id = "qwen" } = {}) {
  if (!apiKey) return "";
  let h = 0x811c9dc5;
  for (const ch of `${id}\u0000${baseUrl}\u0000${apiKey}`) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${id}:${h.toString(16)}`;
}

// ── Model discovery ───────────────────────────────────────────────────────────────────────────
// Text/tool models only. The same accounts also expose image, video, audio and realtime families
// (`wan2.7-image`, `qwen-audio-3.0-tts-plus`, …) which answer 400 on `/v1/messages`, plus
// single-purpose models that answer but cannot hold an agent conversation: the `-mt-` machine
// translation family returns a translation of the prompt, and the OCR models expect an image.
// Offering any of them in `/model` would pin a channel to a model that cannot run a turn.
const NON_TEXT_RE = /(?:^wan|image|video|audio|tts|realtime|t2v|i2v|speech|ocr|(?:^|-)mt-)/i;
export const QWEN_MODEL_RE = /^(?:auto|qwen[0-9][a-z0-9._-]*|qwen-[a-z0-9._-]+|glm-[a-z0-9._-]+|deepseek-[a-z0-9._-]+|kimi-[a-z0-9._-]+|minimax-[a-z0-9._-]+)$/;

export function isQwenTextModel(id) {
  const value = String(id || "").trim().toLowerCase();
  return Boolean(value) && QWEN_MODEL_RE.test(value) && !NON_TEXT_RE.test(value);
}

/** Shipped catalog for a provider: what a fresh install offers before (or when) discovery fails. */
export const qwenFallbackModels = (providerId) => qwenProvider(providerId).models;

/**
 * The model a run uses when neither the thread, the channel nor the gateway names one. The
 * `claude` CLI's own default is an Anthropic model id, which these providers reject ("Model not
 * exist"), so the adapter must never leave the choice to the CLI.
 */
export const qwenDefaultModel = (providerId) => qwenProvider(providerId).models[0].value;

// Pre-resolved for the first provider — the names the original single-provider module exported.
export const QWEN_FALLBACK_MODELS = qwenFallbackModels("qwen");
export const QWEN_DEFAULT_MODEL = qwenDefaultModel("qwen");

/**
 * The account's live model list, from the OpenAI-compatible `/models` endpoint. Returns the same
 * `{ label, value, description }` shape every adapter's `models` uses; the registry normalizes it,
 * keeps the previous catalog on failure, and never lets an empty result blank the picker.
 */
export async function discoverQwenModels({ providerId = QWEN_PROVIDER_IDS[0], fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const entry = qwenProvider(providerId);
  const resolved = await resolveQwenProvider(entry.id);
  if (!resolved.configured) throw new Error(resolved.error);
  const url = qwenModelsUrl(resolved.baseUrl);
  if (!url) throw new Error(`no ${entry.harnessLabel} model list URL could be derived from the configured base URL`);
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${resolved.apiKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${entry.harnessLabel} model list returned HTTP ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .map((row) => String(row?.id || "").trim())
    .filter(isQwenTextModel)
    .sort()
    .map((value) => ({ label: qwenModelLabel(value), value, description: `${entry.catalogName} ${value}.` }));
}

/**
 * "Is this harness's credential usable right now, and is it the SAME one that failed?" — the
 * optional adapter hook the orchestrator only ever compares. No network call: a reachability probe
 * on every turn would bill the operator for asking whether they are signed in.
 */
export async function qwenCredentialState(providerId = QWEN_PROVIDER_IDS[0]) {
  const resolved = await resolveQwenProvider(providerId);
  return {
    known: true,
    authenticated: resolved.configured,
    method: resolved.configured ? "api-key" : "none",
    detail: resolved.configured ? `${resolved.harnessLabel} API key · ${resolved.baseUrl}` : resolved.error,
    source: resolved.baseUrl,
    fingerprint: qwenProviderFingerprint(resolved),
  };
}
