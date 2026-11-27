import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { startProgress } = await import("../src/slack/app.js");

// A minimal fake Slack client that records every call the streaming progress path makes, so a test
// can inspect what was appended to the live stream and what was posted as follow-up messages.
function makeClient() {
  const calls = [];
  const streamer = {
    ts: "1720000000.000100",
    append: async (payload) => calls.push(["append", payload]),
    stop: async (payload) => calls.push(["stopStream", payload]),
  };
  const client = {
    apiCall: async () => {},
    chatStream: (payload) => {
      calls.push(["chatStream", payload]);
      return streamer;
    },
    chat: {
      postMessage: async (payload) => calls.push(["postMessage", payload]),
      update: async () => {},
    },
  };
  return { client, calls };
}

test("channel-thread streamed reply @-mentions the requester at the very end", async () => {
  const { client, calls } = makeClient();
  const progress = startProgress("stream", client, "C1", "111.000", { isDM: false, replyMentions: true, authorId: "U777", teamId: "T1", dir: null });
  progress.onDelta("Here is the answer.");
  await progress.finalize({ content: "Here is the answer.", durationMs: 5, usage: { input_tokens: 3, output_tokens: 1 } });

  const appended = calls.filter((c) => c[0] === "append").map((c) => c[1].markdown_text).join("");
  assert.ok(appended.includes("<@U777>"), "the streamed reply should end with a mention of the requester");
  // The mention is the last thing streamed, not spliced into the middle of the answer.
  assert.ok(/here is the answer\./i.test(appended.replace(/<@U777>/, "").trim() || "Here is the answer."), "answer body stays intact");
});

test("DM reply does not @-mention the peer (already notified)", async () => {
  const { client, calls } = makeClient();
  const progress = startProgress("stream", client, "D1", "111.000", { isDM: true, replyMentions: true, authorId: "U777", teamId: "T1", dir: null });
  progress.onDelta("Answer.");
  await progress.finalize({ content: "Answer.", durationMs: 5, usage: {} });

  assert.ok(!JSON.stringify(calls).includes("<@U777>"), "a DM reply must never tag the sole other participant");
});

test("tool-only reply (nothing streamed) carries the requester tag in the finalized message", async () => {
  const { client, calls } = makeClient();
  const progress = startProgress("stream", client, "C1", "111.000", { isDM: false, replyMentions: true, authorId: "U9", teamId: "T1", dir: null });
  // No onDelta → rawLen === 0 → the answer is sent as the stop() markdown_text.
  await progress.finalize({ content: "Short tool-only answer.", durationMs: 5, usage: {} });

  const stop = calls.find((c) => c[0] === "stopStream");
  assert.ok(stop, "stream should be finalized");
  assert.ok(String(stop[1].markdown_text || "").includes("<@U9>"), "the finalized one-shot message should tag the requester");
});

test("long answer tags the OVERFLOW follow-up, not the truncated first message", async () => {
  const { client, calls } = makeClient();
  const progress = startProgress("stream", client, "C1", "111.000", { isDM: false, replyMentions: true, authorId: "U5", teamId: "T1", dir: null });
  // No onDelta + content well over one Slack message → oneShot + overflow follow-up.
  const long = "line\n".repeat(4000);
  await progress.finalize({ content: long, durationMs: 5, usage: {} });

  const posts = calls.filter((c) => c[0] === "postMessage");
  assert.ok(posts.length > 0, "the overflow should be posted as follow-up message(s)");
  // The last CONTENT message carries the tag; only the stats + menu trailer may follow it.
  const answerPosts = posts.filter((c) => String(c[1].text || "").includes("line"));
  const lastPost = String(answerPosts.at(-1)[1].text || "");
  assert.ok(lastPost.includes("<@U5>"), "the last (overflow) message should tag the requester");
  assert.ok(posts.at(-1)[1].blocks?.some((block) => block.type === "actions"), "the reply ends with the menu");

  const stop = calls.find((c) => c[0] === "stopStream");
  assert.ok(!String(stop?.[1]?.markdown_text || "").includes("<@U5>"), "the truncated first message must not also carry the tag");
});

test("an author-less post (no user id) never yields a broken mention", async () => {
  const { client, calls } = makeClient();
  const progress = startProgress("stream", client, "C1", "111.000", { isDM: false, replyMentions: true, authorId: "", teamId: "T1", dir: null });
  progress.onDelta("Answer.");
  await progress.finalize({ content: "Answer.", durationMs: 5, usage: {} });

  assert.ok(!JSON.stringify(calls).includes("<@>"), "must never emit an empty <@> mention");
});

for (const enabled of [false, true]) {
  for (const delivery of ["stream", "one-shot", "overflow", "fallback"]) {
    test(`reply mention ${enabled ? "on" : "off"} is respected by ${delivery} delivery`, async () => {
      const { client, calls } = makeClient();
      if (delivery === "fallback") client.chatStream = () => { throw new Error("stream unavailable"); };
      const progress = startProgress("stream", client, "C_PREF", "111.001", {
        isDM: false, authorId: "U_PREF", replyMentions: enabled, teamId: "T1", dir: null,
      });
      const answer = delivery === "overflow" ? "line\n".repeat(4000) : "Preference answer.";
      if (delivery === "stream" || delivery === "fallback") progress.onDelta(answer);
      await progress.finalize({ content: answer, durationMs: 5, usage: {} });
      const delivered = calls.filter(([kind]) => ["append", "stopStream", "postMessage"].includes(kind))
        .map(([, payload]) => payload?.markdown_text || payload?.text || "").join("");
      assert.ok(delivered.includes(delivery === "overflow" ? "line" : "Preference answer."));
      assert.equal(delivered.split("<@U_PREF>").length - 1, enabled ? 1 : 0);
    });
  }
}

test("default reply omits the automatic tag and keeps explicit requested mentions", async () => {
  const { client, calls } = makeClient();
  const progress = startProgress("stream", client, "C_PREF", "111.002", {
    isDM: false, authorId: "U_DEFAULT", teamId: "T1",
    dir: { map: new Map([["jane doe", "U_JANE"]]), maxWords: 2 },
  });
  progress.onDelta("Please ask @Jane Doe for the update.");
  await progress.finalize({ content: "Please ask @Jane Doe for the update.", durationMs: 5, usage: {} });
  const delivered = calls.filter(([kind]) => kind === "append" || kind === "stopStream")
    .map(([, payload]) => payload?.markdown_text || "").join("");
  assert.ok(!delivered.includes("<@U_DEFAULT>"));
  assert.ok(delivered.includes("<@U_JANE>"));
});
