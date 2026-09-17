import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  answerImageBlocks,
  answerImageFiles,
  shareAnswerImageFiles,
  MAX_ANSWER_IMAGE_BLOCKS,
} = await import("../src/slack/images.js");
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

test("local Markdown images resolve inside the workspace and reject escapes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-answer-images-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "cg-answer-images-outside-"));
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await mkdir(path.join(root, "reports"));
  await writeFile(path.join(root, "reports", "chart final.png"), Buffer.from("png"));
  await writeFile(path.join(outside, "private.png"), Buffer.from("private"));
  await symlink(outside, path.join(root, "escape"));

  const markdown = [
    "![Revenue](<reports/chart%20final.png> \"Quarterly revenue\")",
    "![duplicate](./reports/chart%20final.png)",
    "![escape](escape/private.png)",
    "![not an image](reports/data.csv)",
    "```md",
    "![example](reports/chart%20final.png)",
    "```",
  ].join("\n");
  const files = await answerImageFiles(markdown, root);

  assert.equal(files.length, 1);
  assert.equal(files[0].relative, "reports/chart final.png");
  assert.equal(files[0].filename, "chart final.png");
  assert.equal(files[0].title, "Quarterly revenue");
});

test("local answer images are uploaded into the Slack thread as native files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-answer-image-share-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "preview.png");
  await writeFile(imagePath, Buffer.from("png"));
  const uploads = [];

  const shared = await shareAnswerImageFiles({
    markdown: "Done.\n\n![Result](preview.png)",
    cwd: root,
    channel: "C1",
    threadTs: "111.222",
    uploadFile: async (payload) => {
      uploads.push(payload);
      return { fileId: "F1", permalink: "https://slack.test/F1" };
    },
  });

  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0], {
    filePath: imagePath,
    rootPath: root,
    filename: "preview.png",
    title: "Result",
    channelId: "C1",
    threadTs: "111.222",
  });
  assert.equal(shared[0].fileId, "F1");
});

test("a native file upload failure stays cosmetic after answer delivery", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-answer-image-failure-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "preview.png"), Buffer.from("png"));
  const failures = [];

  const shared = await shareAnswerImageFiles({
    markdown: "![Result](preview.png)",
    cwd: root,
    channel: "C1",
    threadTs: "111.222",
    uploadFile: async () => { throw new Error("missing_scope"); },
    onError: (error, file) => failures.push([error.message, file.filename]),
  });

  assert.deepEqual(shared, []);
  assert.deepEqual(failures, [["missing_scope", "preview.png"]]);
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

test("unattended Slack delivery shares a referenced workspace image after its text", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-unattended-image-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "result.png"), Buffer.from("png"));
  const calls = [];
  const client = { chat: { postMessage: async (payload) => calls.push(["post", payload]) } };

  await deliverResult(client, {
    channel: "C1",
    threadKey: "111.222",
    dir: null,
    uploadFile: async (payload) => calls.push(["upload", payload]),
    result: { cwd: root, content: "Report\n\n![Result](result.png)" },
  });

  assert.deepEqual(calls.map(([kind]) => kind), ["post", "upload"]);
  assert.equal(calls[1][1].channelId, "C1");
  assert.equal(calls[1][1].threadTs, "111.222");
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

test("native finalization shares a referenced workspace image exactly once", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-native-image-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "render.png"), Buffer.from("png"));
  const events = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async () => {},
    stop: async () => events.push("stop"),
  };
  const client = {
    apiCall: async () => {},
    chatStream: () => streamer,
    chat: { postMessage: async () => {}, delete: async () => {} },
  };
  const markdown = "Result\n\n![Rendered chart](render.png)";
  const progress = startProgress("stream", client, "C1", "111.222", {
    uploadFile: async (payload) => events.push(["upload", payload]),
  });

  progress.onDelta(markdown);
  await progress.finalize({ cwd: root, content: markdown, usage: { input_tokens: 1, output_tokens: 1 } });

  assert.equal(events[0], "stop");
  assert.equal(events.length, 2);
  assert.equal(events[1][0], "upload");
  assert.equal(events[1][1].filename, "render.png");
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
  assert.match(platform, /native Slack file preview/i);
  assert.match(writing, /!\[descriptive alt text\]\(https:\/\//);
  assert.match(writing, /!\[descriptive alt text\]\(reports\/chart\.png\)/);
  assert.match(writing, /up to five/i);
});
