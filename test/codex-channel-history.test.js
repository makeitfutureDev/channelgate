import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, symlink } from "node:fs/promises";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const { copyLegacyChannelCodexHistory, preserveChannelCodexHistory } = await import("../src/engines/codex-channel-history.js");
const sessionId = "019a6a57-9d42-7e21-b923-d222b1701841";
const otherId = "019a6a57-9d42-7e21-b923-d222b1701842";
const rel = id => path.join("sessions", "2026", "11", "13", `rollout-2026-11-13T09-23-54-${id}.jsonl`);

async function fixture() {
  const home = tempDir("cg-codex-history-");
  const sourceRoot = path.join(home, ".codex");
  const destinationRoot = path.join(home, ".codex-channel");
  await mkdir(path.dirname(path.join(sourceRoot, rel(sessionId))), { recursive: true });
  await writeFile(path.join(sourceRoot, rel(sessionId)), "native tool state\n");
  await writeFile(path.join(sourceRoot, rel(otherId)), "other thread\n");
  await writeFile(path.join(sourceRoot, "auth.json"), "fixture credential must stay behind");
  await writeFile(path.join(sourceRoot, "config.toml"), "fixture configuration must stay behind");
  return { home, sourceRoot, destinationRoot, sessionIds: [sessionId] };
}

test("legacy migration copies only the requested native rollout and preserves newer dedicated state", async () => {
  const f = await fixture();
  const copied = await copyLegacyChannelCodexHistory(f);
  assert.deepEqual(copied, { copied: 1, existing: 0, bytes: Buffer.byteLength("native tool state\n") });
  assert.equal(await readFile(path.join(f.destinationRoot, rel(sessionId)), "utf8"), "native tool state\n");
  assert.deepEqual(await readdir(f.destinationRoot), ["sessions"], "neither credentials nor configuration enters the new home");
  assert.deepEqual(await readdir(path.dirname(path.join(f.destinationRoot, rel(sessionId)))), [path.basename(rel(sessionId))], "unrelated session history stays behind");
  await writeFile(path.join(f.destinationRoot, rel(sessionId)), "newer dedicated tool state\n");
  assert.deepEqual(await copyLegacyChannelCodexHistory(f), { copied: 0, existing: 1, bytes: 0 });
  assert.equal(await readFile(path.join(f.destinationRoot, rel(sessionId)), "utf8"), "newer dedicated tool state\n");
});

test("missing legacy history is a no-op and unsafe or unbounded histories are refused", async () => {
  const f = await fixture();
  const missing = path.join(f.home, "missing");
  assert.deepEqual(await copyLegacyChannelCodexHistory({ ...f, sourceRoot: missing }), { copied: 0, existing: 0, bytes: 0 });
  await assert.rejects(copyLegacyChannelCodexHistory({ ...f, maxFileBytes: 1 }), /byte limit/);
  await assert.rejects(copyLegacyChannelCodexHistory({ ...f, maxEntries: 1 }), /entry limit/);
  const linked = path.join(f.home, "linked-source");
  await symlink(f.sourceRoot, linked);
  await assert.rejects(copyLegacyChannelCodexHistory({ ...f, sourceRoot: linked }), /Unsafe.*directory/);
  await assert.rejects(copyLegacyChannelCodexHistory({ ...f, sessionIds: ["../../auth"] }), /session identity/);
});

function context(f, { sourceId = "", fresh = false, signal } = {}) {
  const calls = [];
  const runtime = {
    spawn(_target, spec) {
      calls.push(spec);
      return spawn(process.execPath, spec.args, { cwd: f.home, stdio: spec.stdio });
    },
    signal(child, sig) { child.kill(sig); },
  };
  const ctx = { cwd: f.home, target: { backend: "container", meta: { codexChannelLegacyHistory: true },
    container: { home: f.home, codexChannelHome: f.destinationRoot }, runtime },
    session: { id: sessionId, fresh }, runtime: { signal, forkSourceSessionId: sourceId } };
  return { ctx, calls };
}

test("the serialized runtime helper copies a resumed thread or a fork source and skips fresh/host turns", async () => {
  const f = await fixture();
  const { ctx, calls } = context(f, { fresh: true });
  assert.equal(await preserveChannelCodexHistory(ctx), null);
  assert.equal(calls.length, 0);
  ctx.runtime.forkSourceSessionId = sessionId;
  const copied = await preserveChannelCodexHistory(ctx);
  assert.equal(copied.copied, 1);
  assert.ok(calls[0].runId);
  assert.equal(await readFile(path.join(f.destinationRoot, rel(sessionId)), "utf8"), "native tool state\n");
  ctx.session.fresh = false;
  assert.equal((await preserveChannelCodexHistory(ctx)).existing, 1);
  ctx.target.backend = "host";
  assert.equal(await preserveChannelCodexHistory(ctx), null);
  assert.equal(calls.length, 2);
});

test("runtime history helpers honor pre-aborted signals, cancellation and bounded timeouts", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const { ctx, calls } = context(f, { signal: controller.signal });
  controller.abort();
  await assert.rejects(preserveChannelCodexHistory(ctx), { name: "AbortError" });
  assert.equal(calls.length, 0);

  for (const cancel of [true, false]) {
    const active = new AbortController();
    const running = context(f, { signal: active.signal });
    let child;
    let killed = false;
    running.ctx.target.runtime.spawn = () => { child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "pipe"] }); return child; };
    running.ctx.target.runtime.signal = (process, sig) => { killed = true; process.kill(sig); };
    const outcome = preserveChannelCodexHistory(running.ctx, { timeoutMs: cancel ? 10_000 : 20 });
    if (cancel) active.abort();
    await assert.rejects(outcome, cancel ? { name: "AbortError" } : /timed out/);
    assert.equal(killed, true);
    await new Promise(resolve => child.once("close", resolve));
  }
});
