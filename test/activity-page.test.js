import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createSubscriptionUi } from "../public/subscription-ui.js";
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
  closest(selector) {
    if (this.tag === "button" && selector.startsWith("button")) return this;
    if (selector.startsWith("a.") && this.tag === "a" && String(this.className).split(" ").includes(selector.slice(2))) return this;
    return this.parent?.closest(selector);
  }
  fire(type, event = {}) {
    let prevented = false;
    this.listeners[type]?.({ target: this, preventDefault() { prevented = true; }, ...event });
    if (type === "cancel" && !prevented) this.close();
    return prevented;
  }
}
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
function row(status = "working", title = "Fixture thread", url = "/activity/session/open/C1/1.1") {
  return { channelId: "C1", threadTs: "1.1", title, channelName: "Engineering", status, lastMessageMs: 1_800_000_000_000, url };
}
function browser(fetchImpl = async () => response({ rows: [] }), csrf = "fixture-csrf", subscriptions = false, { prefersLight = false, teamId = "TWORK" } = {}) {
  const elements = Object.fromEntries(["pinned-section", "pinned-count", "pinned-threads", "group-by", "theme-toggle", "load-history", "threads", "search", "filters", "connection", "connection-text", "updated", "notice", "summary", "table", "empty", "empty-title", "empty-copy", "result-count", "group-order", "order-dialog", "order-list", "order-save", "order-cancel", "order-reset", "order-error", "mark-all-done", "all-done-dialog", "all-done-confirm", "all-done-cancel", "all-done-error"].map((id) => [id, new Element()]));
  for (const filter of ["active", "working", "waiting", "error", "idle", "later", "done", "open"]) {
    const button = new Element("button"); button.dataset.filter = filter; button.append(new Element("span")); elements.filters.append(button);
  }
  if (subscriptions) for (const id of ["subscriptions-cards", "subscription-quick", "subscriptions-notice", "subscriptions-refresh"]) elements[id] = new Element();
  const document = { documentElement: new Element("html"), getElementById: (id) => elements[id], createElement: (tag) => new Element(tag), hidden: false, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; } };
  let stream;
  class EventSource extends Element {
    constructor(url) { super(); this.url = url; stream = this; }
    close() { this.closed = true; }
    snapshot(rows, extra = {}) { this.fire("threads", { data: JSON.stringify({ rows, ...extra }) }); }
  }
  const requests = [], timers = [], timeoutDelays = [], browserListeners = {}, opened = [];
  const page = activityPage({ sessionId: "session", csrf, teamId });
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(page.html)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    document,
    fetch: (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); },
    EventSource, URL, Intl, Date, location: { origin: "https://gateway.example" },
    open: (...args) => { opened.push(args); }, matchMedia: () => ({ matches: prefersLight, addEventListener() {} }),
    setInterval: (fn) => { timers.push(fn); return 1; }, clearInterval() {}, setTimeout: (fn, delay) => { timers.push(fn); timeoutDelays.push(delay); return timers.length; }, clearTimeout() {}, addEventListener(type, handler) { browserListeners[type] = handler; },
  });
  return { elements, stream, requests, timers, timeoutDelays, page, document, browserListeners, opened };
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

test("Activity has one icon Slack button; Ctrl/⌘-click opens the same thread in the browser", () => {
  const { elements, stream, opened } = browser(() => new Promise(() => {}));
  stream.snapshot([row()]);
  const tr = elements.threads.children[0], title = tr.children[0].children[0];
  const links = tr.children[4].children[0].children;
  assert.equal(links.length, 1, "the separate browser button is gone");
  const [app] = links;
  assert.equal(title.target, "_self");
  assert.equal(app.target, "_self");
  assert.equal(app.textContent, "Open in Slack", "the icon keeps an accessible name");
  assert.equal(app.attrs["aria-label"], "Open in Slack: Fixture thread");
  assert.equal(app.href, title.href);
  let prevented = elements.threads.fire("click", { target: app });
  assert.equal(prevented, false, "a plain click opens Slack");
  assert.equal(opened.length, 0);
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    prevented = elements.threads.fire("click", { target: app, ...modifier });
    assert.equal(prevented, true);
    assert.deepEqual(opened.at(-1), [app.href + "?browser=1", "_blank", "noopener,noreferrer"]);
  }
  stream.snapshot([row("working", "Slack permalink", "https://team.slack.com/archives/C1/p11")]);
  const permalink = elements.threads.children[0].children[4].children[0].children[0];
  assert.equal(elements.threads.fire("click", { target: permalink, ctrlKey: true }), false, "a Slack permalink keeps the browser default");
  for (const url of ["slack://channel?team=attacker&id=C1", "javascript:alert(1)", "https://attacker.example/"]) {
    stream.snapshot([row("working", "unsafe", url)]);
    const anchor = elements.threads.children[0].children[4].children[0].children[0];
    assert.equal(anchor.href, undefined);
    assert.equal(elements.threads.fire("click", { target: anchor, ctrlKey: true }), false);
  }
  assert.equal(opened.length, 2);
});

test("the channel name opens the conversation in Slack; Ctrl/⌘-click opens it in the browser", () => {
  const { elements, stream, opened } = browser(() => new Promise(() => {}));
  stream.snapshot([row()]);
  const channel = () => elements.threads.children[0].children[1].children[0];
  assert.equal(channel().textContent, "Engineering");
  assert.equal(channel().href, "slack://channel?team=TWORK&id=C1");
  assert.equal(channel().target, "_self");
  assert.equal(channel().attrs["aria-label"], "Open Engineering in Slack");
  assert.equal(elements.threads.fire("click", { target: channel() }), false, "a plain click opens the Slack app");
  assert.equal(elements.threads.fire("click", { target: channel(), metaKey: true }), true);
  assert.deepEqual(opened.at(-1), ["https://app.slack.com/client/TWORK/C1", "_blank", "noopener,noreferrer"]);
  for (const channelId of ["C1&team=TEVIL", "javascript:alert(1)", "slack:C1", "c1", "", "googlechat:spaces/AAA"]) {
    stream.snapshot([{ ...row(), channelId }]);
    assert.equal(channel().href, undefined, channelId);
    assert.equal(channel().attrs["aria-disabled"], "true");
    assert.equal(elements.threads.fire("click", { target: channel(), ctrlKey: true }), false);
  }
  assert.equal(opened.length, 1);
  const noTeam = browser(() => new Promise(() => {}), "csrf", false, { teamId: "T1\"><script>" });
  noTeam.stream.snapshot([row()]);
  assert.equal(noTeam.elements.threads.children[0].children[1].children[0].href, undefined, "an invalid workspace id links nothing");
  assert.doesNotMatch(noTeam.page.html, /T1\\?"><script>/);
});

test("status groups are labelled on their first row, and running work shows a live clock", () => {
  const { elements, stream, timers } = browser(() => new Promise(() => {}));
  const now = Date.now();
  const rows = [
    { ...row("working", "run"), threadTs: "1", workingSinceMs: now - 252_000, lastMessageMs: now - 30_000 },
    { ...row("idle", "old"), threadTs: "2", lastMessageMs: now - 3 * 3_600_000 },
    { ...row("idle", "older"), threadTs: "3", lastMessageMs: now - 2 * 86_400_000 },
    { ...row("waiting", "ask"), threadTs: "4", workingSinceMs: now - 1000, lastMessageMs: now - 5 * 60_000 },
  ];
  stream.snapshot(rows);
  const trs = elements.threads.children;
  assert.deepEqual(trs.map((tr) => tr.children[0].textContent), ["ask", "run", "old", "older"]);
  assert.deepEqual(trs.map((tr) => tr.dataset.group), ["Waiting · 1", "Working · 1", "Idle · 2", undefined]);
  assert.deepEqual(trs.map((tr) => tr.className), ["row s-waiting", "row s-working", "row s-idle", "row s-idle"]);
  const pill = (tr) => tr.children[2].children[0];
  assert.match(pill(trs[1]).textContent, /^Working4m 1[23]s$/);
  assert.equal(pill(trs[0]).textContent, "Waiting", "only the agent's own running work carries a clock");
  assert.deepEqual(trs.map((tr) => tr.children[3].children[0].textContent), ["5m", "now", "3h", "2d"]);
  assert.equal(trs[1].children[3].children[0].attrs.title, undefined);
  for (const timer of timers) timer();
  assert.match(pill(trs[1]).textContent, /^Working4m 1[2-4]s$/);
  stream.snapshot([{ ...rows[0], status: "idle" }]);
  assert.equal(elements.threads.children[0].children[2].children[0].textContent, "Idle");
});

test("theme switch pins the opposite theme, returns to System when it matches the OS, and saves with CSRF", async () => {
  for (const prefersLight of [false, true]) {
    const { elements, requests, document } = browser(() => Promise.resolve(response({ rows: [] })), "fixture-csrf", false, { prefersLight });
    const button = elements["theme-toggle"], root = document.documentElement;
    const system = prefersLight ? "light" : "dark", other = prefersLight ? "dark" : "light";
    assert.equal(button.dataset.theme, system);
    assert.equal(button.attrs["aria-label"], `Switch to ${other} theme`);
    await button.listeners.click(); await flush();
    assert.equal(root.dataset.theme, other);
    assert.equal(button.attrs["aria-label"], `Switch to ${system} theme`);
    let save = requests.filter((r) => r.url.endsWith("/api/theme")).at(-1);
    assert.equal(save.options.headers["X-CG-CSRF"], "fixture-csrf");
    assert.deepEqual(JSON.parse(save.options.body), { theme: other });
    await button.listeners.click(); await flush();
    assert.equal(root.dataset.theme, undefined, "matching the OS follows the system again");
    save = requests.filter((r) => r.url.endsWith("/api/theme")).at(-1);
    assert.deepEqual(JSON.parse(save.options.body), { theme: "system" });
  }
});

test("page shows the agent name safely and pins only a saved explicit theme", () => {
  const hostile = activityPage({ sessionId: "s", csrf: "c", agent: '<img src=x onerror="alert(1)">Atlas' }).html;
  assert.match(hostile, /<span class="agent-name">&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;Atlas<\/span>/);
  assert.match(hostile, /<span class="agent-mark" aria-hidden="true"><svg viewBox="0 0 48 48"[^>]*><rect[^>]*fill="#ff642f"/, "the ChannelGate gate mark");
  assert.match(hostile, /<th scope="col">Actions<\/th>/);
  assert.match(activityPage({ sessionId: "s", csrf: "c" }).html, /agent-name">ChannelGate</);
  assert.match(activityPage({ sessionId: "s", csrf: "c", theme: "light" }).html, /<html lang="en" data-theme="light">/);
  assert.match(activityPage({ sessionId: "s", csrf: "c", theme: "dark" }).html, /<html lang="en" data-theme="dark">/);
  for (const theme of ["system", "blue\"><script>", undefined]) assert.match(activityPage({ sessionId: "s", csrf: "c", theme }).html, /<html lang="en">/);
});

test("activity browser filters locally and serializes each completion action with CSRF", async () => {
  const save = deferred();
  let done = false;
  const { elements, stream, requests } = browser((url) => url.endsWith("/completion") ? save.promise : Promise.resolve(response({ rows: [row(done ? "done" : "working")] })));
  await flush();
  const tr = elements.threads.children[0], toggle = tr.children[4].children[1].children[0];
  elements.search.value = "no match"; elements.search.fire("input");
  assert.equal(elements.threads.children.length, 0);
  elements.search.value = "engineering"; elements.search.fire("input");
  assert.equal(elements.threads.children.length, 1);
  const button = elements.threads.children[0].children[4].children[1].children[0];
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
  assert.equal(elements.threads.children[0].children[4].children[1].children[0].textContent, "Reopen");
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


test("Mark All Done describes its full scope, requires confirmation, and cancels without saving", async () => {
  const { elements, requests, page } = browser(async () => response({ rows: [row()] }));
  assert.equal(elements["mark-all-done"].disabled, true);
  await flush();
  assert.match(page.html, /aria-labelledby="all-done-title" aria-describedby="all-done-description"/);
  assert.match(page.html, /all your open tracked agent threads done across all channels/);
  assert.match(page.html, /outside the current filter, search, or page/);
  assert.match(page.html, /main Slack messages get ✅. Running work continues/);
  elements.search.value = "not visible"; elements.search.fire("input");
  assert.equal(elements.threads.children.length, 0);
  assert.equal(elements["mark-all-done"].disabled, false, "scope is independent of filtered visible rows");
  elements["all-done-confirm"].fire("click");
  elements["mark-all-done"].fire("click");
  assert.equal(elements["all-done-dialog"].open, true);
  assert.equal(elements["all-done-cancel"].focused, true);
  elements["all-done-cancel"].fire("click");
  assert.equal(elements["all-done-dialog"].open, false);
  elements["mark-all-done"].fire("click");
  assert.equal(elements["all-done-dialog"].fire("cancel"), false, "Escape closes an unsent confirmation");
  assert.equal(elements["all-done-dialog"].open, false);
  assert.equal(requests.filter((req) => req.url.endsWith("/completion-all")).length, 0);
});

test("Mark All Done sends once with CSRF, blocks row changes while saving, and reports server totals", async () => {
  const save = deferred();
  let saved = false;
  const { elements, requests, stream } = browser((url) => url.endsWith("/completion-all") ? save.promise
    : Promise.resolve(response({ rows: [row(saved ? "done" : "working")] })));
  await flush();
  const toggle = elements.threads.children[0].children[4].children[1].children[0];
  elements["mark-all-done"].fire("click");
  elements["all-done-confirm"].fire("click"); elements["all-done-confirm"].fire("click");
  elements.threads.fire("click", { target: toggle });
  assert.equal(elements["mark-all-done"].disabled, true);
  assert.equal(elements["all-done-confirm"].disabled, true);
  assert.equal(elements["all-done-cancel"].disabled, true);
  assert.equal(toggle.disabled, true);
  assert.equal(elements["all-done-dialog"].attrs["aria-busy"], "true");
  assert.equal(elements["all-done-dialog"].fire("cancel"), true, "Escape cannot hide an in-flight mutation");
  elements["all-done-cancel"].fire("click");
  assert.equal(elements["all-done-dialog"].open, true);
  const posts = requests.filter((req) => req.options?.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/activity/session/api/completion-all");
  assert.equal(posts[0].options.credentials, "same-origin");
  assert.equal(posts[0].options.headers["X-CG-CSRF"], "fixture-csrf");
  assert.deepEqual(JSON.parse(posts[0].options.body), { confirmed: true });
  saved = true; save.resolve(response({ marked: 351, skipped: 2, failed: 0 })); await flush();
  assert.equal(elements["all-done-dialog"].open, false);
  assert.equal(elements["all-done-confirm"].disabled, false);
  assert.equal(elements.threads.children.length, 0);
  assert.equal(elements.notice.textContent, "Marked 351 threads done. 2 skipped. 0 failed.");
  assert.equal(requests.filter((req) => req.url.endsWith("/threads")).length, 2);
  stream.fire("access-ended");
});

test("Mark All Done waits for pending row actions and allows a safe retry after partial failures", async () => {
  const save = deferred(); let bulkPosts = 0;
  const { elements, requests } = browser((url) => {
    if (url.endsWith("/completion")) return save.promise;
    if (url.endsWith("/completion-all")) { bulkPosts++; return Promise.resolve(response({ marked: 1, skipped: 3, failed: 2 })); }
    return Promise.resolve(response({ rows: [row()] }));
  });
  await flush();
  elements.threads.fire("click", { target: elements.threads.children[0].children[4].children[1].children[0] });
  assert.equal(elements["mark-all-done"].disabled, true);
  elements["mark-all-done"].fire("click");
  assert.notEqual(elements["all-done-dialog"].open, true);
  save.resolve(response({ ok: true })); await flush();
  elements["mark-all-done"].fire("click"); elements["all-done-confirm"].fire("click"); await flush();
  assert.match(elements.notice.textContent, /^Marked 1 thread done. 3 skipped. 2 failed./);
  assert.match(elements.notice.textContent, /retry Mark All Done/);
  assert.equal(elements["mark-all-done"].disabled, false);
  elements["mark-all-done"].fire("click"); elements["all-done-confirm"].fire("click"); await flush();
  assert.equal(bulkPosts, 2);
  assert.equal(requests.filter((req) => req.url.endsWith("/completion-all")).length, 2);
});

test("Mark All Done retains confirmation on transient or malformed results without exposing server details", async () => {
  for (const result of [response({ error: "private server detail" }, 500), response({ marked: -1, skipped: 0, failed: 0 })]) {
    let attempt = 0;
    const { elements } = browser((url) => url.endsWith("/completion-all")
      ? Promise.resolve(++attempt === 1 ? result : response({ marked: 0, skipped: 0, failed: 0 }))
      : Promise.resolve(response({ rows: [] })));
    await flush();
    elements["mark-all-done"].fire("click"); elements["all-done-confirm"].fire("click"); await flush();
    assert.equal(elements["all-done-dialog"].open, true);
    assert.match(elements["all-done-error"].textContent, /safely try again/);
    assert.ok(!elements["all-done-error"].textContent.includes("private server detail"));
    assert.equal(elements["all-done-confirm"].disabled, false);
    elements["all-done-confirm"].fire("click"); await flush();
    assert.equal(elements["all-done-dialog"].open, false);
    assert.equal(elements.notice.textContent, "Marked 0 threads done. 0 skipped. 0 failed.");
  }
});

test("Mark All Done authorization failures end access, and access loss rejects late bulk results", async () => {
  for (const status of [401, 403, "stream"]) {
    const save = deferred();
    const { elements, stream } = browser((url) => url.endsWith("/completion-all") ? save.promise
      : Promise.resolve(response({ rows: [row()] })));
    await flush();
    elements["mark-all-done"].fire("click"); elements["all-done-confirm"].fire("click");
    if (status === "stream") stream.fire("access-ended");
    save.resolve(response({ marked: 17, skipped: 0, failed: 0 }, status === "stream" ? 200 : status)); await flush();
    assert.equal(elements["all-done-dialog"].open, false);
    assert.equal(elements["mark-all-done"].disabled, true);
    assert.equal(elements["all-done-confirm"].disabled, true);
    assert.equal(elements["all-done-error"].textContent, "");
    assert.equal(elements.threads.children.length, 0);
    assert.match(elements.notice.textContent, /access has ended/);
    assert.ok(!elements.notice.textContent.includes("17"));
    assert.equal(stream.closed, true);
  }
});


test("browser history action is explicit, deduplicated, refreshes rows and preserves filters", async () => {
  const pending = deferred();
  const b = browser(async (url) => url.endsWith("/api/history") ? pending.promise : response({ rows: [row("idle")] }));
  await flush();
  const idle = b.elements.filters.children.find((item) => item.dataset.filter === "idle");
  b.elements.filters.fire("click", { target: idle });
  b.elements.search.value = "Fixture";
  const button = b.elements["load-history"];
  button.fire("click"); button.fire("click");
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Loading older threads…");
  assert.equal(b.requests.filter((r) => r.url.endsWith("/api/history")).length, 1);
  const req = b.requests.at(-1);
  assert.equal(req.options.method, "POST");
  assert.equal(req.options.headers["X-CG-CSRF"], "fixture-csrf");
  pending.resolve(response({ rows: [], history: { scanned: 100, moreHistory: true, unavailable: false } }));
  await flush();
  assert.equal(button.disabled, false);
  assert.equal(b.elements.search.value, "Fixture");
  assert.equal(idle.attrs["aria-pressed"], "true");
  assert.equal(b.elements.threads.children.length, 1, "fresh snapshot beats history response rows");
});

test("history exhaustion, retryable failure and session expiry have distinct browser states", async () => {
  for (const status of [200, 503, 401]) {
    const b = browser(async (url) => url.endsWith("/api/history")
      ? response({ history: { scanned: 0, moreHistory: false } }, status) : response({ rows: [row()] }));
    await flush();
    b.elements["load-history"].fire("click");
    await flush();
    assert.equal(b.elements["load-history"].disabled, status !== 503);
    if (status === 200) assert.equal(b.elements["load-history"].textContent, "History loaded");
    if (status === 503) assert.match(b.elements.notice.textContent, /try again/);
    if (status === 401) assert.equal(b.elements.threads.children.length, 0);
  }
});

const subscription = (name = "Codex EU") => ({ name, kind: "subscription", status: "ok", windows: [{ label: "Weekly", usedPercent: 24 }] });
test("Activity has compact subscription navigation without the removed heading or admin dependencies", () => {
  for (const view of ["activity", "subscriptions"]) {
    const { html } = activityPage({ sessionId: "session", csrf: "fixture", view });
    assert.match(html, /href="\/activity\/session\/subscriptions"/);
    assert.doesNotMatch(html, /<h1>My Activity|Your conversations, with the latest status|src="\/admin/);
    assert.match(html, /<title>(Activity|Subscriptions) · ChannelGate/);
    if (view === "subscriptions") assert.match(html, /id="activity-view" hidden/);
  }
});
test("Activity quotas poll only while visible and reject hidden or expired late replies", async () => {
  let next = deferred();
  const fixture = browser((url) => url.endsWith("/subscriptions") ? next.promise : Promise.resolve(response({ rows: [row()] })), "csrf", true);
  const { elements, document, stream, requests, timers, timeoutDelays } = fixture;
  await flush();
  next.resolve(response({ subscriptions: [subscription()] })); await flush();
  assert.match(elements["subscription-quick"].innerHTML, /Codex EU/);
  assert.match(elements["subscription-quick"].innerHTML, /24%/);
  assert.equal(elements["subscription-quick"].hidden, false);
  assert.equal(timeoutDelays.at(-1), 600_000, "subscription polling waits ten minutes");
  assert.equal(requests.filter((r) => r.url.endsWith("/subscriptions")).length, 1);
  next = deferred();
  timers.at(-1)(); await flush();
  document.hidden = true; document.listeners.visibilitychange();
  next.resolve(response({ subscriptions: [subscription("Hidden late response")] })); await flush();
  assert.doesNotMatch(elements["subscription-quick"].innerHTML, /Hidden late response/);
  next = deferred(); document.hidden = false; document.listeners.visibilitychange();
  stream.fire("access-ended");
  next.resolve(response({ subscriptions: [subscription("Expired late response")] })); await flush();
  assert.equal(elements["subscription-quick"].innerHTML, "");
  assert.equal(elements["subscriptions-cards"].innerHTML, "");
  assert.equal(elements.threads.children.length, 0);
});
test("Activity subscription authorization loss clears both quotas and private conversations", async () => {
  const { elements, stream } = browser((url) => Promise.resolve(url.endsWith("/subscriptions") ? response({}, 403) : response({ rows: [row()] })), "csrf", true);
  await flush();
  assert.equal(elements["subscription-quick"].innerHTML, "");
  assert.equal(elements.threads.children.length, 0);
  assert.equal(elements.search.disabled, true);
  assert.equal(stream.closed, true);
});

test("shared subscription UI excludes API, missing and unsupported harnesses from quick view", () => {
  const ui = createSubscriptionUi();
  const rows = [subscription(), { name: "API fixture", kind: "api-key", status: "api-key", windows: [] }, { name: "Not connected fixture", kind: "none", status: "not-connected", windows: [] }, { name: "Unsupported fixture", kind: "unsupported", status: "unsupported", windows: [] }];
  const quick = ui.summary(rows);
  assert.match(quick, /Codex EU/);
  assert.match(quick, /<progress max="100" value="24"/, "a short usage line for wide windows");
  assert.match(quick, /<circle class="ring-value" cx="10" cy="10" r="7.5" pathLength="100" stroke-dasharray="24 100"\/>/, "a ring for narrow windows");
  assert.doesNotMatch(quick, /style=/, "no inline style: the page CSP is nonce-only");
  assert.match(ui.summary([{ ...subscription(), windows: [{ label: "Weekly", usedPercent: 96 }] }]), /subscription-quick critical/);
  assert.match(ui.summary([{ ...subscription(), windows: [] , status: "ok" }]), /subscription-quick unavailable[^>]*>.*<strong>—<\/strong>/);
  assert.doesNotMatch(quick, /API fixture|Not connected fixture|Unsupported fixture/);
  const card = ui.card({ ...subscription(), resetCredits: { available: 2, resets: [{ label: "Full reset", expiresAt: "2099-01-01T00:00:00Z", remaining: 2, paused: true }] }, expiresAt: "2099-02-01T00:00:00Z" });
  assert.match(card, /2 remaining/);
  assert.match(card, /Full reset \(2 remaining\) \(paused\) expires in/);
  assert.match(card, /Subscription expires in/);
  assert.doesNotMatch(ui.card(subscription()), /Subscription expires/);
  const missing = ui.card({ ...subscription(), resetCredits: { available: 1, resets: [{ label: "Banked credit", remaining: 1, usableNow: false }] } });
  assert.match(missing, /1 remaining/);
  assert.match(missing, /Banked credit \(when limit reached\) · expiry unavailable/);
});

test("Activity pagehide stops late requests from restarting quota polling", async () => {
  const quota = deferred();
  const { browserListeners, requests, elements } = browser((url) => url.endsWith("/subscriptions") ? quota.promise : Promise.resolve(response({ rows: [] })), "csrf", true);
  const before = requests.length;
  browserListeners.pagehide();
  quota.resolve(response({ subscriptions: [subscription()] })); await flush();
  assert.equal(requests.length, before);
  assert.equal(elements["subscription-quick"].innerHTML, undefined);
});


test("Later hides postponed work from Active, retains it in All open, and serializes Delay/Resume", async () => {
  let status = "working";
  const save = deferred();
  const b = browser((url) => url.endsWith("/later") ? save.promise : Promise.resolve(response({ rows: [row(status)] })));
  await flush();
  const delay = b.elements.threads.children[0].children[4].children[1].children[1];
  assert.equal(delay.textContent, "Later");
  assert.equal(delay.dataset.state, "later");
  b.elements.threads.fire("click", { target: delay });
  b.elements.threads.fire("click", { target: delay });
  assert.equal(delay.disabled, true);
  const posts = b.requests.filter((r) => r.url.endsWith("/later"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].options.headers["X-CG-CSRF"], "fixture-csrf");
  assert.deepEqual(JSON.parse(posts[0].options.body), { channelId: "C1", threadTs: "1.1", later: true });
  status = "later"; save.resolve(response({ ok: true })); await flush();
  assert.equal(b.elements.threads.children.length, 0);
  assert.match(b.elements.summary.textContent, /0 active · 1 later/);
  const select = (filter) => b.elements.filters.fire("click", { target: b.elements.filters.children.find((t) => t.dataset.filter === filter) });
  select("later");
  const resume = b.elements.threads.children[0].children[4].children[1].children[1];
  assert.equal(resume.textContent, "Resume");
  assert.equal(resume.dataset.state, "resume");
  b.elements.threads.fire("click", { target: resume }); await flush();
  assert.deepEqual(JSON.parse(b.requests.filter((r) => r.url.endsWith("/later")).at(-1).options.body), { channelId: "C1", threadTs: "1.1", later: false });
  select("open"); assert.equal(b.elements.threads.children.length, 1);
  b.stream.fire("access-ended");
  b.elements.threads.fire("click", { target: resume });
  assert.equal(b.requests.filter((r) => r.url.endsWith("/later")).length, 2);
});

test("Activity text stays legible: WCAG AA contrast for secondary text and visible row bands in both themes", () => {
  const { html } = activityPage({ sessionId: "s", csrf: "c" });
  const block = (marker) => html.slice(html.indexOf(marker)).split("}")[0];
  const themes = { dark: block(":root{color-scheme:dark"), light: block("color-scheme:light") };
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [name, css] of Object.entries(themes)) {
    const token = (key) => css.match(new RegExp(`--${key}:([^;]+);`))?.[1];
    const alpha = (key) => Number(token(key).match(/,\s*([.\d]+)\)$/)[1]);
    for (const surface of ["bg", "panel", "panel-2"]) {
      for (const text of ["ink-2", "muted", "faint", "s-idle"]) {
        assert.ok(contrast(token(text), token(surface)) >= 4.5, `${name}: --${text} on --${surface} is ${contrast(token(text), token(surface)).toFixed(2)}:1`);
      }
    }
    assert.ok(alpha("band") >= (name === "dark" ? 0.05 : 0.035), `${name}: alternate rows are visibly banded`);
    assert.ok(alpha("hover") > alpha("band"), `${name}: hover stays stronger than the band`);
  }
  assert.doesNotMatch(html, /\.s-idle \.thread-title/, "idle titles use the full text colour");
  assert.match(html, /\.channel-cell\{[^}]*color:var\(--muted\)/);
  assert.match(html, /th\{[^}]*color:var\(--muted\)/);
});

test("channel grouping keeps channel ids distinct, sorts within channels and filters group counts", async () => {
  const { elements, stream, requests } = browser((url, options) => url.endsWith("/group-by")
    ? Promise.resolve(response({ groupBy: JSON.parse(options.body).groupBy, groupByVersion: 1 })) : new Promise(() => {}));
  const rows = [
    { ...row("idle", "beta idle"), channelId: "C2", channelName: "Beta", threadTs: "1" },
    { ...row("working", "alpha run"), channelId: "C1", channelName: "Alpha", threadTs: "2" },
    { ...row("error", "beta error"), channelId: "C2", channelName: "Beta", threadTs: "3" },
    { ...row("idle", "alpha old"), channelId: "C1", channelName: "Alpha", threadTs: "4", lastMessageMs: 100 },
    { ...row("idle", "alpha new"), channelId: "C1", channelName: "Alpha", threadTs: "5" },
    { ...row("waiting", "duplicate name"), channelId: "C3", channelName: "Alpha", threadTs: "6" },
    { ...row("done", "completed"), channelId: "C1", channelName: "Alpha", threadTs: "7" },
  ];
  const titles = () => elements.threads.children.map((tr) => tr.children[0].textContent);
  const groups = () => elements.threads.children.map((tr) => tr.dataset.group);
  stream.snapshot(rows);
  assert.equal(elements["group-by"].value, "status");
  elements["group-by"].value = "channel"; elements["group-by"].fire("change"); await flush();
  assert.deepEqual(titles(), ["alpha run", "alpha new", "alpha old", "duplicate name", "beta error", "beta idle"]);
  assert.deepEqual(groups(), ["Alpha · 3", undefined, undefined, "Alpha · 1", "Beta · 2", undefined]);
  assert.equal(requests.at(-1).options.headers["X-CG-CSRF"], "fixture-csrf");
  stream.snapshot(rows, { groupBy: "status", groupByVersion: 0, groupOrder: ["idle", "error", "waiting", "working"], groupOrderVersion: 1 });
  assert.equal(elements["group-by"].value, "channel", "stale preference cannot undo a save");
  assert.deepEqual(titles().slice(0, 3), ["alpha new", "alpha old", "alpha run"]);
  elements.search.value = "beta"; elements.search.fire("input");
  assert.deepEqual(titles(), ["beta idle", "beta error"]);
  assert.deepEqual(groups(), ["Beta · 2", undefined]);
  elements.search.value = ""; elements.search.fire("input");
  elements.filters.fire("click", { target: elements.filters.children.find((b) => b.dataset.filter === "done") });
  assert.deepEqual(titles(), ["completed"]); assert.deepEqual(groups(), ["Alpha · 1"]);
  stream.snapshot(rows, { groupBy: "status", groupByVersion: 2 });
  assert.deepEqual(groups(), ["Done · 1"]);
  stream.fire("access-ended"); assert.equal(elements["group-by"].disabled, true);
});

test("failed grouping save restores the view, serializes writes and safely labels hostile channel names", async () => {
  const save = deferred();
  const { elements, stream, requests } = browser((url) => url.endsWith("/group-by") ? save.promise : new Promise(() => {}));
  stream.snapshot([row()]);
  elements["group-by"].value = "channel"; elements["group-by"].fire("change"); elements["group-by"].fire("change");
  assert.equal(elements["group-by"].disabled, true);
  assert.equal(requests.filter((r) => r.url.endsWith("/group-by")).length, 1);
  save.resolve(response({}, 500)); await flush();
  assert.equal(elements["group-by"].value, "status"); assert.equal(elements["group-by"].disabled, false);
  assert.match(elements.notice.textContent, /grouping couldn’t be saved/);
  const name = '<img src=x onerror="alert(1)">';
  stream.snapshot([{ ...row(), channelName: name }], { groupBy: "channel", groupByVersion: 1 });
  assert.equal(elements.threads.children[0].dataset.group, name + " · 1");
  assert.equal(elements.threads.children[0].children.length, 5);
});

test("pins move rows to a matching top table, survive status tabs, filter by search and clear on access loss", () => {
  const b = browser(() => new Promise(() => {})), e = b.elements;
  assert.equal(e["pinned-section"].hidden, true);
  const pinned = { ...row("done", "Saved task"), pinned: true };
  const ordinary = { ...row("idle", "Regular task"), threadTs: "2.2" };
  b.stream.snapshot([pinned, ordinary]);
  const tr = e["pinned-threads"].children[0];
  assert.equal(e["pinned-section"].hidden, false);
  assert.equal(e["pinned-count"].textContent, "1");
  assert.equal(e.threads.children.length, 1);
  assert.equal(tr.dataset.group, undefined);
  assert.equal(e.threads.children[0].dataset.group, "Idle · 1");
  const pin = tr.children[4].children[1].children[2];
  assert.equal(pin.textContent, "Unpin"); assert.equal(pin.attrs["aria-pressed"], "true");
  e.filters.fire("click", { target: e.filters.children.find((button) => button.dataset.filter === "working") });
  assert.equal(e["pinned-threads"].children[0], tr);
  assert.equal(e.table.hidden, true);
  e.search.value = "Regular"; e.search.fire("input");
  assert.equal(e["pinned-section"].hidden, true);
  e.search.value = ""; e.search.fire("input");
  b.stream.snapshot([{ ...pinned, status: "later" }, ordinary], { groupBy: "channel", groupByVersion: 1 });
  assert.equal(e["pinned-threads"].children.length, 1);
  b.stream.fire("access-ended");
  assert.equal(e["pinned-section"].hidden, true);
  assert.equal(e["pinned-threads"].children.length, 0);
  assert.equal(e.threads.children.length, 0);
  b.stream.snapshot([pinned]); assert.equal(e["pinned-threads"].children.length, 0);
});

test("pin and unpin serialize CSRF writes, reuse rows and preserve controls in the pinned table", async () => {
  let pinned = false;
  const save = deferred(); let changes = 0;
  const b = browser(async (url, options) => {
    if (url.endsWith("/pin")) {
      changes++; if (changes === 1) await save.promise;
      pinned = JSON.parse(options.body).pinned;
      return response({ ok: true });
    }
    if (url.endsWith("/threads")) return response({ rows: [{ ...row("idle"), pinned }] });
    return response({ ok: true });
  });
  await flush();
  const tr = b.elements.threads.children[0], pin = tr.children[4].children[1].children[2];
  b.elements.threads.fire("click", { target: pin });
  b.elements.threads.fire("click", { target: pin });
  assert.equal(changes, 1); assert.equal(pin.disabled, true);
  const request = b.requests.find((r) => r.url.endsWith("/pin"));
  assert.equal(request.options.headers["X-CG-CSRF"], "fixture-csrf");
  assert.deepEqual(JSON.parse(request.options.body), { channelId: "C1", threadTs: "1.1", pinned: true });
  save.resolve(); await flush();
  assert.equal(b.elements["pinned-threads"].children[0], tr);
  assert.equal(b.elements.threads.children.length, 0);
  const done = tr.children[4].children[1].children[0];
  b.elements["pinned-threads"].fire("click", { target: done }); await flush();
  assert.ok(b.requests.some((r) => r.url.endsWith("/completion")));
  b.elements["pinned-threads"].fire("click", { target: pin }); await flush();
  assert.equal(b.elements.threads.children[0], tr);
  assert.equal(b.elements["pinned-section"].hidden, true);
  assert.equal(pin.attrs["aria-pressed"], "false");
  assert.deepEqual(JSON.parse(b.requests.filter((r) => r.url.endsWith("/pin")).at(-1).options.body), { channelId: "C1", threadTs: "1.1", pinned: false });
});

test("failed pin save leaves rows in place and access denial clears both tables", async () => {
  let status = 503;
  const b = browser(async (url) => url.endsWith("/pin") ? response({}, status) : response({ rows: [row("idle")] }));
  await flush();
  const pin = b.elements.threads.children[0].children[4].children[1].children[2];
  b.elements.threads.fire("click", { target: pin }); await flush();
  assert.equal(b.elements["pinned-section"].hidden, true);
  assert.equal(pin.disabled, false);
  assert.match(b.elements.notice.textContent, /couldn’t be saved/);
  status = 403;
  b.elements.threads.fire("click", { target: pin }); await flush();
  assert.equal(b.elements.threads.children.length, 0);
  assert.equal(b.elements["pinned-section"].hidden, true);
});

test("channel grouping groups multi-channel pins separately with filtered counts and stable row controls", () => {
  const b = browser(() => new Promise(() => {})), e = b.elements;
  const pinned = [
    { ...row("idle", "Beta pinned"), pinned: true, channelId: "C2", channelName: "Beta", threadTs: "2", lastMessageMs: 300 },
    { ...row("idle", "Alpha idle pinned"), pinned: true, channelId: "C1", channelName: "Alpha", threadTs: "3", lastMessageMs: 200 },
    { ...row("error", "Alpha error pinned"), pinned: true, channelId: "C1", channelName: "Alpha", threadTs: "4", lastMessageMs: 100 },
    { ...row("waiting", "Same name pinned"), pinned: true, channelId: "C3", channelName: "Alpha", threadTs: "5", lastMessageMs: 50 },
  ];
  const ordinary = { ...row("idle", "Alpha regular"), threadTs: "6", channelName: "Alpha" };
  const titles = () => e["pinned-threads"].children.map((tr) => tr.children[0].textContent);
  const groups = () => e["pinned-threads"].children.map((tr) => tr.dataset.group);
  b.stream.snapshot([...pinned, ordinary]);
  const originalNodes = new Set(e["pinned-threads"].children);
  assert.deepEqual(titles(), ["Beta pinned", "Alpha idle pinned", "Alpha error pinned", "Same name pinned"]);
  assert.deepEqual(groups(), [undefined, undefined, undefined, undefined]);
  b.stream.snapshot([...pinned, ordinary], { groupBy: "channel", groupByVersion: 1 });
  assert.equal(e["pinned-threads"].dataset.groupBy, "channel");
  assert.deepEqual(titles(), ["Alpha error pinned", "Alpha idle pinned", "Same name pinned", "Beta pinned"]);
  assert.deepEqual(groups(), ["Alpha · 2", undefined, "Alpha · 1", "Beta · 1"]);
  assert.equal(e.threads.children[0].dataset.group, "Alpha · 1", "regular counts exclude pins");
  assert.ok(e["pinned-threads"].children.every((tr) => originalNodes.has(tr)), "grouping reuses existing row controls");
  e.search.value = "pinned"; e.search.fire("input");
  assert.deepEqual(groups(), ["Alpha · 2", undefined, "Alpha · 1", "Beta · 1"]);
  e.search.value = "Alpha"; e.search.fire("input");
  assert.deepEqual(groups(), ["Alpha · 2", undefined, "Alpha · 1"], "same-named channel ids stay distinct");
  e.search.value = "Beta"; e.search.fire("input");
  assert.deepEqual(groups(), [undefined], "one visible channel needs no extra heading");
  e.search.value = ""; e.search.fire("input");
  b.stream.snapshot([{ ...pinned[0], pinned: false }, ...pinned.slice(1), ordinary], { groupBy: "channel", groupByVersion: 1 });
  assert.deepEqual(groups(), ["Alpha · 2", undefined, "Alpha · 1"]);
  assert.equal(e["pinned-count"].textContent, "3");
  b.stream.snapshot(pinned, { groupBy: "status", groupByVersion: 2 });
  assert.deepEqual(titles(), ["Beta pinned", "Alpha idle pinned", "Alpha error pinned", "Same name pinned"]);
  assert.deepEqual(groups(), [undefined, undefined, undefined, undefined], "switching back removes pinned channel headings");
});
