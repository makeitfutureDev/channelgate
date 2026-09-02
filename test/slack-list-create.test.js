import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { saveSettings } = await import("../src/config/settings.js");
const { createList } = await import("../src/slack/lists.js");

test("a bot-created Slack List is granted to the current channel before it is returned", async (t) => {
  saveSettings({ slackBotToken: "xoxb-test-list-token" });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split("/").at(-1), body: JSON.parse(init.body) });
    if (String(url).endsWith("/slackLists.create")) {
      return { json: async () => ({ ok: true, list_id: "FTESTLIST01", list_metadata: { schema: [] } }) };
    }
    return { json: async () => ({ ok: true }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await createList({ name: "QA defects", channelId: "C_PRIVATE_QA" });

  assert.equal(result.listId, "FTESTLIST01");
  assert.deepEqual(calls.map((c) => c.method), ["slackLists.create", "slackLists.access.set"]);
  assert.deepEqual(calls[1].body, {
    list_id: "FTESTLIST01",
    access_level: "write",
    channel_ids: ["C_PRIVATE_QA"],
  });
});

test("List creation fails visibly when channel sharing fails", async (t) => {
  saveSettings({ slackBotToken: "xoxb-test-list-token" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    json: async () => String(url).endsWith("/slackLists.create")
      ? { ok: true, list_id: "FORPHANED01" }
      : { ok: false, error: "access_denied" },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    () => createList({ name: "Invisible tracker", channelId: "C_PRIVATE_QA" }),
    /can't access that List|access denied/i,
  );
});
