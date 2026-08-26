import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { deleteThreadMessages } = await import("../src/slack/app.js");

const BOT = "UBOT";

// Fake Slack client: serves a canned thread (optionally paginated) and records every chat.delete.
// Deleting a non-bot message throws cant_delete_message exactly like the real API would.
function makeClient(pages) {
  const deletes = [];
  const repliesCalls = [];
  const all = pages.flat();
  const client = {
    conversations: {
      replies: async ({ channel, ts, cursor }) => {
        repliesCalls.push({ channel, ts, cursor });
        const i = cursor ? Number(cursor) : 0;
        return {
          messages: pages[i],
          response_metadata: { next_cursor: i + 1 < pages.length ? String(i + 1) : "" },
        };
      },
    },
    chat: {
      // Mirrors the real API: the (implicit) bot token deletes only the bot's own messages; a
      // per-call `token` override of a workspace admin's xoxp deletes anyone's.
      delete: async ({ channel, ts, token }) => {
        const m = all.find((x) => x.ts === ts);
        const allowed = m && (token === "xoxp-admin" || m.user === BOT);
        if (!allowed) {
          const err = new Error("cant_delete_message");
          err.data = { error: "cant_delete_message" };
          throw err;
        }
        deletes.push({ channel, ts, token: token || "" });
        return { ok: true };
      },
    },
  };
  return { client, deletes, repliesCalls };
}

test("deletes only the bot's messages, tallies humans' as left, parent last", async () => {
  const thread = [
    { ts: "100.000", user: "UHUMAN", text: "question" }, // parent — a human's, undeletable
    { ts: "100.001", user: BOT, text: "answer 1" },
    { ts: "100.002", user: "UHUMAN", text: "/delete" },
    { ts: "100.003", user: BOT, text: "answer 2" },
  ];
  const { client, deletes } = makeClient([thread]);
  const res = await deleteThreadMessages(client, { channelId: "C1", threadTs: "100.000", botUserId: BOT });

  assert.deepEqual(res, { deleted: 2, left: 2, total: 4, parentDeleted: false, usedUserToken: false });
  assert.deepEqual(
    deletes.map((d) => d.ts),
    ["100.001", "100.003"],
    "exactly the bot's two messages are deleted — humans' are never even attempted"
  );
  assert.ok(deletes.every((d) => d.channel === "C1"), "every delete stays in the triggering channel");
});

test("a bot-owned parent is deleted LAST and reported as parentDeleted", async () => {
  const thread = [
    { ts: "200.000", user: BOT, text: "scheduled report" }, // bot-owned thread root
    { ts: "200.001", user: BOT, text: "detail" },
  ];
  const { client, deletes } = makeClient([thread]);
  const res = await deleteThreadMessages(client, { channelId: "C1", threadTs: "200.000", botUserId: BOT });

  assert.equal(res.parentDeleted, true);
  assert.equal(res.deleted, 2);
  assert.deepEqual(
    deletes.map((d) => d.ts),
    ["200.001", "200.000"],
    "the reply goes first; the thread root is deleted last so the thread stays rooted while it empties"
  );
});

test("paginates the full thread and scopes every read to the given channel + thread", async () => {
  const page1 = Array.from({ length: 3 }, (_, i) => ({ ts: `300.00${i + 1}`, user: BOT, text: `m${i}` }));
  const page2 = [{ ts: "300.009", user: BOT, text: "tail" }];
  const { client, deletes, repliesCalls } = makeClient([[{ ts: "300.000", user: "UHUMAN", text: "root" }, ...page1], page2]);
  const res = await deleteThreadMessages(client, { channelId: "C9", threadTs: "300.000", botUserId: BOT });

  assert.equal(repliesCalls.length, 2, "follows next_cursor to the second page");
  assert.ok(repliesCalls.every((c) => c.channel === "C9" && c.ts === "300.000"), "reads never leave this thread");
  assert.equal(res.deleted, 4);
  assert.equal(deletes.length, 4);
});

test("another app's message that Slack refuses to delete counts as left", async () => {
  const thread = [
    { ts: "400.000", user: "UHUMAN", text: "root" },
    { ts: "400.001", bot_id: "BOTHER", text: "another app's post" }, // attempted, refused by API
    { ts: "400.002", user: BOT, text: "mine" },
  ];
  const { client } = makeClient([thread]);
  const res = await deleteThreadMessages(client, { channelId: "C1", threadTs: "400.000", botUserId: BOT });

  assert.equal(res.deleted, 1);
  assert.equal(res.left, 2, "the human root + the foreign bot post both stay");
});

test("with an admin user token, humans' messages are deleted via the token override", async () => {
  const thread = [
    { ts: "600.000", user: "UHUMAN", text: "question" }, // human parent
    { ts: "600.001", user: BOT, text: "answer" },
    { ts: "600.002", user: "UOTHER", text: "follow-up" },
  ];
  const { client, deletes } = makeClient([thread]);
  const res = await deleteThreadMessages(client, { channelId: "C1", threadTs: "600.000", botUserId: BOT, userToken: "xoxp-admin" });

  assert.deepEqual(res, { deleted: 3, left: 0, total: 3, parentDeleted: true, usedUserToken: true });
  const byTs = Object.fromEntries(deletes.map((d) => [d.ts, d.token]));
  assert.equal(byTs["600.001"], "", "the bot's own message uses the client's default (bot) token");
  assert.equal(byTs["600.000"], "xoxp-admin", "the human parent is deleted with the admin user token");
  assert.equal(byTs["600.002"], "xoxp-admin", "the other human's reply is deleted with the admin user token");
  assert.equal(deletes[deletes.length - 1].ts, "600.000", "the parent still goes last");
});

test("with a user token Slack still refuses (workspace pref off) → counted as left, not thrown", async () => {
  const thread = [
    { ts: "700.000", user: "UHUMAN", text: "root" },
    { ts: "700.001", user: BOT, text: "mine" },
  ];
  const { client, deletes } = makeClient([thread]);
  // This workspace refuses even the admin token for others' messages.
  const inner = client.chat.delete;
  client.chat.delete = async (args) => {
    if (args.token) {
      const err = new Error("cant_delete_message");
      err.data = { error: "cant_delete_message" };
      throw err;
    }
    return inner(args);
  };
  const res = await deleteThreadMessages(client, { channelId: "C1", threadTs: "700.000", botUserId: BOT, userToken: "xoxp-admin" });

  assert.equal(res.deleted, 1, "the bot's own message still goes");
  assert.equal(res.left, 1, "the refused human root is tallied, not fatal");
  assert.equal(res.usedUserToken, true);
  assert.deepEqual(deletes.map((d) => d.ts), ["700.001"]);
});

test("message_not_found (raced a manual delete) is already-gone, not a failure", async () => {
  const thread = [
    { ts: "500.000", user: "UHUMAN", text: "root" },
    { ts: "500.001", user: BOT, text: "mine" },
  ];
  const { client } = makeClient([thread]);
  client.chat.delete = async () => {
    const err = new Error("message_not_found");
    err.data = { error: "message_not_found" };
    throw err;
  };
  const res = await deleteThreadMessages(client, { channelId: "C1", threadTs: "500.000", botUserId: BOT });

  assert.equal(res.deleted, 0);
  assert.equal(res.left, 1, "only the human root is reported as left — the vanished bot message isn't");
});
