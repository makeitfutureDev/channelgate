// The unified unattended delivery path (the 2026-08 restructure notes (internal repo) Phase 1): sanitize → mentions →
// chunked post, with the stats footer variant used by API runs and the reply menu on every answer.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

const { deliverResult, postNoticeWithMenu } = await import("../src/slack/deliver.js");

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

test("deliverResult permits only a caller-supplied trusted notification prefix", async () => {
  const client = fakeClient();
  await deliverResult(client, { channel: "C1", result: { content: "model says <!channel>" }, dir: null, trustedPrefix: "<!channel> " });
  assert.match(client.posts[0].text, /^<!channel> /);
  assert.doesNotMatch(client.posts[0].text.slice("<!channel> ".length), /<!channel>/);
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

const menuLabels = (post) => (post.blocks || []).filter((block) => block.type === "actions").flatMap((block) => block.elements.map((button) => button.text.text));

test("deliverResult with footer ends the answer with the run stats and the unbound menu", async () => {
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
  assert.equal(client.posts.length, 1, "a short answer carries its footer and menu in the same message");
  const [post] = client.posts;
  assert.match(post.blocks[0].text.text, /done/);
  assert.match(JSON.stringify(post.blocks), /1\.2s/);
  assert.deepEqual(menuLabels(post), ["📂 Files", "🔑 Variables", "⚙️ Settings"]);
  assert.doesNotMatch(JSON.stringify(post.blocks), /resume_cmd_modal/);
  // An unattended post has no Slack requester, so the menu opens for whoever clicks it.
  for (const button of post.blocks.at(-1).elements) assert.equal(JSON.parse(button.value).u, "");
});

test("deliverResult without footer still ends the answer with the menu", async () => {
  const client = fakeClient();
  await deliverResult(client, { channel: "C1", threadKey: "1.2", result: { content: "scheduled answer" }, dir: null });
  assert.equal(client.posts.length, 1);
  assert.deepEqual(client.posts[0].blocks.map((block) => block.type), ["section", "actions"]);
  assert.deepEqual(menuLabels(client.posts[0]), ["📂 Files", "🔑 Variables", "⚙️ Settings"]);
});

test("deliverResult puts the menu after the LAST chunk of a long answer", async () => {
  const client = fakeClient();
  await deliverResult(client, { channel: "C1", threadKey: "1.2", result: { content: "line\n".repeat(10_000) }, dir: null });
  const withMenu = client.posts.map((post, index) => menuLabels(post).length ? index : -1).filter((index) => index >= 0);
  assert.deepEqual(withMenu, [client.posts.length - 1], "exactly one menu, on the final message");
});

for (const platform of ["googlechat", "msteams"]) {
  for (const engine of ["claude", "codex"]) {
    test(`${platform} delivers a ${engine} automation result through its formatter without a Slack client`, async () => {
      const posts = [];
      const connector = { platform, post: async (payload) => { posts.push(payload); }, directory: async () => null };
      await deliverResult(connector, { channel: "fixture", threadKey: "fixture-thread", result: { content: "# Output\n\n" + "A result line.\n".repeat(5000), engine } });
      assert.ok(posts.length > 1);
      assert.equal(posts[0].conversationId, "fixture");
      assert.equal(posts[0].threadKey, "fixture-thread");
      assert.match(posts[0].text, /Output/);
    });
  }
}

test("postNoticeWithMenu ends an error or stop notice with the requester-bound menu", async () => {
  const client = fakeClient();
  await postNoticeWithMenu(client, { channel: "C1", threadKey: "1.2", text: "⚠️ The run failed.", authorId: "U1" });
  assert.equal(client.posts.length, 1);
  const [post] = client.posts;
  assert.equal(post.text, "⚠️ The run failed.");
  assert.equal(post.thread_ts, "1.2");
  assert.deepEqual(post.blocks.map((block) => block.type), ["section", "actions"]);
  assert.deepEqual(menuLabels(post), ["📂 Files", "🔑 Variables", "⚙️ Settings"]);
  for (const button of post.blocks[1].elements) assert.equal(JSON.parse(button.value).u, "U1");
});

test("postNoticeWithMenu never truncates a long notice: text first, menu below", async () => {
  const client = fakeClient();
  const text = `⚠️ ${"detail ".repeat(600)}`;
  await postNoticeWithMenu(client, { channel: "C1", threadKey: "1.2", text });
  assert.equal(client.posts.length, 2);
  assert.equal(client.posts[0].text, text);
  assert.equal(client.posts[0].blocks, undefined);
  assert.deepEqual(menuLabels(client.posts[1]), ["📂 Files", "🔑 Variables", "⚙️ Settings"]);
});

test("postNoticeWithMenu keeps the notice when Slack rejects the menu blocks", async () => {
  const posts = [];
  const client = { chat: { postMessage: async (args) => {
    posts.push(args);
    if (args.blocks) throw Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } });
    return { ok: true, ts: "1.0" };
  } } };
  await postNoticeWithMenu(client, { channel: "C1", threadKey: "1.2", text: "🛑 Stopped." });
  assert.deepEqual(posts.at(-1), { channel: "C1", thread_ts: "1.2", text: "🛑 Stopped." });
});

for (const platform of ["googlechat", "msteams"]) {
  test(`postNoticeWithMenu on ${platform} delivers the plain notice and no Slack menu`, async () => {
    const posts = [];
    const connector = { platform, capabilities: { richCards: "none" }, post: async (payload) => { posts.push(payload); return {}; } };
    await postNoticeWithMenu(connector, { channel: "fixture", threadKey: "t", text: "x".repeat(4000) });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].blocks, undefined);
  });
}
