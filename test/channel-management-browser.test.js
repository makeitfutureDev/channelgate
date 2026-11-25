// Exercise the shipped admin form and real metadata PUT against a disposable store.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { upsertChannelEntry, defaultChannelMeta, saveChannelMeta, getChannelMeta, patchChannelMeta } = await import("../src/config/store.js");
const { canManage } = await import("../src/gateway/modes.js");

async function fixture(t, channelId) {
  const channel = await upsertChannelEntry(channelId, { name: channelId.toLowerCase(), type: "channel", isDM: false });
  const managers = ["U_NAMED_MANAGER"];
  await saveChannelMeta(channel.slug, { ...defaultChannelMeta({ channelId, name: channel.name, type: "channel", isDM: false }),
    manageAccess: "custom", managers, allowNetwork: false });
  const payloads = [];
  const app = express();
  app.use(express.json());
  // Focused authenticated-admin boundary; authentication has separate coverage.
  app.get("/api/auth/me", (_req, res) => res.json({ bootstrap: false, linkRequired: false, fresh: true, account: { userId: "U_BROWSER_ADMIN" }, passkeys: [] }));
  app.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  app.get("/api/health", (_req, res) => res.json({ slack: { connected: false }, engines: {} }));
  app.get("/api/channels/:id/members", (_req, res) => res.json({ members: [] }));
  app.put(`/api/channels/${channelId}/meta`, (req, _res, next) => { payloads.push(req.body); next(); });
  app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null } }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get("/conversations/channel/:id", (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { channel, managers, payloads, base: `http://127.0.0.1:${server.address().port}` };
}

function assertCustom(meta, managers) {
  assert.equal(meta.manageAccess, "custom");
  assert.deepEqual(meta.managers, managers);
  assert.equal(canManage(meta, { authorId: managers[0], isApprovedUser: true }), true);
  assert.equal(canManage(meta, { authorId: "U_OTHER_MEMBER", isApprovedUser: true }), false);
}

test("metadata PUT preserves omitted custom policy and manager list, and accepts explicit policy changes", async (t) => {
  const channelId = "C_MANAGE_API";
  const { channel, managers, base } = await fixture(t, channelId);
  const put = async (body) => {
    const response = await fetch(`${base}/api/channels/${channelId}/meta`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).meta;
  };
  assertCustom(await put({ allowNetwork: true }), managers);
  assertCustom(await put({ memory: true, manageAccess: "custom" }), managers);
  for (const manageAccess of ["members", "admins", "custom"]) {
    const result = await put({ manageAccess });
    assert.equal(result.manageAccess, manageAccess);
    assert.deepEqual(result.managers, managers);
  }
  assertCustom(await getChannelMeta(channel.slug), managers);
});

test("admin form preserves named managers on unrelated saves and changes policy only on explicit selection", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const channelId = "C_MANAGE_BROWSER";
  const { channel, managers, base, payloads } = await fixture(t, channelId);
  const browser = await chromium.launch({ headless: true, ...(process.env.CG_BROWSER_EXECUTABLE ? { executablePath: process.env.CG_BROWSER_EXECUTABLE } : {}), args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => Object.defineProperty(globalThis, "EventSource", { value: undefined }));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/conversations/channel/${channelId}`);
  await page.locator('#channel-detail .subtab[data-pane="access"]').click();
  const select = page.locator("#channel-detail .ch-manage");
  assert.equal(await select.inputValue(), "custom", "saved named-list policy must be represented by the select");
  const save = async () => {
    const pending = page.waitForResponse((r) => r.url().endsWith(`/channels/${channelId}/meta`) && r.request().method() === "PUT");
    await page.locator("#channel-detail .save-channel").click();
    const response = await pending;
    assert.equal(response.status(), 200, await response.text());
    await page.locator(".detail-savebar .msg").filter({ hasText: /^Saved$/ }).waitFor();
  };
  await page.locator("#channel-detail .ch-network").locator("..").click();
  await save();
  assert.equal(Object.hasOwn(payloads.at(-1), "manageAccess"), false);
  assert.equal(Object.hasOwn(payloads.at(-1), "managers"), false);
  assertCustom(await getChannelMeta(channel.slug), managers);
  await page.reload();
  await page.locator('#channel-detail .subtab[data-pane="access"]').click();
  assert.equal(await select.inputValue(), "custom");
  // A second writer may change the policy while this card is open. An unrelated save
  // must preserve the current stored value instead of reasserting the stale selection.
  await patchChannelMeta(channel.slug, { manageAccess: "members" });
  await page.locator("#channel-detail .ch-network").locator("..").click();
  await save();
  assert.equal(Object.hasOwn(payloads.at(-1), "manageAccess"), false);
  assert.equal((await getChannelMeta(channel.slug)).manageAccess, "members");
  assert.equal(await select.inputValue(), "members", "successful save reconciles the accepted policy");
  for (const manageAccess of ["admins", "custom", "members", "custom"]) {
    await select.selectOption(manageAccess);
    await save();
    assert.equal(payloads.at(-1).manageAccess, manageAccess);
    const stored = await getChannelMeta(channel.slug);
    assert.equal(stored.manageAccess, manageAccess);
    assert.deepEqual(stored.managers, managers);
  }
  assertCustom(await getChannelMeta(channel.slug), managers);
  assert.deepEqual(errors, []);
});
