import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = mkdtempSync(path.join(os.tmpdir(), "cg-vscode-test-"));
process.env.CHANNELGATE_DIR = path.join(scratch, "gateway");
const { createEditorLease, activeEditorLeases } = await import("../src/runtimes/container/editor-lease.js");
const { createContainerReaper } = await import("../src/runtimes/container/reaper.js");
const { vscodeAttachedContainerUri, installVscodeClaudeRelay, launchVscodeContainer } = await import("../src/runtimes/container/vscode.js");

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
