import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = mkdtempSync(path.join(os.tmpdir(), "cg-vscode-test-"));
process.env.CHANNELGATE_DIR = path.join(scratch, "gateway");
const { createEditorLease, activeEditorLeases, editorLeaseDir } = await import("../src/runtimes/container/editor-lease.js");
const { createContainerReaper } = await import("../src/runtimes/container/reaper.js");
const { vscodeAttachedContainerUri, launchVscodeContainer } = await import("../src/runtimes/container/vscode.js");

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

test("agent-writable lease symlinks cannot make the daemon inspect or delete unrelated files", () => {
  const t = target("lease-path");
  const unrelated = path.join(scratch, "unrelated");
  mkdirSync(unrelated);
  writeFileSync(path.join(unrelated, "keep.json"), "unrelated file");
  symlinkSync(unrelated, path.join(t.artifactDir, "editor-leases"), "dir");
  assert.deepEqual(activeEditorLeases(t), []);
  const lease = createEditorLease(t);
  assert.ok(editorLeaseDir(t).startsWith(process.env.CHANNELGATE_DIR));
  assert.equal(activeEditorLeases(t).length, 1);
  lease.release();
  assert.equal(readFileSync(path.join(unrelated, "keep.json"), "utf8"), "unrelated file");
});

test("launcher holds an external lease until code --wait exits without exporting daemon authentication", async () => {
  const t = target("launch");
  let codeSawLease = false;
  await launchVscodeContainer(t, {
    cliBin: "podman",
    refreshMs: 60_000,
    resolveToken: async () => assert.fail("must not resolve a daemon credential"),
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
