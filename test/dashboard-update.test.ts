import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyCallsUpdate, isCallsOnlyUpdate, prepareCallsUpdate } from "../src/gateway/dashboard-update.ts";
import { callsFiles, readCallsRelease } from "../src/web/dashboard-release.ts";
import { buildCallsView } from "../src/web/calls-view-assets.ts";

function fixture() {
  const repo = mkdtempSync(path.join(tmpdir(), "cg-dashboard-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  mkdirSync(path.join(repo, "public/activity"), { recursive: true });
  const initial = { ts: 'const fixture: string = "A";', css: ".a{}", html: "<div>A</div>" };
  for (const key of Object.keys(callsFiles) as (keyof typeof callsFiles)[]) writeFileSync(path.join(repo, callsFiles[key]), initial[key]);
  const oldRevision = commit();
  writeFileSync(path.join(repo, callsFiles.html), "<div>B</div>");
  const targetRevision = commit();
  const baselineHealth = { ok: true, revision: oldRevision, instanceId: "daemon", callsView: { session: "boot", revision: buildCallsView(initial).revision } };
  return { repo, git, commit, initial, oldRevision, targetRevision, baselineHealth };
}

test("only existing regular Calls assets qualify, rollback to equivalent content does not strand the next update", t => {
  const f = fixture(); t.after(() => rmSync(f.repo, { recursive: true, force: true }));
  assert.ok(isCallsOnlyUpdate(f.repo, f.oldRevision, f.targetRevision));
  const release = prepareCallsUpdate(f.repo, f.oldRevision, f.targetRevision, f.baselineHealth);
  assert.ok(release);
  assert.equal(prepareCallsUpdate(f.repo, f.oldRevision, f.targetRevision, {}), null);
  assert.throws(() => prepareCallsUpdate(f.repo, f.oldRevision, f.targetRevision, { callsView: {session:"boot",revision:"wrong"} }));
  writeFileSync(path.join(f.repo, callsFiles.html), f.initial.html);
  const back = f.commit();
  assert.equal(isCallsOnlyUpdate(f.repo, f.oldRevision, back), false);
  assert.ok(isCallsOnlyUpdate(f.repo, f.oldRevision, back, true));
  writeFileSync(path.join(f.repo, "backend.js"), "// changed");
  assert.equal(isCallsOnlyUpdate(f.repo, f.oldRevision, f.commit(), true), false);
});

for (const mode of ["success", "validation failure", "changed instance", "rollback failure"]) {
  test(`dashboard checkout, publication and rollback: ${mode}`, async t => {
    const f = fixture(); t.after(() => rmSync(f.repo, { recursive: true, force: true }));
    const root = mkdtempSync(path.join(tmpdir(), "cg-dashboard-selector-")); t.after(() => rmSync(root, {recursive:true,force:true}));
    const ctx = { ...f, uiRelease: prepareCallsUpdate(f.repo, f.oldRevision, f.targetRevision, f.baselineHealth)! };
    f.git("checkout", "-q", f.oldRevision);
    const viewed = () => readCallsRelease(root, "boot") ?? { ...f.initial, html: readFileSync(path.join(f.repo, callsFiles.html), "utf8") };
    let healthReads = 0, restores = 0;
    const result = await applyCallsUpdate(root, ctx, {
      phase: () => {},
      checkout: async () => { f.git("checkout", "-q", f.targetRevision); },
      test: async () => {
        assert.deepEqual(viewed(), f.initial);
        assert.equal(readCallsRelease(root, "another-boot"), null);
        if (mode === "validation failure" || mode === "rollback failure") throw new Error("validation failed");
      },
      restore: async () => {
        restores++;
        if (mode === "rollback failure") throw new Error("checkout unavailable");
        f.git("checkout", "-q", f.oldRevision);
      },
      health: async () => ({
        ...f.baselineHealth, instanceId: ++healthReads === 1 && mode === "changed instance" ? "other" : "daemon",
        callsView: {session:"boot", revision: buildCallsView(viewed()).revision},
      }),
    });
    assert.equal(result.result, mode === "success" ? "updated" : mode === "rollback failure" ? "failed" : "rolled_back");
    assert.equal(restores, mode === "success" ? 0 : 1);
    assert.equal(viewed().html, mode === "success" ? "<div>B</div>" : f.initial.html);
    assert.equal(result.patch.runningRevision, f.oldRevision);
  });
}
