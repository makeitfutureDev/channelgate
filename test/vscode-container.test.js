import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = mkdtempSync(path.join(os.tmpdir(), "cg-vscode-test-"));
process.env.CHANNELGATE_DIR = path.join(scratch, "gateway");
const { createEditorLease, activeEditorLeases } = await import("../src/runtimes/container/editor-lease.js");
const { createContainerReaper } = await import("../src/runtimes/container/reaper.js");
const {
  vscodeAttachedContainerUri, installVscodeClaudeRelay, launchVscodeContainer, CLAUDE_ONBOARDING_SEED, CLAUDE_ONBOARDING_FILE,
} = await import("../src/runtimes/container/vscode.js");

test.after(() => rmSync(scratch, { recursive: true, force: true }));

function target(slug = "dev channel") {
  const artifactDir = path.join(scratch, slug.replaceAll(" ", "-"));
  mkdirSync(artifactDir, { recursive: true });
  return {
    slug, artifactDir, workDir: `/work/${slug}`,
    settings: { idleMinutes: 1 }, container: { name: `cg-${slug.replaceAll(" ", "-")}` },
  };
}

test("VS Code URI hex-encodes the exact container name and opens the mounted workdir", () => {
  const uri = vscodeAttachedContainerUri("cg-test-one", "/work/project one");
  assert.equal(uri, `vscode-remote://attached-container+${Buffer.from("cg-test-one").toString("hex")}/work/project%20one`);
});

test("signed editor lease keeps the reaper from stopping a container and releases cleanly", async () => {
  const t = target("lease");
  const stopped = [];
  let now = 0;
  const reaper = createContainerReaper({ now: () => now, stopContainer: async (name) => stopped.push(name) });
  reaper.markRunning(t.container.name, t);
  const lease = createEditorLease(t);
  now = 120_000;
  assert.equal(activeEditorLeases(t).length, 1);
  assert.equal(reaper.leaseCount(t.container.name), 1);
  assert.deepEqual(await reaper.tick(), []);
  lease.release();
  assert.deepEqual(await reaper.tick(), [t.container.name]);
});

test("Claude editor wrapper uses the refreshed relay only when a run did not inject one", async () => {
  const t = target("auth");
  const calls = [];
  const result = await installVscodeClaudeRelay(t, "podman", {
    resolveToken: async () => ({ token: "test-oauth-value", source: "operator", expiresAt: 123 }),
    runCommand: async (bin, args, options) => calls.push({ bin, args, options }),
  });
  assert.equal(result.source, "operator");
  assert.equal(readFileSync(result.tokenFile, "utf8"), "test-oauth-value");
  assert.equal(calls[0].bin, "podman");
  assert.match(calls[0].options.input, /\[ -z "\$\{CLAUDE_CODE_OAUTH_TOKEN:-\}" \]/);
  assert.match(calls[0].options.input, /exec \/usr\/local\/bin\/claude "\$@"/);
});

test("an API-key-only Claude identity is not disclosed to an interactive editor", async () => {
  await assert.rejects(
    installVscodeClaudeRelay(target("api-key"), "podman", {
      resolveToken: async () => ({ token: "", source: "api-key", expiresAt: 0 }),
      runCommand: async () => assert.fail("no container write should occur"),
    }),
    /deliberately not exported/,
  );
});

test("launcher holds an external lease until code --wait exits and removes the token", async () => {
  const t = target("launch");
  let codeSawLease = false;
  await launchVscodeContainer(t, {
    cliBin: "podman",
    refreshMs: 60_000,
    resolveToken: async () => ({ token: "test-token", source: "settings", expiresAt: 0 }),
    runCommand: async (bin, args) => {
      if (bin === "code") {
        codeSawLease = activeEditorLeases(t).length === 1;
        assert.deepEqual(args.slice(0, 2), ["--wait", "--folder-uri"]);
      }
    },
  });
  assert.equal(codeSawLease, true);
  assert.equal(activeEditorLeases(t).length, 0);
  assert.throws(() => readFileSync(path.join(t.artifactDir, "vscode", "claude-token")), /ENOENT/);
});

// Live finding (0.5.3 acceptance): SSH and VS Code Remote-SSH into a channel worked, but the first
// interactive `claude` opened the theme picker and a login screen — "not authenticated" — although
// `claude -p` in the same shell answered. The image sets CLAUDE_CONFIG_DIR, so Claude's state is
// $CLAUDE_CONFIG_DIR/.claude.json, and headless engine turns never complete onboarding there.
const seed = (file) => execFileSync(process.execPath, ["-e", CLAUDE_ONBOARDING_SEED, file], { encoding: "utf8" });

test("the relay records Claude onboarding in the file Claude actually reads, after the wrapper", async () => {
  assert.equal(CLAUDE_ONBOARDING_FILE, "/home/agent/.claude/.claude.json", "CLAUDE_CONFIG_DIR/.claude.json, not ~/.claude.json");
  const calls = [];
  await installVscodeClaudeRelay(target("seed"), "podman", {
    resolveToken: async () => ({ token: "test-oauth-value", source: "operator", expiresAt: 1 }),
    runCommand: async (bin, args, options) => calls.push({ bin, args, options }),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(0, 4), ["exec", "cg-seed", "node", "-e"], "run as the container's own user, like the wrapper");
  assert.equal(calls[1].args.at(-1), CLAUDE_ONBOARDING_FILE);
});

test("a failed onboarding write never blocks the attach", async () => {
  let n = 0;
  const result = await installVscodeClaudeRelay(target("seedfail"), "podman", {
    resolveToken: async () => ({ token: "test-oauth-value", source: "operator", expiresAt: 1 }),
    runCommand: async () => { if (++n === 2) throw new Error("node missing"); },
  });
  assert.equal(result.source, "operator");
});

test("the seed marks onboarding done on a fresh channel, and keeps a theme the developer chose", () => {
  const dir = mkdtempSync(path.join(scratch, "onboard-"));
  const fresh = path.join(dir, "fresh", ".claude.json");
  seed(fresh);
  assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), { hasCompletedOnboarding: true, theme: "dark" });
  assert.equal(statSync(fresh).mode & 0o777, 0o600);
  const chosen = path.join(dir, "chosen.json");
  writeFileSync(chosen, JSON.stringify({ theme: "light-daltonized", numStartups: 4 }));
  seed(chosen);
  assert.deepEqual(JSON.parse(readFileSync(chosen, "utf8")), { theme: "light-daltonized", numStartups: 4, hasCompletedOnboarding: true });
});

test("the seed merges into the channel's Claude state and never replaces or repairs it", () => {
  const dir = mkdtempSync(path.join(scratch, "onboard-"));
  const state = path.join(dir, "state.json");
  const existing = { projects: { "/work": { hasTrustDialogAccepted: false, allowedTools: ["Bash"] } }, userID: "abc" };
  writeFileSync(state, JSON.stringify(existing));
  seed(state);
  const merged = JSON.parse(readFileSync(state, "utf8"));
  assert.deepEqual(merged.projects, existing.projects, "folder trust is NOT pre-accepted; other state untouched");
  assert.equal(merged.userID, "abc");
  assert.equal(merged.hasCompletedOnboarding, true);
  // Already done: the file is not rewritten at all.
  const before = readFileSync(state, "utf8");
  seed(state);
  assert.equal(readFileSync(state, "utf8"), before);
  // Corrupt or non-object JSON is left exactly as it is, never "fixed".
  for (const body of ["{not json", "[1,2]", "null"]) {
    const bad = path.join(dir, `bad-${Math.random()}.json`);
    writeFileSync(bad, body);
    seed(bad);
    assert.equal(readFileSync(bad, "utf8"), body, `left alone: ${body}`);
  }
});
