// Real admin form + router acceptance in a disposable store and Chromium profile.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

test("unrelated channel saves preserve undisplayed guests while explicit edits remain validated", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { upsertChannelEntry, defaultChannelMeta, saveChannelMeta, getChannelMeta, setUser } = await import("../src/config/store.js");
  const channelId = "C_GUEST_BROWSER";
  const channel = await upsertChannelEntry(channelId, { name: "guest-browser", type: "channel", isDM: false });
  const saved = ["U_VISIBLE", "U_SAVED_ONLY", "U_APPROVED"];
  await saveChannelMeta(channel.slug, { ...defaultChannelMeta({ channelId, name: channel.name, type: "channel", isDM: false }), allowedUsers: saved, allowNetwork: false, cleanMode: false });
  await setUser("U_APPROVED", { approved: true });
  let rosterFails = false;
  let saveFails = false;
  const members = ["U_VISIBLE", "U_ADD", "U_APPROVED"];
  const client = {
    conversations: { members: async () => {
      if (rosterFails) throw new Error("controlled unavailable roster");
      return { members, response_metadata: { next_cursor: "" } };
    } },
    users: { info: async ({ user }) => ({ user: { id: user, name: user, profile: { display_name: user } } }) },
  };
  const app = express();
  app.use(express.json());
  const payloads = [];
  app.put(`/api/channels/${channelId}/meta`, (req, res, next) => {
    payloads.push(req.body);
    if (saveFails) return res.status(503).json({ error: "controlled save failure" });
    next();
  });
  app.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  app.get("/api/health", (_req, res) => res.json({ slack: { connected: true }, engines: {} }));
  app.use("/api", createAdminRouter({ slack: { getClient: () => client, snapshot: () => ({ connected: true, teamId: "T_FIXTURE" }) } }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get(`/conversations/channel/${channelId}`, (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}/conversations/channel/${channelId}`);
    await page.waitForFunction(() => globalThis.document.querySelector(".ch-users")?.dataset.ready === "1");
  };
  const toggle = async (selector) => page.locator(selector).locator("xpath=..").click();
  const save = async (status = 200) => {
    const pending = page.waitForResponse((r) => r.url().endsWith(`/channels/${channelId}/meta`) && r.request().method() === "PUT");
    await page.locator(".save-channel").click();
    const response = await pending;
    assert.equal(response.status(), status, await response.text());
    await page.locator(".detail-savebar .msg").filter({ hasText: status === 200 ? /^Saved$/ : /Couldn't save/ }).waitFor();
  };
  await open();
  assert.equal(await page.locator('.ch-users input[value="U_SAVED_ONLY"]').count(), 0);
  assert.equal(await page.locator('.ch-users input[value="U_APPROVED"]').isChecked(), true);
  await toggle(".ch-network");
  await save();
  assert.equal(Object.hasOwn(payloads.at(-1), "allowedUsers"), false, "unrelated Network save omits even a successfully loaded partial guest roster");
  assert.deepEqual((await getChannelMeta(channel.slug)).allowedUsers, saved);
  assert.equal(await page.locator('.ch-users input[value="U_APPROVED"]').isChecked(), true, "inherited access stays visibly checked after save");
  await toggle(".ch-clean");
  await save();
  assert.equal(Object.hasOwn(payloads.at(-1), "allowedUsers"), false);
  assert.deepEqual((await getChannelMeta(channel.slug)).allowedUsers, saved);
  await open();
  assert.equal(await page.locator('.ch-users input[value="U_VISIBLE"]').isChecked(), true);
  await toggle('.ch-users input[value="U_VISIBLE"]');
  await toggle('.ch-users input[value="U_ADD"]');
  saveFails = true;
  await save(503);
  assert.deepEqual(payloads.at(-1).allowedUsers, ["U_ADD"]);
  assert.deepEqual((await getChannelMeta(channel.slug)).allowedUsers, saved, "failed edit keeps saved grants");
  saveFails = false;
  await save();
  assert.deepEqual(payloads.at(-1).allowedUsers, ["U_ADD"], "retry retains pending guest edit");
  assert.deepEqual((await getChannelMeta(channel.slug)).allowedUsers, ["U_ADD"], "explicit replacement retains current-member validation");
  await toggle(".ch-network");
  await save();
  assert.equal(Object.hasOwn(payloads.at(-1), "allowedUsers"), false, "successful save resets guest dirty state");
  rosterFails = true;
  await page.reload();
  await page.locator(".ch-users").filter({ hasText: /Guest list unavailable/ }).waitFor();
  await toggle(".ch-network");
  await save();
  assert.equal(Object.hasOwn(payloads.at(-1), "allowedUsers"), false);
  assert.deepEqual((await getChannelMeta(channel.slug)).allowedUsers, ["U_ADD"]);
  assert.deepEqual(errors, []);
});
