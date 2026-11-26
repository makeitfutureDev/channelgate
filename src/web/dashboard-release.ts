import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gatewayRoot } from "../config/paths.js";

export interface CallsSource { html: string; css: string; ts: string }
export const callsFiles = {
  html: "public/activity/call-history.html",
  css: "public/activity/call-history.css",
  ts: "public/activity/call-history.ts",
} as const;

// A replacement process always loads its own checkout. A runner interrupted halfway through a
// UI update leaves the last validated view visible to the original daemon.
export const callsReleaseSession = randomUUID();
const selector = (root: string) => path.join(root, "activity-calls-release.json");

export type AdminSource = Record<string, string>;
export interface DashboardSources { calls?: CallsSource; admin?: AdminSource }
let cached: { key: string; session: string; sources: DashboardSources } | undefined;

// During validation many browser requests may share the same immutable snapshot file.
// Use the atomic rename identity so switching to/from an older release is visible immediately.
function readDashboardRelease(root: string, session: string): DashboardSources | null {
  const file = selector(root);
  const stat = statSync(file, { throwIfNoEntry: false, bigint: true });
  if (!stat) { cached = undefined; return null; }
  const key = JSON.stringify([file, String(stat.ino), String(stat.ctimeNs)]);
  if (cached?.key !== key) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data.session !== session) return null;
    const sources = data.sources ?? { calls: data.source };
    const { calls, admin } = sources;
    if (calls && ![calls.html, calls.css, calls.ts].every(value => typeof value === "string")) {
      throw new Error("Invalid Calls release snapshot");
    }
    if (admin && (typeof admin !== "object" || Array.isArray(admin) ||
        !Object.values(admin).every(value => typeof value === "string"))) {
      throw new Error("Invalid admin release snapshot");
    }
    cached = { key, session, sources };
  }
  return cached.session === session ? cached.sources : null;
}

export function readCallsRelease(root = gatewayRoot(), session: string = callsReleaseSession): CallsSource | null {
  return readDashboardRelease(root, session)?.calls ?? null;
}

export function readAdminRelease(root = gatewayRoot(), session: string = callsReleaseSession): AdminSource | null {
  return readDashboardRelease(root, session)?.admin ?? null;
}

export function selectDashboardRelease(root: string, session: string, sources: DashboardSources) {
  const file = selector(root);
  const temp = file + "." + randomUUID();
  try {
    writeFileSync(temp, JSON.stringify({ session, sources }), { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function selectCallsRelease(root: string, session: string, calls: CallsSource) {
  selectDashboardRelease(root, session, { calls });
}

export function useCheckoutCallsRelease(root: string) {
  rmSync(selector(root), { force: true });
}

export function dashboardHealth(readView: () => { revision: string }, session: string) {
  try {
    return { session, revision: readView().revision };
  } catch {
    // An invalid UI bundle must not turn the daemon health endpoint into a 500.
    return null;
  }
}

