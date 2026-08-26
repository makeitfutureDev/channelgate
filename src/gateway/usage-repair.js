// Historical Codex usage reconstruction. buildCodexHistoryRepair is deliberately read-only; the
// apply step freezes a usage-id cutoff, makes a consistent SQLite backup, and installs the plan in
// one short transaction. Original usage rows remain untouched as run/raw-evidence records. Both the
// CLI wrapper (scripts/repair-codex-usage-history.mjs) and the boot-time auto-repair below share
// the same summarize/backup/apply path, so a manual run and an automatic one are identical.
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { componentRow, insertComponent } from "./usage.js";
import {
  addCodexTokenUsage,
  codexFirstOwnTaskIndex,
  codexParentId,
  codexUsageKey,
  listCodexRollouts,
  normalizeCodexTokenUsage,
  parseCodexRollout,
  subtractCodexTokenUsage,
} from "../engines/codex-usage.js";

const ZERO = Object.freeze({ input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 });
const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const eventMs = (event) => Date.parse(event?.timestamp || "");
const isChildMeta = (meta = {}) => Boolean(codexParentId(meta) || (meta.source && typeof meta.source === "object"));
const pairKey = (input, output) => `${num(input)}:${num(output)}`;

function addRequestTotal(requests) {
  return requests.reduce((total, request) => addCodexTokenUsage(total, request.usage), ZERO);
}

function rootTurns(parsed, sessionId) {
  const starts = new Map(parsed.tasks.filter((task) => task.type === "task_started" && task.turnId).map((task) => [task.turnId, task]));
  const out = [];
  for (const complete of parsed.tasks.filter((task) => task.type === "task_complete")) {
    const start = starts.get(complete.turnId);
    if (!start) continue;
    const terminal = parsed.tokens.filter((token) => token.index > start.index && token.index < complete.index).at(-1);
    if (!terminal) continue;
    out.push({
      sessionId,
      turnId: complete.turnId,
      start,
      complete,
      terminal,
      parsed,
      startedMs: start.startedAt || eventMs(start),
      endedMs: complete.completedAt || eventMs(complete),
    });
  }
  return out;
}

function requestChain(turn) {
  const nodes = turn.parsed.tokens;
  const byTotal = new Map();
  for (const node of nodes) {
    const key = codexUsageKey(node.total);
    const values = byTotal.get(key) || [];
    values.push(node);
    byTotal.set(key, values);
  }
  const selected = [];
  const seenIndexes = new Set();
  let current = turn.terminal;
  let baseline = { ...ZERO };
  while (current && current.index > turn.start.index && !seenIndexes.has(current.index)) {
    seenIndexes.add(current.index);
    if (current.last.input_tokens || current.last.output_tokens) selected.push(current);
    const previousTotal = subtractCodexTokenUsage(current.total, current.last);
    if (codexUsageKey(previousTotal) === codexUsageKey(ZERO)) {
      baseline = { ...ZERO };
      break;
    }
    const prior = (byTotal.get(codexUsageKey(previousTotal)) || [])
      .filter((candidate) => candidate.index < current.index)
      .at(-1);
    if (!prior || prior.index <= turn.start.index) {
      baseline = prior?.total || previousTotal;
      break;
    }
    current = prior;
  }
  const requests = selected.reverse().map((node) => ({
    usage: node.last,
    model: node.model || turn.parsed.lastModel || "",
    contextWindow: node.contextWindow || 0,
  }));
  const usage = subtractCodexTokenUsage(turn.terminal.total, baseline);
  return { usage, requests, exactRequests: codexUsageKey(usage) === codexUsageKey(addRequestTotal(requests)) };
}

function childAccounting(header) {
  const boundary = codexFirstOwnTaskIndex(header.parsed);
  if (!boundary) return null;
  const baseline = header.parsed.tokens.filter((token) => token.index < boundary).at(-1)?.total || ZERO;
  const after = header.parsed.tokens.filter((token) => token.index > boundary);
  const terminal = after.at(-1);
  if (!terminal) return null;
  const seen = new Set();
  const requests = [];
  for (const node of after) {
    const key = codexUsageKey(node.total);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!node.last.input_tokens && !node.last.output_tokens) continue;
    requests.push({ usage: node.last, model: node.model || header.parsed.lastModel || "", contextWindow: node.contextWindow || 0 });
  }
  const usage = subtractCodexTokenUsage(terminal.total, baseline);
  const completion = header.parsed.tasks.filter((task) => task.type === "task_complete" && task.index > boundary).at(-1);
  return {
    usage,
    requests,
    exactRequests: codexUsageKey(usage) === codexUsageKey(addRequestTotal(requests)),
    model: requests.at(-1)?.model || header.parsed.lastModel || "",
    sessionId: header.id,
    parentSessionId: header.parentId,
    sourceId: `codex-child:${header.id}`,
    startedAt: new Date(header.startedMs).toISOString(),
    endedAt: completion?.timestamp || header.parsed.lastTimestamp || "",
    durationMs: completion?.durationMs || null,
  };
}

function rootAncestor(header, byId) {
  const seen = new Set();
  let current = header;
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) return current.parentId;
    if (!parent.parentId) return parent.id;
    current = parent;
  }
  return "";
}

export async function buildCodexHistoryRepair({ db, stateDir, cutoffUsageId = 0 } = {}) {
  const cutoff = cutoffUsageId || num(db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM usage").get()?.id);
  const rows = db.prepare(
    `SELECT * FROM usage WHERE engine = 'codex' AND id <= ? ORDER BY id`
  ).all(cutoff);
  const files = await listCodexRollouts(stateDir);
  const headers = [];
  const candidates = [];
  for (const file of files) {
    let parsed;
    try { parsed = await parseCodexRollout(file); } catch { continue; }
    const id = String(parsed.meta?.id || "");
    if (!id) continue;
    const header = {
      file,
      parsed,
      id,
      parentId: codexParentId(parsed.meta),
      startedMs: Date.parse(parsed.meta?.timestamp || ""),
    };
    headers.push(header);
    if (!isChildMeta(parsed.meta)) candidates.push(...rootTurns(parsed, id));
  }

  const byRaw = new Map();
  for (const candidate of candidates) {
    const key = pairKey(candidate.terminal.total.input_tokens, candidate.terminal.total.output_tokens);
    const values = byRaw.get(key) || [];
    values.push(candidate);
    byRaw.set(key, values);
  }
  const used = new Set();
  const matched = [];
  const unmatchedRows = [];
  for (const row of rows) {
    const rowMs = Date.parse(row.ts || "");
    const possible = (byRaw.get(pairKey(row.tokens_in, row.tokens_out)) || [])
      .filter((candidate) => !used.has(`${candidate.sessionId}:${candidate.turnId}`))
      .map((candidate) => ({ candidate, distance: Math.abs(candidate.endedMs - rowMs) }))
      .filter(({ distance }) => distance <= 15 * 60_000)
      .sort((a, b) => a.distance - b.distance);
    if (!possible.length || (possible[1] && possible[1].distance === possible[0].distance)) {
      unmatchedRows.push(Number(row.id));
      continue;
    }
    const turn = possible[0].candidate;
    used.add(`${turn.sessionId}:${turn.turnId}`);
    const chain = requestChain(turn);
    matched.push({
      usageId: Number(row.id),
      row,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      startedMs: turn.startedMs,
      endedMs: turn.endedMs,
      root: {
        ...chain,
        model: chain.requests.at(-1)?.model || turn.parsed.lastModel || row.model || "",
        sessionId: turn.sessionId,
        sourceId: `codex-turn:${turn.sessionId}:${turn.turnId}`,
        startedAt: new Date(turn.startedMs).toISOString(),
        endedAt: new Date(turn.endedMs).toISOString(),
        durationMs: turn.complete.durationMs || row.duration_ms || null,
      },
      children: [],
    });
  }

  const byId = new Map(headers.map((header) => [header.id, header]));
  const sessionRows = db.prepare("SELECT slug, thread_key, session_id FROM sessions WHERE engine = 'codex'").all();
  const sessionById = new Map(sessionRows.map((row) => [String(row.session_id), row]));
  const unmatchedChildren = [];
  for (const header of headers.filter((item) => item.parentId)) {
    const accounting = childAccounting(header);
    if (!accounting) continue;
    const ancestor = rootAncestor(header, byId);
    let target = matched
      .filter((item) => item.sessionId === ancestor && header.startedMs >= item.startedMs - 1_000 && header.startedMs <= item.endedMs + 2_000)
      .sort((a, b) => b.startedMs - a.startedMs)[0];
    if (!target) {
      // Guardian reviews commonly begin seconds after their root task completed. A background-agent
      // root can also be session-registered even when it has no own ledger checkpoint. In both
      // cases the sessions table is durable gateway attribution; use the nearest same-session run,
      // or a nearby same-channel run for a normal (non nested ::agent) gateway session.
      target = matched
        .filter((item) => item.sessionId === ancestor)
        .map((item) => ({ item, distance: Math.abs(item.endedMs - header.startedMs) }))
        .filter(({ distance }) => distance <= 30 * 60_000)
        .sort((a, b) => a.distance - b.distance)[0]?.item;
      const registered = sessionById.get(ancestor);
      if (!target && registered && !String(registered.thread_key || "").includes("::agent-")) {
        target = matched
          .filter((item) => item.row.slug === registered.slug)
          .map((item) => ({ item, distance: Math.abs(Date.parse(item.row.ts) - header.startedMs) }))
          .filter(({ distance }) => distance <= 30 * 60_000)
          .sort((a, b) => a.distance - b.distance)[0]?.item;
      }
      if (target) accounting.provenance = "codex-rollout-fork-delta+gateway-session-attribution";
    }
    if (!target) {
      unmatchedChildren.push(header.id);
      continue;
    }
    target.children.push(accounting);
  }

  const totals = matched.reduce((total, item) => {
    total.root = addCodexTokenUsage(total.root, item.root.usage);
    for (const child of item.children) total.children = addCodexTokenUsage(total.children, child.usage);
    return total;
  }, { root: { ...ZERO }, children: { ...ZERO } });
  return {
    cutoffUsageId: cutoff,
    usageRows: rows.length,
    matched,
    unmatchedRows,
    unmatchedChildren,
    rootRolloutTurns: candidates.length,
    childRollouts: headers.filter((item) => item.parentId).length,
    totals,
  };
}

// Accounting rollup of a repair plan — the value/coverage numbers shown by both the CLI dry-run
// and the applied-batch record. Pure; prices via componentRow exactly like the apply step does.
export function summarizeCodexRepairPlan(plan) {
  let rootValue = 0;
  let childValue = 0;
  let unpricedComponents = 0;
  let requestVerifiedComponents = 0;
  for (const item of plan.matched) {
    const root = componentRow(item.root, { fallbackModel: item.row.model, durationMs: item.row.duration_ms });
    if (root.costUSD == null) unpricedComponents += 1;
    else rootValue += root.costUSD;
    if (root.confidence === "verified-requests") requestVerifiedComponents += 1;
    for (const child of item.children) {
      const component = componentRow(child, { sourceKind: "subagent", fallbackModel: root.model });
      if (component.costUSD == null) unpricedComponents += 1;
      else childValue += component.costUSD;
      if (component.confidence === "verified-requests") requestVerifiedComponents += 1;
    }
  }
  return {
    cutoffUsageId: plan.cutoffUsageId,
    usageRows: plan.usageRows,
    matchedRows: plan.matched.length,
    unmatchedRows: plan.unmatchedRows.length,
    childRolloutsAttached: plan.matched.reduce((count, item) => count + item.children.length, 0),
    unmatchedChildren: plan.unmatchedChildren.length,
    rootTokens: plan.totals.root.total_tokens,
    childTokens: plan.totals.children.total_tokens,
    estimatedStandardApiValue: Number((rootValue + childValue).toFixed(6)),
    rootEstimatedValue: Number(rootValue.toFixed(6)),
    childEstimatedValue: Number(childValue.toFixed(6)),
    requestVerifiedComponents,
    unpricedComponents,
  };
}

// Repair is needed when legacy-marked codex rows exist BEYOND the last applied batch's cutoff.
// Rows an earlier batch already scanned but could not match (rotated rollouts) sit at or below
// that cutoff and stay visibly legacy without re-triggering a scan on every boot.
export function pendingCodexRepair(db) {
  const lastCutoff = num(db.prepare(
    "SELECT COALESCE(MAX(cutoff_usage_id), 0) AS c FROM usage_repair_batches WHERE status = 'applied'"
  ).get()?.c);
  const pendingRows = num(db.prepare(
    "SELECT COUNT(*) AS n FROM usage WHERE engine = 'codex' AND accounting_status = 'legacy-unverified' AND id > ?"
  ).get(lastCutoff)?.n);
  return { lastCutoff, pendingRows };
}

// Install a computed plan: one batch record (even when nothing matched — that is the marker that
// this id range was scanned) plus idempotent component upserts and usage-row status flips.
export function applyCodexHistoryRepair(db, plan, { batchId, backupPath = "", summary } = {}) {
  const data = summary || summarizeCodexRepairPlan(plan);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO usage_repair_batches(id, created_ts, cutoff_usage_id, status, backup_path, data)
       VALUES(?, ?, ?, 'applied', ?, ?)`
    ).run(batchId, new Date().toISOString(), plan.cutoffUsageId, backupPath, JSON.stringify(data));
    for (const item of plan.matched) {
      const root = componentRow(item.root, { fallbackModel: item.row.model, durationMs: item.row.duration_ms });
      insertComponent(db, item.usageId, root);
      for (const child of item.children) {
        insertComponent(db, item.usageId, componentRow(child, {
          sourceKind: "subagent",
          parentSourceId: item.sessionId,
          fallbackModel: root.model,
        }));
      }
      db.prepare(
        `UPDATE usage SET runtime_model = ?, accounting_status = ?, repair_batch_id = ? WHERE id = ?`
      ).run(root.model, root.confidence === "verified-requests" ? "repaired-verified" : "repaired-total", batchId, item.usageId);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
  return data;
}

export function defaultCodexStateDir() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

// Consistent pre-repair snapshot of the live gateway DB under <root>/backups.
export async function backupGatewayDb() {
  const { backup, DatabaseSync } = await import("node:sqlite");
  const { dbFile, gatewayRoot } = await import("../config/paths.js");
  const backupDir = path.join(gatewayRoot(), "backups");
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `gateway-usage-before-${stamp}.db`);
  const source = new DatabaseSync(dbFile());
  try {
    await backup(source, backupPath);
  } finally {
    source.close();
  }
  return backupPath;
}

// Boot-time hook: when an update introduced accounting schema v10 (which marks pre-existing codex
// rows legacy-unverified), reconstruct their per-turn + subagent usage from surviving rollouts
// automatically — no manual `npm run usage:repair` needed. No-op when nothing is pending, so it is
// safe (and cheap) to call on every daemon start.
export async function autoRepairCodexUsageHistory({ db, stateDir, makeBackup, log = console } = {}) {
  const handle = db || (await import("../db/index.js")).getDb();
  const { lastCutoff, pendingRows } = pendingCodexRepair(handle);
  if (!pendingRows) return { applied: false, pendingRows: 0 };
  const dir = stateDir || defaultCodexStateDir();
  log.log?.(`[usage] auto-repair: ${pendingRows} unrepaired codex row(s) past cutoff ${lastCutoff}; reconstructing from rollouts in ${dir}…`);
  const plan = await buildCodexHistoryRepair({ db: handle, stateDir: dir });
  const backupPath = await (makeBackup || backupGatewayDb)();
  const batchId = `codex-history-auto-${randomUUID()}`;
  const summary = applyCodexHistoryRepair(handle, plan, { batchId, backupPath });
  log.log?.(`[usage] auto-repair applied ${batchId}: ${summary.matchedRows}/${summary.usageRows} rows repaired, ${summary.childRolloutsAttached} subagent rollout(s) attached, ${summary.unmatchedRows} left legacy (no surviving rollout); backup ${backupPath}`);
  return { applied: true, batchId, backupPath, ...summary };
}
