import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, symlink, link, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const { channelHistoryRoot, channelHistoryIdentity, historyMounts, historySeedMarker, seedProjectHistory, buildHistorySeedArgs } = await import("../src/runtimes/container/history.js");
const { currentInstallId } = await import("../src/runtimes/container/names.js");
const { homeVolumeName } = await import("../src/runtimes/container/names.js");
const { runtimeArtifactsRoot } = await import("../src/config/paths.js");

function target(scope = "project", platform = "slack", slug = "shared-example") {
  return { slug, platform, runtimeScope: scope, container: { image: "runtime:test", uid: 1000, gid: 1000 } };
}
async function fixture() {
  const root = tempDir("cg-history-");
  const sourceRoot = path.join(root, "old");
  const sharedRoot = path.join(root, "shared");
  await mkdir(sourceRoot);
  return { sourceRoot, sharedRoot };
}
async function put(root, relative, content = "transcript\n") {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

test("history mounts and identity are channel-wide, with separate channel/platform roots", () => {
  const member = target();
  const admin = target("admin");
  assert.equal(channelHistoryIdentity(member), channelHistoryIdentity(admin));
  assert.deepEqual(historyMounts(member), historyMounts(admin));
  assert.equal(channelHistoryRoot(member), path.join(`${runtimeArtifactsRoot()}-history`, currentInstallId(), "slack", "shared-example"));
  assert.equal(historySeedMarker(member), path.join(channelHistoryRoot(member), ".project-history-seeded-v1.json"));
  assert.notEqual(channelHistoryIdentity(member), channelHistoryIdentity(target("project", "msteams")));
  assert.notEqual(channelHistoryIdentity(member), channelHistoryIdentity(target("project", "slack", "other")));
  assert.deepEqual(historyMounts(member).map((m) => m.target), [
    "/home/agent/.claude/projects", "/home/agent/.codex/sessions", "/home/agent/.codex/archived_sessions",
  ]);
  assert.ok(historyMounts(member).every((m) => m.type === "bind" && m.mode === "rw"));
  assert.throws(() => channelHistoryRoot(target("project", "slack", "../../../other")), /Invalid channel history path/);
});

test("migration imports only project transcript trees and preserves the source", async () => {
  const f = await fixture();
  const cases = [
    [".claude/projects/project/id.jsonl", "claude-projects/project/id.jsonl"],
    [".claude/projects/project/id/subagents/agent.jsonl", "claude-projects/project/id/subagents/agent.jsonl"],
    [".codex/sessions/2026/11/12/rollout-id.jsonl", "codex-sessions/2026/11/12/rollout-id.jsonl"],
    [".codex/archived_sessions/rollout-id.jsonl", "codex-archived-sessions/rollout-id.jsonl"],
  ];
  for (const [source] of cases) await put(f.sourceRoot, source, source);
  for (const sensitive of [".claude/.credentials.json", ".claude/settings.json", ".claude/.claude.json", ".claude/file-history/id/snapshot", ".codex/auth.json", ".codex/config.toml", ".codex/state_5.sqlite", ".codex/queue_1.sqlite", ".codex/thread_history_1.sqlite", ".ssh/id_ed25519"]) {
    await put(f.sourceRoot, sensitive, "not history");
  }
  const originalTime = (await stat(path.join(f.sourceRoot, cases[0][0]))).mtimeMs;
  const result = await seedProjectHistory(f);
  assert.equal(result.copied, cases.length);
  assert.equal(result.alreadySeeded, false);
  for (const [source, destination] of cases) {
    assert.equal(await readFile(path.join(f.sharedRoot, destination), "utf8"), source);
    assert.equal(await readFile(path.join(f.sourceRoot, source), "utf8"), source);
  }
  assert.ok(Math.abs((await stat(path.join(f.sharedRoot, cases[0][1]))).mtimeMs - originalTime) < 1);
  assert.deepEqual((await readdir(f.sharedRoot)).sort(), [".project-history-seeded-v1.json", "claude-projects", "codex-archived-sessions", "codex-sessions"]);
  assert.equal((await stat(path.join(f.sharedRoot, cases[0][1]))).nlink, 1);
});

test("migration is idempotent and retrying a partial import accepts identical files", async () => {
  const f = await fixture();
  await put(f.sourceRoot, ".claude/projects/p/id.jsonl");
  await put(f.sharedRoot, "claude-projects/p/id.jsonl");
  const first = await seedProjectHistory(f);
  assert.equal(first.copied, 0);
  assert.equal(first.unchanged, 1);
  const second = await seedProjectHistory(f);
  assert.equal(second.alreadySeeded, true);
  assert.equal(second.files, 0);
});

test("divergent history is preserved and a failed migration publishes no completion marker", async () => {
  const f = await fixture();
  await put(f.sourceRoot, ".claude/projects/p/id.jsonl", "source");
  await put(f.sharedRoot, "claude-projects/p/id.jsonl", "destination");
  await assert.rejects(seedProjectHistory(f), /conflict/);
  assert.equal(await readFile(path.join(f.sharedRoot, "claude-projects/p/id.jsonl"), "utf8"), "destination");
  assert.equal(await readFile(path.join(f.sourceRoot, ".claude/projects/p/id.jsonl"), "utf8"), "source");
  await assert.rejects(stat(path.join(f.sharedRoot, ".project-history-seeded-v1.json")), { code: "ENOENT" });
});

test("migration rejects source symlinks and hardlinks without copying credentials", async () => {
  for (const mode of ["file-link", "parent-link", "hardlink"]) {
    const f = await fixture();
    const sensitive = await put(f.sourceRoot, ".codex/auth.json", "credential fixture");
    const project = path.join(f.sourceRoot, ".claude/projects/p");
    await mkdir(project, { recursive: true });
    if (mode === "file-link") await symlink(sensitive, path.join(project, "id.jsonl"));
    else if (mode === "hardlink") await link(sensitive, path.join(project, "id.jsonl"));
    else await symlink(path.join(f.sourceRoot, ".codex"), path.join(project, "nested"));
    await assert.rejects(seedProjectHistory(f), /Unsafe/);
    await assert.rejects(stat(path.join(f.sharedRoot, ".project-history-seeded-v1.json")), { code: "ENOENT" });
  }
});

test("migration rejects a symlink or hardlink destination and unsafe root parents", async () => {
  for (const mode of ["file-link", "hardlink", "directory-link"]) {
    const f = await fixture();
    await put(f.sourceRoot, ".claude/projects/p/id.jsonl");
    const outside = tempDir("cg-history-outside-");
    const untouched = await put(outside, "secret", "untouched");
    await mkdir(path.join(f.sharedRoot, "claude-projects/p"), { recursive: true });
    if (mode === "directory-link") await symlink(outside, path.join(f.sharedRoot, "codex-sessions"));
    else if (mode === "file-link") await symlink(untouched, path.join(f.sharedRoot, "claude-projects/p/id.jsonl"));
    else await link(untouched, path.join(f.sharedRoot, "claude-projects/p/id.jsonl"));
    await assert.rejects(seedProjectHistory(f), /Unsafe|ELOOP/);
    assert.equal(await readFile(untouched, "utf8"), "untouched");
  }
});

test("migration bounds files, entries, bytes and directory depth", async () => {
  for (const limits of [{ maxFiles: 1 }, { maxEntries: 1 }, { maxBytes: 1 }, { maxFileBytes: 1 }, { maxDepth: 1 }]) {
    const f = await fixture();
    await put(f.sourceRoot, ".claude/projects/p/a.jsonl");
    await put(f.sourceRoot, ".claude/projects/p/b.jsonl");
    await put(f.sourceRoot, ".claude/projects/p/sub/nested.jsonl");
    await assert.rejects(seedProjectHistory({ ...f, ...limits }), /limit exceeded/);
    await assert.rejects(stat(path.join(f.sharedRoot, ".project-history-seeded-v1.json")), { code: "ENOENT" });
  }
});

test("helper CLI seeds only a read-only project HOME with no network or admin mounts", () => {
  const t = target("admin");
  const args = buildHistorySeedArgs(t, { uidStrategy: "keep-id" });
  assert.ok(args.includes("--userns=keep-id"));
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.ok(args.includes("--read-only"));
  const volumes = args.flatMap((arg, i) => arg === "-v" ? [args[i + 1]] : []);
  assert.deepEqual(volumes, [`${homeVolumeName({ ...t, runtimeScope: "project" })}:/legacy:ro`, `${channelHistoryRoot(t)}:/shared`]);
  assert.ok(!volumes.some((v) => v.startsWith(`${homeVolumeName(t)}:`)));
  const mapped = buildHistorySeedArgs(t, { uidStrategy: "user" });
  assert.equal(mapped[mapped.indexOf("--user") + 1], "1000:1000");
});

test("helper's serialized migration function is executable without repository imports", async () => {
  const f = await fixture();
  await put(f.sourceRoot, ".codex/sessions/2026/11/12/id.jsonl");
  const source = `const result = await (${seedProjectHistory.toString()})(${JSON.stringify(f)});process.stdout.write(JSON.stringify(result));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).copied, 1);
});
