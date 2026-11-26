import { acquireLandingLock, releaseLandingLock } from "../../scripts/with-landing-lock.mjs";
import { execFileSync } from "node:child_process";
import { activityLayoutFile, buildActivityLayout } from "../web/activity-layout.ts";
import { adminAssetName, adminVersion } from "../web/admin-assets.ts";
import { callsFiles, readDashboardRelease, selectDashboardRelease, useCheckoutCallsRelease, type DashboardSources } from "../web/dashboard-release.ts";
import { adminModuleName } from "../web/admin-module-names.ts";
import { buildCallsView } from "../web/calls-view-assets.ts";

const records = ["CHANGELOG.md", "FEATURES.md", "TEST-PLAN.md"];
const callsAssets: string[] = Object.values(callsFiles);
// Only independently served browser files. Server-imported modules and sign-in assets keep
// their ordinary tested deployment. New files require review before joining the allowlist.
const adminAssets = [
  "public/admin-access.js", "public/admin-api.js", "public/admin-composio-policy.js",
  "public/admin-composio.js", "public/admin-conversation-templates.js", "public/admin-custom-mcps.js",
  "public/admin-email-accounts.js", "public/admin-events.js", "public/admin-licenses.js",
  "public/admin-organization-grants.js", "public/admin-schedules.js", "public/admin-secrets.js",
  "public/admin-settings-navigation.js", "public/admin-settings-search.js", "public/admin-skills.js",
  "public/admin-state.js", "public/admin-subscriptions.js", "public/admin-system-health.js",
  "public/admin-user-picker.js", "public/admin-view.js", "public/app.js",
  "public/index.html", "public/plugin-summary.js", "public/skill-assignment-picker.js",
  "public/skills-catalog-filters.js", "public/styles.css",
];


function git(repo: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024 });
}

// A new typed module is eligible only when both regular files exist at the target. The
// type-check gate verifies its committed browser output with the pinned compiler.
function isTypedAsset(repo: string, to: string, file: string) {
  const match = /^(?:ui\/admin\/([a-z0-9-]+)\.ts|public\/([a-z0-9-]+)\.js)$/.exec(file);
  const name = match?.[1] ?? match?.[2];
  if (!name || !adminModuleName.test(name)) return false;
  const pair = git(repo, "ls-tree", "-r", "-z", to, "--", `ui/admin/${name}.ts`, `public/${name}.js`).split("\0").filter(Boolean);
  return pair.length === 2 && pair.every(entry => entry.startsWith("100644 blob "));
}

interface ViewsChanged { calls: boolean; admin: boolean; layout: boolean }
function dashboardChanges(repo: string, from: string, to: string): ViewsChanged | null {
  if (![from, to].every(value => /^[0-9a-f]{40}$/.test(value)) || from === to) return null;
  try {
    git(repo, "merge-base", "--is-ancestor", from, to);
    const entries = git(repo, "diff", "--no-ext-diff", "--raw", "--no-renames", "-z", from, to).split("\0");
    entries.pop();
    const changes = { calls: false, admin: false, layout: false };
    for (let i = 0; i < entries.length; i += 2) {
      const mode = entries[i], file = entries[i + 1];
      const edit = /^:100644 100644 [0-9a-f]+ [0-9a-f]+ M$/.test(mode);
      const add = /^:000000 100644 [0-9a-f]+ [0-9a-f]+ A$/.test(mode);
      if (edit && records.includes(file)) continue;
      if (edit && callsAssets.includes(file)) changes.calls = true;
      else if (edit && file === activityLayoutFile) changes.layout = true;
      else if (edit && adminAssets.includes(file)) changes.admin = true;
      else if ((edit || add) && isTypedAsset(repo, to, file)) changes.admin = true;
      else return null;
    }
    return changes;
  } catch {
    return null;
  }
}

export function isDashboardOnlyUpdate(repo: string, from: string, to: string, allowRevertedAssets = false) {
  const changes = dashboardChanges(repo, from, to);
  return Boolean(changes && (changes.calls || changes.admin || changes.layout || allowRevertedAssets));
}

// Both the installer and parallel development landings may own this checkout.
export async function withDashboardCheckout(repo: string, from: string, branch: string, operation: () => Promise<void> | void) {
  const lock = await acquireLandingLock({ cwd: repo });
  try {
    if (git(repo, "rev-parse", "HEAD").trim() !== from ||
        git(repo, "symbolic-ref", "--short", "HEAD").trim() !== branch ||
        git(repo, "status", "--porcelain", "--untracked-files=no").trim()) {
      throw new Error("Checkout changed during dashboard update; preserving concurrent work.");
    }
    await operation();
  } finally {
    await releaseLandingLock(lock);
  }
}

export function moveDashboardCheckout(repo: string, from: string, to: string, branch: string, restore = false) {
  return withDashboardCheckout(repo, from, branch, () => {
    git(repo, ...(restore ? ["reset", "--keep", to] : ["merge", "--ff-only", to]));
  });
}

interface Snapshot {
  source: DashboardSources;
  revisions: { callsView?: string; adminView?: string; activityLayout?: string };
}

function readAdminSource(repo: string, revision: string) {
  const names = git(repo, "ls-tree", "-z", revision + ":public").split("\0").flatMap(entry => {
    const [meta, name] = entry.split("\t");
    if (!name || !adminAssetName.test(name)) return [];
    if (!meta.startsWith("100644 blob ")) throw new Error("Admin bundle contains a non-regular asset");
    return [name];
  });
  return Object.fromEntries(names.map(name => [name, git(repo, "show", revision + ":public/" + name)]));
}

function loadRelease(repo: string, revision: string, changes: ViewsChanged, pinned?: DashboardSources | null): Snapshot {
  const read = (file: string) => git(repo, "show", revision + ":" + file);
  const snapshot: Snapshot = { source: {}, revisions: {} };
  if (changes.calls) {
    const calls = pinned?.calls ?? { html: read(callsFiles.html), css: read(callsFiles.css), ts: read(callsFiles.ts) };
    snapshot.source.calls = calls;
    snapshot.revisions.callsView = buildCallsView(calls).revision;
  }
  if (changes.layout) {
    const layout = buildActivityLayout(pinned?.activityLayout ?? read(activityLayoutFile));
    snapshot.source.activityLayout = layout.css;
    snapshot.revisions.activityLayout = layout.revision;
  }
  if (changes.admin) {
    const admin = pinned?.admin ?? readAdminSource(repo, revision);
    if (!admin["index.html"]?.includes("<!--ASSET_IMPORTMAP-->") || !admin["index.html"]?.includes("{{ASSET_V}}")) {
      throw new Error("Admin shell is missing its versioned asset entry points");
    }
    snapshot.source.admin = admin;
    snapshot.revisions.adminView = adminVersion(admin);
  }
  return snapshot;
}

interface Health {
  ok?: boolean;
  instanceId?: string;
  revision?: string;
  slack?: { connected?: boolean };
  containerRuntime?: { cli?: { ok?: boolean } };
  callsView?: { session: string; revision: string };
  adminView?: { session: string; revision: string };
  activityLayout?: { session: string; revision: string };
}

export function prepareDashboardUpdate(repo: string, oldRevision: string, targetRevision: string, health: Health, root?: string) {
  const changes = dashboardChanges(repo, oldRevision, targetRevision);
  if (!changes || (!changes.calls && !changes.admin && !changes.layout)) return null;
  const sessions = [changes.calls && health.callsView?.session, changes.admin && health.adminView?.session,
    changes.layout && health.activityLayout?.session].filter(value => value !== false);
  const session = sessions[0];
  if (!session || !sessions.every(value => value === session)) return null;
  // A runner can die after advancing Git while its last verified serving assets stay pinned.
  // Recover every surface in that selector, even if the incoming diff touches another one.
  const priorPin = root ? readDashboardRelease(root, session) : null;
  const affected = {
    calls: changes.calls || Boolean(priorPin?.calls),
    admin: changes.admin || Boolean(priorPin?.admin),
    layout: changes.layout || priorPin?.activityLayout !== undefined,
  };
  const previous = loadRelease(repo, oldRevision, affected, priorPin);
  if (!servesSnapshot(health, previous, session)) throw new Error("Serving dashboard assets do not match the checkout; repair the checkout before updating.");
  return { previous, candidate: loadRelease(repo, targetRevision, affected), session, priorPin };
}

function servesSnapshot(health: Health, snapshot: Snapshot, session: string) {
  return (["callsView", "adminView", "activityLayout"] as const).every(name => {
    const revision = snapshot.revisions[name];
    return revision === undefined || (health[name]?.session === session && health[name]?.revision === revision);
  });
}

type Release = NonNullable<ReturnType<typeof prepareDashboardUpdate>>;
interface UiContext { oldRevision: string; targetRevision: string; baselineHealth: Health; uiRelease: Release }
interface UiOps {
  checkout: () => Promise<unknown>;
  test: () => Promise<unknown>;
  health: () => Promise<Health>;
  restore: () => Promise<unknown>;
  phase: (value: string) => unknown;
  publishAt: (revision: string, publish: () => Promise<void>) => Promise<void>;
}

// Pin a whole view before checking files out. A page sees all three assets from one release.
// The ordinary disk reader resumes once the checkout and the served UI have both been verified.
export async function applyDashboardUpdate(root: string, ctx: UiContext, ops: UiOps) {
  const { previous, candidate, session, priorPin } = ctx.uiRelease;
  const baseline = ctx.baselineHealth;
  const verify = async (snapshot: Snapshot) => {
    const health = await ops.health();
    if (!health.ok || health.instanceId !== baseline.instanceId || health.revision !== baseline.revision ||
        !servesSnapshot(health, snapshot, session) ||
        health.containerRuntime?.cli?.ok === false || (baseline.slack?.connected && !health.slack?.connected)) {
      throw new Error("Dashboard verification failed for the serving gateway instance and selected UI release.");
    }
  };
  selectDashboardRelease(root, session, previous.source);
  let checkedOut = false;
  try {
    ops.phase("checkout");
    await ops.checkout();
    checkedOut = true;
    ops.phase("testing");
    await ops.test();
    ops.phase("verifying");
    await ops.publishAt(ctx.targetRevision, async () => {
      selectDashboardRelease(root, session, candidate.source);
      await verify(candidate);
      useCheckoutCallsRelease(root, session);
      await verify(candidate);
    });
    return { result: "updated", patch: { phase: "complete", changed: true, runningRevision: baseline.revision,
      reason: "Dashboard assets updated and verified on the same gateway instance." } };
  } catch (error) {
    const candidateError = error instanceof Error ? error.message : String(error);
    if (!checkedOut) {
      // A failed git merge must never reset unrelated tracked work.
      // Keep the last verified view available even if checkout failed partway.
      throw error;
    }
    selectDashboardRelease(root, session, previous.source);
    ops.phase("rolling_back");
    try {
      await ops.restore();
      await ops.publishAt(ctx.oldRevision, async () => {
        // The old checkout can contain a release whose validation was interrupted. Restore
        // the exact serving mode that we verified before checkout, including any old pins.
        if (priorPin) selectDashboardRelease(root, session, priorPin);
        else useCheckoutCallsRelease(root, session);
        await verify(previous);
      });
      return { result: "rolled_back", patch: { phase: "complete", changed: true, candidateError, runningRevision: baseline.revision,
        reason: "The previous dashboard release was restored on the same gateway instance." } };
    } catch (rollbackError) {
      selectDashboardRelease(root, session, previous.source);
      return { result: "failed", patch: { phase: "failed", changed: true, candidateError, runningRevision: baseline.revision,
        rollbackError: String(rollbackError), reason: "Dashboard rollback could not be verified." } };
    }
  }
}
