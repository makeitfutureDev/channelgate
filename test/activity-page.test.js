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
  const elements = Object.fromEntries(["threads", "search", "filters", "connection", "connection-text", "updated", "notice", "summary", "table", "empty", "empty-title", "empty-copy", "result-count"].map((id) => [id, new Element()]));
  for (const filter of ["active", "working", "waiting", "error", "idle", "done", "open"]) {
    const button = new Element("button"); button.dataset.filter = filter; button.append(new Element("span")); elements.filters.append(button);
  }
  let stream;
  class EventSource extends Element {
    constructor(url) { super(); this.url = url; stream = this; }
    close() { this.closed = true; }
    snapshot(rows) { this.fire("threads", { data: JSON.stringify({ rows }) }); }
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
