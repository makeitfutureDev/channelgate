// The admin console's Variables tables could add and remove a variable but not change whether it
// is secret (a proxy placeholder) or readable (the raw value): an admin who needed a private key
// in a container had to re-enter its value. PATCH …/:name { exposure } switches it in place for
// all three scopes, never reads or returns the value, and audits the name and mode only.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";

ensureTestEnv();
testLicenseEnv({ tier: "enterprise" });

const { readEvents } = await import("../src/util/logger.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { defaultChannelMeta, saveChannelMeta, upsertChannelEntry, setUser } = await import("../src/config/store.js");
const { getOrgEnv, getUserEnv } = await import("../src/config/scoped-env.js");
const { parseExposureChange } = await import("../src/config/channel-env.js");

const CHANNEL_ID = "C_VAR_VISIBILITY";
const USER_ID = "U_VAR_VISIBILITY";
const VALUE = "sc_dk_never-in-a-response-or-audit-0123456789abcdefghijk";

await setUser(USER_ID, { name: "Visibility Person", approved: true });
const entry = await upsertChannelEntry(CHANNEL_ID, { name: "var-visibility", type: "channel", isDM: false });
await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: CHANNEL_ID, name: "var-visibility", type: "channel", isDM: false }));

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function request(url, { method = "GET", body } = {}) {
  const response = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  return { response, raw, json: JSON.parse(raw) };
}

const SCOPES = [
  { scope: "organization", url: "/org-secrets/SHARE_DECRYPTION_KEY", stored: () => getOrgEnv().SHARE_DECRYPTION_KEY },
  { scope: "channel", url: `/channels/${CHANNEL_ID}/env/SHARE_DECRYPTION_KEY`, stored: null },
  { scope: "personal", url: `/users/${USER_ID}/env/SHARE_DECRYPTION_KEY`, stored: async () => (await getUserEnv(USER_ID)).SHARE_DECRYPTION_KEY },
];

for (const { scope, url, stored } of SCOPES) {
  test(`${scope}: an admin switches a hidden variable to readable and back without re-entering it`, async () => {
    const set = await request(url, { method: "PUT", body: { value: VALUE, exposure: "hidden" } });
    assert.equal(set.response.status, 200, set.raw);
    const row = (vars) => vars.find((v) => v.name === "SHARE_DECRYPTION_KEY");
    assert.equal(row(set.json.vars).protected, true, "starts as a secret");

    const readable = await request(url, { method: "PATCH", body: { exposure: "readable" } });
    assert.equal(readable.response.status, 200, readable.raw);
    assert.equal(row(readable.json.vars).protected, false);
    assert.equal(row(readable.json.vars).exposureChoice, "readable");
    assert.ok(!readable.raw.includes(VALUE), "the response never carries the value");
    if (stored) assert.equal((await stored()).value, VALUE, "the value is untouched");

    const hidden = await request(url, { method: "PATCH", body: { exposure: "hidden" } });
    assert.equal(hidden.response.status, 200, hidden.raw);
    assert.equal(row(hidden.json.vars).protected, true, "secret again");

    const audit = readEvents({ limit: 200 }).filter((e) => e.event === "secret_mode_set" && e.scope === scope);
    assert.deepEqual(audit.slice(0, 2).map((e) => e.exposure).sort(), ["hidden", "readable"]);
    assert.ok(audit.every((e) => e.name === "SHARE_DECRYPTION_KEY"));
    assert.ok(!JSON.stringify(readEvents({ limit: 200 })).includes(VALUE), "no audit row carries the value");
  });

  test(`${scope}: the visibility switch refuses a value, an unknown mode and an unknown name`, async () => {
    const withValue = await request(url, { method: "PATCH", body: { exposure: "readable", value: "rotated" } });
    assert.equal(withValue.response.status, 400);
    assert.match(withValue.json.error, /Use PUT/);
    const badMode = await request(url, { method: "PATCH", body: { exposure: "visible" } });
    assert.equal(badMode.response.status, 400);
    const missing = await request(url.replace("SHARE_DECRYPTION_KEY", "NOT_SET_HERE"), { method: "PATCH", body: { exposure: "readable" } });
    assert.equal(missing.response.status, 400);
    assert.match(missing.json.error, /NOT_SET_HERE/);
  });
}

test("parseExposureChange accepts exactly readable, hidden and auto", () => {
  for (const mode of ["readable", "hidden", "auto"]) assert.equal(parseExposureChange({ exposure: mode }), mode);
  assert.throws(() => parseExposureChange({}), /Choose the visibility/);
  assert.throws(() => parseExposureChange({ exposure: "__proto__" }), /Choose the visibility/);
});

test("the Variables table offers Make readable (confirmed) and Make secret through PATCH", () => {
  const client = readFileSync(new URL("../public/admin-secrets.js", import.meta.url), "utf8");
  assert.match(client, /"Make readable" : "Make secret"/);
  assert.match(client, /method: "PATCH", body: JSON\.stringify\(\{ exposure: secret \? "readable" : "hidden" \}\)/);
  assert.match(client, /title: `Make \$\{entry\.name\} readable\?`/, "making a variable readable asks first");
});
