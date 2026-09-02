// Cache-busting for the admin UI, which has no build step.
//
// index.html loads /app.js, and app.js statically imports its sibling modules by plain relative
// path ("./admin-state.js", …). A hand-bumped `?v=` on the ENTRY alone is a trap: it gives app.js
// a fresh URL while every cache in the path (browser heuristic freshness, the Cloudflare edge, a
// corporate proxy) keeps serving the sibling from before the deploy. The two halves of one module
// graph then straddle two versions and the page dies at import time with
// "does not provide an export named …" — the whole UI, not one feature.
//
// So the stamp is derived from the CONTENT of every shipped asset and applied to the WHOLE graph:
// one changed byte re-versions every module URL at once, and nobody has to remember to bump a
// literal. Content (not mtime) keeps the stamp stable across clones and restarts, so an unchanged
// deploy keeps its warm cache.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Every file whose staleness can break the page. HTML is included so an index.html-only edit still
// re-stamps; only .js is import-mapped, and only .js/.css URLs carry the query.
const STAMPED = /\.(js|css|html)$/;

let cache = null;

// stat is the cheap "did anything change" probe; hashing (the expensive part, and the part that
// must be content-based) only runs when it says yes.
function fingerprint(dir) {
  const files = readdirSync(dir).filter((name) => STAMPED.test(name)).sort();
  const key = files.map((name) => { const s = statSync(path.join(dir, name)); return `${name}:${s.size}:${s.mtimeMs}`; }).join("|");
  if (cache?.key === key && cache?.dir === dir) return cache;
  const hash = createHash("sha256");
  for (const name of files) {
    hash.update(name);
    hash.update(readFileSync(path.join(dir, name)));
  }
  cache = { dir, key, files, version: hash.digest("hex").slice(0, 12), shells: new Map() };
  return cache;
}

export function assetVersion(dir) {
  return fingerprint(dir).version;
}

// A static `import` specifier cannot carry a computed query, and rewriting every import statement
// by hand is the failure mode this module exists to remove. An import map fixes it from the
// outside: keys that parse as URLs are matched against the RESOLVED specifier, so app.js's
// "./admin-state.js" resolves to "/admin-state.js" and is redirected to the stamped URL without a
// single import statement changing. A browser without import-map support simply loads the
// unstamped URLs — which the origin's `Cache-Control: no-cache` still revalidates.
export function importMapFor(dir) {
  const { version, files } = fingerprint(dir);
  const imports = {};
  for (const name of files.filter((name) => name.endsWith(".js"))) imports[`/${name}`] = `/${name}?v=${version}`;
  // `<` can never legally appear in these paths, but escaping it is what keeps a filename from
  // being able to close the script element.
  const json = JSON.stringify({ imports }).replace(/</g, "\\u003c");
  return `<script type="importmap">${json}</script>`;
}

// Renders an HTML shell with the stamp substituted and the import map injected. Cached per
// version, so navigations do not re-read the (large) shell.
export function renderShell(dir, file) {
  const state = fingerprint(dir);
  const hit = state.shells.get(file);
  if (hit) return hit;
  const html = readFileSync(path.join(dir, file), "utf8")
    .replace("<!--ASSET_IMPORTMAP-->", () => importMapFor(dir))
    .replaceAll("{{ASSET_V}}", state.version);
  state.shells.set(file, html);
  return html;
}
