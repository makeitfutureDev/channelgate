import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { createSessionPool } = await import("../src/engines/session-pool.js");
const { clearActiveRun, clearActiveRunHandles, listActiveRuns, recordActiveRun, recoverRuns, shouldClearActiveRun } = await import("../src/gateway/active-runs.js");
const { performShutdown, waitForRuntimeDrain, detectServiceManager, restartExitCode } = await import("../src/gateway/shutdown.js");
const { runQueue } = await import("../src/slack/message-lifecycle.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeSession {
  constructor(sendImpl) {
    this.sendImpl = sendImpl;
    this.state = "starting";
    this.terminated = false;
    this.sent = [];
  }
  start() {
    this.state = "ready";
    return this;
  }
  get alive() {
    return !this.terminated;
  }
  async send(text) {
    this.state = "busy";
    this.sent.push(text);
    try {
      return await this.sendImpl(text);
    } finally {
      if (!this.terminated) this.state = "ready";
    }
  }
  interrupt() {
    return false;
  }
  terminate() {
    this.terminated = true;
    this.state = "dead";
  }
}

function pooledArgs(overrides = {}) {
  return {
    key: "channel::thread",
    cwd: "/tmp/channel",
    args: [],
    idleMs: 60_000,
    mcpConfigJson: "config-a",
    dangerouslySkip: false,
    fingerprintExtra: "model-a",
    text: "turn",
    turnTimeoutMs: 1_000,
    ...overrides,
  };
}

test("warm fingerprint replacement drains the busy entry before terminating its process", async () => {
  const firstTurn = deferred();
  const sessions = [];
  const pool = createSessionPool({
    createSession: () => {
      const session = new FakeSession(sessions.length === 0
        ? () => firstTurn.promise
        : async () => ({ content: "second" }));
      sessions.push(session);
      return session;
    },
    maxSessions: () => 8,
  });

  const first = pool.runPooled(pooledArgs({ text: "first" }));
  await nextTurn();
  assert.equal(sessions[0].state, "busy");

  const replacement = pool.runPooled(pooledArgs({ mcpConfigJson: "config-b", text: "second" }));
  await nextTurn();
  assert.equal(sessions.length, 1, "replacement must not launch until the old turn drains");
  assert.equal(sessions[0].terminated, false, "busy process must remain alive while its turn is in flight");

  firstTurn.resolve({ content: "first" });
  assert.equal((await first).content, "first");
  assert.equal((await replacement).content, "second");
  assert.equal(sessions[0].terminated, true, "old process is swept only after its turn settles");
  assert.deepEqual(sessions[1].sent, ["second"]);
});

test("warm-pool shutdown sweeps idle persistent sessions too", async () => {
  const sessions = [];
  const pool = createSessionPool({
    createSession: () => {
      const session = new FakeSession(async () => ({ content: "done" }));
      sessions.push(session);
      return session;
    },
  });
  await pool.runPooled(pooledArgs());
  assert.equal(pool.poolStats().warm, 1);
  assert.equal(pool.shutdownPool(), 1);
  assert.equal(sessions[0].terminated, true);
  assert.equal(pool.poolStats().warm, 0);
});

test("warm-pool shutdown prevents a fingerprint waiter from spawning after the final sweep", async () => {
  const firstTurn = deferred();
  const sessions = [];
  const pool = createSessionPool({
    createSession: () => {
      const session = new FakeSession(sessions.length === 0
        ? () => firstTurn.promise
        : async () => ({ content: "late replacement" }));
      sessions.push(session);
      return session;
    },
  });

  const first = pool.runPooled(pooledArgs({ text: "first" }));
  await nextTurn();
  const replacement = pool.runPooled(pooledArgs({ mcpConfigJson: "config-b", text: "replacement" }));
  await nextTurn();

  assert.equal(pool.shutdownPool(), 1);
  firstTurn.resolve({ content: "first" });
  assert.equal((await first).content, "first");
  await assert.rejects(replacement, /shutting down/i);
  assert.equal(sessions.length, 1, "no warm process may launch after the shutdown snapshot");
  assert.equal(pool.poolStats().warm, 0);
});

test("restart recovery shares the live Slack thread queue and keeps the live fingerprint", async () => {
  const rec = {
    id: "runtime-recovery::message",
    channelId: "C123",
    slug: "runtime-recovery",
    authorId: "U123",
    threadKey: "111.222",
    text: "recover this",
    attachments: [],
  };
  const key = `${rec.slug}::${rec.threadKey}`;
  const live = { aborted: false, authorId: "U-live" };
  await runQueue.acquire(key, live);

  const runnerCalls = [];
  const finalizations = [];
  const progressStarts = [];
  const progressEvents = [];
  const posts = [];
  const usage = [];
  const deliveryStarted = deferred();
  const deliveryGate = deferred();
  const slack = {
    snapshot: () => ({ connected: true }),
    getClient: () => ({
      apiCall: async () => ({ ok: true }),
      chatStream: () => ({}),
      chat: { postMessage: async (payload) => posts.push(payload) },
    }),
  };
  const recovering = recoverRuns([rec], {
    slack,
    runner: async (args) => {
      runnerCalls.push(args);
      args.onRuntimeResolved({ engine: "claude", model: "claude-sonnet-4-6" });
      args.onEvent({ kind: "tool_use", name: "Read", target: "active-runs.js" });
      args.onDelta("recovered");
      return { content: "recovered", engine: "claude", usage: { output_tokens: 1 } };
    },
    deliver: async () => { throw new Error("owning native progress must deliver the recovery"); },
    progressFactory: (mode, _client, channel, threadTs, ctx) => {
      progressStarts.push({ mode, channel, threadTs, ctx });
      return {
        ownsFinal: true,
        onRuntimeResolved: (event) => progressEvents.push(["runtime", event]),
        onEvent: (event) => progressEvents.push(["event", event]),
        onDelta: (delta) => progressEvents.push(["delta", delta]),
        finalize: async (result) => {
          finalizations.push(result);
          deliveryStarted.resolve();
          await deliveryGate.promise;
        },
        stop: async () => progressEvents.push(["stop"]),
      };
    },
    directoryResolver: async () => ({ map: new Map(), maxWords: 5 }),
    usageRecorder: async (payload) => usage.push(payload),
  });

  await nextTurn();
  assert.equal(runnerCalls.length, 0, "recovery must wait behind the already-live Slack turn");
  runQueue.release(key, live);
  await deliveryStarted.promise;
  // M8: the engine already spent these tokens, so the ledger is written BEFORE the answer is
  // delivered — a Slack failure mid-delivery must not be able to erase real spend.
  assert.equal(usage.length, 1, "usage is banked before the user-visible delivery");
  assert.ok(
    listActiveRuns().some((row) => row.id === rec.id),
    "the durable row survives until delivery actually completes",
  );
  deliveryGate.resolve();
  await recovering;
  assert.equal(
    listActiveRuns().some((row) => row.id === rec.id),
    false,
    "a delivered recovery is durably terminal",
  );

  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].progressReport, true);
  assert.equal(runnerCalls[0].origin, "recovery");
  assert.ok(runnerCalls[0].signal instanceof AbortSignal);
  assert.equal(finalizations[0].content, "recovered");
  assert.deepEqual(progressStarts[0], {
    mode: "stream",
    channel: "C123",
    threadTs: "111.222",
    ctx: { authorId: "U123", teamId: "", isDM: false, dir: { map: new Map(), maxWords: 5 } },
  });
  assert.deepEqual(progressEvents.map(([kind]) => kind), ["runtime", "event", "delta"]);
  assert.equal(runQueue.count(key), 0, "recovery must release its queue ownership");
  assert.match(posts[0].text, /picking it back up/i);
});

test("restart recovery streams native progress instead of going silent until final delivery", async () => {
  const rec = {
    id: "runtime-visible-recovery::message",
    channelId: "C_PROGRESS",
    slug: "runtime-visible-recovery",
    workspaceId: "T123",
    authorId: "U123",
    threadKey: "333.444",
    isDM: false,
    text: "recover visibly",
    attachments: [],
  };
  const posts = [];
  const progressStarts = [];
  const visible = [];
  const finalized = [];
  const deliveries = [];
  const client = {
    apiCall: async () => ({ ok: true }),
    chatStream: () => ({}),
    chat: { postMessage: async (payload) => posts.push(payload) },
  };
  const slack = {
    snapshot: () => ({ connected: true }),
    getClient: () => client,
  };

  await recoverRuns([rec], {
    slack,
    runner: async (args) => {
      assert.equal(typeof args.onDelta, "function");
      assert.equal(typeof args.onEvent, "function");
      args.onRuntimeResolved({ engine: "codex", model: "gpt-5.6-sol" });
      args.onEvent({ kind: "tool_use", name: "Bash", target: "npm test" });
      args.onDelta("Live recovered answer.");
      return { content: "Live recovered answer.", engine: "codex", usage: { output_tokens: 1 } };
    },
    progressFactory: (mode, _client, channel, threadKey, ctx) => {
      progressStarts.push({ mode, channel, threadKey, ctx });
      return {
        ownsFinal: true,
        onDelta: (delta) => visible.push(["delta", delta]),
        onEvent: (event) => visible.push(["event", event]),
        onRuntimeResolved: (runtime) => visible.push(["runtime", runtime]),
        finalize: async (result) => finalized.push(result),
        stop: async () => visible.push(["stop"]),
      };
    },
    directoryResolver: async () => ({ map: new Map([["alex", "U123"]]), maxWords: 1 }),
    deliver: async (_client, payload) => deliveries.push(payload),
    usageRecorder: async () => {},
  });

  assert.equal(progressStarts.length, 1);
  assert.deepEqual(
    { mode: progressStarts[0].mode, channel: progressStarts[0].channel, threadKey: progressStarts[0].threadKey },
    { mode: "stream", channel: rec.channelId, threadKey: rec.threadKey },
  );
  assert.equal(progressStarts[0].ctx.authorId, rec.authorId);
  assert.equal(progressStarts[0].ctx.teamId, rec.workspaceId);
  assert.equal(progressStarts[0].ctx.isDM, false);
  assert.equal(progressStarts[0].ctx.dir.map.get("alex"), "U123");
  assert.deepEqual(visible.map(([kind]) => kind), ["runtime", "event", "delta"]);
  assert.equal(finalized[0].content, "Live recovered answer.");
  assert.equal(deliveries.length, 0, "native recovery progress owns final delivery");
  assert.match(posts[0].text, /picking it back up/i);
});

test("failed restart recovery clears its temporary progress surface before reporting the error", async () => {
  const rec = {
    id: "runtime-recovery-error::message",
    channelId: "C125",
    slug: "runtime-recovery-error",
    authorId: "U125",
    threadKey: "333.444",
    text: "recover and fail",
    attachments: [],
  };
  const posts = [];
  let stops = 0;
  let finalizations = 0;
  const slack = {
    snapshot: () => ({ connected: true }),
    getClient: () => ({
      apiCall: async () => ({ ok: true }),
      chatStream: () => ({}),
      chat: { postMessage: async (payload) => posts.push(payload) },
    }),
  };

  await recoverRuns([rec], {
    slack,
    runner: async () => { throw new Error("recovery exploded"); },
    progressFactory: () => ({
      ownsFinal: true,
      onRuntimeResolved: () => {},
      onEvent: () => {},
      onDelta: () => {},
      finalize: async () => { finalizations += 1; },
      stop: async () => { stops += 1; },
    }),
    directoryResolver: async () => ({ map: new Map(), maxWords: 5 }),
    usageRecorder: async () => {},
  });

  assert.equal(stops, 1, "the temporary status/stream must close on the recovery error path");
  assert.equal(finalizations, 0);
  assert.equal(posts.length, 2, "the restart notice is followed by one visible failure report");
  assert.match(posts[1].text, /tried to resume.*failed.*recovery exploded/is);
  assert.equal(listActiveRuns().some((row) => row.id === rec.id), false);
  assert.equal(runQueue.count(`${rec.slug}::${rec.threadKey}`), 0);
});

test("an explicitly steered restart recovery aborts quietly and releases the successor", async () => {
  const rec = {
    id: "runtime-steered-recovery::message",
    channelId: "C_STEER_RECOVERY",
    slug: "runtime-steered-recovery",
    authorId: "U_STEER_RECOVERY",
    threadKey: "350.450",
    text: "recover until steered",
    attachments: [],
  };
  const key = `${rec.slug}::${rec.threadKey}`;
  const started = deferred();
  const posts = [];
  const slack = {
    snapshot: () => ({ connected: true }),
    getClient: () => ({ chat: { postMessage: async (payload) => posts.push(payload) } }),
  };
  const recovering = recoverRuns([rec], {
    slack,
    runner: async ({ signal }) => new Promise((resolve, reject) => {
      started.resolve();
      signal.addEventListener("abort", () => reject(Object.assign(new Error("steered"), { name: "AbortError" })), { once: true });
    }),
    deliver: async () => { throw new Error("a steered recovery must not deliver"); },
    usageRecorder: async () => {},
  });

  await started.promise;
  const active = runQueue.activeHandle(key);
  assert.ok(active?.recovery);
  active.steered = true;
  active.controller.abort();
  await recovering;

  assert.equal(posts.length, 1, "only the initial restart notice remains; no false recovery error");
  assert.match(posts[0].text, /picking it back up/i);
  assert.equal(runQueue.count(key), 0);
  assert.equal(listActiveRuns().some((row) => row.id === rec.id), false);
});

test("a warm interrupted restart recovery suppresses partial output and false errors", async () => {
  const rec = {
    id: "runtime-warm-steered-recovery::message",
    channelId: "C_WARM_STEER_RECOVERY",
    slug: "runtime-warm-steered-recovery",
    authorId: "U_WARM_STEER_RECOVERY",
    threadKey: "351.451",
    text: "recover until warm interrupt",
    attachments: [],
  };
  const posts = [];
  const deliveries = [];
  const usage = [];
  const slack = {
    snapshot: () => ({ connected: true }),
    getClient: () => ({ chat: { postMessage: async (payload) => posts.push(payload) } }),
  };
  await recoverRuns([rec], {
    slack,
    runner: async () => {
      const active = runQueue.activeHandle(`${rec.slug}::${rec.threadKey}`);
      active.steered = true;
      return { content: "partial output that must stay hidden", interrupted: true, engine: "claude", usage: { output_tokens: 1 } };
    },
    deliver: async (_client, payload) => deliveries.push(payload),
    usageRecorder: async (payload) => usage.push(payload),
  });

  assert.equal(posts.length, 1, "only the restart notice is visible");
  assert.equal(deliveries.length, 0);
  assert.equal(usage.length, 1, "the interrupted work is still accounted for");
  assert.equal(listActiveRuns().some((row) => row.id === rec.id), false);
});

test("restart recovery falls back to final delivery when native streaming is unavailable", async () => {
  const rec = {
    id: "runtime-legacy-recovery::message",
    channelId: "C126",
    slug: "runtime-legacy-recovery",
    authorId: "U126",
    threadKey: "444.555",
    text: "recover on an older Slack client",
    attachments: [],
  };
  const posts = [];
  const deliveries = [];
  let progressStarts = 0;
  const slack = {
    snapshot: () => ({ connected: true }),
    getClient: () => ({ chat: { postMessage: async (payload) => posts.push(payload) } }),
  };

  await recoverRuns([rec], {
    slack,
    runner: async (args) => {
      assert.equal(args.onDelta, undefined);
      assert.equal(args.onEvent, undefined);
      return { content: "Recovered without native streaming.", engine: "claude", usage: { output_tokens: 1 } };
    },
    progressFactory: () => { progressStarts += 1; },
    deliver: async (_client, payload) => deliveries.push(payload),
    usageRecorder: async () => {},
  });

  assert.equal(progressStarts, 0, "an unsupported Slack client must not start native progress");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].result.content, "Recovered without native streaming.");
  assert.equal(posts.length, 1, "the restart notice remains visible before final delivery");
  assert.equal(listActiveRuns().some((row) => row.id === rec.id), false);
});

test("restart recovery queued behind a live turn cannot launch after force-stop", async () => {
  const rec = {
    id: "runtime-force-stop::message",
    channelId: "C124",
    slug: "runtime-force-stop",
    authorId: "U124",
    threadKey: "222.333",
    text: "recover later",
    attachments: [],
  };
  const key = `${rec.slug}::${rec.threadKey}`;
  const live = { aborted: false, authorId: "U-live" };
  await runQueue.acquire(key, live);
  let forced = false;
  let runnerCalls = 0;
  const slack = {
    snapshot: () => ({ connected: true }),
    getClient: () => ({ chat: { postMessage: async () => {} } }),
  };

  const recovering = recoverRuns([rec], {
    slack,
    forceStopping: () => forced,
    runner: async () => {
      runnerCalls += 1;
      return { content: "must not run", engine: "claude", usage: { output_tokens: 1 } };
    },
    deliver: async () => {},
    usageRecorder: async () => {},
  });
  await nextTurn();
  forced = true;
  runQueue.release(key, live);
  await recovering;

  assert.equal(runnerCalls, 0);
  assert.equal(runQueue.count(key), 0);
  assert.ok(listActiveRuns().some((row) => row.id === rec.id), "forced interruption remains recoverable");
  clearActiveRun(rec.id);
});

test("per-turn terminal state beats a concurrent global force-stop for replay cleanup", () => {
  assert.equal(shouldClearActiveRun({ terminal: true, forceStopping: true }), true,
    "a delivered, failed, steered, or explicitly stopped turn must not replay");
  assert.equal(shouldClearActiveRun({ terminal: false, forceStopping: true }), false,
    "only genuinely interrupted work stays recoverable");
  assert.equal(shouldClearActiveRun({ terminal: false, forceStopping: false }), true,
    "ordinary errors during graceful drain are terminal and reported");
});

test("explicit stop clears active and queued durable rows before their owners unwind", async () => {
  const active = { aborted: false, runId: "stop-barrier::active" };
  const queued = { aborted: false, runId: "stop-barrier::queued" };
  recordActiveRun(active.runId, { channelId: "C_STOP", slug: "stop-barrier", authorId: "U_STOP", threadKey: "1.0", text: "active" });
  recordActiveRun(queued.runId, { channelId: "C_STOP", slug: "stop-barrier", authorId: "U_STOP", threadKey: "1.0", text: "queued" });
  assert.equal(clearActiveRunHandles([active, queued]), 2);
  assert.equal(listActiveRuns().some((row) => row.id === active.runId || row.id === queued.runId), false);
});

test("runtime drain is bounded and reports the activity left at its deadline", async () => {
  let clock = 0;
  const result = await waitForRuntimeDrain({
    timeoutMs: 25,
    pollMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    getActivity: () => ({ total: 1, queued: 1, cold: 0, warmPending: 0 }),
  });
  assert.equal(result.drained, false);
  assert.equal(result.waitedMs, 25);
  assert.equal(result.activity.queued, 1);
});

test("graceful shutdown disconnects, drains, then sweeps idle warm and cold groups before exit", async () => {
  const events = [];
  const snapshots = [
    { total: 1, queued: 1, cold: 1, warmPending: 0 }, // initial log snapshot
    { total: 1, queued: 1, cold: 1, warmPending: 0 }, // first drain poll
    { total: 0, queued: 0, cold: 0, warmPending: 0 },
  ];
  const result = await performShutdown({
    slack: { disconnect: async () => { events.push("disconnect"); } },
    reason: "test restart",
    drainTimeoutMs: 100,
    pollMs: 10,
    killAfterMs: 0,
    getActivity: () => snapshots.shift() || { total: 0, queued: 0, cold: 0, warmPending: 0 },
    sleep: async () => { events.push("wait"); },
    markForce: () => events.push("freeze"),
    sweepCold: () => { events.push("cold"); return 0; },
    sweepWarm: () => { events.push("warm"); return 2; },
    sweepColdFinal: () => { events.push("late-cold"); return 0; },
    sweepWarmFinal: () => { events.push("late-warm"); return 0; },
    exit: (code) => events.push(`exit:${code}`),
    logger: { log: () => {}, warn: () => {} },
  });

  assert.equal(result.drained, true);
  assert.deepEqual(events, ["disconnect", "wait", "freeze", "cold", "warm", "late-cold", "late-warm", "exit:0"]);
  assert.equal(result.warm, 2, "idle warm groups are swept even after active work drained cleanly");
});

test("shutdown deadline warns with recoverability before forcing both process registries", async () => {
  const events = [];
  const warnings = [];
  const busy = { total: 3, queued: 1, cold: 1, warmPending: 1 };
  const result = await performShutdown({
    slack: { disconnect: async () => { events.push("disconnect"); } },
    reason: "deadline restart",
    drainTimeoutMs: 0,
    killAfterMs: 0,
    getActivity: () => busy,
    markForce: () => events.push("freeze"),
    sweepCold: () => { events.push("cold"); return 1; },
    sweepWarm: () => { events.push("warm"); return 1; },
    sweepColdFinal: () => { events.push("late-cold"); return 0; },
    sweepWarmFinal: () => { events.push("late-warm"); return 0; },
    exit: () => events.push("exit"),
    logger: { log: () => {}, warn: (message) => warnings.push(message) },
  });

  assert.equal(result.drained, false);
  assert.deepEqual(events, ["disconnect", "freeze", "cold", "warm", "late-cold", "late-warm", "exit"]);
  assert.match(warnings[0], /graceful drain expired/i);
  assert.match(warnings[0], /remain recoverable after restart/i);
});

test("an admin restart exits with the code its service manager treats as 'relaunch me'", () => {
  // Linux only: systemd is the one service manager, so a foreign platform never reports one even
  // with systemd's own env markers present.
  assert.equal(detectServiceManager({ platform: "freebsd", env: { INVOCATION_ID: "abc" } }), "none");
  assert.equal(restartExitCode({ platform: "freebsd", env: { INVOCATION_ID: "abc" } }), 0);
  // The systemd unit uses Restart=on-failure: a clean 0 STOPS the service, which is exactly how
  // the admin Restart button used to take a Linux deployment down. INVOCATION_ID (or
  // JOURNAL_STREAM) is set on every systemd service process and on no plain terminal.
  assert.equal(detectServiceManager({ platform: "linux", env: { INVOCATION_ID: "abc" } }), "systemd");
  assert.equal(detectServiceManager({ platform: "linux", env: { JOURNAL_STREAM: "8:123" } }), "systemd");
  assert.equal(restartExitCode({ platform: "linux", env: { INVOCATION_ID: "abc" } }), 1);
  // Unmanaged run (a terminal `npm start`, container init, …): nothing relaunches us either way,
  // so exit cleanly rather than reporting a failure that never happened.
  assert.equal(detectServiceManager({ platform: "linux", env: {} }), "none");
  assert.equal(restartExitCode({ platform: "linux", env: {} }), 0);
});
