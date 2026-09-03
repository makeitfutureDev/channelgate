import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { progressReportInputSchema } from "../src/engines/progress-report.js";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { applyGatewayGuide } = await import("../src/gateway/guide.js");

const guideUrl = new URL("../src/gateway/gateway-usage/SKILL.md", import.meta.url);
const referenceUrl = new URL(
  "../src/gateway/gateway-usage/references/progress-report.md",
  import.meta.url,
);

test("gateway usage advertises progress reports without adding noise to routine turns", async () => {
  const guide = await readFile(guideUrl, "utf8");

  assert.match(
    guide,
    /^\| Orchestrate long\/high-volume work.*`references\/progress-report\.md`.*`report_progress`.*\|$/m,
  );
  assert.match(guide, /3\+\s+meaningful stages/i);
  assert.match(guide, /long or\s+substantive enough.*stage visibility materially helps/is);
  assert.match(guide, /routine.*never qualifies.*3\+.*(?:steps|stages)/is);
  assert.match(guide, /never invent filler stages/i);
  assert.match(guide, /only when.*report_progress.*available.*foreground chat turn/is);
  assert.match(guide, /unavailable.*clean.*daemon-owned background.*scheduled.*recovery.*headless/is);
  assert.match(guide, /visible.*non-recovery.*chat-backed API.*eligible.*tool.*present/is);
});

test("gateway usage mandates truthful visible subagent orchestration for long high-volume work", async () => {
  const guide = await readFile(guideUrl, "utf8");
  const reference = await readFile(referenceUrl, "utf8");

  assert.match(guide, /long analysis, research, evidence\s+review, validation/is);
  assert.match(guide, /100\+ files\/rows\/records\/items/i);
  assert.match(guide, /dispatch one or more in-turn subagents/i);
  assert.match(guide, /actual model and effort/i);
  assert.match(guide, /inherited settings.*does not expose.*guessing/is);
  assert.match(guide, /exact batch\/item and disagreement counters/i);

  assert.match(reference, /qualifying work is not a solo turn/i);
  assert.match(reference, /bounded, non-overlapping\s+scopes/i);
  assert.match(reference, /independent verifier.*reconcile/is);
  assert.match(reference, /agent\/role.*model.*effort.*scope.*progress/is);
  assert.match(reference, /inherits parent.*not exposed/is);
  assert.match(reference, /never infer a model.*claim `high` effort/is);
  assert.match(reference, /every completed batch or returned subagent result/i);
  assert.match(reference, /roughly every five minutes/i);
  assert.match(reference, /343\/1,750 rows.*batches 008–009 active.*1 disagreement/is);
  assert.match(reference, /run_agent_in_background.*background-jobs\.md/is);
});

test("progress report reference defines semantic snapshot lifecycle", async () => {
  const reference = await readFile(referenceUrl, "utf8");

  assert.match(reference, /domain skill defines.*semantic stages/i);
  assert.match(reference, /routine.*never qualifies.*3\+.*(?:steps|stages)/is);
  assert.match(reference, /before substantive work/i);
  assert.match(reference, /whole (?:authoritative\s+)?snapshot/i);
  assert.match(reference, /real stage boundaries/i);
  assert.match(reference, /preserve.*IDs.*order/is);
  assert.match(reference, /at most one.*in_progress/is);
  assert.match(reference, /completed.*error/is);
  assert.match(reference, /details.*output.*sources/is);
  assert.match(reference, /Read.*Bash.*internal API calls/is);
  assert.match(reference, /same expandable toolbox.*automatic.*tool.*subagent/is);
  assert.match(reference, /does not post a separate Plan message/i);
  assert.match(reference, /shimmering assistant\s+status remains temporary/i);
  assert.match(reference, /final snapshot.*before.*final answer/is);
  assert.match(reference, /interruptions.*gateway/is);
  assert.match(reference, /mark known failures/i);
  assert.match(reference, /Slack replies concise/i);
  assert.match(reference, /only when.*report_progress.*available.*foreground chat turn/is);
  assert.match(reference, /unavailable.*clean.*daemon-owned background.*scheduled.*recovery.*headless/is);
  assert.match(reference, /visible.*non-recovery.*chat-backed API.*eligible.*tool.*present/is);
});

test("progress report reference includes a realistic multi-agent validation example", async () => {
  const reference = await readFile(referenceUrl, "utf8");
  const examples = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  const stageSummary = (snapshot) => snapshot.steps.map(
    ({ id, title, status }) => ({ id, title, status }),
  );

  assert.equal(examples.length, 3);
  for (const [index, example] of examples.entries()) {
    const parsed = progressReportInputSchema.safeParse(example);
    assert.equal(parsed.success, true, `snapshot ${index + 1} must match report_progress schema`);
  }
  assert.deepEqual(
    examples.map(({ title }) => title),
    [
      "Final verification of consolidated subscriptions",
      "Final verification of consolidated subscriptions",
      "Final verification of consolidated subscriptions",
    ],
  );
  assert.deepEqual(stageSummary(examples[0]), [
    { id: "freeze-evidence", title: "Freeze and normalize source evidence", status: "complete" },
    { id: "dual-validation", title: "Validate every subscription row", status: "in_progress" },
    { id: "reconcile-reviews", title: "Reconcile both reviews", status: "pending" },
    { id: "write-verified-columns", title: "Update and verify final AI columns", status: "pending" },
  ]);
  assert.deepEqual(stageSummary(examples[1]), [
    { id: "freeze-evidence", title: "Freeze and normalize source evidence", status: "complete" },
    { id: "dual-validation", title: "Validate every subscription row", status: "in_progress" },
    { id: "reconcile-reviews", title: "Reconcile both reviews", status: "pending" },
    { id: "write-verified-columns", title: "Update and verify final AI columns", status: "pending" },
  ]);
  assert.deepEqual(stageSummary(examples[2]), [
    { id: "freeze-evidence", title: "Freeze and normalize source evidence", status: "complete" },
    { id: "dual-validation", title: "Validate every subscription row", status: "complete" },
    { id: "reconcile-reviews", title: "Reconcile both reviews", status: "complete" },
    { id: "write-verified-columns", title: "Update and verify final AI columns", status: "complete" },
  ]);
  assert.equal(examples[2].steps.some(({ status }) => status === "in_progress"), false);
  assert.match(reference, /report_progress/);
});

test("gateway guide delivery materializes the default progress report reference", async (t) => {
  const channelDir = await mkdtemp(path.join(os.tmpdir(), "cg-progress-guide-"));
  t.after(() => rm(channelDir, { recursive: true, force: true }));

  await applyGatewayGuide(channelDir);

  const delivered = await readFile(
    path.join(
      channelDir,
      ".claude",
      "skills",
      "gateway-usage",
      "references",
      "progress-report.md",
    ),
    "utf8",
  );
  assert.equal(delivered, await readFile(referenceUrl, "utf8"));
});
