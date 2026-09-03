import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { componentRow, insertComponent, readUsage, recordUsage, usageSummary } = await import("../src/gateway/usage.js");
const { getDb } = await import("../src/db/index.js");

test("canonical root and native-child components replace cumulative raw tokens without adding runs", async () => {
  await recordUsage({
    channelId: "C_USAGE",
    slug: "usage-test",
    authorId: "U_USAGE",
    engine: "codex",
    model: "gpt-5.6-sol",
    result: {
      engine: "codex",
      model: "gpt-5.6-sol",
      usage: { input_tokens: 1_000, cached_input_tokens: 500, output_tokens: 10 },
      usageAccounting: {
        root: {
          sourceId: "codex-turn:root:turn",
          sessionId: "root",
          model: "gpt-5.6-sol",
          usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 2 },
          requests: [{ model: "gpt-5.6-sol", usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 2 } }],
        },
        children: [{
          sourceId: "codex-child:child",
          sessionId: "child",
          parentSessionId: "root",
          model: "gpt-5.6-sol",
          usage: { input_tokens: 40, cached_input_tokens: 20, output_tokens: 1 },
          requests: [{ model: "gpt-5.6-sol", usage: { input_tokens: 40, cached_input_tokens: 20, output_tokens: 1 } }],
        }],
      },
    },
  });
  const records = await readUsage({ channelId: "C_USAGE" });
  assert.equal(records.length, 1);
  assert.equal(records[0].tokensIn, 140);
  assert.equal(records[0].tokensOut, 3);
  assert.equal(records[0].runtimeModel, "gpt-5.6-sol");
  const summary = await usageSummary();
  const row = summary.byChannel.find((item) => item.key === "C_USAGE");
  assert.equal(row.runs, 1);
  assert.equal(row.tokensIn + row.tokensOut, 143);

  const db = getDb();
  const usageId = Number(db.prepare("SELECT id FROM usage WHERE channel_id = ?").get("C_USAGE").id);
  const replacement = componentRow({
    sourceId: "codex-turn:root:turn",
    sessionId: "root",
    model: "gpt-5.6-sol",
    usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 2 },
    requests: [{ model: "gpt-5.6-sol", usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 2 } }],
  });
  db.exec("BEGIN IMMEDIATE");
  insertComponent(db, usageId, replacement);
  insertComponent(db, usageId, replacement);
  db.exec("COMMIT");
  const componentId = db.prepare("SELECT id FROM usage_components WHERE source_key = ?").get(replacement.sourceKey).id;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_requests WHERE component_id = ?").get(componentId).n, 1);
});
