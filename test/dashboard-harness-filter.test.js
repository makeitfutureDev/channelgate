import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { usageDashboard } = await import("../src/gateway/usage.js");
const { recordSkillUsage, usageCountsBySlug } = await import("../src/gateway/skills/catalog.js");

function addUsage({ engine, channelId, slug, authorId, tokensIn, tokensOut, cost }) {
  // Keep fixtures strictly inside usageDashboard's [start, now) window. A timestamp created in the
  // same millisecond as the dashboard snapshot is intentionally equal to its exclusive end bound
  // and made this test timing-dependent on fast CI runners.
  const ts = new Date(Date.now() - 1_000).toISOString();
  getDb().prepare(
    `INSERT INTO usage(ts, channel_id, slug, author_id, engine, model, task_kind,
       tokens_in, tokens_out, cost_usd, cost_estimated, duration_ms)
     VALUES(?, ?, ?, ?, ?, ?, 'interactive', ?, ?, ?, ?, 1000)`,
  ).run(
    ts, channelId, slug, authorId, engine,
    engine === "claude" ? "claude-sonnet-4-6" : "gpt-5.6-sol",
    tokensIn, tokensOut, cost, engine === "codex" ? 1 : 0,
  );
}

test("dashboard harness scope filters every usage rollup and splits Claude/Codex cost", () => {
  addUsage({ engine: "claude", channelId: "C_CLAUDE", slug: "claude-room", authorId: "U_CLAUDE", tokensIn: 100, tokensOut: 10, cost: 1.25 });
  addUsage({ engine: "codex", channelId: "C_CODEX", slug: "codex-room", authorId: "U_CODEX", tokensIn: 200, tokensOut: 20, cost: 2.75 });

  const all = usageDashboard({ range: "today" });
  assert.equal(all.harness, "all");
  assert.deepEqual(
    { runs: all.totals.runs, tokens: all.totals.tokens, cost: all.totals.cost, claudeCost: all.totals.claudeCost, codexCost: all.totals.codexCost },
    { runs: 2, tokens: 330, cost: 4, claudeCost: 1.25, codexCost: 2.75 },
  );
  assert.equal(all.series.reduce((sum, row) => sum + row.runs, 0), 2);
  assert.deepEqual(all.byUser.map((row) => row.userId).sort(), ["U_CLAUDE", "U_CODEX"]);
  assert.deepEqual(all.byChannel.map((row) => row.channelId).sort(), ["C_CLAUDE", "C_CODEX"]);

  const claude = usageDashboard({ range: "today", harness: "claude" });
  assert.equal(claude.harness, "claude");
  assert.deepEqual(
    { runs: claude.totals.runs, tokens: claude.totals.tokens, cost: claude.totals.cost, claudeCost: claude.totals.claudeCost, codexCost: claude.totals.codexCost },
    { runs: 1, tokens: 110, cost: 1.25, claudeCost: 1.25, codexCost: 0 },
  );
  assert.equal(claude.series.reduce((sum, row) => sum + row.runs, 0), 1);
  assert.deepEqual(claude.byUser.map((row) => row.userId), ["U_CLAUDE"]);
  assert.deepEqual(claude.byChannel.map((row) => row.channelId), ["C_CLAUDE"]);

  const codex = usageDashboard({ range: "today", harness: "codex" });
  assert.equal(codex.harness, "codex");
  assert.deepEqual(
    { runs: codex.totals.runs, tokens: codex.totals.tokens, cost: codex.totals.cost, claudeCost: codex.totals.claudeCost, codexCost: codex.totals.codexCost },
    { runs: 1, tokens: 220, cost: 2.75, claudeCost: 0, codexCost: 2.75 },
  );

  const invalid = usageDashboard({ range: "today", harness: "other" });
  assert.equal(invalid.harness, "all");
  assert.equal(invalid.totals.runs, 2);
});

test("top-skill usage accepts the same harness scope", () => {
  const ts = new Date().toISOString();
  recordSkillUsage({ ts, slug: "shared-skill", engine: "claude", signal: "exact" });
  recordSkillUsage({ ts, slug: "shared-skill", engine: "codex", signal: "inferred" });
  recordSkillUsage({ ts, slug: "codex-only", engine: "codex", signal: "inferred" });

  assert.equal(usageCountsBySlug().get("shared-skill").total, 2);
  assert.equal(usageCountsBySlug({ engine: "claude" }).get("shared-skill").total, 1);
  assert.equal(usageCountsBySlug({ engine: "claude" }).has("codex-only"), false);
  assert.equal(usageCountsBySlug({ engine: "codex" }).get("codex-only").total, 1);
});

test("Overview exposes the harness selector and sends its scope to the dashboard API", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="dash-harness"[\s\S]*value="all"[\s\S]*value="claude"[\s\S]*value="codex"/);
  assert.match(app, /api\(`\/api\/dashboard\?range=\$\{encodeURIComponent\(dashRange\)\}&harness=\$\{encodeURIComponent\(dashHarness\)\}`\)/);
  assert.match(app, /label: "Token Est Cost"/);
  assert.match(app, /label: "Claude Cost"/);
  assert.match(app, /label: "Codex Cost"/);
  assert.match(app, /String\(run\.engine \|\| run\.engineName \|\| ""\)\.toLowerCase\(\) === dashHarness/);
});
