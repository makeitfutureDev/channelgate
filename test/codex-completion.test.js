import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";
import { createFakeRuntime } from "./fixtures/fake-runtime-backend.js";

ensureTestEnv();
const { runCodex } = await import("../src/engines/codex.js");
const message = (text, phase) => ({ type: "item.completed", item: { id: text, type: "agent_message", text, ...(phase ? { phase } : {}) } });
const completed = { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } };

async function simulate({ events = [], output, code = 0, signal = null, stderr = "", setup } = {}) {
  const runtime = createFakeRuntime();
  const artifactDir = tempDir("cg-codex-completion-");
  const target = runtime.target({ artifactDir });
  let streamed = "";
  // Attach the rejection handler immediately: the fake close event can reject synchronously.
  const pending = runCodex({ cwd: artifactDir, prompt: "synthetic completion fixture", sessionId: "", isNewSession: true, clean: true, target, artifactDir, timeoutMs: 60_000, onDelta: (delta) => { streamed += delta; } })
    .then((result) => ({ result }), (error) => ({ error }));
  for (let attempt = 0; !runtime.spawns.length && attempt < 200; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtime.spawns.length, 1, "only the fake backend spawns");
  if (setup) await setup(runtime, artifactDir);
  const args = runtime.spawns[0].args;
  if (output !== undefined) await writeFile(args[args.indexOf("-o") + 1], output);
  const child = runtime.children[0];
  child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "completion-fixture" })}\n`);
  for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
  if (stderr) child.stderr.write(`${stderr}\n`);
  child.emit("close", code, signal);
  const outcome = await pending;
  assert.deepEqual(await readdir(path.join(artifactDir, "tmp")), [], "scratch output is removed on every outcome");
  return { ...outcome, streamed, runtime };
}

test("Codex explicit terminal failures beat output-file text and retain partial evidence", async () => {
  for (const type of ["turn.failed", "error"]) {
    const { error, result } = await simulate({ output: "Partial answer", events: [completed, { type, error: { message: "synthetic terminal failure" } }] });
    assert.equal(result, undefined);
    assert.match(error.message, /synthetic terminal failure/);
    assert.equal(error.details.partialContent, "Partial answer");
    assert.equal(error.details.sessionId, "completion-fixture");
    assert.equal(error.details.usage.output_tokens, 4);
    assert.equal(error.details.replaySafe, false);
  }
});

test("Codex nonzero and signalled exits beat a completed event and populated output file", async () => {
  for (const exit of [{ code: 1 }, { code: null, signal: "SIGTERM" }]) {
    const { error } = await simulate({ ...exit, events: [completed], output: "Partial answer" });
    assert.ok(error);
    assert.equal(error.details.partialContent, "Partial answer");
    assert.equal(error.details.exitCode, exit.code);
    assert.equal(error.details.signal, exit.signal || null);
    assert.equal(error.details.replaySafe, false);
  }
});

test("Codex output-file-only provider failure is never replay safe", async () => {
  const { error } = await simulate({ code: 1, output: "Some work already happened", stderr: "Your usage limit has been reached" });
  assert.ok(error);
  assert.equal(error.details.replaySafe, false);
});

test("Codex clean exits without terminal completion reject commentary, final text and output files", async () => {
  for (const fixture of [
    { events: [message("I will finish the checks now.", "commentary")] },
    { events: [message("A claimed answer", "final_answer")] },
    { output: "A saved answer" },
    {},
  ]) {
    const { error, result } = await simulate(fixture);
    assert.equal(result, undefined);
    assert.match(error.message, /before reporting.*completed/);
    assert.equal(error.details.incompleteTurn, true);
    assert.equal(error.details.replaySafe, false);
  }
});

test("Codex completed commentary stays live progress and yields an empty answer", async () => {
  const { result, streamed } = await simulate({ events: [message("Checking remaining items.", "commentary"), completed], output: "Checking remaining items." });
  assert.equal(streamed, "Checking remaining items.");
  assert.equal(result.content, "");
});

test("Codex phase-aware final fallback excludes commentary while legacy messages remain supported", async () => {
  for (const phase of ["final", "final_answer"]) {
    const { result, streamed } = await simulate({ events: [message("Working…", "commentary"), message("Done.", phase), completed] });
    assert.equal(result.content, "Done.");
    assert.match(streamed, /Working…/);
    assert.match(streamed, /Done\./);
  }
  const legacy = await simulate({ events: [message("Legacy answer"), completed] });
  assert.equal(legacy.result.content, "Legacy answer");
  const nestedUsage = await simulate({ events: [message("Legacy nested usage"), { type: "turn.completed", turn: { usage: { input_tokens: 8, output_tokens: 3 } } }] });
  assert.equal(nestedUsage.result.usage.output_tokens, 3);
  const output = await simulate({ output: "Authoritative answer", events: [message("Streamed answer", "final_answer"), completed] });
  assert.equal(output.result.content, "Authoritative answer");
});

test("Codex phase carried only by the message start still separates streamed final text", async () => {
  const events = [];
  for (const [id, phase, text] of [["progress", "commentary", "Still checking"], ["answer", "final_answer", "All checked"]]) {
    events.push({ type: "item.started", item: { id, type: "agent_message", phase } });
    events.push({ type: "agent_message_delta", item_id: id, delta: { text } });
  }
  events.push(completed);
  const { result, streamed } = await simulate({ events });
  assert.equal(result.content, "All checked");
  assert.match(streamed, /Still checking/);
});


test("Codex phase arriving at completed-message time classifies already streamed text", async () => {
  const { result } = await simulate({ events: [
    { type: "agent_message_delta", item_id: "progress", delta: { text: "Still checking" } },
    { type: "item.completed", item: { id: "progress", type: "agent_message", phase: "commentary", text: "Still checking" } },
    { type: "agent_message_delta", item_id: "answer", delta: { text: "Done" } },
    { type: "item.completed", item: { id: "answer", type: "agent_message", phase: "final_answer", text: "Done" } },
    completed,
  ] });
  assert.equal(result.content, "Done");
});


test("Codex failure without terminal usage preserves root and child rollout accounting", async () => {
  const { reduceCodexUsage } = await import("../src/engines/codex-usage.js");
  const { error } = await simulate({
    code: 1,
    events: [message("Checks are running", "commentary"), { type: "turn.failed", error: { message: "synthetic execution failure" } }],
    async setup(runtime, artifactDir) {
      const stateDir = path.join(artifactDir, "state");
      const day = path.join(stateDir, "sessions", "2026", "09", "08");
      await mkdir(day, { recursive: true });
      const timestamp = new Date().toISOString();
      const rollout = (id, tokens, parent) => [
        { timestamp, type: "session_meta", payload: { id, timestamp, ...(parent ? { parent_thread_id: parent, agent_path: "/root/reviewer" } : {}) } },
        { timestamp, type: "turn_context", payload: { model: "gpt-5.6-codex" } },
        { timestamp, type: "event_msg", payload: { type: "task_started", started_at: Math.floor(Date.now() / 1000) } },
        { timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: tokens, last_token_usage: tokens } } },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n";
      await writeFile(path.join(day, "rollout-2026-09-08-completion-fixture.jsonl"), rollout("completion-fixture", { input_tokens: 120, output_tokens: 35 }));
      await writeFile(path.join(day, "rollout-2026-09-08-child-reviewer.jsonl"), rollout("child-reviewer", { input_tokens: 80, output_tokens: 20 }, "completion-fixture"));
      runtime.backend.inspectUsage = (_target, { args }) => reduceCodexUsage({ ...args, stateDir });
    },
  });
  assert.match(error.message, /synthetic execution failure/);
  assert.equal(error.details.usage.output_tokens, 35);
  const result = error.details.result;
  assert.equal(result.runtimeModel, "gpt-5.6-codex");
  assert.equal(result.usageRequests.length, 1);
  assert.equal(result.usageRequests[0].usage.output_tokens, 35);
  assert.equal(result.usageAccounting.children.length, 1);
  assert.equal(result.usageAccounting.children[0].usage.output_tokens, 20);
  assert.equal(result.usageAccounting.children[0].sessionId, "child-reviewer");
  assert.equal(error.details.replaySafe, false);
});
