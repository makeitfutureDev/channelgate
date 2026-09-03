import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Slack and MCP update entry points delegate to the shared transactional starter", () => {
  // The in-thread /update command lives in the message pipeline; app.js keeps the confirmation
  // watcher. Both must go through the shared transactional starter, so check them together.
  const slack =
    readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8") +
    readFileSync(new URL("../src/slack/message-pipeline.js", import.meta.url), "utf8");
  const mcp = readFileSync(new URL("../src/mcp/tools/channel-admin.js", import.meta.url), "utf8");

  assert.doesNotMatch(slack, /function triggerUpdate/);
  assert.doesNotMatch(slack, /writeUpdateMarker/);
  assert.match(slack, /startUpdate\(\{[\s\S]*source:\s*"slack"[\s\S]*context:/);
  assert.match(slack, /readTerminalUpdateMarker/);
  assert.match(slack, /formatUpdateResult/);

  assert.doesNotMatch(mcp, /writeUpdateMarker/);
  assert.match(mcp, /startUpdate\(\{[\s\S]*source:\s*"mcp"[\s\S]*context:/);
});

test("the admin UI follows its transaction status instead of treating any reboot as success", () => {
  const ui = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(ui, /started\.transaction\.id/);
  assert.match(ui, /health\.update/);
  assert.match(ui, /transaction\.requiredDiskBytes/);
  assert.match(ui, /transaction\.result === "rolled_back"/);
  assert.match(ui, /transaction\.result === "refused"/);
  assert.doesNotMatch(ui, /let sawDown/);
});
