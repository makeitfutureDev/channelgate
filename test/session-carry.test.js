// Session carry-over: a thread's ENGINE-NATIVE history follows it when its channel changes runtime
// backend. Three layers are covered here — the per-engine facts that say where a session's files
// live, the host-side copy/expansion those facts feed, and the orchestrator that decides whether a
// carry happens at all. The container half is test/container-carry.test.js; the turn-level ordering
// is test/runtime-integration-run.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const { engineSessionFiles, engineSessionState, engineStateDir } = await import("../src/engines/registry.js");
const { copyCarryEntries, expandCarryEntry, walkFiles } = await import("../src/runtimes/copy.js");
const { buildCarryEntries, carrySession, storedRuntimeBackend, CARRY_DIRECTIONS } = await import("../src/gateway/session-carry.js");
const { claudeEngineHome, codexEngineHome } = await import("../src/config/paths.js");

const SESSION = "9f3ab7c2-1111-4000-8000-abcdefabcdef";

function scratch(name) {
  return tempDir(`cg-carry-${name}-`);
}

function write(file, body = "x\n") {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

// ── The per-engine facts (src/engines/adapters.js → registry.js) ───────────────────────────────

test("engine facts: Claude keys transcripts by the run's cwd and carries the subagent directory too", () => {
  const files = engineSessionFiles("claude", { cwd: "/home/management/ChannelGate/slack/cg-qa-auto", sessionId: SESSION });
  assert.deepEqual(files.map((f) => f.kind), ["file", "dir"]);
  // Verified against a live ~/.claude/projects: every non-alphanumeric character becomes a dash.
  assert.equal(files[0].rel, `projects/-home-management-ChannelGate-slack-cg-qa-auto/${SESSION}.jsonl`);
  assert.equal(files[1].rel, `projects/-home-management-ChannelGate-slack-cg-qa-auto/${SESSION}`);
  // Clean mode runs in a different directory, so the key must follow the RUN's cwd, not the channel's.
  const clean = engineSessionFiles("claude", { cwd: "/var/clean-workspaces/slack/cg-qa-auto", sessionId: SESSION });
  assert.equal(clean[0].rel, `projects/-var-clean-workspaces-slack-cg-qa-auto/${SESSION}.jsonl`);
});

test("engine facts: a Codex rollout is a PATTERN whose date directories must survive the copy", () => {
  const files = engineSessionFiles("codex", { cwd: "/anywhere", sessionId: SESSION });
  assert.deepEqual(files, [{ rel: `sessions/*/*/*/*-${SESSION}.jsonl`, kind: "file" }]);
});

test("engine facts: state dirs come from the target, and an engine that declares none never carries", () => {
  assert.equal(engineStateDir("claude", null), path.join(claudeEngineHome(), ".claude"));
  assert.equal(engineStateDir("codex", null), codexEngineHome());
  const containerTarget = { container: { claudeConfigDir: "/home/agent/.claude", codexHome: "/home/agent/.codex" } };
  assert.equal(engineStateDir("claude", containerTarget), "/home/agent/.claude");
  assert.equal(engineStateDir("codex", containerTarget), "/home/agent/.codex");
  // OpenCode declares no session state: the carry is skipped, never guessed at.
  assert.equal(engineSessionState("opencode"), null);
  assert.deepEqual(engineSessionFiles("opencode", { cwd: "/x", sessionId: SESSION }), []);
  // No session id, nothing to locate.
  assert.deepEqual(engineSessionFiles("claude", { cwd: "/x", sessionId: "" }), []);
});

test("engine facts: an adapter that half-declares sessionState does not load", async () => {
  const { validateEngineAdapter } = await import("../src/engines/contract.js");
  const { adapterFor } = await import("../src/engines/registry.js");
  const base = adapterFor("claude");
  assert.throws(
    () => validateEngineAdapter({ ...base, sessionState: { hostDir: () => "/x" } }),
    /incomplete sessionState/,
  );
  assert.throws(
    () => validateEngineAdapter({ ...base, sessionState: { hostDir: () => "/x", files: () => [], containerDirKey: "" } }),
    /incomplete sessionState/,
  );
});

// ── The host-side copy (src/runtimes/copy.js) ──────────────────────────────────────────────────

test("copy: a wildcard is expanded on the source side and the matched tail lands under the destination", () => {
  const root = scratch("glob");
  const from = path.join(root, "from");
  const to = path.join(root, "to");
  write(path.join(from, "sessions/2026/09/01", `rollout-2026-09-01T09-42-11-${SESSION}.jsonl`), "mine\n");
  write(path.join(from, "sessions/2026/09/01", "rollout-2026-09-01T09-42-11-someone-else.jsonl"), "theirs\n");

  const entry = {
    rel: `sessions/*/*/*/*-${SESSION}.jsonl`,
    kind: "file",
    from: path.join(from, `sessions/*/*/*/*-${SESSION}.jsonl`),
    to: path.join(to, `sessions/*/*/*/*-${SESSION}.jsonl`),
  };
  const expanded = expandCarryEntry(entry);
  assert.equal(expanded.length, 1, "only this session's rollout matches");
  assert.equal(copyCarryEntries([entry]), 1);
  // The YYYY/MM/DD tree is what `codex exec resume` walks — it must arrive intact.
  assert.deepEqual(walkFiles(to), [`sessions/2026/09/01/rollout-2026-09-01T09-42-11-${SESSION}.jsonl`]);
});

test("copy: overwrite, merge, and never delete — a missing source carries nothing", () => {
  const root = scratch("merge");
  const from = path.join(root, "from");
  const to = path.join(root, "to");
  write(path.join(from, "projects/k", `${SESSION}.jsonl`), "new\n");
  write(path.join(from, "projects/k", SESSION, "sub-a.jsonl"), "new-a\n");
  write(path.join(to, "projects/k", `${SESSION}.jsonl`), "old\n");
  write(path.join(to, "projects/k", SESSION, "sub-a.jsonl"), "old-a\n");
  // Something the destination has and the source does not: it must survive the carry.
  write(path.join(to, "projects/k", SESSION, "keep-me.jsonl"), "keep\n");

  const entries = [
    { rel: `projects/k/${SESSION}.jsonl`, kind: "file", from: path.join(from, "projects/k", `${SESSION}.jsonl`), to: path.join(to, "projects/k", `${SESSION}.jsonl`) },
    { rel: `projects/k/${SESSION}`, kind: "dir", from: path.join(from, "projects/k", SESSION), to: path.join(to, "projects/k", SESSION) },
    { rel: "projects/k/never-written.jsonl", kind: "file", from: path.join(from, "projects/k/never-written.jsonl"), to: path.join(to, "projects/k/never-written.jsonl") },
  ];
  assert.equal(copyCarryEntries(entries), 2, "a missing source is 0 copied, not an error");
  assert.equal(readFileSync(path.join(to, "projects/k", `${SESSION}.jsonl`), "utf8"), "new\n");
  assert.equal(readFileSync(path.join(to, "projects/k", SESSION, "sub-a.jsonl"), "utf8"), "new-a\n");
  assert.equal(readFileSync(path.join(to, "projects/k", SESSION, "keep-me.jsonl"), "utf8"), "keep\n");
  // And the source is untouched on both counts.
  assert.equal(existsSync(path.join(from, "projects/k", `${SESSION}.jsonl`)), true);
});

// ── The orchestrator (src/gateway/session-carry.js) ────────────────────────────────────────────

test("stored runtime: an empty, malformed or pre-migration stamp is a HOST row", () => {
  assert.equal(storedRuntimeBackend(""), "host");
  assert.equal(storedRuntimeBackend(null), "host");
  assert.equal(storedRuntimeBackend("not json"), "host");
  assert.equal(storedRuntimeBackend("{}"), "host");
  assert.equal(storedRuntimeBackend(JSON.stringify({ backend: "container", image: "x" })), "container");
  assert.equal(storedRuntimeBackend({ backend: "container" }), "container");
});

// A pair of targets whose "state dirs" are real scratch directories, so a carry actually moves
// files and the assertions can look at what arrived.
function carryHarness(name) {
  const root = scratch(name);
  const hostDir = path.join(root, "host-state");
  const ctrDir = path.join(root, "container-state");
  const calls = { copyIn: [], copyOut: [], leases: [] };
  const runtime = {
    id: "container",
    acquireLease(target, lease) {
      const record = { ...lease, released: false };
      calls.leases.push(record);
      return { release() { record.released = true; } };
    },
    async copyIn(target, entries) {
      calls.copyIn.push(entries);
      return { copied: copyCarryEntries(entries) };
    },
    async copyOut(target, entries) {
      calls.copyOut.push(entries);
      return { copied: copyCarryEntries(entries) };
    },
  };
  const hostRuntime = { id: "host", acquireLease: () => ({ release() {} }) };
  const meta = { platform: "slack", channelId: "C1" };
  const containerTarget = {
    backend: "container", slug: name, meta, runtime,
    container: { name: `cg-${name}`, claudeConfigDir: path.join(ctrDir, ".claude"), codexHome: path.join(ctrDir, ".codex") },
  };
  const hostTarget = { backend: "host", slug: name, meta, runtime: hostRuntime, container: null };
  const logs = [];
  const resolveFor = (slug, m, { backend } = {}) => (backend === "container" ? containerTarget : hostTarget);
  return { root, hostDir, ctrDir, calls, containerTarget, hostTarget, logs, log: (m) => logs.push(m), resolveFor };
}

// The claude host state dir is claudeEngineHome()/.claude, which the scratch env pins; a test that
// wants its own directory writes there instead of guessing.
function claudeHostFile(sessionId, cwd) {
  const key = String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(claudeEngineHome(), ".claude", "projects", key, `${sessionId}.jsonl`);
}

test("carry: same backend on both sides is a no-op — a recreated container still has its volume", async () => {
  const h = carryHarness("same");
  const result = await carrySession({
    engine: "claude", sessionId: SESSION, cwd: "/w/same",
    storedRuntime: JSON.stringify({ backend: "container", fingerprint: "c1-old" }),
    target: h.containerTarget, slug: "same", threadKey: "1.0", resolveFor: h.resolveFor, log: h.log,
  });
  assert.equal(result, null);
  assert.equal(h.calls.copyIn.length, 0);
  assert.equal(h.calls.copyOut.length, 0);
  assert.deepEqual(h.logs, []);
});

test("carry: host→container copies the session in, leases the runtime, and reports the direction", async () => {
  const h = carryHarness("in");
  const cwd = "/w/in";
  write(claudeHostFile(SESSION, cwd), "transcript\n");
  write(path.join(path.dirname(claudeHostFile(SESSION, cwd)), SESSION, "sub.jsonl"), "subagent\n");

  const result = await carrySession({
    engine: "claude", sessionId: SESSION, cwd, storedRuntime: "",
    target: h.containerTarget, slug: "in", threadKey: "1.1", resolveFor: h.resolveFor, log: h.log,
  });

  assert.deepEqual(result, { direction: CARRY_DIRECTIONS.IN, files: 2 });
  assert.equal(h.calls.copyIn.length, 1);
  assert.equal(h.calls.copyOut.length, 0);
  const key = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  assert.equal(readFileSync(path.join(h.ctrDir, ".claude", "projects", key, `${SESSION}.jsonl`), "utf8"), "transcript\n");
  assert.equal(readFileSync(path.join(h.ctrDir, ".claude", "projects", key, SESSION, "sub.jsonl"), "utf8"), "subagent\n");
  // The idle reaper must not be able to stop the container mid-copy, and the lease is handed back.
  assert.equal(h.calls.leases.length, 1);
  assert.equal(h.calls.leases[0].kind, "run");
  assert.equal(h.calls.leases[0].released, true);
  assert.match(h.logs.join("\n"), /carried claude session .* host→container \(2 files\)/);
  // The source is never removed: the container copy is now the newest, the host copy is a backup.
  assert.equal(existsSync(claudeHostFile(SESSION, cwd)), true);
});

test("carry: container→host copies the session out of the environment the channel just left", async () => {
  const h = carryHarness("out");
  const cwd = "/w/out";
  const sessionId = "aaaa1111-2222-4000-8000-bbbbccccdddd";
  const key = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  write(path.join(h.ctrDir, ".claude", "projects", key, `${sessionId}.jsonl`), "in-container\n");

  const result = await carrySession({
    engine: "claude", sessionId, cwd,
    storedRuntime: JSON.stringify({ backend: "container", image: "channelgate/runtime:test" }),
    target: h.hostTarget, slug: "out", threadKey: "1.2", resolveFor: h.resolveFor, log: h.log,
  });

  assert.deepEqual(result, { direction: CARRY_DIRECTIONS.OUT, files: 1 });
  assert.equal(h.calls.copyOut.length, 1);
  assert.equal(h.calls.copyIn.length, 0);
  assert.equal(readFileSync(claudeHostFile(sessionId, cwd), "utf8"), "in-container\n");
  // The lease is taken on the CONTAINER — the side that has to stay up for the copy — even though
  // this turn runs on the host.
  assert.equal(h.calls.leases.length, 1);
  assert.equal(h.calls.leases[0].released, true);
});

test("carry: no files to carry is silent, and the resume simply falls back to the heal", async () => {
  const h = carryHarness("none");
  const result = await carrySession({
    engine: "claude", sessionId: "0000ffff-0000-4000-8000-000000000000", cwd: "/w/none", storedRuntime: "",
    target: h.containerTarget, slug: "none", threadKey: "1.3", resolveFor: h.resolveFor, log: h.log,
  });
  assert.equal(result, null);
  assert.equal(h.calls.copyIn.length, 1, "the copy is still attempted — only the engine knows if a file exists");
  assert.deepEqual(h.logs, [], "nothing was carried, so nothing is claimed");
});

test("carry: a backend that throws never fails the turn — it logs and hands back to the heal", async () => {
  const h = carryHarness("boom");
  const cwd = "/w/boom";
  write(claudeHostFile(SESSION, cwd), "transcript\n");
  h.containerTarget.runtime.copyIn = async () => {
    throw new Error("no container CLI on PATH");
  };
  const result = await carrySession({
    engine: "claude", sessionId: SESSION, cwd, storedRuntime: "",
    target: h.containerTarget, slug: "boom", threadKey: "1.4", resolveFor: h.resolveFor, log: h.log,
  });
  assert.equal(result, null);
  assert.match(h.logs.join("\n"), /session carry-over failed \(no container CLI on PATH\) — the resume falls back to the existing heal/);
  // …and the lease it took on the way in is still handed back.
  assert.equal(h.calls.leases[0].released, true);
});

test("carry: an engine with no session-state fact, and a backend that cannot carry, are both skipped", async () => {
  const noFact = carryHarness("nofact");
  const skipped = await carrySession({
    engine: "opencode", sessionId: SESSION, cwd: "/w/nofact", storedRuntime: "",
    target: noFact.containerTarget, slug: "nofact", threadKey: "1.5", resolveFor: noFact.resolveFor, log: noFact.log,
  });
  assert.equal(skipped, null);
  assert.equal(noFact.calls.copyIn.length, 0);
  assert.match(noFact.logs.join("\n"), /opencode does not declare where it keeps a session/);

  const noCarry = carryHarness("nocarry");
  write(claudeHostFile(SESSION, "/w/nocarry"), "transcript\n");
  delete noCarry.containerTarget.runtime.copyIn;
  delete noCarry.containerTarget.runtime.copyOut;
  const result = await carrySession({
    engine: "claude", sessionId: SESSION, cwd: "/w/nocarry", storedRuntime: "",
    target: noCarry.containerTarget, slug: "nocarry", threadKey: "1.6", resolveFor: noCarry.resolveFor, log: noCarry.log,
  });
  assert.equal(result, null);
  assert.match(noCarry.logs.join("\n"), /cannot move session state/);
});

test("carry: entries pair the engine's relative paths with both state dirs, sharing the tail", () => {
  const entries = buildCarryEntries({
    engine: "codex", cwd: "/w/pair", sessionId: SESSION,
    fromDir: "/host/.codex", toDir: "/home/agent/.codex",
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].rel, `sessions/*/*/*/*-${SESSION}.jsonl`);
  assert.equal(entries[0].from, `/host/.codex/sessions/*/*/*/*-${SESSION}.jsonl`);
  assert.equal(entries[0].to, `/home/agent/.codex/sessions/*/*/*/*-${SESSION}.jsonl`);
  // Identical state dirs mean there is no boundary to cross.
  assert.deepEqual(buildCarryEntries({ engine: "codex", cwd: "/w", sessionId: SESSION, fromDir: "/same", toDir: "/same" }), []);
});
