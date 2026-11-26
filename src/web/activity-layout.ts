import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { readDashboardView, type DashboardSources } from "./dashboard-release.ts";

export const activityLayoutFile = "public/activity/dashboard.css";
const file = new URL("../../" + activityLayoutFile, import.meta.url);

export function buildActivityLayout(css: string) {
  if (!css.trim() || /<\/style[\t\n\f\r />]/i.test(css)) throw new Error("Invalid Activity layout stylesheet");
  return { css, revision: createHash("sha256").update(css).digest("hex") };
}

let disk: { key: string; layout: ReturnType<typeof buildActivityLayout> } | undefined;
let pinned: ReturnType<typeof buildActivityLayout> | undefined;
function loadLayout(release: DashboardSources | null) {
  if (release?.activityLayout !== undefined) {
    if (pinned?.css !== release.activityLayout) pinned = buildActivityLayout(release.activityLayout);
    return pinned;
  }
  const fd = openSync(file, "r");
  try {
    const info = fstatSync(fd, { bigint: true });
    const key = `${info.ino}-${info.ctimeNs}-${info.size}`;
    if (disk?.key !== key) disk = { key, layout: buildActivityLayout(readFileSync(fd, "utf8")) };
    return disk.layout;
  } finally {
    closeSync(fd);
  }
}

export function activityLayout(release?: DashboardSources | null) {
  return release === undefined ? readDashboardView(loadLayout) : loadLayout(release);
}
