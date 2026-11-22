// An ENGINE license limited to ONE conversation: the per-channel customer account as an ordinary
// license of any kind, on either harness. What is proved here: what is stored and listed, where
// such a license may run (its conversation and the code channels opened from it — nowhere else),
// what it can never be (the gateway default, part of its pool, "the last license left"), and that
// both setting a limit and running on one need the Enterprise entitlement. ("License" here is an
// engine license, never the product license of src/ee/ — which is what the entitlement reads.)
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { ensureTestEnv, clearTestLicense, testLicenseEnv } from "./helpers.js";

ensureTestEnv();
const { saveSettings, getSettings, settingsForApi, getEngine, getEnginePool, isEngineEnabled } = await import("../src/config/settings.js");
const store = await import("../src/config/engine-licenses.js");
const registry = await import("../src/engines/registry.js");
const facts = await import("../src/engines/license-state.js");
const policy = await import("../src/gateway/channel-engines.js");
const pool = await import("../src/gateway/license-pool.js");
const threads = await import("../src/gateway/thread-engine.js");
const grants = await import("../src/gateway/egress/grants.js");
const { effectiveMeta } = await import("../src/gateway/effective-meta.js");
const { approvedHarnessOptions } = await import("../src/gateway/approved-harnesses.js");
const { createSettingsRouter } = await import("../src/web/routes/settings.js");
const { createLicensesRouter } = await import("../src/web/routes/licenses.js");
const { createChannelsRouter } = await import("../src/web/routes/channels.js");
const { upsertChannelEntry, saveChannelMeta, getChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const ui = await import("../public/admin-licenses.js");

const reset = (extra = {}) => {
  testLicenseEnv({ tier: "enterprise" });
  saveSettings({ engineLicenses: [], engine: "claude", enginePool: "", engineEnabled: { claude: true, codex: true }, engineFallback: true, ...extra });
};
const KEY = "fixture-channel-limit-key-0001";
const INPUTS = {
  "codex-login": { label: "Customer ChatGPT", type: "business" },
  "claude-login": { label: "Customer Claude", type: "business" },
  "codex-api": { label: "Customer OpenAI key", type: "api", apiKey: KEY },
  "claude-api": { label: "Customer server", type: "api", baseUrl: "https://llm.example.com/v1", apiKey: KEY, authScheme: "bearer", models: ["team-large"] },
  "claude-aws": { label: "Customer Bedrock", type: "api", region: "eu-central-1", apiKey: KEY },
  "codex-azure": { label: "Customer Azure", type: "enterprise", baseUrl: "https://acme.openai.azure.com/openai/v1", apiKey: KEY, authScheme: "api-key", apiVersion: "2025-04-01-preview", models: ["gpt-deploy"] },
};
const add = (kind, extra = {}) => store.createLicense({ kind, ...INPUTS[kind], ...extra });
const HOME = "C0LIMITHOME", OTHER = "C0LIMITOTHER";
const metaOf = (channelId, extra = {}) => ({ channelId, ...extra });

const app = express();
app.use(express.json());
app.use(createSettingsRouter());
app.use(createLicensesRouter({ verify: async () => ({ verification: null }) }));
app.use(createChannelsRouter());
app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ error: error.message }));
const server = createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => { server.closeAllConnections(); server.close(); testLicenseEnv(); });
const call = async (method, route, body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : {} };
};
const channel = async (id, extra = {}) => {
  const entry = await upsertChannelEntry(id, { name: id.toLowerCase(), type: "channel" });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: id, name: entry.name, type: "channel" }), template: "custom", ...extra });
  return entry;
};

test("a stored limit is one conversation id, and a broken one limits the license to nowhere", () => {
  assert.equal(facts.normalizeLicenseChannelId("  C0LIMITHOME "), "C0LIMITHOME");
  assert.equal(facts.normalizeLicenseChannelId("googlechat:spaces/AAAA"), "googlechat:spaces/AAAA", "a namespaced conversation id is kept whole");
  for (const bad of ["", "   ", "two words", "tab\there", "line\nbreak", null, 12, {}, "x".repeat(facts.MAX_LICENSE_CHANNEL_ID_LENGTH + 1)]) {
    assert.equal(facts.normalizeLicenseChannelId(bad), "", JSON.stringify(bad));
  }
  const base = { id: "codex-lic-0a0a0a0a", kind: "codex-login", label: "Seat", type: "business" };
  assert.equal(Object.hasOwn(facts.normalizeLicenseRecord(base), "channelId"), false, "an unlimited license stores nothing");
  assert.equal(facts.normalizeLicenseRecord({ ...base, channelId: HOME }).channelId, HOME);
  // A hand-edited or damaged limit must never read as "every conversation".
  assert.equal(facts.normalizeLicenseRecord({ ...base, channelId: "not a conversation" }).channelId, facts.UNUSABLE_LICENSE_CHANNEL);
  assert.equal(facts.normalizeLicenseChannelId(facts.UNUSABLE_LICENSE_CHANNEL), "", "the sentinel is not a conversation anyone can be in");
});

test("every kind of license, on both harnesses, runs only in the conversation it is limited to", () => {
  for (const kind of Object.keys(INPUTS)) {
    reset();
    const limited = add(kind, { channelId: HOME });
    const open = add(kind, { label: `${INPUTS[kind].label} (open)` });
    assert.equal(facts.licenseChannelOf(limited.id), HOME, kind);
    assert.equal(facts.isChannelLimitedLicense(limited.id), true, kind);
    assert.equal(facts.licenseChannelOf(open.id), "", kind);
    assert.equal(registry.isGatewayWideLicense(limited.id), false, kind);
    assert.equal(registry.isGatewayWideLicense(open.id), true, kind);

    assert.equal(policy.isChannelEngineApproved(metaOf(HOME), limited.id), true, `${kind}: its own conversation`);
    assert.equal(policy.isChannelEngineApproved(metaOf(OTHER), limited.id), false, `${kind}: another conversation`);
    assert.equal(policy.isChannelEngineApproved({}, limited.id), false, `${kind}: a conversation with no id is not its conversation`);
    assert.equal(policy.isChannelEngineApproved(null, limited.id), false, kind);
    assert.equal(policy.isChannelEngineApproved(metaOf(OTHER), open.id), true, `${kind}: an unlimited license is unaffected`);
    assert.equal(policy.engineAvailableForChannel(metaOf(HOME), limited.id), true, kind);
    assert.equal(policy.engineAvailableForChannel(metaOf(OTHER), limited.id), false, kind);

    const harness = limited.harness;
    assert.ok(pool.selectableLicenses(harness, metaOf(HOME)).includes(limited.id), `${kind}: offered in its conversation`);
    assert.ok(!pool.selectableLicenses(harness, metaOf(OTHER)).includes(limited.id), `${kind}: offered nowhere else`);
    assert.ok(pool.selectableLicenses(harness, metaOf(OTHER)).includes(open.id), kind);
    // "Any license" in another conversation never reaches it; in its own it is a candidate.
    assert.ok(!pool.licensePoolCandidates({ engine: harness, pool: "any", meta: metaOf(OTHER) }).includes(limited.id), kind);
    assert.ok(pool.licensePoolCandidates({ engine: harness, pool: "any", meta: metaOf(HOME) }).includes(limited.id), kind);
    assert.ok(!pool.licensePoolCandidates({ engine: harness, pool: [limited.id], meta: metaOf(OTHER) }).includes(limited.id), `${kind}: a stored pool naming it elsewhere is not a way in`);
    assert.throws(() => pool.resolveLicensePick({ harness, meta: metaOf(OTHER), license: limited.id }), /not available in this conversation/, kind);
    assert.equal(pool.resolveLicensePick({ harness, meta: metaOf(HOME), license: limited.id }).engine, limited.id, kind);
  }
});

test("a code channel opened from the limited conversation may use the license; a linked workspace may not", () => {
  reset();
  const limited = add("claude-login", { channelId: HOME });
  const code = metaOf("C0LIMITCODE", { codeChannel: { originChannelId: HOME } });
  assert.equal(policy.licenseFitsConversation(code, limited.id), true);
  assert.equal(policy.isChannelEngineApproved(code, limited.id), true);
  assert.equal(policy.isChannelEngineApproved(metaOf("C0LIMITCODE2", { codeChannel: { originChannelId: OTHER } }), limited.id), false);
  assert.equal(policy.isChannelEngineApproved(metaOf("D0LIMITLINK", { isDM: true, workspaceLink: { channelId: HOME } }), limited.id), false, "sharing a workspace does not share the account");
  // The approved-harness lock still applies on top: a limit admits, it never overrides the lock.
  assert.equal(policy.isChannelEngineApproved(metaOf(HOME, { approvedEngines: ["codex"] }), limited.id), false);
  assert.equal(policy.isChannelEngineApproved(metaOf(HOME, { approvedEngines: [limited.id] }), limited.id), true);
  assert.equal(policy.isChannelEngineApproved(metaOf(HOME, { approvedEngines: ["harness:claude"] }), limited.id), true);
});

test("a refusal names the reason: limited elsewhere, or limited here without Enterprise", () => {
  reset();
  const limited = add("codex-login", { channelId: HOME });
  assert.equal(policy.licenseLimitRefusal(metaOf(HOME), limited.id), "");
  assert.equal(policy.licenseLimitRefusal(metaOf(OTHER), limited.id), "elsewhere");
  assert.equal(policy.licenseLimitRefusal(metaOf(OTHER), "codex"), "", "an unlimited license has no limit to refuse on");
  assert.equal(policy.licenseLimitRefusal(metaOf(HOME), limited.id, { enterprise: false }), "enterprise");
  assert.equal(policy.licenseLimitRefusal(metaOf(OTHER), limited.id, { enterprise: false }), "elsewhere", "where it may run is answered first");

  assert.throws(() => policy.assertChannelEngineApproved(metaOf(OTHER), limited.id), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, "channel_engine_not_approved");
    assert.equal(error.details.licenseLimit, "elsewhere");
    assert.match(error.message, /Customer ChatGPT is limited to another conversation/);
    return true;
  });
  assert.doesNotThrow(() => policy.assertChannelEngineApproved(metaOf(HOME), limited.id));
  assert.match(policy.channelEngineRefusal(metaOf(OTHER), limited.id), /limited to another conversation.*Pick another license/);
  assert.equal(policy.channelEngineRefusal(metaOf(HOME), limited.id), "");
});

test("without the Enterprise entitlement a limit cannot be set and a limited license runs nowhere — clearing it is the way out", () => {
  reset();
  const limited = add("claude-api", { channelId: HOME });
  const open = add("codex-login");
  try {
    clearTestLicense();
    assert.equal(policy.isChannelEngineApproved(metaOf(HOME), limited.id), false, "not even in its own conversation");
    assert.ok(!pool.selectableLicenses("claude", metaOf(HOME)).includes(limited.id));
    assert.throws(() => policy.assertChannelEngineApproved(metaOf(HOME), limited.id), /need an active Enterprise license/);
    assert.match(policy.channelEngineRefusal(metaOf(HOME), limited.id), /Enterprise/);
    const enterpriseRequired = (error) => error.statusCode === 403 && /Enterprise/.test(error.message);
    assert.throws(() => add("codex-login", { label: "New limited", channelId: HOME }), enterpriseRequired);
    assert.throws(() => store.updateLicense(open.id, { channelId: HOME }), enterpriseRequired);
    assert.throws(() => store.updateLicense(limited.id, { channelId: OTHER }), enterpriseRequired, "moving a limit is setting one");
    assert.equal(store.getLicenseRecord(open.id).channelId, undefined, "a refused limit stores nothing");
    // An edit that leaves the limit alone still saves, and so does taking the limit off.
    assert.equal(store.updateLicense(limited.id, { label: "Renamed server" }).channelId, HOME);
    assert.equal(store.updateLicense(limited.id, { channelId: "" }).channelId, undefined);
    assert.equal(policy.isChannelEngineApproved(metaOf(OTHER), limited.id), true, "unlimited again, it is an ordinary license");
  } finally { testLicenseEnv({ tier: "enterprise" }); }
});

test("a limited license is never the gateway default, never in its pool, and never 'the last license left'", async () => {
  reset();
  const seat = add("codex-login", { label: "Team seat" });
  const second = add("codex-login", { label: "Second seat" });
  saveSettings({ engine: seat.id, enginePool: [second.id, "codex"] });
  assert.equal(getEngine(), seat.id);

  // Limiting the license the gateway runs on by default hands the default back to the harness's
  // own sign-in, and its pool goes with it.
  store.updateLicense(seat.id, { channelId: HOME });
  assert.equal(getSettings().engine, "codex");
  assert.equal(getSettings().enginePool, "");
  assert.equal(getEngine(), "codex");

  // Limiting a license that only sat in the pool takes it out of the pool.
  saveSettings({ engine: "codex", enginePool: [second.id] });
  store.updateLicense(second.id, { channelId: OTHER });
  assert.deepEqual(getEnginePool(), "");
  // Whatever a settings file says, a limited license is not what the gateway resolves to.
  saveSettings({ engine: seat.id });
  assert.equal(getEngine(), "claude");

  // The web settings page refuses both, by name.
  saveSettings({ engine: "codex", enginePool: "" });
  let res = await call("PUT", "/settings", { engine: seat.id });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Team seat is limited to one conversation and cannot be the gateway default/);
  res = await call("PUT", "/settings", { enginePool: [seat.id] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot be part of the gateway default/);
  assert.equal(getSettings().engine, "codex");

  // Switching every gateway-wide license off is refused even while a limited one stays on …
  res = await call("PUT", "/settings", { engineEnabled: { claude: false, codex: false } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at least one engine must stay enabled/);
  // … and a state that got there anyway is rescued without touching the limited license's switch.
  saveSettings({ engineEnabled: { claude: false, codex: false, [seat.id]: true, [second.id]: false } });
  assert.equal(isEngineEnabled("claude"), true, "the default harnesses come back");
  assert.equal(isEngineEnabled(seat.id), true);
  assert.equal(isEngineEnabled(second.id), false, "a limited license keeps its own switch");
});

test("the last gateway-wide license cannot be limited, and a limited one can always be deleted", async () => {
  reset();
  const only = add("claude-api");
  const limited = add("codex-login", { channelId: HOME });
  saveSettings({ engine: only.id, engineEnabled: { claude: false, codex: false, [only.id]: true, [limited.id]: true } });
  assert.throws(() => store.updateLicense(only.id, { channelId: HOME }), (error) => error.status === 409 && /only license switched on for the whole gateway/.test(error.message));
  assert.equal(store.getLicenseRecord(only.id).channelId, undefined);
  await assert.rejects(store.deleteLicense(only.id), (error) => error.status === 409, "the limited license beside it is not something the gateway can run on");
  await store.deleteLicense(limited.id);
  assert.equal(registry.isEngineId(limited.id), false);
  // With another gateway-wide license on, the same limit is accepted.
  saveSettings({ engineEnabled: { claude: true, codex: false, [only.id]: true } });
  assert.equal(store.updateLicense(only.id, { channelId: HOME }).channelId, HOME);
  assert.equal(getEngine(), "claude");
});

test("a conversation default naming a license limited elsewhere follows the gateway default; a thread pin is refused by name", async () => {
  reset();
  const limited = add("codex-login");
  // The order it happens in: both conversations picked the license while anyone could, and an
  // administrator limited it afterwards. (Picking it elsewhere once limited is refused on save.)
  const home = await channel(HOME, { engine: limited.id, licensePool: ["codex"] });
  const other = await channel(OTHER, { engine: limited.id, licensePool: ["codex"] });
  store.updateLicense(limited.id, { channelId: HOME });
  await assert.rejects(channel("C0LIMITTHIRD", { engine: limited.id }), /limited to another conversation/);

  const here = effectiveMeta(await getChannelMeta(home.slug));
  assert.equal(here.engine, limited.id);
  assert.deepEqual(here.licensePool, ["codex"]);
  const elsewhere = effectiveMeta(await getChannelMeta(other.slug));
  assert.equal(elsewhere.engine, undefined, "like a deleted license: no default here");
  assert.equal(elsewhere.licensePool, undefined, "and the pool chosen beside it goes with it");

  // A DM on a template: neither its own pick nor the template's reaches a license limited elsewhere.
  const dm = { channelId: "D0LIMITDM", isDM: true, template: "user", engine: limited.id, licensePool: "any" };
  assert.equal(effectiveMeta(dm).engine, "", "the DM follows the gateway default");
  assert.equal(effectiveMeta(dm).licensePool, "");
  saveSettings({ dmTemplates: { user: { engine: limited.id, licensePool: "any" } } });
  const templated = effectiveMeta({ channelId: "D0LIMITDM", isDM: true, template: "user" });
  assert.notEqual(templated.engine, limited.id);
  assert.equal(effectiveMeta({ channelId: HOME, isDM: true, template: "user" }).engine, limited.id, "the one conversation it belongs to still gets it");
  saveSettings({ dmTemplates: { user: { engine: "" } } });

  // An explicit pin is an explicit ask: refused where the license does not belong, kept where it does.
  await assert.rejects(threads.setThreadEngine(other.slug, "200.1", limited.id), /limited to another conversation/);
  assert.equal(await threads.getThreadEngine(other.slug, "200.1"), "");
  await threads.setThreadEngine(home.slug, "200.1", limited.id);
  assert.equal(await threads.getThreadEngine(home.slug, "200.1"), limited.id);
});

test("the admin API adds, lists, moves and clears a limit, and refuses a conversation it does not know", async () => {
  reset();
  await channel(HOME);
  await channel(OTHER);
  const unknown = await call("POST", "/engine-licenses", { kind: "claude-login", label: "Nowhere", type: "business", channelId: "C0NOSUCHPLACE" });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /not known to this gateway/);
  const malformed = await call("POST", "/engine-licenses", { kind: "claude-login", label: "Nowhere", type: "business", channelId: "two words" });
  assert.equal(malformed.status, 400);

  for (const kind of ["claude-login", "codex-login", "claude-api", "codex-api"]) {
    const added = await call("POST", "/engine-licenses", { kind, ...INPUTS[kind], channelId: HOME });
    assert.equal(added.status, 201, `${kind}: ${added.text}`);
    assert.equal(added.body.license.channelId, HOME, kind);
    assert.equal(added.body.license.channelLimited, true, kind);
    assert.ok(!added.text.includes(KEY), "a listing never carries the key");
  }
  const listed = await call("GET", "/engine-licenses");
  const limited = listed.body.licenses.filter((license) => license.channelLimited);
  assert.equal(limited.length, 4);
  assert.ok(limited.every((license) => license.channelId === HOME));
  const id = limited.find((license) => license.kind === "codex-login").id;
  assert.equal(registry.engineUiManifest().find((m) => m.id === id).limitedToChannel, HOME);
  assert.equal(registry.engineUiManifest().find((m) => m.id === "codex").limitedToChannel, "");

  // An edit that does not mention the limit keeps it; moving it needs a known conversation.
  let res = await call("PUT", `/engine-licenses/${id}`, { label: "Customer seat" });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.license.channelId, HOME);
  assert.equal((await call("PUT", `/engine-licenses/${id}`, { channelId: "C0NOSUCHPLACE" })).status, 400);
  res = await call("PUT", `/engine-licenses/${id}`, { channelId: OTHER });
  assert.equal(res.body.license.channelId, OTHER);
  assert.equal(policy.isChannelEngineApproved(metaOf(HOME), id), false, "moved: the old conversation loses it at once");
  assert.equal(policy.isChannelEngineApproved(metaOf(OTHER), id), true);
  res = await call("PUT", `/engine-licenses/${id}`, { channelId: "" });
  assert.equal(res.status, 200);
  assert.equal(res.body.license.channelId, "");
  assert.equal(res.body.license.channelLimited, false);
  assert.equal(policy.isChannelEngineApproved(metaOf(HOME), id), true);

  // Without Enterprise the same request is refused as an upgrade, not as a bad form.
  try {
    clearTestLicense();
    res = await call("PUT", `/engine-licenses/${id}`, { channelId: HOME });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Enterprise/);
  } finally { testLicenseEnv({ tier: "enterprise" }); }
});

test("a conversation's settings accept its own limited license and refuse another conversation's", async () => {
  reset();
  await channel(HOME);
  const other = await channel(OTHER);
  const limited = add("claude-api", { channelId: HOME });
  const mine = await call("PUT", `/channels/${HOME}/meta`, { engine: limited.id });
  assert.equal(mine.status, 200, mine.text);
  const theirs = await call("PUT", `/channels/${OTHER}/meta`, { engine: limited.id });
  assert.equal(theirs.status, 403, theirs.text);
  assert.match(theirs.body.error, /limited to another conversation/);
  assert.notEqual((await getChannelMeta(other.slug)).engine, limited.id, "nothing was stored");

  // The approved-harness lock lists only what this conversation could ever run on.
  const ids = (meta) => approvedHarnessOptions(meta).map((option) => option.value ?? option.id ?? option);
  assert.ok(JSON.stringify(ids(metaOf(HOME))).includes(limited.id));
  assert.ok(!JSON.stringify(ids(metaOf(OTHER))).includes(limited.id));
  assert.ok(!JSON.stringify(ids(null)).includes(limited.id));
});

test("a limited license's key is swapped only for containers of its own conversation", async () => {
  reset();
  const record = store.getLicenseRecord(add("claude-api", { channelId: HOME }).id);
  const targetOf = (channelId, meta = {}) => ({ backend: "container", meta: { channelId, ...meta }, container: { egress: { active: true, mode: "proxy", network: "none" } } });
  const metas = { [HOME]: { channelId: HOME }, [OTHER]: { channelId: OTHER }, C0LIMITCODE: { channelId: "C0LIMITCODE", codeChannel: { originChannelId: HOME } }, C0LIMITBARE: {} };
  const deps = { metaFor: async (id) => metas[id] || null };
  const swapped = async (channelId) => (await grants.resolveEgressGrant(grants.containerLicenseApiCredential({ target: targetOf(channelId), record }).token, deps))?.value || "";
  assert.equal(await swapped(HOME), KEY);
  assert.equal(await swapped("C0LIMITCODE"), KEY, "a code channel opened from it");
  assert.equal(await swapped(OTHER), "", "a placeholder held by any other channel is worth nothing");
  assert.equal(await swapped("C0LIMITBARE"), "", "a stored record without its id is still the grant's own channel, which is not the license's");
  // Moving the limit moves where the key answers, with nothing re-issued.
  store.updateLicense(record.id, { channelId: OTHER });
  assert.equal(await swapped(HOME), "");
  assert.equal(await swapped(OTHER), KEY);
});

test("the dashboard pickers offer a limited license only where it belongs", () => {
  reset();
  const limited = add("codex-login", { channelId: HOME });
  const open = add("codex-login", { label: "Open seat" });
  const env = (channelIds) => ({ manifests: registry.engineUiManifest(), enabled: settingsForApi().engineEnabled, codexAuthSource: "", policy: null, ...(channelIds ? { channelIds } : {}) });
  const manifest = registry.engineUiManifest().find((m) => m.id === limited.id);
  assert.equal(ui.fitsConversation(env([HOME]), manifest), true);
  assert.equal(ui.fitsConversation(env([OTHER]), manifest), false);
  assert.equal(ui.fitsConversation(env(), manifest), false, "the gateway default and the templates stand in no conversation");
  for (const [where, meta] of [[[HOME], metaOf(HOME)], [[OTHER], metaOf(OTHER)], [["C0LIMITCODE", HOME], metaOf("C0LIMITCODE", { codeChannel: { originChannelId: HOME } })]]) {
    assert.deepEqual(ui.usableLicenses(env(where), "codex"), pool.selectableLicenses("codex", meta), `the page and the server agree for ${where}`);
  }
  assert.ok(ui.usableLicenses(env(), "codex").includes(open.id));
  assert.ok(!ui.usableLicenses(env(), "codex").includes(limited.id));
});

test("the admin UI: 'Available in' limits a license, and only that conversation's picker offers it", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  reset();
  const homeId = "C0LIMITPAGEHOME", otherId = "C0LIMITPAGEOTHER";
  await channel(homeId, { engine: "codex" });
  await channel(otherId, { engine: "codex" });
  const seat = add("codex-login");

  const pageApp = express();
  pageApp.use(express.json());
  // This focused router fixture represents an authenticated admin; real login is tested separately.
  pageApp.get("/api/auth/me", (_req, res) => res.json({ bootstrap: false, linkRequired: false, fresh: true, account: { userId: "U_BROWSER_ADMIN" }, passkeys: [] }));
  pageApp.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  pageApp.get("/api/health", (_req, res) => res.json({ slack: { connected: false, status: "off" }, engines: {} }));
  pageApp.use("/api", createAdminRouter({ slack: { getClient: () => null, snapshot: () => ({ status: "disconnected", connected: false }) } }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  pageApp.use(express.static(publicDir, { dotfiles: "allow" }));
  for (const route of ["/conversations/channel/:id", "/settings", "/settings/:section"]) pageApp.get(route, (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const pageServer = await new Promise((resolve) => { const s = pageApp.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { pageServer.closeAllConnections(); pageServer.close(resolve); }));
  const browser = await chromium.launch({ headless: true, ...(process.env.CG_BROWSER_EXECUTABLE ? { executablePath: process.env.CG_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = `http://127.0.0.1:${pageServer.address().port}`;
  const license = page.locator(".ch-engine-field + .lic-field .lic-select");
  const offered = async (channelId) => {
    await page.goto(`${origin}/conversations/channel/${channelId}`);
    await page.locator('[data-pane="runtime"].subtab').click();
    await page.locator(".ch-engine").waitFor();
    return (await license.isVisible()) ? license.locator("option").evaluateAll((options) => options.map((o) => o.value)) : [];
  };

  // Unlimited, both conversations offer it.
  assert.ok((await offered(homeId)).includes(seat.id));
  assert.ok((await offered(otherId)).includes(seat.id));

  // Settings → Engine licenses → the form: "Available in" lists the conversations by name.
  await page.goto(`${origin}/settings`);
  const manager = page.locator("#engine-enabled-box");
  const row = manager.locator(`.lic-row[data-license="${seat.id}"]`);
  await row.waitFor();
  assert.doesNotMatch(await row.textContent(), /Only in/);
  await row.locator(".lic-edit").click();
  const form = manager.locator(".lic-form");
  const limit = form.locator(".lic-channel");
  await limit.locator(`option[value="${homeId}"]`).waitFor({ state: "attached" });
  assert.equal(await limit.inputValue(), "", "an unlimited license reads Every conversation");
  assert.equal(await limit.locator("option").first().textContent(), "Every conversation");
  assert.ok((await limit.locator("option").evaluateAll((options) => options.map((o) => o.value))).includes(otherId));

  // Saving the form untouched never rewrites the limit; choosing a conversation sends its id.
  let saved = page.waitForResponse((r) => r.url().endsWith(`/api/engine-licenses/${seat.id}`) && r.request().method() === "PUT");
  await form.locator(".lic-save").click();
  let response = await saved;
  assert.equal(response.status(), 200, await response.text());
  assert.equal(Object.hasOwn(response.request().postDataJSON(), "channelId"), false);
  await row.locator(".lic-edit").click();
  await limit.locator(`option[value="${homeId}"]`).waitFor({ state: "attached" });
  await limit.selectOption(homeId);
  saved = page.waitForResponse((r) => r.url().endsWith(`/api/engine-licenses/${seat.id}`) && r.request().method() === "PUT");
  await form.locator(".lic-save").click();
  response = await saved;
  assert.equal(response.status(), 200, await response.text());
  assert.equal(response.request().postDataJSON().channelId, homeId);
  assert.equal(store.getLicenseRecord(seat.id).channelId, homeId);
  await row.filter({ hasText: "Only in" }).waitFor();
  assert.match(await row.textContent(), new RegExp(`Only in .*${homeId.toLowerCase()}`), "the row names the conversation");
  // The form of a limited license shows its conversation again.
  await row.locator(".lic-edit").click();
  await limit.locator(`option[value="${homeId}"]`).waitFor({ state: "attached" });
  assert.equal(await limit.inputValue(), homeId);
  await form.locator(".lic-cancel").click();

  // The gateway default never offers it; its own conversation does; the other one does not.
  await page.locator("#set-engine").selectOption("codex");
  const gatewayLicense = page.locator("#set-engine").locator("xpath=ancestor::label[1]/following-sibling::label[contains(@class,'lic-field')][1]");
  const gatewayOptions = (await gatewayLicense.isVisible()) ? await gatewayLicense.locator("option").evaluateAll((options) => options.map((o) => o.value)) : [];
  assert.ok(!gatewayOptions.includes(seat.id));
  assert.ok((await offered(homeId)).includes(seat.id));
  assert.ok(!(await offered(otherId)).includes(seat.id));
  assert.deepEqual(errors, []);
});
