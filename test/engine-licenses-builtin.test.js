// The licenses the gateway SHIPS with (src/config/engine-licenses.js, the second half).
//
// A harness's own sign-in (`claude`, `codex`) can be renamed and never removed; every other shipped
// license — the dedicated logins and the provider table (Qwen, Qwen EU, Codex EU, Claude Extra, the
// channel-account Codex) — can be removed and restored. Removed means: off whatever the enable map
// says, listed nowhere, its own credential deleted, the id still registered.
import { openSetting } from "./settings-navigation-helper.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { saveSettings, getSettings, settingsForApi, isEngineEnabled, getEnabledEngines, getEngine, qwenProviderSettings, hasQwenApiKey } = await import("../src/config/settings.js");
const store = await import("../src/config/engine-licenses.js");
const registry = await import("../src/engines/registry.js");
const state = await import("../src/engines/license-state.js");
const pool = await import("../src/gateway/license-pool.js");
const policy = await import("../src/gateway/channel-engines.js");
const { validateEngineAdapter } = await import("../src/engines/contract.js");
const { codexEuLoginHome } = await import("../src/engines/codex-eu.js");
const { bedrockLoginHome } = await import("../src/engines/bedrock.js");
const { createLicensesRouter } = await import("../src/web/routes/licenses.js");
const { createSettingsRouter } = await import("../src/web/routes/settings.js");
const { readEvents } = await import("../src/util/logger.js");
const ui = await import("../public/admin-licenses.js");

const QWEN_KEY = "sk-fixture-qwen-builtin-0001";
const REMOVABLE = ["codex-channel", "codex-eu", "claude-bedrock", "qwen", "qwen-eu"];
const reset = () => saveSettings({
  engineLicenses: [], licenseNames: {}, removedLicenses: [], engine: "claude", enginePool: "",
  engineEnabled: { claude: true, codex: true }, qwenApiKey: "", qwenBaseUrl: "", qwenEuApiKey: "", qwenEuBaseUrl: "",
  defaultQwenModel: "", defaultQwenEffort: "",
});
const manifestOf = (id) => registry.engineUiManifest().find((m) => m.id === id) || null;

test("which shipped licenses can be renamed and which can be removed is a registry fact", () => {
  reset();
  for (const id of ["claude", "codex"]) {
    assert.equal(registry.isDefaultLicense(id), true);
    assert.equal(registry.isRemovableBuiltinLicense(id), false, `${id} is what every selection falls back to`);
    assert.deepEqual([manifestOf(id).defaultLicense, manifestOf(id).removable, manifestOf(id).customName], [true, false, ""]);
  }
  assert.deepEqual(registry.engineRegistry.builtinIds.filter(registry.isRemovableBuiltinLicense).sort(), [...REMOVABLE].sort(), "every shipped license but the two sign-ins");
  for (const id of REMOVABLE) assert.deepEqual([manifestOf(id).defaultLicense, manifestOf(id).removable], [false, true]);
  // What removal deletes is declared by the adapter and only its KIND reaches a browser.
  assert.deepEqual(Object.fromEntries(REMOVABLE.map((id) => [id, manifestOf(id).ownCredential])), {
    "codex-channel": "", "codex-eu": "sign-in", "claude-bedrock": "sign-in", qwen: "api-key", "qwen-eu": "api-key",
  });
  assert.deepEqual(registry.adapterFor("qwen").ownCredential.settingsKeys, ["qwenApiKey", "qwenBaseUrl"]);
  assert.deepEqual(registry.adapterFor("qwen-eu").ownCredential.settingsKeys, ["qwenEuApiKey", "qwenEuBaseUrl"]);
  assert.equal(registry.adapterFor("codex-eu").ownCredential.directory(), codexEuLoginHome());
  assert.equal(registry.adapterFor("claude-bedrock").ownCredential.directory(), bedrockLoginHome());
  // An added license is a record: neither a default nor a removable built-in.
  const added = store.createLicense({ kind: "codex-login", label: "Second seat", type: "business" });
  assert.deepEqual([registry.isDefaultLicense(added.id), registry.isRemovableBuiltinLicense(added.id), manifestOf(added.id).removable], [false, false, false]);
});

test("a malformed ownCredential fact refuses to load", () => {
  const base = registry.adapterFor("qwen");
  for (const bad of [{}, { kind: "api-key" }, { kind: "password", settingsKeys: ["x"] }, { kind: "api-key", settingsKeys: [] }, { kind: "sign-in", directory: "/tmp/x" }, null]) {
    assert.throws(() => validateEngineAdapter({ ...base, ownCredential: bad }), /malformed ownCredential/, JSON.stringify(bad));
  }
});

test("a harness's own sign-in can be renamed, everywhere a license is named", () => {
  reset();
  const extra = store.createLicense({ kind: "claude-login", label: "Second Claude", type: "business" });
  assert.equal(registry.licenseLabel("claude"), "Default sign-in");

  const renamed = store.renameBuiltinLicense("claude", "  Company   Max\u0007 ");
  assert.equal(renamed.label, "Company Max", "trimmed, control characters and runs of spaces collapsed");
  assert.equal(renamed.previousLabel, "Default sign-in");
  assert.deepEqual(getSettings().licenseNames, { claude: "Company Max" });
  assert.equal(registry.licenseLabel("claude"), "Company Max");
  assert.equal(registry.licenseLabel("codex"), "Default sign-in", "the other harness keeps its own name");
  assert.equal(registry.engineLabel("claude"), "Claude", "the engine label (usage rows, audit) is not the license name");
  assert.deepEqual([manifestOf("claude").licenseLabel, manifestOf("claude").customName], ["Company Max", "Company Max"]);

  // The picker every chat surface renders, and the admin UI's own.
  const picker = pool.licensePicker({ harness: "claude", meta: {}, engine: "claude", pool: "" });
  assert.deepEqual(picker.licenses.map((l) => [l.id, l.label]), [["claude", "Company Max"], [extra.id, "Second Claude"]]);
  const env = { manifests: registry.engineUiManifest(), enabled: settingsForApi().engineEnabled, policy: null };
  assert.deepEqual(ui.licensePickerState(env, { harness: "claude", engine: "claude" }).licenses[0], { id: "claude", label: "Company Max" });
  assert.equal(ui.engineDisplayName(env.manifests, "claude"), "Claude Code · Company Max");
  assert.equal(ui.engineDisplayName(env.manifests, "codex"), "Codex", "an unnamed sign-in still reads as its harness");

  // A name is unique across added licenses, the other shipped licenses and their engine labels.
  assert.throws(() => store.renameBuiltinLicense("codex", "second claude"), (e) => e.status === 409);
  assert.throws(() => store.renameBuiltinLicense("codex", "Company Max"), (e) => e.status === 409);
  assert.throws(() => store.renameBuiltinLicense("codex", "claude"), (e) => e.status === 409, "another shipped license's engine label");
  assert.throws(() => store.renameBuiltinLicense("codex", "Qwen (Claude Code)"), (e) => e.status === 409);
  assert.throws(() => store.renameBuiltinLicense("codex", "x".repeat(61)), (e) => e.status === 400);
  assert.equal(registry.licenseLabel("codex"), "Default sign-in", "a refused rename stores nothing");
  // …and the taken name is refused for a new or edited license too.
  assert.throws(() => store.createLicense({ kind: "claude-login", label: "company max" }), (e) => e.status === 409);
  assert.throws(() => store.updateLicense(extra.id, { label: "Company Max" }), (e) => e.status === 409);
  // "Default sign-in" stays reserved while a sign-in carries another name: clearing puts it back.
  assert.throws(() => store.createLicense({ kind: "claude-login", label: "Default sign-in" }), (e) => e.status === 409);
  // Saving the name it already has is not a conflict with itself.
  assert.equal(store.renameBuiltinLicense("claude", "Company Max").label, "Company Max");

  // Blank — or the default typed back — restores "Default sign-in".
  assert.equal(store.renameBuiltinLicense("claude", "default SIGN-in").label, "Default sign-in");
  assert.deepEqual(getSettings().licenseNames, {});
  store.renameBuiltinLicense("claude", "Company Max");
  const cleared = store.renameBuiltinLicense("claude", "");
  assert.deepEqual([cleared.label, cleared.previousLabel], ["Default sign-in", "Company Max"]);
  assert.equal(manifestOf("claude").customName, "");

  assert.throws(() => store.renameBuiltinLicense("codex-lic-00000000", "Mine"), (e) => e.status === 404);
});

test("every other shipped license can be renamed too, and reads under that name everywhere", () => {
  reset();
  const shipped = registry.adapterFor("codex-channel").label;
  const renamed = store.renameBuiltinLicense("codex-channel", " Customer  ChatGPT ");
  assert.deepEqual([renamed.label, renamed.previousLabel, renamed.shippedLabel, renamed.defaultLicense, renamed.removable], ["Customer ChatGPT", shipped, shipped, false, true]);
  assert.deepEqual(getSettings().licenseNames, { "codex-channel": "Customer ChatGPT" });
  assert.equal(registry.licenseLabel("codex-channel"), "Customer ChatGPT");
  assert.equal(registry.engineLabel("codex-channel"), "Customer ChatGPT");
  assert.equal(registry.engineDisplayName("codex-channel"), "Customer ChatGPT");
  assert.deepEqual([manifestOf("codex-channel").label, manifestOf("codex-channel").shippedLabel, manifestOf("codex-channel").customName], ["Customer ChatGPT", shipped, "Customer ChatGPT"]);
  // The name is taken for everything else, and the shipped label stays reserved for this license.
  assert.throws(() => store.renameBuiltinLicense("qwen", "customer chatgpt"), (e) => e.status === 409);
  assert.throws(() => store.renameBuiltinLicense("qwen", shipped), (e) => e.status === 409);
  assert.throws(() => store.createLicense({ kind: "codex-login", label: "Customer ChatGPT", type: "business" }), (e) => e.status === 409);
  assert.throws(() => store.renameBuiltinLicense("qwen", "Default sign-in"), (e) => e.status === 409);
  // A harness's own sign-in keeps reading as the harness where no harness is shown beside it.
  store.renameBuiltinLicense("claude", "Company Max");
  assert.deepEqual([registry.engineLabel("claude"), registry.engineDisplayName("claude"), registry.engineDisplayName("codex")], ["Claude", "Claude Code · Company Max", "Codex"]);
  const added = store.createLicense({ kind: "codex-login", label: "Second seat", type: "business" });
  assert.equal(registry.engineDisplayName(added.id), "Codex · Second seat");
  // Blank — or the shipped label typed back — restores it.
  assert.equal(store.renameBuiltinLicense("codex-channel", shipped.toUpperCase()).label, shipped);
  store.renameBuiltinLicense("codex-channel", "Customer ChatGPT");
  const cleared = store.renameBuiltinLicense("codex-channel", "");
  assert.deepEqual([cleared.label, cleared.previousLabel, registry.engineLabel("codex-channel")], [shipped, "Customer ChatGPT", shipped]);
  // A removed license is restored before it is renamed.
  store.removeBuiltinLicense("qwen-eu");
  assert.throws(() => store.renameBuiltinLicense("qwen-eu", "Mine"), (e) => e.status === 409);
});

test("stored names and removals are normalized: names are id-keyed strings, a sign-in is never removed", () => {
  assert.deepEqual(state.normalizeLicenseNames({ claude: " A  b ", codex: "x".repeat(61), qwen: "Mine", extra: 1, "Bad Id": "x", __proto__: "x" }), { claude: "A b", qwen: "Mine" });
  // A name stored under an id that is not a shipped license is never read.
  state.setBuiltinLicenseState({ names: { "codex-lic-00000000": "Ghost" } });
  assert.equal(registry.licenseLabel("codex-lic-00000000"), "codex-lic-00000000");
  state.setBuiltinLicenseState({});
  assert.deepEqual(state.normalizeLicenseNames(["claude"]), {});
  assert.deepEqual(state.normalizeRemovedLicenses(["qwen", "qwen", "claude", "codex", 7, "Bad Id", "qwen-eu"]), ["qwen", "qwen-eu"]);
  assert.deepEqual(state.normalizeRemovedLicenses("qwen"), []);
  // A hand-edited file naming a sign-in, an added license or an unknown id removes nothing.
  reset();
  const added = store.createLicense({ kind: "codex-login", label: "Kept seat", type: "business" });
  saveSettings({ removedLicenses: ["claude", "codex", added.id, "no-such-engine"] });
  for (const id of ["claude", "codex", added.id]) {
    assert.equal(registry.isRemovedLicense(id), false);
    assert.equal(isEngineEnabled(id), true);
    assert.ok(manifestOf(id));
  }
  assert.deepEqual(store.listRemovedBuiltinLicenses(), []);
});

test("removing Qwen switches it off for good, unlists it and deletes its key and endpoint", async () => {
  reset();
  saveSettings({
    qwenApiKey: QWEN_KEY, qwenBaseUrl: "https://qwen.example.com/anthropic", defaultQwenModel: "qwen3-coder-plus", defaultQwenEffort: "high",
    engineEnabled: { claude: true, codex: true, qwen: true }, engine: "qwen", enginePool: ["qwen-eu"],
  });
  assert.equal(isEngineEnabled("qwen"), true);
  assert.equal(hasQwenApiKey("qwen"), true);
  assert.equal(getEngine(), "qwen");

  const removed = await store.removeBuiltinLicense("qwen");
  assert.deepEqual([removed.id, removed.harness, removed.removed, removed.ownCredential, removed.engineLabel], ["qwen", "claude", true, "api-key", "Qwen (Claude Code)"]);
  const stored = getSettings();
  assert.deepEqual(stored.removedLicenses, ["qwen"]);
  assert.deepEqual([stored.qwenApiKey, stored.qwenBaseUrl, stored.defaultQwenModel, stored.defaultQwenEffort], ["", "", "", ""], "its key, endpoint and defaults are gone");
  assert.ok(!JSON.stringify(stored).includes(QWEN_KEY));
  assert.equal(hasQwenApiKey("qwen"), false);
  assert.deepEqual([stored.engine, stored.enginePool], ["claude", ""], "the gateway default that named it moves to the harness's own sign-in");

  // Registered (stored references keep reading) but off and unlisted.
  assert.equal(registry.isEngineId("qwen"), true);
  assert.equal(registry.isRemovedLicense("qwen"), true);
  assert.equal(isEngineEnabled("qwen"), false);
  assert.ok(!getEnabledEngines().includes("qwen"));
  assert.equal(settingsForApi().engineEnabled.qwen, false);
  assert.equal(manifestOf("qwen"), null);
  assert.ok(!registry.listedEngineIds().includes("qwen"));
  assert.deepEqual(qwenProviderSettings().map((p) => p.id), ["qwen-eu"], "its settings card is gone; the other provider's stays");
  assert.ok(!pool.selectableLicenses("claude", {}).includes("qwen"));
  assert.deepEqual(store.listRemovedBuiltinLicenses().map((l) => [l.id, l.harness, l.label]), [["qwen", "claude", "Qwen (Claude Code)"]]);
  // A stored lock that names it still reads (it is a registered id) and still approves only what it names.
  assert.deepEqual(policy.normalizeApprovedEngines(["qwen", "codex"]), ["codex", "qwen"]);
  assert.equal(policy.isChannelEngineApproved({ approvedEngines: ["qwen"] }, "claude"), false, "a lock never widens because its license was removed");

  // Nothing but Restore brings it back: not a stored `true`, not removing it twice.
  saveSettings({ engineEnabled: { ...getSettings().engineEnabled, qwen: true } });
  assert.equal(isEngineEnabled("qwen"), false);
  await assert.rejects(store.removeBuiltinLicense("qwen"), (e) => e.status === 409);

  const restored = store.restoreBuiltinLicense("qwen");
  assert.deepEqual([restored.id, restored.removed], ["qwen", false]);
  assert.deepEqual(getSettings().removedLicenses, []);
  assert.ok(manifestOf("qwen"), "listed again");
  assert.equal(isEngineEnabled("qwen"), false, "an opt-in license comes back switched off");
  assert.equal(hasQwenApiKey("qwen"), false, "and without a credential");
  assert.deepEqual(qwenProviderSettings().map((p) => p.id), ["qwen", "qwen-eu"]);
  assert.throws(() => store.restoreBuiltinLicense("qwen"), (e) => e.status === 409);
});

test("removing a dedicated login deletes its sign-in directory; the channel-account license keeps the channels' own", async () => {
  reset();
  for (const [id, home] of [["codex-eu", codexEuLoginHome()], ["claude-bedrock", bedrockLoginHome()]]) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(home, "fixture-login.json"), "{}", { mode: 0o600 });
    saveSettings({ engineEnabled: { ...getSettings().engineEnabled, [id]: true } });
    assert.equal(isEngineEnabled(id), true);
    const removed = await store.removeBuiltinLicense(id);
    assert.equal(removed.ownCredential, "sign-in");
    assert.equal(existsSync(home), false, `${id}: the login directory is deleted`);
    assert.equal(isEngineEnabled(id), false);
    assert.equal(manifestOf(id), null);
    assert.ok(!settingsForApi().terminalHarnesses.some((card) => card.id === id), "its terminal-setup card is gone");
  }
  assert.deepEqual(settingsForApi().terminalHarnesses, []);

  // The channel-account Codex inherits the Codex switch until it is removed, and again once restored.
  assert.equal(isEngineEnabled("codex-channel"), true);
  const channel = await store.removeBuiltinLicense("codex-channel");
  assert.equal(channel.ownCredential, "", "it stores nothing of its own to delete");
  assert.equal(isEngineEnabled("codex-channel"), false);
  assert.equal(manifestOf("codex-channel"), null);
  assert.deepEqual(store.listRemovedBuiltinLicenses().map((l) => l.id).sort(), ["claude-bedrock", "codex-channel", "codex-eu"]);
  store.restoreBuiltinLicense("codex-channel");
  assert.equal(isEngineEnabled("codex-channel"), true, "back to following the Codex switch");
  store.restoreBuiltinLicense("codex-eu");
  assert.equal(isEngineEnabled("codex-eu"), false, "an opt-in login comes back off and signed out");
  assert.ok(settingsForApi().terminalHarnesses.some((card) => card.id === "codex-eu"));
});

test("a sign-in is never removed, and the last license switched on is not removed either", async () => {
  reset();
  for (const id of ["claude", "codex"]) await assert.rejects(store.removeBuiltinLicense(id), (e) => e.status === 400 && /cannot be removed/.test(e.message));
  await assert.rejects(store.removeBuiltinLicense("no-such-engine"), (e) => e.status === 404);
  const added = store.createLicense({ kind: "codex-login", label: "Record seat", type: "business" });
  await assert.rejects(store.removeBuiltinLicense(added.id), (e) => e.status === 404, "an added license is deleted, not removed");
  assert.throws(() => store.restoreBuiltinLicense("claude"), (e) => e.status === 404);
  assert.throws(() => store.restoreBuiltinLicense(added.id), (e) => e.status === 404);

  // Qwen is the only license on: removing it would leave nothing to run, and the read-time rescue
  // would switch a default harness back on unasked.
  saveSettings({ engineLicenses: [], qwenApiKey: QWEN_KEY, engineEnabled: { claude: false, codex: false, qwen: true }, engine: "qwen" });
  assert.deepEqual(getEnabledEngines().filter((id) => !registry.adapterFor(id).channelScoped), ["qwen"]);
  await assert.rejects(store.removeBuiltinLicense("qwen"), (e) => e.status === 409 && /only license switched on/.test(e.message));
  assert.equal(hasQwenApiKey("qwen"), true, "a refused removal deletes nothing");
  assert.deepEqual(getSettings().removedLicenses || [], []);
  // A license that is OFF can always be removed.
  await store.removeBuiltinLicense("qwen-eu");
  assert.equal(registry.isRemovedLicense("qwen-eu"), true);
});

// ── The admin API ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use("/api", createLicensesRouter());
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

test("the admin API renames a sign-in, removes and restores a shipped license, and audits each", async () => {
  reset();
  saveSettings({ qwenEuApiKey: QWEN_KEY, engineEnabled: { claude: true, codex: true, "qwen-eu": true } });
  const since = new Date().toISOString();

  const renamed = await call("PUT", "/engine-licenses/codex", { label: "Team ChatGPT", kind: "claude-api", apiKey: "ignored-entirely" });
  assert.equal(renamed.status, 200);
  assert.deepEqual([renamed.body.license.id, renamed.body.license.label, renamed.body.license.builtin, renamed.body.license.defaultLicense], ["codex", "Team ChatGPT", true, true]);
  assert.equal(registry.licenseLabel("codex"), "Team ChatGPT");
  assert.equal((await call("PUT", "/engine-licenses/claude", { label: "team chatgpt" })).status, 409);
  const other = await call("PUT", "/engine-licenses/codex-channel", { label: "Customer ChatGPT" });
  assert.deepEqual([other.status, other.body.license.label, other.body.license.defaultLicense], [200, "Customer ChatGPT", false]);
  assert.equal((await call("GET", "/settings")).body.engines.find((m) => m.id === "codex-channel").label, "Customer ChatGPT");
  assert.equal((await call("PUT", "/engine-licenses/codex-channel", { label: "" })).body.license.label, "Codex (channel account)");
  assert.equal((await call("GET", "/settings")).body.engines.find((m) => m.id === "codex").licenseLabel, "Team ChatGPT");

  assert.equal((await call("DELETE", "/engine-licenses/claude")).status, 400);
  const removed = await call("DELETE", "/engine-licenses/qwen-eu");
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { ok: true, removed: "qwen-eu", restorable: true });
  assert.equal((await call("DELETE", "/engine-licenses/qwen-eu")).status, 409);
  assert.equal(getSettings().qwenEuApiKey, "");

  const listed = await call("GET", "/engine-licenses");
  assert.deepEqual(listed.body.removed.map((l) => [l.id, l.harness, l.label]), [["qwen-eu", "claude", "Qwen EU (Claude Code)"]]);
  const settings = await call("GET", "/settings");
  assert.ok(!settings.body.engines.some((m) => m.id === "qwen-eu"));
  assert.deepEqual(settings.body.qwenProviders.map((p) => p.id), ["qwen"]);
  for (const response of [removed, listed, settings]) assert.ok(!response.text.includes(QWEN_KEY));

  // A save from a page loaded before the removal cannot switch it on or put a key back.
  const stale = await call("PUT", "/settings", { engineEnabled: { claude: true, codex: true, "qwen-eu": true }, qwenEuApiKey: QWEN_KEY, qwenEuBaseUrl: "https://qwen-eu.example.com/anthropic" });
  assert.equal(stale.status, 200, stale.text);
  assert.deepEqual([getSettings().engineEnabled["qwen-eu"], getSettings().qwenEuApiKey, getSettings().qwenEuBaseUrl || ""], [false, "", ""]);
  assert.equal(isEngineEnabled("qwen-eu"), false);
  assert.equal((await call("PUT", "/settings", { engine: "qwen-eu" })).status, 400, "a removed license cannot become the gateway default");

  const restored = await call("POST", "/engine-licenses/qwen-eu/restore");
  assert.equal(restored.status, 200);
  assert.equal(restored.body.license.removed, false);
  assert.equal((await call("POST", "/engine-licenses/qwen-eu/restore")).status, 409);
  assert.equal((await call("POST", "/engine-licenses/claude/restore")).status, 404);
  assert.deepEqual((await call("GET", "/engine-licenses")).body.removed, []);

  const cleared = await call("PUT", "/engine-licenses/codex", { label: "" });
  assert.equal(cleared.body.license.label, "Default sign-in");

  // Every change is audited, by name — never with a credential.
  const events = readEvents({ limit: 200 }).filter((event) => event.ts >= since && String(event.event || "").startsWith("engine_license_")).reverse();
  assert.deepEqual(events.map((event) => [event.event, event.license]), [
    ["engine_license_changed", "codex"], ["engine_license_changed", "codex-channel"], ["engine_license_changed", "codex-channel"], ["engine_license_removed", "qwen-eu"], ["engine_license_restored", "qwen-eu"], ["engine_license_changed", "codex"],
  ]);
  assert.deepEqual([events[0].name, events[0].previousName, events[0].changed], ["Team ChatGPT", "Default sign-in", ["label"]]);
  assert.deepEqual([events[3].kind, events[3].name, events[3].author], ["builtin", "Qwen EU (Claude Code)", "admin-ui"]);
  assert.ok(!JSON.stringify(events).includes(QWEN_KEY));
});

test("the confirmation says what removing each shipped license deletes", () => {
  reset();
  const text = (id) => ui.builtinRemovalText(manifestOf(id));
  for (const id of ["qwen", "qwen-eu"]) assert.match(text(id), /API key and endpoint are deleted.*Restore, but it has to be set up again/);
  for (const id of ["codex-eu", "claude-bedrock"]) assert.match(text(id), /sign-in on the gateway host is deleted.*Restore, but it has to be set up again/);
  assert.match(text("codex-channel"), /Sign-ins that channels made for themselves are kept.*Restore\.$/);
  for (const id of REMOVABLE) assert.match(text(id), /switched off and disappears from every picker/);
  assert.equal(ui.DEFAULT_LICENSE_NAME, state.DEFAULT_LICENSE_NAME, "the page and the server agree on the default name");
});

// ── The real page ─────────────────────────────────────────────────────────────────────────────
test("the admin UI: Rename on a sign-in, Remove on every other shipped license, Restore under the list", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  reset();
  saveSettings({ qwenApiKey: QWEN_KEY, engineEnabled: { claude: true, codex: true, qwen: true } });

  const site = express();
  site.use(express.json());
  site.get("/api/auth/me", (_req, res) => res.json({ bootstrap: false, linkRequired: false, fresh: true, account: { userId: "U_BROWSER_ADMIN" }, passkeys: [] }));
  site.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  site.get("/api/health", (_req, res) => res.json({ slack: { connected: false, status: "off" }, engines: {} }));
  site.use("/api", createAdminRouter({ slack: { getClient: () => null, snapshot: () => ({ status: "disconnected", connected: false }) } }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  site.use(express.static(publicDir, { dotfiles: "allow" }));
  for (const route of ["/settings", "/settings/:section"]) site.get(route, (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const listener = await new Promise((resolve) => { const s = site.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { listener.closeAllConnections(); listener.close(resolve); }));
  const browser = await chromium.launch({ headless: true, ...(process.env.CG_BROWSER_EXECUTABLE ? { executablePath: process.env.CG_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${listener.address().port}/settings`);
  const manager = page.locator("#engine-enabled-box");
  await openSetting(page, manager);
  const row = (id) => manager.locator(`.lic-row[data-license="${id}"]`);
  await row("qwen").waitFor();

  // Which button each shipped license gets.
  for (const id of ["claude", "codex"]) {
    assert.equal(await row(id).locator(".lic-rename-open").count(), 1, `${id}: Rename`);
    assert.equal(await row(id).locator(".lic-remove").count(), 0, `${id}: no Remove`);
  }
  for (const id of REMOVABLE) {
    assert.equal(await row(id).locator(".lic-remove").count(), 1, `${id}: Remove`);
    assert.equal(await row(id).locator(".lic-rename-open").count(), 1, `${id}: Rename`);
  }
  assert.equal(await manager.locator(".lic-removed").count(), 0, "nothing removed yet");

  // Rename the Claude Code sign-in.
  await row("claude").locator(".lic-rename-open").click();
  const nameBox = row("claude").locator(".lic-rename input");
  assert.equal(await nameBox.getAttribute("placeholder"), "Default sign-in");
  await nameBox.fill("Company Max");
  const renameDone = page.waitForResponse((r) => r.url().endsWith("/api/engine-licenses/claude") && r.request().method() === "PUT");
  await row("claude").locator(".lic-save").click();
  assert.equal((await renameDone).status(), 200);
  await row("claude").locator(".lic-name", { hasText: "Company Max" }).waitFor();
  assert.equal(registry.licenseLabel("claude"), "Company Max");

  // Remove Qwen: the confirmation names what is deleted; the row and its settings card go.
  assert.equal(await page.locator(".qwen-provider-card").count(), 2);
  await row("qwen").locator(".lic-remove").click();
  const dialog = page.locator("dialog[open], .modal:not([hidden])").first();
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Qwen \(Claude Code\)[\s\S]*API key and endpoint are deleted/);
  const removeDone = page.waitForResponse((r) => r.url().endsWith("/api/engine-licenses/qwen") && r.request().method() === "DELETE");
  await dialog.getByRole("button", { name: "Remove license" }).click();
  assert.equal((await removeDone).status(), 200);
  const removedItem = manager.locator('.lic-group[data-harness="claude"] .lic-removed-item[data-license="qwen"]');
  await removedItem.waitFor();
  assert.equal(await row("qwen").count(), 0);
  assert.equal(await page.locator(".qwen-provider-card").count(), 1, "the removed provider's settings card is gone");
  assert.equal(getSettings().qwenApiKey, "");
  assert.equal(isEngineEnabled("qwen"), false);
  assert.ok(!(await page.content()).includes(QWEN_KEY));

  // Restore: listed again, switched off.
  const restoreDone = page.waitForResponse((r) => r.url().endsWith("/api/engine-licenses/qwen/restore") && r.request().method() === "POST");
  await removedItem.locator(".lic-restore").click();
  assert.equal((await restoreDone).status(), 200);
  await row("qwen").waitFor();
  assert.equal(await row("qwen").locator('input[type="checkbox"]').isChecked(), false);
  await manager.locator(".lic-removed").waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
});
