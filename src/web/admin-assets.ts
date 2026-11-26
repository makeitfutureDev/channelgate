// The HTML, its CSP hash and every module URL must describe the same captured release.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readAdminRelease, type AdminSource } from "./dashboard-release.ts";

export const adminAssetName = /^[a-z][a-z0-9-]*\.(?:js|css|html)$/;
export function adminVersion(source: AdminSource) {
  const hash = createHash("sha256");
  for (const name of Object.keys(source).sort()) {
    hash.update(name);
    hash.update(source[name]);
  }
  return hash.digest("hex").slice(0, 12);
}

function buildAdminView(source: AdminSource) {
  const version = adminVersion(source);
  const imports = Object.fromEntries(Object.keys(source).sort().filter(name => name.endsWith(".js"))
    .map(name => ["/" + name, "/" + name + "?v=" + version]));
  const json = JSON.stringify({ imports }).replace(/</g, "\\u003c");
  const importMap = `<script type="importmap">${json}</script>`;
  const mapHash = `'sha256-${createHash("sha256").update(json).digest("base64")}'`;
  const shells = new Map<string, string>();
  return {
    source, version, importMap, mapHash,
    shell(file: string) {
      let html = shells.get(file);
      if (html === undefined) {
        html = source[file].replace("<!--ASSET_IMPORTMAP-->", () => importMap).replaceAll("{{ASSET_V}}", version);
        shells.set(file, html);
      }
      return html;
    },
  };
}

type AdminView = ReturnType<typeof buildAdminView>;

export function createAdminAssets(dir: string, select = readAdminRelease) {
  const views = new Map<string, AdminView>();
  let disk: { key: string; view: AdminView } | null = null;
  let selected: { source: AdminSource; view: AdminView } | null = null;

  function diskView() {
    const names = readdirSync(dir).filter(name => adminAssetName.test(name)).sort();
    const key = JSON.stringify(names.map(name => {
      const info = statSync(path.join(dir, name));
      return [name, info.ino, info.ctimeMs, info.size];
    }));
    if (disk?.key !== key) {
      const source = Object.fromEntries(names.map(name => [name, readFileSync(path.join(dir, name), "utf8")]));
      disk = { key, view: buildAdminView(source) };
    }
    return disk.view;
  }
  function current() {
    const source = select();
    if (source && selected?.source !== source) selected = { source, view: buildAdminView(source) };
    const view = source ? selected!.view : diskView();
    views.delete(view.version);
    views.set(view.version, view);
    if (views.size > 2) views.delete(views.keys().next().value!);
    return view;
  }
  return {
    current,
    asset(name: string, version?: string): string | undefined {
      const view = version && views.has(version) ? views.get(version) : current();
      if (!view || (version && view.version !== version) || !Object.hasOwn(view.source, name)) return undefined;
      return view.source[name];
    },
  };
}

const stores = new Map<string, ReturnType<typeof createAdminAssets>>();
export function adminAssets(dir: string) {
  if (!stores.has(dir)) stores.set(dir, createAdminAssets(dir));
  return stores.get(dir)!;
}

function policy(hashes: string[]) {
  return ["default-src 'self'", `script-src 'self'${hashes.length ? " " + hashes.join(" ") : ""}`,
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'",
    "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"].join("; ");
}

export function adminShellResponse(dir: string, file: string) {
  const view = adminAssets(dir).current();
  return { html: view.shell(file), csp: policy(file === "login.html" ? [] : [view.mapHash]) };
}
export function assetVersion(dir: string) { return adminAssets(dir).current().version; }
export function importMapFor(dir: string) { return adminAssets(dir).current().importMap; }
export function renderShell(dir: string, file: string) { return adminAssets(dir).current().shell(file); }
export function shellContentSecurityPolicy(dir: string, { inlineScriptHashes }: { inlineScriptHashes?: string[] } = {}) {
  return policy(inlineScriptHashes ?? [adminAssets(dir).current().mapHash]);
}
