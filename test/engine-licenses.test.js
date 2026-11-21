// Engine licenses: an administrator adds as many as they hold, each becomes a live engine of its
// harness, a conversation selects one or several, and a channel can be locked to licenses or to
// whole harnesses. ("License" here is an ENGINE license — the ChannelGate product license is
// src/ee/license.js and is covered by the license-*.test.js files.)
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { saveSettings, getSettings, settingsForApi, getEnginePool, isEngineEnabled, getEngine } = await import("../src/config/settings.js");
const store = await import("../src/config/engine-licenses.js");
const registry = await import("../src/engines/registry.js");
const { licenseLoginHome, readLicensePool, storeLicensePool } = await import("../src/engines/license-state.js");
const pool = await import("../src/gateway/license-pool.js");
const policy = await import("../src/gateway/channel-engines.js");
const threads = await import("../src/gateway/thread-engine.js");
const { upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { createLicensesRouter } = await import("../src/web/routes/licenses.js");
const { createSettingsRouter } = await import("../src/web/routes/settings.js");
const { policyDiff } = await import("../src/config/channel-audit.js");

const jwt = (plan = "plus") => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 864000, "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_account_id: "lic-test" } })).toString("base64url")}.fixture`;
const signIn = (id, plan) => {
  mkdirSync(licenseLoginHome(id), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(licenseLoginHome(id), "auth.json"), JSON.stringify({ tokens: { access_token: jwt(plan), refresh_token: "fixture-refresh", account_id: "lic-test" } }), { mode: 0o600 });
};
const reset = () => saveSettings({ engineLicenses: [], engine: "claude", enginePool: "", engineEnabled: { claude: true, codex: true }, engineFallback: true });
const API_KEY = "sk-fixture-engine-license-0001";
const apiInput = (extra = {}) => ({ kind: "claude-api", label: "Team API", type: "api", baseUrl: "https://llm.example.com/v1", apiKey: API_KEY, authScheme: "bearer", models: ["team-large"], ...extra });

test("an added license is a live engine of its harness, and any number can be added", () => {
  reset();
  const before = registry.licensesOfHarness("codex").length;
  const made = [];
  for (let i = 0; i < 6; i++) made.push(store.createLicense({ kind: "codex-login", label: `Seat ${i}`, type: "business" }));
  assert.equal(new Set(made.map((r) => r.id)).size, 6);
  for (const record of made) {
    assert.match(record.id, /^codex-lic-[a-f0-9]{8}$/);
    assert.equal(registry.isEngineId(record.id), true, "registered without a restart");
    assert.equal(registry.harnessOf(record.id), "codex");
    assert.equal(registry.engineLabel(record.id), record.label);
    assert.equal(isEngineEnabled(record.id), true, "adding a license switches it on");
  }
  assert.equal(registry.licensesOfHarness("codex").length, before + 6);
  const manifest = registry.engineUiManifest().find((entry) => entry.id === made[0].id);
  assert.equal(manifest.harness, "codex");
  assert.equal(manifest.builtin, false);
  assert.equal(registry.engineUiManifest().find((entry) => entry.id === "codex").builtin, true);
});

test("a license needs a kind, a type its kind allows and a name nothing else uses", () => {
  reset();
  assert.throws(() => store.createLicense({ kind: "nope", label: "X" }), /kind of license/);
  assert.throws(() => store.createLicense({ kind: "codex-login", label: "X", type: "api" }), /license is one of/);
  assert.throws(() => store.createLicense({ kind: "codex-login", label: "  " }), /name/);
  const first = store.createLicense({ kind: "codex-login", label: "Work ChatGPT", type: "enterprise" });
  assert.throws(() => store.createLicense({ kind: "claude-login", label: "work chatgpt" }), (error) => error.status === 409);
  assert.throws(() => store.createLicense({ kind: "claude-login", label: "Codex" }), (error) => error.status === 409, "a built-in's name is taken too");
  assert.equal(store.updateLicense(first.id, { label: "Work ChatGPT", type: "business" }).type, "business", "renaming to its own name is not a clash");
  assert.throws(() => store.updateLicense("codex-lic-00000000", { label: "Ghost" }), (error) => error.status === 404);
});

test("an API license's key is write-only on every read path", () => {
  reset();
  assert.throws(() => store.createLicense(apiInput({ baseUrl: "http://llm.example.com" })), /https/);
  assert.throws(() => store.createLicense(apiInput({ apiKey: "short" })), /API key/);
  assert.throws(() => store.createLicense(apiInput({ models: [] })), /at least one model/);
  const record = store.createLicense(apiInput());
  const seen = store.licenseForApi(store.getLicenseRecord(record.id));
  assert.equal(seen.hasApiKey, true);
  assert.equal(seen.apiKeyLast4, API_KEY.slice(-4));
  assert.equal(seen.apiKey, undefined);
  assert.ok(!JSON.stringify(seen).includes(API_KEY));
  assert.ok(!JSON.stringify(settingsForApi()).includes(API_KEY), "the settings listing never carries a license key");
  assert.ok(!JSON.stringify(registry.engineUiManifest()).includes(API_KEY), "nor does the engine manifest");
  // A blank key on an edit keeps the stored one; a new endpoint is an unverified one.
  saveSettings((current) => ({ engineLicenses: current.engineLicenses.map((entry) => entry.id === record.id ? { ...entry, verification: { at: new Date().toISOString(), ok: true, verified: true, detail: "ok" } } : entry) }));
  assert.equal(store.getLicenseRecord(record.id).verification.ok, true);
  const kept = store.updateLicense(record.id, { label: "Team API 2", apiKey: "" });
  assert.equal(kept.apiKey, API_KEY);
  assert.equal(kept.verification.ok, true, "an unchanged credential keeps its verdict");
  const moved = store.updateLicense(record.id, { baseUrl: "https://llm.example.com/v2" });
  assert.equal(moved.verification, null);
  assert.equal(moved.apiKey, API_KEY, "another path on the same server keeps the stored key");
  // The stored key is only ever sent to the server it was saved for: another host needs the key again.
  assert.throws(() => store.updateLicense(record.id, { baseUrl: "https://llm2.example.com/v1" }), /Re-enter the API key to move this license to llm2\.example\.com/);
  assert.equal(store.getLicenseRecord(record.id).baseUrl, "https://llm.example.com/v2", "a refused move changes nothing");
  const rehomed = store.updateLicense(record.id, { baseUrl: "https://llm2.example.com/v1", apiKey: `${API_KEY}-2` });
  assert.equal(rehomed.baseUrl, "https://llm2.example.com/v1");
  assert.equal(rehomed.apiKey, `${API_KEY}-2`);
});

test("removing a license unregisters it and every default that named it", async () => {
  reset();
  const a = store.createLicense({ kind: "codex-login", label: "Seat A" });
  const b = store.createLicense({ kind: "codex-login", label: "Seat B" });
  signIn(a.id);
  saveSettings({ engine: a.id, enginePool: [b.id], [`licenseDefaultModel:${a.id}`]: "gpt-fixture" });
  assert.equal(getEngine(), a.id);
  await store.deleteLicense(b.id);
  assert.equal(getEnginePool(), "", "a removed license leaves the default's pool");
  await store.deleteLicense(a.id);
  assert.equal(registry.isEngineId(a.id), false);
  assert.equal(getEngine(), "codex", "the gateway default returns to the harness's own sign-in");
  assert.equal(Object.hasOwn(getSettings().engineEnabled || {}, a.id), false);
  assert.ok(!getSettings()[`licenseDefaultModel:${a.id}`]);
  assert.equal(existsSync(licenseLoginHome(a.id)), false, "its sign-in directory is removed");
  await assert.rejects(store.deleteLicense(a.id), (error) => error.status === 404);
});

test("a sign-in license is verified against the plan its own credential reports", async () => {
  reset();
  const record = store.createLicense({ kind: "codex-login", label: "Enterprise seat", type: "enterprise" });
  let status = await store.licenseStatusFor(record.id);
  assert.equal(status.ready, false);
  assert.equal(status.signedIn, false);
  assert.match(status.detail, /Not signed in/);
  signIn(record.id, "enterprise");
  status = await store.licenseStatusFor(record.id);
  assert.equal(status.ready, true);
  assert.equal(status.plan.matches, true);
  assert.equal(status.fingerprint, undefined, "the credential fingerprint never leaves the daemon");
  signIn(record.id, "plus");
  status = await store.licenseStatusFor(record.id);
  assert.equal(status.signedIn, true);
  assert.equal(status.ready, false, "a personal plan is not the Enterprise license it was declared as");
  assert.equal(status.plan.matches, false);
  store.updateLicense(record.id, { type: "subscription" });
  assert.equal((await store.licenseStatusFor(record.id)).ready, true);
});

test("an API license is verified by asking its endpoint, and a rejected key is not ready", async () => {
  reset();
  const record = store.createLicense(apiInput());
  const calls = [];
  const rejected = await store.verifyLicense(record.id, { fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401, headers: { "content-type": "application/json" } }); } });
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((call) => new URL(call.url).hostname === "llm.example.com"), "the key is sent to the license's own endpoint only");
  assert.equal(rejected.status.ready, false);
  assert.equal(store.getLicenseRecord(record.id).verification.ok, false);
  assert.equal((await registry.requireAdapter(record.id).selectionReadiness()).ready, false);
  const accepted = await store.verifyLicense(record.id, { fetchImpl: async () => new Response('{"data":[{"id":"team-large"}]}', { status: 200, headers: { "content-type": "application/json" } }) });
  assert.equal(accepted.status.ready, true);
  assert.equal(store.getLicenseRecord(record.id).verification.ok, true);
  assert.ok(!JSON.stringify(accepted).includes(API_KEY));
});

test("pool values: one license, any, or an ordered list of the same harness", () => {
  reset();
  const a = store.createLicense({ kind: "codex-login", label: "Pool A" });
  const b = store.createLicense({ kind: "codex-login", label: "Pool B" });
  const c = store.createLicense({ kind: "claude-login", label: "Pool C" });
  assert.equal(pool.normalizeLicensePool("", "codex"), "");
  assert.equal(pool.normalizeLicensePool([], "codex"), "");
  assert.equal(pool.normalizeLicensePool("any", "codex"), "any");
  assert.deepEqual(pool.normalizeLicensePool([b.id, "codex", a.id, b.id], "codex"), [b.id, a.id], "the license itself and repeats are dropped, order kept");
  assert.throws(() => pool.normalizeLicensePool([c.id], "codex"), (error) => error.status === 400 && /Codex license/.test(error.message));
  assert.throws(() => pool.normalizeLicensePool(["codex-lic-00000000"], "codex"), (error) => error.code === "invalid_license_pool");
  assert.throws(() => pool.normalizeLicensePool("any", ""), /Choose a license/);
  // Storage round-trip (thread rows store text; settings and channel meta store the value).
  assert.equal(storeLicensePool("any"), "any");
  assert.deepEqual(readLicensePool(storeLicensePool([a.id, b.id])), [a.id, b.id]);
  assert.equal(readLicensePool("garbage"), "");
  assert.equal(readLicensePool(undefined), "");
});

test("run-time candidates follow the live state: enabled, approved, signed in here, able to serve a picked model", () => {
  reset();
  const a = store.createLicense({ kind: "codex-login", label: "Cand A" });
  const b = store.createLicense({ kind: "codex-login", label: "Cand B" });
  assert.deepEqual(pool.licensePoolCandidates({ engine: "codex", pool: "", meta: {} }), [], "no pool, no candidates");
  assert.deepEqual(pool.licensePoolCandidates({ engine: "codex", pool: [b.id, a.id], meta: {} }), [b.id, a.id]);
  const any = pool.licensePoolCandidates({ engine: "codex", pool: "any", meta: {} });
  assert.ok(any.includes(a.id) && any.includes(b.id) && !any.includes("codex"));
  assert.ok(!any.includes("codex-channel"), "a channel account exists only where it was signed in");
  assert.ok(any.every((id) => registry.harnessOf(id) === "codex"), "a pool never crosses harnesses");
  saveSettings({ engineEnabled: { ...getSettings().engineEnabled, [a.id]: false } });
  assert.deepEqual(pool.licensePoolCandidates({ engine: "codex", pool: [a.id, b.id], meta: {} }), [b.id], "a switched-off license is skipped");
  assert.deepEqual(pool.licensePoolCandidates({ engine: "codex", pool: [a.id, b.id], meta: { approvedEngines: ["codex"] } }), [], "the channel lock applies to the pool");
  assert.deepEqual(pool.licensePoolCandidates({ engine: "codex", pool: [b.id], meta: { approvedEngines: ["harness:codex"] } }), [b.id]);
  // A picked model the candidate cannot serve keeps that candidate out.
  const api = store.createLicense(apiInput({ label: "Cand API" }));
  assert.deepEqual(pool.licensePoolCandidates({ engine: "claude", pool: [api.id], meta: {} }), [api.id]);
  assert.deepEqual(pool.licensePoolCandidates({ engine: "claude", pool: [api.id], meta: {}, model: "team-large" }), [api.id]);
  const claudeOnly = registry.modelsForEngine("claude").map((m) => m.value || m).find((m) => m && !registry.modelBelongsToEngine(m, api.id));
  if (claudeOnly) assert.deepEqual(pool.licensePoolCandidates({ engine: "claude", pool: [api.id], meta: {}, model: claudeOnly }), []);
});

test("the license selector is offered only when a harness has more than one license here", () => {
  reset();
  saveSettings({ engineEnabled: { claude: true, codex: true, "codex-eu": false } });
  assert.deepEqual(pool.selectableLicenses("codex", {}), ["codex"], "one license: nothing to choose between");
  assert.equal(pool.primaryLicenseOf("codex", {}), "codex");
  const a = store.createLicense({ kind: "codex-login", label: "Second seat" });
  assert.deepEqual(pool.selectableLicenses("codex", {}), ["codex", a.id]);
  assert.deepEqual(pool.selectableLicenses("codex", { approvedEngines: [a.id] }), [a.id], "a lock to one license leaves one");
  assert.equal(pool.primaryLicenseOf("codex", { approvedEngines: [a.id] }), a.id);
  assert.deepEqual(pool.describeLicenseSelection({ engine: "codex", pool: [a.id, "claude", "codex-lic-00000000"] }), { harness: "codex", license: "codex", pool: [a.id] });
});

test("pickers get one shape: harness, then a license step only when there is a choice", () => {
  reset();
  saveSettings({ engineEnabled: { claude: true, codex: true, "codex-eu": false } });
  assert.deepEqual(pool.selectableHarnesses({}), ["claude", "codex"]);
  assert.deepEqual(pool.selectableHarnesses({ approvedEngines: ["harness:codex"] }), ["codex"]);
  let picker = pool.licensePicker({ harness: "codex", meta: {}, engine: "codex", pool: "" });
  assert.equal(picker.show, false, "one license: no license step");
  assert.deepEqual(pool.resolveLicensePick({ harness: "codex", meta: {} }), { engine: "codex", licensePool: "" });
  assert.deepEqual(pool.resolveLicensePick({ harness: "codex", meta: {}, license: "any" }), { engine: "codex", licensePool: "" }, "`any` of one license is that license");
  assert.equal(pool.describeSelectionText({ engine: "codex", pool: "any", meta: {} }), "Codex");

  const a = store.createLicense({ kind: "codex-login", label: "Pick A" });
  const b = store.createLicense({ kind: "codex-login", label: "Pick B" });
  picker = pool.licensePicker({ harness: "codex", meta: {}, engine: a.id, pool: [b.id] });
  assert.equal(picker.show, true);
  assert.deepEqual(picker.licenses.map((item) => item.label), ["Default sign-in", "Pick A", "Pick B"]);
  assert.equal(picker.selected, a.id);
  assert.deepEqual(picker.also, [b.id]);
  assert.deepEqual(picker.others.map((item) => item.id), ["codex", b.id]);
  assert.equal(pool.licensePicker({ harness: "codex", meta: {}, engine: "codex", pool: "any" }).selected, "any");
  assert.equal(pool.licensePicker({ harness: "codex", meta: {}, engine: "claude", pool: "any" }).selected, "codex", "another harness's selection says nothing about this one");

  assert.deepEqual(pool.resolveLicensePick({ harness: "codex", meta: {}, license: "any" }), { engine: "codex", licensePool: "any" });
  assert.deepEqual(pool.resolveLicensePick({ harness: "codex", meta: {}, license: a.id, also: [b.id, a.id] }), { engine: a.id, licensePool: [b.id] });
  assert.deepEqual(pool.resolveLicensePick({ harness: "codex", meta: {}, license: b.id }), { engine: b.id, licensePool: "" });
  assert.deepEqual(pool.resolveLicensePick({ harness: "codex", meta: { approvedEngines: [a.id] }, license: "any" }), { engine: a.id, licensePool: "" });
  assert.throws(() => pool.resolveLicensePick({ harness: "codex", meta: { approvedEngines: [a.id] }, license: b.id }), /not available in this conversation/);
  assert.throws(() => pool.resolveLicensePick({ harness: "codex", meta: {}, license: a.id, also: ["claude"] }), (error) => error.code === "invalid_license_pool");
  assert.throws(() => pool.resolveLicensePick({ harness: "codex", meta: { approvedEngines: ["harness:claude"] } }), /no license this conversation can use/);

  assert.equal(pool.describeSelectionText({ engine: "codex", pool: "any", meta: {} }), "Codex · any license");
  assert.equal(pool.describeSelectionText({ engine: a.id, pool: [b.id], meta: {} }), "Codex · Pick A, then Pick B");
  assert.equal(pool.describeSelectionText({ engine: b.id, pool: "", meta: {} }), "Codex · Pick B");
  assert.equal(pool.describeSelectionText({ engine: "claude", pool: "", meta: {} }), "Claude Code");

  // A bare harness pick keeps the conversation's own choice for that harness, and implies nothing.
  assert.deepEqual(pool.harnessSelection("codex", { engine: a.id, licensePool: [b.id] }), { engine: a.id, licensePool: [b.id] });
  assert.deepEqual(pool.harnessSelection("codex", { engine: "codex", licensePool: "any" }), { engine: "codex", licensePool: "any" });
  assert.deepEqual(pool.harnessSelection("codex", { engine: "claude" }), { engine: "codex", licensePool: "" });
  assert.deepEqual(pool.harnessSelection("codex", { engine: a.id, licensePool: [b.id], approvedEngines: [a.id] }), { engine: a.id, licensePool: "" });
  saveSettings({ engine: b.id, enginePool: [a.id] });
  assert.deepEqual(pool.harnessSelection("codex", {}), { engine: b.id, licensePool: [a.id] }, "no channel choice: the gateway default's");
  assert.deepEqual(pool.harnessSelection("claude", {}), { engine: "claude", licensePool: "" });
});

test("a channel is locked to licenses, to whole harnesses, or both", () => {
  reset();
  const a = store.createLicense({ kind: "codex-login", label: "Lock A" });
  const b = store.createLicense({ kind: "claude-login", label: "Lock B" });
  assert.deepEqual(policy.normalizeApprovedEngines(["codex", "harness:claude"]), ["harness:claude", "codex"]);
  assert.throws(() => policy.normalizeApprovedEngines(["harness:gemini"]), (error) => error.code === "invalid_approved_engines");
  const harnessLock = { approvedEngines: ["harness:codex"] };
  assert.equal(policy.isChannelEngineApproved(harnessLock, "codex"), true);
  assert.equal(policy.isChannelEngineApproved(harnessLock, a.id), true);
  assert.equal(policy.isChannelEngineApproved(harnessLock, "claude"), false);
  assert.equal(policy.isChannelEngineApproved(harnessLock, b.id), false);
  const later = store.createLicense({ kind: "codex-login", label: "Lock later" });
  assert.equal(policy.isChannelEngineApproved(harnessLock, later.id), true, "a harness lock admits licenses added afterwards");
  const licenseLock = { approvedEngines: [a.id] };
  assert.equal(policy.isChannelEngineApproved(licenseLock, a.id), true);
  assert.equal(policy.isChannelEngineApproved(licenseLock, "codex"), false, "a license lock admits only that license");
  assert.equal(policy.isChannelEngineApproved({ approvedEngines: ["codex"] }, a.id), false, "a stored `codex` entry never widens to other Codex licenses");
  assert.equal(policy.isChannelEngineApproved({ approvedEngines: ["harness:claude", "harness:codex"] }, b.id), true);
  assert.match(policy.describeApprovedEngines(["harness:codex", b.id]), /Codex \(any license\), Lock B/);
  // What a person is told for a pick outside the list: the pick, then what the conversation may use.
  assert.equal(policy.channelEngineRefusal(harnessLock, a.id), "");
  assert.equal(policy.channelEngineRefusal({}, "claude"), "", "no list refuses nothing");
  assert.match(policy.channelEngineRefusal({ approvedEngines: ["harness:codex", b.id] }, "claude"), /^Claude is not approved for this conversation\. Approved here: Codex \(any license\), Lock B\. Pick one of those/);
  assert.match(policy.channelEngineRefusal({ approvedEngines: "codex" }, "codex"), /^Codex is not approved for this conversation\. Ask an Enterprise administrator to review/, "a malformed list approves nothing and names no alternative");
  assert.throws(() => policy.assertChannelEngineApproved(licenseLock, "codex"), /not an approved harness/);
  assert.throws(() => policy.assertApprovedEnginesUpdate({}, ["harness:codex"], { enterprise: false }), (error) => error.code === "enterprise_required");
  assert.deepEqual(policy.assertApprovedEnginesUpdate({}, ["harness:codex"], { enterprise: true }), ["harness:codex"]);
});

test("a lock that names a removed license stays closed instead of widening", async () => {
  reset();
  const a = store.createLicense({ kind: "codex-login", label: "Gone A" });
  const locked = { approvedEngines: [a.id] };
  const mixed = { approvedEngines: [a.id, "claude"] };
  await store.deleteLicense(a.id);
  assert.equal(policy.isChannelEngineApproved(locked, "codex"), false);
  assert.equal(policy.isChannelEngineApproved(locked, "claude"), false);
  assert.deepEqual(policy.normalizeApprovedEngines(locked.approvedEngines), [a.id], "kept as stored: it approves nothing");
  assert.equal(policy.isChannelEngineApproved(mixed, "claude"), true, "the remaining entries keep working");
  assert.deepEqual(policy.normalizeApprovedEngines(mixed.approvedEngines), ["claude"]);
});

test("a thread pin carries its own pool, and a plain pin drops an earlier one", async () => {
  reset();
  const a = store.createLicense({ kind: "codex-login", label: "Thread A" });
  const b = store.createLicense({ kind: "codex-login", label: "Thread B" });
  const entry = await upsertChannelEntry("C_LIC_THREAD", { name: "lic-thread", type: "channel" });
  await saveChannelMeta(entry.slug, { channelId: "C_LIC_THREAD", name: entry.name, type: "channel" });
  await threads.setThreadEngine(entry.slug, "100.1", a.id, { licensePool: [b.id] });
  assert.equal(await threads.getThreadEngine(entry.slug, "100.1"), a.id);
  assert.deepEqual(await threads.getThreadLicensePool(entry.slug, "100.1"), [b.id]);
  await threads.setThreadEngine(entry.slug, "100.1", "codex");
  assert.equal(await threads.getThreadLicensePool(entry.slug, "100.1"), "", "a `codex` directive names one license");
  threads.setThreadRuntimeOverrides(entry.slug, "100.2", { engine: "codex", licensePool: "any", model: "", effort: "" });
  assert.equal(await threads.getThreadLicensePool(entry.slug, "100.2"), "any");
  await store.deleteLicense(a.id);
  await threads.setThreadEngine(entry.slug, "100.3", b.id);
  await store.deleteLicense(b.id);
  assert.equal(await threads.getThreadEngine(entry.slug, "100.3"), "", "a pin naming a removed license is no pin");
  assert.equal(await threads.clearThreadRuntimeOverrides([entry.slug]) >= 2, true);
  assert.equal(await threads.getThreadLicensePool(entry.slug, "100.2"), "");
});

test("a channel's pool is stored beside its license, audited, and dropped with it", async () => {
  reset();
  const a = store.createLicense({ kind: "codex-login", label: "Chan A" });
  const c = store.createLicense({ kind: "claude-login", label: "Chan C" });
  const entry = await upsertChannelEntry("C_LIC_CHAN", { name: "lic-chan", type: "channel" });
  const base = { channelId: "C_LIC_CHAN", name: entry.name, type: "channel" };
  await saveChannelMeta(entry.slug, { ...base, engine: "codex", licensePool: [a.id, c.id, "codex"] });
  let meta = await getChannelMeta(entry.slug);
  assert.deepEqual(meta.licensePool, [a.id], "only licenses of the same harness, never the license itself");
  await saveChannelMeta(entry.slug, { ...meta, engine: "codex", licensePool: "any" });
  assert.equal((await getChannelMeta(entry.slug)).licensePool, "any");
  const diff = policyDiff({ engine: "codex", licensePool: [a.id] }, { engine: "codex", licensePool: "any" });
  assert.deepEqual(diff.licensePool, { from: [a.id], to: "any" });
  await saveChannelMeta(entry.slug, { ...(await getChannelMeta(entry.slug)), engine: "" });
  assert.equal((await getChannelMeta(entry.slug)).licensePool, "", "no license, no pool");
});

// ── Admin API ─────────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use("/api", createLicensesRouter({ verify: (id) => store.verifyLicense(id, { fetchImpl: async () => new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } }) }) }));
app.use("/api", createSettingsRouter({}));
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
const server = createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());
const call = async (method, route, body) => {
  const res = await fetch(`${baseUrl}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : {} };
};

test("the admin API adds, lists, edits, verifies and removes licenses without ever returning a key", async () => {
  reset();
  const listed = await call("GET", "/engine-licenses");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.licenses, []);
  assert.deepEqual(listed.body.catalog.harnesses.map((h) => h.id).sort(), ["claude", "codex"]);
  assert.ok(listed.body.catalog.kinds.some((kind) => kind.id === "codex-login" && kind.harness === "codex"));

  const bad = await call("POST", "/engine-licenses", { kind: "codex-login", label: "" });
  assert.equal(bad.status, 400);
  const seat = await call("POST", "/engine-licenses", { kind: "codex-login", label: "API seat", type: "business" });
  assert.equal(seat.status, 201);
  assert.equal(seat.body.license.status.ready, false, "a sign-in license starts signed out");
  assert.match(seat.body.license.loginCommand, /codex/);

  const api = await call("POST", "/engine-licenses", apiInput({ label: "API key one" }));
  assert.equal(api.status, 201);
  assert.ok(!api.text.includes(API_KEY));
  assert.equal(api.body.license.hasApiKey, true);
  assert.equal(api.body.license.verification.ok, true, "an API license is verified as it is added");

  const dup = await call("POST", "/engine-licenses", { kind: "claude-login", label: "api seat" });
  assert.equal(dup.status, 409);

  const edited = await call("PUT", `/engine-licenses/${seat.body.license.id}`, { label: "Renamed seat", kind: "claude-login" });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.license.label, "Renamed seat");
  assert.equal(edited.body.license.kind, "codex-login", "the kind of a license never changes");

  signIn(seat.body.license.id, "business");
  const verified = await call("POST", `/engine-licenses/${seat.body.license.id}/verify`);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.status.ready, true);

  const all = await call("GET", "/engine-licenses");
  assert.equal(all.body.licenses.length, 2);
  assert.ok(!all.text.includes(API_KEY));
  assert.equal((await call("GET", `/engine-licenses/${api.body.license.id}/login`)).status, 400, "only a ChatGPT sign-in license signs in from the browser");
  assert.equal((await call("POST", "/engine-licenses/codex-lic-00000000/verify")).status, 404);

  assert.equal((await call("DELETE", `/engine-licenses/${api.body.license.id}`)).status, 200);
  assert.equal((await call("DELETE", `/engine-licenses/${api.body.license.id}`)).status, 404);
  assert.equal(registry.isEngineId(api.body.license.id), false);
});

test("the gateway default takes a license pool, validated beside the default license", async () => {
  reset();
  const a = store.createLicense({ kind: "codex-login", label: "Default A" });
  const c = store.createLicense({ kind: "claude-login", label: "Default C" });
  signIn(a.id);
  let res = await call("PUT", "/settings", { engine: "codex", enginePool: [a.id] });
  assert.equal(res.status, 200);
  assert.deepEqual(getEnginePool(), [a.id]);
  assert.deepEqual(settingsForApi().enginePool, [a.id]);
  res = await call("PUT", "/settings", { enginePool: [c.id] });
  assert.equal(res.status, 400, "a pool never crosses harnesses");
  assert.deepEqual(getEnginePool(), [a.id]);
  res = await call("PUT", "/settings", { enginePool: "any" });
  assert.equal(res.status, 200);
  assert.equal(getEnginePool(), "any");
  res = await call("PUT", "/settings", { engine: "claude" });
  assert.equal(res.status, 200);
  assert.equal(getEnginePool(), "", "a new default license does not inherit the old one's pool");
});
