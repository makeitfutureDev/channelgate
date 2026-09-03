import test from "node:test";
import assert from "node:assert/strict";

import { createStreamConsumer } from "../src/engines/stream.js";
import {
  isProgressReportTool,
  normalizeProgressReport,
  progressReportInputSchema,
} from "../src/engines/progress-report.js";

const snapshot = {
  title: "  Customer   onboarding  ",
  steps: [
    {
      id: "collect-context",
      title: "  Collect   the context  ",
      status: "in_progress",
      details: "  Read the customer record.  ",
      output: "  Three meetings found.  ",
      sources: [
        { text: "  CRM record  ", url: "https://example.com/customer" },
      ],
    },
    { id: "  draft  ", title: "Draft the dossier", status: "pending" },
  ],
};

function assertContract(input, valid) {
  assert.equal(progressReportInputSchema.safeParse(input).success, valid);
  assert.equal(normalizeProgressReport(input) !== null, valid);
}

test("progress report helpers recognize supported tool names", () => {
  assert.equal(isProgressReportTool("report_progress"), true);
  assert.equal(isProgressReportTool("mcp__gateway__report_progress"), true);
  assert.equal(isProgressReportTool("mcp__gateway__create_schedule"), false);
});

test("shared schema and normalizer accept object input and trim user-facing strings", () => {
  assertContract(snapshot, true);
  assert.deepEqual(normalizeProgressReport(snapshot), {
    kind: "report_progress",
    title: "Customer   onboarding",
    steps: [
      {
        id: "collect-context",
        title: "Collect   the context",
        status: "in_progress",
        details: "Read the customer record.",
        output: "Three meetings found.",
        sources: [{ url: "https://example.com/customer", text: "CRM record" }],
      },
      {
        id: "draft",
        title: "Draft the dossier",
        status: "pending",
        details: "",
        output: "",
        sources: [],
      },
    ],
  });
});

test("normalizer accepts JSON-string input through the shared contract", () => {
  const input = {
    title: "  Prepare launch  ",
    steps: [{
      id: "  ship  ",
      title: "  Ship release  ",
      status: "complete",
      details: "   ",
    }],
  };
  const normalized = normalizeProgressReport(JSON.stringify(input));

  assert.deepEqual(normalized, {
    kind: "report_progress",
    title: "Prepare launch",
    steps: [{
      id: "ship",
      title: "Ship release",
      status: "complete",
      details: "",
      output: "",
      sources: [],
    }],
  });
});

test("shared contract accepts every maximum boundary", () => {
  const urlPrefix = "https://example.com/";
  const exactUrl = `${urlPrefix}${"u".repeat(2_000 - urlPrefix.length)}`;
  const steps = Array.from({ length: 20 }, (_, index) => {
    const idPrefix = `step-${index}-`;
    return {
      id: `${idPrefix}${"i".repeat(80 - idPrefix.length)}`,
      title: "t".repeat(240),
      status: index === 0 ? "in_progress" : "pending",
      details: "d".repeat(2_000),
      output: "o".repeat(2_000),
      sources: Array.from({ length: 10 }, () => ({ url: exactUrl, text: "s".repeat(240) })),
    };
  });

  assertContract({ title: "p".repeat(80), steps }, true);
});

test("shared contract strictly rejects invalid scalar fields", () => {
  const cases = [
    { title: "   ", steps: [{ id: "step", title: "Step", status: "pending" }] },
    { title: "Plan", steps: [{ id: "   ", title: "Step", status: "pending" }] },
    { title: "Plan", steps: [{ id: "step", title: "   ", status: "pending" }] },
    { title: "x".repeat(81), steps: [{ id: "step", title: "Step", status: "pending" }] },
    { title: "Plan", steps: [{ id: "x".repeat(81), title: "Step", status: "pending" }] },
    { title: "Plan", steps: [{ id: "step", title: "x".repeat(241), status: "pending" }] },
    { title: "Plan", steps: [{ id: "step", title: "Step", status: "unexpected" }] },
    { title: "Plan", steps: [{ id: "step", title: "Step", status: "pending", details: "x".repeat(2_001) }] },
    { title: "Plan", steps: [{ id: "step", title: "Step", status: "pending", output: "x".repeat(2_001) }] },
  ];

  for (const input of cases) assertContract(input, false);
});

test("shared contract rejects duplicate IDs and multiple in-progress steps", () => {
  assertContract({
    title: "Duplicate IDs",
    steps: [
      { id: "same", title: "First", status: "pending" },
      { id: " same ", title: "Second", status: "complete" },
    ],
  }, false);
  assertContract({
    title: "Multiple active",
    steps: [
      { id: "first", title: "First", status: "in_progress" },
      { id: "second", title: "Second", status: "in_progress" },
    ],
  }, false);
});

test("shared contract rejects oversized step and source collections", () => {
  assertContract({
    title: "Too many steps",
    steps: Array.from({ length: 21 }, (_, index) => ({
      id: `step-${index}`,
      title: `Step ${index}`,
      status: "pending",
    })),
  }, false);
  assertContract({
    title: "Too many sources",
    steps: [{
      id: "sources",
      title: "Sources",
      status: "pending",
      sources: Array.from({ length: 11 }, (_, index) => ({
        url: `https://example.com/${index}`,
        text: `Source ${index}`,
      })),
    }],
  }, false);
});

test("shared contract accepts intact HTTP sources and rejects invalid sources", () => {
  const valid = {
    title: "Safe sources",
    steps: [{
      id: "sources",
      title: "Check sources",
      status: "pending",
      sources: [
        { url: "https://example.com/customer?q=active", text: " Customer record " },
        { url: "http://example.com/plain", text: "Plain HTTP" },
      ],
    }],
  };
  assertContract(valid, true);
  assert.deepEqual(normalizeProgressReport(valid).steps[0].sources, [
    { url: "https://example.com/customer?q=active", text: "Customer record" },
    { url: "http://example.com/plain", text: "Plain HTTP" },
  ]);

  for (const source of [
    { url: "/relative/path", text: "Relative" },
    { url: "ftp://example.com/file", text: "FTP" },
    { url: " https://example.com/padded ", text: "Padded" },
    { url: "https://example.com", text: "   " },
    { url: `https://example.com/${"u".repeat(2_000)}`, text: "Too long" },
    { url: "https://example.com", text: "x".repeat(241) },
  ]) {
    assertContract({
      title: "Invalid source",
      steps: [{ id: "source", title: "Source", status: "pending", sources: [source] }],
    }, false);
  }
});

test("normalizer returns null for invalid or empty snapshots", () => {
  for (const input of [null, "", "not json", "[]", {}, { title: "Plan", steps: [] }, { title: "Plan", steps: [null, {}] }]) {
    assert.equal(normalizeProgressReport(input), null);
  }
});

test("Claude stream emits progress report without a generic meta-tool row", () => {
  const events = [];
  const consumer = createStreamConsumer({ onEvent: (event) => events.push(event) });
  const input = JSON.stringify(snapshot);

  consumer.consume({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", name: "mcp__gateway__report_progress" },
    },
  });
  consumer.consume({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: input.slice(0, 80) },
    },
  });
  consumer.consume({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: input.slice(80) },
    },
  });
  consumer.consume({
    type: "stream_event",
    event: { type: "content_block_stop", index: 2 },
  });

  assert.deepEqual(events, [normalizeProgressReport(snapshot)]);
  assert.equal(events.some((event) => event.kind === "tool_use"), false);
});

test("Claude stream preserves TodoWrite structured and generic progress behavior", () => {
  const events = [];
  const consumer = createStreamConsumer({ onEvent: (event) => events.push(event) });

  consumer.consume({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 4,
      content_block: { type: "tool_use", name: "TodoWrite" },
    },
  });
  consumer.consume({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 4,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          todos: [
            { content: "Inspect context", status: "completed" },
            { activeForm: "Implementing", status: "in_progress" },
          ],
        }),
      },
    },
  });
  consumer.consume({
    type: "stream_event",
    event: { type: "content_block_stop", index: 4 },
  });

  assert.deepEqual(events, [
    {
      kind: "todos",
      items: [
        { content: "Inspect context", status: "completed" },
        { content: "Implementing", status: "in_progress" },
      ],
    },
    { kind: "tool_use", name: "TodoWrite", target: "" },
  ]);
});

test("Claude stream normalizes Agent launch and task progress to one stable activity row", () => {
  const events = [];
  const consumer = createStreamConsumer({ onEvent: (event) => events.push(event) });
  const input = JSON.stringify({
    description: "Check Codex events",
    prompt: "Inspect the current Codex lifecycle payloads.",
    subagent_type: "researcher",
  });

  consumer.consume({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 7,
      content_block: { type: "tool_use", id: "toolu_agent_1", name: "Agent" },
    },
  });
  consumer.consume({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 7,
      delta: { type: "input_json_delta", partial_json: input },
    },
  });
  consumer.consume({
    type: "stream_event",
    event: { type: "content_block_stop", index: 7 },
  });
  consumer.consume({
    type: "system",
    subtype: "task_started",
    task_id: "task-claude-1",
    tool_use_id: "toolu_agent_1",
    description: "Check Codex events",
    task_type: "local_agent",
  });
  consumer.consume({
    type: "system",
    subtype: "task_progress",
    task_id: "task-claude-1",
    subagent_type: "researcher",
    description: "Inspecting lifecycle events",
    last_tool_name: "Read",
    usage: { total_tokens: 39_900, tool_uses: 4, duration_ms: 9_200 },
  });
  consumer.consume({
    type: "system",
    subtype: "task_notification",
    task_id: "task-claude-1",
    status: "completed",
    summary: "Found both event families.",
    usage: { total_tokens: 46_200, tool_uses: 6, duration_ms: 12_000 },
  });

  assert.equal(events.some((event) => event.kind === "tool_use" && event.name === "Agent"), false);
  assert.deepEqual(events, [
    {
      kind: "agent_activity",
      id: "toolu_agent_1",
      engine: "claude",
      name: "researcher",
      description: "Check Codex events",
      status: "running",
    },
    {
      kind: "agent_activity",
      id: "toolu_agent_1",
      engine: "claude",
      description: "Check Codex events",
      status: "running",
    },
    {
      kind: "agent_activity",
      id: "toolu_agent_1",
      engine: "claude",
      name: "researcher",
      description: "Inspecting lifecycle events",
      status: "running",
      elapsedMs: 9_200,
      tokens: 39_900,
      toolUses: 4,
      lastTool: "Read",
    },
    {
      kind: "agent_activity",
      id: "toolu_agent_1",
      engine: "claude",
      description: "Found both event families.",
      status: "completed",
      elapsedMs: 12_000,
      tokens: 46_200,
      toolUses: 6,
    },
  ]);
});

test("Claude stream maps task failure and tool progress without requiring optional metadata", () => {
  const events = [];
  const consumer = createStreamConsumer({ onEvent: (event) => events.push(event) });

  consumer.consume({
    type: "system",
    subtype: "task_started",
    task_id: "task-claude-2",
    description: "Run a bounded check",
  });
  consumer.consume({
    type: "tool_progress",
    task_id: "task-claude-2",
    tool_name: "Bash",
    elapsed_time_seconds: 3.4,
  });
  consumer.consume({
    type: "system",
    subtype: "task_updated",
    task_id: "task-claude-2",
    patch: { status: "failed", error: "command failed" },
  });

  assert.deepEqual(events, [
    {
      kind: "agent_activity",
      id: "task-claude-2",
      engine: "claude",
      description: "Run a bounded check",
      status: "running",
    },
    {
      kind: "agent_activity",
      id: "task-claude-2",
      engine: "claude",
      status: "running",
      elapsedMs: 3_400,
      lastTool: "Bash",
    },
    {
      kind: "agent_activity",
      id: "task-claude-2",
      engine: "claude",
      description: "command failed",
      status: "failed",
    },
  ]);
});
