import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { threadHasCompletionReaction } = await import("../src/gateway/thread-completion.js");
const { noteBotReply, sweepNudges } = await import("../src/gateway/nudges.js");
const { recordActivity, sendDigest, buildPendingReportForUser } = await import("../src/gateway/followups.js");
const check = [{ name: "white_check_mark", count: 1 }];
const msg = (ts, reactions = []) => ({ ts, reactions });
const clientFor = (messages) => ({ conversations: { replies: async () => ({ messages }) } });

for (const [name, messages, expected] of [
  ["checked root", [msg("1", check), msg("2")], true],
  ["checked latest", [msg("1"), msg("2", check)], true],
  ["checked older reply", [msg("1"), msg("2", check), msg("3")], true],
  ...["+1", "thumbsup", "+1::skin-tone-3", "thumbsup::skin-tone-5"].flatMap((name) => [
    [`${name} on root stays open`, [msg("1", [{ name, count: 1 }])], false],
    [`${name} on older reply stays open`, [msg("1"), msg("2", [{ name, count: 1 }]), msg("3")], false],
  ]),
  ["removed reaction", [msg("1", [{ name: "white_check_mark", count: 0 }])], false],
  ["ordinary text check", [{ ts: "1", text: "✅ done" }], false],
]) {
  test(name, async () => {
    assert.equal(await threadHasCompletionReaction(clientFor(messages), "C", "1"), expected);
  });
}

test("checks older replies across every page before deciding completion", async () => {
  const calls = [];
  const client = { conversations: { replies: async (args) => {
    calls.push(args);
    return args.cursor ? { messages: [msg("3")] } : {
      messages: [msg("1"), msg("2", check)], has_more: true, response_metadata: { next_cursor: "next" },
    };
  } } };
  assert.equal(await threadHasCompletionReaction(client, "C", "1"), true);
  assert.equal(calls[1].cursor, "next");
});

test("incomplete pagination cannot establish an open thread", async () => {
  const c = { conversations: { replies: async () => ({ messages: [msg("1")], has_more: true }) } };
  await assert.rejects(threadHasCompletionReaction(c, "C", "1"), /Incomplete/);
});

test("nudges defer on checked roots, checked last replies and lookup errors, then retry", async () => {
  let messages = [msg("1", check), msg("2")];
  let fail = false;
  const c = { conversations: { replies: async () => {
    if (fail) throw new Error("rate limited");
    return { messages };
  } } };
  const slack = { snapshot: () => ({ connected: true }), getClient: () => c };
  const map = new Map();
  noteBotReply("C", "s", "1", "U", { map, nowMs: 100 });
  let posts = 0;
  const options = { map, nowMs: 1000, thresholdMs: 10, loadUser: async () => ({ nudges: true }),
    post: async () => { posts++; }, log: async () => {} };
  await sweepNudges(slack, options);
  messages = [msg("1"), msg("2", check)];
  await sweepNudges(slack, options);
  fail = true;
  await sweepNudges(slack, options);
  assert.equal(posts, 0);
  assert.equal(map.get("s::1").reminded, false);
  fail = false;
  messages = [msg("1"), msg("2", [{ name: "eyes", count: 1 }])];
  await sweepNudges(slack, options);
  await sweepNudges(slack, options);
  assert.equal(posts, 1);
});

test("digest and pending report omit checked threads for every participant", async () => {
  const base = { channelId: "C_COMPLETION", slug: "completion", threadTs: "1" };
  recordActivity({ ...base, userId: "U_COMPLETION", aiTurn: true, tsMs: 1000, text: "question" });
  recordActivity({ ...base, userId: "BOT", isBot: true, aiTurn: true, tsMs: 2000 });
  const c = clientFor([msg("1", check), msg("2")]);
  assert.equal(await sendDigest(c, "U_COMPLETION", "BOT", 3000), 0);
  assert.match(await buildPendingReportForUser(c, "U_COMPLETION", "BOT", 3000), /Nothing pending/);
});

test("pending reports disclose failed verification instead of claiming an empty inbox", async () => {
  const c = { conversations: { replies: async () => { throw new Error("unavailable"); } } };
  assert.match(await buildPendingReportForUser(c, "U_COMPLETION", "BOT", 3000), /couldn’t verify/);
  assert.equal(await sendDigest(c, "U_COMPLETION", "BOT", 3000), 0);
});

test("a nudge replaced during the reaction lookup is not sent", async () => {
  const map = new Map();
  noteBotReply("C", "s", "1", "U", { map, nowMs: 100 });
  const c = { conversations: { replies: async () => {
    map.delete("s::1");
    return { messages: [msg("1")] };
  } } };
  let posts = 0;
  await sweepNudges({ snapshot: () => ({ connected: true }), getClient: () => c }, {
    map, nowMs: 1000, thresholdMs: 10, loadUser: async () => ({ nudges: true }),
    post: async () => { posts++; }, log: async () => {},
  });
  assert.equal(posts, 0);
});
