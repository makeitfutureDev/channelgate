// The admin surface of the License card: the key never rides a listing, it is revealable one at a
// time through the existing allowlist, and the card's state comes from its own endpoint.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { ensureTestEnv, clearTestLicense, testLicenseEnv, testLicensePublicKeyPem } from "./helpers.js";

ensureTestEnv();
const { createSettingsRouter } = await import("../src/web/routes/settings.js");
const { settingsForApi, saveSettings, getLicenseKey } = await import("../src/config/settings.js");
const { readSecret, revealableFields } = await import("../src/web/secrets.js");
const { resetLicenseUsage, licenseAdmission } = await import("../src/ee/limits.js");
const { resetLicenseAnnouncements } = await import("../src/ee/license.js");

const app = express();
app.use(express.json());
app.use("/api", createSettingsRouter({}));
const server = createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());

const put = async (body) => {
  const res = await fetch(`${base}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const getJson = async (p) => (await fetch(`${base}${p}`)).json();

const SECRET_KEY = "cg_live_secret_key_abcd1234WXYZ";

test("the settings listing reports hasLicenseKey + last4 and never the key", async () => {
  const saved = await put({ licenseKey: SECRET_KEY });
  assert.equal(saved.status, 200);
  assert.equal(getLicenseKey(), SECRET_KEY);

  const listing = settingsForApi();
  assert.equal(listing.hasLicenseKey, true);
  assert.equal(listing.licenseKeyLast4, "WXYZ");
  const serialized = JSON.stringify(listing);
  assert.ok(!serialized.includes(SECRET_KEY), "the key must never ride a listing response");
  // …and not through the PUT's own echo of the settings either.
  assert.ok(!JSON.stringify(saved.body).includes(SECRET_KEY));
});

test("the key is on the reveal allowlist and comes back one at a time", async () => {
  await put({ licenseKey: SECRET_KEY });
  assert.ok(revealableFields("settings").includes("licenseKey"));
  assert.equal(await readSecret({ scope: "settings", field: "licenseKey" }), SECRET_KEY);
  // The allowlist is resolved by NAME with own-property checks — it can never become "read any
  // config key", including the neighbouring license state.
  await assert.rejects(() => readSecret({ scope: "settings", field: "licenseCache" }), /not revealable/);
});

test("clearing the key falls the deployment back to the no-key tier", async () => {
  await put({ licenseKey: SECRET_KEY });
  clearTestLicense(); // no offline payload either
  const cleared = await put({ clearLicenseKey: true });
  assert.equal(cleared.status, 200);
  assert.equal(getLicenseKey(), "");
  assert.equal(settingsForApi().hasLicenseKey, false);
  const status = await getJson("/license");
  assert.equal(status.state, "no_key");
  assert.deepEqual(status.limits, { conversations: 1, messagesPerConversationPerMonth: 500 });
});

test("GET /api/license carries the state, the limits and this month's usage — never the key", async () => {
  resetLicenseUsage();
  resetLicenseAnnouncements();
  saveSettings({ licenseKey: "" });
  process.env.CHANNELGATE_LICENSE_PUBLIC_KEY = testLicensePublicKeyPem();
  testLicenseEnv({ tier: "free", limits: { conversations: null, messagesPerConversationPerMonth: 500 }, organization: "Acme GmbH" });
  await put({ licenseKey: SECRET_KEY });

  licenseAdmission({ conversationId: "C_ADMIN_ONE", origin: "slack_foreground" });
  licenseAdmission({ conversationId: "C_ADMIN_ONE", origin: "slack_foreground" });
  licenseAdmission({ conversationId: "C_ADMIN_TWO", origin: "schedule" });

  const status = await getJson("/license");
  assert.equal(status.state, "valid");
  assert.equal(status.tier, "free");
  assert.equal(status.organization, "Acme GmbH");
  assert.equal(status.hasLicenseKey, true);
  assert.equal(status.licenseKeyLast4, "WXYZ");
  assert.deepEqual(status.limits, { conversations: null, messagesPerConversationPerMonth: 500 });
  assert.equal(status.banner, null, "a verified deployment shows no banner");
  assert.equal(status.usage.runs, 3);
  assert.equal(status.usage.conversations.length, 2);
  assert.equal(status.usage.conversations[0].conversationId, "C_ADMIN_ONE");
  assert.equal(status.usage.conversations[0].runs, 2);
  assert.ok(!JSON.stringify(status).includes(SECRET_KEY), "the key never rides the license endpoint either");
  resetLicenseUsage();
});

test("the platform URL is settable and defaults to the compiled-in one", async () => {
  const { DEFAULT_PLATFORM_URL, platformBaseUrl } = await import("../src/ee/tiers.js");
  await put({ platformUrl: "https://staging.example.test/channelgate/api/" });
  assert.equal(platformBaseUrl(), "https://staging.example.test/channelgate/api", "the trailing slash is normalized away");
  // Clearing the setting restores the AMBIENT environment value (settings.json overrides .env and
  // gives it back when emptied — the same lifecycle every managed setting has here).
  await put({ platformUrl: "" });
  assert.equal(platformBaseUrl(), "http://127.0.0.1:9/channelgate/api");
  // …and with nothing configured anywhere, the compiled-in constant is the answer.
  const ambient = process.env.CHANNELGATE_PLATFORM_URL;
  delete process.env.CHANNELGATE_PLATFORM_URL;
  assert.equal(platformBaseUrl(), DEFAULT_PLATFORM_URL);
  process.env.CHANNELGATE_PLATFORM_URL = ambient;
});

test("POST /api/license/verify answers even when the platform is unreachable", async () => {
  clearTestLicense();
  await put({ licenseKey: SECRET_KEY });
  const res = await fetch(`${base}/license/verify`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  // The unroutable base URL means "unreachable" — a healthy state with a banner, not a 500.
  assert.equal(body.outcome, "unreachable");
  assert.equal(body.state, "grace");
  assert.equal(body.banner.level, "warn");
});
