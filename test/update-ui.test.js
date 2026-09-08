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
