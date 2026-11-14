// Session carry-over: a thread that last ran on the host (a row from before every channel ran in a
// container) has its ENGINE-NATIVE history copied into the container about to resume it. Three
// layers are covered here — the per-engine facts that say where a session's files live, the
// host-side copy/expansion those facts feed, and the orchestrator that decides whether a carry
// happens at all. The container half is test/container-carry.test.js; the turn-level ordering
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
const { hostClaudeStateDir, hostCodexStateDir } = await import("../src/engines/host-state.js");
const { hostBackend } = await import("../src/runtimes/host.js");

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
  assert.equal(engineStateDir("claude", null), hostClaudeStateDir());
  assert.equal(engineStateDir("codex", null), hostCodexStateDir());
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

// A container target whose "state dir" is a real scratch directory, so a carry actually moves
// files and the assertions can look at what arrived.
function carryHarness(name) {
  const root = scratch(name);
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
  const meta = { platform: "slack", channelId: "C1" };
  const containerTarget = {
    backend: "container", slug: name, meta, runtime,
    container: { name: `cg-${name}`, claudeConfigDir: path.join(ctrDir, ".claude"), codexHome: path.join(ctrDir, ".codex") },
  };
  const logs = [];
  return { root, ctrDir, calls, containerTarget, logs, log: (m) => logs.push(m) };
}

// The direct host backend uses the native CLI state dir, which the scratch env pins.
function claudeHostFile(sessionId, cwd) {
  const key = String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(hostClaudeStateDir(), "projects", key, `${sessionId}.jsonl`);
}

test("carry: same backend on both sides is a no-op — a recreated container still has its volume", async () => {
  const h = carryHarness("same");
  const result = await carrySession({
    engine: "claude", sessionId: SESSION, cwd: "/w/same",
    storedRuntime: JSON.stringify({ backend: "container", fingerprint: "c1-old" }),
    target: h.containerTarget, slug: "same", threadKey: "1.0", log: h.log,
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
    target: h.containerTarget, slug: "in", threadKey: "1.1", log: h.log,
  });

  assert.deepEqual(result, { direction: CARRY_DIRECTIONS.IN, files: 2, sources: 0 });
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

test("carry: container→host copies session history out for a sudo turn", async () => {
  assert.deepEqual(Object.keys(CARRY_DIRECTIONS), ["IN", "OUT"]);
  assert.equal(CARRY_DIRECTIONS.IN, "host→container");
  assert.equal(CARRY_DIRECTIONS.OUT, "container→host");

  const h = carryHarness("out");
  const cwd = "/w/out";
  const sessionId = "aaaa1111-2222-4000-8000-bbbbccccdddd";
  const key = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  write(path.join(h.ctrDir, ".claude", "projects", key, `${sessionId}.jsonl`), "in-container\n");

  const hostTarget = hostBackend.prepareTarget({
    slug: "out", platform: "slack", meta: { platform: "slack", sudoMode: true },
    cwd, workDir: cwd, cleanWorkDir: "", settings: {}, artifactDir: null,
  });
  const result = await carrySession({
    engine: "claude", sessionId, cwd,
    storedRuntime: JSON.stringify({ backend: "container", image: "channelgate/runtime:test" }),
    target: hostTarget, slug: "out", threadKey: "1.2", log: h.log,
    resolveFor: () => h.containerTarget,
  });

  assert.deepEqual(result, { direction: CARRY_DIRECTIONS.OUT, files: 1, sources: 0 });
  assert.equal(h.calls.copyOut.length, 1);
  assert.equal(h.calls.copyIn.length, 0);
  assert.equal(h.calls.leases.length, 1, "the source container stays leased while state is copied out");
  assert.equal(readFileSync(claudeHostFile(sessionId, cwd), "utf8"), "in-container\n");
  assert.match(h.logs.join("\n"), /container→host \(1 file\)/);
});

test("carry: no files to carry is silent, and the resume simply falls back to the heal", async () => {
  const h = carryHarness("none");
  const result = await carrySession({
    engine: "claude", sessionId: "0000ffff-0000-4000-8000-000000000000", cwd: "/w/none", storedRuntime: "",
    target: h.containerTarget, slug: "none", threadKey: "1.3", log: h.log,
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
    target: h.containerTarget, slug: "boom", threadKey: "1.4", log: h.log,
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
    target: noFact.containerTarget, slug: "nofact", threadKey: "1.5", log: noFact.log,
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
    target: noCarry.containerTarget, slug: "nocarry", threadKey: "1.6", log: noCarry.log,
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

test("carry: cancellation propagates and releases its lease instead of healing", async () => {
  const h = carryHarness("cancel");
  const controller = new AbortController();
  const announce = () => {};
  h.containerTarget.runtime.copyIn = async (_target, _entries, opts) => {
    assert.equal(opts.signal, controller.signal);
    assert.equal(opts.announce, announce);
    assert.equal(typeof opts.lease.release, "function");
    controller.abort();
    throw controller.signal.reason;
  };
  await assert.rejects(carrySession({
    engine: "claude", sessionId: SESSION, cwd: "/w/cancel", storedRuntime: "host",
    target: h.containerTarget, signal: controller.signal, announce, log: h.log,
  }), { name: "AbortError" });
  assert.equal(h.calls.leases[0].released, true);
  assert.deepEqual(h.logs, []);
});

test("carry: a stopped turn never acquires a lease or starts copying", async () => {
  const h = carryHarness("pre-cancel");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(carrySession({
    engine: "claude", sessionId: SESSION, cwd: "/w/cancel", target: h.containerTarget,
    signal: controller.signal, log: h.log,
  }), { name: "AbortError" });
  assert.equal(h.calls.leases.length, 0);
});

// ── Fork lineage: a paginated Codex fork needs its source rollouts on the side that resumes it ──

const { readFirstLine, locateSessionFile, sessionParentOnHost, CARRY_LINEAGE_LIMIT } = await import("../src/gateway/session-carry.js");
const { engineSessionParent } = await import("../src/engines/registry.js");

// A Codex rollout as 0.162 writes it: the first line is `session_meta`; a fork is `paginated`
// and names the rollout it was cut from, a root (or a pre-pagination fork) is `legacy`.
function codexMeta(id, parent = "") {
  const payload = {
    id, session_id: id, cli_version: "0.162.1", history_mode: parent ? "paginated" : "legacy",
    base_instructions: { text: "You are Codex. ".repeat(2000) },
    ...(parent ? { forked_from_id: parent, forked_from_ordinal_exclusive: 376, history_base: { thread_id: parent, end_ordinal_exclusive: 376, end_byte_offset: 1472466 } } : {}),
  };
  return `${JSON.stringify({ timestamp: "2026-11-14T14:03:00.362Z", type: "session_meta", payload })}\n{"type":"response_item","payload":{"type":"message"}}\n`;
}
function codexRollout(stateDir, id, day = "2026/11/14") {
  return path.join(stateDir, "sessions", day, `rollout-2026-11-14T16-03-00-${id}.jsonl`);
}
const CHILD = "01a1da5e-5f14-7420-a6dc-71def784eb3d";
const PARENT = "01a1d921-e18b-7d21-a2db-230d62d843a0";
const ROOT = "01a1d72a-e785-76b3-872d-7d422597c17a";

test("engine facts: Codex names the source of a paginated fork from the rollout's first line, and nothing else", () => {
  assert.equal(engineSessionParent("codex", codexMeta(CHILD, PARENT).split("\n")[0]), PARENT);
  // A legacy rollout holds its whole history: no source to follow, even when it records a fork.
  const legacy = JSON.stringify({ type: "session_meta", payload: { id: CHILD, forked_from_id: PARENT, history_mode: "legacy" } });
  assert.equal(engineSessionParent("codex", legacy), "");
  // Not a header, not JSON, a self-reference, no fact at all: all "no parent", never a throw.
  assert.equal(engineSessionParent("codex", JSON.stringify({ type: "response_item", payload: { history_mode: "paginated", forked_from_id: PARENT } })), "");
  assert.equal(engineSessionParent("codex", "{not json"), "");
  assert.equal(engineSessionParent("codex", JSON.stringify({ type: "session_meta", payload: { id: CHILD, history_mode: "paginated", forked_from_id: CHILD } })), "");
  assert.equal(engineSessionParent("claude", codexMeta(CHILD, PARENT)), "", "Claude's --fork-session copies the history: nothing to follow");
  assert.equal(engineSessionParent("opencode", codexMeta(CHILD, PARENT)), "");
});

test("engine facts: a parentSession fact that is not a function does not load", async () => {
  const { validateEngineAdapter } = await import("../src/engines/contract.js");
  const { adapterFor } = await import("../src/engines/registry.js");
  const base = adapterFor("codex");
  assert.throws(
    () => validateEngineAdapter({ ...base, sessionState: { ...base.sessionState, parentSession: "forked_from_id" } }),
    /malformed parentSession/,
  );
});

test("header: the first line is read without loading the rest, and a lineage header is located by pattern", () => {
  const root = scratch("header");
  const file = write(codexRollout(root, CHILD), codexMeta(CHILD, PARENT));
  const line = readFirstLine(file);
  assert.equal(line.includes("\n"), false);
  assert.equal(JSON.parse(line).payload.forked_from_id, PARENT);
  assert.equal(readFirstLine(path.join(root, "absent.jsonl")), "");
  assert.equal(readFirstLine(file, 16), "", "a line longer than the limit is not a header");
  assert.equal(locateSessionFile("codex", { stateDir: root, cwd: "/w", sessionId: CHILD }), file);
  assert.equal(locateSessionFile("codex", { stateDir: root, cwd: "/w", sessionId: PARENT }), "");
  assert.equal(sessionParentOnHost("codex", { stateDir: root, cwd: "/w", sessionId: CHILD }), PARENT);
  assert.equal(sessionParentOnHost("codex", { stateDir: root, cwd: "/w", sessionId: PARENT }), "");
});

test("copy: an ifMissing file is written only where the destination has none — a directory still merges", () => {
  const root = scratch("ifmissing");
  const from = path.join(root, "from");
  const to = path.join(root, "to");
  write(codexRollout(from, PARENT), "container-copy\n");
  write(codexRollout(to, PARENT), "live-on-this-side\n");
  write(codexRollout(from, ROOT), "root-copy\n");
  const entry = (id) => ({ rel: `sessions/*/*/*/*-${id}.jsonl`, kind: "file", ifMissing: true, from: path.join(from, `sessions/*/*/*/*-${id}.jsonl`), to: path.join(to, `sessions/*/*/*/*-${id}.jsonl`) });
  assert.equal(expandCarryEntry(entry(PARENT))[0].ifMissing, true, "the flag survives expansion");
  assert.equal(copyCarryEntries([entry(PARENT), entry(ROOT)]), 1);
  assert.equal(readFileSync(codexRollout(to, PARENT), "utf8"), "live-on-this-side\n");
  assert.equal(readFileSync(codexRollout(to, ROOT), "utf8"), "root-copy\n");
  // Without the flag the rule stays overwrite.
  assert.equal(copyCarryEntries([{ ...entry(PARENT), ifMissing: false }]), 1);
  assert.equal(readFileSync(codexRollout(to, PARENT), "utf8"), "container-copy\n");
});

function hostTargetFor(slug, cwd) {
  return hostBackend.prepareTarget({
    slug, platform: "slack", meta: { platform: "slack", sudoMode: true },
    cwd, workDir: cwd, cleanWorkDir: "", settings: {}, artifactDir: null,
  });
}

test("carry: container→host brings a Codex fork's source rollouts along, as far up as the chain goes", async () => {
  const h = carryHarness("lineage-out");
  const cwd = "/w/lineage-out";
  const ctrCodex = path.join(h.ctrDir, ".codex");
  // The Atlas int-hubexo-nordics shape: a fork of a fork, the root a legacy rollout, every file in
  // the channel's HOME volume and none of them on the host.
  write(codexRollout(ctrCodex, CHILD), codexMeta(CHILD, PARENT));
  write(codexRollout(ctrCodex, PARENT, "2026/11/13"), codexMeta(PARENT, ROOT));
  write(codexRollout(ctrCodex, ROOT, "2026/11/12"), codexMeta(ROOT));

  const result = await carrySession({
    engine: "codex", sessionId: CHILD, cwd,
    storedRuntime: JSON.stringify({ backend: "container", image: "channelgate/runtime:test" }),
    target: hostTargetFor("lineage-out", cwd), slug: "lineage-out", threadKey: "2.1", log: h.log,
    resolveFor: () => h.containerTarget,
  });

  assert.deepEqual(result, { direction: CARRY_DIRECTIONS.OUT, files: 3, sources: 2 });
  // One copy per link: the daemon cannot read a header until it has arrived on the host.
  assert.equal(h.calls.copyOut.length, 3);
  assert.deepEqual(h.calls.copyOut.map((entries) => entries.map((e) => e.rel)), [
    [`sessions/*/*/*/*-${CHILD}.jsonl`], [`sessions/*/*/*/*-${PARENT}.jsonl`], [`sessions/*/*/*/*-${ROOT}.jsonl`],
  ]);
  for (const [id, day] of [[CHILD, "2026/11/14"], [PARENT, "2026/11/13"], [ROOT, "2026/11/12"]]) {
    assert.equal(existsSync(codexRollout(hostCodexStateDir(), id, day)), true, `${id} arrived with its date directory`);
  }
  assert.equal(h.calls.leases.length, 1, "one lease spans the whole chain");
  assert.equal(h.calls.leases[0].released, true);
  assert.match(h.logs.join("\n"), /carried codex session .* container→host \(3 files, 2 fork sources\)/);
});

test("carry: a source the host already holds is kept as it is, but the walk continues past it", async () => {
  const h = carryHarness("lineage-keep");
  const cwd = "/w/lineage-keep";
  const ctrCodex = path.join(h.ctrDir, ".codex");
  const child = "01a1da5e-aaaa-7420-a6dc-000000000001";
  const parent = "01a1d921-aaaa-7d21-a2db-000000000002";
  const root = "01a1d72a-aaaa-76b3-872d-000000000003";
  write(codexRollout(ctrCodex, child), codexMeta(child, parent));
  write(codexRollout(ctrCodex, parent), codexMeta(parent, root));
  write(codexRollout(ctrCodex, root), codexMeta(root));
  // The parent's own thread was /sudo'd earlier and has run on the host since: its host copy is
  // the live one (longer than the container's), and it names the same root — which never came.
  write(codexRollout(hostCodexStateDir(), parent), `${codexMeta(parent, root)}{"type":"response_item","payload":{"host":"turn"}}\n`);

  const result = await carrySession({
    engine: "codex", sessionId: child, cwd,
    storedRuntime: JSON.stringify({ backend: "container" }),
    target: hostTargetFor("lineage-keep", cwd), slug: "lineage-keep", threadKey: "2.2", log: h.log,
    resolveFor: () => h.containerTarget,
  });

  assert.deepEqual(result, { direction: CARRY_DIRECTIONS.OUT, files: 2, sources: 1 });
  assert.deepEqual(h.calls.copyOut.map((entries) => entries.map((e) => e.rel)), [
    [`sessions/*/*/*/*-${child}.jsonl`], [`sessions/*/*/*/*-${root}.jsonl`],
  ]);
  assert.match(readFileSync(codexRollout(hostCodexStateDir(), parent), "utf8"), /"host":"turn"/, "the live host copy was not overwritten");
  assert.equal(existsSync(codexRollout(hostCodexStateDir(), root)), true);
});

test("carry: a lineage cycle, a broken chain and a Claude session all stop cleanly", async () => {
  const cycle = carryHarness("lineage-cycle");
  const ctrCodex = path.join(cycle.ctrDir, ".codex");
  const a = "01a1da5e-bbbb-7420-a6dc-000000000001";
  const b = "01a1d921-bbbb-7d21-a2db-000000000002";
  write(codexRollout(ctrCodex, a), codexMeta(a, b));
  write(codexRollout(ctrCodex, b), codexMeta(b, a));
  const looped = await carrySession({
    engine: "codex", sessionId: a, cwd: "/w/cycle", storedRuntime: JSON.stringify({ backend: "container" }),
    target: hostTargetFor("lineage-cycle", "/w/cycle"), slug: "lineage-cycle", threadKey: "2.3", log: cycle.log,
    resolveFor: () => cycle.containerTarget,
  });
  assert.deepEqual(looped, { direction: CARRY_DIRECTIONS.OUT, files: 2, sources: 1 });
  assert.equal(cycle.calls.copyOut.length, 2);

  const broken = carryHarness("lineage-broken");
  const c = "01a1da5e-cccc-7420-a6dc-000000000001";
  write(codexRollout(path.join(broken.ctrDir, ".codex"), c), codexMeta(c, "01a1d921-cccc-7d21-a2db-000000000009"));
  const partial = await carrySession({
    engine: "codex", sessionId: c, cwd: "/w/broken", storedRuntime: JSON.stringify({ backend: "container" }),
    target: hostTargetFor("lineage-broken", "/w/broken"), slug: "lineage-broken", threadKey: "2.4", log: broken.log,
    resolveFor: () => broken.containerTarget,
  });
  // The source is missing on the container side too: the session still arrives (the heal takes
  // over at resume time), and the walk does not keep asking.
  assert.deepEqual(partial, { direction: CARRY_DIRECTIONS.OUT, files: 1, sources: 0 });
  assert.equal(broken.calls.copyOut.length, 2);
  assert.ok(CARRY_LINEAGE_LIMIT >= 8 && CARRY_LINEAGE_LIMIT <= 64, "bounded, but no hand-made chain reaches it");

  // A Claude transcript declares no parent: exactly the one copy there always was.
  const claude = carryHarness("lineage-claude");
  const cwd = "/w/lineage-claude";
  write(claudeHostFile(SESSION, cwd), "transcript\n");
  const plain = await carrySession({
    engine: "claude", sessionId: SESSION, cwd, storedRuntime: "",
    target: claude.containerTarget, slug: "lineage-claude", threadKey: "2.5", log: claude.log,
  });
  assert.deepEqual(plain, { direction: CARRY_DIRECTIONS.IN, files: 1, sources: 0 });
  assert.equal(claude.calls.copyIn.length, 1);
});

test("carry: host→container copies a fork and its sources in one go, and never over a source the container has", async () => {
  const h = carryHarness("lineage-in");
  const cwd = "/w/lineage-in";
  const ctrCodex = path.join(h.ctrDir, ".codex");
  const child = "01a1da5e-dddd-7420-a6dc-000000000001";
  const parent = "01a1d921-dddd-7d21-a2db-000000000002";
  const root = "01a1d72a-dddd-76b3-872d-000000000003";
  // /sudo off: the fork ran on the host (its chain came out with it); the parent's thread kept
  // running in the container meanwhile, so the container's copy is the live one.
  write(codexRollout(hostCodexStateDir(), child), codexMeta(child, parent));
  write(codexRollout(hostCodexStateDir(), parent), codexMeta(parent, root));
  write(codexRollout(hostCodexStateDir(), root), codexMeta(root));
  write(codexRollout(ctrCodex, parent), `${codexMeta(parent, root)}{"type":"response_item","payload":{"container":"turn"}}\n`);

  const result = await carrySession({
    engine: "codex", sessionId: child, cwd, storedRuntime: JSON.stringify({ backend: "host" }),
    target: h.containerTarget, slug: "lineage-in", threadKey: "2.6", log: h.log,
  });

  assert.equal(result.direction, CARRY_DIRECTIONS.IN);
  assert.equal(result.sources, 2);
  assert.equal(h.calls.copyIn.length, 1, "the chain is read on the host first, then copied once");
  const entries = h.calls.copyIn[0];
  assert.deepEqual(entries.map((e) => [e.rel, e.ifMissing === true]), [
    [`sessions/*/*/*/*-${child}.jsonl`, false],
    [`sessions/*/*/*/*-${parent}.jsonl`, true],
    [`sessions/*/*/*/*-${root}.jsonl`, true],
  ]);
  assert.match(readFileSync(codexRollout(ctrCodex, child), "utf8"), /"forked_from_id"/);
  assert.match(readFileSync(codexRollout(ctrCodex, parent), "utf8"), /"container":"turn"/, "the live container copy survived");
  assert.equal(existsSync(codexRollout(ctrCodex, root)), true);
  assert.match(h.logs.join("\n"), /host→container \(2 files, 2 fork sources\)/);
});
