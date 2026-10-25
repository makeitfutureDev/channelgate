// Security hardening of the admin web surface (audit 2026-10-23, batch 1):
//   - case-variant URLs ("/API/settings") can no longer slip past the path guards into the router;
//   - the admin shell and login page carry a Content-Security-Policy with no inline script, and
//     every response carries nosniff / frame-denial headers;
//   - an unexpected error answers with a bare status, never a stack trace;
//   - the background-job "Check status" button is gated like /status and scoped to its channel;
//   - the file explorer's share/preview/edit paths re-prove the opened descriptor under the root;
//   - the License card escapes the platform-supplied free text; the service unit runs in
//     production mode; the internal IPC secret is compared in constant time.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
process.env.CG_BIND_HOST = "127.0.0.1";
delete process.env.ADMIN_PASSWORD;
delete process.env.CG_API_KEY;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const publicDir = path.join(root, "public");

const { saveSettings } = await import("../src/config/settings.js");
const { noPasswordLockdown, authMiddleware, isApiPath } = await import("../src/web/auth.js");
const { importMapFor, shellContentSecurityPolicy } = await import("../src/web/assets.js");
const { createWebApp } = await import("../src/web/app.js");

function fakeRes() {
  const res = { statusCode: 200, body: null, redirectedTo: "" };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.redirect = (to) => { res.redirectedTo = to; return res; };
  return res;
}
function call(middleware, req) {
  const res = fakeRes();
  let passed = false;
  middleware({ method: "GET", headers: {}, ...req }, res, () => { passed = true; });
  return { res, passed };
}

// ── Case-variant paths ──────────────────────────────────────────────────────────
test("the path guards treat /API/... exactly like /api/...", () => {
  for (const p of ["/api/settings", "/API/settings", "/Api/Settings", "/API/runs"]) assert.equal(isApiPath(p), true, p);
  assert.equal(isApiPath("/apix"), false);
  assert.equal(isApiPath("/login.html"), false);

  saveSettings({ bindHost: "127.0.0.1", adminPassword: "", apiKey: "" });
  for (const p of ["/API/settings", "/Api/channels", "/API/runs"]) {
    const { res, passed } = call(noPasswordLockdown, { path: p });
    assert.equal(passed, false, `${p} must be refused by the lockdown`);
    assert.equal(res.statusCode, 403);
  }

  saveSettings({ bindHost: "127.0.0.1", adminPassword: "a-real-password", apiKey: "" });
  for (const p of ["/API/settings", "/API/users"]) {
    const { res, passed } = call(authMiddleware, { path: p });
    assert.equal(passed, false, `${p} must not pass without a session`);
    assert.equal(res.statusCode, 401, `${p} answers the API 401, not the page redirect`);
  }
  saveSettings({ bindHost: "127.0.0.1", adminPassword: "", apiKey: "" });
});

// ── Live app: routing, headers, error handler ───────────────────────────────────
const slackStub = { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null };
const app = createWebApp({ slack: slackStub });
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test("a case variant of an API path never reaches the router: refused by the guards, else a 404", async () => {
  assert.equal(app.get("case sensitive routing"), true);
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.ok((await health.json()).instanceId);
  // Two layers: the lowercase-aware guards answer first (403 here — the test install has no admin
  // password, so the lockdown refuses every API path), and case-sensitive routing would 404 anything
  // they let through. Either way the handler behind the path is never reached.
  for (const p of ["/API/health", "/Api/health", "/API/settings", "/API/runs", "/API/users"]) {
    const response = await fetch(base + p);
    assert.ok([401, 403, 404].includes(response.status), `${p}: ${response.status}`);
    assert.doesNotMatch(await response.text(), /instanceId|"ok":true/, p);
  }
  // Non-API paths keep their exact-case routes; a case variant of a page is a plain 404.
  assert.equal((await fetch(`${base}/Overview`)).status, 404);
});

test("the admin shell and the login page carry a no-inline-script CSP and frame denial", async () => {
  for (const p of ["/", "/overview", "/login.html"]) {
    const response = await fetch(base + p);
    assert.equal(response.status, 200, p);
    const csp = response.headers.get("content-security-policy") || "";
    assert.match(csp, /default-src 'self'/, p);
    assert.match(csp, /script-src 'self'(?: 'sha256-[A-Za-z0-9+/=]+')?(;|$)/, `${p}: scripts are same-origin plus at most the import-map hash`);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, p);
    assert.match(csp, /frame-ancestors 'none'/, p);
    assert.match(csp, /object-src 'none'/, p);
    assert.equal(response.headers.get("x-frame-options"), "DENY", p);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", p);
    assert.equal(response.headers.get("referrer-policy"), "same-origin", p);
  }
  // The shell's one inline script is the import map, admitted by the hash of its exact content.
  const json = importMapFor(publicDir).replace(/^<script type="importmap">/, "").replace(/<\/script>$/, "");
  const expected = `'sha256-${createHash("sha256").update(json).digest("base64")}'`;
  assert.ok(shellContentSecurityPolicy(publicDir).includes(`script-src 'self' ${expected}`));
  const shell = await (await fetch(`${base}/`)).text();
  assert.ok(shell.includes(json), "the served shell embeds the import map the hash was taken over");
  // No other inline script anywhere in the two pages (the login handler moved to /login.js).
  for (const file of ["index.html", "login.html"]) {
    const inline = (read(`public/${file}`).match(/<script\b(?![^>]*\bsrc=)[^>]*>/g) || []).filter((tag) => !/importmap/.test(tag));
    assert.deepEqual(inline, [], `${file} has no inline <script>`);
    assert.doesNotMatch(read(`public/${file}`), /\son[a-z]+="/i, `${file} has no inline event handlers`);
  }
  assert.equal((await fetch(`${base}/login.js`)).status, 200);
});

test("an error on a public route answers with a bare status and message, never a stack trace", async () => {
  const response = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.doesNotMatch(text, /node_modules|\n\s+at\s|SyntaxError: Unexpected/);
  assert.match(text, /"error"/);
  // The factory registers a final 4-arity error handler (what makes the above hold for every route).
  assert.match(read("src/web/app.js"), /app\.use\(\(err, req, res, _next\) => \{/);
});

test("the internal IPC secret is compared in constant time", () => {
  const src = read("src/web/app.js");
  const guard = src.match(/const internalForbidden = \(req\) => \{[\s\S]*?\n  \};/)?.[0] || "";
  assert.match(guard, /timingSafeEqualStr\(/);
  assert.doesNotMatch(guard, /!== secret/);
});

// ── Slack: background-job status, file explorer ─────────────────────────────────
test("the background-job status button runs through the run-control gate and stays in its channel", () => {
  const src = read("src/slack/app.js");
  const handler = src.match(/app\.action\("cg_bgjob_status",[\s\S]*?\n  \}\);/)?.[0] || "";
  assert.ok(handler, "handler present");
  assert.match(handler, /await authorizedControlEntry\(channel, userId\)/);
  assert.match(handler, /live\.slug === authorized\.slug/);
  assert.doesNotMatch(handler, /getChannelEntry\(/);
  // status() reports the owning slug so the handler can compare it.
  assert.match(read("src/gateway/background.js"), /return \{ id: j\.id, slug: j\.slug \|\| "", kind:/);
});

test("file explorer share, send-to-me, preview and edit re-prove the opened file under the channel root", () => {
  const src = read("src/slack/app.js");
  const share = src.match(/command\.o === "share"\) \{[\s\S]*?await uploadLocalFile\(\{[\s\S]*?\}\);/)?.[0] || "";
  const sendDm = src.match(/command\.o === "send_dm"\) \{[\s\S]*?await uploadLocalFile\(\{[\s\S]*?\}\);/)?.[0] || "";
  assert.match(share, /rootPath: file\.rootReal/);
  assert.match(sendDm, /rootPath: file\.rootReal/);
  const explorer = read("src/slack/file-explorer.js");
  const opener = explorer.match(/async function openVisibleFile\(file\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(opener, /O_NOFOLLOW/);
  assert.match(opener, /\/proc\/self\/fd\//);
  assert.match(opener, /isWithin\(file\.rootReal, openedReal\)/);
  const preview = explorer.match(/export async function readFilePreview\([\s\S]*?\n\}/)?.[0] || "";
  const edit = explorer.match(/export async function readEditableFile\([\s\S]*?\n\}/)?.[0] || "";
  assert.match(preview, /openVisibleFile\(file\)/);
  assert.match(edit, /openVisibleFile\(file\)/);
  assert.doesNotMatch(edit, /readFile\(file\.path\)/);
});

// ── Browser side and service unit ───────────────────────────────────────────────
test("the License card escapes every platform-supplied value it renders as HTML", () => {
  const src = read("public/app.js");
  const paint = src.match(/function paintLicense\(l\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(paint, /escapeHtml\(l\.organization \|\| "—"\)/);
  assert.match(paint, /escapeHtml\(l\.tier\)/);
  assert.match(src, /const fmtLicenseLimit = \(v\) => \(v === null \|\| v === undefined \? "unlimited" : escapeHtml\(String\(v\)\)\)/);
  assert.match(src, /const fmtLicenseTime = \(v\) => \(v \? escapeHtml\(new Date\(v\)\.toLocaleString\(\)\) : "—"\)/);
});

test("the systemd unit runs the daemon with NODE_ENV=production", () => {
  assert.match(read("scripts/install-systemd.sh"), /^Environment=NODE_ENV=production$/m);
});
