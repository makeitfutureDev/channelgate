import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
process.env.SESSION_KEEPALIVE = "0";
const { createFakeRuntimeBackend, useFakeRuntime } = await import("./runtime-fake.js");
const { setUser } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { processMessageEvent, runQueue, stopRunsInChannel } = await import("../src/slack/message-pipeline.js");
const { steerActiveRun } = await import("../src/slack/busy-thread-choice.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeSlack(user) {
  const calls = [], posted = [], streamed = [];
  let seq = 0;
  const ok = async () => ({ ok: true });
  return {
    calls, posted, streamed,
    apiCall: async (method, args) => { calls.push({ method, args }); return { ok: true }; },
    chat: {
      postMessage: async (message) => { posted.push(message); return { ok: true, ts: `bot.${++seq}` }; },
      update: ok, delete: ok, postEphemeral: ok,
    },
    chatStream: () => ({ ts: `stream.${++seq}`,
      append: async (args) => { streamed.push(args); }, stop: ok }),
    users: {
      info: async () => ({ user: { id: user, real_name: "Stop fixture" } }),
      list: async () => ({ members: [{ id: user, real_name: "Stop fixture" }], response_metadata: {} }),
    },
    conversations: {
      history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }),
      info: async ({ channel }) => ({ channel: { id: channel } }),
      members: async () => ({ members: [user], response_metadata: {} }),
    },
  };
}

test("Stop during directory preflight never starts progress or the runner afterwards", { timeout: 10_000 }, async () => {
  const user = "U_PROGRESS_DIRECTORY", channel = "D_PROGRESS_DIRECTORY", thread = "9100.301";
  const slug = `dm-${user.toLowerCase()}`;
  await setUser(user, { approved: true });
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const backend = await useFakeRuntime();
  const client = fakeSlack(user), entered = deferred(), release = deferred();
  client.users.list = async () => {
    entered.resolve();
    await release.promise;
    return { members: [], response_metadata: {} };
  };
  const processing = processMessageEvent({ type: "message", channel, channel_type: "im", user,
    text: "stop during directory lookup", ts: thread }, client, { botUserId: "U_BOT", teamId: "T_PROGRESS_DIRECTORY" });
  try {
    await entered.promise;
    assert.ok(runQueue.activeHandle(`${slug}::${thread}`));
    await stopRunsInChannel(client, channel, slug, user, thread);
    const afterStop = client.calls.length;
    release.resolve();
    await processing;
    assert.equal(client.calls.slice(afterStop).some(({ args }) => args.status === "processing"), false);
    assert.equal(backend.calls.spawn.length, 0);
    assert.equal(runQueue.isActive(`${slug}::${thread}`), false);
  } finally {
    release.resolve();
    await processing;
    await useFakeRuntime(null);
  }
});

for (const engine of ["claude", "codex"]) {
  test(`${engine} late stdout after Stop cannot restart status or stream an answer`, { timeout: 10_000 }, async () => {
    const user = `U_LATE_PROGRESS_${engine}`, channel = `D_LATE_PROGRESS_${engine}`;
    const slug = `dm-${user.toLowerCase()}`, thread = "9100.201";
    await setUser(user, { approved: true });
    saveSettings({ engine, memoryReviewEvery: 0, composioMode: "personal", engineFallback: false });
    const ready = deferred(), late = deferred();
    const backend = createFakeRuntimeBackend(), spawn = backend.spawn;
    const fixture = `
      const engine = process.argv[1];
      const write = (text) => console.log(JSON.stringify(engine === "claude"
        ? { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }
        : { type: "item.completed", item: { id: text, type: "agent_message", text } }));
      process.on("SIGTERM", () => {
        setTimeout(() => write("LATE_ABORTED_ANSWER"), 100);
        setTimeout(() => process.exit(0), 300);
      });
      write("FIXTURE_READY");
      setInterval(() => {}, 1000);
    `;
    backend.spawn = (target, spec) => {
      const child = spawn(target, { ...spec, cmd: process.execPath, args: ["-e", fixture, engine] });
      child.stdout.on("data", (bytes) => {
        if (String(bytes).includes("FIXTURE_READY")) ready.resolve();
        if (String(bytes).includes("LATE_ABORTED_ANSWER")) late.resolve();
      });
      return child;
    };
    await useFakeRuntime(backend);
    const client = fakeSlack(user);
    const processing = processMessageEvent({ type: "message", channel, channel_type: "im", user,
      text: "run the delayed abort fixture", ts: thread }, client, { botUserId: "U_BOT", teamId: `T_LATE_${engine}` });
    try {
      await ready.promise;
      await stopRunsInChannel(client, channel, slug, user, thread);
      const afterStop = client.calls.length;
      await late.promise;
      await processing;
      assert.equal(client.calls.slice(afterStop).some(({ args }) => args.status === "processing"), false);
      assert.doesNotMatch(JSON.stringify([...client.posted, ...client.streamed]), /LATE_ABORTED_ANSWER/);
      assert.equal(client.posted.filter((m) => m.text === "🛑 Stopped.").length, 1);
    } finally {
      await stopRunsInChannel(client, channel, slug, user, thread);
      await processing;
      await useFakeRuntime(null);
    }
  });
}

for (const engine of ["claude", "codex"]) for (const action of ["stop", "steer"]) {
  test(`${engine} ${action} closes progress before delayed runtime unwind`, { timeout: 10_000 }, async () => {
    const user = `U_PROGRESS_${engine}_${action}`;
    const channel = `D_PROGRESS_${engine}_${action}`;
    const slug = `dm-${user.toLowerCase()}`;
    const thread = "9100.101";
    await setUser(user, { approved: true });
    saveSettings({ engine, memoryReviewEvery: 0, composioMode: "personal", engineFallback: false });
    const entered = deferred(), release = deferred();
    const backend = createFakeRuntimeBackend();
    backend.ensureUp = async () => {
      entered.resolve();
      await release.promise;
      throw new Error("owned runtime fixture unwound after cancellation");
    };
    await useFakeRuntime(backend);
    const client = fakeSlack(user);
    const processing = processMessageEvent({ type: "message", channel, channel_type: "im", user,
      text: "wait for the owned runtime fixture", ts: thread }, client, { botUserId: "U_BOT", teamId: `T_${engine}_${action}` });
    try {
      await entered.promise;
      const active = runQueue.activeHandle(`${slug}::${thread}`);
      assert.ok(active, "runtime remains owned until unwind completes");
      if (action === "stop") await stopRunsInChannel(client, channel, slug, user, thread);
      else assert.equal(steerActiveRun(runQueue, `${slug}::${thread}`, { requesterAuthorId: user,
        interruptWarm: () => false }), "aborted");
      assert.equal(active.controller.signal.aborted, true);
      // The runtime warmup notice fires after two seconds, while the cancelled runner is still
      // held. This real late onEvent used to reassert processing after the Stop handler's clear.
      const afterAbort = client.calls.length;
      await delay(2_100);
      assert.equal(client.calls.slice(afterAbort).some(({ args }) => args.status === "processing"), false,
        "cancelled progress must not restart while the runner is still unwinding");
      assert.ok(client.calls.some(({ args }) => args.status === "active"), "cancellation clears native status before unwind");
    } finally {
      release.resolve();
      await processing;
      await useFakeRuntime(null);
    }
    assert.equal(client.posted.filter((m) => m.text === "🛑 Stopped.").length, action === "stop" ? 1 : 0);
    assert.equal(client.posted.some((m) => /fixture unwound|wait for the owned runtime/.test(m.text || "")), false,
      "neither the late failure nor an answer is delivered after cancellation");
  });
}

for (const engine of ["claude", "codex"]) {
  test(`${engine} steered successor waits for the predecessor's deferred status cleanup`, { timeout: 10_000 }, async () => {
    const user = `U_STEER_CLEANUP_${engine}`, channel = `D_STEER_CLEANUP_${engine}`;
    const slug = `dm-${user.toLowerCase()}`, thread = "9100.401";
    await setUser(user, { approved: true });
    saveSettings({ engine, memoryReviewEvery: 0, composioMode: "personal", engineFallback: false });
    const ready = deferred(), exited = deferred(), oldWrite = deferred(), successorReady = deferred();
    const backend = createFakeRuntimeBackend(), spawn = backend.spawn;
    let spawns = 0;
    const fixture = `
      process.on("SIGTERM", () => process.exit(0));
      console.log(JSON.stringify(process.argv[1] === "claude"
        ? { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "READY" } } }
        : { type: "item.completed", item: { id: "ready", type: "agent_message", text: "READY" } }));
      setInterval(() => {}, 1000);
    `;
    backend.spawn = (target, spec) => {
      const predecessor = ++spawns === 1;
      const child = spawn(target, { ...spec, cmd: process.execPath, args: ["-e", fixture, engine] });
      child.stdout.once("data", () => (predecessor ? ready : successorReady).resolve());
      if (predecessor) child.once("exit", () => exited.resolve());
      return child;
    };
    await useFakeRuntime(backend);
    const client = fakeSlack(user), accepted = [];
    let held = false;
    client.apiCall = async (method, args) => {
      client.calls.push({ method, args });
      if (method === "agents.sessions.setStatus") {
        if (!held && args.status === "processing") { held = true; await oldWrite.promise; }
        accepted.push(args.status);
      }
      return { ok: true };
    };
    const options = { botUserId: "U_BOT", teamId: `T_STEER_CLEANUP_${engine}` };
    const first = processMessageEvent({ type: "message", channel, channel_type: "im", user,
      text: "first cleanup fixture", ts: thread }, client, options);
    let second;
    try {
      await ready.promise;
      assert.equal(held, true);
      second = processMessageEvent({ type: "message", channel, channel_type: "im", user,
        text: "steered cleanup successor", thread_ts: thread, ts: "9100.402" }, client, { ...options, busyChoice: "steer" });
      await exited.promise;
      // The child has already exited; only the old Slack write remains. This delay is shorter
      // than the existing one-second stop grace, so it must not promote the queued successor.
      const settledEarly = await Promise.race([first.then(() => true), delay(100).then(() => false)]);
      assert.equal(settledEarly, false, "the second stop() must await the original cleanup, not just its stream chain");
      assert.equal(spawns, 1);
      assert.equal(runQueue.count(`${slug}::${thread}`), 2);
      oldWrite.resolve();
      await first;
      await successorReady.promise;
      assert.equal(spawns, 2);
      assert.equal(accepted.at(-1), "processing", "the old clear lands before the successor starts processing");
      assert.ok(accepted.indexOf("active") < accepted.lastIndexOf("processing"));
    } finally {
      oldWrite.resolve();
      await first;
      if (second) {
        await successorReady.promise;
        await stopRunsInChannel(client, channel, slug, user, thread);
        await second;
      }
      await useFakeRuntime(null);
    }
  });
}
