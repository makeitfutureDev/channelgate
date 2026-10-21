import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { setUser, upsertChannelEntry, saveChannelMeta, getUser } = await import("../src/config/store.js");
const { createUsersRouter } = await import("../src/web/routes/users.js");
const { createChannelsRouter } = await import("../src/web/routes/channels.js");
const { saveSettings } = await import("../src/config/settings.js");
const { noPasswordLockdown, authMiddleware, handleLogin } = await import("../src/web/auth.js");

saveSettings({ adminPassword: "inventory-test-password", apiKey: "inventory-test-run-key" });
await setUser("U_INVENTORY", { name: "Inventory user", composioToken: "private-user-token" });
await setUser("U_OTHER", { name: "Other user", composioToken: "other-private-user-token" });
const channel = await upsertChannelEntry("C_INVENTORY", { name: "inventory-fixture", type: "channel", isDM: false });
await saveChannelMeta(channel.slug, { channelId: "C_INVENTORY", composioToken: "private-channel-token", noDefaultTokens: true });
for (const [id, entryDM, metaDM, entryType, metaType] of [
  ["D_ENTRY_DM", true, false, "im", "channel"],
  ["D_META_DM", false, true, "channel", "channel"],
  ["D_ENTRY_TYPE", false, false, "im", "channel"],
  ["D_META_TYPE", false, false, "channel", "im"],
]) {
  const entry = await upsertChannelEntry(id, { name: id.toLowerCase(), type: entryType, isDM: entryDM });
  await saveChannelMeta(entry.slug, { channelId: id, type: metaType, isDM: metaDM, composioToken: "dm-must-stay-disabled" });
}

const calls = [];
const inventory = async (selection) => {
  calls.push(selection);
  return { state: "ready", source: selection.kind, accounts: [{ app: "gmail", id: `ca-${selection.id}` }] };
};
const app = express();
app.use(express.json());
app.post("/api/login", handleLogin);
app.use(noPasswordLockdown, authMiddleware);
app.use("/api", createUsersRouter({ composioInventory: inventory }));
app.use("/api", createChannelsRouter({ composioInventory: inventory }));
const server = await new Promise((resolve) => {
  const running = app.listen(0, "127.0.0.1", () => resolve(running));
});
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;
const login = await fetch(`${base}/api/login`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "inventory-test-password" }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";")[0];
async function get(path, headers = { cookie }) {
  const response = await fetch(`${base}/api${path}`, { headers });
  return { response, json: await response.json() };
}

test("user inventory is scoped to the selected user's stored record and never returns stored credentials", async () => {
  const before = await getUser("U_INVENTORY");
  const { response, json } = await get("/users/U_INVENTORY/composio-connections");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(json.accounts, [{ app: "gmail", id: "ca-U_INVENTORY" }]);
  assert.deepEqual(calls.at(-1), { kind: "user", id: "U_INVENTORY", record: before });
  assert.doesNotMatch(JSON.stringify(json), /private-user-token|other-private-user-token|composioToken/);
  assert.deepEqual(await getUser("U_INVENTORY"), before, "viewing inventory does not mutate the user");
});

test("channel inventory merges its entry with current metadata and retains policy scope", async () => {
  const { response, json } = await get("/channels/C_INVENTORY/composio-connections?refresh=1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const selection = calls.at(-1);
  assert.equal(selection.kind, "channel");
  assert.equal(selection.id, "C_INVENTORY");
  assert.equal(selection.record.slug, channel.slug);
  assert.equal(selection.record.composioToken, "private-channel-token");
  assert.equal(selection.record.noDefaultTokens, true);
  assert.equal(selection.record.isDM, false);
  assert.doesNotMatch(JSON.stringify(json), /private-channel-token|composioToken/);
});

test("DM identity remains disabled when either entry or metadata supplies the DM marker", async () => {
  for (const id of ["D_ENTRY_DM", "D_META_DM", "D_ENTRY_TYPE", "D_META_TYPE"]) {
    const { response } = await get(`/channels/${id}/composio-connections`);
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1).record.isDM, true, `${id} preserves the direct-message boundary`);
  }
});

test("unknown users and channels return 404 without invoking any provider", async () => {
  const count = calls.length;
  for (const path of ["/users/U_UNKNOWN/composio-connections", "/channels/C_UNKNOWN/composio-connections"]) {
    const { response, json } = await get(path);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(json.error, /unknown/);
  }
  assert.equal(calls.length, count);
});

test("both inventories require the admin session; the run API key does not grant access", async () => {
  const count = calls.length;
  for (const path of ["/users/U_INVENTORY/composio-connections", "/channels/C_INVENTORY/composio-connections"]) {
    for (const headers of [{}, { "x-api-key": "inventory-test-run-key" }, { authorization: "Bearer inventory-test-run-key" }]) {
      const { response, json } = await get(path, headers);
      assert.equal(response.status, 401);
      assert.doesNotMatch(JSON.stringify(json), /ca-U_INVENTORY|private-user-token|private-channel-token/);
    }
  }
  assert.equal(calls.length, count, "authentication rejects before provider lookup");
});
