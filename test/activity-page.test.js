import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { activityPage } from "../src/web/activity-page.js";

// Exercise the generated browser script (including asynchronous responses), rather than a second
// implementation of dashboard state. Browser layout/CSP are also covered by manual acceptance.
class Element {
  constructor(tag = "div") {
    this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attrs = {};
    this.value = ""; this.disabled = false; this.hidden = false; this.parent = null; this.text = "";
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  removeAttribute(key) { delete this.attrs[key]; if (key === "href") delete this.href; }
  append(...items) { for (const item of items) this.insertBefore(item, null); }
  insertBefore(item, before) {
    item.remove(); item.parent = this;
    const index = before ? this.children.indexOf(before) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, item);
  }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  querySelectorAll(selector) { return this.children.flatMap((c) => [...(c.tag === selector ? [c] : []), ...c.querySelectorAll(selector)]); }
  closest(selector) { return this.tag === "button" && selector.startsWith("button") ? this : this.parent?.closest(selector); }
  fire(type, event = {}) { this.listeners[type]?.({ target: this, ...event }); }
}
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
function row(status = "working", title = "Fixture thread", url = "/activity/session/open/C1/1.1") {
  return { channelId: "C1", threadTs: "1.1", title, channelName: "Engineering", status, lastMessageMs: 1_800_000_000_000, url };
}
function browser(fetchImpl = async () => response({ rows: [] }), csrf = "fixture-csrf") {
  const elements = Object.fromEntries(["threads", "search", "filters", "connection", "connection-text", "updated", "notice", "summary", "table", "empty", "empty-title", "empty-copy", "result-count", "group-order", "order-dialog", "order-list", "order-save", "order-cancel", "order-reset", "order-error"].map((id) => [id, new Element()]));
  for (const filter of ["active", "working", "waiting", "error", "idle", "done", "open"]) {
    const button = new Element("button"); button.dataset.filter = filter; button.append(new Element("span")); elements.filters.append(button);
  }
  let stream;
  class EventSource extends Element {
    constructor(url) { super(); this.url = url; stream = this; }
    close() { this.closed = true; }
    snapshot(rows, extra = {}) { this.fire("threads", { data: JSON.stringify({ rows, ...extra }) }); }
  }
  const requests = [], timers = [];
  const page = activityPage({ sessionId: "session", csrf });
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(page.html)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    document: { getElementById: (id) => elements[id], createElement: (tag) => new Element(tag) },
    fetch: (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); },
    EventSource, URL, Intl, Date, location: { origin: "https://gateway.example" },
    setInterval: (fn) => { timers.push(fn); return 1; }, clearInterval() {}, addEventListener() {},
  });
  return { elements, stream, requests, timers, page };
}

test("activity browser keeps a newer SSE snapshot when the initial fetch resolves later", async () => {
  const initial = deferred();
  const { elements, stream } = browser(() => initial.promise);
  stream.snapshot([row()]);
  assert.equal(elements.threads.children.length, 1);
  initial.resolve(response({ rows: [] }));
  await flush();
  assert.equal(elements.threads.children.length, 1);
  assert.equal(elements.threads.children[0].children[0].textContent, "Fixture thread");
});

test("activity browser safely renders hostile text and restricts links to Slack or this session", () => {
  const { elements, stream, page } = browser(() => new Promise(() => {}), '</script><script>alert(1)</script>');
  assert.equal((page.html.match(/<script nonce=/g) || []).length, 1);
  assert.ok(!page.html.includes('</script><script>alert(1)</script>'));
  const title = '<img src=x onerror="alert(1)">';
  for (const url of ["javascript:alert(1)", "https://slack.com.attacker.example/a", "https://user@team.slack.com/a", "/activity/other/open/C1/1.1", "/api/settings"]) {
    stream.snapshot([row("working", title, url)]);
    const anchor = elements.threads.children[0].children[0].children[0];
    assert.equal(anchor.textContent, title);
    assert.equal(anchor.children.length, 0);
    assert.equal(anchor.href, undefined);
  }
  for (const url of ["https://team.slack.com/archives/C1/p11", "/activity/session/open/C1/1.1"]) {
    stream.snapshot([row("working", title, url)]);
    const anchor = elements.threads.children[0].children[0].children[0];
    assert.ok(anchor.href.startsWith("https://"));
    assert.equal(anchor.rel, "noopener noreferrer");
  }
});

test("activity browser filters locally and serializes each completion action with CSRF", async () => {
  const save = deferred();
  let done = false;
  const { elements, stream, requests } = browser((url) => url.endsWith("/completion") ? save.promise : Promise.resolve(response({ rows: [row(done ? "done" : "working")] })));
  await flush();
  const tr = elements.threads.children[0], toggle = tr.children[4].children[1];
  elements.search.value = "no match"; elements.search.fire("input");
  assert.equal(elements.threads.children.length, 0);
  elements.search.value = "engineering"; elements.search.fire("input");
  assert.equal(elements.threads.children.length, 1);
  const button = elements.threads.children[0].children[4].children[1];
  elements.threads.fire("click", { target: button });
  elements.threads.fire("click", { target: button });
  assert.equal(button.disabled, true);
  const posts = requests.filter((req) => req.url.endsWith("/completion"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].options.headers["X-CG-CSRF"], "fixture-csrf");
  assert.deepEqual(JSON.parse(posts[0].options.body), { channelId: "C1", threadTs: "1.1", done: true });
  done = true; save.resolve(response({ ok: true })); await flush();
  assert.equal(elements.threads.children.length, 0);
  elements.filters.fire("click", { target: elements.filters.children.find((b) => b.dataset.filter === "done") });
  assert.equal(elements.threads.children[0].children[4].children[1].textContent, "Reopen");
  assert.equal(toggle.textContent, "Done");
  stream.fire("access-ended");
});

test("activity browser clears private rows on access loss and rejects late fetch or SSE data", async () => {
  const initial = deferred();
  const { elements, stream } = browser(() => initial.promise);
  stream.snapshot([row()]);
  stream.fire("access-ended");
  initial.resolve(response({ rows: [row()] })); await flush();
  stream.snapshot([row()]);
  assert.equal(elements.threads.children.length, 0);
  assert.equal(stream.closed, true);
  assert.equal(elements.search.disabled, true);
  assert.match(elements.notice.textContent, /access has ended/);
  assert.equal(elements.table.hidden, true);
});

test("activity browser handles authorization failures and hides transient server details", async () => {
  for (const status of [401, 403, 500]) {
    const { elements, stream } = browser(async () => response({ error: "private server detail" }, status));
    await flush();
    assert.ok(!elements.notice.textContent.includes("private server detail"));
    if (status !== 500) { assert.equal(stream.closed, true); assert.equal(elements.search.disabled, true); }
    else assert.match(elements.notice.textContent, /try again automatically/);
  }
});

const titles = (elements) => elements.threads.children.map((tr) => tr.children[0].textContent);
const orderLabels = (elements) => elements["order-list"].children.map((li) => li.children[0].textContent);
function moveGroup(elements, status, direction) {
  const button = elements["order-list"].children.flatMap((li) => li.children[1].children)
    .find((b) => b.dataset.status === status && b.dataset.direction === String(direction));
  elements["order-list"].fire("click", { target: button });
}
test("activity groups errors, waiting, working and idle before sorting newest within a group", () => {
  const { elements, stream } = browser(() => new Promise(() => {}));
  const rows = ["idle", "working", "waiting", "error", "error", "done"].map((status, i) =>
    ({ ...row(status, status + i), threadTs: String(i + 1), lastMessageMs: 100 - i }));
  stream.snapshot(rows);
  assert.deepEqual(titles(elements), ["error3", "error4", "waiting2", "working1", "idle0"]);
  stream.snapshot(rows.map((r) => r.title === "idle0" ? { ...r, status: "waiting" } : r));
  assert.deepEqual(titles(elements), ["error3", "error4", "idle0", "waiting2", "working1"]);
  elements.filters.fire("click", { target: elements.filters.children.find((b) => b.dataset.filter === "open") });
  assert.deepEqual(titles(elements), ["error3", "error4", "idle0", "waiting2", "working1"]);
  elements.filters.fire("click", { target: elements.filters.children.find((b) => b.dataset.filter === "error") });
  assert.deepEqual(titles(elements), ["error3", "error4"]);
});

test("group order dialog stages changes, saves once with CSRF, survives live updates, and resets", async () => {
  const save = deferred();
  const { elements, stream, requests } = browser((url) => url.endsWith("/group-order") ? save.promise : new Promise(() => {}));
  const rows = ["idle", "error", "working", "waiting"].map((status, i) => ({ ...row(status, status), threadTs: String(i + 1) }));
  stream.snapshot(rows);
  elements["group-order"].fire("click");
  assert.equal(elements["order-dialog"].open, true);
  moveGroup(elements, "idle", -1); moveGroup(elements, "idle", -1); moveGroup(elements, "idle", -1);
  assert.deepEqual(orderLabels(elements), ["Idle", "Error", "Waiting", "Working"]);
  assert.deepEqual(titles(elements), ["error", "waiting", "working", "idle"], "draft has not been applied");
  elements["order-cancel"].fire("click"); elements["group-order"].fire("click");
  assert.deepEqual(orderLabels(elements), ["Error", "Waiting", "Working", "Idle"]);
  moveGroup(elements, "error", 1);
  elements["order-save"].fire("click"); elements["order-save"].fire("click");
  const posts = requests.filter((req) => req.url.endsWith("/group-order"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].options.headers["X-CG-CSRF"], "fixture-csrf");
  assert.deepEqual(JSON.parse(posts[0].options.body), { groupOrder: ["waiting", "error", "working", "idle"] });
  assert.equal(elements["order-cancel"].disabled, true);
  save.resolve(response({ groupOrder: ["waiting", "error", "working", "idle"], groupOrderVersion: 1 })); await flush();
  assert.equal(elements["order-dialog"].open, false);
  stream.snapshot(rows, { groupOrder: ["error", "waiting", "working", "idle"], groupOrderVersion: 0 });
  assert.deepEqual(titles(elements), ["waiting", "error", "working", "idle"], "buffered pre-save SSE cannot revert the saved order");
  stream.snapshot(rows, { groupOrder: ["waiting", "error", "working", "idle"], groupOrderVersion: 1 });
  assert.deepEqual(titles(elements), ["waiting", "error", "working", "idle"]);
  elements["group-order"].fire("click"); elements["order-reset"].fire("click");
  assert.deepEqual(orderLabels(elements), ["Error", "Waiting", "Working", "Idle"]);
  elements["order-cancel"].fire("click");
  stream.snapshot(rows, { groupOrder: ["unknown"] });
  assert.deepEqual(titles(elements), ["waiting", "error", "working", "idle"]);
});

test("group order failure preserves the draft and access loss closes the dialog", async () => {
  const { elements, stream } = browser((url) => url.endsWith("/group-order") ? Promise.resolve(response({}, 500)) : new Promise(() => {}));
  elements["group-order"].fire("click"); moveGroup(elements, "error", 1);
  elements["order-save"].fire("click"); await flush();
  assert.equal(elements["order-dialog"].open, true);
  assert.match(elements["order-error"].textContent, /couldn’t be saved/);
  assert.equal(elements["order-save"].disabled, false);
  assert.deepEqual(orderLabels(elements), ["Waiting", "Error", "Working", "Idle"]);
  stream.fire("access-ended");
  assert.equal(elements["order-dialog"].open, false);
  assert.equal(elements["group-order"].disabled, true);
});
