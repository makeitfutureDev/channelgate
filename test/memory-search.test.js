import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { searchChannelMemory, readChannelMemorySource } = await import("../src/gateway/memory-search.js");

test("Markdown stays canonical while the derived FTS index finds relevant topic passages", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "cg-memory-search-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "memory"));
  await writeFile(path.join(cwd, "MEMORY.md"), "# Channel memory\n\nDeployment details → [[deployments]]\n");
  await writeFile(path.join(cwd, "memory", "deployments.md"), "Production deploys happen on Friday through the release workflow.\n");
  await writeFile(path.join(cwd, "memory", "preferences.md"), "The team prefers concise answers.\n");

  const hits = await searchChannelMemory(cwd, "memory-search", "Friday release", 5);
  assert.equal(hits[0].source, "memory/deployments.md");
  assert.match(hits[0].excerpt, /\[Friday\]|\[release\]/i);
  assert.equal(await readChannelMemorySource(cwd, hits[0].source), "Production deploys happen on Friday through the release workflow.\n");
  await assert.rejects(readChannelMemorySource(cwd, "../settings.json"), /source must be/);
});

test("search rebuilds the derived index so hand-edited Markdown is immediately current", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "cg-memory-reindex-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "MEMORY.md"), "Old deployment uses blue.\n");
  assert.equal((await searchChannelMemory(cwd, "memory-reindex", "blue")).length, 1);
  await writeFile(path.join(cwd, "MEMORY.md"), "New deployment uses green.\n");
  assert.equal((await searchChannelMemory(cwd, "memory-reindex", "blue")).length, 0);
  assert.equal((await searchChannelMemory(cwd, "memory-reindex", "green")).length, 1);
});

test("without FTS5 in the engine, the database still opens and search answers the same shape from a plain scan", async (t) => {
  // Node 22.13 — the documented floor — ships a SQLite without FTS5. Simulate that engine by
  // dropping the derived table: the migration is written to skip it, and the scan must carry
  // the same AND semantics, diacritic folding and bracketed excerpts as the indexed path.
  const { getDb } = await import("../src/db/index.js");
  const { memoryFtsPresent, ensureMemoryFtsTable } = await import("../src/db/fts.js");
  const db = getDb();
  const hadIndex = memoryFtsPresent(db);
  if (hadIndex) db.exec("DROP TABLE channel_memory_fts");
  t.after(() => {
    if (hadIndex) ensureMemoryFtsTable(db);
  });
  assert.equal(memoryFtsPresent(db), false);

  const cwd = await mkdtemp(path.join(os.tmpdir(), "cg-memory-scan-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "memory"));
  await writeFile(path.join(cwd, "MEMORY.md"), "# Channel memory\n\nDeployment details → [[deployments]]\n");
  await writeFile(path.join(cwd, "memory", "deployments.md"), "Production deploys happen on Friday through the release workflow.\n");
  await writeFile(path.join(cwd, "memory", "preferences.md"), "The team prefers concise answers. Deploys are reviewed on Friday too.\n");

  const hits = await searchChannelMemory(cwd, "memory-scan", "Friday release", 5);
  assert.equal(hits.length, 1, "AND semantics: only the document with both terms");
  assert.equal(hits[0].source, "memory/deployments.md");
  assert.match(hits[0].excerpt, /\[Friday\]/);
  assert.equal(typeof hits[0].rank, "number");

  const folded = await searchChannelMemory(cwd, "memory-scan", "fridáy", 5);
  assert.equal(folded.length, 2, "diacritics and case fold like the unicode61 tokenizer");
  assert.equal((await searchChannelMemory(cwd, "memory-scan", "nothing-here")).length, 0);
  assert.equal((await searchChannelMemory(cwd, "memory-scan", "!!!")).length, 0, "no terms → no hits, no throw");
});

test("the FTS probe is honest about the engine and the ensure step is idempotent", async () => {
  const { getDb } = await import("../src/db/index.js");
  const { fts5Available, ensureMemoryFtsTable, memoryFtsPresent } = await import("../src/db/fts.js");
  const db = getDb();
  const available = fts5Available(db);
  assert.equal(typeof available, "boolean");
  assert.equal(ensureMemoryFtsTable(db), available);
  assert.equal(ensureMemoryFtsTable(db), available, "a second call neither throws nor changes the answer");
  assert.equal(memoryFtsPresent(db), available);
});
