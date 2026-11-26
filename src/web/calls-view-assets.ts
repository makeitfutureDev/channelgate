import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { Script } from "node:vm";
import { callsFiles, readCallsRelease, type CallsSource } from "./dashboard-release.ts";

interface CallsView {
  html: string;
  css: string;
  script: string;
  revision: string;
}

function revisionOf({ html, css, ts }: CallsSource) {
  return createHash("sha256").update(JSON.stringify([html, css, ts])).digest("hex");
}

export function buildCallsView(source: CallsSource): CallsView {
  const script = stripTypeScriptTypes(source.ts);
  // Parse as the browser will (a classic external script). This also rejects accidental
  // module imports before an updater can activate the new release. Nothing executes here.
  new Script(script, { filename: "call-history.js" });
  return {
    html: source.html,
    css: source.css,
    script,
    revision: revisionOf(source),
  };
}

function readCallsSource(active = readCallsRelease()): CallsSource {
  if (active) return active;
  const root = new URL("../../", import.meta.url);
  return {
    html: readFileSync(new URL(callsFiles.html, root), "utf8"),
    css: readFileSync(new URL(callsFiles.css, root), "utf8"),
    ts: readFileSync(new URL(callsFiles.ts, root), "utf8"),
  };
}

// The shell and its browser code share one revision. Keep the previous bundle for a
// tab that received its shell just before the next release or rollback.
export function createCallsViewAssets(readSource = readCallsSource) {
  const views = new Map<string, CallsView>();
  return {
    current(active?: CallsSource | null) {
      const source = readSource(active);
      const revision = revisionOf(source);
      const view = views.get(revision) ?? buildCallsView(source);
      views.delete(revision);
      views.set(revision, view);
      if (views.size > 2) views.delete(views.keys().next().value!);
      return view;
    },
    script(revision: string) {
      return views.get(revision)?.script;
    },
  };
}

export const callsViewAssets = createCallsViewAssets();
