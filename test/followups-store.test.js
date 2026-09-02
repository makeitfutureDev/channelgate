// M8: the follow-up store now upserts/deletes only the touched row (no wipe-and-reinsert).
// Exercises the observable behavior end-to-end against a scratch SQLite DB: record → pending →
// done → re-open on fresh activity → clear.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const followups = await import("../src/gateway/followups.js");
const { recordActivity, markDone, clearDone, pendingForUser } = followups;

const BOT = "UBOT";
const base = { channelId: "C1", slug: "chan", channelName: "chan", threadTs: "111.1" };

test("bot-last AI thread shows up as pending for its human participant", () => {
  recordActivity({ ...base, userId: "U1", isBot: false, aiTurn: true, text: "hey <@UBOT>", tsMs: 1000 });
  recordActivity({ ...base, userId: BOT, isBot: true, aiTurn: true, text: "done?", tsMs: 2000 });
  const pending = pendingForUser("U1", BOT);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].threadTs, "111.1");
  assert.equal(pending[0].lastAuthorId, BOT);
});

test("updates touch only the addressed thread row", () => {
  recordActivity({ ...base, threadTs: "222.2", userId: "U1", isBot: false, aiTurn: true, text: "second thread", tsMs: 3000 });
  recordActivity({ ...base, threadTs: "222.2", userId: BOT, isBot: true, aiTurn: true, text: "answered", tsMs: 4000 });
  // The first thread's record is untouched by the second thread's writes.
  const pending = pendingForUser("U1", BOT);
  assert.deepEqual(pending.map((r) => r.threadTs), ["111.1", "222.2"]); // oldest-waiting first
});

test("markDone hides the thread; fresh bot activity re-opens it; clearDone reverts a ✅", () => {
  markDone("U1", "C1", "111.1", 5000);
  assert.deepEqual(pendingForUser("U1", BOT).map((r) => r.threadTs), ["222.2"]);
  // Newer bot activity after the done marker re-opens the thread automatically.
  recordActivity({ ...base, userId: BOT, isBot: true, aiTurn: true, text: "one more thing", tsMs: 6000 });
  assert.deepEqual(pendingForUser("U1", BOT).map((r) => r.threadTs), ["222.2", "111.1"]);
  // ✅ again, then remove the ✅ — the thread comes back.
  markDone("U1", "C1", "111.1", 7000);
  assert.deepEqual(pendingForUser("U1", BOT).map((r) => r.threadTs), ["222.2"]);
  clearDone("U1", "C1", "111.1");
  assert.deepEqual(pendingForUser("U1", BOT).map((r) => r.threadTs), ["222.2", "111.1"]);
});

test("a human replying last clears the thread (bot no longer awaits them)", () => {
  recordActivity({ ...base, userId: "U1", isBot: false, aiTurn: false, text: "here you go", tsMs: 8000 });
  assert.deepEqual(pendingForUser("U1", BOT).map((r) => r.threadTs), ["222.2"]);
});

test("digest snapshots persist the exact listed source threads", () => {
  assert.equal(typeof followups.saveDigestSnapshot, "function");
  assert.equal(typeof followups.getDigestSnapshot, "function");

  followups.saveDigestSnapshot({
    channelId: "D1",
    messageTs: "900.1",
    userId: "U1",
    threads: [
      { channelId: "C1", threadTs: "111.1" },
      { channelId: "C1", threadTs: "222.2" },
    ],
    createdMs: 10_000,
  });

  assert.deepEqual(followups.getDigestSnapshot("D1", "900.1"), {
    channelId: "D1",
    messageTs: "900.1",
    userId: "U1",
    threads: [
      { channelId: "C1", threadTs: "111.1" },
      { channelId: "C1", threadTs: "222.2" },
    ],
    createdMs: 10_000,
    dismissedMs: null,
  });
});

test("digest snapshot retention prunes rows older than the follow-up window", () => {
  assert.equal(typeof followups.pruneDigestSnapshots, "function");
  assert.equal(typeof followups.FOLLOWUP_RETENTION_MS, "number");

  followups.saveDigestSnapshot({
    channelId: "D1",
    messageTs: "900.2",
    userId: "U1",
    threads: [{ channelId: "C1", threadTs: "222.2" }],
    createdMs: 20_000,
  });

  assert.equal(followups.pruneDigestSnapshots(20_000 + followups.FOLLOWUP_RETENTION_MS + 1), 2);
  assert.equal(followups.getDigestSnapshot("D1", "900.1"), null);
  assert.equal(followups.getDigestSnapshot("D1", "900.2"), null);
});

test("database migrations retain the v7 digest snapshot table", async () => {
  const { getDb } = await import("../src/db/index.js");
  const db = getDb();
  assert.ok(db.prepare("PRAGMA user_version").get().user_version >= 7);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'followup_digest_messages'").get()?.name,
    "followup_digest_messages",
  );
});

test("scheduled digest persists only the source threads visibly listed in the posted message", async () => {
  assert.equal(typeof followups.sendDigest, "function");

  const nowMs = 100_000;
  for (let i = 1; i <= 26; i += 1) {
    const threadTs = `300.${i}`;
    const row = { channelId: "C2", slug: "many", channelName: "#many", threadTs };
    recordActivity({ ...row, userId: "U2", isBot: false, aiTurn: true, text: `question ${i}`, tsMs: i * 100 });
    recordActivity({ ...row, userId: BOT, isBot: true, aiTurn: true, text: `answer ${i}`, tsMs: i * 100 + 1 });
  }

  let postedText = "";
  const client = {
    conversations: { open: async () => ({ channel: { id: "D2" } }) },
    chat: {
      getPermalink: async ({ channel, message_ts }) => ({ permalink: `https://slack.test/${channel}/${message_ts}` }),
      postMessage: async ({ text }) => {
        postedText = text;
        return { ts: "901.1" };
      },
    },
  };

  assert.equal(await followups.sendDigest(client, "U2", BOT, nowMs), 26);
  const snapshot = followups.getDigestSnapshot("D2", "901.1");
  assert.equal(snapshot.threads.length, 25);
  assert.deepEqual(snapshot.threads[0], { channelId: "C2", threadTs: "300.1" });
  assert.deepEqual(snapshot.threads[24], { channelId: "C2", threadTs: "300.25" });
  assert.equal(snapshot.threads.some((thread) => thread.threadTs === "300.26"), false);
  assert.match(postedText, /React ✅ to dismiss all listed threads/);
  assert.match(postedText, /…and 1 more/);
});

test("scheduled digest without a returned Slack timestamp does not guess a snapshot key", async () => {
  assert.equal(typeof followups.sendDigest, "function");
  const { getDb } = await import("../src/db/index.js");
  const db = getDb();
  const before = db.prepare("SELECT COUNT(*) AS count FROM followup_digest_messages").get().count;
  const row = { channelId: "C3", slug: "one", channelName: "#one", threadTs: "400.1" };
  recordActivity({ ...row, userId: "U3", isBot: false, aiTurn: true, text: "question", tsMs: 50_000 });
  recordActivity({ ...row, userId: BOT, isBot: true, aiTurn: true, text: "answer", tsMs: 50_001 });
  const client = {
    conversations: { open: async () => ({ channel: { id: "D3" } }) },
    chat: {
      getPermalink: async () => ({ permalink: "" }),
      postMessage: async () => ({ ok: true }),
    },
  };

  assert.equal(await followups.sendDigest(client, "U3", BOT, 100_000), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM followup_digest_messages").get().count, before);
});

test("digest done reaction dismisses every listed source thread for its recipient", () => {
  assert.equal(typeof followups.applyDigestDoneReaction, "function");
  const first = { channelId: "C4", slug: "digest", channelName: "#digest", threadTs: "500.1" };
  const second = { ...first, threadTs: "500.2" };
  for (const row of [first, second]) {
    recordActivity({ ...row, userId: "U4", isBot: false, aiTurn: true, text: "question", tsMs: 55_000 });
    recordActivity({ ...row, userId: BOT, isBot: true, aiTurn: true, text: "answer", tsMs: 55_001 });
  }
  followups.saveDigestSnapshot({
    channelId: "D4",
    messageTs: "902.1",
    userId: "U4",
    threads: [
      { channelId: "C4", threadTs: "500.1" },
      { channelId: "C4", threadTs: "500.2" },
    ],
    createdMs: 59_000,
  });

  assert.equal(followups.applyDigestDoneReaction("OTHER", "D4", "902.1", 60_000), false);
  assert.equal(pendingForUser("U4", BOT).length, 2);
  assert.equal(followups.applyDigestDoneReaction("U4", "D4", "902.1", 60_000), true);
  assert.deepEqual(pendingForUser("U4", BOT), []);
  assert.equal(followups.getDigestSnapshot("D4", "902.1").dismissedMs, 60_000);
  assert.equal(followups.applyDigestDoneReaction("U4", "D4", "902.1", 70_000), true);
  assert.equal(followups.getDigestSnapshot("D4", "902.1").dismissedMs, 60_000);
});

test("removing a digest reaction reopens only its own dismissals", () => {
  assert.equal(typeof followups.removeDigestDoneReaction, "function");

  // A later direct source-thread ✅ must survive removal of the older digest ✅.
  markDone("U4", "C4", "500.1", 80_000);
  assert.equal(followups.removeDigestDoneReaction("OTHER", "D4", "902.1"), false);
  assert.equal(followups.removeDigestDoneReaction("U4", "D4", "902.1"), true);
  assert.deepEqual(pendingForUser("U4", BOT).map((row) => row.threadTs), ["500.2"]);
  assert.equal(followups.getDigestSnapshot("D4", "902.1").dismissedMs, null);
  assert.equal(followups.removeDigestDoneReaction("U4", "D4", "missing"), false);
});
