import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { startProgress } = await import("../src/slack/progress.js");
const { startRunningReaction, queueRunningReactionsForRecovery, retryRunningReactions } = await import("../src/slack/thread-running-reaction.ts");

type Reaction = { name: string; timestamp: string; channel: string };

function fakeSlack() {
  const calls: Array<[string, Reaction]> = [];
  const reactions = {
    async add(args: Reaction) { calls.push(["add", args]); return { ok: true }; },
    async remove(args: Reaction) { calls.push(["remove", args]); return { ok: true }; },
  };
  const client = {
    reactions, apiCall: async () => ({ ok: true }),
    chatStream: () => ({ append: async () => {}, stop: async () => {} }),
    chat: { postMessage: async () => ({ ts: "200.2" }) },
  };
  return { calls, client };
}

test("progress marks the root once until every turn on it has finalized or stopped", async () => {
  const { client, calls } = fakeSlack();
  const args = { channel: "C1", timestamp: "100.1", name: "arrow_forward" };
  const first = startProgress("stream", client, args.channel, args.timestamp);
  const second = startProgress("stream", client, args.channel, args.timestamp);
  await turn();
  assert.deepEqual(calls, [["add", args]]);
  await first.finalize({ content: "Done." });
  await first.stop();
  assert.equal(calls.length, 1);
  await second.stop();
  await turn();
  assert.deepEqual(calls, [["add", args], ["remove", args]]);
  assert.equal(getDb().prepare("SELECT count(*) n FROM slack_running_reactions").get().n, 0);
});

test("a slow add finishes before removal; headless synthetic keys never call Slack", async () => {
  const { client, calls } = fakeSlack();
  let finishAdd!: () => void;
  const added = new Promise<void>((resolve) => { finishAdd = resolve; });
  const original = client.reactions.add;
  client.reactions.add = async args => { const result = await original(args); await added; return result; };
  startRunningReaction(client, "C2", "sched-synthetic")();
  const stop = startRunningReaction(client, "C2", "123.456::agent-1");
  await turn();
  stop();
  stop();
  assert.deepEqual(calls.map(([verb, args]) => [verb, args.timestamp]), [["add", "123.456"]]);
  finishAdd();
  await turn();
  assert.deepEqual(calls.map(([verb, args]) => [verb, args.timestamp]), [["add", "123.456"], ["remove", "123.456"]]);
});

test("a failed removal retries; boot clears an interrupted marker even without a run to replay", async () => {
  const { client, calls } = fakeSlack();
  const remove = client.reactions.remove;
  let refuse = true;
  client.reactions.remove = async args => {
    await remove(args);
    return refuse ? { ok: false, error: "ratelimited" } : { ok: true };
  };
  const stop = startRunningReaction(client, "C3", "60.1");
  await turn();
  stop();
  await turn();
  const db = getDb();
  assert.ok(db.prepare("SELECT retry_ms FROM slack_running_reactions WHERE channel_id='C3'").get().retry_ms > 0);
  refuse = false;
  await retryRunningReactions(client, Date.now() + 120_000);
  assert.equal(calls.filter(([verb]) => verb === "remove").length, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM slack_running_reactions").get().n, 0);
  db.prepare("INSERT INTO slack_running_reactions VALUES('C4', '61.2', NULL)").run();
  queueRunningReactionsForRecovery();
  await retryRunningReactions(client);
  assert.deepEqual(calls.at(-1), ["remove", { channel: "C4", timestamp: "61.2", name: "arrow_forward" }]);
  assert.equal(db.prepare("SELECT count(*) n FROM slack_running_reactions").get().n, 0);
});
