import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { setUser } = await import("../src/config/store.js");
const { dispatchIncomingMessage, handledMessage } = await import("../src/gateway/message-flow.ts");
const { createIngest } = await import("../src/platforms/ingest.js");

for (const platform of ["googlechat", "msteams"]) {
  const rawConversationId = platform === "googlechat" ? "spaces/FLOW" : "19:flow@thread.tacv2";
  const conversationId = platform === "googlechat" ? `gchat:${rawConversationId}` : `teams:${rawConversationId}`;
  const threadKey = platform === "googlechat" ? `${rawConversationId}/threads/flow` : "1000";
  const message = { platform, rawConversationId, conversationId, threadKey, isDM: false, kind: "channel",
    conversationName: `Flow ${platform}`, userId: `member-${platform}`, mentionsBot: true, trigger: "message" };

  test(`${platform} denies an unknown author before reserving a reply mapping or reading an attachment`, async () => {
    const replies: string[] = [];
    const effects: string[] = [];
    const connector = { platform, post: async ({ text }: { text: string }) => { replies.push(text); } };
    const options = { connector, run: async () => { effects.push("run"); }, log: console };
    const ingest = createIngest(options);
    const request = { ...message, userId: `unknown-${platform}`, messageId: "denied", text: "inspect file",
      attachments: [{ name: "fixture.txt", download: async () => { effects.push("download"); return Buffer.from("fixture"); } }] };

    assert.deepEqual(await ingest(request), { skipped: "unauthorized" });
    assert.deepEqual(effects, []);
    assert.equal(replies.length, 1);
    const mapped = getDb().prepare("SELECT thread_key FROM conversation_reply_sessions WHERE conversation_id = ? AND message_id = ?")
      .get(conversationId, request.messageId);
    assert.equal(mapped, undefined);
  });

  test(`${platform} holds the lane through answer delivery and then prepares the next turn's attachments`, { timeout: 10_000 }, async () => {
    await setUser(message.userId, { approved: true });
    const wire = new EventEmitter();
    const deliveryStarted = once(wire, "delivering");
    const finishDelivery = once(wire, "release");
    const queued = once(wire, "queued");
    const order: string[] = [];
    let nextId = 0;
    const connector = {
      platform,
      async post({ text }: { text: string }) {
        if (text.includes("Queued in this session")) wire.emit("queued");
        return { conversationId: rawConversationId, messageId: `reply-${++nextId}`, threadKey };
      },
      async edit({ text }: { text: string }) {
        if (text.includes("FIRST_ANSWER")) {
          wire.emit("delivering");
          await finishDelivery;
          order.push("first answer delivered");
        }
        if (text.includes("SECOND_ANSWER")) order.push("second answer delivered");
      },
    };
    const options = { connector, log: console, async run({ text, attachments }: { text: string; attachments: string[] }) {
      if (text === "first") return { engine: "claude", content: "FIRST_ANSWER" };
      assert.equal(text, "second");
      assert.equal(attachments.length, 1);
      assert.equal(await readFile(attachments[0], "utf8"), "second attachment");
      order.push("second run");
      return { engine: "codex", content: "SECOND_ANSWER" };
    } };
    const ingest = createIngest(options);
    const first = ingest({ ...message, messageId: "initial", text: "first", attachments: [] });
    await deliveryStarted;
    const second = ingest({ ...message, messageId: "later", text: "second", attachments: [{
      name: "attachment.txt", contentType: "text/plain",
      download: async () => { order.push("download"); return Buffer.from("second attachment"); },
    }] });
    try {
      await queued;
      assert.deepEqual(order, []);
    } finally {
      wire.emit("release");
    }
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first answer delivered", "download", "second run", "second answer delivered"]);
  });
}

const scope = { slug: "flow", threadKey: "thread", actorId: "flow-user", isDM: false, meta: { allowedUsers: ["flow-user"] } };

test("a handled preparation returns its value and releases only a queue that it actually acquired", async () => {
  for (const stage of ["before queue", "inside queue"]) {
    const order: string[] = [];
    const result = await dispatchIncomingMessage({
      ...scope, denied: (reason) => assert.fail(reason),
      admitted: (_identity, processTurn) => processTurn({
        prepareForQueue: () => stage === "before queue" ? handledMessage("answered") : "file",
        withQueue: async (file, start) => {
          assert.equal(file, "file");
          order.push("acquire");
          try { return await start(undefined); } finally { order.push("release"); }
        },
        prepareForRun: () => handledMessage("answered"),
        run: () => assert.fail("the adapter already answered"),
        deliver: () => assert.fail("second answer"),
      }),
    });
    assert.equal(result, "answered");
    assert.deepEqual(order, stage === "before queue" ? [] : ["acquire", "release"]);
  }
});

test("a final delivery error propagates to the queue owner without generating an engine-error answer", async () => {
  const deliveryError = new Error("wire unavailable");
  const order: string[] = [];
  await assert.rejects(dispatchIncomingMessage({
    ...scope, denied: (reason) => assert.fail(reason),
    admitted: (_identity, processTurn) => processTurn({
      withQueue: async (_before, start) => {
        try { return await start(undefined); } finally { order.push("release"); }
      },
      run: () => { order.push("run"); return "answer"; },
      deliver: (answer) => { order.push(answer); throw deliveryError; },
      onRunError: () => assert.fail("delivery was reported as an engine failure"),
    }),
  }), error => error === deliveryError);
  assert.deepEqual(order, ["run", "answer", "release"]);
});
