// A cached module graph that straddles two deploys takes the whole admin UI down at import time
// ("does not provide an export named …"), so the stamp must cover EVERY module app.js imports —
// not just the entry that happens to have a hand-written `?v=` on it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { ensureTestEnv } from "./helpers.js";
import { ADMIN_VIEW_PATHS } from "../public/admin-routes.js";
import { assetVersion, importMapFor, renderShell } from "../src/web/assets.js";

ensureTestEnv();
process.env.CG_BIND_HOST = "127.0.0.1";
delete process.env.ADMIN_PASSWORD;

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const moduleNames = readdirSync(publicDir).filter((name) => name.endsWith(".js"));

test("the shell stamps every asset URL and leaves no placeholder behind", () => {
  const version = assetVersion(publicDir);
  assert.match(version, /^[0-9a-f]{12}$/);
  const html = renderShell(publicDir, "index.html");
  assert.ok(!html.includes("{{ASSET_V}}"), "unsubstituted stamp placeholder reached the browser");
  assert.ok(!html.includes("<!--ASSET_IMPORTMAP-->"), "import map placeholder was not replaced");
  assert.match(html, new RegExp(`/app\\.js\\?v=${version}`));
  assert.match(html, new RegExp(`/styles\\.css\\?v=${version}`));
  // The map must precede the module script, or the browser resolves imports before reading it.
  assert.ok(html.indexOf("importmap") < html.indexOf('src="/app.js'), "import map must come before the entry script");
});

test("every module app.js can import is versioned, not just the entry", () => {
  const map = JSON.parse(importMapFor(publicDir).replace(/^<script type="importmap">|<\/script>$/g, ""));
  const version = assetVersion(publicDir);
  for (const name of moduleNames) {
    assert.equal(map.imports[`/${name}`], `/${name}?v=${version}`, `${name} is not import-mapped`);
  }
  // The concrete regression: app.js imports admin-state.js by relative path, which resolves to the
  // mapped key — so a new app.js can never load a pre-deploy admin-state.js.
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  for (const [, specifier] of app.matchAll(/from "\.\/([\w.-]+\.js)"/g)) {
    assert.ok(map.imports[`/${specifier}`], `app.js imports ${specifier} but it is not in the import map`);
  }
});

test("the stamp follows content, so an unchanged deploy keeps its cached assets", () => {
  assert.equal(assetVersion(publicDir), assetVersion(publicDir));
});

const { createWebApp } = await import("../src/web/app.js");
const slackStub = { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null };
const app = createWebApp({ slack: slackStub });

// Drive the app as a plain request handler instead of binding a port: a sandboxed CI box may
// refuse `listen`, and the routing question here ("which handler answers /index.html") is answered
// identically either way.
function get(url) {
  return new Promise((resolve, reject) => {
    const request = new IncomingMessage(new Socket());
    request.method = "GET";
    request.url = url;
    request.headers = { host: "127.0.0.1" };
    const response = new ServerResponse(request);
    const chunks = [];
    const collect = (chunk, encoding) => {
      if (chunk && typeof chunk !== "function") chunks.push(Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
    };
    response.write = (chunk, encoding, done) => { collect(chunk, encoding); if (typeof done === "function") done(); return true; };
    response.end = (chunk, encoding, done) => {
      collect(chunk, encoding);
      if (typeof done === "function") done();
      resolve({ status: response.statusCode, header: (name) => response.getHeader(name), body: Buffer.concat(chunks).toString("utf8") });
      return response;
    };
    response.on("error", reject);
    app(request, response);
  });
}

test("no route can serve the raw, unstamped shell", async () => {
  for (const path of ["/", "/index.html", ...ADMIN_VIEW_PATHS, "/conversations/channel/C123"]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.ok(!response.body.includes("{{ASSET_V}}"), `${path} served an unstamped shell`);
    assert.match(response.body, /type="importmap"/, `${path} served a shell with no import map`);
    assert.equal(response.header("cache-control"), "no-cache", path);
  }
});

test("stamped module URLs are served and revalidated", async () => {
  const version = assetVersion(publicDir);
  for (const name of moduleNames) {
    const response = await get(`/${name}?v=${version}`);
    assert.equal(response.status, 200, name);
    assert.equal(response.header("cache-control"), "no-cache", name);
    assert.match(String(response.header("content-type") || ""), /javascript/, name);
  }
});

test("Admin shell, CSP and stamped module bytes stay from one release across activation and rollback", async t => {
  const { createHash } = await import("node:crypto");
  const { adminAssets, adminVersion } = await import("../src/web/admin-assets.ts");
  const { selectDashboardRelease, callsReleaseSession, useCheckoutCallsRelease } = await import("../src/web/dashboard-release.ts");
  const { gatewayRoot } = await import("../src/config/paths.js");
  const previous = adminAssets(publicDir).current();
  const next = { ...previous.source,
    "index.html": previous.source["index.html"].replace("<html", '<html data-design="second"'),
    "admin-state.js": previous.source["admin-state.js"] + "\n// second design",
    "styles.css": previous.source["styles.css"] + "\n/* second design */",
  };
  const version = adminVersion(next);
  const css = "/styles.css?v=", js = "/admin-state.js?v=";
  selectDashboardRelease(gatewayRoot(), callsReleaseSession, { admin: next });
  t.after(() => useCheckoutCallsRelease(gatewayRoot()));
  const shell = await get("/");
  assert.match(shell.body, /data-design="second"/);
  const map = shell.body.match(/<script type="importmap">([^<]+)<\/script>/)[1];
  assert.equal(JSON.parse(map).imports["/admin-state.js"], js + version);
  const policy = String(shell.header("content-security-policy"));
  assert.ok(policy.includes("'sha256-" + createHash("sha256").update(map).digest("base64") + "'"));
  assert.equal((await get(js + previous.version)).body, previous.source["admin-state.js"]);
  assert.equal((await get(css + previous.version)).body, previous.source["styles.css"]);
  assert.equal((await get(css + version)).body, next["styles.css"]);
  assert.equal((await get(js + version)).body, next["admin-state.js"]);
  assert.equal((await get(js + "000000000000")).status, 404);
  useCheckoutCallsRelease(gatewayRoot());
  assert.doesNotMatch((await get("/")).body, /data-design="second"/);
  assert.equal((await get(js + version)).body, next["admin-state.js"]);
});

test("an open admin tab can import its own version after another tab opens the released shell", { skip: !process.env.CG_BROWSER_MODULE }, async t => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { adminAssets } = await import("../src/web/admin-assets.ts");
  const { selectDashboardRelease, useCheckoutCallsRelease, callsReleaseSession } = await import("../src/web/dashboard-release.ts");
  const { gatewayRoot } = await import("../src/config/paths.js");
  const original = adminAssets(publicDir).current().source;
  const publish = name => selectDashboardRelease(gatewayRoot(), callsReleaseSession, { admin: {
    ...original,
    "index.html": '<!doctype html><title>' + name + '</title><!--ASSET_IMPORTMAP--><script type="module" src="/app.js?v={{ASSET_V}}"></script>',
    "app.js": 'globalThis.loadState = () => import("./admin-state.js").then(mod => mod.name);',
    "admin-state.js": 'export const name = ' + JSON.stringify(name) + ';',
  } });
  t.after(() => useCheckoutCallsRelease(gatewayRoot()));
  const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const first = await browser.newPage(), second = await browser.newPage();
  const url = "http://127.0.0.1:" + server.address().port;
  publish("first");
  await first.goto(url);
  publish("second");
  await second.goto(url);
  assert.equal(await second.title(), "second");
  assert.equal(await first.evaluate(() => globalThis.loadState()), "first");
  publish("first");
  await first.reload();
  assert.equal(await first.title(), "first");
  assert.equal(await second.evaluate(() => globalThis.loadState()), "second");
});
