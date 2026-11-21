// What happens around an ENGINE license after it is added: it is deleted while threads, channels
// and pools still name it; its own model names (a custom server's vocabulary) are saved as
// defaults; its endpoint is moved; it is verified while an admin page holds unsaved edits; and the
// background memory reviewer has to pick a Claude sign-in. ("License" here is an engine license,
// never the product license of src/ee/.)
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";

ensureTestEnv();
const { saveSettings, getSettings, getSettingsVersion, getDefaultModel } = await import("../src/config/settings.js");
const store = await import("../src/config/engine-licenses.js");
const registry = await import("../src/engines/registry.js");
const { licenseDefaultModelKey, licenseDefaultEffortKey } = await import("../src/engines/license-adapters.js");
const sessions = await import("../src/gateway/sessions.js");
const threads = await import("../src/gateway/thread-engine.js");
const { effectiveMeta } = await import("../src/gateway/effective-meta.js");
const { buildResumeCommand } = await import("../src/slack/footer.js");
const { invalidModelOrEffort } = await import("../src/web/routes/helpers.js");
const { createSettingsRouter } = await import("../src/web/routes/settings.js");
const { createLicensesRouter } = await import("../src/web/routes/licenses.js");
const { createChannelsRouter } = await import("../src/web/routes/channels.js");
const { upsertChannelEntry, saveChannelMeta, getChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const { reviewLicenseCandidates } = await import("../src/gateway/memory-review.js");
const { recordUsage, usageSummary, usageDashboard } = await import("../src/gateway/usage.js");

const reset = (extra = {}) => saveSettings({ engineLicenses: [], engine: "claude", enginePool: "", engineEnabled: { claude: true, codex: true }, engineFallback: true, ...extra });
const API_KEY = "sk-fixture-engine-license-0002";
const custom = (extra = {}) => ({ kind: "claude-api", label: "Team server", type: "api", baseUrl: "https://llm.example.com/v1", apiKey: API_KEY, authScheme: "bearer", models: ["glm-4.6", "llama3.1:70b"], ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const app = express();
app.use(express.json());
app.use(createSettingsRouter());
app.use(createLicensesRouter());
app.use(createChannelsRouter());
app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ error: error.message }));
const server = createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => { server.closeAllConnections(); server.close(); });
const call = async (method, route, body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : {} };
};

test("a deleted license reads as gone everywhere a thread, a channel or a pool still names it", async () => {
  reset();
  const gone = store.createLicense({ kind: "codex-login", label: "Soon gone", type: "business" });
  const kept = store.createLicense({ kind: "codex-login", label: "Kept seat", type: "business" });
  await sessions.saveSession("lifecycle-gone", "100.1", "sess-gone", gone.id);
  await threads.setThreadEngine("lifecycle-gone", "100.1", gone.id, { licensePool: [kept.id] });
  assert.equal(await sessions.getSessionEngine("lifecycle-gone", "100.1"), gone.id);
  assert.equal(await sessions.getSession("lifecycle-gone", "100.1"), "sess-gone");
  assert.deepEqual(effectiveMeta({ engine: gone.id, licensePool: [kept.id] }).licensePool, [kept.id]);

  await store.deleteLicense(gone.id);
  assert.equal(registry.isEngineId(gone.id), false);
  assert.equal(registry.harnessOf(gone.id), "codex", "the id's shape still names its harness — existence is asked separately");

  // The session a deleted license minted cannot be resumed: every reader that names it says "none".
  assert.equal(await sessions.getSession("lifecycle-gone", "100.1"), "");
  assert.equal(await sessions.getSessionEngine("lifecycle-gone", "100.1"), "");
  assert.equal(await sessions.getSessionRuntime("lifecycle-gone", "100.1"), null);
  assert.equal(await sessions.hasThreadSession("lifecycle-gone", "100.1"), true, "the bot has still been in that thread");
  assert.equal(await threads.getThreadEngine("lifecycle-gone", "100.1"), "", "nor is the thread still pinned to it");
  // A channel default naming it follows the gateway default again, and its pool goes with it.
  const projected = effectiveMeta({ engine: gone.id, licensePool: [kept.id], model: "" });
  assert.equal(projected.engine, undefined);
  assert.equal(projected.licensePool, undefined);
  // A stored pool that still lists it is echoed back without it, so a settings page can save again.
  assert.deepEqual(registry.coherentLicensePool([gone.id, kept.id], "codex"), [kept.id]);
  assert.equal(registry.coherentLicensePool([gone.id], "codex"), "");
  // A reply footer for a session it ran offers no resume command, and does not throw.
  assert.equal(buildResumeCommand("/work", "sess-gone", gone.id), "");
  assert.notEqual(buildResumeCommand("/work", "sess-live", "claude"), "");
});

test("the only license switched on cannot be deleted", async () => {
  reset();
  const only = store.createLicense({ kind: "codex-login", label: "Only seat", type: "business" });
  saveSettings({ engine: only.id, engineEnabled: { claude: false, codex: false, [only.id]: true } });
  await assert.rejects(store.deleteLicense(only.id), (error) => error.status === 409 && /only license switched on/.test(error.message));
  assert.equal(registry.isEngineId(only.id), true, "a refused delete removes nothing");
  saveSettings({ engineEnabled: { claude: true, codex: false, [only.id]: true } });
  await store.deleteLicense(only.id);
  assert.equal(registry.isEngineId(only.id), false);
});

test("a model a license lists is accepted wherever a model is saved, and only for that license", async () => {
  reset();
  const lic = store.createLicense(custom());
  const other = store.createLicense(custom({ label: "Other server", baseUrl: "https://llm2.example.com/v1", models: ["other-large"] }));
  assert.equal(registry.isLicenseListedModel("glm-4.6"), true);
  assert.equal(registry.isLicenseListedModel("GLM-4.6", lic.id), true);
  assert.equal(registry.isLicenseListedModel("llama3.1:70b", lic.id), true);
  assert.equal(registry.isLicenseListedModel("glm-4.6", other.id), false, "another license's list does not admit it");
  assert.equal(registry.isLicenseListedModel("glm-4.6", "claude"), false, "a built-in harness lists nothing of its own");
  assert.equal(registry.isLicenseListedModel("made-up-model"), false);
  assert.equal(invalidModelOrEffort({ model: "glm-4.6" }), "");
  assert.match(invalidModelOrEffort({ model: "made-up-model" }), /unrecognized model/);

  // A license with a list of its own has a closed catalog; a sign-in license follows its harness.
  const manifest = (id) => registry.engineUiManifest().find((entry) => entry.id === id);
  assert.equal(manifest(lic.id).modelListClosed, true);
  assert.equal(manifest("claude").modelListClosed, false);
  assert.equal(registry.modelBelongsToEngine("sonnet", lic.id), false);

  // The gateway default model of that license takes one of its own names — and no other.
  const key = licenseDefaultModelKey(lic.id);
  assert.equal((await call("PUT", "/settings", { [key]: "llama3.1:70b" })).status, 200);
  assert.equal(getDefaultModel(lic.id), "llama3.1:70b");
  assert.equal((await call("PUT", "/settings", { [key]: "made-up-model" })).status, 400);
  assert.equal((await call("PUT", "/settings", { [key]: "other-large" })).status, 400, "another license's model is not this one's");
  assert.equal(getDefaultModel(lic.id), "llama3.1:70b");

  // Editing the list drops a default the license no longer lists, with the effort chosen for it.
  saveSettings({ [licenseDefaultEffortKey(lic.id)]: "high" });
  store.updateLicense(lic.id, { models: ["glm-4.6"] });
  assert.equal(getSettings()[key] || "", "");
  assert.equal(getSettings()[licenseDefaultEffortKey(lic.id)] || "", "");
  saveSettings({ [key]: "glm-4.6" });
  store.updateLicense(lic.id, { label: "Team server renamed" });
  assert.equal(getDefaultModel(lic.id), "glm-4.6", "a default it still lists survives an unrelated edit");
});

test("a model list over the limit is refused with the count, not silently cut", () => {
  reset();
  const many = Array.from({ length: 41 }, (_, i) => `team-model-${i}`);
  assert.throws(() => store.createLicense(custom({ models: many })), /at most 40 models; this list has 41/);
  assert.equal(store.createLicense(custom({ models: many.slice(0, 40) })).models.length, 40);
});

test("a custom server that refuses its model list is not called a rejected key", async () => {
  reset();
  const lic = store.createLicense(custom());
  const refused = await store.verifyLicense(lic.id, { fetchImpl: async () => json({ error: "forbidden" }, 403) });
  assert.equal(refused.verification.ok, true, "HTTP 403 on the list says nothing about turns");
  assert.equal(refused.verification.verified, false);
  assert.match(refused.verification.detail, /refused its model list \(HTTP 403\)/);
  const missing = await store.verifyLicense(lic.id, { fetchImpl: async () => json({ error: "not found" }, 404) });
  assert.equal(missing.verification.ok, true);
  assert.equal(missing.verification.verified, false);
  const rejected = await store.verifyLicense(lic.id, { fetchImpl: async () => json({ error: "bad key" }, 401) });
  assert.equal(rejected.verification.ok, false, "a 401 is still a rejected key");
  assert.ok(!JSON.stringify([refused, missing, rejected]).includes(API_KEY));
});

test("a check reports the settings version it moved, and a stale page is told so before its values are judged", async () => {
  reset();
  const lic = store.createLicense(custom());
  const before = getSettingsVersion();
  const checked = await store.verifyLicense(lic.id, { fetchImpl: async () => json({ data: [{ id: "glm-4.6" }] }) });
  assert.deepEqual(checked.settingsVersion, { from: before, to: getSettingsVersion() }, "exactly this check's own step");
  assert.notEqual(before, getSettingsVersion());

  // A page painted before the license was deleted still names it. It is stale, not wrong.
  const pageVersion = getSettingsVersion();
  saveSettings({ engineEnabled: { claude: true, codex: true } });
  const named = { engine: "codex", enginePool: ["codex-lic-deadbeef"] };
  const stale = await call("PUT", "/settings", { settingsVersion: pageVersion, ...named });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "settings_version_conflict");
  assert.equal(stale.body.stale, true);
  assert.ok(!stale.text.includes(API_KEY), "the repaint payload carries no key");
  // The same body from a current page is judged on its values.
  assert.equal((await call("PUT", "/settings", { settingsVersion: getSettingsVersion(), ...named })).status, 400);
  assert.equal((await call("PUT", "/settings", { settingsVersion: getSettingsVersion(), engine: "claude" })).status, 200);
});

test("a channel's model follows the license it is saved with", async () => {
  reset();
  testLicenseEnv({ tier: "enterprise" });
  const lic = store.createLicense(custom());
  const entry = await upsertChannelEntry("C_LIFECYCLE_MODEL", { name: "lifecycle-model", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: "C_LIFECYCLE_MODEL", name: entry.name, isDM: false }), engine: "claude", model: "sonnet", template: "custom" });
  const url = "/channels/C_LIFECYCLE_MODEL/meta";

  // A new model the resulting license cannot serve is refused, and nothing is stored.
  const wrong = await call("PUT", url, { model: "glm-4.6" });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /model "glm-4\.6" is not a .* model/);
  assert.equal((await getChannelMeta(entry.slug)).model, "sonnet");
  // The license and one of its own models, together.
  assert.equal((await call("PUT", url, { engine: lic.id, model: "glm-4.6" })).status, 200);
  assert.deepEqual([(await getChannelMeta(entry.slug)).engine, (await getChannelMeta(entry.slug)).model], [lic.id, "glm-4.6"]);
  // A license change that leaves the stored model behind drops it instead of keeping a stale pick.
  assert.equal((await call("PUT", url, { engine: "claude" })).status, 200);
  assert.deepEqual([(await getChannelMeta(entry.slug)).engine, (await getChannelMeta(entry.slug)).model || ""], ["claude", ""]);
  // An unrelated save leaves a matching model alone.
  assert.equal((await call("PUT", url, { model: "sonnet" })).status, 200);
  assert.equal((await call("PUT", url, { cleanMode: true })).status, 200);
  assert.equal((await getChannelMeta(entry.slug)).model, "sonnet");
});

test("the memory reviewer runs on a Claude sign-in the conversation may use, never on a metered server", () => {
  reset();
  assert.deepEqual(reviewLicenseCandidates({}), ["claude"]);
  const seat = store.createLicense({ kind: "claude-login", label: "Second Claude seat", type: "business" });
  const server_ = store.createLicense(custom());
  store.createLicense({ kind: "codex-login", label: "Codex seat", type: "business" });
  assert.equal(typeof registry.adapterFor(seat.id).claudeRunAccess, "function");
  assert.equal(registry.adapterFor(server_.id).claudeRunAccess, undefined);
  // An added sign-in may not be signed in on this machine: it is offered only when it is usable here.
  const candidates = reviewLicenseCandidates({});
  assert.equal(candidates[0], "claude", "the gateway's own login first");
  assert.ok(!candidates.includes(server_.id), "a custom server is never billed for a review nobody asked for");
  assert.ok(candidates.every((id) => registry.harnessOf(id) === "claude"));
  // A channel locked to the other harness gets no review; one locked to a license never borrows the default.
  assert.deepEqual(reviewLicenseCandidates({ approvedEngines: ["harness:codex"] }), []);
  assert.ok(!reviewLicenseCandidates({ approvedEngines: [seat.id] }).includes("claude"));
  // The switched-off default leaves only licenses that are switched on.
  saveSettings({ engineEnabled: { claude: true, codex: true, [seat.id]: false } });
  assert.deepEqual(reviewLicenseCandidates({}), ["claude"]);
});

test("a Claude sign-in license records each turn's own cost, in its harness's share of the bill", async () => {
  reset();
  const seat = store.createLicense({ kind: "claude-login", label: "Costed seat", type: "business" });
  const MODEL = "claude-opus-5-5";
  const terminal = (cost, out) => ({
    type: "result", subtype: "success", session_id: "sess-license-cost", total_cost_usd: cost,
    usage: { input_tokens: 4, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { [MODEL]: { inputTokens: 4, outputTokens: out, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost, contextWindow: 200000 } },
  });
  const record = (raw) => recordUsage({
    channelId: "C_LICENSE_COST", slug: "C_LICENSE_COST", authorId: "U1", engine: seat.id,
    result: { engine: seat.id, model: "opus", primaryModel: MODEL, sessionId: raw.session_id, usage: raw.usage, costUSD: raw.total_cost_usd, durationMs: 1000, raw },
  });
  const share = () => Number(usageDashboard({ range: "today", source: "gateway" }).totals.claudeCost);
  const before = share();
  const first = await record(terminal(0.30, 1000));
  const second = await record(terminal(0.42, 1400));
  assert.equal(first.costUSD, 0.30);
  assert.ok(Math.abs(second.costUSD - 0.12) < 1e-9, `the resumed turn is charged its own $0.12, not the session total (got ${second.costUSD})`);
  const summary = await usageSummary();
  const channel = summary.byChannel.find((row) => row.key === "C_LICENSE_COST");
  assert.ok(Math.abs(channel.costUSD - 0.42) < 1e-9);
  assert.ok(Math.abs(share() - before - 0.42) < 1e-3, "a license's spend is part of its harness's total");
});
