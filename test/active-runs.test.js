import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  activeRunForApi,
  clearActiveRun,
  listActiveRuns,
  recordActiveRun,
  updateActiveRunRuntime,
} = await import("../src/gateway/active-runs.js");

test("runtime enrichment preserves the recoverable active-run payload", () => {
  const id = "dm-alex::thread::message";
  recordActiveRun(id, {
    channelId: "D123",
    slug: "dm-U04MC5JQ51B",
    authorId: "U04MC5JQ51B",
    threadKey: "123.456",
    text: "private prompt",
    attachments: ["uploads/example.png"],
    startedAt: 1_720_000_000_000,
  });

  assert.equal(updateActiveRunRuntime(id, { engine: "claude", model: "claude-opus-4-8" }), true);
  const stored = listActiveRuns().find((run) => run.id === id);
  assert.equal(stored.engine, "claude");
  assert.equal(stored.model, "claude-opus-4-8");
  assert.equal(stored.text, "private prompt");
  assert.deepEqual(stored.attachments, ["uploads/example.png"]);

  // A mid-turn fallback replaces only the runtime metadata.
  assert.equal(updateActiveRunRuntime(id, { engine: "codex", model: "gpt-5.4" }), true);
  const fallback = listActiveRuns().find((run) => run.id === id);
  assert.equal(fallback.engine, "codex");
  assert.equal(fallback.model, "gpt-5.4");
  assert.equal(fallback.text, "private prompt");

  clearActiveRun(id);
});

test("active-run API projection resolves DM names and omits recovery secrets", () => {
  const view = activeRunForApi(
    {
      id: "run-1",
      channelId: "D123",
      slug: "dm-U04MC5JQ51B",
      authorId: "U04MC5JQ51B",
      engine: "claude",
      model: "claude-opus-4-8[1m]",
      startedAt: 1234,
      text: "must never reach the browser",
      attachments: ["secret-file"],
    },
    {
      channels: { D123: { name: "dm-U04MC5JQ51B", slug: "dm-U04MC5JQ51B", type: "im", isDM: true } },
      users: { U04MC5JQ51B: { name: "Alex Doe" } },
    }
  );

  assert.equal(view.channelName, "Alex Doe (DM)");
  assert.equal(view.authorName, "Alex Doe");
  assert.equal(view.engineName, "Claude");
  assert.equal(view.modelName, "Opus 4.8 1M");
  assert.equal("text" in view, false);
  assert.equal("attachments" in view, false);
});

test("active-run API projection keeps ordinary channel names", () => {
  const view = activeRunForApi(
    { id: "run-2", channelId: "C123", slug: "ops", authorId: "U1", engine: "codex", model: "gpt-5.4" },
    {
      channels: { C123: { name: "#ops", slug: "ops", type: "channel", isDM: false } },
      users: { U1: { name: "Alex Doe" } },
    }
  );

  assert.equal(view.channelName, "#ops");
  assert.equal(view.engineName, "Codex");
  assert.equal(view.modelName, "gpt-5.4");
});

test("active-run API projection identifies an unpinned CLI model", () => {
  const view = activeRunForApi({ id: "run-3", channelId: "C1", authorId: "U1", engine: "claude", model: "" });
  assert.equal(view.engineName, "Claude");
  assert.equal(view.modelName, "CLI default");
});
