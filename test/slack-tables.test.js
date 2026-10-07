import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { buildTableMessage, postTable } = await import("../src/slack/tables.js");

test("buildTableMessage creates a native sortable, paginated data table", () => {
  const message = buildTableMessage({
    caption: "Suppliers in space 6",
    headers: ["ID", "Name", "Tier 1 CZ", "Status"],
    rows: [
      [2, "HansGrohe", "✅", "Fully configured"],
      [4786, "HG", "✅", "Duplicate of 2"],
      [5685, "UBC", "", "Name only"],
    ],
    pageSize: 2,
    rowHeaderColumn: 1,
  });

  assert.match(message.text, /Suppliers in space 6.*3 rows.*4 columns/);
  assert.equal(message.blocks.length, 1);
  const table = message.blocks[0];
  assert.equal(table.type, "data_table");
  assert.equal(table.caption, "Suppliers in space 6");
  assert.equal(table.page_size, 2);
  assert.equal(table.row_header_column_index, 1);
  assert.deepEqual(table.rows[0], [
    { type: "raw_text", text: "ID" },
    { type: "raw_text", text: "Name" },
    { type: "raw_text", text: "Tier 1 CZ" },
    { type: "raw_text", text: "Status" },
  ]);
  assert.deepEqual(table.rows[1][0], { type: "raw_number", value: 2, text: "2" });
  assert.deepEqual(table.rows[3][2], { type: "raw_text", text: "—" });
});

test("buildTableMessage uses supplied accessible fallback text", () => {
  const message = buildTableMessage({
    caption: "Build status",
    headers: ["Job", "Duration"],
    rows: [["Tests", 42]],
    summary: "One build job completed.",
  });

  assert.equal(message.text, "One build job completed.");
  assert.equal(message.blocks[0].page_size, 1);
});

test("table validation enforces Slack's rectangular shape and limits", () => {
  assert.throws(
    () => buildTableMessage({ caption: "Mismatch", headers: ["A", "B"], rows: [["only one"]] }),
    /exactly 2 cells/,
  );
  assert.throws(
    () => buildTableMessage({ caption: "Bad value", headers: ["A"], rows: [[Number.NaN]] }),
    /finite number/,
  );
  assert.throws(
    () => buildTableMessage({ caption: "Bad header", headers: ["  "], rows: [["x"]] }),
    /headers\[0\].*required/,
  );
  assert.throws(
    () => buildTableMessage({ caption: "Too large", headers: ["A"], rows: [["x".repeat(20_001)]] }),
    /20,000-character limit/,
  );
  assert.throws(
    () => buildTableMessage({ caption: "Too many", headers: ["A"], rows: Array.from({ length: 201 }, () => ["x"]) }),
    /at most 200 items/,
  );
  assert.throws(
    () => buildTableMessage({ caption: "Bad page", headers: ["A"], rows: [["x"]], pageSize: 0 }),
    /integer from 1 to 100/,
  );
  assert.throws(
    () => buildTableMessage({ caption: "Bad header", headers: ["A"], rows: [["x"]], rowHeaderColumn: 1 }),
    /integer from 0 to 0/,
  );
});

test("rich cells: links, formatting, mentions and row buttons become rich_text / action_cell cells", () => {
  const message = buildTableMessage({
    caption: "Open tasks",
    headers: ["**Task**", "Owner", "Link", "Action"],
    rows: [
      ["Fix login [spec](https://example.com/spec) — see https://example.com/notes.", { user: "U123ABC" }, { text: "Ticket 42", url: "https://example.com/42" }, { button: { label: "Open", url: "https://example.com/42" } }],
      [{ text: "Done", strike: true }, "**urgent** `p1` ~~p2~~", { text: "n/a" }, "none"],
    ],
  });
  const table = message.blocks[0];
  // Header cells are always plain text — Slack rejects rich text there.
  assert.deepEqual(table.rows[0][0], { type: "raw_text", text: "Task" });
  const [link, owner, ticket, action] = table.rows[1];
  assert.equal(link.type, "rich_text");
  assert.deepEqual(link.elements[0].elements, [
    { type: "text", text: "Fix login " },
    { type: "link", url: "https://example.com/spec", text: "spec" },
    { type: "text", text: " — see " },
    { type: "link", url: "https://example.com/notes" },
    { type: "text", text: "." },
  ]);
  assert.deepEqual(owner.elements[0].elements, [{ type: "user", user_id: "U123ABC" }]);
  assert.deepEqual(ticket.elements[0].elements, [{ type: "link", url: "https://example.com/42", text: "Ticket 42" }]);
  assert.equal(action.type, "action_cell");
  assert.equal(action.element.type, "button");
  assert.equal(action.element.action_id, "cg_table_row_0_3");
  assert.equal(action.element.url, "https://example.com/42");
  assert.deepEqual(action.fallback, { type: "raw_text", text: "Open" });
  const [done, styled, plainObject, none] = table.rows[2];
  assert.deepEqual(done.elements[0].elements, [{ type: "text", text: "Done", style: { strike: true } }]);
  assert.deepEqual(styled.elements[0].elements, [
    { type: "text", text: "urgent", style: { bold: true } },
    { type: "text", text: " " },
    { type: "text", text: "p1", style: { code: true } },
    { type: "text", text: " " },
    { type: "text", text: "p2", style: { strike: true } },
  ]);
  assert.deepEqual(plainObject.elements[0].elements, [{ type: "text", text: "n/a" }]);
  assert.deepEqual(none, { type: "raw_text", text: "none" });
  // Every row button carries a distinct action_id (Slack refuses duplicates in one block).
  const ids = table.rows.flat().filter((cell) => cell.type === "action_cell").map((cell) => cell.element.action_id);
  assert.equal(new Set(ids).size, ids.length);
});

test("rich cells are validated before the API call", () => {
  assert.throws(() => buildTableMessage({ caption: "x", headers: ["A"], rows: [[{ url: "ftp://nope" }]] }), /absolute http\(s\) URL/);
  assert.throws(() => buildTableMessage({ caption: "x", headers: ["A"], rows: [[{ button: { label: "Open" } }]] }), /button\.url.*required/);
  assert.throws(() => buildTableMessage({ caption: "x", headers: ["A"], rows: [[{ button: { label: "", url: "https://a.b" } }]] }), /button\.label.*required/);
  assert.throws(() => buildTableMessage({ caption: "x", headers: ["A"], rows: [[{ user: "nobody" }]] }), /Slack user id/);
  assert.throws(() => buildTableMessage({ caption: "x", headers: ["A"], rows: [[{}]] }), /needs `text`, `url`, `user` or `button`/);
  assert.throws(() => buildTableMessage({ caption: "x", headers: ["A"], rows: [[null]] }), /text, a finite number, or a cell object/);
  // Rich text counts its readable characters against the 20,000 cap, not the markup.
  const message = buildTableMessage({ caption: "x", headers: ["A"], rows: [[`[${"y".repeat(19_990)}](https://example.com)`]] });
  assert.equal(message.blocks[0].rows[1][0].type, "rich_text");
});

test("postTable posts only to the trusted channel and thread with bot auth", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, channel: "C123", ts: "123.456" }) };
  };

  const result = await postTable({
    channelId: "C123",
    threadTs: "111.222",
    caption: "Suppliers",
    headers: ["ID", "Name"],
    rows: [[2, "HansGrohe"]],
  }, { token: "xoxb-test", fetchImpl });

  assert.deepEqual(result, { channel: "C123", ts: "123.456" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal(calls[0].options.headers.Authorization, "Bearer xoxb-test");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.channel, "C123");
  assert.equal(body.thread_ts, "111.222");
  assert.equal(body.blocks[0].type, "data_table");
  assert.equal("channel" in body.blocks[0], false);
});

test("postTable reports missing context and Slack API errors", async () => {
  await assert.rejects(() => postTable({ caption: "No channel", headers: ["A"], rows: [["x"]] }, { token: "xoxb-test" }), /No channel context/);
  await assert.rejects(
    () => postTable({ channelId: "C123", caption: "Suppliers", headers: ["A"], rows: [["x"]] }, {
      token: "xoxb-test",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "invalid_blocks" }) }),
    }),
    /invalid_blocks/,
  );
});

test("gateway-usage skill routes tables to streamed, native, export, or editable shapes", () => {
  const skill = readFileSync(new URL("../src/gateway/gateway-usage/SKILL.md", import.meta.url), "utf8");
  const tables = readFileSync(new URL("../src/gateway/gateway-usage/references/tables.md", import.meta.url), "utf8");
  const replies = readFileSync(new URL("../src/gateway/gateway-usage/platforms/slack/writing-replies.md", import.meta.url), "utf8");

  assert.match(skill, /description:[\s\S]*inline Markdown table[\s\S]*sortable\/filterable data[\s\S]*chart, graph, data visualization/i);
  assert.match(skill, /small explanatory table[\s\S]*GFM pipe table/i);
  assert.match(skill, /sortable\/filterable read-only dataset[\s\S]*slack_post_table/i);
  assert.match(tables, /native streaming with `markdown_text`[\s\S]*GFM pipe tables/i);
  assert.match(tables, /Do not call a tool for this case/);
  assert.match(tables, /pagination, sorting, and filtering/);
  assert.match(tables, /200 rows \/ 20 columns \/ 20,000[\s\S]*slack_post_table/);
  assert.match(tables, /Larger or wider read-only export[\s\S]*slack_upload_snippet/);
  assert.match(tables, /People will edit it over time[\s\S]*Slack List/);
  assert.match(replies, /native streaming API as `markdown_text`/);
  assert.match(replies, /Wide pipe tables or hand-aligned fenced-code tables/);
});
