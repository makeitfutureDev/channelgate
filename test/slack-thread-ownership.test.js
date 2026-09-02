import assert from "node:assert/strict";
import test from "node:test";

import * as slackApp from "../src/slack/app.js";

const { fetchThreadContext } = slackApp;
const canEngageThreadByReaction = slackApp.canEngageThreadByReaction;
const ownershipTest = typeof canEngageThreadByReaction === "function" ? test : test.skip;

test("Slack exports the bot-owned reaction-thread ownership check", () => {
  assert.equal(typeof canEngageThreadByReaction, "function");
});

ownershipTest("an existing session remains the no-read fast path", async () => {
  let reads = 0;
  const client = {
    conversations: {
      replies: async () => {
        reads += 1;
        throw new Error("the session fast path must not read Slack");
      },
    },
  };

  assert.equal(
    await canEngageThreadByReaction(client, {
      channelId: "C1",
      threadTs: "100.1",
      botUserId: "UBOT",
      hasSession: true,
    }),
    true,
  );
  assert.equal(reads, 0);
});

ownershipTest("a sessionless thread rooted by this gateway can be engaged", async () => {
  const calls = [];
  const client = {
    conversations: {
      replies: async (args) => {
        calls.push(args);
        return { messages: [{ ts: "100.1", user: "UBOT", text: "Reminder" }] };
      },
    },
  };

  assert.equal(
    await canEngageThreadByReaction(client, {
      channelId: "C1",
      threadTs: "100.1",
      botUserId: "UBOT",
    }),
    true,
  );
  assert.deepEqual(calls, [{ channel: "C1", ts: "100.1", limit: 200 }]);
});

// A daemon-side command (`/model`, `/help`, `/mode`, …) answers in-thread WITHOUT spawning an
// engine, so such a thread has no session and its root is the human who typed the command. A 🤖
// reaction there was refused as "another agent's thread" until the check learned to look past the
// root at whether this bot has actually spoken in the thread.
ownershipTest("a sessionless command-only thread the bot replied in can be engaged", async () => {
  const client = {
    conversations: {
      replies: async () => ({
        messages: [
          { ts: "100.1", user: "UHUMAN", text: "<@UBOT> /model" },
          { ts: "100.2", user: "UBOT", text: "✅ Runtime updated for just this thread" },
          { ts: "100.3", user: "UHUMAN", text: "can you run hermes headless?" },
        ],
      }),
    },
  };

  assert.equal(
    await canEngageThreadByReaction(client, {
      channelId: "C1",
      threadTs: "100.1",
      botUserId: "UBOT",
    }),
    true,
  );
});

ownershipTest("a sessionless thread this bot never spoke in remains protected", async () => {
  const client = {
    conversations: {
      replies: async () => ({
        messages: [
          { ts: "100.1", user: "UOTHER", text: "Another agent's root" },
          { ts: "100.2", user: "UAGENT", bot_id: "B_OTHER", text: "another agent's answer" },
          { ts: "100.3", subtype: "bot_message", bot_id: "B_APP", text: "an app post with no user" },
        ],
      }),
    },
  };

  assert.equal(
    await canEngageThreadByReaction(client, {
      channelId: "C1",
      threadTs: "100.1",
      botUserId: "UBOT",
    }),
    false,
  );
});

ownershipTest("the ownership scan follows pagination but stays bounded", async () => {
  const page = (n) => Array.from({ length: 3 }, (_, i) => ({ ts: `${n}.${i}`, user: "UHUMAN" }));
  const clientFor = (pages) => {
    const calls = [];
    return {
      calls,
      conversations: {
        replies: async (args) => {
          calls.push(args);
          const index = args.cursor ? Number(args.cursor) : 0;
          const next = index + 1 < pages.length ? String(index + 1) : "";
          return { messages: pages[index] || [], response_metadata: { next_cursor: next } };
        },
      },
    };
  };

  const found = clientFor([page(1), page(2), [{ ts: "300.1", user: "UBOT" }]]);
  assert.equal(
    await canEngageThreadByReaction(found, { channelId: "C1", threadTs: "100.1", botUserId: "UBOT" }),
    true,
  );
  assert.equal(found.calls.length, 3);
  assert.equal(found.calls[1].cursor, "1");

  const endless = clientFor(Array.from({ length: 20 }, (_, i) => page(i)));
  assert.equal(
    await canEngageThreadByReaction(endless, { channelId: "C1", threadTs: "100.1", botUserId: "UBOT" }),
    false,
  );
  assert.equal(endless.calls.length, 5, "the walk must stop after the bounded page budget");
});

ownershipTest("a missing channel, thread, or bot identity fails closed without a read", async () => {
  let reads = 0;
  const client = { conversations: { replies: async () => { reads += 1; return { messages: [] }; } } };
  for (const args of [
    { channelId: "", threadTs: "100.1", botUserId: "UBOT" },
    { channelId: "C1", threadTs: "", botUserId: "UBOT" },
    { channelId: "C1", threadTs: "100.1", botUserId: "" },
  ]) {
    assert.equal(await canEngageThreadByReaction(client, args), false);
  }
  assert.equal(reads, 0);
});

ownershipTest("a Slack thread-read failure logs safely and fails closed", async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    const client = {
      conversations: {
        replies: async () => {
          throw new Error("temporary Slack failure");
        },
      },
    };

    assert.equal(
      await canEngageThreadByReaction(client, {
        channelId: "C1",
        threadTs: "100.1",
        botUserId: "UBOT",
      }),
      false,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0].join(" "), /thread ownership check failed.*temporary Slack failure/);
});

test("first engagement replays the bot reminder root before earlier replies", async () => {
  const client = {
    conversations: {
      replies: async () => ({
        messages: [
          { ts: "100.1", user: "UBOT", text: "Reminder: choose a, b, or c." },
          { ts: "200.1", user: "U1", text: "I deleted the local meetings folder." },
          { ts: "300.1", user: "U1", text: "Please inspect this.", thread_ts: "100.1" },
        ],
        response_metadata: { next_cursor: "" },
      }),
    },
    users: {
      info: async ({ user }) => ({
        user: { profile: { display_name: user === "UBOT" ? "Robin" : "Alex" } },
      }),
    },
  };

  const context = await fetchThreadContext(client, {
    channelId: "C1",
    threadTs: "100.1",
    currentTs: "300.1",
    botUserId: "UBOT",
  });

  const reminderAt = context.indexOf("Robin: Reminder: choose a, b, or c.");
  const replyAt = context.indexOf("Alex: I deleted the local meetings folder.");
  assert.ok(reminderAt >= 0, "the daemon-posted reminder root must be replayed");
  assert.ok(replyAt > reminderAt, "prior replies must follow the root chronologically");
  assert.doesNotMatch(context, /Please inspect this/, "the reacted request is the live prompt, not replay context");
});
