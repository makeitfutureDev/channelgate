import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const settings = await import("../src/config/settings.js");
const { createSettingsRouter } = await import("../src/web/routes/settings.js");
const { createActivityRouter } = await import("../src/web/activity.js");
const { activityIcon } = await import("../src/web/activity-icons.js");
const { activityPage } = await import("../src/web/activity-page.js");
const { normalizeLogoColor, logoForeground } = await import("../src/config/appearance.js");
const { authMiddleware } = await import("../src/web/auth.js");
const { hashPassword } = await import("../src/web/security.js");
let base;
const app = express(); app.use(express.json());
app.use("/activity", createActivityRouter({ getClient: () => null, getTeamId: () => "T_FIXTURE", getBaseUrl: () => base }));
app.use((req, res, next) => req.path.startsWith("/api/") ? authMiddleware(req, res, next) : next());
app.use("/api", createSettingsRouter({ slack: { snapshot: () => ({ connected: false }) } }));
// The isolated router below represents an authenticated admin; auth denial is checked separately.
app.use("/admin", createSettingsRouter({ slack: { snapshot: () => ({ connected: false }) } }));
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.closeAllConnections(); server.close(); });
test.afterEach(() => settings.saveSettings({ logoColor: "#ff642f", adminPassword: "" }));
async function put(patch) {
  return fetch(base + "/admin/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...patch, connectSlack: false }) });
}
// Coloured PNGs use filter zero, so this reader checks their actual pixels independently.
function pixels(bytes) {
  const chunks = [];
  for (let at = 8; at < bytes.length;) {
    const size = bytes.readUInt32BE(at);
    if (bytes.toString("ascii", at + 4, at + 8) === "IDAT") chunks.push(bytes.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), channels = bytes[25] === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(chunks));
  return { width, height, channels, at: (x, y) => [...raw.subarray(y * (width * channels + 1) + 1 + x * channels, y * (width * channels + 1) + 1 + (x + 1) * channels)] };
}

test("logo color saves canonically, rejects invalid/stale writes atomically and requires admin auth", async () => {
  assert.equal(settings.getLogoColor(), "#ff642f");
  assert.equal((await put({ logoColor: " #7C3AED " })).status, 200);
  assert.equal(settings.settingsForApi().logoColor, "#7c3aed");
  const before = settings.getSettings();
  for (const logoColor of [null, false, 1, "red", "#fff", "#1234567", "#000000\" onload=\"alert(1)", {}, ["#112233"]]) {
    assert.equal((await put({ logoColor, publicUrl: "https://should-not-save.example" })).status, 400);
    assert.deepEqual(settings.getSettings(), before);
  }
  assert.equal((await put({ settingsVersion: "0", logoColor: "#00aabb" })).status, 409);
  settings.saveSettings({ adminPassword: await hashPassword("logo-fixture-only") });
  assert.equal((await fetch(base + "/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ logoColor: "#00aabb" }) })).status, 401);
  assert.equal(settings.getLogoColor(), "#7c3aed");
});

test("public manifest and real PNGs follow the deployment color, preserve app identity and alpha", async () => {
  const before = await (await fetch(base + "/activity/manifest.webmanifest")).json();
  await put({ logoColor: "#2266ee" });
  const response = await fetch(base + "/activity/manifest.webmanifest");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const manifest = await response.json();
  for (const field of ["id", "start_url", "scope"]) assert.equal(manifest[field], before[field]);
  for (const [i, icon] of manifest.icons.entries()) {
    assert.match(icon.src, /\?color=2266ee$/);
    assert.notEqual(icon.src, before.icons[i].src);
    const response = await fetch(base + icon.src);
    assert.match(response.headers.get("content-type"), /image\/png/);
    assert.match(response.headers.get("cache-control"), /immutable/);
    const bytes = Buffer.from(await response.arrayBuffer()), image = pixels(bytes);
    assert.equal(`${image.width}x${image.height}`, icon.sizes);
    assert.deepEqual(image.at(image.width / 2, 2).slice(0, 3), [34, 102, 238]);
    if (icon.purpose === "any") {
      assert.equal(image.at(0, 0)[3], 0);
      assert.equal(image.at(image.width / 2, 2)[3], 255);
    } else assert.equal(image.channels, 3, "maskable icon remains opaque");
    // Versioned old URLs retain their old artwork after changing settings.
    const old = await fetch(base + before.icons[i].src);
    const originalName = icon.src.split("/").at(-1).split("?")[0].replace(/^icon/, "activity-icon");
    assert.deepEqual(Buffer.from(await old.arrayBuffer()), readFileSync(new URL(`../public/activity/${originalName}`, import.meta.url)));
  }
  const login = await (await fetch(base + "/activity/login")).text();
  assert.match(login, /manifest\.webmanifest\?color=2266ee/);
  assert.match(login, /icon\.svg\?color=2266ee/);
  assert.match(login, /icon-192\.png\?color=2266ee/);
  assert.match(await (await fetch(base + "/activity/icon.svg?color=2266ee")).text(), /fill="#2266ee"/);
  const page = activityPage({ sessionId: "example-session", csrf: "test" }).html;
  assert.match(page, /fill="#2266ee"/);
  for (const path of ["/activity/icon.svg?color=bad", "/activity/icon-192.png?color=%3Cscript%3E", "/activity/icon-512.png?color=123456&color=abcdef"]) assert.equal((await fetch(base + path)).status, 400);
  assert.equal((await fetch(base + "/activity/icon-999.png")).status, 401);
});

test("PNG recoloring is deterministic, bounded to known assets, and dark custom colors retain a visible gate", () => {
  const first = activityIcon("activity-icon-192.png", "#abcdef");
  activityIcon("activity-icon-512.png", "#010203");
  assert.deepEqual(first, activityIcon("activity-icon-192.png", "#abcdef"));
  assert.equal(normalizeLogoColor("#ABCDEF"), "#abcdef");
  assert.equal(logoForeground("#010203"), "#ffffff");
  assert.equal(logoForeground("#ff642f"), "#18382b");
  assert.throws(() => activityIcon("../../settings.json", "#abcdef"));
  assert.deepEqual(activityIcon("activity-icon-192.png", "#ff642f"), readFileSync(new URL("../public/activity/activity-icon-192.png", import.meta.url)));
});
