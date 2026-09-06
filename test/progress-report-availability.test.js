import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createScopedRunEventHandler } = await import("../src/gateway/run.js");

const source = async (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("runMessage defaults progress report off and threads the opt-in through both engines", async () => {
  const [run, adapters, engineMcp] = await Promise.all([
    source("src/gateway/run.js"),
    source("src/engines/adapters.js"),
    source("src/gateway/run-engine-mcp.js"),
  ]);

  assert.match(run, /export async function runMessage\(\{[^}]*progressReport = false/);
  assert.match(run, /const mcpRuntimeInput = \{[\s\S]*?progressReport: progressReportEnabled/);
  // `target` rides alongside `engine`: mcp.js needs both to pick the gateway server entry (the
  // checkout's stdio server on the host, the in-container bridge for an isolated runtime).
  assert.match(engineMcp, /buildMcpConfig\(\{ \.\.\.identity, engine, target \}\)/);
  assert.match(run, /progressReport: progressReportEnabled,/);
  assert.ok((run.match(/progressReport: progressReportEnabled/g) || []).length >= 2);
  assert.match(adapters, /progressReport: r\.progressReport/);
  assert.ok((run.match(/onEvent: scopedOnEvent/g) || []).length >= 2);
});

test("run event boundary suppresses hidden progress reports without dropping ordinary progress", () => {
  const reportEvent = {
    kind: "report_progress",
    title: "Hidden",
    steps: [{ id: "stage", title: "Stage", status: "pending", details: "", output: "", sources: [] }],
  };
  const toolEvent = { kind: "tool_use", name: "Read" };

  for (const options of [
    { progressReport: false, clean: false },
    { progressReport: true, clean: true },
  ]) {
    const events = [];
    const onEvent = createScopedRunEventHandler((event) => events.push(event), options);
    onEvent(reportEvent);
    onEvent(toolEvent);
    assert.deepEqual(events, [toolEvent]);
    assert.equal(events[0], toolEvent);
  }
});

test("run event boundary forwards progress reports for visible non-clean runs", () => {
  const events = [];
  const reportEvent = {
    kind: "report_progress",
    title: "Visible",
    steps: [{ id: "stage", title: "Stage", status: "pending", details: "", output: "", sources: [] }],
  };
  const onEvent = createScopedRunEventHandler((event) => events.push(event), {
    progressReport: true,
    clean: false,
  });

  onEvent(reportEvent);
  assert.deepEqual(events, [reportEvent]);
});

test("live foreground Slack and restart recovery keep the progress-report launch capability", async () => {
  const [slack, activeRuns, apiRuns] = await Promise.all([
    source("src/slack/message-pipeline.js"),
    source("src/gateway/active-runs.js"),
    source("src/gateway/api-runs.js"),
  ]);

  assert.match(slack, /const runArgs = \{[\s\S]*?progressReport: true/);
  assert.match(activeRuns, /progressReport: true/);
  assert.match(apiRuns, /progressReport: Boolean\(status && client\)/);
});

test("non-visible runMessage callers rely on the false default", async () => {
  const callers = await Promise.all([
    "src/gateway/background.js",
    "src/gateway/scheduler.js",
    "src/gateway/diagnosis.js",
  ].map(source));

  for (const caller of callers) {
    assert.match(caller, /runMessage\(\{/);
    assert.doesNotMatch(caller, /progressReport\s*:/);
  }
});

test("runMessage threads one per-channel Make toolbox through Claude, Codex, and fallback", async () => {
  const [run, adapters, engineMcp] = await Promise.all([
    source("src/gateway/run.js"),
    source("src/engines/adapters.js"),
    source("src/gateway/run-engine-mcp.js"),
  ]);

  assert.match(run, /makeToolboxUrl:\s*meta\.makeToolboxUrl/);
  assert.match(run, /makeToolboxKey:\s*meta\.makeToolboxKey/);
  assert.match(run, /const mcpRuntimeInput = \{[\s\S]*?makeToolboxUrl, makeToolboxKey/);
  // `target` rides alongside `engine`: mcp.js needs both to pick the gateway server entry (the
  // checkout's stdio server on the host, the in-container bridge for an isolated runtime).
  assert.match(engineMcp, /buildMcpConfig\(\{ \.\.\.identity, engine, target \}\)/);
  assert.ok((run.match(/makeToolboxUrl, makeToolboxKey/g) || []).length >= 2);
  assert.match(adapters, /makeToolboxUrl: r\.makeToolboxUrl, makeToolboxKey: r\.makeToolboxKey/);
});
