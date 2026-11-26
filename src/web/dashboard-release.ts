import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
export interface DashboardSources { calls?: CallsSource; admin?: AdminSource; activityLayout?: string }
let cached: { key: string; session: string; sources: DashboardSources } | undefined;

// During validation many browser requests may share the same immutable snapshot file.
// Use the atomic rename identity so switching to/from an older release is visible immediately.
function readDashboardGeneration(root = gatewayRoot(), session: string = callsReleaseSession): DashboardSources | null {
  const file = selector(root);
  let fd: number;
  try { fd = openSync(file, "r"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    cached = undefined;
    return null;
  }
  try {
    // The updater can rename or unlink the path between any two syscalls. Both identity
    // and bytes come from the same open file description.
    const stat = fstatSync(fd, { bigint: true });
    const key = JSON.stringify([file, String(stat.ino), String(stat.ctimeNs)]);
    if (cached?.key !== key) {
      const data = JSON.parse(readFileSync(fd, "utf8"));
      if (data.session !== session) return null;
      const sources = data.sources ?? { calls: data.source };
      const { calls, admin } = sources;
      if (sources.activityLayout !== undefined && typeof sources.activityLayout !== "string") throw new Error("Invalid Activity layout snapshot");
      if (calls && ![calls.html, calls.css, calls.ts].every(value => typeof value === "string")) {
        throw new Error("Invalid Calls release snapshot");
      }
      if (admin && (typeof admin !== "object" || Array.isArray(admin) ||
          !Object.values(admin).every(value => typeof value === "string"))) {
        throw new Error("Invalid admin release snapshot");
      }
      cached = { key, session: data.session, sources };
    }
    return cached.session === session ? cached.sources : null;
  } finally {
    closeSync(fd);
  }
}

// All disk-backed parts of a view must come from the same checkout generation. A pin can
// appear during a multi-file read, including just as git temporarily removes a file.
export function readDashboardView<T>(load: (release: DashboardSources | null) => T,
  root = gatewayRoot(), session: string = callsReleaseSession): T {
  let before = readDashboardGeneration(root, session);
  for (;;) {
    let view: T;
    try {
      view = load(before);
    } catch (error) {
      const after = readDashboardGeneration(root, session);
      if (before === after) throw error;
      before = after;
      continue;
    }
    const after = readDashboardGeneration(root, session);
    if (before === after) return view;
    before = after;
  }
}

// Recovery only needs actual pins. The empty checkout marker is internal to generation tracking.
export function readDashboardRelease(root = gatewayRoot(), session: string = callsReleaseSession) {
  const sources = readDashboardGeneration(root, session);
  return sources && Object.keys(sources).length ? sources : null;
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

export function useCheckoutCallsRelease(root: string, session: string = callsReleaseSession) {
  // Keep an empty generation marker so a reader can detect even a *complete* checkout and
  // publication between the first and last files it read. Normal disk edits still apply live.
  selectDashboardRelease(root, session, {});
}

export function dashboardHealth(readView: () => { revision: string }, session: string) {
  try {
    return { session, revision: readView().revision };
  } catch {
    // An invalid UI bundle must not turn the daemon health endpoint into a 500.
    return null;
  }
}
