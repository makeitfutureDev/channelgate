// A run's CG_THREAD_KEY is its SESSION key, not a Slack thread_ts. Scheduled runs use
// `sched-<id>-<ts>`, background agents `<realTs>::agent-<id>`, and API jobs their own shapes.
// The Slack-posting MCP tools (slack_post_table / slack_post_chart / slack_upload_snippet, and the
// updater's result post) passed that key straight through as `thread_ts`, so every one of them
// returned invalid_thread_ts from a scheduled or background run — the agent was told the table had
// been posted while Slack had rejected it. They now share the exact resolver the approval cards
// use: a real ts stays the thread, a derived key falls back to its launching thread, and a fully
// synthetic key posts TOP-LEVEL (empty thread_ts) instead of failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { isSlackTs, slackThreadFor } = await import("../src/slack/thread-keys.js");
const approvals = await import("../src/slack/approvals.js");

const src = (rel) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", rel);

test("the resolver maps every session-key shape the gateway actually builds", () => {
  // A live Slack turn: the key IS the thread.
  assert.equal(slackThreadFor("1700000000.000100"), "1700000000.000100");
  // A background agent (background.js) — post into the thread that launched it.
  assert.equal(slackThreadFor("1700000000.000100::agent-ab12cd34"), "1700000000.000100");
  // A fallback turn (run.js `${threadKey}::${engine}-fallback`) — same thread.
  assert.equal(slackThreadFor("1700000000.000100::claude-fallback"), "1700000000.000100");
  // A scheduled run (scheduler.js `sched-<id>-<ts>`) — no thread at all; post top-level.
  assert.equal(slackThreadFor("sched-9f2c1a7b-1700000000.000100"), null);
  assert.equal(slackThreadFor(""), null);
  assert.equal(slackThreadFor(undefined), null);

  assert.equal(isSlackTs("1700000000.000100"), true);
  assert.equal(isSlackTs("sched-9f2c1a7b-1700000000.000100"), false);
});

test("approvals re-exports the shared resolver, so both surfaces cannot drift apart", () => {
  assert.equal(approvals.slackThreadFor, slackThreadFor);
  assert.equal(approvals.isSlackTs, isSlackTs);
});

// The MCP tool servers run as separate child processes and import the resolver directly. Guard the
// call sites: a raw `process.env.CG_THREAD_KEY` handed to Slack as a thread_ts is the bug itself.
test("no Slack-posting MCP tool passes the raw session key as thread_ts", async () => {
  for (const rel of ["mcp/tools/slack-native.js", "mcp/tools/channel-admin.js"]) {
    const code = await readFile(src(rel), "utf8");
    assert.equal(
      /threadTs:\s*process\.env\.CG_THREAD_KEY/.test(code),
      false,
      `${rel} must resolve CG_THREAD_KEY before using it as a Slack thread_ts`,
    );
    assert.match(code, /slackThreadFor/, `${rel} should use the shared resolver`);
  }
});
