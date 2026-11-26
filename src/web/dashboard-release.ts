import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

export function readCallsRelease(root = gatewayRoot(), session: string = callsReleaseSession): CallsSource | null {
  let bytes: string;
  try {
    bytes = readFileSync(selector(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const release = JSON.parse(bytes);
  if (release.session !== session) return null;
  const { html, css, ts } = release.source;
  if (![html, css, ts].every(value => typeof value === "string")) throw new Error("Invalid Calls release snapshot");
  return { html, css, ts };
}

export function selectCallsRelease(root: string, session: string, source: CallsSource) {
  const file = selector(root);
  const temp = file + "." + randomUUID();
  try {
    writeFileSync(temp, JSON.stringify({ session, source }), { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
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
