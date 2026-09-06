import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { createAdminRouter } = await import("../src/web/routes/admin.js");
const {
  defaultChannelMeta,
  getChannelMeta,
  saveChannelMeta,
  upsertChannelEntry,
} = await import("../src/config/store.js");

const entry = await upsertChannelEntry("C_MAKE", {
  name: "make-toolbox-test",
  type: "channel",
  isDM: false,
});
await saveChannelMeta(entry.slug, defaultChannelMeta({
  channelId: "C_MAKE",
  name: "make-toolbox-test",
  type: "channel",
  isDM: false,
}));

const probeCalls = [];
const app = express();
app.use(express.json());
app.use(createAdminRouter({
  slack: { snapshot: () => ({ status: "disconnected", connected: false }) },
  testMakeToolbox: async (input) => {
    probeCalls.push(input);
    return { count: 2, tools: ["lookup_customer", "create_ticket"] };
  },
}));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, json: await response.json() };
}

test("channel API saves, preserves, masks, validates, and clears one Make toolbox", async () => {
  const url = "https://eu1.make.celonis.com/mcp/server/abc-123/";
  const saved = await request("/channels/C_MAKE/meta", {
    method: "PUT",
    body: { makeToolboxUrl: url, makeToolboxKey: "channel-key-1234" },
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.json.meta.makeToolboxUrl, url.slice(0, -1));
  // The API never returns a stored secret — not from the list, and not echoed by a save.
  assert.equal(saved.json.meta.makeToolboxKey, undefined);
  assert.equal(saved.json.meta.hasMakeToolboxKey, true);
  assert.equal(saved.json.meta.makeToolboxKeyLast4, "1234");

  const channels = await request("/channels");
  const channel = channels.json.channels.find((item) => item.channelId === "C_MAKE");
  assert.equal(channel.meta.makeToolboxKey, undefined, "the list must never carry the raw key");
  assert.equal(channel.meta.hasMakeToolboxKey, true);
  assert.equal(channel.meta.makeToolboxKeyLast4, "1234");

  const unrelated = await request("/channels/C_MAKE/meta", {
    method: "PUT",
    body: { nudges: true },
  });
  assert.equal(unrelated.response.status, 200);
  assert.equal((await getChannelMeta(entry.slug)).makeToolboxKey, "channel-key-1234");

  const invalid = await request("/channels/C_MAKE/meta", {
    method: "PUT",
    body: { makeToolboxUrl: "https://evil.example/mcp/server/abc" },
  });
  assert.equal(invalid.response.status, 400);
  assert.match(invalid.json.error, /Make toolbox URL/i);
  assert.equal((await getChannelMeta(entry.slug)).makeToolboxUrl, url.slice(0, -1));

  const cleared = await request("/channels/C_MAKE/meta", {
    method: "PUT",
    body: { clearMakeToolbox: true },
  });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.json.meta.makeToolboxUrl, "");
  // Masked like every other secret; "cleared" shows as simply not present.
  assert.equal(cleared.json.meta.makeToolboxKey, undefined);
  assert.equal(cleared.json.meta.hasMakeToolboxKey, false);

  const partial = await request("/channels/C_MAKE/meta", {
    method: "PUT",
    body: { makeToolboxUrl: "https://eu2.make.com/mcp/server/new" },
  });
  assert.equal(partial.response.status, 400);
  assert.match(partial.json.error, /URL and key are both required/i);
});

test("connection test uses unsaved or saved channel credentials and only returns tools/list summary", async () => {
  probeCalls.length = 0;
  const unsaved = await request("/channels/C_MAKE/make-toolbox-test", {
    method: "POST",
    body: {
      makeToolboxUrl: "https://eu2.make.com/mcp/server/unsaved/",
      makeToolboxKey: "unsaved-key",
    },
  });
  assert.equal(unsaved.response.status, 200);
  assert.deepEqual(unsaved.json, {
    ok: true,
    count: 2,
    tools: ["lookup_customer", "create_ticket"],
  });
  assert.deepEqual(probeCalls[0], {
    url: "https://eu2.make.com/mcp/server/unsaved",
    key: "unsaved-key",
    timeoutMs: 10_000,
  });

  await request("/channels/C_MAKE/meta", {
    method: "PUT",
    body: {
      makeToolboxUrl: "https://eu2.make.com/mcp/server/saved",
      makeToolboxKey: "saved-key",
    },
  });
  const stored = await request("/channels/C_MAKE/make-toolbox-test", {
    method: "POST",
    body: {},
  });
  assert.equal(stored.response.status, 200);
  assert.deepEqual(probeCalls[1], {
    url: "https://eu2.make.com/mcp/server/saved",
    key: "saved-key",
    timeoutMs: 10_000,
  });
});

test("Admin Connections page exposes per-channel Make toolbox URL, key, test, and clear controls", async () => {
  const [html, client] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  for (const className of [
    "ch-make-toolbox-url",
    "ch-make-toolbox-key",
    "ch-make-toolbox-test",
    "ch-make-toolbox-clear",
    "ch-make-toolbox-state",
  ]) {
    assert.match(html, new RegExp(className));
    assert.match(client, new RegExp(className));
  }
  assert.match(client, /make-toolbox-test/);
  assert.match(client, /clearMakeToolbox/);
  assert.match(client, /makeToolboxUrl/);
  assert.match(client, /makeToolboxKey/);
  // The key is masked in the UI and only fetched on demand — the API no longer sends it, so the
  // field is seeded from has/last4 with a reveal fetcher rather than a stored value.
  assert.match(client, /attachReveal\(makeToolboxKeyInput, \{ has: ch\.meta\.hasMakeToolboxKey/);
  assert.match(client, /revealSecret\("channel", "makeToolboxKey", ch\.slug\)/);
  assert.match(client, /makeToolboxState\.textContent = ch\.meta\.hasMakeToolboxKey \? "saved" : "not configured"/);
});
