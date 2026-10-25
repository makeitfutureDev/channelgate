// Security audit batch 4: the admin UI's channel meta PUT narrows the use policy the same way the
// Slack Access control does — "admins"/"none" evicts the approved members seeded under
// "approved" and keeps explicit (un-approved) guests. The org-wide reset-access route already
// clears the whole list.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createChannelsRouter } = await import("../src/web/routes/channels.js");
const { upsertChannelEntry, saveChannelMeta, getChannelMeta, defaultChannelMeta, setUser } = await import("../src/config/store.js");
const { isAuthorized } = await import("../src/gateway/modes.js");

const app = express();
app.use(express.json());
app.use(createChannelsRouter());
app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ error: error.message }));
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${server.address().port}`;
const put = (url, body) => fetch(base + url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("PUT /channels/:id/meta with access=admins evicts seeded approved members and keeps guests", async () => {
  await setUser("U_EV_ADMIN", { approved: true, isAdmin: true });
  await setUser("U_EV_MEMBER", { approved: true });
  await setUser("U_EV_GUEST", { approved: false });
  const id = "C_EVICT_WEB";
  const entry = await upsertChannelEntry(id, { name: "evict-web", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: id, name: entry.name }), access: "approved", allowedUsers: ["U_EV_MEMBER", "U_EV_GUEST", "U_EV_ADMIN"] });

  const res = await put(`/channels/${id}/meta`, { access: "admins" });
  assert.equal(res.status, 200, await res.text());
  const meta = await getChannelMeta(entry.slug);
  assert.equal(meta.access, "admins");
  assert.deepEqual(meta.allowedUsers, ["U_EV_GUEST", "U_EV_ADMIN"], "the seeded member goes; the guest and the admin stay");
  assert.equal(isAuthorized(meta, "U_EV_MEMBER", false, { isApprovedUser: true }), false);
  assert.equal(isAuthorized(meta, "U_EV_GUEST", false, {}), true);
  assert.equal(isAuthorized(meta, "U_EV_ADMIN", false, { isAdminUser: true }), true);

  // Widening back resurrects nobody; an unrelated save under a narrow policy touches the list not at all.
  assert.equal((await put(`/channels/${id}/meta`, { access: "approved" })).status, 200);
  assert.deepEqual((await getChannelMeta(entry.slug)).allowedUsers, ["U_EV_GUEST", "U_EV_ADMIN"]);
  assert.equal((await put(`/channels/${id}/meta`, { access: "none", allowNetwork: true })).status, 200);
  assert.deepEqual((await getChannelMeta(entry.slug)).allowedUsers, ["U_EV_GUEST", "U_EV_ADMIN"]);
});
