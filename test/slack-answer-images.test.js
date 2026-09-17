import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { answerImageBlocks, MAX_ANSWER_IMAGE_BLOCKS } = await import("../src/slack/images.js");
const { deliverResult } = await import("../src/slack/deliver.js");
const { startProgress } = await import("../src/slack/progress.js");
const { postChunkedReply } = await import("../src/slack/util.js");

test("Markdown images become bounded, deduplicated Slack image blocks outside code fences", () => {
  const markdown = [
    "![**Revenue** by region](https://img.example/chart_(final).png \"Q3 revenue\")",
    "![duplicate](https://img.example/chart_(final).png)",
    "![No title](http://img.example/no-title.gif)",
    "![local](./chart.png)",
    "![data](data:image/png;base64,AAAA)",
    "```md",
    "![example only](https://img.example/code.png)",
    "```",
    ...Array.from({ length: 10 }, (_, index) => `![extra ${index}](https://img.example/${index}.jpg)`),
  ].join("\n");

  const blocks = answerImageBlocks(markdown);

  assert.equal(blocks.length, MAX_ANSWER_IMAGE_BLOCKS);
  assert.deepEqual(blocks[0], {
    type: "image",
    image_url: "https://img.example/chart_(final).png",
    alt_text: "Revenue by region",
    title: { type: "plain_text", text: "Q3 revenue", emoji: true },
  });
  assert.equal(blocks[1].image_url, "http://img.example/no-title.gif");
  assert.equal(blocks[1].alt_text, "No title");
  assert.equal(blocks.some((block) => /code|data|chart\.png$/.test(block.image_url)), false);
  assert.equal(new Set(blocks.map((block) => block.image_url)).size, blocks.length);
});

test("classic Slack delivery keeps the answer and image preview in one Block Kit message", async () => {
  const posts = [];
  const client = { chat: { postMessage: async (payload) => posts.push(payload) } };
  const blocks = answerImageBlocks("![Architecture](https://img.example/architecture.png)");

  await postChunkedReply(client, "C1", "111.222", "Architecture: <https://img.example/architecture.png|open image>", "", null, {
    answerBlocks: blocks,
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, "Architecture: <https://img.example/architecture.png|open image>");
  assert.deepEqual(posts[0].blocks.map((block) => block.type), ["section", "image"]);
  assert.equal(posts[0].blocks[1].image_url, "https://img.example/architecture.png");
});

test("unattended Slack delivery promotes the model's Markdown image into the answer blocks", async () => {
  const posts = [];
  const client = { chat: { postMessage: async (payload) => posts.push(payload) } };

  await deliverResult(client, {
    channel: "C1",
    threadKey: "111.222",
    dir: null,
    result: { content: "Report\n\n![Trend](https://img.example/trend.png)" },
  });

  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].blocks.map((block) => block.type), ["section", "image"]);
  assert.equal(posts[0].blocks[1].image_url, "https://img.example/trend.png");
  assert.match(posts[0].text, /https:\/\/img\.example\/trend\.png/);
});

test("an image preview does not displace an unattended run footer with no resume control", async () => {
  const posts = [];
  const client = { chat: { postMessage: async (payload) => posts.push(payload) } };

  await deliverResult(client, {
    channel: "C1",
    threadKey: "111.222",
    dir: null,
    footer: true,
    result: {
      content: "![Trend](https://img.example/trend.png)",
      usage: { input_tokens: 3, output_tokens: 2 },
    },
  });

  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].blocks.map((block) => block.type), ["section", "image", "context"]);
  assert.match(posts[0].blocks[2].elements[0].text, /3\/2/);
});

test("invalid classic preview blocks never cost the completed text answer", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        if (payload.blocks) throw Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } });
      },
    },
  };

  await postChunkedReply(client, "C1", "111.222", "Completed answer", "", null, {
    answerBlocks: answerImageBlocks("![Preview](https://img.example/preview.png)"),
  });

  assert.equal(posts.length, 2);
  assert.ok(posts[0].blocks);
  assert.deepEqual(posts[1], { channel: "C1", thread_ts: "111.222", text: "Completed answer" });
});

test("native answer finalization appends image blocks before the run footer", async () => {
  const stops = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async () => {},
    stop: async (payload) => stops.push(payload),
  };
  const client = {
    apiCall: async () => {},
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, delete: async () => {} },
  };
  const markdown = "Result\n\n![Rendered chart](https://img.example/chart.png)";
  const progress = startProgress("stream", client, "C1", "111.222");

  progress.onDelta(markdown);
  await progress.finalize({ content: markdown, usage: { input_tokens: 1, output_tokens: 1 } });

  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0].blocks.map((block) => block.type), ["image", "context"]);
  assert.equal(stops[0].blocks[0].image_url, "https://img.example/chart.png");
});

test("a rejected native image preview retries with the healthy footer", async () => {
  const stops = [];
  let attempts = 0;
  const streamer = {
    ts: "1720000000.000100",
    append: async () => {},
    stop: async (payload) => {
      attempts += 1;
      stops.push(payload);
      if (attempts === 1) throw Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } });
    },
  };
  const posts = [];
  const client = {
    apiCall: async () => {},
    chatStream: () => streamer,
    chat: { postMessage: async (payload) => posts.push(payload), delete: async () => {} },
  };
  const markdown = "![Preview](https://img.example/preview.png)";
  const progress = startProgress("stream", client, "C1", "111.222");

  progress.onDelta(markdown);
  await progress.finalize({ content: markdown, usage: { input_tokens: 1, output_tokens: 1 } });

  assert.equal(stops.length, 2);
  assert.deepEqual(stops[0].blocks.map((block) => block.type), ["image", "context"]);
  assert.deepEqual(stops[1].blocks.map((block) => block.type), ["context"]);
  assert.equal(stops[1].markdown_text, undefined, "the SDK's retained terminal Markdown is not duplicated");
  assert.equal(posts.length, 0, "a rejected preview does not force a duplicate classic answer");
});

test("the injected Slack guide documents the image-preview contract", async () => {
  const [platform, writing] = await Promise.all([
    readFile(new URL("../src/gateway/gateway-usage/platforms/slack/platform.md", import.meta.url), "utf8"),
    readFile(new URL("../src/gateway/gateway-usage/platforms/slack/writing-replies.md", import.meta.url), "utf8"),
  ]);
  assert.match(platform, /Block Kit image previews/i);
  assert.match(writing, /!\[descriptive alt text\]\(https:\/\//);
  assert.match(writing, /up to five/i);
});
