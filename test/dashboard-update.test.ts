import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyDashboardUpdate, isDashboardOnlyUpdate, moveDashboardCheckout, prepareDashboardUpdate, withDashboardCheckout } from "../src/gateway/dashboard-update.ts";
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
  assert.ok(isDashboardOnlyUpdate(f.repo, f.oldRevision, f.targetRevision));
  const release = prepareDashboardUpdate(f.repo, f.oldRevision, f.targetRevision, f.baselineHealth);
  assert.ok(release);
  assert.equal(prepareDashboardUpdate(f.repo, f.oldRevision, f.targetRevision, {}), null);
  assert.throws(() => prepareDashboardUpdate(f.repo, f.oldRevision, f.targetRevision, { callsView: {session:"boot",revision:"wrong"} }));
  writeFileSync(path.join(f.repo, callsFiles.html), f.initial.html);
  const back = f.commit();
  assert.equal(isDashboardOnlyUpdate(f.repo, f.oldRevision, back), false);
  assert.ok(isDashboardOnlyUpdate(f.repo, f.oldRevision, back, true));
  writeFileSync(path.join(f.repo, "backend.js"), "// changed");
  assert.equal(isDashboardOnlyUpdate(f.repo, f.oldRevision, f.commit(), true), false);
});

for (const mode of ["success", "validation failure", "changed instance", "rollback failure"]) {
  test(`dashboard checkout, publication and rollback: ${mode}`, async t => {
    const f = fixture(); t.after(() => rmSync(f.repo, { recursive: true, force: true }));
    const root = mkdtempSync(path.join(tmpdir(), "cg-dashboard-selector-")); t.after(() => rmSync(root, {recursive:true,force:true}));
    const ctx = { ...f, uiRelease: prepareDashboardUpdate(f.repo, f.oldRevision, f.targetRevision, f.baselineHealth)! };
    f.git("checkout", "-q", f.oldRevision);
    const viewed = () => readCallsRelease(root, "boot") ?? { ...f.initial, html: readFileSync(path.join(f.repo, callsFiles.html), "utf8") };
    let healthReads = 0, restores = 0;
    const result = await applyDashboardUpdate(root, ctx, {
      phase: () => {},
      publishAt: (_revision, publish) => publish(),
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

test("admin and Calls changes activate as one release while sign-in and server-imported changes require a full update", async t => {
  const { adminVersion } = await import("../src/web/admin-assets.ts");
  const { readAdminRelease, selectDashboardRelease } = await import("../src/web/dashboard-release.ts");
  const f = fixture(); t.after(() => rmSync(f.repo, { recursive: true, force: true }));
  const publicDir = path.join(f.repo, "public");
  const baseline = { "index.html": "<!--ASSET_IMPORTMAP-->{{ASSET_V}}", "styles.css": ".alpha{}",
    "admin-routes.js": "export {};", "subscription-ui.js": "export {};", "login.js": "// sign in" };
  for (const [name, bytes] of Object.entries(baseline)) writeFileSync(path.join(publicDir, name), bytes);
  const before = f.commit();
  writeFileSync(path.join(publicDir, "styles.css"), ".beta{}");
  writeFileSync(path.join(f.repo, callsFiles.ts), "const second: number = 2;");
  const candidate = f.commit();
  const initialCalls = { ...f.initial, html: "<div>B</div>" };
  const health = { ...f.baselineHealth, callsView: { session: "boot", revision: buildCallsView(initialCalls).revision },
    adminView: { session: "boot", revision: adminVersion(baseline) } };
  assert.ok(isDashboardOnlyUpdate(f.repo, before, candidate));
  assert.equal(prepareDashboardUpdate(f.repo, before, candidate, { ...health, adminView: undefined }), null);
  const update = prepareDashboardUpdate(f.repo, before, candidate, health)!;
  assert.deepEqual(update.previous.source, { admin: baseline, calls: initialCalls });
  selectDashboardRelease(f.repo, "boot", update.candidate.source);
  assert.equal(readAdminRelease(f.repo, "boot")?.["styles.css"], ".beta{}");
  assert.equal(readCallsRelease(f.repo, "boot")?.ts, "const second: number = 2;");
  for (const name of ["admin-routes.js", "subscription-ui.js", "login.js"]) {
    writeFileSync(path.join(publicDir, name), "// changed");
    const after = f.commit();
    assert.equal(isDashboardOnlyUpdate(f.repo, candidate, after), false, name);
    f.git("reset", "--hard", candidate);
  }
});


for (const interference of ["dirty file", "new commit", "different branch"]) {
  test(`dashboard activation preserves concurrent checkout changes: ${interference}`, async t => {
    const f = fixture(); t.after(() => rmSync(f.repo, { recursive: true, force: true }));
    const root = mkdtempSync(path.join(tmpdir(), "cg-dashboard-guard-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const branch = f.git("symbolic-ref", "--short", "HEAD");
    f.git("reset", "--hard", f.oldRevision);
    const uiRelease = prepareDashboardUpdate(f.repo, f.oldRevision, f.targetRevision, f.baselineHealth)!;
    let actualHead = "";
    const result = await applyDashboardUpdate(root, { ...f, uiRelease }, {
      phase: () => {},
      checkout: () => moveDashboardCheckout(f.repo, f.oldRevision, f.targetRevision, branch),
      restore: () => moveDashboardCheckout(f.repo, f.targetRevision, f.oldRevision, branch, true),
      publishAt: (rev, publish) => withDashboardCheckout(f.repo, rev, branch, publish),
      test: async () => {
        if (interference === "different branch") f.git("switch", "-c", "other-work");
        else writeFileSync(path.join(f.repo, callsFiles.css), "/* concurrent */");
        if (interference === "new commit") f.commit();
        actualHead = f.git("rev-parse", "HEAD");
      },
      health: async () => { throw new Error("guard should run before activation"); },
    });
    assert.equal(result.result, "failed");
    assert.match(result.patch.candidateError ?? "", /preserving concurrent work/);
    assert.deepEqual(readCallsRelease(root, "boot"), f.initial);
    assert.equal(f.git("rev-parse", "HEAD"), actualHead);
    if (interference === "different branch") assert.equal(f.git("symbolic-ref", "--short", "HEAD"), "other-work");
    else assert.equal(readFileSync(path.join(f.repo, callsFiles.css), "utf8"), "/* concurrent */");
  });
}
