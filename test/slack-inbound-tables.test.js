import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  appendSlackTables,
  extractSlackTables,
  flattenSlackRichText,
  formatSlackTables,
} = await import("../src/slack/block-content.js");
const { shapeMessages } = await import("../src/slack/read.js");
const { fetchThreadContext } = await import("../src/slack/app.js");

function rich(...elements) {
  return { type: "rich_text", elements: [{ type: "rich_text_section", elements }] };
}

test("extractSlackTables reads data_table and table blocks from blocks and attachments", () => {
  const message = {
    blocks: [
      { type: "rich_text", elements: [] },
      {
        type: "data_table",
        caption: "Supplier prices",
        rows: [
          [{ type: "raw_text", text: "Supplier" }, { type: "raw_text", text: "Price" }],
          [rich({ type: "link", text: "Acme", url: "https://example.com/acme" }), { type: "raw_number", value: 42.5, text: "42.50" }],
        ],
      },
    ],
    attachments: [{
      color: "#ddd",
      blocks: [{
        type: "table",
        rows: [
          [{ type: "raw_text", text: "Owner" }, { type: "raw_text", text: "State" }],
          [rich({ type: "user", user_id: "U123" }), rich({ type: "emoji", name: "white_check_mark" })],
        ],
      }],
    }],
  };

  assert.deepEqual(extractSlackTables(message), [
    {
      type: "data_table",
      caption: "Supplier prices",
      rows: [["Supplier", "Price"], ["Acme (https://example.com/acme)", 42.5]],
    },
    {
      type: "table",
      rows: [["Owner", "State"], ["<@U123>", ":white_check_mark:"]],
    },
  ]);
});

test("extractSlackTables handles direct attachment blocks, malformed rows, and documented limits", () => {
  const shared = {
    type: "table",
    rows: [
      ...Array.from({ length: 101 }, (_, row) => Array.from({ length: 21 }, (_, column) => ({ type: "raw_text", text: `${row}:${column}` }))),
      "not a row",
    ],
  };
  const message = {
    blocks: [shared, shared], // the same object is visited once even if Slack repeats the reference
    attachments: [{
      type: "table",
      rows: ["not a row", [{ type: "future_cell", value: "kept" }, { type: "raw_number", value: "7", text: "seven" }]],
    }],
    root: { blocks: [{ type: "table", rows: [[{ type: "raw_text", text: "must not leak" }]] }] },
  };

  const tables = extractSlackTables(message);
  assert.equal(tables.length, 2);
  assert.equal(tables[0].rows.length, 101);
  assert.equal(tables[0].rows[0].length, 20);
  assert.equal(tables[0].omittedRows, 1);
  assert.equal(tables[0].omittedCellsBeyondColumnLimit, 101);
  assert.deepEqual(tables[1].rows, [["kept", "seven"]]);
  assert.equal(tables[1].skippedMalformedRows, 1);
  assert.doesNotMatch(JSON.stringify(tables), /must not leak/);
});

test("rich Slack cells retain readable lists, links, channels, and broadcasts", () => {
  const value = {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_list",
        style: "ordered",
        elements: [
          { type: "rich_text_section", elements: [{ type: "text", text: "Open " }, { type: "channel", channel_id: "C1" }] },
          { type: "rich_text_section", elements: [{ type: "link", url: "https://example.com" }, { type: "text", text: " for " }, { type: "broadcast", range: "channel" }] },
        ],
      },
    ],
  };

  assert.equal(flattenSlackRichText(value), "1. Open <#C1>\n2. https://example.com for @channel");
});

test("formatSlackTables appends exact structured rows to mixed message text", () => {
  const message = {
    blocks: [{ type: "data_table", caption: "Pipe-safe", rows: [[{ type: "raw_text", text: "A|B" }], [{ type: "raw_text", text: "line 1\nline 2" }]] }],
  };
  const tables = extractSlackTables(message);
  const rendered = formatSlackTables(tables);
  assert.match(rendered, /Native Slack table included/);
  assert.match(rendered, /"A\|B"/);
  assert.match(rendered, /line 1\\nline 2/);
  assert.equal(appendSlackTables("Please summarize", message), `Please summarize\n\n${rendered}`);
});

test("current-channel history shaping includes native table rows", () => {
  const [row] = shapeMessages([{
    ts: "100.1",
    user: "U1",
    text: "Previous result",
    blocks: [{ type: "table", rows: [[{ type: "raw_text", text: "Name" }], [{ type: "raw_text", text: "Luna" }]] }],
  }], (id) => (id === "U1" ? "Alex" : id));

  assert.equal(row.name, "Alex");
  assert.match(row.text, /^Previous result/);
  assert.match(row.text, /Native Slack table included/);
  assert.match(row.text, /Luna/);
});

test("fresh-session thread replay includes a prior table-only message", async () => {
  const client = {
    conversations: {
      replies: async () => ({
        messages: [{
          ts: "100.1",
          user: "U1",
          text: "",
          blocks: [{ type: "data_table", caption: "Quarter", rows: [[{ type: "raw_text", text: "Revenue" }], [{ type: "raw_number", value: 900, text: "900" }]] }],
        }],
        response_metadata: { next_cursor: "" },
      }),
    },
    users: { info: async ({ user }) => ({ user: { profile: { display_name: user === "U1" ? "Alex" : "Gateway" } } }) },
  };

  const context = await fetchThreadContext(client, {
    channelId: "C1",
    threadTs: "100.1",
    currentTs: "200.1",
    botUserId: "B1",
  });
  assert.match(context, /Alex:.*Native Slack table included.*Quarter.*Revenue.*900/);
});

test("live Slack processing treats tables as content and appends them to the run prompt", () => {
  const source = readFileSync(new URL("../src/slack/message-pipeline.js", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");
  assert.match(source, /files\.length === 0 && slackTables\.length === 0/);
  assert.match(source, /formatSlackTables\(slackTables\)/);
  // The 🤖-reaction synthetic event (app.js wiring) must forward blocks + attachments so tables survive.
  assert.match(appSource, /blocks: msg\.blocks,[\s\S]*attachments: msg\.attachments/);
});
