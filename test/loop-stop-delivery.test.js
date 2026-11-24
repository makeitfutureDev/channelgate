import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { armLoop, threadLoops, stopThreadLoops } = await import("../src/gateway/loops.js");
const { readUsage, recordUsage } = await import("../src/gateway/usage.js");
const { getScheduleRun } = await import("../src/gateway/schedule-runs.js");
const { runSchedule, startScheduler, resetSchedulerState } = await import("../src/gateway/scheduler.js");
const { stopRunsInChannel } = await import("../src/slack/message-pipeline.js");

const channel = "C_STOP_LOOP", slug = "stop-loop", thread = "1700000000.001000";
const wakeup = { kind: "loop_wakeup", mode: "interval", cron: "*/5 * * * *", prompt: "check" };
const arm = (maxTicks = 3) => armLoop({ channelId: channel, slug, threadTs: thread, authorId: "U_LOOP", wakeup, maxTicks }).schedule;
const output = { engine: "codex", content: "Checked.", completed: true, usage: { input_tokens: 13, output_tokens: 4 }, loopWakeup: wakeup };
let posts, client, timer;

test.beforeEach(() => {
  posts = [];
  client = { chat: { postMessage: async ({ text }) => { posts.push(text); return { ok: true, ts: thread }; } } };
  timer = startScheduler({ immediate: false, slack: { snapshot: () => ({ connected: true }), getClient: () => client } });
});
test.afterEach(() => { clearInterval(timer); resetSchedulerState(); stopThreadLoops(channel, thread); });

for (const { replacement, budget } of [{ replacement: false, budget: 3 }, { replacement: true, budget: 3 }, { replacement: true, budget: 1 }]) {
  test(`a stopped loop with ${budget} ticks finishing delivery preserves ${replacement ? "a newly armed loop" : "the cancellation"}`, async () => {
    const schedule = arm(budget);
    const delivering = Promise.withResolvers(), finish = Promise.withResolvers();
    const work = runSchedule(schedule, { runner: async () => output, deliver: async () => { delivering.resolve(); await finish.promise; } });
    let next;
    try {
      await delivering.promise;
      await stopRunsInChannel(client, channel, slug, "U_LOOP", thread);
      if (replacement) next = arm();
    } finally {
      finish.resolve();
      await work;
    }
    assert.deepEqual(threadLoops(channel, thread).map(row => row.id), next ? [next.id] : []);
    assert.equal(posts.some(text => /Next loop tick|Looping on|tick budget/.test(text)), false);
    assert.equal(getScheduleRun(schedule.activeRunId).deliveryStatus, "delivered");
  });
}

for (const outcome of ["success", "error", "already-banked error"]) {
  test(`stopping an active loop accounts for a late engine ${outcome} once`, async () => {
    const before = (await readUsage({ channelId: channel })).length;
    const schedule = arm(), entered = Promise.withResolvers(), release = Promise.withResolvers();
    let delivered = 0;
    const work = runSchedule(schedule, { runner: async ({ signal }) => {
      entered.resolve(signal);
      await release.promise;
      if (outcome !== "success") {
        const usageRecorded = outcome === "already-banked error";
        if (usageRecorded) await recordUsage({ channelId: channel, slug, engine: output.engine, taskKind: "scheduled", result: output });
        throw Object.assign(new Error("run stopped"), { details: { result: output, explicitStop: true, usageRecorded } });
      }
      return output;
    }, deliver: async () => { delivered++; } });
    try {
      const signal = await entered.promise;
      await stopRunsInChannel(client, channel, slug, "U_LOOP", thread);
      assert.equal(signal.aborted, true);
    } finally {
      release.resolve();
      await work;
    }
    assert.equal(delivered, 0);
    assert.equal(posts.some(text => /Scheduled run failed|Looping on/.test(text)), false);
    assert.equal(threadLoops(channel, thread).length, 0);
    const recorded = getScheduleRun(schedule.activeRunId);
    assert.equal(recorded.status, "skipped");
    assert.equal(recorded.engineStatus, "interrupted");
    assert.equal(recorded.deliveryStatus, "suppressed");
    assert.equal(recorded.tokensIn, 13);
    const usage = await readUsage({ channelId: channel });
    assert.equal(usage.length, before + 1);
    assert.deepEqual([usage[0].taskKind, usage[0].tokensIn, usage[0].tokensOut], ["scheduled", 13, 4]);
  });
}
