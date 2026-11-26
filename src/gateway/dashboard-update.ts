import { acquireLandingLock, releaseLandingLock } from "../../scripts/with-landing-lock.mjs";
import { execFileSync } from "node:child_process";
import { callsFiles, selectCallsRelease, useCheckoutCallsRelease } from "../web/dashboard-release.ts";
import { buildCallsView } from "../web/calls-view-assets.ts";

const records = ["CHANGELOG.md", "FEATURES.md", "TEST-PLAN.md"];
const assets = Object.values(callsFiles);
const allowed = [...assets, ...records];

function git(repo: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024 });
}

// Only regular-file edits to this exact set qualify. A rename, symlink, newly added server
// import, changed contract or unknown path belongs to the regular update transaction.
export function isCallsOnlyUpdate(repo: string, from: string, to: string, allowRevertedAssets = false) {
  if (![from, to].every(value => /^[0-9a-f]{40}$/.test(value)) || from === to) return false;
  try {
    git(repo, "merge-base", "--is-ancestor", from, to);
    git(repo, "diff", "--quiet", from, to, "--", ".", ...allowed.map(name => ":(exclude)" + name));
    const entries = git(repo, "diff", "--no-ext-diff", "--raw", "--no-renames", "-z", from, to, "--", ...allowed).split("\0");
    entries.pop();
    let hasAsset = false;
    for (let i = 0; i < entries.length; i += 2) {
      if (!/^:100644 100644 [0-9a-f]+ [0-9a-f]+ M$/.test(entries[i]) || !allowed.includes(entries[i + 1])) return false;
      hasAsset ||= assets.some(name => name === entries[i + 1]);
    }
    return hasAsset || allowRevertedAssets;
  } catch {
    return false;
  }
}

// Both the installer and parallel development landings may own this checkout.
export async function moveCallsCheckout(repo: string, from: string, to: string, branch: string, restore = false) {
  const lock = await acquireLandingLock({ cwd: repo });
  try {
    if (git(repo, "rev-parse", "HEAD").trim() !== from ||
        git(repo, "symbolic-ref", "--short", "HEAD").trim() !== branch ||
        git(repo, "status", "--porcelain", "--untracked-files=no").trim()) {
      throw new Error("Checkout changed during dashboard update; preserving concurrent work.");
    }
    git(repo, ...(restore ? ["reset", "--keep", to] : ["merge", "--ff-only", to]));
  } finally {
    await releaseLandingLock(lock);
  }
}

function loadRelease(repo: string, revision: string) {
  const read = (file: string) => git(repo, "show", revision + ":" + file);
  const source = { html: read(callsFiles.html), css: read(callsFiles.css), ts: read(callsFiles.ts) };
  return { source, revision: buildCallsView(source).revision };
}

interface Health {
  ok?: boolean;
  instanceId?: string;
  revision?: string;
  slack?: { connected?: boolean };
  containerRuntime?: { cli?: { ok?: boolean } };
  callsView?: { session: string; revision: string };
}

export function prepareCallsUpdate(repo: string, oldRevision: string, targetRevision: string, health: Health) {
  if (!health.callsView?.session || !isCallsOnlyUpdate(repo, oldRevision, targetRevision)) return null;
  const previous = loadRelease(repo, oldRevision);
  if (previous.revision !== health.callsView.revision) throw new Error("Serving Calls view does not match the checkout; repair the checkout before updating.");
  return { previous, candidate: loadRelease(repo, targetRevision), session: health.callsView.session };
}

type Release = NonNullable<ReturnType<typeof prepareCallsUpdate>>;
interface UiContext { oldRevision: string; targetRevision: string; baselineHealth: Health; uiRelease: Release }
interface UiOps {
  checkout: () => Promise<unknown>;
  test: () => Promise<unknown>;
  health: () => Promise<Health>;
  restore: () => Promise<unknown>;
  phase: (value: string) => unknown;
}

// Pin a whole view before checking files out. A page sees all three assets from one release.
// The ordinary disk reader resumes once the checkout and the served UI have both been verified.
export async function applyCallsUpdate(root: string, ctx: UiContext, ops: UiOps) {
  const { previous, candidate, session } = ctx.uiRelease;
  const baseline = ctx.baselineHealth;
  const verify = async (revision: string) => {
    const health = await ops.health();
    if (!health.ok || health.instanceId !== baseline.instanceId || health.revision !== baseline.revision ||
        health.callsView?.session !== session || health.callsView?.revision !== revision ||
        health.containerRuntime?.cli?.ok === false || (baseline.slack?.connected && !health.slack?.connected)) {
      throw new Error("Dashboard verification failed for the serving gateway instance and Calls view.");
    }
  };
  selectCallsRelease(root, session, previous.source);
  let checkedOut = false;
  try {
    ops.phase("checkout");
    await ops.checkout();
    checkedOut = true;
    ops.phase("testing");
    await ops.test();
    ops.phase("verifying");
    selectCallsRelease(root, session, candidate.source);
    await verify(candidate.revision);
    useCheckoutCallsRelease(root);
    await verify(candidate.revision);
    return { result: "updated", patch: { phase: "complete", changed: true, runningRevision: baseline.revision,
      reason: "Calls dashboard updated and verified on the same gateway instance." } };
  } catch (error) {
    const candidateError = error instanceof Error ? error.message : String(error);
    if (!checkedOut) {
      // A failed git merge must never reset unrelated tracked work.
      // Keep the last verified view available even if checkout failed partway.
      throw error;
    }
    selectCallsRelease(root, session, previous.source);
    ops.phase("rolling_back");
    try {
      await ops.restore();
      useCheckoutCallsRelease(root);
      await verify(previous.revision);
      return { result: "rolled_back", patch: { phase: "complete", changed: true, candidateError, runningRevision: baseline.revision,
        reason: "The previous Calls dashboard was restored on the same gateway instance." } };
    } catch (rollbackError) {
      selectCallsRelease(root, session, previous.source);
      return { result: "failed", patch: { phase: "failed", changed: true, candidateError, runningRevision: baseline.revision,
        rollbackError: String(rollbackError), reason: "Dashboard rollback could not be verified." } };
    }
  }
}
