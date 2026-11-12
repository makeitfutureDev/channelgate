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
  claude: "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
  codex: "https://chatgpt.com/backend-api/wham/usage",
});
const CODEX_ACCOUNTS_ENDPOINT = "https://chatgpt.com/backend-api/wham/accounts/check";
const CLAUDE_PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
const CODEX_RESETS_ENDPOINT = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CACHE_MS = 300_000;
const text = (value) => typeof value === "string" ? value.slice(0, 80) : "";
const percent = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

const identityText = (value, max = 160) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max) : "";
function publicAccount(value) {
  return { email: identityText(value?.email, 254), workspace: identityText(value?.workspace) };
}
function tokenClaims(token) {
  try {
    const payload = String(token || "").split(".")[1];
    return payload && payload.length <= 64 * 1024 ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) : null;
  } catch { return null; }
}
// Display facts only. Claims are never authentication authority, and an unselected/default
// organization must not be labelled as the selected ChatGPT workspace.
export function codexSubscriptionAccount(current) {
  const access = tokenClaims(current?.token), id = tokenClaims(current?.idToken);
  const auth = access?.["https://api.openai.com/auth"];
  const idAuth = id?.["https://api.openai.com/auth"];
  const selected = current?.accountId || auth?.chatgpt_account_id;
  const sameLogin = access?.sub && id?.sub === access.sub && idAuth?.chatgpt_account_id === selected;
  const organization = sameLogin && Array.isArray(idAuth?.organizations)
    ? idAuth.organizations.find((entry) => entry?.id === selected) : null;
  return publicAccount({ email: access?.email || access?.["https://api.openai.com/profile"]?.email || (sameLogin ? id?.email : ""), workspace: organization?.title });
}

export function codexSubscriptionWorkspace(payload, accountId) {
  if (typeof accountId !== "string" || !accountId) return "";
  if (Array.isArray(payload?.accounts)) {
    const matches = payload.accounts.slice(0, 100).filter((account) => account?.id === accountId);
    return matches.length === 1 ? identityText(matches[0].name) : "";
  }
  if (!payload?.accounts || typeof payload.accounts !== "object") return "";
  const matches = Object.values(payload.accounts).slice(0, 100).map((entry) => entry?.account).filter((account) => account?.account_id === accountId);
  return matches.length === 1 ? identityText(matches[0].name) : "";
}

// The official Claude CLI reads this optional grant projection from the usage response.
function normalizeClaudeResets(status) {
  if (!status || !Array.isArray(status.grants)) return null;
  const available = status.grants.slice(0, 100).filter((grant) => grant && count(grant.resets_left) !== null && grant.resets_left > 0);
  const total = available.reduce((sum, grant) => sum + grant.resets_left, 0);
  if (!Number.isSafeInteger(total)) return null;
  return { available: total, resets: available.map((grant) => {
    const clears = Array.isArray(grant.clears) ? grant.clears : [];
    const session = clears.includes("five_hour"), weekly = clears.some((key) => key !== "five_hour");
    const kind = grant.gives_back_weekly ? "fable" : ["session", "weekly", "full"].includes(grant.type) ? grant.type : session && weekly ? "full" : session ? "session" : weekly ? "weekly" : "unknown";
    const label = { session: "5-hour reset", weekly: "Weekly reset", full: "Full reset", fable: "Fable reset", unknown: "Usage reset" }[kind];
    return { label: text(grant.label) || label, expiresAt: iso(grant.ends_at), remaining: grant.resets_left, paused: grant.paused === true, usableNow: grant.usable_now === true };
  }) };
}

export function normalizeResetCredits(data) {
  if (count(data?.available_count) === null) return null;
  const resets = (Array.isArray(data.credits) ? data.credits : []).slice(0, 100)
    .filter((credit) => credit?.status === "available")
    .map((credit) => ({ label: text(credit.title) || (credit.reset_type === "codex_rate_limits" ? "Full reset" : "Usage reset"), expiresAt: iso(credit.expires_at) }));
  return { available: data.available_count, resets };
}

function iso(value) {
  if (value == null || value === "") return null;
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
}

export function normalizeSubscriptionUsage(provider, data) {
  const windows = [];
  if (provider === "claude") {
    for (const [key, label] of Object.entries({ five_hour: "Current session (5 hours)", seven_day: "Weekly · all models", seven_day_fable: "Weekly · Fable", seven_day_opus: "Weekly · Opus", seven_day_sonnet: "Weekly · Sonnet", seven_day_oauth_apps: "Weekly · OAuth apps", seven_day_cowork: "Weekly · Cowork", seven_day_overage_included: "Weekly · included overage" })) {
      const window = data?.[key];
      if (percent(window?.utilization) !== null) windows.push({ id: key, label, usedPercent: percent(window.utilization), resetsAt: iso(window.resets_at) });
    }
    // Current Claude payloads include model-scoped limits here rather than a new flat key.
    // Project only known window kinds, bounded display names and numeric percentages.
    const indexed = new Map(windows.map((window) => [window.id, window]));
    for (const limit of (Array.isArray(data?.limits) ? data.limits : []).slice(0, 50)) {
      const usedPercent = percent(limit?.percent);
      if (usedPercent === null) continue;
      const model = text(limit.scope?.model?.display_name);
      const scoped = limit.kind === "weekly_scoped" && model;
      const id = limit.kind === "session" ? "five_hour" : limit.kind === "weekly_all" ? "seven_day" : scoped ? `seven_day_${model.toLowerCase().replace(/[^a-z0-9]+/g, "_")}` : "";
      if (!id) continue;
      indexed.set(id, { id, label: scoped ? `Weekly · ${model}` : id === "five_hour" ? "Current session (5 hours)" : "Weekly · all models", usedPercent, resetsAt: iso(limit.resets_at) });
    }
    windows.splice(0, windows.length, ...indexed.values());
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
  const resetCredits = provider === "claude" ? normalizeClaudeResets(data?.cedar_ember) : normalizeResetCredits(data?.rate_limit_reset_credits);
  return { windows, plan: provider === "codex" ? text(data?.plan_type) : "", ...(resetCredits ? { resetCredits } : {}) };
}

export function createDaemonSubscriptionCredentials({ resolveClaude = resolveClaudeLogin, readClaude = readDaemonClaudeAccessToken,
  claudeToken = getContainerClaudeOauthToken, resolveCodex = resolveCodexLogin, readCodex = readDaemonCodexAccessToken,
  euHome = codexEuLoginHome, env = process.env } = {}) {
  return (engine, usage) => {
    if (usage.provider === "claude") {
      const login = resolveClaude();
      if (login.kind === "api-key" || login.kind === "none") return { kind: login.kind };
      const current = login.kind === "settings" ? { token: claudeToken() } : readClaude(login);
      return { kind: "subscription", token: current?.token || "", expiresAt: current?.expiresAt || 0, plan: current?.subscriptionType === "max" && /max_(5|20)x$/.test(current?.rateLimitTier || "") ? `Max ${current.rateLimitTier.match(/max_(5|20)x$/)[1]}x` : current?.subscriptionType || "", source: login.kind, profile: "claude" };
    }
    const dedicated = usage.login === "codex-eu";
    const login = resolveCodex(dedicated ? { env: {}, candidates: [path.join(euHome(), "auth.json")] } : {});
    if (dedicated && login.kind !== "chatgpt") return { kind: "none" };
    if (login.kind !== "chatgpt") return { kind: login.kind === "none" && env.OPENAI_API_KEY ? "api-key" : login.kind };
    const current = readCodex(login);
    return { kind: "subscription", token: current?.token || "", expiresAt: current?.expiresAt || 0, plan: current?.planType || "", accountId: current?.accountId || "", source: dedicated ? "codex-eu" : "chatgpt", account: codexSubscriptionAccount(current), profile: "codex" };
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
    const base = { account: publicAccount(null), provider: engine, kind: "unsupported", name: manifest?.label || engine, plan: "", windows: [], checkedAt: null, updatedAt: null, stale: false };
    if (!Object.hasOwn(ENDPOINTS, provider || "")) {
      cache.delete(engine);
      return { ...base, status: "unsupported", message: "Subscription quota reporting is not available for this harness. Check its provider dashboard for limits and billing." };
    }
    let credential;
    try { credential = credentials(engine, usage); } catch { return { ...base, status: "unavailable", message: "Could not read the gateway login. Check engine settings." }; }
    base.account = publicAccount(credential.account);
    base.kind = credential.kind === "subscription" ? "subscription" : credential.kind === "api-key" ? "api-key" : "none";
    if (credential.kind !== "subscription" || !credential.token) {
      base.account = publicAccount(null);
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
    const key = createHash("sha256").update(JSON.stringify([credential.token, credential.accountId, credential.plan, credential.source, base.account])).digest("hex");
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
          const payload = JSON.parse(bytes.toString("utf8"));
          const normalized = normalizeSubscriptionUsage(provider, payload);
          // /usage returns the identity of this exact authenticated Codex request. Prefer it to
          // a saved ID-token email, and never publish the provider's account/user identifiers.
          if (provider === "codex" && typeof payload?.email === "string") base.account = publicAccount({ ...base.account, email: payload.email });
          if (provider === "codex" && credential.profile === "codex" && credential.accountId) {
            try {
              const accountsResponse = await fetchImpl(CODEX_ACCOUNTS_ENDPOINT, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
              if (accountsResponse.ok) {
                const accountBytes = await readBoundedBytes(accountsResponse, 256 * 1024);
                const workspace = codexSubscriptionWorkspace(JSON.parse(accountBytes.toString("utf8")), credential.accountId);
                if (workspace) base.account = publicAccount({ ...base.account, workspace });
              } else await accountsResponse.body?.cancel?.();
            } catch { /* Email and quotas remain available when workspace metadata cannot be read. */ }
          }
          if (provider === "claude" && credential.profile === "claude") {
            try {
              const profileResponse = await fetchImpl(CLAUDE_PROFILE_ENDPOINT, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
              if (profileResponse.ok) {
                const profileBytes = await readBoundedBytes(profileResponse, 256 * 1024);
                const profile = JSON.parse(profileBytes.toString("utf8"));
                // This profile is bound to the same bearer used for usage, including setup-token
                // logins. Do not substitute the operator's possibly unrelated saved CLI account.
                base.account = publicAccount({ email: profile?.account?.email, workspace: profile?.organization?.name });
              } else await profileResponse.body?.cancel?.();
            } catch { /* Valid quota data remains usable when account metadata is unavailable. */ }
          }
          // Reset allowances have a separate read-only endpoint. A failure there must never
          // hide valid quota windows or leak a response body. Share the main per-harness cache.
          if (provider === "codex" && normalized.resetCredits?.available > 0) {
            try {
              const resetResponse = await fetchImpl(CODEX_RESETS_ENDPOINT, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
              if (resetResponse.ok) {
                const resetBytes = await readBoundedBytes(resetResponse, 256 * 1024);
                const details = normalizeResetCredits(JSON.parse(resetBytes.toString("utf8")));
                if (details) normalized.resetCredits = details;
              } else await resetResponse.body?.cancel?.();
            } catch { /* The usage summary still reports the available count. */ }
          }
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
        result = { ...result, windows: previous.windows, account: previous.account, plan: previous.plan, ...(previous.resetCredits ? { resetCredits: previous.resetCredits } : {}), updatedAt: previous.updatedAt, stale: true };
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
