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
