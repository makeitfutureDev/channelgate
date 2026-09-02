#!/usr/bin/env node
// Dry-run by default. `--apply` makes a consistent backup, migrates the schema, then installs the
// already-computed canonical component plan under a frozen usage-id cutoff. The daemon also runs
// this repair automatically at boot when un-repaired legacy codex rows exist (see
// autoRepairCodexUsageHistory); this CLI remains for previews, custom cutoffs, and manual reruns.
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dbFile } from "../src/config/paths.js";
import { getDb } from "../src/db/index.js";
import {
  applyCodexHistoryRepair,
  backupGatewayDb,
  buildCodexHistoryRepair,
  defaultCodexStateDir,
  summarizeCodexRepairPlan,
} from "../src/gateway/usage-repair.js";

const apply = process.argv.includes("--apply");
const cutoffArg = process.argv.find((arg) => arg.startsWith("--cutoff="));
const stateDir = defaultCodexStateDir();
const sourcePath = dbFile();
const source = new DatabaseSync(sourcePath, { readOnly: true });
const frozenCutoff = cutoffArg ? Number(cutoffArg.slice("--cutoff=".length)) : Number(source.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM usage").get().id);
const plan = await buildCodexHistoryRepair({ db: source, stateDir, cutoffUsageId: frozenCutoff });
source.close();

const summary = {
  mode: apply ? "apply" : "dry-run",
  database: sourcePath,
  stateDir,
  ...summarizeCodexRepairPlan(plan),
};

if (!apply) {
  console.log(JSON.stringify({ ...summary, unmatchedUsageIds: plan.unmatchedRows, unmatchedChildSessionIds: plan.unmatchedChildren }, null, 2));
  process.exit(0);
}

const backupPath = await backupGatewayDb();
const batchId = `codex-history-${randomUUID()}`;
const db = getDb(); // Applies schema-only migration v10 before the bounded data transaction.
applyCodexHistoryRepair(db, plan, { batchId, backupPath, summary });

console.log(JSON.stringify({ ...summary, batchId, backupPath }, null, 2));
