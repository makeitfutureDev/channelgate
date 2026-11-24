// Engine licenses in the web admin UI (public/admin-licenses.js, wired by public/app.js).
//
// Two halves:
//   1. The pure picker / lock functions run under plain Node and are checked against the server's
//      own picker (src/gateway/license-pool.js) — the admin UI must offer what the gateway accepts.
//   2. The real page in a browser (only with CG_BROWSER_MODULE): the Settings licenses manager, the
//      channel card's Harness → License → "If it fails, also use" controls, and the lock.
import { openSetting } from "./settings-navigation-helper.js";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { saveSettings, settingsForApi } = await import("../src/config/settings.js");
const { engineUiManifest } = await import("../src/engines/registry.js");
const licenses = await import("../src/config/engine-licenses.js");
const serverPicker = await import("../src/gateway/license-pool.js");
const { licenseLoginHome } = await import("../src/engines/license-state.js");
const { upsertChannelEntry, saveChannelMeta, getChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const ui = await import("../public/admin-licenses.js");

const API_KEY = "sk-web-test-secret-0042";
// What a finished ChatGPT sign-in leaves in a Codex license's own login directory.
const jwt = (plan) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 864000, "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_account_id: "lic-web" } })).toString("base64url")}.fixture`;
const signIn = (id, plan) => {
  mkdirSync(licenseLoginHome(id), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(licenseLoginHome(id), "auth.json"), JSON.stringify({ tokens: { access_token: jwt(plan), refresh_token: "fixture-refresh", account_id: "lic-web" } }), { mode: 0o600 });
};
const env = ({ policy = null, codexAuthSource = "" } = {}) => ({ manifests: engineUiManifest(), enabled: settingsForApi().engineEnabled, codexAuthSource, policy });
const metaOf = ({ policy = null, codexAuthSource = "" } = {}) => ({ approvedEngines: policy, codexAuthSource });

test("with one license per harness the picker has no license control", () => {
  const e = env();
  assert.deepEqual(ui.selectableHarnesses(e), [{ id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex" }]);
  for (const harness of ["claude", "codex"]) {
    assert.deepEqual(ui.usableLicenses(e, harness), [harness], `${harness} runs on its own sign-in only`);
    const state = ui.licensePickerState(e, { harness, engine: harness });
    assert.equal(state.show, false, "one usable license ⇒ no License control");
    assert.deepEqual(ui.resolveLicensePick(e, { harness }), { engine: harness, licensePool: "" });
    // "Any" means nothing with a single license: it is not stored.
    assert.deepEqual(ui.resolveLicensePick(e, { harness, license: "any" }), { engine: harness, licensePool: "" });
    assert.equal(ui.describeSelection(e, { engine: harness }), harness === "claude" ? "Claude Code" : "Codex");
  }
  assert.deepEqual(ui.engineChoices(e), [{ id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex" }]);
});

test("a second license shows the License control, and the picks map to engine + pool like the server's", async () => {
  const work = licenses.createLicense({ kind: "codex-login", label: "Work ChatGPT", type: "business" });
  const seat = licenses.createLicense({ kind: "codex-login", label: "Second seat", type: "subscription" });
  const e = env();
  assert.deepEqual(ui.usableLicenses(e, "codex"), ["codex", work.id, seat.id], "an added license is switched on and usable");
  assert.deepEqual(ui.usableLicenses(e, "codex"), serverPicker.selectableLicenses("codex", metaOf()));

  const state = ui.licensePickerState(e, { harness: "codex", engine: "codex" });
  assert.equal(state.show, true, "two or more usable licenses ⇒ the License control");
  assert.deepEqual(state.licenses, [{ id: "codex", label: "Default sign-in" }, { id: work.id, label: "Work ChatGPT" }, { id: seat.id, label: "Second seat" }]);
  assert.equal(ui.licensePickerState(e, { harness: "claude", engine: "claude" }).show, false, "the other harness is unaffected");

  // "Any license": the harness's own license first, pool "any".
  assert.deepEqual(ui.resolveLicensePick(e, { harness: "codex", license: "any" }), { engine: "codex", licensePool: "any" });
  const any = ui.licensePickerState(e, { harness: "codex", engine: "codex", pool: "any" });
  assert.equal(any.selected, "any");
  assert.deepEqual(any.others, [], '"also use" is not offered beside "Any license"');
  // A specific license, alone and with further licenses to move to.
  assert.deepEqual(ui.resolveLicensePick(e, { harness: "codex", license: work.id }), { engine: work.id, licensePool: "" });
  assert.deepEqual(ui.resolveLicensePick(e, { harness: "codex", license: work.id, also: [seat.id, work.id, "codex"] }), { engine: work.id, licensePool: [seat.id, "codex"] });
  const specific = ui.licensePickerState(e, { harness: "codex", engine: work.id, pool: [seat.id] });
  assert.equal(specific.selected, work.id);
  assert.deepEqual(specific.also, [seat.id]);
  assert.deepEqual(specific.others.map((o) => o.id), ["codex", seat.id]);

  // Same answers as the gateway's own picker for every stored selection worth drawing.
  for (const [engine, pool] of [["codex", ""], ["codex", "any"], [work.id, ""], [work.id, [seat.id]], [seat.id, ["codex", work.id]], ["claude", ""]]) {
    const harness = engine === "claude" ? "claude" : "codex";
    const mine = ui.licensePickerState(e, { harness, engine, pool });
    assert.deepEqual(mine, serverPicker.licensePicker({ harness, meta: metaOf(), engine, pool }), `picker state for ${engine} + ${JSON.stringify(pool)}`);
    assert.equal(ui.describeSelection(e, { engine, pool }), serverPicker.describeSelectionText({ engine, pool, meta: metaOf() }));
    for (const pick of [{ license: "" }, { license: "any" }, { license: mine.licenses.at(-1).id, also: mine.licenses.map((l) => l.id) }]) {
      assert.deepEqual(ui.resolveLicensePick(e, { harness, ...pick }), serverPicker.resolveLicensePick({ harness, meta: metaOf(), ...pick }));
    }
  }
  assert.equal(ui.describeSelection(e, { engine: work.id, pool: [seat.id] }), "Codex · Work ChatGPT, then Second seat");
  assert.equal(ui.engineDisplayName(e.manifests, work.id), "Codex · Work ChatGPT");
  assert.equal(ui.engineDisplayName(e.manifests, "codex-lic-00000000"), "codex-lic-00000000", "an id the manifest no longer knows is printed as it is");

  // Switched off ⇒ not offered; with it gone "Any license" still names the harness's own license.
  saveSettings({ engineEnabled: { ...settingsForApi().engineEnabled, [seat.id]: false } });
  assert.deepEqual(ui.usableLicenses(env(), "codex"), ["codex", work.id]);
  saveSettings({ engineEnabled: { ...settingsForApi().engineEnabled, [seat.id]: true } });

  // The lock narrows the picker: one license ⇒ no control; the harness-wide entry ⇒ all of them.
  for (const policy of [[work.id], ["harness:codex"], ["claude", work.id, seat.id], ["harness:claude"], []]) {
    const locked = env({ policy });
    for (const harness of ["claude", "codex"]) {
      assert.deepEqual(ui.usableLicenses(locked, harness), serverPicker.selectableLicenses(harness, metaOf({ policy })), `${harness} under ${JSON.stringify(policy)}`);
    }
    assert.deepEqual(ui.selectableHarnesses(locked).map((h) => h.id), serverPicker.selectableHarnesses(metaOf({ policy })));
  }
  assert.equal(ui.licensePickerState(env({ policy: [work.id] }), { harness: "codex", engine: work.id }).show, false);
  assert.deepEqual(ui.resolveLicensePick(env({ policy: [work.id] }), { harness: "codex", license: "any" }), { engine: work.id, licensePool: "" }, "the first usable license when the harness's own is locked out");
  assert.deepEqual(ui.resolveLicensePick(env({ policy: [work.id, seat.id] }), { harness: "codex", license: "any" }), { engine: work.id, licensePool: "any" });

  // A channel's own Codex sign-in is a license of that channel only.
  assert.ok(!ui.usableLicenses(env(), "codex").includes("codex-channel"));
  assert.deepEqual(ui.usableLicenses(env({ codexAuthSource: "channel" }), "codex"), serverPicker.selectableLicenses("codex", metaOf({ codexAuthSource: "channel" })));
  assert.ok(ui.usableLicenses(env({ codexAuthSource: "channel" }), "codex").includes("codex-channel"));

  await licenses.deleteLicense(work.id);
  await licenses.deleteLicense(seat.id);
});

test("the lock offers each harness as a whole and each license, and stores a harness-wide entry once", async () => {
  const work = licenses.createLicense({ kind: "codex-login", label: "Lock ChatGPT", type: "business" });
  const manifests = engineUiManifest();
  const groups = ui.lockOptionGroups(manifests);
  assert.deepEqual(groups.map((g) => [g.harness, g.entry, g.entryLabel]), [
    ["claude", "harness:claude", "Claude Code — any license"],
    ["codex", "harness:codex", "Codex — any license"],
  ]);
  const codex = groups.find((g) => g.harness === "codex");
  assert.ok(codex.licenses.some((l) => l.id === "codex" && l.label === "Default sign-in"));
  assert.ok(codex.licenses.some((l) => l.id === work.id && l.label === "Lock ChatGPT"), "an added license is lockable on its own");
  assert.ok(groups.find((g) => g.harness === "claude").licenses.every((l) => manifests.find((m) => m.id === l.id).harness === "claude"));

  assert.deepEqual(ui.lockValues(manifests, ["claude", work.id]), ["claude", work.id]);
  assert.deepEqual(ui.lockValues(manifests, ["harness:codex", "codex", work.id, "claude"]), ["claude", "harness:codex"], "a whole harness is not repeated license by license");
  assert.deepEqual(ui.lockValues(manifests, ["codex-lic-00000000", "nonsense"]), [], "what the manifest does not know is not sent back");
  assert.deepEqual(ui.unknownLockEntries(manifests, ["claude", "harness:codex", "codex-lic-00000000"]), ["codex-lic-00000000"]);
  assert.deepEqual(ui.unknownLockEntries(manifests, null), []);

  const byId = (id) => manifests.find((m) => m.id === id);
  assert.equal(ui.policyAdmits(null, byId("codex")), true);
  assert.equal(ui.policyAdmits(["harness:codex"], byId(work.id)), true);
  assert.equal(ui.policyAdmits(["harness:claude"], byId(work.id)), false);
  assert.equal(ui.policyAdmits([work.id], byId("codex")), false);
  assert.equal(ui.policyAdmits(["codex"], undefined), false, "a removed license is approved by nothing");
  await licenses.deleteLicense(work.id);
});

test("license status badges and the models box", () => {
  assert.deepEqual(ui.licenseStatusBadge({ status: { ready: true } }), { tone: "ok", text: "Ready", detail: "" });
  assert.equal(ui.licenseStatusBadge({ status: { ready: false, signedIn: false, detail: "Sign in first." } }).text, "Not signed in");
  assert.equal(ui.licenseStatusBadge({ status: { ready: false, signedIn: true, plan: { matches: false, detail: "This is a personal plan." } } }).text, "Plan mismatch");
  assert.deepEqual(ui.licenseStatusBadge({ status: { ready: false }, verification: { verified: true, ok: false, detail: "401 from the endpoint" } }), { tone: "bad", text: "Key rejected", detail: "401 from the endpoint" });
  assert.equal(ui.licenseStatusBadge({ status: { ready: false, signedIn: true } }).text, "Not ready");
  assert.deepEqual(ui.parseModelList("m-one\n m-two , m-three\n\nm-one"), ["m-one", "m-two", "m-three"]);
});

test("the admin UI: licenses manager, harness → license picker and the lock", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const channelId = "C_LICENSE_WEB";
  const entry = await upsertChannelEntry(channelId, { name: "license-web", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId, name: entry.name, type: "channel", isDM: false }), engine: "codex" });
  // An API license made on the server: the page must never learn its key.
  const apiLicense = licenses.createLicense({ kind: "claude-api", label: "Team API", type: "api", baseUrl: "https://llm.example/anthropic", apiKey: API_KEY, authScheme: "bearer", models: ["m-one"] });
  // A Claude sign-in license is signed in on the host. Both stay switched off, so Claude Code keeps
  // one usable license for the picker checks below.
  const hostLicense = licenses.createLicense({ kind: "claude-login", label: "Second Claude", type: "business" });
  saveSettings({ engineEnabled: { ...settingsForApi().engineEnabled, [apiLicense.id]: false, [hostLicense.id]: false } });

  const app = express();
  app.use(express.json());
  // This focused router fixture represents an authenticated admin; real login is tested separately.
  app.get("/api/auth/me", (_req, res) => res.json({ bootstrap: false, linkRequired: false, fresh: true, account: { userId: "U_BROWSER_ADMIN" }, passkeys: [] }));
  app.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  app.get("/api/health", (_req, res) => res.json({ slack: { connected: false, status: "off" }, engines: {} }));
  app.use("/api", createAdminRouter({ slack: { getClient: () => null, snapshot: () => ({ status: "disconnected", connected: false }) } }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  for (const route of ["/conversations/channel/:id", "/settings", "/settings/:section"]) app.get(route, (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const channelUrl = `${origin}/conversations/channel/${channelId}`;
  const harness = page.locator(".ch-engine");
  const license = page.locator(".ch-engine-field + .lic-field .lic-select");
  const alsoField = page.locator(".ch-engine-field ~ .lic-also-field");
  const openRuntime = async () => {
    await page.goto(channelUrl);
    await page.locator('[data-pane="runtime"].subtab').click();
    await harness.waitFor();
  };
  const saveChannel = async () => {
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/channels/${channelId}/meta`) && r.request().method() === "PUT");
    await page.locator(".save-channel").click();
    const response = await saved;
    assert.equal(response.status(), 200, await response.text());
    return response.request().postDataJSON();
  };

  // ── One license per harness: the screen is the old one with "Harness" on the first control ──
  await openRuntime();
  assert.deepEqual(await harness.locator("option").evaluateAll((options) => options.map((o) => [o.value, o.textContent])), [["", "Default (global setting)"], ["claude", "Claude Code"], ["codex", "Codex"]]);
  assert.equal(await harness.inputValue(), "codex");
  assert.equal(await license.isVisible(), false, "one usable license ⇒ the License control is not shown");
  assert.equal(await alsoField.isVisible(), false);

  // ── Settings: the manager lists every license under its harness, and adds one ──
  await page.goto(`${origin}/settings`);
  const manager = page.locator("#engine-enabled-box");
  await openSetting(page, manager);
  await manager.locator('.lic-group[data-harness="codex"]').waitFor();
  // The manager is its own Settings section, apart from the ChannelGate product license; the
  // harness card points to it.
  assert.equal(await page.locator("#set-engine-licenses #engine-enabled-box").count(), 1);
  assert.equal(await page.locator("#set-license #engine-enabled-box").count(), 0);
  assert.equal(await page.locator('#settings-nav a[data-sec="engine-licenses"]').textContent(), "Engine licenses");
  const licenseJump = page.locator("#settings-body a.lic-jump").first();
  await openSetting(page, licenseJump);
  await licenseJump.click();
  await page.waitForURL(/#set-engine-licenses$/);
  assert.deepEqual(await manager.locator(".lic-group-title").allTextContents(), ["Claude Code licenses", "Codex licenses"]);
  const apiRow = manager.locator(`.lic-row[data-license="${apiLicense.id}"]`);
  await apiRow.waitFor();
  assert.match(await apiRow.textContent(), /Team API/);
  assert.equal(await manager.locator('.lic-group[data-harness="claude"] .lic-row[data-license="claude"]').count(), 1, "the built-in sign-in is a license too");
  assert.equal(await manager.locator('.lic-group[data-harness="codex"] .lic-row[data-license="codex"] .lic-remove').count(), 0, "a built-in license cannot be removed");

  // Editing the API license: the key box is empty and write-only; only the last four show.
  await apiRow.locator(".lic-edit").click();
  const form = manager.locator(".lic-form");
  await form.waitFor();
  assert.equal(await form.locator(".lic-api-key").inputValue(), "", "the stored key is never put back into the form");
  assert.equal(await form.locator(".lic-api-key").getAttribute("type"), "password");
  assert.equal(await form.locator(".lic-api-key").getAttribute("placeholder"), `•••• ${API_KEY.slice(-4)}`);
  assert.equal(await form.locator(".lic-kind").isDisabled(), true, "the kind of an existing license is fixed");
  assert.equal(await form.locator(".lic-base-url").inputValue(), "https://llm.example/anthropic");
  assert.equal(await form.locator(".lic-models").inputValue(), "m-one");
  assert.ok(!(await page.content()).includes(API_KEY), "the API key is nowhere in the page");
  await form.locator(".lic-cancel").click();
  assert.equal(await manager.locator(".lic-form").count(), 0);

  // Add a Codex sign-in license through the form: only Codex kinds are offered.
  await manager.locator('.lic-group[data-harness="codex"] .lic-add').click();
  await form.waitFor();
  assert.deepEqual(await form.locator(".lic-kind option").evaluateAll((options) => options.map((o) => o.value)), ["codex-login", "codex-api", "codex-aws", "codex-gcp", "codex-azure"]);
  assert.equal(await form.locator(".lic-api-fields").isVisible(), false, "a sign-in license asks for no endpoint or key");
  await form.locator(".lic-label").fill("Work ChatGPT");
  await form.locator(".lic-type-select").selectOption("business");
  const added = page.waitForResponse((r) => r.url().endsWith("/api/engine-licenses") && r.request().method() === "POST");
  await form.locator(".lic-save").click();
  const addedResponse = await added;
  assert.equal(addedResponse.status(), 201, await addedResponse.text());
  const workId = (await addedResponse.json()).license.id;
  assert.match(workId, /^codex-lic-[0-9a-f]{8}$/);
  const workRow = manager.locator(`.lic-row[data-license="${workId}"]`);
  await workRow.waitFor();
  assert.match(await workRow.textContent(), /Work ChatGPT/);
  await workRow.locator(".lic-status").filter({ hasText: "Not signed in" }).waitFor();
  assert.equal(await workRow.locator('input[type="checkbox"]').isChecked(), true, "a new license is switched on");
  assert.equal(await workRow.locator(".lic-signin").count(), 1, "a Codex sign-in license signs in from the browser");
  // The "Not signed in — run `…`" line under the row copies the command it quotes with one click.
  const workCommand = (await licenses.listLicensesForApi()).find((l) => l.id === workId).loginCommand;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  assert.ok((await workRow.locator(".lic-detail").textContent()).includes(workCommand));
  await workRow.locator(".lic-detail .lic-copy-inline").click();
  await workRow.locator(".lic-copy-state", { hasText: "Copied" }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), workCommand);

  // Signing it in: the shared Codex device-code box, against this license's own login route.
  let loginState = { authenticated: false, phase: "idle", code: "", url: "" };
  const loginCalls = [];
  await page.route(`**/api/engine-licenses/${workId}/login`, async (route) => {
    const method = route.request().method();
    loginCalls.push(method);
    if (method === "POST") loginState = { authenticated: false, phase: "pending", code: "WXYZ-12345", url: "https://auth.openai.com/codex/device" };
    await route.fulfill({ status: method === "POST" ? 202 : 200, contentType: "application/json", body: JSON.stringify(loginState) });
  });
  const panel = manager.locator(".lic-panel");
  await workRow.locator(".lic-signin").click();
  await panel.locator(".lic-signin-start").click();
  await panel.locator(".ch-codex-device-value").filter({ hasText: "WXYZ-12345" }).waitFor();
  assert.equal(loginCalls.filter((method) => method === "POST").length, 1, "one device-code sign-in was started");
  signIn(workId, "business");
  loginState = { authenticated: true, phase: "complete", method: "chatgpt", code: "", url: "" };
  await workRow.locator(".lic-status.ok").waitFor(); // the box polls, then the list reloads
  assert.match(await workRow.locator(".lic-status").textContent(), /Ready/);
  assert.equal(await panel.count(), 0, "the sign-in box closes when the sign-in completes");
  // Verify asks the gateway again and says what it found.
  const verified = page.waitForResponse((r) => r.url().endsWith(`/api/engine-licenses/${workId}/verify`) && r.request().method() === "POST");
  await workRow.locator(".lic-verify").click();
  assert.equal((await verified).status(), 200);
  await manager.locator('.lic-group[data-harness="codex"] .lic-notice').filter({ hasText: "Work ChatGPT: Ready" }).waitFor();

  // A Claude sign-in license shows the host command, copies it, and can be checked again.
  const hostRow = manager.locator(`.lic-row[data-license="${hostLicense.id}"]`);
  const loginCommand = (await licenses.listLicensesForApi()).find((l) => l.id === hostLicense.id).loginCommand;
  assert.ok(loginCommand, "the listing carries the host sign-in command");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await hostRow.locator(".lic-signin").click();
  assert.equal(await panel.locator("pre code").textContent(), loginCommand);
  await panel.locator(".lic-copy-command").click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), loginCommand);
  const checked = page.waitForResponse((r) => r.url().endsWith(`/api/engine-licenses/${hostLicense.id}/verify`) && r.request().method() === "POST");
  await panel.locator(".lic-check-again").click();
  assert.equal((await checked).status(), 200);
  await manager.locator('.lic-group[data-harness="claude"] .lic-notice').filter({ hasText: "Second Claude: Not signed in" }).waitFor();
  await panel.locator(".lic-signin-close").click();
  assert.equal(await panel.count(), 0);

  // An API license: the key is typed into a write-only box and travels in the request body only.
  const typedKey = "sk-typed-in-the-form-7781";
  let apiPost = null;
  await page.route("**/api/engine-licenses", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    apiPost = route.request().postDataJSON();
    // The endpoint check is the server's business (test/engine-licenses.test.js): refuse here so
    // nothing is stored and the form stays open.
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Refused by the fixture." }) });
  });
  await manager.locator('.lic-group[data-harness="claude"] .lic-add').click();
  await form.waitFor();
  assert.deepEqual(await form.locator(".lic-kind option").evaluateAll((options) => options.map((o) => o.value)), ["claude-login", "claude-api", "claude-aws", "claude-gcp", "claude-azure"], "only Claude Code kinds");
  await form.locator(".lic-kind").selectOption("claude-api");
  assert.equal(await form.locator(".lic-api-fields").isVisible(), true);
  assert.deepEqual(await form.locator(".lic-type-select option").evaluateAll((options) => options.map((o) => o.value)), ["api", "business", "enterprise"], "the types of that kind");
  await form.locator(".lic-label").fill("Typed API");
  await form.locator(".lic-base-url").fill("https://llm.example/v1/");
  await form.locator(".lic-api-key").fill(typedKey);
  await form.locator(".lic-auth-scheme").selectOption("bearer");
  await form.locator(".lic-models").fill("m-one\nm-two, m-three");
  await form.locator(".lic-save").click();
  await form.locator(".lic-form-state").filter({ hasText: "Refused by the fixture." }).waitFor();
  assert.deepEqual(apiPost, { label: "Typed API", type: "api", kind: "claude-api", baseUrl: "https://llm.example/v1/", authScheme: "bearer", models: ["m-one", "m-two", "m-three"], apiKey: typedKey });
  assert.equal(await form.locator(".lic-api-key").inputValue(), "", "the key box is emptied as soon as the key is sent");
  assert.ok(!(await page.content()).includes(typedKey), "a typed key is in no attribute or text of the page");

  // The form is drawn from the catalog: each kind asks for exactly what its provider needs.
  const asked = () => form.locator(".lic-provider-field").evaluateAll((rows) => rows.filter((row) => !row.hidden).map((row) => row.dataset.field));
  assert.deepEqual(await asked(), ["baseUrl", "apiKey", "authScheme", "models"]);
  await form.locator(".lic-kind").selectOption("claude-aws");
  assert.deepEqual(await asked(), ["region", "apiKey", "models"], "Bedrock: a region and a Bedrock API key, one way to send it");
  await form.locator(".lic-kind").selectOption("claude-gcp");
  assert.deepEqual(await asked(), ["projectId", "region", "serviceAccount", "models"]);
  assert.equal(await form.locator(".lic-api-key").count(), 0, "a Vertex license has no API key box");
  const typedAccount = JSON.stringify({ type: "service_account", project_id: "typed-project-1", client_email: "bot@typed-project-1.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nTYPEDKEYMATERIAL7781\n-----END PRIVATE KEY-----\n" });
  await form.locator(".lic-label").fill("Typed Vertex");
  await form.locator(".lic-region").fill("europe-west1");
  await form.locator(".lic-service-account").fill(typedAccount);
  await form.locator(".lic-models").fill("");
  await form.locator(".lic-save").click();
  await form.locator(".lic-form-state").filter({ hasText: "Paste the key file again." }).waitFor();
  assert.deepEqual(apiPost, { label: "Typed Vertex", type: "api", kind: "claude-gcp", projectId: "", region: "europe-west1", models: [], serviceAccount: typedAccount });
  assert.equal(await form.locator(".lic-service-account").inputValue(), "", "the key file leaves its box with the request");
  assert.ok(!(await page.content()).includes("TYPEDKEYMATERIAL7781"), "a pasted key file is in no attribute or text of the page");
  await form.locator(".lic-cancel").click();

  // Codex on Azure: the endpoint, the key and how it is sent, the API version, the deployments.
  await manager.locator('.lic-group[data-harness="codex"] .lic-add').click();
  await form.waitFor();
  await form.locator(".lic-kind").selectOption("codex-azure");
  assert.deepEqual(await asked(), ["baseUrl", "apiKey", "authScheme", "apiVersion", "models"]);
  assert.deepEqual(await form.locator(".lic-auth-scheme option").evaluateAll((options) => options.map((o) => o.value)), ["api-key", "bearer"]);
  await form.locator(".lic-kind").selectOption("codex-api");
  assert.deepEqual(await asked(), ["baseUrl", "apiKey", "models"], "one way to send the key ⇒ nothing to choose");
  await form.locator(".lic-label").fill("Typed Codex API");
  await form.locator(".lic-base-url").fill("https://llm.example/v1");
  await form.locator(".lic-api-key").fill(typedKey);
  await form.locator(".lic-models").fill("m-codex");
  await form.locator(".lic-save").click();
  await form.locator(".lic-form-state").filter({ hasText: "Enter the API key again." }).waitFor();
  assert.deepEqual(apiPost, { label: "Typed Codex API", type: "api", kind: "codex-api", baseUrl: "https://llm.example/v1", models: ["m-codex"], apiKey: typedKey });
  await form.locator(".lic-cancel").click();
  await page.unroute("**/api/engine-licenses");

  // The gateway default picker now has a License control for Codex and none for Claude Code.
  const gatewayLicense = page.locator("#set-engine").locator("xpath=ancestor::label[1]/following-sibling::label[contains(@class,'lic-field')][1]");
  await openSetting(page, "#set-engine");
  await page.locator("#set-engine").selectOption("claude");
  assert.equal(await gatewayLicense.isVisible(), false, "Claude Code still has one usable license");
  await page.locator("#set-engine").selectOption("codex");
  assert.equal(await gatewayLicense.isVisible(), true);
  // The license list changes with a page reload, so it waits for unsaved Settings edits.
  await openSetting(page, manager);
  await manager.locator('.lic-group[data-harness="codex"] .lic-add').click();
  await manager.locator('.lic-group[data-harness="codex"] .lic-notice').filter({ hasText: "Save your settings changes first" }).waitFor();
  assert.equal(await manager.locator(".lic-form").count(), 0);
  // The gateway default is saved as engine + enginePool.
  await openSetting(page, gatewayLicense);
  await gatewayLicense.locator("select").selectOption("any");
  const settingsSaved = page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT");
  await page.locator("#save-settings").click();
  const settingsResponse = await settingsSaved;
  assert.equal(settingsResponse.status(), 200, await settingsResponse.text());
  const settingsBody = settingsResponse.request().postDataJSON();
  assert.equal(settingsBody.engine, "codex");
  assert.equal(settingsBody.enginePool, "any");
  assert.equal(settingsForApi().enginePool, "any");
  await page.reload();
  await openSetting(page, manager);
  await manager.locator('.lic-group[data-harness="codex"]').waitFor();
  assert.equal(await page.locator("#set-engine").inputValue(), "codex");
  assert.equal(await gatewayLicense.locator("select").inputValue(), "any", "the stored gateway selection is shown again");

  // ── Channel: two Codex licenses ⇒ License + "If it fails, also use" ──
  await openRuntime();
  assert.equal(await harness.inputValue(), "codex");
  assert.equal(await license.isVisible(), true, "two usable licenses ⇒ the License control");
  assert.deepEqual(await license.locator("option").evaluateAll((options) => options.map((o) => [o.value, o.textContent])), [["any", "Any license"], ["codex", "Default sign-in"], [workId, "Work ChatGPT"]]);
  assert.equal(await license.inputValue(), "codex");
  assert.equal(await alsoField.isVisible(), true);
  assert.match(await alsoField.textContent(), /If it fails, also use/);
  assert.match(await alsoField.textContent(), /When a license cannot answer, the turn moves to the next one\./);

  await license.selectOption("any");
  assert.equal(await alsoField.isVisible(), false, '"Any license" already includes the others');
  let body = await saveChannel();
  assert.equal(body.engine, "codex");
  assert.equal(body.licensePool, "any");
  assert.equal((await getChannelMeta(entry.slug)).licensePool, "any");

  await openRuntime();
  assert.equal(await license.inputValue(), "any", "the stored selection is shown again");
  await license.selectOption(workId);
  assert.deepEqual(await alsoField.locator("input").evaluateAll((inputs) => inputs.map((i) => [i.value, i.checked])), [["codex", false]]);
  await alsoField.locator('input[value="codex"]').check();
  body = await saveChannel();
  assert.equal(body.engine, workId);
  assert.deepEqual(body.licensePool, ["codex"]);
  assert.deepEqual((await getChannelMeta(entry.slug)).licensePool, ["codex"]);

  // The harness without a choice shows no license control; the inherited default sends no pool.
  await harness.selectOption("claude");
  assert.equal(await license.isVisible(), false);
  assert.equal(await alsoField.isVisible(), false);
  await harness.selectOption("");
  body = await saveChannel();
  assert.equal(body.engine, "");
  assert.equal(body.licensePool, "");

  // ── The lock: whole harnesses and single licenses ──
  await openRuntime();
  const restrict = page.locator(".ch-harness-restrict");
  await restrict.check();
  const lock = page.locator(".ch-harness-options");
  assert.deepEqual(await lock.locator('.lic-lock-group[data-harness="codex"] input').evaluateAll((inputs) => inputs.map((i) => i.value)), ["harness:codex", "codex", "codex-channel", "codex-eu", workId]);
  assert.match(await lock.locator('.lic-lock-group[data-harness="claude"] .lic-lock-harness').textContent(), /Claude Code — any license/);
  // Only one Codex license approved ⇒ the picker has nothing to choose between.
  await lock.locator(`input[value="${workId}"]`).check();
  assert.deepEqual(await harness.locator("option:not([disabled])").evaluateAll((options) => options.map((o) => o.value)), ["codex"], "only an approved harness can be picked");
  await harness.selectOption("codex");
  assert.equal(await license.isVisible(), false, "a channel locked to one license shows no License control");
  // The whole harness: its licenses grey out and the picker offers all of them again.
  await lock.locator('input[value="harness:codex"]').check();
  assert.equal(await lock.locator(`input[value="${workId}"]`).isDisabled(), true, "the harness-wide entry covers its licenses");
  assert.equal(await lock.locator('input[value="claude"]').isDisabled(), false);
  assert.equal(await license.isVisible(), true);
  body = await saveChannel();
  assert.deepEqual(body.approvedEngines, ["harness:codex"]);
  assert.deepEqual((await getChannelMeta(entry.slug)).approvedEngines, ["harness:codex"]);

  // ── Removing a license asks first; a lock that still names it does not break the page ──
  await saveChannelMeta(entry.slug, { ...(await getChannelMeta(entry.slug)), approvedEngines: ["claude", workId], engine: workId, licensePool: "" });
  await page.goto(`${origin}/settings`);
  await openSetting(page, manager);
  await workRow.waitFor();
  await workRow.locator(".lic-remove").click();
  await page.locator("#confirm-ok").waitFor();
  assert.equal(await page.locator("#confirm-title").textContent(), 'Remove the license "Work ChatGPT"?');
  assert.match(await page.locator("#confirm-body").textContent(), /Channels and threads that selected this license fall back to their defaults\./);
  assert.equal(await page.locator("#confirm-ok").textContent(), "Remove license");
  const removed = page.waitForResponse((r) => r.url().endsWith(`/api/engine-licenses/${workId}`) && r.request().method() === "DELETE");
  await page.locator("#confirm-ok").click();
  assert.equal((await removed).status(), 200);
  await workRow.waitFor({ state: "detached" });

  await openRuntime();
  assert.equal(await license.isVisible(), false, "back to one Codex license");
  assert.equal(await restrict.isChecked(), true);
  assert.equal(await page.locator(`.ch-harness-options input[value="${workId}"]`).count(), 0, "a removed license is not drawn in the lock");
  assert.match(await page.locator(".ch-harness-options .lic-lock-unknown").textContent(), /no longer exists/);
  assert.equal(await page.locator('.ch-harness-options input[value="claude"]').isChecked(), true);

  assert.ok(!(await page.content()).includes(API_KEY));
  assert.deepEqual(errors, []);
  await licenses.deleteLicense(apiLicense.id);
  await licenses.deleteLicense(hostLicense.id);
});
