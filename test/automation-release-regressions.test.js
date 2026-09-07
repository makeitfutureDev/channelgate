import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const [{ applyMemoryOperations }, { getDb, toJson }, { createDurableInbox }, { registerTransport, unregisterTransport }, scheduler, schedules, { recoverApiRuns, getApiJob }] = await Promise.all([
  import("../src/gateway/channel-memory.js"), import("../src/db/index.js"), import("../src/platforms/durable-inbox.js"),
  import("../src/platforms/live.js"), import("../src/gateway/scheduler.js"), import("../src/config/schedules.js"), import("../src/gateway/api-runs.js"),
]);
const waitFor = async (predicate) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), "expected asynchronous state was reached");
};
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test("parallel memory adds from independent processes retain every fact", async () => {
  const cwd = tempDir("cg-test-memory-writers-");
  const module = new URL("../src/gateway/channel-memory.js", import.meta.url).href;
  const workers = Array.from({ length: 6 }, (_, worker) => new Promise((resolve, reject) => {
    const source = `import { applyMemoryOperations } from ${JSON.stringify(module)}; for(let n=0;n<8;n++) await applyMemoryOperations(${JSON.stringify(cwd)}, {}, [{action:"add",text:"Worker ${worker} fact "+n}]);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(errors)));
  }));
  await Promise.all(workers);
  const text = await readFile(path.join(cwd, "MEMORY.md"), "utf8");
  assert.equal(new Set(text.trim().split("\n")).size, 48);
});

test("a failed topic publication restores earlier files in the same batch", async () => {
  const cwd = tempDir("cg-test-memory-rollback-");
  await mkdir(path.join(cwd, "memory", "blocked.md"), { recursive: true });
  await writeFile(path.join(cwd, "memory", "first.md"), "original\n");
  await assert.rejects(applyMemoryOperations(cwd, {}, [
    { action: "write_topic", topic: "first", content: "replacement" },
    { action: "write_topic", topic: "blocked", content: "cannot publish" },
  ]));
  assert.equal(await readFile(path.join(cwd, "memory", "first.md"), "utf8"), "original\n");
});

function fakeConnector(posts = []) {
  return { platform: "googlechat", capabilities: {}, ready: () => true,
    post: async (payload) => { posts.push(payload); return { messageId: "spaces/A/messages/notice", threadKey: "spaces/A/threads/thread" }; },
    directory: async () => null,
  };
}

test("a Chat schedule retries its saved result with Slack disconnected, without reexecuting tools", async () => {
  const posts = [];
  registerTransport("googlechat", { getConnector: () => fakeConnector(posts) });
  const timer = scheduler.startScheduler({ immediate: false, slack: { snapshot: () => ({ connected: false }) } });
  let executions = 0;
  const sched = schedules.addSchedule({ channelId: "gchat:spaces/A", slug: "chat", createdBy: "someone", prompt: "fixture", once: true, runAt: new Date().toISOString() });
  const deps = { runner: async () => { executions++; return { engine: "claude", content: "saved answer" }; }, deliver: async () => { throw new Error("delivery outage"); } };
  try {
    await scheduler.runSchedule(sched, deps);
    const saved = schedules.getSchedules().find((item) => item.id === sched.id);
    assert.equal(saved.pendingDelivery.content, "saved answer");
    assert.equal(saved.executionState, "completed");
    await scheduler.runSchedule(saved, { ...deps, deliver: async (_target, { result }) => posts.push(result) });
    assert.equal(executions, 1);
    assert.equal(posts.at(-1).content, "saved answer");
    assert.equal(schedules.getSchedules().some((item) => item.id === sched.id), false);
  } finally { clearInterval(timer); unregisterTransport("googlechat"); }
});

test("an unknown scheduled execution is paused instead of replayed after restart", async () => {
  registerTransport("googlechat", { getConnector: () => fakeConnector() });
  const sched = schedules.addSchedule({ channelId: "gchat:spaces/A", slug: "chat", prompt: "fixture", once: true, runAt: new Date().toISOString() });
  schedules.updateSchedule(sched.id, { executionState: "running", runAttempts: 1 });
  let executions = 0;
  try {
    await scheduler.runSchedule(schedules.getSchedules().find((item) => item.id === sched.id), { runner: async () => { executions++; } });
    const saved = schedules.getSchedules().find((item) => item.id === sched.id);
    assert.equal(saved.enabled, false);
    assert.equal(saved.executionState, "interrupted");
    assert.equal(executions, 0);
  } finally { schedules.deleteSchedule(sched.id); unregisterTransport("googlechat"); }
});

test("API recovery retries delivery checkpoints and never executes an interrupted request", async () => {
  const db = getDb();
  const insert = (job) => db.prepare("INSERT INTO api_jobs(id,status,created_ms,data) VALUES(?,?,?,?)").run(job.id, job.status, Date.now(), toJson({ ...job, createdMs: Date.now() }));
  insert({ id: "release-api-unknown", status: "running", textForRun: "side effects may have happened" });
  insert({ id: "release-api-output", status: "completed", slackThread: true, channelId: "C_TEST", threadKey: "123.000100", deliveryPending: true, result: { content: "durable result" } });
  let delivered = 0;
  const slack = { snapshot: () => ({ connected: true }), getClient: () => ({}) };
  await recoverApiRuns({ slack, deliver: async () => { throw new Error("offline"); } });
  assert.equal(getApiJob("release-api-unknown").status, "interrupted");
  assert.match(getApiJob("release-api-unknown").error, /not run again/);
  assert.equal(getApiJob("release-api-output").deliveryPending, true);
  await recoverApiRuns({ slack, deliver: async (_target, args) => { assert.equal(args.result.content, "durable result"); delivered++; } });
  await recoverApiRuns({ slack, deliver: async () => { delivered++; } });
  assert.equal(delivered, 1);
});

test("durable intake isolates conversations, orders each conversation, and stops without waiting for engines", async () => {
  const gate = deferred();
  const seen = [];
  const inbox = createDurableInbox({ namespace: "test-conversations", handle: async (event) => { seen.push(event.id); if (event.id === "a1") await gate.promise; } });
  inbox.start();
  inbox.accept({ id: "a1", conversationId: "A", payload: { id: "a1" } });
  inbox.accept({ id: "a2", conversationId: "A", payload: { id: "a2" } });
  inbox.accept({ id: "b1", conversationId: "B", payload: { id: "b1" } });
  await waitFor(() => seen.includes("b1"));
  assert.deepEqual(seen, ["a1", "b1"]);
  assert.equal(getDb().prepare("SELECT status FROM inbound_events WHERE namespace = ? AND event_id = ?").get("test-conversations", "a2").status, "queued");
  inbox.stop();
  assert.throws(() => inbox.accept({ id: "c", conversationId: "C", payload: {} }), /stopped/);
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(seen.includes("a2"), false, "stopped dispatchers do not start queued work");
  const recovered = createDurableInbox({ namespace: "test-conversations", handle: async (event) => { seen.push(event.id); } });
  recovered.start();
  await waitFor(() => seen.includes("a2"));
  assert.equal(recovered.accept({ id: "a1", conversationId: "A", payload: {} }).duplicate, true);
  recovered.stop();
});

test("inbox restart reports unknown running work and resumes only queued work", async () => {
  const db = getDb();
  for (const [id, status] of [["unknown", "running"], ["safe", "queued"]]) db.prepare("INSERT INTO inbound_events(namespace,event_id,conversation_id,status,created_ms,owner,data) VALUES(?,?,?,?,?,?,?)").run("test-recovery", id, id, status, Date.now(), "dead-daemon", toJson({ id }));
  const handled = [], notices = [];
  const inbox = createDurableInbox({ namespace: "test-recovery", handle: async ({ id }) => { handled.push(id); }, interrupted: async ({ id }) => { notices.push(id); } });
  inbox.start();
  await waitFor(() => handled.length === 1 && notices.length === 1);
  inbox.stop();
  assert.deepEqual(handled, ["safe"]);
  assert.deepEqual(notices, ["unknown"]);
});

test("a delivered one-time checkpoint is retired without running the task again", async () => {
  registerTransport("googlechat", { getConnector: () => fakeConnector() });
  const sched = schedules.addSchedule({ channelId: "gchat:spaces/A", slug: "chat", prompt: "fixture", once: true, runAt: new Date().toISOString() });
  schedules.updateSchedule(sched.id, { executionState: "delivered", runAttempts: 1 });
  let executions = 0;
  try {
    await scheduler.runSchedule(schedules.getSchedules().find((item) => item.id === sched.id), { runner: async () => { executions++; } });
    assert.equal(executions, 0);
    assert.equal(schedules.getSchedules().some((item) => item.id === sched.id), false);
  } finally { unregisterTransport("googlechat"); }
});
