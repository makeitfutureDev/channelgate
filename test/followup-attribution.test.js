// M9: follow-up ACTIVITY attribution. Only the gateway's own posts map to botUserId — a foreign
// bot (any other integration) keeps its real identity, so it posting last in a thread never reads
// as "the gateway spoke last" and mints false "the bot is waiting for you" reminders. Plus the
// recordActivity monotonicity guard: observation is fire-and-forget, so out-of-order completions
// must never move the "who spoke last" snapshot backwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { followupIdentity } = await import("../src/slack/app.js");
const { recordActivity, pendingForUser } = await import("../src/gateway/followups.js");

const BOT = "UGATEWAY";

test("followupIdentity: the gateway's own post maps to the bot identity", () => {
  const id = followupIdentity({ user: BOT, bot_id: "B_OURS", text: "done" }, BOT);
  assert.deepEqual(id, { userId: BOT, isBot: true, isSelf: true });
});

test("followupIdentity: a foreign bot keeps its real identity — never the gateway's", () => {
  // A bot integration posting with its own bot user (e.g. another workspace app).
  const withUser = followupIdentity({ user: "UOTHERBOT", bot_id: "B_FOREIGN", text: "build passed" }, BOT);
  assert.equal(withUser.userId, "UOTHERBOT");
  assert.equal(withUser.isBot, true);
  assert.equal(withUser.isSelf, false);

  // Classic bot_message subtype: no `user` at all — the bot_id is the identity, not botUserId.
  const noUser = followupIdentity({ bot_id: "B_FOREIGN", subtype: "bot_message", text: "ping" }, BOT);
  assert.equal(noUser.userId, "B_FOREIGN");
  assert.equal(noUser.isBot, true);
  assert.equal(noUser.isSelf, false);
});

test("followupIdentity: a human stays a human", () => {
  const id = followupIdentity({ user: "U1", text: "hey" }, BOT);
  assert.deepEqual(id, { userId: "U1", isBot: false, isSelf: false });
});

test("a foreign bot posting last does not create 'the gateway awaits you' reminders", () => {
  const base = { channelId: "C_ATTR", slug: "attr", channelName: "attr", threadTs: "500.1" };
  // Genuine AI thread: human @mentions the gateway, the gateway answers.
  recordActivity({ ...base, userId: "U1", isBot: false, aiTurn: true, text: `hi <@${BOT}>`, tsMs: 1000 });
  recordActivity({ ...base, userId: BOT, isBot: true, aiTurn: true, text: "which option?", tsMs: 2000 });
  assert.deepEqual(pendingForUser("U1", BOT).map((r) => r.threadTs), ["500.1"]);

  // A Make.com-style integration posts last, under its OWN identity — the gateway is no longer
  // the last author, so it isn't waiting on anyone.
  recordActivity({ ...base, userId: "B_FOREIGN", isBot: true, aiTurn: false, text: "scenario ran", tsMs: 3000 });
  assert.deepEqual(pendingForUser("U1", BOT), []);
});

test("recordActivity never moves the last-speaker snapshot backwards", () => {
  const base = { channelId: "C_MONO", slug: "mono", channelName: "mono", threadTs: "600.1" };
  recordActivity({ ...base, userId: "U1", isBot: false, aiTurn: true, text: `<@${BOT}> help`, tsMs: 1000 });
  recordActivity({ ...base, userId: BOT, isBot: true, aiTurn: true, text: "need your call", tsMs: 5000 });
  assert.equal(pendingForUser("U1", BOT).length, 1, "bot spoke last → pending");

  // U2's message was SENT before the bot's reply but its observation lands after (fire-and-forget
  // completion order). It must still join the participants without rewinding "who spoke last".
  recordActivity({ ...base, userId: "U2", isBot: false, aiTurn: false, text: "me too", tsMs: 4000 });
  const pending = pendingForUser("U2", BOT);
  assert.equal(pending.length, 1, "late old message did not un-last the bot");
  assert.equal(pending[0].lastAuthorId, BOT);
  assert.equal(pending[0].lastTs, 5000);
  assert.ok(pending[0].participants.includes("U2"), "late participant still recorded");

  // A genuinely NEWER human reply advances the snapshot and clears the reminder.
  recordActivity({ ...base, userId: "U1", isBot: false, aiTurn: false, text: "option B", tsMs: 6000 });
  assert.deepEqual(pendingForUser("U1", BOT), []);
  assert.deepEqual(pendingForUser("U2", BOT), []);
});
