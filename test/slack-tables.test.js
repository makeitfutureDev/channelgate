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
    () => buildTableMessage({ caption: "Too large", headers: ["A"], rows: [["x".repeat(10_001)]] }),
    /10,000-character limit/,
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
  assert.match(tables, /100 rows \/ 20 columns \/ 10,000[\s\S]*slack_post_table/);
  assert.match(tables, /Larger or wider read-only export[\s\S]*slack_upload_snippet/);
  assert.match(tables, /People will edit it over time[\s\S]*Slack List/);
  assert.match(replies, /native streaming API as `markdown_text`/);
  assert.match(replies, /Wide pipe tables or hand-aligned fenced-code tables/);
});
