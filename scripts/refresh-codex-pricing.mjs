#!/usr/bin/env node
// Dry-run by default. `--apply` backs up the gateway database and installs the current Codex
// Standard API-equivalent pricing basis over the declared historical window. Daemon boot runs the
// same idempotent refresh once after an upgraded instance repairs any legacy Codex accounting.
import { DatabaseSync } from "node:sqlite";
import { dbFile } from "../src/config/paths.js";
import { getDb } from "../src/db/index.js";
import { backupGatewayDb } from "../src/gateway/usage-repair.js";
import {
  applyCodexPricingRefresh,
  buildCodexPricingRefresh,
  summarizeCodexPricingRefresh,
} from "../src/gateway/usage-pricing.js";

const apply = process.argv.includes("--apply");
const sourcePath = dbFile();
const source = new DatabaseSync(sourcePath, { readOnly: true });
const plan = buildCodexPricingRefresh({ db: source });
source.close();
const summary = { mode: apply ? "apply" : "dry-run", database: sourcePath, ...summarizeCodexPricingRefresh(plan) };

if (!apply) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const backupPath = plan.usageRows ? await backupGatewayDb() : "";
applyCodexPricingRefresh(getDb(), plan);
console.log(JSON.stringify({ ...summary, backupPath }, null, 2));
