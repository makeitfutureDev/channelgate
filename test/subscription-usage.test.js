import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { ensureTestEnv, tempDir } from "./helpers.js";

// The default reader imports the daemon login resolvers. Pin their homes before import even
// though these tests inject all credentials and never contact a provider.
ensureTestEnv();
// The real admin router uses the module's default reader. Capture a refusing transport in that
// reader before restoring normal fetch for the local HTTP client below.
const localFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Provider networking is disabled in this fixture"); };
const { createSubscriptionUsageReader: createReader, createDaemonSubscriptionCredentials, normalizeSubscriptionUsage } = await import("../src/gateway/subscription-usage.js");
globalThis.fetch = localFetch;
const { createSubscriptionsRouter } = await import("../src/web/routes/subscriptions.js");
const { createSubscriptionPoller, subscriptionCard, subscriptionReset } = await import("../public/admin-subscriptions.js");
const { default: express } = await import("express");

const createSubscriptionUsageReader = (options) => createReader({ engines: () => ["claude", "codex"], ...options });

const START = Date.parse("2026-11-11T12:00:00Z");
const TTL = 300_000;
const success = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const claudeBody = (used = 25) => ({ five_hour: { utilization: used, resets_at: "2026-11-11T17:00:00Z" } });
const codexBody = (used = 40) => ({ plan_type: "plus", rate_limit: { primary_window: { used_percent: used, reset_at: 1794416400, limit_window_seconds: 18000 } } });
const connected = (provider) => ({ kind: "subscription", token: `fixture-${provider}-access`, expiresAt: START + 86400_000, plan: provider === "claude" ? "max" : "plus", accountId: provider === "codex" ? "fixture-account" : undefined });
const forProvider = (result, provider = "claude") => result.subscriptions.find((row) => row.provider === provider);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Claude normalizes only supported, finite percentage windows and valid reset dates", () => {
  const normalized = normalizeSubscriptionUsage("claude", {
    ...claudeBody(0),
    seven_day: { utilization: 100, resets_at: "2026-11-18T12:00:00Z" },
    seven_day_opus: { utilization: 75.5, resets_at: "not a date" },
    seven_day_sonnet: { utilization: "50" },
    seven_day_oauth_apps: { utilization: -1 },
    seven_day_cowork: { utilization: Infinity },
    seven_day_overage_included: { utilization: 101 },
    secret: { utilization: 20, access_token: "upstream-secret" },
  });
  assert.deepEqual(normalized, { plan: "", windows: [
    { id: "five_hour", label: "Current session (5 hours)", usedPercent: 0, resetsAt: "2026-11-11T17:00:00.000Z" },
    { id: "seven_day", label: "Weekly · all models", usedPercent: 100, resetsAt: "2026-11-18T12:00:00.000Z" },
    { id: "seven_day_opus", label: "Weekly · Opus", usedPercent: 75.5, resetsAt: null },
  ] });
  for (const body of [undefined, null, {}, []]) assert.deepEqual(normalizeSubscriptionUsage("claude", body), { windows: [], plan: "" });
});

test("Codex includes primary, secondary and code review limits with safe plan and time normalization", () => {
  const normalized = normalizeSubscriptionUsage("codex", {
    plan_type: "p".repeat(120),
    rate_limit: {
      primary_window: { used_percent: 12.5, reset_at: START / 1000, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 80, reset_at: "bad date", limit_window_seconds: 604800 },
    },
    code_review_rate_limit: {
      primary_window: { used_percent: 100, reset_at: -1, limit_window_seconds: 3600 },
      secondary_window: { used_percent: 0, reset_at: 1e20 },
    },
    access_token: "never-returned",
  });
  assert.equal(normalized.plan.length, 80);
  assert.deepEqual(normalized.windows.map(({ label, usedPercent, resetsAt }) => ({ label, usedPercent, resetsAt })), [
    { label: "5 hours", usedPercent: 12.5, resetsAt: "2026-11-11T12:00:00.000Z" },
    { label: "Weekly", usedPercent: 80, resetsAt: null },
    { label: "Code review · 60 minutes", usedPercent: 100, resetsAt: null },
    { label: "Code review · Secondary limit", usedPercent: 0, resetsAt: null },
  ]);
  assert.doesNotMatch(JSON.stringify(normalized), /never-returned/);
  assert.deepEqual(normalizeSubscriptionUsage("unknown", codexBody()), { windows: [], plan: "" });
});

test("Codex additional model limits cap upstream group counts and names", () => {
  const normalized = normalizeSubscriptionUsage("codex", {
    additional_rate_limits: Array.from({ length: 60 }, (_, index) => ({ limit_name: index === 0 ? "m".repeat(120) : `Model ${index}`, rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } })),
  });
  assert.equal(normalized.windows.length, 50);
  assert.equal(normalized.windows[0].id, "additional_0_primary_window");
  assert.equal(normalized.windows[0].label, "m".repeat(80) + " · 5 hours");
  assert.equal(normalized.windows.at(-1).id, "additional_49_primary_window");
});

test("missing, API-key and expired subscription logins make no outbound request", async () => {
  for (const [credential, expected] of [
    [{ kind: "none" }, "not-connected"],
    [{ kind: "api-key", token: "fixture-api-key" }, "api-key"],
    [{ kind: "subscription", token: "" }, "not-connected"],
    [{ ...connected("claude"), expiresAt: START }, "expired"],
  ]) {
    let requests = 0;
    const read = createSubscriptionUsageReader({ credentials: () => credential, now: () => START, fetchImpl: async () => { requests++; throw new Error("unexpected network"); } });
    const result = await read();
    assert.equal(requests, 0);
    assert.ok(result.subscriptions.every((row) => row.status === expected));
    assert.ok(result.subscriptions.every((row) => row.windows.length === 0 && row.checkedAt === null));
  }
});

test("credential reader failures are isolated per engine and return no exception details", async () => {
  const read = createSubscriptionUsageReader({
    credentials(provider) { if (provider === "claude") throw new Error("credential-secret /private/login.json"); return connected(provider); },
    now: () => START,
    fetchImpl: async () => success(codexBody()),
  });
  const result = await read();
  assert.equal(forProvider(result).status, "unavailable");
  assert.equal(forProvider(result, "codex").status, "ok");
  assert.doesNotMatch(JSON.stringify(result), /credential-secret|private\/login/);
});

test("outbound calls use exact fixed endpoints, bearer auth and provider-specific headers without redirects", async () => {
  const requests = [];
  const read = createSubscriptionUsageReader({ credentials: connected, now: () => START, timeoutMs: 1234, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return success(url.includes("anthropic") ? claudeBody() : codexBody());
  } });
  const result = await read();
  assert.deepEqual(requests.map((row) => row.url), ["https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1", "https://chatgpt.com/backend-api/wham/usage"]);
  assert.deepEqual(requests[0].options.headers, { Authorization: "Bearer fixture-claude-access", Accept: "application/json", "User-Agent": "ChannelGate/subscription-usage", "anthropic-beta": "oauth-2025-04-20" });
  assert.deepEqual(requests[1].options.headers, { Authorization: "Bearer fixture-codex-access", Accept: "application/json", "User-Agent": "ChannelGate/subscription-usage", "ChatGPT-Account-Id": "fixture-account" });
  for (const { options } of requests) { assert.equal(options.redirect, "error"); assert.ok(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false); }
  assert.equal(result.refreshAfterSeconds, 300);
  assert.ok(result.subscriptions.every((row) => row.status === "ok" && row.checkedAt === "2026-11-11T12:00:00.000Z" && row.updatedAt === row.checkedAt));
  assert.doesNotMatch(JSON.stringify(result), /fixture-(?:claude|codex)-access|fixture-account|Authorization/);
});

test("successful readings cache for five minutes and concurrent readers share provider requests", async () => {
  let clock = START, count = 0;
  const gate = deferred();
  const read = createSubscriptionUsageReader({ credentials: connected, now: () => clock, fetchImpl: async (url) => { count++; await gate.promise; return success(url.includes("anthropic") ? claudeBody() : codexBody()); } });
  const first = read(), second = read();
  await settle();
  assert.equal(count, 2);
  gate.resolve();
  assert.deepEqual(await first, await second);
  await read();
  clock += TTL - 1;
  await read();
  assert.equal(count, 2);
  clock++;
  await read();
  assert.equal(count, 4);
});

test("Codex without an account identifier omits the account-selection header", async () => {
  let headers;
  const read = createSubscriptionUsageReader({ credentials: (provider) => provider === "codex" ? { ...connected(provider), accountId: "" } : { kind: "none" }, now: () => START,
    fetchImpl: async (_url, options) => { headers = options.headers; return success(codexBody()); },
  });
  assert.equal(forProvider(await read(), "codex").status, "ok");
  assert.equal(Object.hasOwn(headers, "ChatGPT-Account-Id"), false);
});

test("rate-limit Retry-After cooldown supports seconds and HTTP dates with five-minute and one-hour bounds", async () => {
  for (const [header, cooldown] of [
    ["1", TTL], ["900", 900_000], ["999999999", 3_600_000],
    [new Date(START + 600_000).toUTCString(), 600_000], ["invalid", TTL],
  ]) {
    let clock = START, count = 0;
    const read = createSubscriptionUsageReader({ credentials: (provider) => provider === "claude" ? connected(provider) : { kind: "none" }, now: () => clock,
      fetchImpl: async () => { count++; return new Response("upstream-secret", { status: 429, headers: { "Retry-After": header } }); },
    });
    assert.equal(forProvider(await read()).status, "unavailable");
    clock += cooldown - 1;
    await read();
    assert.equal(count, 1, `cached cooldown ${header}`);
    clock++;
    await read();
    assert.equal(count, 2, `retry cooldown ${header}`);
  }
});

test("token/account changes discard cached quota and prevent an old in-flight response replacing the new account", async () => {
  let account = "old";
  const oldRequest = deferred();
  const requests = [];
  const read = createSubscriptionUsageReader({ credentials: (provider) => provider === "claude" ? { kind: "none" } : { ...connected(provider), accountId: account }, now: () => START,
    fetchImpl: async (_url, options) => { const id = options.headers["ChatGPT-Account-Id"]; requests.push(id); if (id === "old") await oldRequest.promise; return success(codexBody(id === "old" ? 95 : 5)); },
  });
  const old = read();
  account = "new";
  assert.equal(forProvider(await read(), "codex").windows[0].usedPercent, 5);
  oldRequest.resolve();
  assert.equal(forProvider(await old, "codex").windows[0].usedPercent, 95);
  assert.equal(forProvider(await read(), "codex").windows[0].usedPercent, 5);
  assert.deepEqual(requests, ["old", "new"]);
});

test("disconnecting clears old quota so reconnect failures cannot show the former cached reading", async () => {
  let clock = START, credential = connected("claude"), fail = false;
  const read = createSubscriptionUsageReader({ credentials: (provider) => provider === "claude" ? credential : { kind: "none" }, now: () => clock,
    fetchImpl: async () => { if (fail) throw new Error("transport-secret"); return success(claudeBody()); },
  });
  await read();
  credential = { kind: "none" };
  assert.equal(forProvider(await read()).status, "not-connected");
  credential = connected("claude"); fail = true; clock += TTL;
  const row = forProvider(await read());
  assert.equal(row.status, "unavailable");
  assert.equal(row.stale, false);
  assert.deepEqual(row.windows, []);
});

test("provider failures retain timestamped last-good windows as stale but 401 clears visible quotas", async () => {
  let clock = START, mode = 200, jsonReads = 0;
  const read = createSubscriptionUsageReader({ credentials: (provider) => provider === "claude" ? connected(provider) : { kind: "none" }, now: () => clock,
    fetchImpl: async () => mode === 200 ? success(claudeBody()) : { ok: false, status: mode, json: async () => { jsonReads++; return { error: "secret echoed" }; } },
  });
  const good = forProvider(await read());
  clock += TTL; mode = 429;
  const stale = forProvider(await read());
  assert.equal(stale.status, "unavailable"); assert.equal(stale.stale, true);
  assert.deepEqual(stale.windows, good.windows);
  assert.equal(stale.updatedAt, good.updatedAt);
  assert.equal(stale.checkedAt, new Date(clock).toISOString());
  assert.match(stale.message, /rate limiting/);
  clock += TTL; mode = 401;
  const rejected = forProvider(await read());
  assert.equal(rejected.status, "expired"); assert.equal(rejected.stale, false);
  assert.deepEqual(rejected.windows, []);
  clock += TTL; mode = 500;
  const laterFailure = forProvider(await read());
  assert.equal(laterFailure.status, "unavailable");
  assert.equal(laterFailure.stale, false, "a rejected login must not resurrect an old last-good quota");
  assert.deepEqual(laterFailure.windows, []);
  assert.equal(jsonReads, 0, "upstream error bodies are never read or forwarded");
});

test("HTTP errors, invalid JSON and transport exceptions expose only fixed safe messages", async () => {
  for (const failure of [
    async () => ({ ok: false, status: 403, statusText: "upstream-secret" }),
    async () => ({ ok: false, status: 500, headers: { Authorization: "upstream-secret" } }),
    async () => new Response('{ malformed json "upstream-secret"'),
    async () => new Response('"' + "upstream-secret".repeat(30_000) + '"'),
    async () => { throw new Error("upstream-secret"); },
    async () => success({ access_token: "upstream-secret", unexpected: "upstream-secret" }),
  ]) {
    const read = createSubscriptionUsageReader({ credentials: connected, now: () => START, fetchImpl: failure });
    const result = await read();
    assert.ok(result.subscriptions.every((row) => row.status === "unavailable" && row.windows.length === 0));
    assert.doesNotMatch(JSON.stringify(result), /upstream-secret|fixture-(?:claude|codex)-access/);
  }
});

test("a synchronous transport failure retries once its failure cache expires", async () => {
  let clock = START, count = 0;
  const read = createSubscriptionUsageReader({ credentials: (provider) => provider === "claude" ? connected(provider) : { kind: "none" }, now: () => clock,
    fetchImpl() { count++; if (count === 1) throw new Error("synchronous failure"); return Promise.resolve(success(claudeBody())); },
  });
  assert.equal(forProvider(await read()).status, "unavailable");
  clock += TTL;
  assert.equal(forProvider(await read()).status, "ok");
  assert.equal(count, 2);
});

test("subscription cards escape every upstream text field and reject invalid progress values", () => {
  const payload = '<img src=x onerror="alert(1)">';
  const html = subscriptionCard({ name: payload, plan: payload, status: 'ok" onclick="bad', message: payload, stale: true, checkedAt: payload, updatedAt: payload,
    windows: [{ label: payload, usedPercent: 77.7, resetsAt: payload }, { label: "bad", usedPercent: '0" onmouseover="bad' }, { label: "nan", usedPercent: NaN }, { label: "too big", usedPercent: 101 }],
  });
  assert.doesNotMatch(html, /<img|onclick=|onmouseover=|value="NaN"|value="101"/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /subscription-status unavailable/);
  assert.match(html, /Stale data/);
  assert.match(html, /<progress max="100" value="77\.7"/);
  assert.equal((html.match(/<progress/g) || []).length, 1);
  assert.equal(subscriptionReset(null, START), "Reset time unavailable");
  assert.equal(subscriptionReset("2026-11-11T12:00:00Z", START), "Reset time passed · awaiting provider update");
  assert.match(subscriptionReset("2026-11-11T12:30:00Z", START), /^Resets in 30m/);
  assert.match(subscriptionReset("2026-11-11T14:01:00Z", START), /^Resets in 2h 1m/);
  assert.match(subscriptionReset("2026-11-13T13:00:00Z", START), /^Resets in 2d 1h/);
});

function pollerFixture() {
  let visible = true, sequence = 0;
  const pending = [], paints = [], timers = new Map(), paths = [];
  const poller = createSubscriptionPoller({
    request(path) { paths.push(path); const request = deferred(); pending.push(request); return request.promise; },
    render(state) { paints.push({ ...state }); }, visible: () => visible,
    schedule(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    unschedule(id) { timers.delete(id); },
  });
  return { poller, pending, paints, timers, paths, setVisible: (value) => { visible = value; poller.visibilityChanged(); } };
}

test("poller reads only the active page, shares pending refreshes and removes timers on departure", async () => {
  const f = pollerFixture();
  await f.poller.refresh();
  assert.equal(f.pending.length, 0);
  f.poller.enter(); f.poller.enter(); void f.poller.refresh();
  assert.deepEqual(f.paths, ["/api/subscriptions"]);
  assert.equal(f.paints.at(-1).loading, true);
  f.pending[0].resolve({ subscriptions: [] }); await settle();
  assert.equal(f.paints.at(-1).loading, false);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, TTL);
  f.poller.leave();
  assert.equal(f.timers.size, 0);
});

test("poller ignores late hidden-page responses, then reads again when visible", async () => {
  const f = pollerFixture();
  f.poller.enter();
  f.setVisible(false);
  f.pending[0].resolve({ subscriptions: [{ name: "ignored" }] }); await settle();
  assert.equal(f.timers.size, 0);
  assert.ok(f.paints.every((paint) => !paint.data));
  f.setVisible(true);
  assert.equal(f.pending.length, 2);
  f.pending[1].resolve({ subscriptions: [{ name: "fresh" }] }); await settle();
  assert.equal(f.paints.at(-1).data.subscriptions[0].name, "fresh");
  f.setVisible(false);
  assert.equal(f.timers.size, 0);
});

test("leaving and reentering while a request is pending ignores the old response and starts a fresh read", async () => {
  const f = pollerFixture();
  f.poller.enter(); f.poller.leave(); f.poller.enter();
  assert.equal(f.pending.length, 1);
  f.pending[0].resolve({ subscriptions: [{ name: "old" }] }); await settle();
  assert.equal(f.pending.length, 2);
  f.pending[1].resolve({ subscriptions: [{ name: "new" }] }); await settle();
  assert.equal(f.paints.at(-1).data.subscriptions[0].name, "new");
  assert.equal(f.paints.at(-1).loading, false);
  assert.ok(f.paints.every((paint) => paint.data?.subscriptions[0]?.name !== "old"));
  f.poller.leave();
});

test("poller does not render late departed responses or error details and retries after failures", async () => {
  const f = pollerFixture();
  f.poller.enter();
  f.pending[0].reject(new Error("api-secret")); await settle();
  assert.equal(f.paints.at(-1).error, "Could not load subscription usage. Try again.");
  assert.equal(f.paints.at(-1).loading, false);
  const timer = [...f.timers.values()][0];
  assert.ok(timer); void timer.fn();
  f.poller.leave();
  const paintCount = f.paints.length;
  f.pending[1].resolve({ subscriptions: [{ name: "too late" }] }); await settle();
  assert.equal(f.paints.length, paintCount);
  assert.equal(f.timers.size, 0);
  assert.doesNotMatch(JSON.stringify(f.paints), /api-secret|too late/);
});

test("poller explicitly labels the previous reading when a later API request fails", async () => {
  const f = pollerFixture();
  f.poller.enter();
  const data = { subscriptions: [{ name: "previous" }] };
  f.pending[0].resolve(data); await settle();
  const refresh = f.poller.refresh();
  f.pending[1].reject(new Error("api-secret")); await refresh;
  assert.equal(f.paints.at(-1).data, data);
  assert.match(f.paints.at(-1).error, /Showing the previous reading; limits may have changed/);
  assert.equal(f.paints.at(-1).loading, false);
  f.poller.leave();
});

test("subscription endpoint returns no-store JSON from its injected reader", async () => {
  const payload = { subscriptions: [], refreshAfterSeconds: 300 };
  const app = express();
  let reads = 0;
  app.use("/api", createSubscriptionsRouter({ readUsage: async () => { reads++; return payload; } }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/subscriptions`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), payload);
    assert.equal(reads, 1);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("real admin subscription route admits an administrator and rejects signed-out, run-key and demoted-member requests", async (t) => {
  const { saveSettings } = await import("../src/config/settings.js");
  const { setUser } = await import("../src/config/store.js");
  const { ensureUserAdminAccount } = await import("../src/config/admin-accounts.js");
  const { createAdminSession } = await import("../src/web/auth.js");
  const { createWebApp } = await import("../src/web/app.js");
  saveSettings({ publicUrl: "", adminPassword: "disposable-subscriptions-auth-fixture", apiKey: "fixture-subscription-run-key" });
  await setUser("USUBSCRIPTIONAUTH", { name: "Subscription fixture administrator", isAdmin: true });
  let cookie;
  createAdminSession({ headers: {} }, { setHeader: (_name, value) => { cookie = value.split(";")[0]; } }, ensureUserAdminAccount("USUBSCRIPTIONAUTH"));
  const app = createWebApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const headers of [{}, { "X-API-Key": "fixture-subscription-run-key" }, { Authorization: "Bearer fixture-subscription-run-key" }]) {
    assert.equal((await fetch(`${base}/api/subscriptions`, { headers })).status, 401);
  }
  const allowed = await fetch(`${base}/api/subscriptions`, { headers: { Cookie: cookie } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.deepEqual((await allowed.json()).subscriptions.map((row) => row.provider), (await import("../src/config/settings.js")).getEnabledEngines());
  await setUser("USUBSCRIPTIONAUTH", { isAdmin: false, approved: true });
  assert.equal((await fetch(`${base}/api/subscriptions`, { headers: { Cookie: cookie } })).status, 401);
  assert.throws(() => ensureUserAdminAccount("USUBSCRIPTIONAUTH"), /not an administrator/);
});

test("enabled harnesses are resolved on each read and unsupported engines never probe credentials", async () => {
  const { getEnabledEngines, saveSettings } = await import("../src/config/settings.js");
  const { ENGINE_IDS } = await import("../src/engines/registry.js");
  const credentialReads = [];
  const requests = [];
  const read = createReader({ credentials(engine) { credentialReads.push(engine); return connected(engine); }, now: () => START,
    fetchImpl: async (url) => { requests.push(url); return success(url.includes("anthropic") ? claudeBody() : codexBody()); } });
  try {
    saveSettings({ engineEnabled: Object.fromEntries(ENGINE_IDS.map((id) => [id, true])) });
    const result = await read();
    assert.deepEqual(result.subscriptions.map((row) => row.provider), getEnabledEngines());
    assert.deepEqual(credentialReads, ["claude", "codex", "codex-eu"]);
    assert.equal(requests.length, 3);
    for (const row of result.subscriptions.filter((item) => !credentialReads.includes(item.provider))) {
      assert.equal(row.status, "unsupported");
      assert.equal(row.windows.length, 0);
      assert.match(subscriptionCard(row), /Not supported/);
    }
    assert.equal(forProvider(result, "codex-eu").name, "Codex EU");
    saveSettings({ engineEnabled: Object.fromEntries(ENGINE_IDS.map((id) => [id, id === "codex-eu"])) });
    assert.deepEqual((await read()).subscriptions.map((row) => row.provider), ["codex-eu"]);
    assert.equal(requests.length, 3);
    saveSettings({ engineEnabled: Object.fromEntries(ENGINE_IDS.map((id) => [id, id === "codex"])) });
    assert.deepEqual((await read()).subscriptions.map((row) => row.provider), ["codex"]);
    assert.equal(requests.length, 4, "disabled harness cache was discarded");
  } finally { saveSettings({ engineEnabled: {} }); }
});

test("Codex EU credentials use only the dedicated login and never inherit a default API key", () => {
  const calls = [];
  let kind = "chatgpt";
  const credentials = createDaemonSubscriptionCredentials({ euHome: () => "/fixture/eu-login", env: { OPENAI_API_KEY: "fixture-default-key" },
    resolveCodex(options) { calls.push(options); return { kind, file: "fixture" }; },
    readCodex() { return { token: "fixture-eu-token", accountId: "fixture-eu-account", planType: "pro_lite" }; } });
  assert.equal(credentials("codex-eu", { provider: "codex", login: "codex-eu" }).accountId, "fixture-eu-account");
  assert.deepEqual(calls[0], { env: {}, candidates: ["/fixture/eu-login/auth.json"] });
  for (kind of ["none", "api-key"]) assert.deepEqual(credentials("codex-eu", { provider: "codex", login: "codex-eu" }), { kind: "none" });
  assert.equal(credentials("codex", { provider: "codex" }).kind, "api-key");
  assert.deepEqual(calls.at(-1), {});
});

test("Codex and Codex EU keep account headers, concurrent reads, failures and token changes isolated", async () => {
  let clock = START, euToken = "fixture-eu-token", euKind = "subscription", failEu = false;
  const requests = [];
  const gate = deferred();
  const read = createReader({ engines: () => ["codex", "codex-eu"], now: () => clock,
    credentials(engine) { return { kind: engine === "codex-eu" ? euKind : "subscription", token: engine === "codex-eu" ? euToken : "fixture-normal-token", accountId: engine }; },
    async fetchImpl(url, { headers }) {
      requests.push({ url, headers });
      await gate.promise;
      return headers["ChatGPT-Account-Id"] === "codex-eu" ? failEu ? new Response("ignored", { status: 503 }) : success(codexBody(77)) : success(codexBody(12));
    } });
  const first = read(), concurrent = read();
  await settle();
  assert.equal(requests.length, 2);
  gate.resolve();
  const [a, b] = await Promise.all([first, concurrent]);
  assert.deepEqual(a, b);
  assert.equal(forProvider(a, "codex").windows[0].usedPercent, 12);
  assert.equal(forProvider(a, "codex-eu").windows[0].usedPercent, 77);
  assert.deepEqual(requests.map(({ headers }) => [headers.Authorization, headers["ChatGPT-Account-Id"]]), [["Bearer fixture-normal-token", "codex"], ["Bearer fixture-eu-token", "codex-eu"]]);
  await read(); assert.equal(requests.length, 2);
  clock += TTL; failEu = true;
  const failed = await read();
  assert.equal(forProvider(failed, "codex").stale, false);
  assert.equal(forProvider(failed, "codex-eu").stale, true);
  euToken = "fixture-rotated-eu-token";
  const rotated = await read();
  assert.equal(forProvider(rotated, "codex-eu").stale, false);
  assert.deepEqual(forProvider(rotated, "codex-eu").windows, []);
  euKind = "none";
  assert.equal(forProvider(await read(), "codex-eu").status, "not-connected");
  assert.equal(requests.length, 5);
  assert.doesNotMatch(JSON.stringify(rotated), /fixture-.*token|Authorization|accountId/);
});

test("dedicated EU missing, malformed and API-key files cannot read another login's quota", async (t) => {
  const { writeFileSync, rmSync } = await import("node:fs");
  const path = await import("node:path");
  const home = tempDir("cg-subscription-eu-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const credentials = createDaemonSubscriptionCredentials({ euHome: () => home, env: { OPENAI_API_KEY: "fixture-default-api-key" } });
  const usage = { provider: "codex", login: "codex-eu" };
  assert.equal(credentials("codex-eu", usage).kind, "none");
  for (const body of ["malformed-json", JSON.stringify({ OPENAI_API_KEY: "fixture-eu-api-key" }), JSON.stringify({ tokens: { access_token: "bad-token" } })]) {
    writeFileSync(path.join(home, "auth.json"), body);
    assert.equal(credentials("codex-eu", usage).kind, "none");
  }
  const claims = Buffer.from(JSON.stringify({ exp: START / 1000 + 86400, "https://api.openai.com/auth": { chatgpt_plan_type: "pro_lite", chatgpt_account_id: "fixture-eu-account" } })).toString("base64url");
  const token = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${claims}.fixture-signature`;
  writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: token, refresh_token: "fixture-unused-refresh" } }));
  const credential = credentials("codex-eu", usage);
  assert.equal(credential.kind, "subscription");
  assert.equal(credential.accountId, "fixture-eu-account");
  assert.equal(credential.plan, "pro_lite");
  assert.equal(credential.token, token);
  assert.doesNotMatch(JSON.stringify(credential), /fixture-unused-refresh/);
});

test("Claude structured session and scoped model limits replace duplicate legacy windows", () => {
  const result = normalizeSubscriptionUsage("claude", { seven_day_opus: { utilization: 10 }, limits: [
    { kind: "session", percent: 0, resets_at: "2026-12-01T12:00:00Z" },
    { kind: "weekly_all", percent: 56 },
    { kind: "weekly_scoped", percent: 63, scope: { model: { display_name: "Fable" } } },
    { kind: "weekly_scoped", percent: 21, scope: { model: { display_name: "Opus" } } },
    { kind: "unknown", percent: 50 }, { kind: "weekly_scoped", percent: 999, scope: { model: { display_name: "Invalid" } } },
  ] });
  assert.deepEqual(result.windows.map((row) => [row.id, row.label, row.usedPercent]), [
    ["seven_day_opus", "Weekly · Opus", 21], ["five_hour", "Current session (5 hours)", 0], ["seven_day", "Weekly · all models", 56], ["seven_day_fable", "Weekly · Fable", 63],
  ]);
});

test("Codex reset allowances include safe counts and expiry details, cache together, and tolerate detail failure", async () => {
  let requests = [], fail = false, clock = START;
  const read = createSubscriptionUsageReader({ engines: () => ["codex"], credentials: connected, now: () => clock,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("reset-credits")) {
        if (fail) throw new Error("fixture-secret");
        return success({ available_count: 2, credits: [
          { id: "private-credit-id", status: "available", reset_type: "codex_rate_limits", expires_at: "2026-12-01T12:00:00Z", access_token: "private-token" },
          { status: "redeemed", title: "Do not expose", expires_at: "2026-12-02T12:00:00Z" },
          { status: "available", title: "Another reset", expires_at: "bad date" },
        ] });
      }
      return success({ ...codexBody(), rate_limit_reset_credits: { available_count: 2 } });
    } });
  const first = await read();
  assert.deepEqual(forProvider(first, "codex").resetCredits, { available: 2, resets: [{ label: "Full reset", expiresAt: "2026-12-01T12:00:00.000Z" }, { label: "Another reset", expiresAt: null }] });
  assert.equal(forProvider(first, "codex").kind, "subscription");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
  assert.deepEqual(requests[0].options.headers, requests[1].options.headers);
  assert.equal(requests[1].options.redirect, "error");
  await read(); assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(first), /private-credit-id|private-token|Do not expose/);
  clock += TTL; fail = true;
  const later = forProvider(await read(), "codex");
  assert.equal(later.status, "ok");
  assert.deepEqual(later.resetCredits, { available: 2, resets: [] });
  assert.equal(requests.length, 4);
  for (const value of [undefined, null, -1, "2", 1.2]) {
    assert.equal(normalizeSubscriptionUsage("codex", { rate_limit_reset_credits: { available_count: value } }).resetCredits, undefined);
  }
});

test("Claude reset grants preserve banked counts, usability and grant expiry without sensitive identifiers", () => {
  const result = normalizeSubscriptionUsage("claude", { ...claudeBody(), cedar_ember: {
    eligible: true, weekly_resets_at: "2026-12-08T00:00:00Z", grants: [
      { id: "private-reset-id", label: "Session reset", resets_left: 2, paused: false, usable_now: true, ends_at: "2026-12-01T00:00:00Z" },
      { resets_left: 1, paused: true, usable_now: true, ends_at: "2026-12-02T00:00:00Z" },
      { resets_left: 1, paused: false, usable_now: false },
      { resets_left: "5", paused: false, usable_now: true },
    ] } });
  assert.deepEqual(result.resetCredits, { available: 4, resets: [
    { label: "Session reset", expiresAt: "2026-12-01T00:00:00.000Z", remaining: 2, paused: false, usableNow: true },
    { label: "Usage reset", expiresAt: "2026-12-02T00:00:00.000Z", remaining: 1, paused: true, usableNow: true },
    { label: "Usage reset", expiresAt: null, remaining: 1, paused: false, usableNow: false },
  ] });
  assert.doesNotMatch(JSON.stringify(result), /private-reset-id|2026-12-08/);
  assert.deepEqual(normalizeSubscriptionUsage("claude", { cedar_ember: { grants: [] } }).resetCredits, { available: 0, resets: [] });
  assert.equal(normalizeSubscriptionUsage("claude", { cedar_ember: {} }).resetCredits, undefined);
});
