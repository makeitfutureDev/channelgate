// Provider subscription quotas, separate from the gateway's token/cost ledger. This reader
// never refreshes credentials or starts an engine turn. Access tokens stay in daemon memory.
import { createHash } from "node:crypto";
import path from "node:path";
import { codexEuLoginHome } from "./channel-codex-paths.js";
import { adapterFor } from "../engines/registry.js";
import { resolveClaudeLogin } from "./claude-login.js";
import { readDaemonClaudeAccessToken } from "./claude-token-relay.js";
import { resolveCodexLogin, readDaemonCodexAccessToken } from "./codex-token-relay.js";
import { getEnabledEngines, getContainerClaudeOauthToken } from "../config/settings.js";
import { readBoundedBytes } from "../util/bounded-bytes.js";

const ENDPOINTS = Object.freeze({
  claude: "https://api.anthropic.com/api/oauth/usage",
  codex: "https://chatgpt.com/backend-api/wham/usage",
});
const CACHE_MS = 300_000;
const text = (value) => typeof value === "string" ? value.slice(0, 80) : "";
const percent = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
function iso(value) {
  if (value == null || value === "") return null;
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
}

export function normalizeSubscriptionUsage(provider, data) {
  const windows = [];
  if (provider === "claude") {
    for (const [key, label] of Object.entries({ five_hour: "Current session (5 hours)", seven_day: "Weekly · all models", seven_day_opus: "Weekly · Opus", seven_day_sonnet: "Weekly · Sonnet", seven_day_oauth_apps: "Weekly · OAuth apps", seven_day_cowork: "Weekly · Cowork", seven_day_overage_included: "Weekly · included overage" })) {
      const window = data?.[key];
      if (percent(window?.utilization) !== null) windows.push({ id: key, label, usedPercent: percent(window.utilization), resetsAt: iso(window.resets_at) });
    }
  } else if (provider === "codex") {
    const groups = [["rate_limit", "", data?.rate_limit], ["code_review_rate_limit", "Code review · ", data?.code_review_rate_limit]];
    if (Array.isArray(data?.additional_rate_limits)) {
      data.additional_rate_limits.slice(0, 50).forEach((limit, index) => {
        groups.push([`additional_${index}`, `${text(limit?.limit_name) || text(limit?.metered_feature) || "Additional limit"} · `, limit?.rate_limit]);
      });
    }
    for (const [group, prefix, limits] of groups) {
      for (const key of ["primary_window", "secondary_window"]) {
        const window = limits?.[key];
        if (percent(window?.used_percent) === null) continue;
        const seconds = window.limit_window_seconds;
        const duration = seconds === 18_000 ? "5 hours" : seconds === 604_800 ? "Weekly" : typeof seconds === "number" && seconds > 0 ? `${Math.round(seconds / 60)} minutes` : key === "primary_window" ? "Primary limit" : "Secondary limit";
        windows.push({ id: `${group}_${key}`, label: prefix + duration, usedPercent: percent(window.used_percent), resetsAt: iso(window.reset_at) });
      }
    }
  }
  return { windows, plan: provider === "codex" ? text(data?.plan_type) : "" };
}

export function createDaemonSubscriptionCredentials({ resolveClaude = resolveClaudeLogin, readClaude = readDaemonClaudeAccessToken,
  claudeToken = getContainerClaudeOauthToken, resolveCodex = resolveCodexLogin, readCodex = readDaemonCodexAccessToken,
  euHome = codexEuLoginHome, env = process.env } = {}) {
  return (engine, usage) => {
    if (usage.provider === "claude") {
      const login = resolveClaude();
      if (login.kind === "api-key" || login.kind === "none") return { kind: login.kind };
      const current = login.kind === "settings" ? { token: claudeToken() } : readClaude(login);
      return { kind: "subscription", token: current?.token || "", expiresAt: current?.expiresAt || 0, plan: current?.subscriptionType || "", source: login.kind };
    }
    const dedicated = usage.login === "codex-eu";
    const login = resolveCodex(dedicated ? { env: {}, candidates: [path.join(euHome(), "auth.json")] } : {});
    if (dedicated && login.kind !== "chatgpt") return { kind: "none" };
    if (login.kind !== "chatgpt") return { kind: login.kind === "none" && env.OPENAI_API_KEY ? "api-key" : login.kind };
    const current = readCodex(login);
    return { kind: "subscription", token: current?.token || "", expiresAt: current?.expiresAt || 0, plan: current?.planType || "", accountId: current?.accountId || "", source: dedicated ? "codex-eu" : "chatgpt" };
  };
}
const daemonCredentials = createDaemonSubscriptionCredentials();

// Dependency injection keeps provider fixtures entirely offline and outside real login state.
export function createSubscriptionUsageReader({ credentials = daemonCredentials, engines = getEnabledEngines, adapter = adapterFor, fetchImpl = fetch, now = Date.now, timeoutMs = 10_000 } = {}) {
  const cache = new Map();
  async function readProvider(engine) {
    const manifest = adapter(engine);
    const usage = manifest?.subscriptionUsage;
    const provider = usage?.provider;
    const base = { provider: engine, name: manifest?.label || engine, plan: "", windows: [], checkedAt: null, updatedAt: null, stale: false };
    if (!Object.hasOwn(ENDPOINTS, provider || "")) {
      cache.delete(engine);
      return { ...base, status: "unsupported", message: "Subscription quota reporting is not available for this harness. Check its provider dashboard for limits and billing." };
    }
    let credential;
    try { credential = credentials(engine, usage); } catch { return { ...base, status: "unavailable", message: "Could not read the gateway login. Check engine settings." }; }
    if (credential.kind !== "subscription" || !credential.token) {
      cache.delete(engine);
      return { ...base, status: credential.kind === "api-key" ? "api-key" : "not-connected", message: credential.kind === "api-key" ? "API-key billing has no subscription quota. View token usage and estimated costs on Overview." : "No subscription login is available. Sign in to this engine on the gateway host." };
    }
    base.plan = text(credential.plan);
    if (credential.expiresAt && credential.expiresAt <= now()) {
      cache.delete(engine);
      return { ...base, status: "expired", message: "The access token has expired. Renew the engine login on the gateway host; this page never refreshes credentials." };
    }
    // Bound to the actual token/account: a login change must never show the previous account's
    // cached usage. Only one entry per harness is retained; hashes never leave this closure.
    const key = createHash("sha256").update(JSON.stringify([credential.token, credential.accountId, credential.plan, credential.source])).digest("hex");
    let entry = cache.get(engine);
    if (entry?.key === key && entry.pending) return entry.pending;
    if (entry?.key === key && now() - entry.at < entry.ttl) return entry.value;
    const previous = entry?.key === key ? entry.good : null;
    entry = { key, at: 0, value: null, good: previous, pending: null, ttl: CACHE_MS };
    cache.set(engine, entry);
    entry.pending = Promise.resolve().then(async () => {
      const checkedAt = new Date(now()).toISOString();
      let result;
      try {
        const headers = { Authorization: `Bearer ${credential.token}`, Accept: "application/json", "User-Agent": "ChannelGate/subscription-usage" };
        if (provider === "claude") headers["anthropic-beta"] = "oauth-2025-04-20";
        if (provider === "codex" && credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
        const response = await fetchImpl(ENDPOINTS[provider], { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
        if (!response.ok) {
          // Never pass upstream error text/headers to an API caller or log: it may echo secrets.
          const status = response.status;
          if (status === 429) {
            const retry = response.headers?.get?.("retry-after");
            const retryMs = /^\d+$/.test(retry || "") ? Number(retry) * 1000 : Date.parse(retry) - now();
            if (Number.isFinite(retryMs)) entry.ttl = Math.max(CACHE_MS, Math.min(3_600_000, retryMs));
          }
          await response.body?.cancel?.();
          result = { ...base, status: status === 401 ? "expired" : "unavailable", message: status === 401 ? "The provider rejected this login. Renew it on the gateway host." : status === 403 ? "This login cannot read subscription usage. Check its subscription and usage permissions." : status === 429 ? "The provider is rate limiting usage checks. Try again later." : "The provider could not return usage. Try again later." };
        } else {
          const bytes = await readBoundedBytes(response, 256 * 1024);
          const normalized = normalizeSubscriptionUsage(provider, JSON.parse(bytes.toString("utf8")));
          result = { ...base, ...normalized, plan: normalized.plan || base.plan, status: normalized.windows.length ? "ok" : "unavailable", message: normalized.windows.length ? "" : "The provider returned no supported usage windows." };
        }
      } catch {
        result = { ...base, status: "unavailable", message: "Could not reach the provider or read its usage response. Try again later." };
      }
      result.checkedAt = checkedAt;
      if (result.status === "ok") {
        result.updatedAt = checkedAt;
        entry.good = result;
      } else if (result.status === "expired") {
        entry.good = null;
      } else if (previous && result.status !== "expired") {
        result = { ...result, windows: previous.windows, plan: previous.plan, updatedAt: previous.updatedAt, stale: true };
      }
      entry.at = now();
      entry.value = result;
      entry.pending = null;
      return result;
    });
    return entry.pending;
  }
  return async () => {
    const enabled = [...new Set(engines())];
    for (const engine of cache.keys()) if (!enabled.includes(engine)) cache.delete(engine);
    return { subscriptions: await Promise.all(enabled.map(readProvider)), refreshAfterSeconds: CACHE_MS / 1000 };
  };
}

export const readSubscriptionUsage = createSubscriptionUsageReader();
