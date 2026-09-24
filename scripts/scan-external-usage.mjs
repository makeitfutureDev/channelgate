#!/usr/bin/env node
// Reprocess engine usage the gateway never launched — `npm run usage:external`.
//
// The daemon already does this hourly and drains any backlog on its own, so this exists for the two
// cases a timer cannot cover: seeing what a pass WOULD record before it records it, and forcing a
// full re-read after something changed that the incremental bookmarks cannot know about (an edited
// rate table, a corrected channel work folder, a new release of the scanner itself).
//
// Dry run is the default and touches nothing. `--apply` writes, and is safe to repeat: a session's
// rows are replaced wholesale, so running it twice produces the same table.
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    rescan: { type: "boolean", default: false },
    containers: { type: "boolean", default: false },
    since: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`Usage: npm run usage:external -- [options]

  --apply        write the results (default: dry run, nothing is written)
  --rescan       forget the bookmarks so every transcript is read again. Happens by itself
                 after an update that changes the scanner, or after a rate-table edit.
  --containers   also read channels whose container is already running
                 (never starts one; the daemon's own scan includes these by default)
  --since <ISO>  only count usage from this date onward (default: all history)
  --limit <n>    transcripts per engine per scope in one pass (default: all)
  --json         print the raw summary instead of the report
`);
  process.exit(0);
}

if (values.since) {
  if (!Number.isFinite(Date.parse(values.since))) {
    console.error(`--since must be a date this runtime can parse: ${values.since}`);
    process.exit(2);
  }
  process.env.CHANNELGATE_EXTERNAL_USAGE_SINCE = values.since;
}

const { getDb } = await import("../src/db/index.js");
const { scanExternalUsage, EXTERNAL_SCAN_FILE_LIMIT } = await import("../src/gateway/external-usage.js");

// A dry run must leave the database exactly as it found it, and the scan's whole job is to write —
// so it runs inside a transaction that is always rolled back. That exercises the REAL write path
// (constraints, replacements, bookmarks included) rather than a parallel accounting of it, which is
// the only way a preview can be trusted to predict the apply.
const db = getDb();
const limit = values.limit ? Math.max(1, Number(values.limit) || 0) : 0;
const options = { includeContainers: values.containers, rescan: values.rescan, limit };

let summary;
if (values.apply) {
  summary = await scanExternalUsage(options);
} else {
  db.exec("BEGIN IMMEDIATE");
  try {
    summary = await scanExternalUsage(options);
  } finally {
    db.exec("ROLLBACK");
  }
}

if (values.json) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.errors.length ? 1 : 0);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
console.log(`\n${values.apply ? "Applied" : "Dry run"} — ${plural(summary.sessions, "session")} read in ${(summary.durationMs / 1000).toFixed(1)}s`);
if (summary.since) console.log(`Window: from ${summary.since}`);
else console.log("Window: all history");
if (summary.reprocessing) console.log(`Reprocessing: ${summary.reprocessing} — every transcript is being read again.`);

console.log(`\nAttributed to the gateway itself (not counted as outside usage):`);
const OUTSIDE_REASONS = ["terminal", "vscode", "desktop", "headless", "ssh", "other"];
const reasons = Object.entries(summary.attributed).filter(([reason]) => reason !== "empty" && !OUTSIDE_REASONS.includes(reason));
if (!reasons.length) console.log("  (none)");
for (const [reason, count] of reasons.sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(6)}  ${reason}`);

console.log(`\nRecorded as usage outside the gateway:`);
const outside = Object.entries(summary.attributed).filter(([reason]) => OUTSIDE_REASONS.includes(reason));
if (!outside.length) console.log("  (none)");
for (const [reason, count] of outside.sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(6)}  ${reason}`);
if (summary.attributed.empty) console.log(`\n${summary.attributed.empty} session(s) recorded no API call at all and are counted as neither.`);

for (const scope of summary.scopes) {
  const where = scope.scope === "host" ? "host" : `container/${scope.scopeKey}`;
  for (const [engine, stats] of Object.entries(scope.engines)) {
    console.log(
      `\n${where} · ${engine}: ${stats.total} on disk · ${stats.scanned} read · ${stats.skipped} skipped by id · ` +
      `${stats.unchanged} unchanged · ${stats.outside} outside · ${stats.rows} rows · $${(stats.cost || 0).toFixed(2)}`
    );
  }
  for (const error of scope.errors) console.log(`  ! ${error}`);
}

if (summary.truncated) {
  console.log(`\nMore transcripts remain (--limit ${limit || EXTERNAL_SCAN_FILE_LIMIT} reached). Re-run, or let the daemon's own pass continue.`);
}
if (!values.apply) console.log(`\nNothing was written. Re-run with --apply to keep these results.`);
process.exit(summary.errors.length ? 1 : 0);
