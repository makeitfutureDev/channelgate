// Composed replies (slack_compose_reply): the block builder, the daemon-side normalizer, the
// engine-stream hooks for Claude and Codex, and the Slack finalize path that appends the blocks
// under the answer text with the tiered invalid_blocks recovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { buildReplyBlocks, normalizeReplyBlocks, isReplyBlocksTool, describeReplyBlocks, MAX_REPLY_BLOCKS } = await import("../src/slack/reply-blocks.js");
const { progressFromCodexEvent } = await import("../src/engines/codex.js");
const { startProgress } = await import("../src/slack/progress.js");

const SECTIONS = [
  { type: "text", markdown: "**Spend** rose 12% in Q3." },
  { type: "chart", chart_type: "bar", title: "Spend by month", series: [{ name: "EUR", data: [{ label: "Jul", value: 10 }, { label: "Aug", value: 12 }] }] },
  { type: "table", caption: "Top vendors", headers: ["Vendor", "EUR", "Invoice"], rows: [["Acme", 1200, { button: { label: "Open", url: "https://example.com/1" } }]] },
  { type: "collapsible", title: "Sources", markdown: "- ledger export\n- [invoices](https://example.com/inv)" },
  { type: "card", title: "Q3 report", subtitle: "PDF · 4 pages", body: "Ready for review.", buttons: [{ label: "Open", url: "https://example.com/q3.pdf" }] },
  { type: "links", buttons: [{ label: "Export CSV", url: "https://example.com/q3.csv" }] },
  { type: "divider" },
];

test("buildReplyBlocks turns ordered sections into Slack Block Kit", () => {
  const blocks = buildReplyBlocks(SECTIONS);
  assert.deepEqual(blocks.map((block) => block.type), ["section", "data_visualization", "data_table", "container", "card", "actions", "divider"]);
  assert.equal(blocks[0].text.text, "*Spend* rose 12% in Q3.");
  assert.equal(blocks[1].chart.type, "bar");
  assert.equal(blocks[2].rows[1][2].type, "action_cell");
  assert.equal(blocks[3].is_collapsible, true);
  assert.equal(blocks[3].default_collapsed, true);
  assert.equal(blocks[3].child_blocks[0].type, "section");
  assert.match(blocks[3].child_blocks[0].text.text, /<https:\/\/example\.com\/inv\|invoices>/);
  assert.equal(blocks[4].title.text, "Q3 report");
  assert.equal(blocks[4].actions[0].url, "https://example.com/q3.pdf");
  assert.equal(blocks[5].elements[0].url, "https://example.com/q3.csv");
  // Every URL button carries a distinct action_id for the ack-only handler.
  const ids = [blocks[4].actions[0].action_id, blocks[5].elements[0].action_id];
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every((id) => id.startsWith("cg_reply_link_")));
  assert.equal(describeReplyBlocks(SECTIONS), "1 text, 1 chart, 1 table, 1 collapsible, 1 card, 1 links, 1 divider");
});

test("buildReplyBlocks refuses what Slack would refuse, with the reason", () => {
  assert.throws(() => buildReplyBlocks([]), /too_small|at least|>=1/i);
  assert.throws(() => buildReplyBlocks([{ type: "chart", chart_type: "pie", title: "x" }]), /segments/);
  assert.throws(() => buildReplyBlocks([{ type: "links", buttons: [{ label: "x", url: "javascript:alert(1)" }] }]), /http/);
  assert.throws(() => buildReplyBlocks([{ type: "table", caption: "x", headers: ["A", "B"], rows: [["only one"]] }]), /exactly 2 cells/);
  assert.throws(() => buildReplyBlocks([{ type: "card", title: "x", buttons: [1, 2, 3, 4].map((n) => ({ label: `b${n}`, url: "https://e.x" })) }]), /3|too_big/i);
  assert.throws(() => buildReplyBlocks(Array.from({ length: 13 }, () => ({ type: "divider" }))), /12|too_big/i);
  assert.ok(MAX_REPLY_BLOCKS <= 50);
});

test("card copy is defanged like any reply text, and two tables never share a row-button id", () => {
  const [card] = buildReplyBlocks([{ type: "card", title: "<!channel> alert", subtitle: "<!here>", body: "<https://evil.example|Official> **ok**" }]);
  assert.doesNotMatch(card.title.text, /<!channel>/);
  assert.doesNotMatch(card.subtitle.text, /<!here>/);
  assert.doesNotMatch(card.body.text, /<https:\/\/evil\.example\|Official>/);
  assert.match(card.body.text, /\*ok\*/);
  const [first, second] = buildReplyBlocks([
    { type: "table", caption: "a", headers: ["X"], rows: [[{ button: { label: "Open", url: "https://e.x/1" } }]] },
    { type: "table", caption: "b", headers: ["X"], rows: [[{ button: { label: "Open", url: "https://e.x/2" } }]] },
  ]);
  const ids = [first.rows[1][0].element.action_id, second.rows[1][0].element.action_id];
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every((id) => id.startsWith("cg_table_row_")));
  assert.throws(() => buildReplyBlocks([{ type: "links", buttons: [{ label: "x", url: "https://a.example/a\nb" }] }]), /http/);
});

test("composed blocks are only offered to, and only rendered for, runs with a live progress writer", async () => {
  const { register } = await import("../src/mcp/tools/slack-native.js");
  const { ctxFromClaims } = await import("../src/mcp/gateway-server.js");
  const { createScopedRunEventHandler } = await import("../src/gateway/run.js");
  const registered = (progressReport) => {
    const names = [];
    register({ registerTool: (name) => names.push(name) }, ctxFromClaims({ channelId: "C1", slug: "s", authorId: "U1", threadKey: "1.1", principalTrusted: true, progressReport }));
    return names;
  };
  assert.ok(registered(true).includes("slack_compose_reply"));
  assert.ok(!registered(false).includes("slack_compose_reply"), "a scheduled/background/clean run has nothing to render the blocks");
  const seen = [];
  createScopedRunEventHandler((event) => seen.push(event.kind), { progressReport: true, clean: true })({ kind: "reply_blocks", blocks: [] });
  createScopedRunEventHandler((event) => seen.push(event.kind), { progressReport: true, clean: false })({ kind: "reply_blocks", blocks: [] });
  assert.deepEqual(seen, ["reply_blocks"]);
});

test("normalizeReplyBlocks accepts JSON strings and objects and drops invalid snapshots silently", () => {
  const event = normalizeReplyBlocks(JSON.stringify({ sections: [{ type: "divider" }, { type: "text", markdown: "hi" }] }));
  assert.equal(event.kind, "reply_blocks");
  assert.deepEqual(event.blocks.map((block) => block.type), ["divider", "section"]);
  assert.equal(event.summary, "1 divider, 1 text");
  assert.equal(normalizeReplyBlocks("{not json"), null);
  assert.equal(normalizeReplyBlocks({ sections: [{ type: "chart", chart_type: "pie", title: "x" }] }), null);
  assert.equal(normalizeReplyBlocks({}), null);
  assert.ok(isReplyBlocksTool("slack_compose_reply"));
  assert.ok(isReplyBlocksTool("mcp__gateway__slack_compose_reply"));
  assert.ok(!isReplyBlocksTool("slack_post_table"));
});

test("a Codex mcp tool call to slack_compose_reply becomes the reply_blocks event and no tool row", () => {
  const started = progressFromCodexEvent({
    type: "item.started",
    item: { type: "mcp_tool_call", id: "call-1", server: "gateway", tool: "slack_compose_reply", arguments: { sections: [{ type: "divider" }] } },
  });
  assert.equal(started?.event?.kind, "reply_blocks");
  assert.deepEqual(started.event.blocks, [{ type: "divider" }]);
  const completed = progressFromCodexEvent({
    type: "item.completed",
    item: { type: "mcp_tool_call", id: "call-1", server: "gateway", tool: "slack_compose_reply", status: "completed" },
  });
  assert.equal(completed, null);
});

test("a Claude stream-json tool_use of slack_compose_reply becomes the reply_blocks event", async () => {
  const { createStreamConsumer } = await import("../src/engines/stream.js");
  const events = [];
  const consumer = createStreamConsumer({ onEvent: (event) => events.push(event) });
  const input = JSON.stringify({ sections: [{ type: "divider" }] });
  for (const line of [
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "mcp__gateway__slack_compose_reply" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
  ]) consumer.consume(line);
  const event = events.find((candidate) => candidate.kind === "reply_blocks");
  assert.ok(event, `expected a reply_blocks event, got ${JSON.stringify(events)}`);
  assert.deepEqual(event.blocks, [{ type: "divider" }]);
  assert.ok(!events.some((candidate) => candidate.kind === "tool_use"), "the staging call is not a tool row");
});

test("finalize appends the composed blocks under the answer and above the footer", async () => {
  const stops = [];
  const streamer = { ts: "1720000000.000100", append: async () => {}, stop: async (payload) => stops.push(payload) };
  const client = { apiCall: async () => {}, chatStream: () => streamer, chat: { postMessage: async () => {}, delete: async () => {} } };
  const progress = startProgress("stream", client, "C1", "111.222", { authorId: "U1", teamId: "T1" });
  progress.onEvent(normalizeReplyBlocks({ sections: [{ type: "divider" }] }));
  progress.onEvent(normalizeReplyBlocks({ sections: [{ type: "text", markdown: "Takeaway" }, { type: "divider" }] })); // latest snapshot wins
  progress.onDelta("Spend rose.");
  await progress.finalize({ content: "Spend rose.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0].blocks.map((block) => block.type), ["section", "divider", "context", "actions", "context_actions"]);
  assert.equal(stops[0].blocks[0].text.text, "Takeaway");
});

test("a rejected composed block set is retried without the composed blocks, then without feedback", async () => {
  const stops = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async () => {},
    stop: async (payload) => {
      stops.push(payload);
      if (stops.length <= 2) throw Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } });
    },
  };
  const posts = [];
  const client = { apiCall: async () => {}, chatStream: () => streamer, chat: { postMessage: async (payload) => posts.push(payload), delete: async () => {} } };
  const progress = startProgress("stream", client, "C1", "111.222", { authorId: "U1", teamId: "T1" });
  progress.onEvent(normalizeReplyBlocks({ sections: [{ type: "divider" }] }));
  progress.onDelta("Answer.");
  await progress.finalize({ content: "Answer.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });
  // One suspect at a time: the composed blocks, then (with them back) the feedback controls.
  assert.deepEqual(stops.map((stop) => stop.blocks.map((block) => block.type)), [
    ["divider", "context", "actions", "context_actions"],
    ["context", "actions", "context_actions"],
    ["divider", "context", "actions"],
  ]);
  assert.equal(stops[1].markdown_text, undefined, "retries never re-append the SDK's retained markdown");
  assert.equal(posts.length, 0, "the streamed answer is never duplicated through the classic fallback");
});

test("the classic fallback carries the composed blocks with the answer", async () => {
  const posts = [];
  const client = {
    apiCall: async () => {},
    chatStream: () => ({ ts: "", append: async () => { throw Object.assign(new Error("not_allowed"), { data: { error: "not_allowed" } }); }, stop: async () => { throw new Error("nope"); } }),
    chat: { postMessage: async (payload) => { posts.push(payload); return { ts: "9.9" }; }, delete: async () => {} },
  };
  const progress = startProgress("stream", client, "C1", "111.222", { authorId: "U1", teamId: "T1" });
  progress.onEvent(normalizeReplyBlocks({ sections: [{ type: "divider" }] }));
  progress.onDelta("Answer.");
  await progress.finalize({ content: "Answer.", durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } });
  const answer = posts.find((post) => post.blocks?.some((block) => block.type === "divider"));
  assert.ok(answer, "the composed blocks ride the fallback answer message");
  assert.deepEqual(answer.blocks.map((block) => block.type), ["section", "divider", "context", "actions", "context_actions"]);
});
