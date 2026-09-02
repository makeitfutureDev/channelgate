// The container half of the session carry-over: staging through the bind-mounted artifact dir and
// the ONE `sh -c` that does the copy on the other side of the boundary.
//
// The generated scripts are not just asserted on — they are EXECUTED, by this machine's real
// /bin/sh, against scratch directories standing in for the container's state dir. A carry that
// composes a shell script the daemon never runs would otherwise only be proved correct by the
// production incident it caused.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

process.env.CG_WORKSPACE_DIR ||= tempDir("cg-ws-");
ensureTestEnv();

const { createContainerCarry, buildCopyInScript, buildCopyOutScript, carryStagingDir, shellQuote, shellQuoteGlob, CARRY_TIMEOUT_MS } = await import("../src/runtimes/container/carry.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { walkFiles } = await import("../src/runtimes/copy.js");

const SETTINGS = {
  enabled: true, defaultBackend: "container", cli: "auto", image: "channelgate/runtime:latest",
  idleMinutes: 10, maxRunning: 8, pidsLimit: 1024, memory: "", cpus: "", hasClaudeOauthToken: true,
};
const SESSION = "5c1d0e77-3333-4000-8000-0123456789ab";

function write(file, body = "x\n") {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

// A container target whose "inside" is a scratch directory: the exec that would run in the image
// runs here instead, so a real /bin/sh proves the script and the assertions can read the result.
function harness(slug, { execResult = null } = {}) {
  const target = resolveRuntime(slug, { platform: "slack", channelId: "C1", runtime: "container" }, { settings: SETTINGS });
  mkdirSync(target.artifactDir, { recursive: true });
  const inside = tempDir(`cg-inside-${slug}-`);
  const calls = [];
  const logs = [];
  const exec = {
    async runExec(t, args, opts) {
      calls.push({ args: [...args], opts });
      if (execResult) return execResult;
      try {
        execFileSync("/bin/sh", ["-c", args[3]], { stdio: ["ignore", "pipe", "pipe"] });
        return { code: 0, stdout: "", stderr: "" };
      } catch (error) {
        return { code: error.status ?? 1, stdout: "", stderr: String(error.stderr || error.message) };
      }
    },
  };
  const ensured = [];
  const lifecycle = { async ensureUp(t) { ensured.push(t.container.name); return { created: false, started: false }; } };
  const carry = createContainerCarry({ exec, lifecycle, log: (m) => logs.push(m) });
  return { target, inside, calls, logs, ensured, carry };
}

test("shell quoting: a literal path is quoted whole, a pattern keeps its wildcards live", () => {
  assert.equal(shellQuote("/home/agent/.claude"), "/home/agent/.claude");
  assert.equal(shellQuote("/a b/c"), "'/a b/c'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  // The literal runs are quoted, the `*` are not — adjacent parts concatenate into one shell word.
  assert.equal(shellQuoteGlob("/a b/sessions/*/*/x-1.jsonl"), "'/a b/sessions/'*/*/x-1.jsonl");
  assert.equal(shellQuoteGlob("/home/agent/.codex/sessions/*/*/*/*-id.jsonl"), "/home/agent/.codex/sessions/*/*/*/*-id.jsonl");
});

test("copyIn: the daemon stages under the artifact dir, one exec copies inside, staging is removed", async () => {
  const h = harness("carry-in");
  const hostRoot = tempDir("cg-host-");
  const key = "-w-carry-in";
  write(path.join(hostRoot, ".claude/projects", key, `${SESSION}.jsonl`), "transcript\n");
  write(path.join(hostRoot, ".claude/projects", key, SESSION, "sub.jsonl"), "subagent\n");
  const ctrClaude = path.join(h.inside, ".claude");
  const entries = [
    { rel: `projects/${key}/${SESSION}.jsonl`, kind: "file", from: path.join(hostRoot, ".claude/projects", key, `${SESSION}.jsonl`), to: path.join(ctrClaude, "projects", key, `${SESSION}.jsonl`) },
    { rel: `projects/${key}/${SESSION}`, kind: "dir", from: path.join(hostRoot, ".claude/projects", key, SESSION), to: path.join(ctrClaude, "projects", key, SESSION) },
    { rel: `projects/${key}/absent.jsonl`, kind: "file", from: path.join(hostRoot, ".claude/projects", key, "absent.jsonl"), to: path.join(ctrClaude, "projects", key, "absent.jsonl") },
  ];

  const result = await h.carry.copyIn(h.target, entries);
  assert.deepEqual(result, { copied: 2 });

  // Exactly one exec, addressed to this channel's container, running a shell script — never
  // `cg-exec` (this is not a run, it holds no process group) and never one exec per file.
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].args[0], h.target.container.name);
  assert.deepEqual(h.calls[0].args.slice(1, 3), ["/bin/sh", "-c"]);
  assert.equal(h.calls[0].opts.timeoutMs, CARRY_TIMEOUT_MS);
  assert.equal(h.ensured[0], h.target.container.name, "a stopped container is brought up first");

  // The files really arrived, subagent directory included.
  assert.equal(readFileSync(path.join(ctrClaude, "projects", key, `${SESSION}.jsonl`), "utf8"), "transcript\n");
  assert.equal(readFileSync(path.join(ctrClaude, "projects", key, SESSION, "sub.jsonl"), "utf8"), "subagent\n");
  assert.equal(existsSync(path.join(ctrClaude, "projects", key, "absent.jsonl")), false);
  // Nothing is left behind under the shared artifact dir.
  assert.deepEqual(walkFiles(path.join(h.target.artifactDir, "carry")), []);
});

test("copyIn: the staging layout mirrors the DESTINATION path, and a failed exec still cleans up", async () => {
  const h = harness("carry-in-fail", { execResult: { code: 1, stdout: "", stderr: "cp: cannot create" } });
  const hostRoot = tempDir("cg-host-");
  const from = write(path.join(hostRoot, "a.jsonl"), "body\n");
  const to = "/home/agent/.claude/projects/k/a.jsonl";

  await assert.rejects(
    h.carry.copyIn(h.target, [{ rel: "projects/k/a.jsonl", kind: "file", from, to }]),
    /copying session state into .* failed: cp: cannot create/,
  );
  // The staged tree mirrors the destination absolute path, which is what lets the other side apply
  // a carry by walking; and it is gone whether the exec worked or not.
  const script = h.calls[0].args[3];
  assert.match(script, /^set -e\n/);
  assert.ok(script.includes(`${h.target.artifactDir}/carry/`), "staged under the bind-mounted artifact dir");
  assert.ok(script.includes("/carry/") && script.includes("/home/agent/.claude/projects/k/a.jsonl"), "…mirroring the destination path");
  assert.equal(existsSync(path.join(h.target.artifactDir, "carry")), true, "the carry root itself may stay");
  assert.deepEqual(walkFiles(path.join(h.target.artifactDir, "carry")), []);
});

test("copyOut: one exec stages inside, the daemon drains it, and a rollout keeps its date directories", async () => {
  const h = harness("carry-out");
  const hostRoot = tempDir("cg-host-");
  const ctrCodex = path.join(h.inside, ".codex");
  write(path.join(ctrCodex, "sessions/2026/09/01", `rollout-2026-09-01T09-42-11-${SESSION}.jsonl`), "rollout\n");
  write(path.join(ctrCodex, "sessions/2026/09/01", "rollout-2026-09-01T09-42-11-other.jsonl"), "not mine\n");
  const hostCodex = path.join(hostRoot, ".codex");

  const result = await h.carry.copyOut(h.target, [{
    rel: `sessions/*/*/*/*-${SESSION}.jsonl`, kind: "file",
    from: path.join(ctrCodex, `sessions/*/*/*/*-${SESSION}.jsonl`),
    to: path.join(hostCodex, `sessions/*/*/*/*-${SESSION}.jsonl`),
  }]);

  assert.deepEqual(result, { copied: 1 });
  assert.equal(h.calls.length, 1, "one exec, not one per candidate directory");
  // The wildcard is expanded by the shell INSIDE, because only that side can see the file — and the
  // YYYY/MM/DD tree `codex exec resume` walks arrives intact.
  assert.deepEqual(walkFiles(hostCodex), [`sessions/2026/09/01/rollout-2026-09-01T09-42-11-${SESSION}.jsonl`]);
  assert.equal(readFileSync(path.join(hostCodex, "sessions/2026/09/01", `rollout-2026-09-01T09-42-11-${SESSION}.jsonl`), "utf8"), "rollout\n");
  // Someone else's rollout in the same directory is left where it is.
  assert.equal(existsSync(path.join(hostCodex, "sessions/2026/09/01", "rollout-2026-09-01T09-42-11-other.jsonl")), false);
  assert.equal(existsSync(path.join(ctrCodex, "sessions/2026/09/01", `rollout-2026-09-01T09-42-11-${SESSION}.jsonl`)), true, "the source is never deleted");
  assert.deepEqual(walkFiles(path.join(h.target.artifactDir, "carry")), []);
});

test("copyOut: a file the container stages OUTSIDE the requested state dirs is refused", async () => {
  const h = harness("carry-rogue");
  const hostRoot = tempDir("cg-host-");
  const rogue = path.join(tempDir("cg-rogue-"), "cron.d", "evil");
  const ctrClaude = path.join(h.inside, ".claude");
  write(path.join(ctrClaude, "projects/k", `${SESSION}.jsonl`), "legit\n");
  // A hostile (or simply buggy) container stages a second file naming a path nobody asked for.
  const rogueStager = {
    async runExec(t, args, opts) {
      h.calls.push({ args: [...args], opts });
      execFileSync("/bin/sh", ["-c", args[3]]);
      const staging = args[3].match(/carry\/[a-z0-9-]+/)[0];
      write(path.join(h.target.artifactDir, staging, rogue.replace(/^\//, "")), "pwned\n");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const carry = createContainerCarry({ exec: rogueStager, lifecycle: { async ensureUp() {} }, log: (m) => h.logs.push(m) });
  const hostClaude = path.join(hostRoot, ".claude");

  const result = await carry.copyOut(h.target, [{
    rel: `projects/k/${SESSION}.jsonl`, kind: "file",
    from: path.join(ctrClaude, "projects/k", `${SESSION}.jsonl`),
    to: path.join(hostClaude, "projects/k", `${SESSION}.jsonl`),
  }]);

  assert.deepEqual(result, { copied: 1 }, "the legitimate file still lands");
  assert.equal(existsSync(rogue), false, "…and a path outside the requested state dirs never gets written");
  assert.match(h.logs.join("\n"), /refusing a carried file outside the requested state dirs/);
});

test("scripts: copyIn merges a directory instead of nesting it, copyOut guards every source", () => {
  const inScript = buildCopyInScript([
    { staged: "/art/carry/1/home/agent/.claude/x.jsonl", to: "/home/agent/.claude/x.jsonl", kind: "file" },
    { staged: "/art/carry/1/home/agent/.claude/d", to: "/home/agent/.claude/d", kind: "dir" },
  ]);
  assert.match(inScript, /mkdir -p \/home\/agent\/\.claude\ncp -a \/art\/carry\/1\/home\/agent\/\.claude\/x\.jsonl \/home\/agent\/\.claude\/x\.jsonl/);
  // `cp -a src/. dst/` merges; `cp -a src dst` on an existing dst would create dst/d instead.
  assert.match(inScript, /cp -a \/art\/carry\/1\/home\/agent\/\.claude\/d\/\. \/home\/agent\/\.claude\/d\//);

  const outScript = buildCopyOutScript([
    { rel: "projects/k/x.jsonl", kind: "file", from: "/home/agent/.claude/projects/k/x.jsonl", to: "/host/.claude/projects/k/x.jsonl" },
    { rel: "projects/k/x", kind: "dir", from: "/home/agent/.claude/projects/k/x", to: "/host/.claude/projects/k/x" },
    { rel: "sessions/*/*/*/*-id.jsonl", kind: "file", from: "/home/agent/.codex/sessions/*/*/*/*-id.jsonl", to: "/host/.codex/sessions/*/*/*/*-id.jsonl" },
  ], "/art/carry/2");
  assert.match(outScript, /if \[ -e \/home\/agent\/\.claude\/projects\/k\/x\.jsonl \]; then/);
  assert.match(outScript, /if \[ -d \/home\/agent\/\.claude\/projects\/k\/x \]; then/);
  assert.match(outScript, /for f in \/home\/agent\/\.codex\/sessions\/\*\/\*\/\*\/\*-id\.jsonl; do/);
  // The staged mirror of the DESTINATION root, so the daemon can drain by walking.
  assert.ok(outScript.includes("d=/art/carry/2/host/.codex/${f#/home/agent/.codex/}"));
});

test("staging: each carry gets its own directory under the channel's artifact dir", () => {
  const target = resolveRuntime("carry-stage", { platform: "slack", channelId: "C1", runtime: "container" }, { settings: SETTINGS });
  assert.equal(carryStagingDir(target, "abc"), path.join(target.artifactDir, "carry", "abc"));
  // Never under the gateway root, and never a path the container cannot see.
  assert.ok(carryStagingDir(target, "abc").startsWith(target.artifactDir));
});

test("boot: the idle reaper runs even with the gateway switch off, so a carry cannot strand a container", async () => {
  const { createFakeCli } = await import("./container-fake-cli.js");
  const { __setContainerRuntime, __resetContainerRuntime, bootContainerRuntime, stopContainerRuntime } = await import("../src/runtimes/container/index.js");
  const fake = createFakeCli({ kind: "podman" });
  const ctx = __setContainerRuntime({ exec: fake.exec, log: () => {} });
  try {
    let started = 0;
    const realStart = ctx.reaper.startTimer;
    ctx.reaper.startTimer = (...args) => {
      started += 1;
      return realStart.apply(ctx.reaper, args);
    };
    // Disabled is the kill switch, not "the CLI is gone": a container→host carry may still start
    // one container to read its HOME volume, and nothing else would stop it again.
    await bootContainerRuntime({ settings: { ...SETTINGS, enabled: false }, log: () => {} });
    assert.equal(started, 1, "boot starts the reaper even with the runtime disabled");
    assert.equal(ctx.reaper.size, 0, "…and it is inert until a carry actually brings a container up");
  } finally {
    stopContainerRuntime();
    __resetContainerRuntime();
  }
});
