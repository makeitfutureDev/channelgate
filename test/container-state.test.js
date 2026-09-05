// Reading engine state INSIDE the container — the half of `/resume` adoption that exists because
// the daemon cannot open a channel's HOME volume at all (rootless Podman owns the volume's own
// directory as the mapped sub-uid, mode 0700).
//
// As with the carry, the generated script is not merely asserted on: it is EXECUTED by this
// machine's real /bin/sh against a scratch directory standing in for the container's state dir, so
// a script the daemon never runs cannot pass here and fail in production.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

process.env.CG_WORKSPACE_DIR ||= tempDir("cg-ws-");
ensureTestEnv();

const { buildInspectScript, createContainerState, parseInspectOutput, INSPECT_TIMEOUT_MS } = await import("../src/runtimes/container/state.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");

const SETTINGS = {
  enabled: true, defaultBackend: "container", cli: "auto", image: "channelgate/runtime:latest",
  idleMinutes: 10, maxRunning: 8, pidsLimit: 1024, memory: "", cpus: "", hasClaudeOauthToken: true,
};
const SESSION = "7ac41b90-1111-4222-8333-44445555aaaa";

function write(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

// The "inside" of the container is a scratch directory: the exec that would run in the image runs
// here instead, through the same /bin/sh the image ships.
function harness({ execResult = null } = {}) {
  const target = resolveRuntime("state-ch", { platform: "slack", channelId: "C1" }, { settings: SETTINGS });
  const inside = tempDir("cg-inside-state-");
  const calls = [];
  const ensured = [];
  const logs = [];
  const exec = {
    async runExec(t, args, opts) {
      calls.push({ args: [...args], opts });
      if (execResult) return execResult;
      try {
        const stdout = execFileSync("/bin/sh", ["-c", args[3]], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { code: 0, stdout, stderr: "" };
      } catch (error) {
        return { code: error.status ?? 1, stdout: String(error.stdout || ""), stderr: String(error.stderr || error.message) };
      }
    },
  };
  const lifecycle = { async ensureUp(t) { ensured.push(t.container.name); return { created: false, started: false }; } };
  return { target, inside, calls, ensured, logs, state: createContainerState({ exec, lifecycle, log: (m) => logs.push(m) }) };
}

test("the inspect script quotes every literal, keeps the wildcards live, and caps what it reads", () => {
  const script = buildInspectScript(["/home/agent/.claude/projects/*/id.jsonl"], "MARK", { maxLines: 4, maxBytes: 128 });
  assert.equal(
    script,
    [
      "for f in /home/agent/.claude/projects/*/id.jsonl; do",
      '  if [ -f "$f" ]; then',
      `    printf '%s %s %s\\n' MARK "$(stat -c %Y "$f" 2>/dev/null || echo 0)" "$f"`,
      '    head -c 128 "$f" 2>/dev/null | head -n 4 2>/dev/null || true',
      `    printf '\\n'`,
      "  fi",
      "done",
      "exit 0",
    ].join("\n")
  );
  // A directory with a space stays ONE shell word while its wildcard is still expanded.
  assert.match(buildInspectScript(["/a b/sessions/*/x.jsonl"], "M"), /for f in '\/a b\/sessions\/'\*\/x\.jsonl; do/);
});

test("a match comes back with its mtime and only the opening lines of the transcript", async () => {
  const h = harness();
  const claude = path.join(h.inside, ".claude");
  const key = "-home-agent-work";
  const lines = [
    JSON.stringify({ type: "user", sessionId: SESSION, cwd: "/home/agent/work" }),
    JSON.stringify({ type: "assistant", text: "x".repeat(4000) }),
    JSON.stringify({ type: "assistant", text: "later" }),
  ];
  write(path.join(claude, "projects", key, `${SESSION}.jsonl`), `${lines.join("\n")}\n`);
  // A second project directory that does NOT hold this id must not answer.
  write(path.join(claude, "projects", "-other", "aaaaaaaa-0000-0000-0000-000000000000.jsonl"), "{}\n");

  const found = await h.state.inspectState(h.target, { globs: [path.join(claude, "projects", "*", `${SESSION}.jsonl`)], maxLines: 2 });
  assert.equal(found.length, 1);
  assert.equal(found[0].path, path.join(claude, "projects", key, `${SESSION}.jsonl`));
  assert.ok(found[0].mtimeMs > 0, "the mtime comes back in milliseconds");
  assert.equal(JSON.parse(found[0].head[0]).cwd, "/home/agent/work");
  assert.ok(!found[0].head.join("\n").includes("later"), "the line cap stops before the rest of the transcript");
  // A stopped container is the normal case — the state lives in the volume, which outlives it.
  assert.deepEqual(h.ensured, [h.target.container.name]);
  assert.equal(h.calls[0].opts.timeoutMs, INSPECT_TIMEOUT_MS);
});

test("a byte cap truncates a single enormous line instead of reading it whole", async () => {
  const h = harness();
  const dir = path.join(h.inside, ".claude", "projects", "-p");
  write(path.join(dir, `${SESSION}.jsonl`), `${JSON.stringify({ type: "user", cwd: "/home/agent/work", blob: "y".repeat(50_000) })}\n`);
  const found = await h.state.inspectState(h.target, { globs: [path.join(dir, `${SESSION}.jsonl`)], maxBytes: 512 });
  assert.equal(found.length, 1);
  // 512 ASCII bytes of the one 50 KB line, and a truncated JSON record simply fails to parse —
  // which is already how session-adopt.js treats a corrupt one.
  assert.equal(found[0].head[0].length, 512);
  assert.throws(() => JSON.parse(found[0].head[0]));
});

test("an unmatched pattern is no match rather than a literal path, and nothing is a no-op", async () => {
  const h = harness();
  assert.deepEqual(await h.state.inspectState(h.target, { globs: [path.join(h.inside, ".codex/sessions/*/*/*/*-nope.jsonl")] }), []);
  assert.deepEqual(await h.state.inspectState(h.target, { globs: [] }), []);
  assert.equal(h.calls.length, 1, "an empty request never reaches the container");
});

test("transcript content can never forge a record boundary", () => {
  // The marker is random per call, so a transcript that quotes an OLD marker cannot split a record.
  const body = ["cg-state-deadbeefdeadbeef 1 /spoofed", '{"type":"user"}'].join("\n");
  const parsed = parseInspectOutput(`cg-state-0123456789abcdef 1700000000 /real\n${body}\n`, "cg-state-0123456789abcdef");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].path, "/real");
  assert.equal(parsed[0].mtimeMs, 1_700_000_000_000);
  assert.ok(parsed[0].head.includes("cg-state-deadbeefdeadbeef 1 /spoofed"), "the spoofed line is content, not a record");
});

test("a failed exec is an error, not a silent 'no such session'", async () => {
  const h = harness({ execResult: { code: 125, stdout: "", stderr: "no such container" } });
  await assert.rejects(
    () => h.state.inspectState(h.target, { globs: ["/home/agent/.claude/projects/*/x.jsonl"] }),
    /reading engine state in .* failed: no such container/
  );
});
