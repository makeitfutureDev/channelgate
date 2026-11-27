import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { saveSettings } = await import("../src/config/settings.js");
const { addItem, updateItem, listItems } = await import("../src/slack/lists.js");
const channelId = "C_LIST_FIELDS";
const listId = "FLISTFIELDS";
const itemId = "RecFIELDS";
const message = "https://example.slack.com/archives/C_LIST_FIELDS/p1700000000123456";
const schema = [
  { id: "ColNAME", key: "name", name: "Name", type: "text", is_primary_column: true },
  { id: "ColMESSAGE", key: "message", name: "Message", type: "message" },
  { id: "ColFILE", key: "files", name: "Attachments", type: "attachment" },
  { id: "ColLINK", key: "url", name: "Link", type: "link" },
  { id: "ColSTATUS", key: "status", name: "Status", type: "select", options: { choices: [{ value: "ongoing", label: "Ongoing" }] } },
];
function mockSlack(t, items = []) {
  saveSettings({ slackBotToken: "xoxb-test-list-token" });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").at(-1);
    const body = init.headers["Content-Type"].startsWith("application/json") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ method, body });
    const data = method === "files.info" ? { file: { channels: [channelId], list_metadata: { schema } } }
      : method === "slackLists.items.list" ? { items }
        : { item: { id: itemId } };
    return { json: async () => ({ ok: true, ...data }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return calls;
}

test("creating a row sends native message, attachment and link values alongside title and status", async (t) => {
  const calls = mockSlack(t);
  const result = await addItem({ listId, channelId, name: "Source task", fields: {
    Message: message, files: ["FONE", "FTWO"], ColLINK: { original_url: "https://example.com", display_name: "Details", display_as_url: false }, Status: "Ongoing",
  } });
  assert.equal(result.itemId, itemId);
  const body = calls.find((c) => c.method === "slackLists.items.create").body;
  assert.deepEqual(body.initial_fields.slice(0, 4), [
    { column_id: "ColMESSAGE", message: [message] },
    { column_id: "ColFILE", attachment: ["FONE", "FTWO"] },
    { column_id: "ColLINK", link: [{ original_url: "https://example.com", display_name: "Details", display_as_url: false }] },
    { column_id: "ColSTATUS", select: ["ongoing"] },
  ]);
  assert.equal(body.initial_fields[4].rich_text[0].elements[0].elements[0].text, "Source task");
  assert.equal(calls[0].method, "files.info");
});

test("updating typed columns addresses the existing row and supports scalar and array values", async (t) => {
  const calls = mockSlack(t);
  await updateItem({ listId, channelId, itemId, fields: { message: [message], Attachments: "FONE", Link: ["https://one.example", { original_url: "https://two.example", display_name: "Two" }] } });
  assert.deepEqual(calls.at(-1), { method: "slackLists.items.update", body: { list_id: listId, cells: [
    { row_id: itemId, column_id: "ColMESSAGE", message: [message] },
    { row_id: itemId, column_id: "ColFILE", attachment: ["FONE"] },
    { row_id: itemId, column_id: "ColLINK", link: [
      { original_url: "https://one.example", display_as_url: true, display_name: "https://one.example" },
      { original_url: "https://two.example", display_name: "Two", display_as_url: true },
    ] },
  ] } });
  await updateItem({ listId, channelId, itemId, fields: { Message: [], Attachments: [], Link: [] } });
  assert.deepEqual(calls.at(-1).body.cells, [
    { row_id: itemId, column_id: "ColMESSAGE", message: [] },
    { row_id: itemId, column_id: "ColFILE", attachment: [] },
    { row_id: itemId, column_id: "ColLINK", link: [] },
  ]);
});

test("list summaries retain URLs from Slack response objects and file IDs", async (t) => {
  mockSlack(t, [{ id: itemId, fields: [
    { column_id: "ColNAME", text: "Source task" },
    { column_id: "ColMESSAGE", text: "message preview", message: [{ value: message, channel_id: channelId, ts: "1700000000.123456" }] },
    { column_id: "ColFILE", attachment: ["FONE", "FTWO"] },
    { column_id: "ColLINK", link: [{ originalUrl: "https://one.example", displayName: "One" }, { original_url: "https://two.example" }] },
  ] }, { id: "RecSTRINGS", fields: [
    { column_id: "ColMESSAGE", message: [message] },
    { column_id: "ColLINK", link: ["https://three.example"] },
  ] }]);
  const { items } = await listItems({ listId, channelId });
  assert.deepEqual(items[0], { id: itemId, title: "Source task", cols: { Message: message, Attachments: "FONE, FTWO", Link: "https://one.example, https://two.example" } });
  assert.equal(items[1].cols.Message, message);
  assert.equal(items[1].cols.Link, "https://three.example");
});

test("typed message and link writes cannot access a List outside the current channel", async (t) => {
  const calls = mockSlack(t);
  const fields = { Message: message, Link: "https://example.com", Attachments: "FONE" };
  await assert.rejects(
    () => addItem({ listId, channelId: "C_OTHER_CHANNEL", name: "Denied", fields }),
    /not shared with the current channel/,
  );
  await assert.rejects(
    () => updateItem({ listId, channelId: "C_OTHER_CHANNEL", itemId, fields }),
    /not shared with the current channel/,
  );
  assert.deepEqual(calls.map(({ method }) => method), ["files.info", "files.info"]);
});
