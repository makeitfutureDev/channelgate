import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf("const UPDATE_PHASES ="), source.indexOf("// Resolve the initial path"));
function fixture({ entitlement = false, checked = true, transaction = null, fetchError = false } = {}) {
  const el = { innerHTML: "", addEventListener() {} };
  const timers = [];
  const context = {
    document: { getElementById: () => el },
    escapeHtml: (text) => String(text).replaceAll("<", "&lt;"),
    Date, Number, Math, JSON,
    sessionStorage: { getItem: () => null, removeItem() {}, setItem() {} },
    location: { reload() {} },
    api: async (url) => url.includes("check") ? { current: "abc", behind: checked ? 76 : 0, checked, automaticUpdates: entitlement } : { update: transaction },
    fetch: async () => { if (fetchError) throw new Error("offline"); return { ok: true, json: async () => ({ update: transaction }) }; },
    setTimeout: (fn) => timers.push(fn),
  };
  runInNewContext(code, context);
  return { el, timers, context };
}

test("only Enterprise sees update button; other editions see count and manual guidance", async () => {
  for (const entitlement of [false, true, undefined]) {
    const { el, context } = fixture({ entitlement });
    await context.loadUpdateStatus();
    assert.match(el.innerHTML, /76 commits? behind/);
    assert.equal(el.innerHTML.includes('<button id="update-now"'), entitlement === true);
    if (entitlement !== true) assert.match(el.innerHTML, /update manually/);
  }
});

test("reload preserves failed transaction and still offers Enterprise retry", async () => {
  const { el, context } = fixture({ entitlement: true, transaction: { status: "terminal", result: "refused", reason: "disk too small" } });
  await context.loadUpdateStatus();
  assert.match(el.innerHTML, /disk too small/);
  assert.match(el.innerHTML, /update-now/);
});

test("updates older than fifteen minutes continue monitoring", async () => {
  const transaction = { id: "long", status: "running", phase: "testing", startedAt: Date.now() - 20 * 60_000 };
  const { el, context, timers } = fixture({ transaction });
  await context.monitorGatewayUpdate("long", el, transaction.startedAt);
  assert.equal(timers.length, 1);
  assert.match(el.innerHTML, /regression suite/);
  assert.match(el.innerHTML, /still monitoring/);
});

test("restart connection loss remains visible and keeps polling", async () => {
  const { el, context, timers } = fixture({ fetchError: true });
  await context.monitorGatewayUpdate("tx", el);
  assert.match(el.innerHTML, /reconnect/);
  assert.equal(timers.length, 1);
});

test("interrupted update reports unverified completion without claiming rollback failed", async () => {
  const transaction = { id: "tx", status: "terminal", result: "failed", interrupted: true, reason: "Runner stopped; rollback unverified", candidateError: "missing acorn" };
  const { el, context, timers } = fixture({ transaction });
  await context.monitorGatewayUpdate("tx", el);
  assert.match(el.innerHTML, /rollback unverified/);
  assert.match(el.innerHTML, /missing acorn/);
  assert.doesNotMatch(el.innerHTML, /rollback failed/);
  assert.equal(timers.length, 0);
});

test("remote check failure does not claim up to date", async () => {
  const { el, context } = fixture({ checked: false });
  await context.loadUpdateStatus();
  assert.match(el.innerHTML, /update check unavailable/);
  assert.doesNotMatch(el.innerHTML, /up to date/);
});

test("session loss after restart asks for login without leaking or inventing update status", async () => {
  const { el, context, timers } = fixture();
  context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, instanceId: "replacement" }) });
  await context.monitorGatewayUpdate("tx", el);
  assert.match(el.innerHTML, /Sign in again/);
  assert.match(el.innerHTML, /completion is not yet verified/);
  assert.equal(timers.length, 0);
});

test("completed update shows a short revision with the full hash available on hover", () => {
  const { context } = fixture();
  const revision = "79ee4e6de60c3ea7be98699deea56922a6f36170";
  for (const transaction of [{ result: "updated" }, { result: "updated", changed: false }, { result: "rolled_back" }]) {
    const html = context.updateResultHtml({ ...transaction, runningRevision: revision });
    assert.ok(html.includes(`<code title="${revision}">79ee4e6</code>`));
  }
});

// Use the real sidebar markup, CSS and update renderer: DOM-only tests cannot detect overflow.
test("sidebar update results, progress and login links stay within the rail", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const sidebar = index.match(/<aside class="sidebar">[\s\S]*?<\/aside>/)[0];
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const revision = "79ee4e6de60c3ea7be98699deea56922a6f36170";
  const longDetail = `Fixture failure: /tmp/${"long-path-segment".repeat(12)}`;
  const states = [
    { status: "terminal", result: "updated", runningRevision: revision },
    { status: "terminal", result: "updated", changed: false, runningRevision: revision },
    { status: "terminal", result: "rolled_back", runningRevision: revision, candidateError: longDetail },
    { status: "terminal", result: "refused", reason: longDetail },
    { status: "terminal", result: "failed", rollbackError: longDetail },
    { status: "terminal", result: "updated", imageWarning: longDetail },
    { id: "running", status: "running", phase: "preflight", requiredDiskBytes: 8 * 1024 ** 3, availableDiskBytes: 12 * 1024 ** 3 },
  ];
  const markup = [];
  for (const transaction of states) {
    const { context, el } = fixture({ transaction });
    await context.loadUpdateStatus();
    markup.push(el.innerHTML);
  }
  const login = fixture();
  login.context.fetch = async () => ({ ok: true, json: async () => ({}) });
  await login.context.monitorGatewayUpdate("tx", login.el);
  markup.push(login.el.innerHTML);
  for (const width of [1440, 800, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.setContent(`<style>${css}</style><div class="app">${sidebar}<main class="content"></main></div>`);
    for (const html of markup) {
      await page.locator("#update").evaluate((el, value) => { el.innerHTML = value; }, html);
      const overflow = await page.locator("#update").evaluate((el) => {
        const rail = el.closest(".sidebar").getBoundingClientRect();
        const range = globalThis.document.createRange();
        range.selectNodeContents(el);
        return [...range.getClientRects()].some((rect) => rect.left < rail.left || rect.right > rail.right + 1);
      });
      assert.equal(overflow, false, `${width}px: ${html}`);
      for (const dot of await page.locator("#update .dot").all()) {
        const box = await dot.boundingBox();
        assert.equal(box.width, 7, "status dot remains visible at its normal size");
      }
    }
    assert.equal(await page.locator('#update a[href="/login"]').isVisible(), true);
  }
});
