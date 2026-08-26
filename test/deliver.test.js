// The unified unattended delivery path (the 2026-08 restructure notes (internal repo) Phase 1): sanitize → mentions →
// chunked post, with the footer + resume button variant used by API runs.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

const { deliverResult } = await import("../src/slack/deliver.js");

function fakeClient() {
  const posts = [];
  return { posts, chat: { postMessage: async (args) => { posts.push(args); return { ok: true, ts: "1.0" }; } } };
}

test("deliverResult posts the converted reply into the thread", async () => {
  const client = fakeClient();
  await deliverResult(client, { channel: "C1", threadKey: "11.22", result: { content: "**bold** answer" }, dir: null });
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].channel, "C1");
  assert.equal(client.posts[0].thread_ts, "11.22");
  assert.match(client.posts[0].text, /\*bold\* answer/);
});

test("deliverResult escapes model-authored Slack control sequences (injection guard)", async () => {
  const client = fakeClient();
  await deliverResult(client, { channel: "C1", threadKey: "1.2", result: { content: "ping <!channel> now" }, dir: null });
  assert.doesNotMatch(client.posts[0].text, /<!channel>/);
});

test("deliverResult falls back to a visible placeholder on an empty result", async () => {
  const client = fakeClient();
  await deliverResult(client, { channel: "C1", threadKey: "1.2", result: { content: "" }, dir: null });
  assert.equal(client.posts[0].text, "_(no output)_");
});

test("deliverResult chunks a long answer instead of truncating it", async () => {
  const client = fakeClient();
  const long = "line\n".repeat(10_000);
  await deliverResult(client, { channel: "C1", threadKey: "1.2", result: { content: long }, dir: null });
  assert.ok(client.posts.length > 1, `expected multiple chunks, got ${client.posts.length}`);
});

test("deliverResult with footer appends the run-stats trailer and resume control", async () => {
  const client = fakeClient();
  const result = {
    content: "done",
    cwd: "/tmp/chan",
    sessionId: "sess-1",
    engine: "claude",
    durationMs: 1234,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  await deliverResult(client, { channel: "C1", threadKey: "1.2", result, dir: null, footer: true });
  const trailer = client.posts.at(-1);
  assert.ok(Array.isArray(trailer.blocks), "footer trailer should carry blocks");
  const json = JSON.stringify(trailer.blocks);
  assert.match(json, /resume_cmd_modal/);
});
