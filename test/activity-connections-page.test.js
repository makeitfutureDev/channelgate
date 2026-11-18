import test from "node:test";
import assert from "node:assert/strict";
import { activityConnectionsBrowser } from "../src/web/activity-connections-page.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.value = ""; this.text = ""; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(item => item.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ""; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  all() { return this.children.flatMap(item => [item, ...item.all()]); }
  querySelectorAll(selector) { return this.all().filter(item => selector.split(",").includes(item.tag)); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const state = (extra = {}) => ({ mode: "sdk", canAdd: true, state: "ready", accounts: [], policy: { multiAccount: true, maxAccountsPerToolkit: 5 }, ...extra });
const app = (slug, extra = {}) => ({ slug, name: slug === "gmail" ? "Gmail" : slug === "slack" ? "Slack" : slug, canConnect: true, ...extra });
const find = (root, tag, text) => root.all().find(item => item.tag === tag && item.textContent === text);
const openApp = (root, name = "Gmail") => root.all().find(item => item.tag === "button" && item.attributes["aria-label"] === "View " + name + " connections").listeners.click();
const connectApp = root => { openApp(root); find(root, "button", "Connect new").listeners.click(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(fetch, config = {}) {
  const requests = [], timers = new Map(); let timerId = 0;
  const browser = { document: { createElement: tag => new Element(tag) }, URL,
    fetch: (url, options) => { requests.push({ url, options }); return fetch(url, options); },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) };
  const widget = activityConnectionsBrowser({ base: "/activity/me", csrf: "private-csrf", ...config }, browser);
  const root = widget.mount();
  return { root, widget, requests, tick() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); } };
}

test("cached mount groups own application accounts, renders hostile data as text and links to add", async () => {
  const { root, widget, requests } = fixture(async () => response(state({ accounts: [
    { app: "gmail", account: "<img src=x onerror=alert(1)>", alias: "work", status: "ACTIVE", isDefault: true },
    { app: "gmail", account: "personal@example.test", alias: "personal", status: "ACTIVE" },
  ] })));
  assert.equal(widget.mount(), root); await flush();
  assert.equal(requests.length, 1);
  assert.equal(root.all().filter(item => item.className === "connection-app-card").length, 1);
  assert.match(root.textContent, /2 accounts · 2 active/);
  assert.doesNotMatch(root.textContent, /personal@example.test|onerror/);
  assert.equal(find(root, "a", "Add connection").href, "/activity/me/settings/connections/new");
  openApp(root);
  assert.ok(find(root, "div", "<img src=x onerror=alert(1)> · ACTIVE · Default account"));
  assert.ok(find(root, "button", "Back to apps"));
});

test("personal token mode is list-only even on the add page and never fetches the catalog", async () => {
  const { root, requests } = fixture(async () => response(state({ mode: "personal", canAdd: false })), { connectionsNew: true });
  await flush(); assert.equal(requests.length, 1);
  assert.match(root.textContent, /Add applications in Composio/);
  assert.equal(find(root, "a", "Add connection"), undefined);
  assert.ok(find(root, "button", "Refresh"));
});

test("parent token changes refresh the cached widget and immediately clear removed accounts", async () => {
  const stale = deferred(), removed = deferred(); let calls = 0;
  const { root, widget } = fixture(async () => {
    calls++;
    if (calls === 1) return response(state({ mode: "personal", state: "unconfigured", canAdd: false }));
    if (calls === 2) return response(state({ mode: "personal", canAdd: false, accounts: [{ app: "gmail", account: "private@example.test" }] }));
    return calls === 3 ? stale.promise : removed.promise;
  });
  await flush(); assert.match(root.textContent, /Add your personal Composio token below/);
  await widget.refresh(); openApp(root); assert.match(root.textContent, /private@example.test/); assert.equal(widget.mount(), root);
  const beforeRemove = widget.refresh();
  assert.doesNotMatch(root.textContent, /private@example.test/);
  const removal = widget.refresh();
  removed.resolve(response(state({ mode: "personal", state: "unconfigured", canAdd: false })));
  await removal;
  stale.resolve(response(state({ mode: "personal", canAdd: false, accounts: [{ app: "gmail", account: "stale@example.test" }] })));
  await beforeRemove;
  assert.match(root.textContent, /Add your personal Composio token below/); assert.doesNotMatch(root.textContent, /private@example.test|stale@example.test/);
});

test("refresh ignores access refusals from the old inventory request", async () => {
  const stale = deferred(); let calls = 0;
  const { root, widget } = fixture(async () => ++calls === 1 ? stale.promise : response(state({ accounts: [{ app: "gmail", account: "current@example.test" }] })));
  await widget.refresh(); openApp(root); stale.resolve(response({}, 403)); await flush();
  assert.match(root.textContent, /current@example.test/); assert.doesNotMatch(root.textContent, /session has ended/);
});

test("load failure differs from empty, retries successfully and access loss clears old account data", async () => {
  let calls = 0;
  const { root } = fixture(async () => ++calls === 1 ? response({ error: "Provider unavailable" }, 502)
    : calls === 2 ? response(state({ accounts: [{ app: "gmail", account: "private@example.test" }] })) : response({}, 401));
  await flush(); assert.match(root.textContent, /Provider unavailable/); assert.doesNotMatch(root.textContent, /No applications/);
  find(root, "button", "Retry connections").listeners.click(); await flush();
  openApp(root); assert.match(root.textContent, /private@example.test/);
  find(root, "button", "Back to apps").listeners.click(); find(root, "button", "Refresh").listeners.click(); await flush();
  assert.match(root.textContent, /session has ended/); assert.doesNotMatch(root.textContent, /private@example.test/);
});

test("provider unavailable state is never rendered as an empty connection list", async () => {
  const { root } = fixture(async () => response(state({ state: "unavailable", message: "Token is not configured" })));
  await flush(); assert.match(root.textContent, /Token is not configured/); assert.doesNotMatch(root.textContent, /No applications/);
});

test("unconfigured modes show setup instructions instead of an empty connected-account list", async () => {
  for (const mode of ["sdk", "personal"]) {
    const { root, requests } = fixture(async () => response(state({ mode, state: "unconfigured", canAdd: false })), { connectionsNew: true });
    await flush(); assert.match(root.textContent, mode === "sdk" ? /SDK is not configured/ : /Add your personal Composio token below/);
    assert.doesNotMatch(root.textContent, /No applications are connected/); assert.equal(requests.length, 1);
  }
});

test("catalog search ignores stale requests and preserves search focus by reusing its input", async () => {
  const held = deferred();
  const { root, tick, requests } = fixture(async url => !url.includes("/apps?") ? response(state()) : url.endsWith("query=") ? held.promise : response({ apps: [app("slack")], nextCursor: null }), { connectionsNew: true });
  await flush(); const search = root.querySelectorAll("input")[0]; search.value = "slack"; search.listeners.input(); tick(); await flush();
  assert.ok(root.all().find(item => item.attributes["aria-label"] === "View Slack connections"));
  held.resolve(response({ apps: [app("gmail")], nextCursor: "stale" })); await flush();
  assert.equal(root.querySelectorAll("input")[0], search); assert.equal(root.all().find(item => item.attributes["aria-label"] === "View Gmail connections"), undefined);
  assert.ok(requests.some(item => item.url.endsWith("query=slack")));
});

test("catalog pagination deduplicates applications and policy-refused applications cannot be chosen", async () => {
  const { root, requests } = fixture(async url => !url.includes("/apps?") ? response(state()) : url.includes("cursor=")
    ? response({ apps: [app("gmail"), app("slack", { canConnect: false, reason: "Limit reached" })], nextCursor: null })
    : response({ apps: [app("gmail")], nextCursor: "next page" }), { connectionsNew: true });
  await flush(); find(root, "button", "Load more applications").listeners.click(); await flush();
  assert.equal(root.all().filter(item => item.attributes["aria-label"] === "View Gmail connections").length, 1);
  openApp(root, "Slack"); assert.equal(find(root, "button", "Connect new").disabled, true);
  assert.match(root.textContent, /Limit reached/);
  find(root, "button", "Back to apps").listeners.click(); await flush();
  assert.ok(requests.some(item => /cursor=next%20page/.test(item.url)));
});

test("catalog error shows retry without claiming that no apps match", async () => {
  let calls = 0;
  const { root } = fixture(async url => !url.includes("/apps?") ? response(state()) : ++calls === 1
    ? response({ error: "Catalog temporarily unavailable" }, 503) : response({ apps: [app("gmail")] }), { connectionsNew: true });
  await flush(); assert.match(root.textContent, /Catalog temporarily unavailable/); assert.doesNotMatch(root.textContent, /No applications match/);
  find(root, "button", "Retry applications").listeners.click(); await flush(); assert.ok(root.all().find(item => item.attributes["aria-label"] === "View Gmail connections"));
});

test("create requires alias, prevents duplicate POST and offers explicit HTTPS authorization with CSRF", async () => {
  const held = deferred();
  const { root, requests } = fixture(async (url, options) => options.method === "POST" ? held.promise
    : url.includes("/apps?") ? response({ apps: [app("gmail")] }) : response(state()), { connectionsNew: true });
  await flush(); connectApp(root);
  const form = root.all().find(item => item.tag === "form"), alias = form.querySelectorAll("input")[0];
  await form.listeners.submit({ preventDefault() {} }); assert.match(form.textContent, /Enter an account alias/);
  alias.value = " work "; const first = form.listeners.submit({ preventDefault() {} }); const second = form.listeners.submit({ preventDefault() {} });
  assert.equal(requests.filter(item => item.options.method === "POST").length, 1);
  const post = requests.at(-1); assert.equal(post.options.headers["X-CG-CSRF"], "private-csrf");
  assert.deepEqual(JSON.parse(post.options.body), { app: "gmail", alias: "work" });
  held.resolve(response({ redirectUrl: "https://connect.composio.dev/link/one" })); await Promise.all([first, second]);
  const authorize = find(root, "a", "Continue to Gmail"); assert.equal(authorize.target, "_blank"); assert.equal(authorize.rel, "noopener noreferrer");
  assert.equal(find(root, "a", "View your connections").href, "/activity/me/settings/connections");
});

test("unsafe authorization URLs are refused and a failed POST is not retried automatically", async () => {
  for (const redirectUrl of ["javascript:alert(1)", "http://connect.composio.dev/auth", "https://user:password@connect.composio.dev/auth", "https://connect.composio.dev:444/auth", "https://connect.composio.dev.attacker.test/auth", "https://attacker.test/auth", "/relative"]) {
    const { root, requests } = fixture(async (url, options) => options.method === "POST" ? response({ redirectUrl })
      : url.includes("/apps?") ? response({ apps: [app("gmail")] }) : response(state()), { connectionsNew: true });
    await flush(); connectApp(root);
    const form = root.all().find(item => item.tag === "form"); form.querySelectorAll("input")[0].value = "work";
    await form.listeners.submit({ preventDefault() {} });
    assert.match(root.textContent, /invalid authorization link/); assert.equal(find(root, "a", "Continue to Gmail"), undefined);
    assert.equal(requests.filter(item => item.options.method === "POST").length, 1);
    assert.equal(form.querySelectorAll("input")[0].disabled, false);
  }
});

test("access loss during catalog/create clears the whole widget and ignores late responses", async () => {
  const held = deferred(); let calls = 0;
  const { root, tick } = fixture(async url => !url.includes("/apps?") ? response(state()) : ++calls === 1 ? held.promise : response({}, 403), { connectionsNew: true });
  await flush(); const search = root.querySelectorAll("input")[0]; search.value = "new"; search.listeners.input(); tick(); await flush();
  assert.match(root.textContent, /session has ended/);
  held.resolve(response({ apps: [app("private-app")] })); await flush(); assert.doesNotMatch(root.textContent, /private-app/);
});

test("connected app overview filters locally and SDK All apps loads only when requested", async () => {
  const { root, requests } = fixture(async url => url.includes("/apps?") ? response({ apps: [app("slack")] }) : response(state({ accounts: [
    { app: "gmail", alias: "work", account: "private@example.test", status: "ACTIVE" },
    { app: "slack", alias: "team", status: "DISABLED" },
  ] })));
  await flush(); assert.equal(requests.length, 1);
  assert.match(root.textContent, /Connected \(2\)/); assert.match(root.textContent, /1 account · 0 active/);
  const search = root.querySelectorAll("input")[0]; search.value = "mail"; search.listeners.input();
  assert.equal(requests.length, 1); assert.ok(root.all().find(item => item.attributes["aria-label"] === "View Gmail connections"));
  assert.equal(root.all().find(item => item.attributes["aria-label"] === "View Slack connections"), undefined);
  find(root, "button", "All apps").listeners.click(); await flush();
  assert.equal(find(root, "button", "All apps").attributes["aria-pressed"], "true");
  assert.equal(requests.length, 2); assert.ok(root.all().find(item => item.attributes["aria-label"] === "View Slack connections"));
});

test("leaving All apps invalidates outstanding catalog replies", async () => {
  const held = deferred();
  const { root } = fixture(async url => url.includes("/apps?") ? held.promise : response(state({ accounts: [{ app: "gmail", status: "ACTIVE" }] })));
  await flush(); find(root, "button", "All apps").listeners.click();
  find(root, "button", "Connected (1)").listeners.click();
  held.resolve(response({ apps: [app("slack")] })); await flush();
  assert.ok(root.all().find(item => item.attributes["aria-label"] === "View Gmail connections"));
  assert.equal(root.all().find(item => item.attributes["aria-label"] === "View Slack connections"), undefined);
});

test("account removal requires explicit inline confirmation, sends exact ID and CSRF, then reloads inventory", async () => {
  const held = deferred(); let deleted = false;
  const { root, requests } = fixture(async (_url, options) => options.method === "DELETE" ? held.promise : response(state({ accounts: deleted ? [] : [
    { id: "account/one ?", app: "gmail", alias: "personal", account: "person@example.test", status: "ACTIVE", canDelete: true },
  ] })));
  await flush(); openApp(root);
  find(root, "button", "Delete connection").listeners.click();
  assert.match(root.textContent, /Delete personal\?/); assert.equal(requests.length, 1);
  find(root, "button", "Cancel deletion").listeners.click();
  assert.equal(find(root, "button", "Confirm deletion"), undefined); assert.equal(requests.length, 1);
  find(root, "button", "Delete connection").listeners.click();
  const confirm = find(root, "button", "Confirm deletion");
  const first = confirm.listeners.click(), second = confirm.listeners.click();
  assert.equal(requests.filter(item => item.options.method === "DELETE").length, 1);
  const deletion = requests.at(-1); assert.equal(deletion.url, "/activity/me/api/connections/account%2Fone%20%3F");
  assert.equal(deletion.options.headers["X-CG-CSRF"], "private-csrf"); assert.equal(deletion.options.body, undefined);
  assert.equal(find(root, "button", "Back to apps").disabled, true);
  deleted = true; held.resolve(response({ deleted: true })); await Promise.all([first, second]);
  assert.match(root.textContent, /no connected accounts for this application/); assert.doesNotMatch(root.textContent, /person@example.test/);
  assert.equal(requests.filter(item => item.options.method === "GET").length, 2);
});

test("delete is offered only for explicitly deletable accounts and personal mode can remove supported connections", async () => {
  const { root } = fixture(async () => response(state({ mode: "personal", canAdd: false, accounts: [
    { id: "own", app: "gmail", alias: "own", status: "ACTIVE", canDelete: true },
    { id: "shared", app: "gmail", alias: "shared", status: "ACTIVE", canDelete: false },
    { id: "legacy", app: "gmail", alias: "legacy", status: "ACTIVE" },
  ] })));
  await flush(); openApp(root);
  assert.equal(root.all().filter(item => item.tag === "button" && item.textContent === "Delete connection").length, 1);
  assert.equal(find(root, "button", "Connect new"), undefined);
});

test("failed deletion remains visible, does not refresh or retry, and allows an explicit retry", async () => {
  const { root, requests } = fixture(async (_url, options) => options.method === "DELETE" ? response({ error: "Could not remove account" }, 503)
    : response(state({ accounts: [{ id: "one", app: "gmail", alias: "work", canDelete: true }] })));
  await flush(); openApp(root); find(root, "button", "Delete connection").listeners.click();
  await find(root, "button", "Confirm deletion").listeners.click();
  assert.match(root.textContent, /Could not remove account/); assert.equal(requests.length, 2);
  assert.equal(find(root, "button", "Confirm deletion").disabled, false);
  assert.equal(find(root, "button", "Back to apps").disabled, false);
});

test("access loss during deletion clears private details and cannot be retried", async () => {
  const { root } = fixture(async (_url, options) => options.method === "DELETE" ? response({}, 403)
    : response(state({ accounts: [{ id: "one", app: "gmail", account: "private@example.test", canDelete: true }] })));
  await flush(); openApp(root); find(root, "button", "Delete connection").listeners.click();
  await find(root, "button", "Confirm deletion").listeners.click();
  assert.match(root.textContent, /session has ended/); assert.doesNotMatch(root.textContent, /private@example.test/);
  assert.equal(find(root, "button", "Confirm deletion"), undefined);
});

test("parent token refresh invalidates a delayed deletion and detached confirmation controls", async () => {
  const held = deferred(); let inventoryCalls = 0;
  const { root, widget, requests } = fixture(async (_url, options) => options.method === "DELETE" ? held.promise : response(state({
    accounts: ++inventoryCalls === 1 ? [{ id: "old", app: "gmail", account: "old@example.test", canDelete: true }] : [{ app: "slack", alias: "new" }],
  })));
  await flush(); openApp(root); find(root, "button", "Delete connection").listeners.click();
  const confirmation = find(root, "button", "Confirm deletion"), deletion = confirmation.listeners.click();
  await widget.refresh(); held.resolve(response({ deleted: true })); await deletion;
  await confirmation.listeners.click();
  assert.equal(requests.filter(item => item.options.method === "DELETE").length, 1);
  assert.ok(root.all().find(item => item.attributes["aria-label"] === "View Slack connections"));
  assert.doesNotMatch(root.textContent, /old@example.test/); assert.equal(inventoryCalls, 2);
});
