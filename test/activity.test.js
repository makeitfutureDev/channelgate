import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { request as httpRequest } from "node:http";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { setUser, getUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { indexSlackThread, indexSlackFork, getSlackThread, recordSlackThreadParticipation, setSlackThreadHidden, setSlackThreadLater, setSlackThreadDone, recordSlackThreadOutcome } = await import("../src/gateway/slack-threads.js");
const { registerAgentInterfaceHandlers } = await import("../src/slack/agent-interface.js");
const { setThreadSudo } = await import("../src/gateway/thread-engine.js");
const { activityThreadSnapshot } = await import("../src/slack/home-threads.js");
const { recordActiveRun, clearActiveRun } = await import("../src/gateway/active-runs.js");
const { activityHomeActions } = await import("../src/slack/home-activity.js");
const { handleReplyDashboardAction, registerReplyDashboardActions, REPLY_DASHBOARD_ACTION_ID } = await import("../src/slack/reply-dashboard.js");
const { menuButtons } = await import("../src/slack/footer.js");
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests, forgetActivitySessionCacheForTests, ACTIVITY_GRANT_TTL_MS, ACTIVITY_SESSION_TTL_MS } = await import("../src/web/activity.js");

beforeEach(async () => {
  resetActivityStateForTests();
  for (const table of ["platform_thread_messages", "platform_thread_participants", "platform_threads", "slack_threads", "sessions", "channels", "channel_meta", "active_runs", "bg_jobs", "question_requests", "approval_requests", "followup_threads", "followup_done", "thread_overrides"]) getDb().exec(`DELETE FROM ${table}`);
  await setUser("U_MINE", { approved: true, isAdmin: false, activityPinnedThreads: [], activityPinnedChannels: [], activityIdentities: [] });
  await setUser("U_OTHER", { approved: true, isAdmin: false, activityPinnedThreads: [], activityPinnedChannels: [], activityIdentities: [] });
});

test("reply Dashboard privately launches the clicker's Activity from owned, foreign and automation replies", async (t) => {
  const f = await fixture(t);
  await f.root("C_WORK", "100.000001", "U_MINE");
  await f.root("C_WORK", "100.000002", "U_OTHER");
  const sent = [];
  f.client.chat.postEphemeral = async (payload) => { sent.push(payload); };
  f.client.chat.postMessage = async () => assert.fail("a launch credential must never be public");
  let previousUrl;
  for (const owner of ["U_MINE", "U_OTHER", ""]) {
    const buttons = menuButtons({ channel: "C_WORK", threadTs: "100.000002", authorId: owner });
    const button = buttons.at(-1);
    assert.equal(button.action_id, REPLY_DASHBOARD_ACTION_ID);
    assert.equal(buttons.at(-2).text.text, "⚙️ Settings");
    assert.equal(button.url, undefined);
    assert.doesNotMatch(JSON.stringify(buttons), /\/activity\/open#/);
    let acknowledged = false;
    await handleReplyDashboardAction({ ack: async () => { acknowledged = true; }, client: f.client,
      body: { user: { id: "U_MINE" }, channel: { id: "C_WORK" }, team: { id: "T_WORK" } },
      action: button }, { teamId: "T_WORK", baseUrl: f.base });
    assert.equal(acknowledged, true);
    const post = sent.at(-1);
    assert.equal(post.user, "U_MINE"); assert.equal(post.channel, "C_WORK");
    assert.equal(post.thread_ts, "100.000002");
    const url = post.blocks[1].elements[0].url;
    const notice = `This link expires in 10 minutes.\n<${url}|Activity link>`;
    assert.equal(post.text, notice);
    assert.equal(post.blocks[0].text.text, notice);
    assert.doesNotMatch(JSON.stringify(post), /only once|just once|one.use|single.use/i);
    assert.notEqual(url, previousUrl); previousUrl = url;
    const response = await f.exchange(url);
    assert.equal(response.status, 200);
    assert.equal((await f.exchange(url)).status, 200);
    const { url: sessionUrl } = await response.json();
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const snapshot = await f.request(sessionUrl + "/api/threads", { headers: { cookie } });
    assert.equal(snapshot.status, 200);
    assert.deepEqual((await snapshot.json()).rows.map((r) => r.threadTs), ["100.000001"]);
    assert.equal((await f.request("/activity", { headers: { cookie } })).status, 401);
  }
});

test("reply Dashboard refuses revoked, inaccessible, malformed and misconfigured launches privately", async (t) => {
  const f = await fixture(t);
  const entry = await f.root("G_PRIVATE", "100.000001", "U_MINE", true, "private");
  f.members.set("G_PRIVATE", ["U_MINE"]);
  const sent = [];
  f.client.chat.postEphemeral = async (payload) => { sent.push(payload); };
  for (const variant of ["revoked", "membership", "channel-access", "channel", "workspace", "missing-workspace", "malformed", "url"]) {
    await setUser("U_MINE", { approved: variant !== "revoked" });
    f.members.set("G_PRIVATE", variant === "membership" ? [] : ["U_MINE"]);
    await saveChannelMeta(entry.slug, { access: variant === "channel-access" ? "admins" : "approved" });
    const button = menuButtons({ channel: variant === "channel" ? "C_OTHER" : "G_PRIVATE" }).at(-1);
    if (variant === "malformed") button.value = "{";
    await handleReplyDashboardAction({ ack: async () => {}, client: f.client,
      body: { user: { id: "U_MINE" }, channel: { id: "G_PRIVATE" }, team: { id: variant === "workspace" ? "T_OTHER" : "T_WORK" } },
      action: button }, { teamId: variant === "missing-workspace" ? "" : "T_WORK", baseUrl: variant === "url" ? "" : f.base });
    assert.equal(sent.at(-1).user, "U_MINE", variant);
    assert.equal(sent.at(-1).blocks, undefined, variant);
    assert.doesNotMatch(JSON.stringify(sent.at(-1)), /\/activity\/open#/, variant);
  }
  assert.match(sent.at(-1).text, /Public URL/);
});

test("reply Dashboard and private URL actions are registered and acknowledged", async () => {
  const handlers = new Map();
  registerReplyDashboardActions({ action: (id, handler) => handlers.set(id, handler) }, { teamId: "T_WORK" });
  assert.equal(typeof handlers.get(REPLY_DASHBOARD_ACTION_ID), "function");
  let acknowledged = false;
  await handlers.get("cg_reply_dashboard_open")({ ack: async () => { acknowledged = true; } });
  assert.equal(acknowledged, true);
});
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  let currentTime = Date.now(), team = "T_WORK", connected = true, base;
  const roots = new Map(), members = new Map(), reads = [];
  const markerCalls = [];
  const client = { auth: { test: async () => ({ user_id: "B_GATEWAY" }) }, reactions: {
    add: async (args) => { markerCalls.push(["add", args]); return { ok: true }; },
    remove: async (args) => { markerCalls.push(["remove", args]); return { ok: true }; },
  }, conversations: {
    replies: async ({ channel, ts }) => { reads.push("replies"); return { messages: [roots.get(`${channel}:${ts}`)].filter(Boolean) }; },
    members: async ({ channel }) => { reads.push("members"); return { members: members.get(channel) || [] }; },
  }, chat: { getPermalink: async ({ channel, message_ts }) => { reads.push("link"); return { permalink: `https://example.slack.com/archives/${channel}/p${message_ts.replace(".", "")}` }; } } };
  const app = express();
  app.use("/activity", createActivityRouter({ getClient: () => connected ? client : null, getTeamId: () => team,
    getBaseUrl: () => base, now: () => currentTime, pollMs: 20, accessRefreshMs: 40, ...options }));
  app.get("/activity", (_req, res) => res.status(401).send("administrator login"));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { resetActivityStateForTests(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const request = (url, init = {}) => fetch(base + url, { ...init, redirect: "manual" });
  const grant = (ownerId = "U_MINE", teamId = "T_WORK") => createActivityGrantUrl({ baseUrl: base, ownerId, teamId, now: currentTime });
  const exchange = (url = grant(), init = {}) => request("/activity/exchange", { method: "POST", headers: { Origin: base, "Content-Type": "application/json", ...init.headers }, body: JSON.stringify({ token: new URL(url).hash.slice(1), ...init.body }) });
  const login = async (ownerId = "U_MINE", launchUrl = grant(ownerId)) => {
    const response = await exchange(launchUrl);
    assert.equal(response.status, 200);
    const { url } = await response.json(), cookie = response.headers.get("set-cookie").split(";")[0];
    const page = await request(url, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text(), csrf = /"csrf":"([A-Za-z0-9_-]+)"/.exec(html)?.[1];
    assert.ok(csrf);
    return { url, cookie, csrf, html, headers: { cookie }, post: { cookie, Origin: base, "Content-Type": "application/json", "X-CG-CSRF": csrf } };
  };
  const root = async (id = "C_WORK", ts = "100.000001", owner = "U_MINE", engaged = true, type = "channel") => {
    await upsertChannelEntry(id, { name: `#${id}`, type, isDM: type === "im" });
    const entry = await getChannelEntry(id);
    await saveChannelMeta(entry.slug, { access: "approved", isDM: type === "im" });
    const message = { ts, user: owner, text: `Build ${ts}` };
    roots.set(`${id}:${ts}`, message);
    indexSlackThread({ channelId: id, slug: entry.slug, root: message, agentEngaged: engaged });
    return entry;
  };
  return { base, client, markerCalls, request, grant, exchange, login, root, roots, members, reads,
    advance: (ms) => { currentTime += ms; }, setTeam: (value) => { team = value; }, disconnect: () => { connected = false; } };
}
async function nextEvent(reader, event = "threads") {
  let buffer = "", timedOut = false;
  const timer = setTimeout(() => { timedOut = true; reader.cancel(); }, 2500);
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error(timedOut ? `no ${event} event within 2.5 s` : `SSE ended before ${event}`);
      buffer += decoder.decode(value, { stream: true });
      for (const frame of buffer.split("\n\n").slice(0, -1)) {
        if (frame.includes(`event: ${event}\n`)) return JSON.parse(frame.split("data: ")[1]);
      }
      const consumed = buffer.lastIndexOf("\n\n"); // A frame may span several chunks: keep the partial tail intact.
      if (consumed >= 0) buffer = buffer.slice(consumed + 2);
    }
  } finally { clearTimeout(timer); }
}

test("Activity exposes completion time across REST, live snapshots and explicit reopen cycles", async (t) => {
  const f = await fixture(t); await f.root();
  const mine = await f.login();
  const snapshot = async () => (await (await f.request(mine.url + "/api/threads", { headers: mine.headers })).json()).rows[0];
  assert.equal((await snapshot()).completedMs, 0);
  const first = Date.now();
  setSlackThreadDone("C_WORK", "100.000001", "U_MINE", true, first);
  assert.equal((await snapshot()).completedMs, first);
  const response = await f.request(mine.url + "/stream", { headers: mine.headers });
  const reader = response.body.getReader(); t.after(() => reader.cancel());
  assert.equal((await nextEvent(reader)).rows[0].completedMs, first);
  recordSlackThreadOutcome("C_WORK", "100.000001", { error: true });
  assert.equal((await snapshot()).completedMs, first, "later agent activity preserves completion time");
  setSlackThreadDone("C_WORK", "100.000001", "U_MINE", false, first + 100);
  assert.equal((await snapshot()).completedMs, 0);
  setSlackThreadDone("C_WORK", "100.000001", "U_MINE", true, first + 200);
  assert.equal((await snapshot()).completedMs, first + 200);
  getDb().prepare("UPDATE slack_threads SET done_ms=0,root_done=1,root_reaction_ms=? WHERE channel_id='C_WORK'").run(first + 300);
  assert.equal((await snapshot()).completedMs, first + 300, "reaction completions carry their observed timestamp");
});

test("Activity group order persists per viewer across sessions and streams without changing authority", async (t) => {
  const f = await fixture(t);
  const mine = await f.login(), other = await f.login("U_OTHER");
  const endpoint = mine.url + "/api/group-order";
  const defaults = ["error", "waiting", "working", "idle"], custom = ["idle", "working", "error", "waiting"];
  const snapshot = async (user) => (await f.request(user.url + "/api/threads", { headers: user.headers })).json();
  assert.deepEqual((await snapshot(mine)).groupOrder, defaults);
  const original = await getUser("U_MINE");
  const result = await f.request(endpoint, { method: "POST", headers: mine.post,
    body: JSON.stringify({ groupOrder: custom, ownerId: "U_OTHER", approved: false, isAdmin: true }) });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).groupOrder, custom);
  assert.deepEqual(await getUser("U_MINE"), { ...original, activityGroupOrder: custom, activityGroupOrderVersion: 1 });
  assert.deepEqual((await snapshot(other)).groupOrder, defaults);
  assert.deepEqual((await snapshot(await f.login())).groupOrder, custom);
  const stream = await f.request(mine.url + "/stream", { headers: mine.headers });
  const reader = stream.body.getReader(); t.after(() => reader.cancel());
  assert.deepEqual((await nextEvent(reader)).groupOrder, custom);
  assert.equal((await f.request(endpoint, { method: "POST", headers: mine.post, body: JSON.stringify({ groupOrder: defaults }) })).status, 200);
  assert.deepEqual((await nextEvent(reader)).groupOrder, defaults);
});

test("Activity group order rejects malformed orders, unauthenticated writes, CSRF and revoked admission", async (t) => {
  const f = await fixture(t), mine = await f.login();
  const originalOrder = (await getUser("U_MINE")).activityGroupOrder;
  const endpoint = mine.url + "/api/group-order", order = ["idle", "working", "waiting", "error"];
  for (const groupOrder of [null, "error", [], ["error", "waiting", "idle"], ["error", "error", "waiting", "idle"], ["error", "waiting", "working", "done"], [...order, "idle"]]) {
    assert.equal((await f.request(endpoint, { method: "POST", headers: mine.post, body: JSON.stringify({ groupOrder }) })).status, 400);
  }
  const body = JSON.stringify({ groupOrder: order });
  assert.equal((await f.request(endpoint, { method: "POST", headers: { ...mine.post, cookie: "" }, body })).status, 401);
  assert.equal((await f.request(endpoint, { method: "POST", headers: { ...mine.post, "X-CG-CSRF": "invalid" }, body })).status, 403);
  assert.equal((await f.request(endpoint, { method: "POST", headers: { ...mine.post, Origin: "https://other.example" }, body })).status, 403);
  assert.deepEqual((await getUser("U_MINE")).activityGroupOrder, originalOrder);
  await setUser("U_MINE", { approved: false, isAdmin: false });
  assert.equal((await f.request(endpoint, { method: "POST", headers: mine.post, body })).status, 403);
  assert.deepEqual((await getUser("U_MINE")).activityGroupOrder, originalOrder);
});

test("Activity theme preference is the viewer's own, CSRF-protected and rendered before paint", async (t) => {
  const f = await fixture(t), mine = await f.login(), other = await f.login("U_OTHER");
  assert.doesNotMatch(mine.html, /<html lang="en" data-theme=/, "system preference pins nothing");
  const endpoint = mine.url + "/api/theme";
  for (const theme of [null, "", "blue", ["dark"], "DARK"]) {
    assert.equal((await f.request(endpoint, { method: "POST", headers: mine.post, body: JSON.stringify({ theme }) })).status, 400);
  }
  const body = JSON.stringify({ theme: "light", ownerId: "U_OTHER", isAdmin: true });
  assert.equal((await f.request(endpoint, { method: "POST", headers: { ...mine.post, "X-CG-CSRF": "invalid" }, body })).status, 403);
  assert.equal((await f.request(endpoint, { method: "POST", headers: { ...mine.post, Origin: "https://other.example" }, body })).status, 403);
  assert.equal((await f.request(endpoint, { method: "POST", headers: { ...mine.post, cookie: "" }, body })).status, 401);
  const original = await getUser("U_MINE");
  const saved = await f.request(endpoint, { method: "POST", headers: mine.post, body });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { theme: "light" });
  assert.deepEqual(await getUser("U_MINE"), { ...original, activityTheme: "light" });
  assert.equal((await getUser("U_OTHER")).activityTheme, undefined);
  assert.match(await (await f.request(mine.url, { headers: mine.headers })).text(), /<html lang="en" data-theme="light">/);
  assert.doesNotMatch(await (await f.request(other.url, { headers: other.headers })).text(), /data-theme="light"/);
  assert.equal((await f.request(endpoint, { method: "POST", headers: mine.post, body: JSON.stringify({ theme: "system" }) })).status, 200);
  assert.doesNotMatch(await (await f.request(mine.url, { headers: mine.headers })).text(), /<html lang="en" data-theme=/);
});

test("Activity shows the bot's Slack display name, escaped, cached, and never blocks the page", async (t) => {
  let calls = 0, name = "Xavier <b>";
  const f = await fixture(t, { getBotIdentity: () => ({ userId: "B_GATEWAY", handle: "xavier" }) });
  f.client.users = { info: async ({ user }) => { calls++; assert.equal(user, "B_GATEWAY"); return { user: { profile: { display_name: name } } }; } };
  const first = await f.login();
  assert.match(first.html, /<span class="agent-name">Xavier &lt;b&gt;<\/span>/);
  assert.doesNotMatch(first.html, /Xavier <b>/);
  name = "Renamed"; await f.login();
  assert.equal(calls, 1, "the profile lookup is cached");
  f.advance(61 * 60_000);
  assert.match((await f.login()).html, /agent-name">Renamed</);
  f.client.users.info = async () => { throw new Error("rate limited"); };
  f.advance(61 * 60_000);
  assert.match((await f.login()).html, /agent-name">xavier</, "a failed lookup falls back to the bot handle");
});

test("Activity reports when a working thread started so the browser can show its running time", async (t) => {
  const f = await fixture(t);
  await f.root("C_WORK", "100.000001"); await f.root("C_WORK", "200.000001");
  const db = getDb();
  db.prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("run-a", JSON.stringify({ channelId: "C_WORK", threadKey: "100.000001", startedAt: 1_700_000_000_000 }));
  db.prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("run-b", JSON.stringify({ channelId: "C_WORK", threadKey: "100.000001", startedAt: 1_700_000_050_000 }));
  db.prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run("run-c", JSON.stringify({ channelId: "C_WORK", threadKey: "200.000001", awaitingChoice: true, startedAt: 1_700_000_000_000 }));
  t.after(() => db.prepare("DELETE FROM active_runs WHERE id IN ('run-a','run-b','run-c')").run());
  const mine = await f.login();
  const rows = (await (await f.request(mine.url + "/api/threads", { headers: mine.headers })).json()).rows;
  const byTs = Object.fromEntries(rows.map((row) => [row.threadTs, row]));
  assert.equal(byTs["100.000001"].status, "working");
  assert.equal(byTs["100.000001"].workingSinceMs, 1_700_000_000_000, "the earliest accepted turn starts the clock");
  assert.equal(byTs["200.000001"].status, "waiting");
  assert.equal(byTs["200.000001"].workingSinceMs, undefined, "waiting on a person carries no running clock");
});

test("optional queued-message controls preserve Working, its clock and real blockers", async (t) => {
  const f = await fixture(t);
  const threadKey = "100.000001", startedAt = 1_700_000_000_000;
  await f.root("C_WORK", threadKey);
  const { busyThreadChoices } = await import("../src/slack/busy-thread-choice.js");
  const { createQuestion, updateQuestion } = await import("../src/gateway/questions.js");
  const { createApprovalRequest, transitionApprovalRequest } = await import("../src/gateway/approval-requests.js");
  const context = { channelId: "C_WORK", threadKey, authorId: "U_MINE" };
  // Use the production card store: these records carry awaitingChoice despite being optional.
  const card = busyThreadChoices.create({ event: { channel: "C_WORK", thread_ts: threadKey, user: "U_MINE" }, queuedRunId: "queued" });
  t.after(() => busyThreadChoices.discard(card));
  recordActiveRun("running", { ...context, startedAt });
  recordActiveRun("queued", { ...context, startedAt: startedAt + 1000 });
  const mine = await f.login();
  const snapshot = async () => (await (await f.request(mine.url + "/api/threads", { headers: mine.headers })).json()).rows[0];
  assert.equal((await snapshot()).status, "working");
  assert.equal((await snapshot()).workingSinceMs, startedAt);
  clearActiveRun("running");
  assert.equal((await snapshot()).status, "working", "an accepted queued turn runs without a button click");
  assert.equal((await snapshot()).workingSinceMs, startedAt + 1000);
  const question = createQuestion(context, { title: "Required decision", questions: [{ id: "next", prompt: "What next?", type: "text" }] });
  assert.equal((await snapshot()).status, "waiting");
  assert.equal((await snapshot()).workingSinceMs, undefined);
  updateQuestion(question.id, question.revision, { status: "cancelled" });
  assert.equal((await snapshot()).status, "working");
  const approval = createApprovalRequest({ id: "queue-approval", actionKey: "queue-approval", channelId: "C_WORK", action: context });
  assert.equal((await snapshot()).status, "waiting");
  transitionApprovalRequest(approval.id, "pending", "denied");
  assert.equal((await snapshot()).status, "working");
  clearActiveRun("queued");
  assert.equal((await snapshot()).status, "idle", "a leftover optional card cannot keep a thread waiting or working");
  assert.equal((await snapshot()).workingSinceMs, undefined);
});

test("launch fragment is removed before reusable exchange; cookies, origin and expiry fail closed", async (t) => {
  const f = await fixture(t), url = f.grant();
  assert.ok(new URL(url).hash);
  const launch = await f.request("/activity/open");
  assert.equal(launch.status, 200);
  assert.equal(launch.headers.get("referrer-policy"), "no-referrer");
  const html = await launch.text(), script = /<script nonce="[^"]+">([\s\S]+?)<\/script>/.exec(html)[1];
  assert.doesNotMatch(html, /already used/i);
  const calls = [];
  await new Function("globalThis", `return ${script}`)({
    location: { hash: new URL(url).hash, pathname: "/activity/open", replace: (value) => calls.push(value) },
    history: { replaceState: () => calls.push("cleared") },
    fetch: async (path, init) => { assert.equal(calls[0], "cleared"); calls.push(path); return f.request(path, { ...init, headers: { ...init.headers, Origin: f.base } }); },
    document: { getElementById: (id) => id === "status" ? { textContent: "" } : null, querySelectorAll: () => [] },
    ChannelGatePasskeys: { available: () => true, errorMessage: error => error.message },
  });
  assert.match(calls.at(-1), /^\/activity\/[A-Za-z0-9_-]{16}$/);
  assert.equal((await f.exchange(url)).status, 200);
  const sessionPath = calls.at(-1);
  assert.equal((await f.request(sessionPath, { headers: { cookie: "cg_admin=forged" } })).status, 401);
  const fresh = f.grant();
  assert.equal((await f.exchange(fresh, { headers: { Origin: "https://evil.example" } })).status, 403);
  const responses = await Promise.all([f.exchange(fresh), f.exchange(fresh)]);
  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  const sessionUrls = await Promise.all(responses.map((r) => r.clone().json()));
  assert.notEqual(sessionUrls[0].url, sessionUrls[1].url, "each launch has its own browser session");
  const cookie = responses.find((r) => r.status === 200).headers.get("set-cookie");
  assert.match(cookie, /HttpOnly; SameSite=Lax; Path=\/activity\/[A-Za-z0-9_-]{16}; Max-Age=43200/);
  const expired = f.grant(); f.advance(ACTIVITY_GRANT_TTL_MS + 1);
  assert.equal((await f.exchange(expired)).status, 410);
  assert.equal(createActivityGrantUrl({ baseUrl: "http://public.example", ownerId: "U_MINE", teamId: "T_WORK" }), "");
});

test("reusing a launch near expiry does not extend its original ten-minute lifetime", async (t) => {
  assert.equal(ACTIVITY_GRANT_TTL_MS, 10 * 60_000);
  const f = await fixture(t), grant = f.grant();
  assert.equal((await f.exchange(grant)).status, 200);
  f.advance(ACTIVITY_GRANT_TTL_MS - 1);
  const last = await f.exchange(grant);
  assert.equal(last.status, 200);
  const { url } = await last.json(), cookie = last.headers.get("set-cookie").split(";")[0];
  f.advance(1);
  const expired = await f.exchange(grant);
  assert.equal(expired.status, 410);
  assert.equal(expired.headers.get("set-cookie"), null);
  assert.equal((await f.request(url, { headers: { cookie } })).status, 200,
    "an existing browser session retains its independent session lifetime");
});

test("sessions survive a gateway restart: rows persist, only the cookie secret's hash is stored, expiry still applies", async (t) => {
  const f = await fixture(t); await f.root();
  const user = await f.login("U_MINE");
  const row = getDb().prepare("SELECT * FROM activity_sessions WHERE owner_id = ?").get("U_MINE");
  assert.ok(row, "the session is a row");
  assert.equal(row.credential_id, ""); assert.equal(row.cookie_hash.length, 64);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(user.cookie.split("=")[1]), "the secret itself is never stored");
  forgetActivitySessionCacheForTests();
  assert.equal((await f.request(user.url + "/api/threads", { headers: user.headers })).status, 200, "a restart does not sign the person out");
  const stream = await f.request(user.url + "/stream", { headers: user.headers });
  assert.equal(stream.status, 200); await stream.body.cancel();
  f.advance(ACTIVITY_SESSION_TTL_MS + 1);
  forgetActivitySessionCacheForTests();
  assert.equal((await f.request(user.url + "/api/threads", { headers: user.headers })).status, 401, "a persisted session still expires");
  const second = await f.login("U_MINE");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM activity_sessions WHERE owner_id = ? AND expires_at > ?").get("U_MINE", 0).n >= 1, true);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM activity_sessions WHERE id = ?").get(user.url.split("/").pop()).n, 0, "the expired row is pruned on the next issue");
  assert.equal((await f.request(second.url + "/api/threads", { headers: second.headers })).status, 200);
});

test("opened dashboards load, refresh, reconnect and write for twelve hours without extending their deadline", async (t) => {
  assert.equal(ACTIVITY_SESSION_TTL_MS, 12 * 60 * 60_000);
  const f = await fixture(t); await f.root();
  const grant = f.grant(), user = await f.login("U_MINE", grant);
  f.advance(ACTIVITY_GRANT_TTL_MS);
  assert.equal((await f.exchange(grant)).status, 410, "launch expires after its original ten minutes");

  const afterOneHour = 60 * 60_000 + 1;
  f.advance(afterOneHour - ACTIVITY_GRANT_TTL_MS);
  for (const suffix of ["", "/api/threads"]) {
    const response = await f.request(user.url + suffix, { headers: user.headers });
    assert.equal(response.status, 200, "opened dashboard remains usable beyond one hour");
    assert.equal(response.headers.get("set-cookie"), null, "refresh does not renew the cookie");
  }
  const firstStream = await f.request(user.url + "/stream", { headers: user.headers });
  assert.equal(firstStream.status, 200);
  const firstReader = firstStream.body.getReader();
  t.after(() => firstReader.cancel());
  assert.equal((await nextEvent(firstReader)).rows.length, 1);
  await firstReader.cancel();

  f.advance(ACTIVITY_SESSION_TTL_MS - 1 - afterOneHour);
  for (const suffix of ["", "/api/threads"]) {
    assert.equal((await f.request(user.url + suffix, { headers: user.headers })).status, 200,
      "session is usable until the millisecond before twelve hours");
  }
  const completion = user.url + "/api/completion";
  const body = (done) => JSON.stringify({ channelId: "C_WORK", threadTs: "100.000001", done });
  assert.equal((await f.request(completion, { method: "POST", headers: user.post, body: body(true) })).status, 200);
  const reconnect = await f.request(user.url + "/stream", { headers: user.headers });
  assert.equal(reconnect.status, 200);
  const reader = reconnect.body.getReader();
  t.after(() => reader.cancel());
  assert.equal((await nextEvent(reader)).rows[0].status, "done");

  f.advance(1);
  await nextEvent(reader, "access-ended");
  assert.equal((await reader.read()).done, true);
  for (const suffix of ["", "/api/threads", "/stream"]) {
    assert.equal((await f.request(user.url + suffix, { headers: user.headers })).status, 401,
      "reads and SSE reconnects cannot extend the original twelve-hour deadline");
  }
  assert.equal((await f.request(completion, { method: "POST", headers: user.post, body: body(false) })).status, 401);
  assert.ok(getSlackThread("C_WORK", "100.000001").done_ms > 0, "expired session cannot write");
});

test("a launch that expires while authorization awaits cannot mint another session", async (t) => {
  let expireDuringAuthorization = false;
  const f = await fixture(t, { getTeamId: () => {
    // authorize() awaits the user lookup before checking the live workspace.
    if (expireDuringAuthorization) f.advance(1);
    return "T_WORK";
  } });
  const grant = f.grant();
  assert.equal((await f.exchange(grant)).status, 200);
  f.advance(ACTIVITY_GRANT_TTL_MS - 1);
  expireDuringAuthorization = true;
  const response = await f.exchange(grant);
  assert.equal(response.status, 410);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("a launch evicted while authorization awaits cannot mint another session", async (t) => {
  let evictDuringAuthorization = false;
  const f = await fixture(t, { getTeamId: () => {
    if (evictDuringAuthorization) for (let i = 0; i < 20; i++) f.grant();
    return "T_WORK";
  } });
  const grant = f.grant();
  assert.equal((await f.exchange(grant)).status, 200);
  evictDuringAuthorization = true;
  const response = await f.exchange(grant);
  assert.equal(response.status, 410);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("user revocation while launch authorization awaits cannot mint a browser session", async (t) => {
  let revokeDuringAuthorization = false, revoked;
  const f = await fixture(t, { getTeamId: () => {
    // The prior user lookup has already resolved; its approved snapshot is now stale.
    if (revokeDuringAuthorization) revoked = setUser("U_MINE", { approved: false });
    return "T_WORK";
  } });
  const grant = f.grant();
  assert.equal((await f.exchange(grant)).status, 200);
  revokeDuringAuthorization = true;
  const response = await f.exchange(grant);
  await revoked;
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("each reuse checks user revocation, workspace and Slack connectivity", async (t) => {
  const f = await fixture(t), grant = f.grant();
  assert.equal((await f.exchange(grant)).status, 200);
  await setUser("U_MINE", { approved: false });
  const revoked = await f.exchange(grant);
  assert.equal(revoked.status, 403); assert.equal(revoked.headers.get("set-cookie"), null);
  await setUser("U_MINE", { approved: true });
  assert.equal((await f.exchange(grant)).status, 200);
  f.setTeam("T_OTHER");
  assert.equal((await f.exchange(grant)).status, 403);
  f.setTeam("T_WORK");
  assert.equal((await f.exchange(grant)).status, 200);
  f.disconnect();
  assert.equal((await f.exchange(grant)).status, 403);
});

test("repeated launches preserve the per-owner browser-session cap", async (t) => {
  const f = await fixture(t), grant = f.grant(), launches = [];
  for (let i = 0; i < 11; i++) {
    const response = await f.exchange(grant);
    assert.equal(response.status, 200);
    launches.push({ ...(await response.json()), cookie: response.headers.get("set-cookie").split(";")[0] });
  }
  assert.equal(new Set(launches.map((row) => row.url)).size, 11);
  for (const [i, row] of launches.entries()) {
    assert.equal((await f.request(row.url, { headers: { cookie: row.cookie } })).status, i === 0 ? 401 : 200);
  }
});

test("administrator Activity retains its own auth while private paths enforce Host and secure cookie scope", async (t) => {
  const f = await fixture(t, { getBaseUrl: () => "https://dashboard.example" });
  assert.equal((await f.request("/activity")).status, 401);
  assert.equal((await f.request("/activity/open")).status, 403);
  const grant = createActivityGrantUrl({ baseUrl: "https://dashboard.example", ownerId: "U_MINE", teamId: "T_WORK" });
  // Raw HTTP preserves a deliberate Host override; fetch derives Host from its target URL.
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(f.base + "/activity/exchange", { method: "POST", headers: { Host: "dashboard.example", Origin: "https://dashboard.example", "Content-Type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res)); });
    req.on("error", reject); req.end(JSON.stringify({ token: new URL(grant).hash.slice(1) }));
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["set-cookie"][0], /; Secure$/);
  assert.equal((await f.request("/activity/exchange", { method: "POST", headers: { Host: "evil.example", Origin: "https://dashboard.example", "Content-Type": "application/json" }, body: JSON.stringify({ token: new URL(grant).hash.slice(1) }) })).status, 403);
});

test("private Home button and REST expose only the viewer's eligible threads with real-link resolution on click", async (t) => {
  const f = await fixture(t);
  const blocks = activityHomeActions({ ownerId: "U_MINE", teamId: "T_WORK", baseUrl: f.base, approved: true });
  assert.equal(blocks[0].text.text, "Open live dashboard");
  assert.equal(activityHomeActions({ ownerId: "U_MINE", teamId: "T_WORK", baseUrl: f.base, approved: false }).length, 0);
  await f.root(); await f.root("C_HUMAN", "101.000001", "U_MINE", false);
  await f.root("C_OTHER", "102.000001", "U_OTHER");
  const user = await f.login(), other = await f.login("U_OTHER");
  f.reads.length = 0;
  const response = await f.request(user.url + "/api/threads?ownerId=U_OTHER", { headers: user.headers });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].channelId, "C_WORK");
  assert.deepEqual(f.reads, [], "refresh uses local state without transcript/permalink Slack reads");
  assert.equal((await f.request(user.url + "/api/threads", { headers: other.headers })).status, 401);
  const open = await f.request(data.rows[0].url, { headers: user.headers });
  assert.equal(open.status, 303); assert.match(open.headers.get("location"), /^slack:\/\/channel\?/);
  assert.equal((await f.request(user.url + "/open/C_OTHER/102.000001", { headers: user.headers })).status, 403);
  assert.match(user.html, /<table/);
  f.setTeam("T_DIFFERENT");
  assert.equal((await f.request(user.url + "/api/threads", { headers: user.headers })).status, 403);
});

test("Open thread targets Slack app at the newest exact reply on each click with a browser alternative", async (t) => {
  const f = await fixture(t); await f.root();
  const user = await f.login(), root = f.roots.get("C_WORK:100.000001");
  const url = user.url + "/open/C_WORK/100.000001", calls = [];
  const originalRead = f.client.conversations.replies;
  f.client.conversations.replies = async (args) => { calls.push(args); return originalRead(args); };
  // The locally indexed date remains the root's date; exact live metadata must win.
  root.reply_count = 800; root.latest_reply = "1794471234.123456";
  const linkCalls = [];
  f.client.chat.getPermalink = async (args) => {
    linkCalls.push(args);
    return { permalink: `https://example.slack.com/archives/C_WORK/p${args.message_ts.replace(".", "")}?thread_ts=100.000001&cid=C_WORK` };
  };
  for (const latest of ["1794471234.123456", "1794471234.123457"]) {
    root.latest_reply = latest;
    const response = await f.request(url, { headers: user.headers });
    assert.equal(response.status, 303);
    const target = new URL(response.headers.get("location"));
    assert.equal(target.protocol, "slack:");
    assert.equal(target.hostname, "channel");
    assert.equal(target.searchParams.get("team"), "T_WORK");
    assert.equal(target.searchParams.get("message"), latest);
    assert.equal(target.searchParams.get("thread_ts"), root.ts);
    assert.equal(target.searchParams.get("id"), "C_WORK");
    assert.deepEqual(linkCalls.at(-1), { channel: "C_WORK", message_ts: latest });
  }
  assert.deepEqual(calls, Array(2).fill({ channel: "C_WORK", ts: root.ts, limit: 1 }), "one root lookup per click even with hundreds of replies");
  delete root.latest_reply; root.reply_count = 0;
  const response = await f.request(url, { headers: user.headers });
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get("location"));
  assert.equal(target.searchParams.get("message"), root.ts);
  assert.equal(target.searchParams.get("thread_ts"), root.ts, "empty thread still opens its conversation pane");
  const web = await f.request(url + "?browser=1", { headers: user.headers });
  assert.equal(web.status, 303);
  const browserTarget = new URL(web.headers.get("location"));
  assert.equal(browserTarget.protocol, "https:");
  assert.equal(browserTarget.hostname, "example.slack.com");
  assert.equal(browserTarget.pathname, "/archives/C_WORK/p100000001");
  assert.equal(browserTarget.searchParams.get("thread_ts"), root.ts);
  assert.equal(browserTarget.searchParams.get("cid"), "C_WORK");
  await setUser("U_MINE", { approved: false });
  for (const suffix of ["", "?browser=1"]) {
    const denied = await f.request(url + suffix, { headers: user.headers });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("location"), null);
  }
});

test("Open thread refuses missing roots, changed owners, invalid latest metadata and foreign threads", async (t) => {
  const f = await fixture(t); await f.root();
  const user = await f.login(), path = user.url + "/open/C_WORK/100.000001";
  const original = { ...f.roots.get("C_WORK:100.000001") };
  const variants = [null, { ...original, user: "U_OTHER" }, { ...original, bot_id: "B_OTHER" },
    { ...original, latest_reply: "bad" }, { ...original, latest_reply: "99.000001" }];
  for (const root of variants) {
    f.roots.set("C_WORK:100.000001", root);
    const response = await f.request(path, { headers: user.headers });
    assert.ok([403, 503].includes(response.status));
    assert.equal(response.headers.get("location"), null);
  }
  assert.equal(f.reads.includes("link"), false);
  f.roots.set("C_WORK:100.000001", original);
  await f.root("C_OTHER", "101.000001", "U_OTHER");
  const before = f.reads.length;
  assert.equal((await f.request(user.url + "/open/C_OTHER/101.000001", { headers: user.headers })).status, 403);
  assert.equal(f.reads.length, before, "foreign thread denied before Slack reads");
});

test("Open thread paginates to the latest reply when optional latest_reply metadata is absent", async (t) => {
  const f = await fixture(t); await f.root();
  const user = await f.login(), root = { ...f.roots.get("C_WORK:100.000001"), reply_count: 3 }, calls = [];
  f.client.conversations.replies = async (args) => {
    calls.push(args);
    if (args.limit === 1) return { messages: [root] };
    if (!args.cursor) return { messages: [root, { ts: "101.123456", thread_ts: root.ts }], has_more: true, response_metadata: { next_cursor: "next" } };
    assert.equal(args.cursor, "next");
    return { messages: [{ ts: "102.123456", thread_ts: root.ts }, { ts: "102.123457", thread_ts: root.ts }], has_more: false };
  };
  const response = await f.request(user.url + "/open/C_WORK/100.000001", { headers: user.headers });
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get("location"));
  assert.equal(target.searchParams.get("message"), "102.123457");
  assert.equal(target.searchParams.get("thread_ts"), root.ts);
  assert.deepEqual(calls.map((args) => [args.limit, args.cursor]), [[1, undefined], [100, undefined], [100, "next"]]);
});

test("Open thread never redirects from incomplete, repeated or failed reply pagination", async (t) => {
  const f = await fixture(t); await f.root();
  const user = await f.login(), root = { ...f.roots.get("C_WORK:100.000001"), reply_count: 3 };
  for (const failedPage of [
    { messages: [root], has_more: true },
    { messages: [root], response_metadata: { next_cursor: "repeat" } },
    { ok: false, error: "ratelimited" },
    { messages: [] },
    { messages: [{ ts: "101.000001", thread_ts: "999.000001" }] },
  ]) {
    f.client.conversations.replies = async ({ limit }) => limit === 1 ? { messages: [root] } : failedPage;
    const response = await f.request(user.url + "/open/C_WORK/100.000001", { headers: user.headers });
    assert.notEqual(response.status, 303);
    assert.equal(response.headers.get("location"), null);
  }
});

test("Open thread rechecks private membership after a delayed latest-reply lookup", async (t) => {
  const f = await fixture(t); await f.root("G_PRIVATE", "100.000001", "U_MINE", true, "group");
  f.members.set("G_PRIVATE", ["U_MINE"]);
  const user = await f.login(), gate = defer(), started = defer();
  f.client.conversations.replies = async () => {
    started.resolve(); await gate.promise;
    return { messages: [{ ts: "100.000001", user: "U_MINE", latest_reply: "101.123456", reply_count: 1 }] };
  };
  const pending = f.request(user.url + "/open/G_PRIVATE/100.000001", { headers: user.headers });
  await started.promise; f.members.set("G_PRIVATE", []); gate.resolve();
  const response = await pending;
  assert.equal(response.status, 403); assert.equal(response.headers.get("location"), null);
});

test("Done requires CSRF and fresh root ownership and shares persistent completion with Slack", async (t) => {
  const f = await fixture(t); await f.root(); await f.root("C_OTHER", "101.000001", "U_OTHER");
  const user = await f.login(), path = user.url + "/api/completion";
  const body = JSON.stringify({ channelId: "C_WORK", threadTs: "100.000001", done: true });
  assert.equal((await f.request(path, { method: "POST", headers: { ...user.post, "X-CG-CSRF": "wrong" }, body })).status, 403);
  assert.equal(getSlackThread("C_WORK", "100.000001").done_ms, 0);
  assert.equal((await f.request(path, { method: "POST", headers: user.post, body })).status, 200);
  assert.ok(getSlackThread("C_WORK", "100.000001").done_ms > 0);
  assert.equal(getDb().prepare("SELECT count(*) n FROM followup_done WHERE user_id='U_MINE'").get().n, 1);
  const reopen = JSON.stringify({ channelId: "C_WORK", threadTs: "100.000001", done: false });
  assert.equal((await f.request(path, { method: "POST", headers: user.post, body: reopen })).status, 200);
  assert.ok(getSlackThread("C_WORK", "100.000001").done_ms < 0);
  assert.deepEqual(f.markerCalls, ["add", "remove"].map((method) => [method, {
    channel: "C_WORK", timestamp: "100.000001", name: "white_check_mark",
  }]));
  const foreign = JSON.stringify({ channelId: "C_OTHER", threadTs: "101.000001", done: true, ownerId: "U_OTHER" });
  assert.equal((await f.request(path, { method: "POST", headers: user.post, body: foreign })).status, 403);
  f.roots.set("C_WORK:100.000001", { ts: "100.000001", user: "U_OTHER" });
  assert.equal((await f.request(path, { method: "POST", headers: user.post, body })).status, 403);
});

test("Done answers once the decision is saved, without waiting for the Slack ✅ reaction", async (t) => {
  const f = await fixture(t); await f.root();
  const user = await f.login(), slack = defer(), started = defer();
  f.client.reactions.add = async (args) => { started.resolve(); await slack.promise; f.markerCalls.push(["add", args]); return { ok: true }; };
  const response = await f.request(user.url + "/api/completion", { method: "POST", headers: user.post,
    body: JSON.stringify({ channelId: "C_WORK", threadTs: "100.000001", done: true }) });
  assert.equal(response.status, 200, "the reply does not wait on a slow reactions.add");
  assert.ok(getSlackThread("C_WORK", "100.000001").done_ms > 0, "completion is durable before the reaction");
  await started.promise; assert.equal(f.markerCalls.length, 0);
  slack.resolve();
  for (let i = 0; i < 20 && !f.markerCalls.length; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.markerCalls.map(([method]) => method), ["add"], "the ✅ still lands afterwards");
});

test("private membership and sudo access are rechecked after delayed completion or permalink reads", async (t) => {
  const f = await fixture(t); const entry = await f.root("G_PRIVATE", "100.000001", "U_MINE", true, "group");
  f.members.set("G_PRIVATE", ["U_MINE"]);
  const user = await f.login(), parked = defer(), started = defer();
  f.client.conversations.replies = async () => { started.resolve(); await parked.promise; return { messages: [f.roots.get("G_PRIVATE:100.000001")] }; };
  const change = f.request(user.url + "/api/completion", { method: "POST", headers: user.post, body: JSON.stringify({ channelId: "G_PRIVATE", threadTs: "100.000001", done: true }) });
  await started.promise; f.members.set("G_PRIVATE", []); parked.resolve();
  assert.equal((await change).status, 403);
  assert.equal(getSlackThread("G_PRIVATE", "100.000001").done_ms, 0);
  f.members.set("G_PRIVATE", ["U_MINE"]); await setUser("U_MINE", { isAdmin: true });
  await setThreadSudo(entry.slug, "100.000001", true);
  const linkGate = defer(), linkStarted = defer();
  f.client.chat.getPermalink = async () => { linkStarted.resolve(); await linkGate.promise; return { permalink: "https://example.slack.com/archives/G_PRIVATE/p100000001" }; };
  const open = f.request(user.url + "/open/G_PRIVATE/100.000001", { headers: user.headers });
  await linkStarted.promise; await setUser("U_MINE", { isAdmin: false }); linkGate.resolve();
  assert.equal((await open).status, 403);
});

test("REST refuses a snapshot if channel authority changes while membership reads await", async (t) => {
  const gate = defer(), started = defer();
  const f = await fixture(t, { snapshot: async (...args) => { const data = await activityThreadSnapshot(...args); started.resolve(); await gate.promise; return data; } });
  const entry = await f.root(); const user = await f.login();
  const pending = f.request(user.url + "/api/threads", { headers: user.headers });
  await started.promise; await saveChannelMeta(entry.slug, { access: "none" }); gate.resolve();
  const response = await pending;
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /Build 100/);
});

test("revocation during the final membership recheck cannot race a completion write", async (t) => {
  const f = await fixture(t); const entry = await f.root("G_PRIVATE", "100.000001", "U_MINE", true, "group");
  const user = await f.login(), gate = defer(), started = defer(); let lookups = 0;
  f.client.conversations.members = async () => {
    if (++lookups === 2) { started.resolve(); await gate.promise; }
    return { members: ["U_MINE"] };
  };
  const pending = f.request(user.url + "/api/completion", { method: "POST", headers: user.post, body: JSON.stringify({ channelId: "G_PRIVATE", threadTs: "100.000001", done: true }) });
  await started.promise; await saveChannelMeta(entry.slug, { access: "none" }); gate.resolve();
  assert.equal((await pending).status, 403);
  assert.equal(getSlackThread("G_PRIVATE", "100.000001").done_ms, 0);
});

test("SSE publishes local status and completion changes, bounds connections, and ends on session expiry", async (t) => {
  const f = await fixture(t, { maxStreams: 1 }); await f.root();
  const user = await f.login(); f.reads.length = 0;
  const response = await f.request(user.url + "/stream", { headers: user.headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get("x-accel-buffering"), "no");
  const reader = response.body.getReader(); t.after(() => reader.cancel());
  assert.equal((await nextEvent(reader)).rows[0].status, "idle");
  assert.equal((await f.request(user.url + "/stream", { headers: user.headers })).status, 429);
  recordSlackThreadOutcome("C_WORK", "100.000001", { error: true });
  assert.equal((await nextEvent(reader)).rows[0].status, "error");
  setSlackThreadDone("C_WORK", "100.000001", "U_MINE", true);
  assert.equal((await nextEvent(reader)).rows[0].status, "done");
  assert.deepEqual(f.reads, []);
  f.advance(ACTIVITY_SESSION_TTL_MS + 1);
  await nextEvent(reader, "access-ended");
  assert.equal((await reader.read()).done, true);
  assert.equal((await f.request(user.url + "/api/threads", { headers: user.headers })).status, 401);
});

for (const engine of ["claude", "codex"]) {
  test(`${engine} durable run events preserve shared Done until explicit Reopen without polling`, async (t) => {
    const f = await fixture(t, { pollMs: 60_000, accessRefreshMs: 60_000 });
    const entry = await f.root();
    setSlackThreadDone("C_WORK", "100.000001", "U_MINE", true);
    const doneAt = getSlackThread("C_WORK", "100.000001").done_ms;
    const user = await f.login(); f.reads.length = 0;
    const response = await f.request(user.url + "/stream", { headers: user.headers });
    const reader = response.body.getReader(); t.after(() => reader.cancel());
    assert.equal((await nextEvent(reader)).rows[0].status, "done");
    const run = { channelId: "C_WORK", slug: entry.slug, authorId: "U_OTHER", engine,
      threadKey: "100.000001", slackThreadTs: "100.000001" };
    recordActiveRun("activity-live", run);
    assert.equal((await nextEvent(reader)).rows[0].status, "done");
    recordActiveRun("activity-live", { ...run, awaitingChoice: true });
    assert.equal((await nextEvent(reader)).rows[0].status, "done");
    clearActiveRun("activity-live");
    assert.equal((await nextEvent(reader)).rows[0].status, "done");
    assert.equal(getSlackThread("C_WORK", "100.000001").done_ms, doneAt);
    setSlackThreadDone("C_WORK", "100.000001", "U_MINE", false);
    assert.equal((await nextEvent(reader)).rows[0].status, "idle");
    recordActiveRun("activity-live", run);
    assert.equal((await nextEvent(reader)).rows[0].status, "working");
    recordActiveRun("activity-live", { ...run, awaitingChoice: true });
    assert.equal((await nextEvent(reader)).rows[0].status, "waiting");
    clearActiveRun("activity-live");
    assert.equal((await nextEvent(reader)).rows[0].status, "idle");
    assert.deepEqual(f.reads, []);
  });
}

test("accepted run event discovers its missing human root before queue ownership", async (t) => {
  const f = await fixture(t, { pollMs: 60_000, accessRefreshMs: 60_000 });
  const entry = await f.root();
  getDb().exec("DELETE FROM slack_threads");
  const user = await f.login();
  const response = await f.request(user.url + "/stream", { headers: user.headers });
  const reader = response.body.getReader(); t.after(() => reader.cancel());
  assert.equal((await nextEvent(reader)).rows.length, 0);
  recordActiveRun("not-indexed", { channelId: "C_WORK", slug: entry.slug,
    authorId: "U_OTHER", threadKey: "100.000001" });
  assert.equal((await nextEvent(reader)).rows[0].status, "working");
  assert.equal(getSlackThread("C_WORK", "100.000001").starter_id, "U_MINE");
  clearActiveRun("not-indexed");
});

test("SSE keeps a healthy connection open while a large snapshot drains instead of reconnecting every retry", async (t) => {
  // A snapshot above the socket's high-water mark makes res.write() return false even when the
  // browser is reading fine; closing there made the page cycle Reconnecting/Live every 2 s.
  const rows = Array.from({ length: 400 }, (_, i) => ({ channel_id: "C_WORK", thread_ts: `100.${String(i).padStart(6, "0")}`,
    title: "T".repeat(500), channelName: "#C_WORK", status: "idle", last_message_ms: 1 }));
  let snapshots = 0;
  const f = await fixture(t, { pollMs: 20, accessRefreshMs: 40, snapshot: async () => { snapshots++; return { rows, total: rows.length }; } });
  const user = await f.login();
  const response = await f.request(user.url + "/stream", { headers: user.headers });
  const reader = response.body.getReader(); t.after(() => reader.cancel());
  const first = await nextEvent(reader);
  assert.equal(first.rows.length, 400);
  assert.ok(JSON.stringify(first).length > 128 * 1024, "the fixture must exceed any default high-water mark");
  f.advance(100);
  const second = await nextEvent(reader);
  assert.equal(second.rows.length, 400);
  assert.ok(snapshots >= 2);
});

test("SSE removes revoked private access and rejects admission after user disable or Slack disconnect", async (t) => {
  const f = await fixture(t); await f.root("G_PRIVATE", "100.000001", "U_MINE", true, "group");
  f.members.set("G_PRIVATE", ["U_MINE"]);
  const user = await f.login();
  const response = await f.request(user.url + "/stream", { headers: user.headers });
  const reader = response.body.getReader(); t.after(() => reader.cancel());
  assert.equal((await nextEvent(reader)).rows.length, 1);
  f.members.set("G_PRIVATE", []); f.advance(100);
  assert.equal((await nextEvent(reader)).rows.length, 0);
  await setUser("U_MINE", { approved: false });
  await nextEvent(reader, "access-ended");
  assert.equal((await f.exchange()).status, 403);
  await setUser("U_MINE", { approved: true }); f.disconnect();
  assert.equal((await f.exchange()).status, 403);
});


test("Slack title events push renamed titles to Activity over SSE without polling or Slack reads", async (t) => {
  const f = await fixture(t, { pollMs: 60_000, accessRefreshMs: 60_000 });
  const entry = await f.root();
  const user = await f.login(); f.reads.length = 0;
  const response = await f.request(user.url + "/stream", { headers: user.headers });
  const reader = response.body.getReader(); t.after(() => reader.cancel());
  await nextEvent(reader);
  const events = new Map();
  registerAgentInterfaceHandlers({ event: (name, fn) => events.set(name, fn), action: () => {} });
  await events.get("agent_session_title_changed")({ event: {
    channel: "C_WORK", thread_ts: "100.000001", user: "U_OTHER", title: "Renamed from Slack", event_ts: "200.000001",
  } });
  const row = (await nextEvent(reader)).rows[0];
  assert.equal(row.title, "Renamed from Slack");
  assert.equal(row.status, "idle");
  indexSlackThread({ channelId: "C_WORK", slug: entry.slug, root: { ts: "100.000001", user: "U_MINE", text: "Original root preview" } });
  const refreshed = await f.request(user.url + "/api/threads", { headers: user.headers });
  assert.equal((await refreshed.json()).rows[0].title, "Renamed from Slack");
  assert.equal(getSlackThread("C_WORK", "100.000001").starter_id, "U_MINE", "a participant's rename cannot take ownership");
  assert.deepEqual(f.reads, []);
});


test("browser Mark All Done requires confirmation and CSRF, spans pages, and ignores supplied owners", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++) await f.root("C_WORK", `${100+i}.000001`);
  await f.root("C_FOREIGN", "200.000001", "U_OTHER");
  const user = await f.login(), path = user.url + "/api/completion-all";
  for (const body of [{}, { confirmed: false }, { confirmed: "true" }]) {
    assert.equal((await f.request(path, { method: "POST", headers: user.post, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal((await f.request(path, { method: "POST", headers: user.headers, body: JSON.stringify({ confirmed: true }) })).status, 403);
  assert.equal(getSlackThread("C_WORK", "100.000001").done_ms, 0);
  const response = await f.request(path, { method: "POST", headers: user.post, body: JSON.stringify({ confirmed: true, ownerId: "U_OTHER", filter: "done", page: 9 }) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { marked: 12, skipped: 0, failed: 0 });
  assert.equal(getSlackThread("C_FOREIGN", "200.000001").done_ms, 0);
  assert.equal(f.markerCalls.length, 0, "root checks are durably queued rather than blocking the bulk request");
  assert.equal(getDb().prepare("SELECT count(*) n FROM slack_threads WHERE done_ms>0 AND completion_marker_retry_ms>0").get().n, 12);
  assert.deepEqual(await (await f.request(path, { method: "POST", headers: user.post, body: JSON.stringify({ confirmed: true }) })).json(), { marked: 0, skipped: 0, failed: 0 });
});

test("browser Mark All Done stops when its session expires during a Slack root read", async (t) => {
  const f = await fixture(t); await f.root();
  const user = await f.login(), read = f.client.conversations.replies;
  f.client.conversations.replies = async (args) => { f.advance(ACTIVITY_SESSION_TTL_MS); return read(args); };
  const response = await f.request(user.url + "/api/completion-all", { method: "POST", headers: user.post, body: JSON.stringify({ confirmed: true }) });
  assert.equal(response.status, 401); assert.equal(getSlackThread("C_WORK", "100.000001").done_ms, 0);
});


test("browser history explicitly indexes 100 candidates, continues older rows and reuses the durable index", async (t) => {
  const f = await fixture(t);
  const c = await f.root();
  getDb().exec("DELETE FROM slack_threads");
  for (let n = 1; n <= 103; n++) {
    const ts = `${100+n}.000001`;
    f.roots.set(`C_WORK:${ts}`, { ts, user: n % 2 ? "U_MINE" : "U_OTHER", text: `Old ${n}` });
    getDb().prepare("INSERT INTO sessions(slug,thread_key,session_id) VALUES(?,?,?)").run(c.slug, ts, `old-${n}`);
  }
  const session = await f.login();
  const snapshot = await f.request(session.url + "/api/threads", { headers: session.headers });
  assert.equal((await snapshot.json()).rows.length, 0, "ordinary refresh never indexes legacy history");
  for (const [scanned, moreHistory] of [[100, true], [3, false], [0, false]]) {
    f.reads.length = 0;
    const result = await f.request(session.url + "/api/history", { method: "POST", headers: session.post, body: JSON.stringify({ ownerId: "U_OTHER" }) });
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.equal(data.history.scanned, scanned); assert.equal(data.history.moreHistory, moreHistory);
    assert.ok(data.rows.every((r) => Number(r.threadTs.split(".")[0]) % 2 === 1));
    if (!scanned) assert.equal(f.reads.length, 0);
  }
  getDb().exec("DELETE FROM sessions");
  const result = await f.request(session.url + "/api/threads", { headers: session.headers });
  assert.equal((await result.json()).rows.length, 52);
});

test("history requires session, origin and CSRF and aborts indexing on mid-read revocation", async (t) => {
  const f = await fixture(t);
  const c = await f.root();
  getDb().exec("DELETE FROM slack_threads");
  getDb().prepare("INSERT INTO sessions(slug,thread_key,session_id) VALUES(?,?,?)").run(c.slug, "100.000001", "legacy");
  const session = await f.login();
  for (const headers of [session.headers, { ...session.post, "X-CG-CSRF": "bad" }, { ...session.post, Origin: "https://evil.example" }, { Origin: f.base, "X-CG-CSRF": session.csrf }]) {
    const result = await f.request(session.url + "/api/history", { method: "POST", headers, body: "{}" });
    assert.ok([401, 403].includes(result.status));
    assert.equal(getSlackThread("C_WORK", "100.000001"), null);
  }
  const replies = f.client.conversations.replies;
  f.client.conversations.replies = async (args) => {
    const result = await replies(args);
    await setUser("U_MINE", { approved: false });
    return result;
  };
  const revoked = await f.request(session.url + "/api/history", { method: "POST", headers: session.post, body: "{}" });
  assert.equal(revoked.status, 403);
  assert.equal(getSlackThread("C_WORK", "100.000001"), null);
});


test("history cannot index after channel access changes during the final private membership read", async (t) => {
  const f = await fixture(t);
  const c = await f.root("G_HISTORY", "100.000001", "U_MINE", true, "group");
  f.members.set("G_HISTORY", ["U_MINE"]);
  getDb().exec("DELETE FROM slack_threads");
  getDb().prepare("INSERT INTO sessions(slug,thread_key,session_id) VALUES(?,?,?)").run(c.slug, "100.000001", "private-history");
  const session = await f.login();
  let checks = 0;
  f.client.conversations.members = async () => {
    if (++checks === 2) await saveChannelMeta(c.slug, { access: "none" });
    return { members: ["U_MINE"] };
  };
  const result = await f.request(session.url + "/api/history", { method: "POST", headers: session.post, body: "{}" });
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.history.unavailable, true); assert.equal(data.history.moreHistory, true);
  assert.deepEqual(data.rows, []);
  assert.equal(getSlackThread("G_HISTORY", "100.000001"), null);
});

test("approved Activity viewers can read shared subscription usage without admin access", async (t) => {
  const payload = { subscriptions: [{ provider: "codex-eu", name: "Codex EU", kind: "subscription", status: "ok", windows: [{ label: "Weekly", usedPercent: 24, resetsAt: "2026-12-01T12:00:00Z" }] }], refreshAfterSeconds: 600 };
  let calls = 0;
  const f = await fixture(t, { readSubscriptions: async () => { calls++; return payload; } });
  const user = await f.login();
  assert.notEqual((await getUser("U_MINE")).isAdmin, true);
  for (const suffix of ["/subscriptions", "/api/subscriptions"]) {
    assert.equal((await f.request(user.url + suffix)).status, 401);
    assert.equal((await f.request(user.url + suffix, { headers: { cookie: "cg_session=forged", Authorization: "Bearer fake-api-key" } })).status, 401);
    const response = await f.request(user.url + suffix, { headers: user.headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    if (suffix.startsWith("/api")) assert.deepEqual(await response.json(), payload);
    else {
      assert.match(response.headers.get("content-security-policy"), /script-src 'nonce-/);
      assert.doesNotMatch(await response.text(), /<h1>My Activity<\/h1>/);
    }
  }
  assert.equal(calls, 1);
  const other = await f.login("U_OTHER");
  assert.equal((await f.request(user.url + "/api/subscriptions", { headers: other.headers })).status, 401);
  assert.equal(calls, 1, "another viewer's session cannot authorize this URL");
  f.advance(ACTIVITY_SESSION_TTL_MS);
  assert.equal((await f.request(user.url + "/api/subscriptions", { headers: user.headers })).status, 401);
  assert.equal(calls, 1, "expired session cannot trigger provider lookup");
});

test("subscription payload is withheld when Activity access expires, is revoked or changes while reading", async (t) => {
  for (const cause of ["expiry", "revoked", "team", "disconnected"]) {
    await t.test(cause, async (t) => {
      const started = defer(), gate = defer();
      const f = await fixture(t, { readSubscriptions: async () => { started.resolve(); await gate.promise; return { subscriptions: [{ name: "PRIVATE_QUOTA" }] }; } });
      await setUser("U_MINE", { approved: true, isAdmin: false });
      const user = await f.login();
      const pending = f.request(user.url + "/api/subscriptions", { headers: user.headers });
      await started.promise;
      if (cause === "expiry") f.advance(ACTIVITY_SESSION_TTL_MS);
      if (cause === "revoked") await setUser("U_MINE", { approved: false, isAdmin: false });
      if (cause === "team") f.setTeam("T_CHANGED");
      if (cause === "disconnected") f.disconnect();
      gate.resolve();
      const response = await pending;
      assert.ok([401, 403, 503].includes(response.status));
      assert.doesNotMatch(await response.text(), /PRIVATE_QUOTA/);
    });
  }
});


test("Later saves only owned authorized threads with CSRF; history and runtime preserve it until Resume or Done", async (t) => {
  const f = await fixture(t);
  await f.root(); await f.root("C_WORK", "100.000002", "U_OTHER");
  const user = await f.login(), path = user.url + "/api/later";
  const body = (later, threadTs = "100.000001") => JSON.stringify({ channelId: "C_WORK", threadTs, later });
  assert.equal((await f.request(path, { method: "POST", headers: user.headers, body: body(true) })).status, 403);
  assert.equal((await f.request(path, { method: "POST", headers: user.post, body: body("yes") })).status, 400);
  assert.equal((await f.request(path, { method: "POST", headers: user.post, body: body(true, "100.000002") })).status, 403);
  assert.equal((await f.request(path, { method: "POST", headers: user.post, body: body(true) })).status, 200);
  assert.ok(getSlackThread("C_WORK", "100.000001").later_ms > 0);
  assert.ok(f.markerCalls.some(([method, args]) => method === "add" && args.name === "clock3" && args.timestamp === "100.000001"));
  const run = { id: "later-running", channelId: "C_WORK", slug: "c-work", threadKey: "100.000001", engine: "codex" };
  recordActiveRun(run.id, run);
  await f.root();
  let data = await (await f.request(user.url + "/api/threads", { headers: user.headers })).json();
  assert.equal(data.rows[0].status, "later");
  assert.equal((await activityThreadSnapshot(f.client, "U_MINE", { filter: "active" })).rows.length, 0);
  assert.equal((await activityThreadSnapshot(f.client, "U_MINE", { filter: "all" })).rows.length, 1);
  assert.equal((await f.request(path, { method: "POST", headers: user.post, body: body(false) })).status, 200);
  data = await (await f.request(user.url + "/api/threads", { headers: user.headers })).json();
  assert.equal(data.rows[0].status, "working");
  assert.ok(f.markerCalls.some(([method, args]) => method === "remove" && args.name === "clock3" && args.timestamp === "100.000001"));
  clearActiveRun(run.id);
  setSlackThreadLater("C_WORK", "100.000001", "U_MINE", true);
  assert.equal((await f.request(user.url + "/api/completion", { method: "POST", headers: user.post,
    body: JSON.stringify({ channelId: "C_WORK", threadTs: "100.000001", done: true }) })).status, 200);
  assert.equal(getSlackThread("C_WORK", "100.000001").later_ms, 0);
});

test("Later rechecks private membership and ownership after a delayed root lookup", async (t) => {
  const f = await fixture(t); await f.root("G_PRIVATE", "100.000001", "U_MINE", true, "private");
  f.members.set("G_PRIVATE", ["U_MINE"]);
  const user = await f.login(), read = defer();
  f.client.conversations.replies = async () => { await read.promise; return { messages: [{ ts: "100.000001", user: "U_MINE" }] }; };
  const pending = f.request(user.url + "/api/later", { method: "POST", headers: user.post,
    body: JSON.stringify({ channelId: "G_PRIVATE", threadTs: "100.000001", later: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  f.members.set("G_PRIVATE", []); read.resolve();
  assert.equal((await pending).status, 403);
  assert.equal(getSlackThread("G_PRIVATE", "100.000001").later_ms, 0);
});

test("Settings page and API are the viewer's own, masked, CSRF-protected and closed on revocation", async (t) => {
  const f = await fixture(t), mine = await f.login(), other = await f.login("U_OTHER");
  await setUser("U_OTHER", { composioToken: "other-composio-token-9999" });
  const page = await f.request(mine.url + "/settings", { headers: mine.headers });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Settings · ChannelGate<\/title>/);
  assert.match(html, /aria-current="page">Settings</);
  assert.match(html, /"csrf":"/);
  assert.doesNotMatch(html, /id="threads"/, "the settings view does not open the Activity stream");
  assert.equal((await f.request(mine.url + "/settings", { headers: { cookie: "" } })).status, 401);
  const endpoint = mine.url + "/api/settings";
  assert.equal((await f.request(endpoint, { headers: { cookie: "" } })).status, 401);
  const before = await (await f.request(endpoint, { headers: mine.headers })).json();
  assert.equal(before.account.id, "U_MINE");
  assert.equal(before.connections.composio.configured, false, "another person's token never appears");
  const token = "my-composio-token-123456";
  const body = JSON.stringify({ action: "composio.save", token, ownerId: "U_OTHER", userId: "U_OTHER" });
  assert.equal((await f.request(endpoint, { method: "POST", headers: { ...mine.post, "X-CG-CSRF": "invalid" }, body })).status, 403);
  assert.equal((await f.request(endpoint, { method: "POST", headers: { ...mine.post, Origin: "https://other.example" }, body })).status, 403);
  assert.equal((await f.request(endpoint, { method: "POST", headers: { ...mine.post, cookie: "" }, body })).status, 401);
  assert.equal((await f.request(endpoint, { method: "POST", headers: { ...mine.post, "X-CG-CSRF": other.csrf }, body })).status, 403, "another session's CSRF token is refused");
  assert.ok(!(await getUser("U_MINE")).composioToken, "refused writes change nothing");
  const saved = await f.request(endpoint, { method: "POST", headers: mine.post, body });
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.match(result.notice, /Composio/);
  assert.equal(result.settings.connections.composio.last4, "3456");
  assert.ok(!JSON.stringify(result).includes(token), "the response never echoes the secret");
  assert.equal((await getUser("U_MINE")).composioToken, token);
  assert.equal((await getUser("U_OTHER")).composioToken, "other-composio-token-9999");
  const invalid = await f.request(endpoint, { method: "POST", headers: mine.post, body: JSON.stringify({ action: "variable.save", name: "PATH", value: "/tmp" }) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(Object.keys(await invalid.json()).sort(), ["error", "field"]);
  const large = await f.request(endpoint, { method: "POST", headers: mine.post, body: JSON.stringify({ action: "variable.save", name: "BIG_VALUE", value: "x".repeat(12_000) }) });
  assert.equal(large.status, 200, "a variable value larger than the 8 KB default fits the settings limit");
  await setUser("U_MINE", { approved: false, isAdmin: false });
  assert.equal((await f.request(endpoint, { headers: mine.headers })).status, 403);
  assert.equal((await f.request(endpoint, { method: "POST", headers: mine.post, body: JSON.stringify({ action: "nudges", enabled: true }) })).status, 403);
  assert.notEqual((await getUser("U_MINE")).nudges, true);
});

test("Connections pages and APIs bind the authenticated Activity owner and workspace", async (t) => {
  const calls = [];
  const f = await fixture(t, { connectionServices: {
    inventory: async input => { calls.push(["inventory", input]); return { mode: "sdk", canAdd: true, state: "ready", accounts: [{ app: "gmail", account: input.ownerId, status: "INITIATED" }] }; },
    apps: async input => { calls.push(["apps", input]); return { apps: [{ slug: "gmail", name: "Gmail", canConnect: true }], nextCursor: "page2" }; },
    create: async input => { await input.authorize(); calls.push(["create", input]); return { redirectUrl: "https://connect.composio.dev/link/fixture" }; },
  } });
  const mine = await f.login(), other = await f.login("U_OTHER");
  for (const suffix of ["/settings/connections", "/settings/connections/new", "/settings/email"]) {
    const page = await f.request(mine.url + suffix, { headers: mine.headers });
    assert.equal(page.status, 200); const html = await page.text();
    assert.match(html, /<title>Settings · ChannelGate/);
    assert.match(html, suffix.endsWith("/email") ? /"emailPage":true/ : /"connectionsPage":true/);
    const policy = page.headers.get("content-security-policy");
    assert.match(policy, /img-src 'self' data: https:\/\/logos\.composio\.dev https:\/\/assets\.composio\.dev;/);
    assert.match(html, new RegExp('"connectionsNew":' + String(suffix.endsWith("/new"))));
    assert.doesNotMatch(html, /id="threads"/);
  }
  const inventory = await f.request(mine.url + "/api/connections?ownerId=U_OTHER", { headers: mine.headers });
  assert.match(inventory.headers.get("cache-control"), /no-store/);
  assert.equal((await inventory.json()).accounts[0].account, "U_MINE");
  assert.deepEqual(calls.at(-1), ["inventory", { ownerId: "U_MINE", teamId: "T_WORK" }]);
  const catalog = await f.request(mine.url + "/api/connections/apps?query=mail&cursor=opaque&userId=U_OTHER", { headers: mine.headers });
  assert.equal(catalog.status, 200);
  assert.deepEqual(calls.at(-1), ["apps", { ownerId: "U_MINE", teamId: "T_WORK", query: "mail", cursor: "opaque" }]);
  const endpoint = mine.url + "/api/connections", body = JSON.stringify({ app: "gmail", alias: "work" });
  for (const headers of [{}, { ...mine.post, "X-CG-CSRF": "" }, { ...mine.post, "X-CG-CSRF": other.csrf }, { ...mine.post, Origin: "https://evil.example" }, { cookie: "cg_admin=forged", Origin: f.base }]) {
    const result = await f.request(endpoint, { method: "POST", headers, body });
    assert.ok([401, 403].includes(result.status));
  }
  assert.equal(calls.filter(([kind]) => kind === "create").length, 0);
  assert.equal((await f.request(endpoint, { method: "POST", headers: mine.post, body: JSON.stringify({ app: "gmail", ownerId: "U_OTHER", callbackUrl: "https://evil.example" }) })).status, 400);
  const created = await f.request(endpoint, { method: "POST", headers: mine.post, body });
  assert.equal(created.status, 200); assert.deepEqual(await created.json(), { redirectUrl: "https://connect.composio.dev/link/fixture" });
  const actual = calls.at(-1)[1]; assert.equal(actual.ownerId, "U_MINE"); assert.equal(actual.teamId, "T_WORK");
  assert.equal(actual.sessionId, mine.url.split("/").at(-1));
  assert.equal(actual.callbackUrl, f.base + mine.url + "/settings/connections");
  // Callback query strings are never evidence of an ACTIVE provider account.
  assert.equal((await f.request(mine.url + "/settings/connections?status=success", { headers: mine.headers })).status, 200);
  assert.equal((await (await f.request(endpoint, { headers: mine.headers })).json()).accounts[0].status, "INITIATED");
});

test("Connections discard awaited data and refuse link creation after Activity revocation", async (t) => {
  const gate = defer(); let entered = false;
  const f = await fixture(t, { connectionServices: { inventory: async () => { entered = true; await gate.promise; return { accounts: [{ account: "must-not-publish" }] }; } } });
  const mine = await f.login();
  const pending = f.request(mine.url + "/api/connections", { headers: mine.headers });
  while (!entered) await new Promise(resolve => setImmediate(resolve));
  await setUser("U_MINE", { approved: false }); gate.resolve();
  const result = await pending; assert.equal(result.status, 403); assert.doesNotMatch(await result.text(), /must-not-publish/);
});

test("Activity is one installable web app: shared manifest, icons and a launcher that resumes the live session", async (t) => {
  const f = await fixture(t);
  await f.root("C_WORK", "100.000001", "U_MINE");
  const manifestResponse = await f.request("/activity/manifest.webmanifest", { headers: { Origin: f.base } });
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get("content-type"), /^application\/manifest\+json/);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.id, "/activity/app");
  assert.equal(manifest.start_url, "/activity/app");
  assert.equal(manifest.scope, "/activity/");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.name && manifest.short_name);
  for (const size of ["192x192", "512x512"]) assert.ok(manifest.icons.some((icon) => icon.sizes === size && icon.type === "image/png" && icon.purpose === "any"), size);
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
  for (const icon of manifest.icons) {
    const response = await f.request(icon.src);
    assert.equal(response.status, 200, icon.src);
    assert.equal(response.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.readUInt32BE(1), 0x504e470d, "PNG signature");
    assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes);
  }
  assert.equal(manifest.icons.every((icon) => icon.src.startsWith(manifest.scope)), true);

  // Signed out: the app opens on passkey sign-in, which also links the manifest under a CSP that allows it.
  const signedOut = await f.request("/activity/app");
  assert.equal(signedOut.status, 303);
  assert.equal(signedOut.headers.get("location"), "/activity/login");
  const loginPage = await f.request("/activity/login");
  assert.match(await loginPage.text(), /<link rel="manifest" href="\/activity\/manifest\.webmanifest\?color=ff642f">/);
  assert.match(loginPage.headers.get("content-security-policy"), /manifest-src 'self'/);

  // A new session also sets the launcher cookie (id only, never the secret) scoped to /activity/app.
  const response = await f.exchange();
  const { url } = await response.json();
  const cookies = response.headers.getSetCookie();
  const launcher = cookies.find((c) => c.startsWith("cg_activity_app="));
  const sessionCookie = cookies.find((c) => c.startsWith("cg_activity_") && !c.startsWith("cg_activity_app="));
  assert.ok(launcher && sessionCookie);
  const id = url.split("/").at(-1);
  assert.equal(launcher.split(";")[0], `cg_activity_app=${id}`);
  assert.match(launcher, /; HttpOnly; SameSite=Lax; Path=\/activity\/app; Max-Age=43200/);
  assert.doesNotMatch(launcher, new RegExp(sessionCookie.split(";")[0].split("=")[1]));
  const resumed = await f.request("/activity/app", { headers: { cookie: launcher.split(";")[0] } });
  assert.equal(resumed.status, 303);
  assert.equal(resumed.headers.get("location"), url);
  const ready = await f.request('/activity/app/session', { headers: { cookie: launcher.split(';')[0] } });
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { url });
  assert.equal(ready.headers.get('set-cookie'), null, 'polling never issues or extends a session');
  for (const bad of ['cg_activity_app=nope', 'cg_activity_app=AAAAAAAAAAAAAAAA', '']) {
    assert.equal((await f.request('/activity/app/session', { headers: { cookie: bad } })).status, 401);
  }
  assert.equal((await f.request('/activity/app/session', { headers: { cookie: launcher.split(';')[0], Origin: 'https://foreign.example' } })).status, 403);
  await setUser('U_MINE', { approved: false });
  assert.equal((await f.request('/activity/app/session', { headers: { cookie: launcher.split(';')[0] } })).status, 401);
  await setUser('U_MINE', { approved: true });
  // The dashboard still demands the session cookie: the launcher id alone opens nothing.
  const page = await f.request(url, { headers: { cookie: launcher.split(";")[0] } });
  assert.equal(page.status, 401);
  const dashboard = await f.request(url, { headers: { cookie: sessionCookie.split(";")[0] } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /<link rel="manifest" href="\/activity\/manifest\.webmanifest\?color=ff642f">/);
  for (const bad of ["cg_activity_app=nope", "cg_activity_app=AAAAAAAAAAAAAAAA", ""]) {
    assert.equal((await f.request("/activity/app", { headers: { cookie: bad } })).headers.get("location"), "/activity/login", bad);
  }
  f.advance(ACTIVITY_SESSION_TTL_MS + 1);
  assert.equal((await f.request("/activity/app/session", { headers: { cookie: launcher.split(";")[0] } })).status, 401);
  assert.equal((await f.request("/activity/app", { headers: { cookie: launcher.split(";")[0] } })).headers.get("location"), "/activity/login");
});

test("Activity grouping persists only for its viewer, streams updates and rejects invalid or unauthorized writes", async (t) => {
  const f = await fixture(t), mine = await f.login(), other = await f.login("U_OTHER");
  const endpoint = mine.url + "/api/group-by";
  const snapshot = async (viewer) => (await f.request(viewer.url + "/api/threads", { headers: viewer.headers })).json();
  assert.equal((await snapshot(mine)).groupBy, "channel");
  const original = await getUser("U_MINE");
  const body = JSON.stringify({ groupBy: "channel", ownerId: "U_OTHER", isAdmin: true });
  const result = await f.request(endpoint, { method: "POST", headers: mine.post, body });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { groupBy: "channel", groupByVersion: 1 });
  assert.deepEqual(await getUser("U_MINE"), { ...original, activityGroupBy: "channel", activityGroupByVersion: 1 });
  assert.equal((await snapshot(other)).groupBy, "channel");
  assert.equal((await snapshot(await f.login())).groupBy, "channel");
  const stream = await f.request(mine.url + "/stream", { headers: mine.headers });
  const reader = stream.body.getReader(); t.after(() => reader.cancel());
  assert.equal((await nextEvent(reader)).groupBy, "channel");
  assert.equal((await f.request(endpoint, { method: "POST", headers: mine.post, body: JSON.stringify({ groupBy: "status" }) })).status, 200);
  assert.equal((await nextEvent(reader)).groupBy, "status");
  assert.equal((await snapshot(await f.login())).groupBy, "status", "explicit Status choice survives a new session");
  for (const groupBy of [null, "unknown", [], {}, 1]) {
    assert.equal((await f.request(endpoint, { method: "POST", headers: mine.post, body: JSON.stringify({ groupBy }) })).status, 400);
  }
  for (const [headers, status] of [[{ ...mine.post, cookie: "" }, 401], [{ ...mine.post, "X-CG-CSRF": "bad" }, 403], [{ ...mine.post, Origin: "https://other.example" }, 403]]) {
    assert.equal((await f.request(endpoint, { method: "POST", headers, body })).status, status);
  }
  await setUser("U_MINE", { approved: false, isAdmin: false });
  assert.equal((await f.request(endpoint, { method: "POST", headers: mine.post, body })).status, 403);
  assert.equal((await getUser("U_MINE")).activityGroupBy, "status");
});

test("Activity pins persist per owner across sessions and streams without changing thread state", async (t) => {
  const f = await fixture(t);
  await f.root(); await f.root("C_WORK", "100.000002");
  await f.root("C_WORK", "100.000003", "U_OTHER");
  const mine = await f.login(), other = await f.login("U_OTHER");
  const snapshot = async (viewer) => (await f.request(viewer.url + "/api/threads", { headers: viewer.headers })).json();
  const change = (threadTs, pinned) => f.request(mine.url + "/api/pin", { method: "POST", headers: mine.post,
    body: JSON.stringify({ channelId: "C_WORK", threadTs, pinned, ownerId: "U_OTHER", isAdmin: true }) });
  const original = getSlackThread("C_WORK", "100.000001");
  const stream = await f.request(mine.url + "/stream", { headers: mine.headers });
  const reader = stream.body.getReader(); t.after(() => reader.cancel());
  assert.equal((await nextEvent(reader)).rows[0].pinned, false);
  assert.equal((await change("100.000001", true)).status, 200);
  assert.equal((await nextEvent(reader)).rows.find((r) => r.threadTs === "100.000001").pinned, true);
  assert.equal((await change("100.000001", true)).status, 200, "pinning is idempotent");
  const replies = await Promise.all([change("100.000001", true), change("100.000002", true)]);
  assert.ok(replies.every((r) => r.status === 200));
  assert.equal((await getUser("U_MINE")).activityPinnedThreads.length, 2, "concurrent writes preserve both pins");
  assert.deepEqual((await getUser("U_OTHER")).activityPinnedThreads, []);
  assert.equal((await getUser("U_MINE")).isAdmin, false);
  assert.ok((await snapshot(await f.login())).rows.every((r) => r.pinned));
  assert.ok((await snapshot(other)).rows.every((r) => !r.pinned));
  assert.deepEqual(getSlackThread("C_WORK", "100.000001"), original);
  setSlackThreadLater("C_WORK", "100.000001", "U_MINE", true);
  assert.equal((await snapshot(mine)).rows.find((r) => r.threadTs === "100.000001").pinned, true);
  assert.equal((await change("100.000001", false)).status, 200);
  assert.equal((await change("100.000002", false)).status, 200);
  assert.ok((await snapshot(mine)).rows.every((r) => !r.pinned));
  assert.equal(f.markerCalls.length, 0, "personal pins never change Slack reactions");
});

test("Activity pins deny foreign, inaccessible, malformed, CSRF and revoked writes", async (t) => {
  const f = await fixture(t), entry = await f.root("G_PRIVATE", "100.000001", "U_MINE", true, "private");
  f.members.set("G_PRIVATE", ["U_MINE"]);
  await f.root("C_WORK", "100.000002", "U_OTHER");
  const mine = await f.login(), endpoint = mine.url + "/api/pin";
  const payload = { channelId: "G_PRIVATE", threadTs: "100.000001", pinned: true };
  const send = (body = payload, headers = mine.post) => f.request(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  for (const [headers, status] of [[{ ...mine.post, cookie: "" }, 401], [{ ...mine.post, "X-CG-CSRF": "bad" }, 403], [{ ...mine.post, Origin: "https://other.example" }, 403]]) assert.equal((await send(payload, headers)).status, status);
  for (const body of [{ ...payload, pinned: "true" }, { ...payload, channelId: null }, { ...payload, threadTs: [] }]) assert.equal((await send(body)).status, 400);
  assert.equal((await send({ ...payload, channelId: "C_WORK", threadTs: "100.000002" })).status, 403);
  assert.equal((await send()).status, 200);
  f.members.set("G_PRIVATE", []);
  assert.equal((await send()).status, 403);
  assert.equal((await (await f.request(mine.url + "/api/threads", { headers: mine.headers })).json()).rows.length, 0);
  f.members.set("G_PRIVATE", ["U_MINE"]);
  await saveChannelMeta(entry.slug, { access: "none" }); assert.equal((await send()).status, 403);
  await saveChannelMeta(entry.slug, { access: "approved" });
  await setUser("U_MINE", { approved: false }); assert.equal((await send()).status, 403);
});

test("Activity pin rechecks revocation after an awaited private membership read", async (t) => {
  const f = await fixture(t);
  await f.root("G_PRIVATE", "100.000001", "U_MINE", true, "private");
  f.members.set("G_PRIVATE", ["U_MINE"]);
  const mine = await f.login(), started = defer(), gate = defer();
  f.client.conversations.members = async () => { started.resolve(); await gate.promise; return { members: ["U_MINE"] }; };
  const pending = f.request(mine.url + "/api/pin", { method: "POST", headers: mine.post,
    body: JSON.stringify({ channelId: "G_PRIVATE", threadTs: "100.000001", pinned: true }) });
  await started.promise; await setUser("U_MINE", { approved: false }); gate.resolve();
  assert.equal((await pending).status, 403);
  assert.deepEqual((await getUser("U_MINE")).activityPinnedThreads, []);
});

test("Activity channel pins persist per viewer, include future open work and preserve separate thread pins", async (t) => {
  const f = await fixture(t);
  await f.root(); await f.root("C_WORK", "100.000002");
  await f.root("C_WORK", "100.000003", "U_OTHER");
  const mine = await f.login(), other = await f.login("U_OTHER");
  const snapshot = async (viewer) => (await f.request(viewer.url + "/api/threads", { headers: viewer.headers })).json();
  const pin = (channelId, pinned) => f.request(mine.url + "/api/channel-pin", { method: "POST", headers: mine.post,
    body: JSON.stringify({ channelId, pinned, ownerId: "U_OTHER", isAdmin: true, activityPinnedThreads: [] }) });
  const original = getSlackThread("C_WORK", "100.000001");
  await setUser("U_MINE", { activityPinnedThreads: [JSON.stringify(["C_WORK", "100.000001"])] });
  const stream = await f.request(mine.url + "/stream", { headers: mine.headers });
  const reader = stream.body.getReader(); t.after(() => reader.cancel());
  assert.deepEqual((await nextEvent(reader)).pinnedChannels, []);
  assert.equal((await pin("C_WORK", true)).status, 200);
  const event = await nextEvent(reader);
  assert.deepEqual(event.pinnedChannels, [{ channelId: "C_WORK", channelName: "#C_WORK" }]);
  assert.ok(event.rows.every((row) => row.channelPinned));
  assert.deepEqual(event.rows.map((row) => row.pinned).sort(), [false, true]);
  assert.equal((await pin("C_WORK", true)).status, 200);
  assert.deepEqual((await getUser("U_MINE")).activityPinnedChannels, ["C_WORK"], "idempotent");
  assert.deepEqual((await snapshot(other)).pinnedChannels, []);
  assert.ok((await snapshot(other)).rows.every((row) => !row.channelPinned));
  assert.equal((await getUser("U_MINE")).isAdmin, false);
  assert.deepEqual(getSlackThread("C_WORK", "100.000001"), original);
  await f.root("C_WORK", "100.000004");
  setSlackThreadLater("C_WORK", "100.000002", "U_MINE", true);
  const again = await snapshot(await f.login());
  assert.equal(again.rows.find((row) => row.threadTs === "100.000004").channelPinned, true);
  assert.equal(again.rows.find((row) => row.threadTs === "100.000002").status, "later");
  assert.ok(again.rows.every((row) => row.threadTs !== "100.000003"), "foreign roots remain excluded");
  // Unpinning a channel never clears an individual conversation pin.
  assert.equal((await pin("C_WORK", false)).status, 200);
  const unpinned = await snapshot(mine);
  assert.deepEqual(unpinned.pinnedChannels, []);
  assert.ok(unpinned.rows.every((row) => !row.channelPinned));
  assert.equal(unpinned.rows.find((row) => row.threadTs === "100.000001").pinned, true);
  await f.root("C_EMPTY", "100.000001", "U_OTHER");
  const results = await Promise.all([pin("C_WORK", true), pin("C_EMPTY", true)]);
  assert.ok(results.every((result) => result.status === 200));
  assert.deepEqual(new Set((await snapshot(mine)).pinnedChannels.map((channel) => channel.channelId)), new Set(["C_WORK", "C_EMPTY"]));
  assert.deepEqual((await getUser("U_OTHER")).activityPinnedChannels, []);
  assert.equal(f.markerCalls.length, 0, "pins never mutate Slack reactions");
});

test("Activity channel pins reject malformed, CSRF, inaccessible and revoked requests and hide private channel names", async (t) => {
  const f = await fixture(t), entry = await f.root("G_PRIVATE", "100.000001", "U_MINE", true, "private");
  f.members.set("G_PRIVATE", ["U_MINE"]);
  const mine = await f.login(), payload = { channelId: "G_PRIVATE", pinned: true };
  const send = (body = payload, headers = mine.post) => f.request(mine.url + "/api/channel-pin", { method: "POST", headers, body: JSON.stringify(body) });
  for (const [headers, status] of [[{ ...mine.post, cookie: "" }, 401], [{ ...mine.post, "X-CG-CSRF": "bad" }, 403], [{ ...mine.post, Origin: "https://other.example" }, 403]]) assert.equal((await send(payload, headers)).status, status);
  for (const body of [{ ...payload, pinned: "true" }, { ...payload, channelId: null }, { ...payload, channelId: "" }, { ...payload, channelId: "googlechat:spaces/AAA" }]) assert.equal((await send(body)).status, 400);
  assert.equal((await send({ ...payload, channelId: "C_UNKNOWN" })).status, 403);
  assert.equal((await send()).status, 200);
  f.members.set("G_PRIVATE", []);
  assert.equal((await send()).status, 403);
  const hidden = await (await f.request(mine.url + "/api/threads", { headers: mine.headers })).json();
  assert.deepEqual(hidden.pinnedChannels, []); assert.deepEqual(hidden.rows, []);
  assert.doesNotMatch(JSON.stringify(hidden), /G_PRIVATE/);
  f.members.set("G_PRIVATE", ["U_MINE"]);
  await saveChannelMeta(entry.slug, { access: "none" }); assert.equal((await send()).status, 403);
  await saveChannelMeta(entry.slug, { access: "approved" });
  await setUser("U_MINE", { approved: false }); assert.equal((await send()).status, 403);
});

test("Activity channel pin rechecks revocation after awaited private membership", async (t) => {
  const f = await fixture(t);
  await f.root("G_PRIVATE", "100.000001", "U_MINE", true, "private");
  f.members.set("G_PRIVATE", ["U_MINE"]);
  const mine = await f.login(), started = defer(), gate = defer();
  f.client.conversations.members = async () => { started.resolve(); await gate.promise; return { members: ["U_MINE"] }; };
  const pending = f.request(mine.url + "/api/channel-pin", { method: "POST", headers: mine.post,
    body: JSON.stringify({ channelId: "G_PRIVATE", pinned: true }) });
  await started.promise; await setUser("U_MINE", { approved: false }); gate.resolve();
  assert.equal((await pending).status, 403);
  assert.deepEqual((await getUser("U_MINE")).activityPinnedChannels, []);
});


test("Activity DM labels resolve the peer, hide legacy identifiers and apply to empty pins and search", async (t) => {
  const f = await fixture(t);
  const entry = await f.root("D12345678", "100.000001", "U_MINE", true, "im");
  f.members.set("D12345678", ["U_MINE"]);
  await upsertChannelEntry("D12345678", { name: "dm-U_MINE" });
  await setUser("U_MINE", { name: "Alex Example", activityPinnedChannels: ["D12345678"] });
  await saveChannelMeta(entry.slug, { dmUserId: "U_MINE" });
  const mine = await f.login();
  const snapshot = async () => (await f.request(mine.url + "/api/threads", { headers: mine.headers })).json();
  let data = await snapshot();
  assert.equal(data.rows[0].channelName, "Personal conversation with Alex Example");
  assert.equal(data.pinnedChannels[0].channelName, data.rows[0].channelName);
  const searched = await activityThreadSnapshot(f.client, "U_MINE", { search: "Alex Example" });
  assert.equal(searched.rows.length, 1);
  assert.equal(searched.rows[0].isDM, true);
  await saveChannelMeta(entry.slug, { dmUserId: "U_MISSING" });
  data = await snapshot();
  assert.equal(data.rows[0].channelName, "Personal conversation");
  assert.equal(data.pinnedChannels[0].channelName, "Personal conversation");
  setSlackThreadDone("D12345678", "100.000001", "U_MINE", true);
  data = await snapshot();
  assert.equal(data.pinnedChannels[0].channelName, "Personal conversation", "empty pinned groups use the same resolver");
  f.members.set("D12345678", []);
  data = await snapshot();
  assert.deepEqual(data.rows, []);
  assert.deepEqual(data.pinnedChannels, []);
});


test("fork Activity rows open and support independent Done/Later with fresh creator and bot checks", async (t) => {
  const f = await fixture(t);
  const entry = await f.root("G_FORKS", "100.000001", "U_OTHER", true, "private");
  f.members.set("G_FORKS", ["U_MINE", "U_OTHER"]);
  const threadTs = "101.000001";
  const root = { ts: threadTs, user: "UBOT", bot_id: "B_GATEWAY", text: "↪️ <@U_MINE> Fork: Explore another solution" };
  f.roots.set(`G_FORKS:${threadTs}`, root);
  indexSlackFork({ channelId: "G_FORKS", slug: entry.slug, threadTs, sourceThreadTs: "100.000001",
    creatorId: "U_MINE", botUserId: "UBOT", title: "Fork: Explore another solution" });
  const mine = await f.login(), other = await f.login("U_OTHER");
  const snapshot = await f.request(mine.url + "/api/threads", { headers: mine.headers });
  assert.deepEqual((await snapshot.json()).rows.map(r => r.threadTs), [threadTs]);
  assert.equal((await f.request(mine.url + `/open/G_FORKS/${threadTs}`, { headers: mine.headers })).status, 303);
  assert.equal((await f.request(other.url + `/open/G_FORKS/${threadTs}`, { headers: other.headers })).status, 403);
  const action = (user, operation, value) => f.request(user.url + `/api/${operation}`, { method: "POST", headers: user.post,
    body: JSON.stringify({ channelId: "G_FORKS", threadTs, [operation === "later" ? "later" : "done"]: value }) });
  assert.equal((await action(other, "completion", true)).status, 403);
  for (const [operation, value] of [["completion", true], ["completion", false], ["later", true], ["later", false]]) {
    assert.equal((await action(mine, operation, value)).status, 200);
  }
  assert.equal(getSlackThread("G_FORKS", "100.000001").done_ms, 0, "fork choices leave the source unchanged");
  f.roots.set(`G_FORKS:${threadTs}`, { ...root, user: "UOTHERBOT" });
  assert.equal((await action(mine, "completion", true)).status, 403);
  f.roots.set(`G_FORKS:${threadTs}`, root);
  f.members.set("G_FORKS", ["U_OTHER"]);
  assert.equal((await action(mine, "completion", true)).status, 403);
  assert.equal((await f.request(mine.url + `/open/G_FORKS/${threadTs}`, { headers: mine.headers })).status, 403);
});

test("Activity comments are the owner's private one-line notes on their own conversations", async (t) => {
  const f = await fixture(t);
  await f.root(); await f.root("C_WORK", "100.000002");
  await f.root("C_WORK", "100.000003", "U_OTHER");
  const mine = await f.login(), other = await f.login("U_OTHER");
  const endpoint = mine.url + "/api/comment";
  const snapshot = async (viewer) => (await f.request(viewer.url + "/api/threads", { headers: viewer.headers })).json();
  const send = (body, headers = mine.post) => f.request(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = { channelId: "C_WORK", threadTs: "100.000001", comment: "  Waiting on\nthe client reply  ", ownerId: "U_OTHER", isAdmin: true };
  assert.ok((await snapshot(mine)).rows.every((row) => row.comment === ""));
  for (const [headers, status] of [[{ ...mine.post, cookie: "" }, 401], [{ ...mine.post, "X-CG-CSRF": "bad" }, 403], [{ ...mine.post, Origin: "https://other.example" }, 403]]) assert.equal((await send(payload, headers)).status, status);
  for (const body of [{ ...payload, comment: 5 }, { ...payload, comment: null }, { ...payload, comment: "x".repeat(501) }, { ...payload, channelId: null }, { ...payload, threadTs: [] }]) assert.equal((await send(body)).status, 400);
  assert.equal((await send({ ...payload, threadTs: "100.000003" })).status, 403, "another person's conversation");
  assert.equal((await getUser("U_MINE")).activityComments, undefined);
  const original = await getUser("U_MINE"), thread = getSlackThread("C_WORK", "100.000001");
  const saved = await send(payload);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { comment: "Waiting on the client reply" });
  assert.deepEqual(await getUser("U_MINE"), { ...original, activityComments: { '["C_WORK","100.000001"]': "Waiting on the client reply" } });
  assert.equal((await send({ ...payload, comment: "é".repeat(500) })).status, 200, "the limit counts characters, not bytes");
  const rows = (await snapshot(await f.login())).rows;
  assert.equal(rows.find((row) => row.threadTs === "100.000001").comment, "é".repeat(500));
  assert.equal(rows.find((row) => row.threadTs === "100.000002").comment, "");
  assert.ok((await snapshot(other)).rows.every((row) => row.comment === ""), "comments are never shown to another person");
  assert.equal((await getUser("U_OTHER")).activityComments, undefined);
  assert.deepEqual(getSlackThread("C_WORK", "100.000001"), thread, "a comment never changes thread state");
  assert.equal((await send({ ...payload, comment: "   " })).status, 200);
  assert.deepEqual((await getUser("U_MINE")).activityComments, {}, "an empty comment removes it");
  assert.equal(f.markerCalls.length, 0);
  await setUser("U_MINE", { approved: false });
  assert.equal((await send(payload)).status, 403);
  assert.deepEqual((await getUser("U_MINE")).activityComments, {});
});

test("Activity column layout persists per viewer and rejects malformed layouts, CSRF and revoked admission", async (t) => {
  const f = await fixture(t);
  const mine = await f.login(), other = await f.login("U_OTHER");
  const endpoint = mine.url + "/api/columns";
  const defaults = ["conversation", "comment", "channel", "status", "last", "actions"];
  const custom = { order: ["status", "conversation", "actions", "last", "comment", "channel"], widths: { conversation: 420, comment: 240, actions: 260 } };
  const snapshot = async (viewer) => (await f.request(viewer.url + "/api/threads", { headers: viewer.headers })).json();
  assert.deepEqual((await snapshot(mine)).columns, { order: defaults, widths: {} });
  const send = (body, headers = mine.post) => f.request(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  for (const body of [{}, { order: defaults }, { widths: {} }, { order: defaults.slice(1), widths: {} }, { order: [...defaults.slice(1), "conversation"].concat("x"), widths: {} },
    { order: ["conversation", "conversation", "channel", "status", "last", "actions"], widths: {} }, { order: defaults, widths: [] }, { order: defaults, widths: { actions: 187 } }, { order: defaults, widths: { actions: 1601 } },
    { order: defaults, widths: { conversation: 119 } }, { order: defaults, widths: { conversation: 1601 } }, { order: defaults, widths: { comment: 100.5 } }, { order: defaults, widths: { comment: "200" } }]) {
    assert.equal((await send(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await f.request(endpoint, { method: "POST", headers: mine.post, body: '{"order":' + JSON.stringify(defaults) + ',"widths":{"__proto__":200}}' })).status, 400);
  for (const [headers, status] of [[{ ...mine.post, cookie: "" }, 401], [{ ...mine.post, "X-CG-CSRF": "bad" }, 403], [{ ...mine.post, Origin: "https://other.example" }, 403]]) assert.equal((await send(custom, headers)).status, status);
  const original = await getUser("U_MINE");
  const saved = await send({ ...custom, ownerId: "U_OTHER", isAdmin: true });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { columns: custom, columnsVersion: 1 });
  assert.deepEqual(await getUser("U_MINE"), { ...original, activityColumns: custom, activityColumnsVersion: 1 });
  assert.deepEqual((await snapshot(await f.login())).columns, custom);
  assert.equal((await snapshot(mine)).columnsVersion, 1);
  assert.deepEqual((await snapshot(other)).columns, { order: defaults, widths: {} });
  await setUser("U_MINE", { activityColumns: { order: ["conversation", "channel"], widths: { conversation: 5 } } });
  assert.deepEqual((await snapshot(mine)).columns, { order: defaults, widths: {} }, "a stale stored layout falls back to the defaults");
  await setUser("U_MINE", { approved: false, isAdmin: false });
  assert.equal((await send(custom)).status, 403);
});

test("Activity call history paginates privately and opens actual segment posts after current access checks", async (t) => {
  const { saveCallHistory } = await import("../src/gateway/voice/history.js");
  getDb().exec("DELETE FROM voice_calls");
  const f = await fixture(t, { voiceAvailable: () => false });
  const entry = await f.root("G_CALL", "100.000001", "U_OTHER", true, "private");
  f.members.set("G_CALL", ["U_MINE", "U_OTHER"]);
  const startedMs = Date.now();
  const receipt = { ownerId: "U_MINE", teamId: "T_WORK", startedMs, endedMs: startedMs + 75000, durationMs: 75000,
    costUSD: 0.0123, model: "gemini-3.8-live", summary: "Discussed the plan <script>literal text</script>", reason: "the caller hung up",
    threads: [{ channelId: "G_CALL", channelName: "Private project", threadTs: "100.000001", messageTs: "100.000099", title: "Quarterly plan", durationMs: 75000 }] };
  for (let i = 0; i < 31; i++) saveCallHistory({ ...receipt, id: `call-${i}`, startedMs: startedMs + i });
  saveCallHistory({ ...receipt, id: "foreign", ownerId: "U_OTHER" });
  saveCallHistory({ ...receipt, id: "other-team", teamId: "T_OTHER" });
  const mine = await f.login(), other = await f.login("U_OTHER");
  const page = await f.request(mine.url + "/calls", { headers: mine.headers });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Calls · ChannelGate/); assert.match(html, /aria-current="page">Calls/);
  assert.doesNotMatch(html, /id="connection"|id="activity-view"|id="call-agent"/);
  let response = await f.request(mine.url + "/api/calls", { headers: mine.headers });
  const first = await response.json();
  assert.equal(first.calls.length, 30); assert.ok(first.nextCursor); assert.equal(first.calls[0].id, "call-30");
  assert.equal(first.calls[0].costUSD, 0.0123); assert.equal(first.calls[0].summary, undefined);
  saveCallHistory({ ...receipt, id: "new-call", startedMs: startedMs + 100 });
  response = await f.request(mine.url + "/api/calls?before=" + first.nextCursor, { headers: mine.headers });
  const second = await response.json(); assert.equal(second.calls.length, 1); assert.equal(second.nextCursor, null);
  response = await f.request(mine.url + "/api/calls/call-30", { headers: mine.headers });
  assert.equal((await response.json()).summary, receipt.summary);
  for (const id of ["foreign", "other-team", "missing"]) assert.equal((await f.request(mine.url + "/api/calls/" + id, { headers: mine.headers })).status, 404);
  assert.equal((await f.request(other.url + "/api/calls/call-30", { headers: other.headers })).status, 404);
  assert.equal((await f.request(mine.url + "/api/calls")).status, 401);
  assert.equal((await f.request(mine.url + "/api/calls?before=invalid", { headers: mine.headers })).status, 400);
  const link = mine.url + "/calls/call-30/thread/0";
  response = await f.request(link, { headers: mine.headers });
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /p100000099\?thread_ts=100\.000001&cid=G_CALL/);
  assert.equal((await f.request(mine.url + "/calls/foreign/thread/0", { headers: mine.headers })).status, 404);
  f.members.set("G_CALL", ["U_OTHER"]);
  assert.equal((await f.request(link, { headers: mine.headers })).status, 403);
  f.members.set("G_CALL", ["U_MINE"]);
  await saveChannelMeta(entry.slug, { access: "admins" });
  assert.equal((await f.request(link, { headers: mine.headers })).status, 403);
  await setUser("U_MINE", { approved: false });
  assert.equal((await f.request(mine.url + "/api/calls", { headers: mine.headers })).status, 403);
});

test("call post links refuse sudo threads and recheck revocation during permalink lookup", async (t) => {
  const { saveCallHistory } = await import("../src/gateway/voice/history.js");
  getDb().exec("DELETE FROM voice_calls");
  const f = await fixture(t);
  const entry = await f.root("C_CALL", "100.000001");
  saveCallHistory({ id: "race-call", ownerId: "U_MINE", teamId: "T_WORK", startedMs: Date.now(), endedMs: Date.now(), durationMs: 1,
    costUSD: 0, model: "gemini-3.8-live", summary: "Hello", reason: "hangup",
    threads: [{ channelId: "C_CALL", threadTs: "100.000001", messageTs: "100.000002", durationMs: 1 }] });
  const mine = await f.login();
  const target = mine.url + "/calls/race-call/thread/0";
  await setThreadSudo(entry.slug, "100.000001", true);
  assert.equal((await f.request(target, { headers: mine.headers })).status, 403);
  await setThreadSudo(entry.slug, "100.000001", false);
  const started = defer(), gate = defer();
  f.client.chat.getPermalink = async () => { started.resolve(); await gate.promise; return { permalink: "https://example.slack.com/archives/C_CALL/p100000002" }; };
  const pending = f.request(target, { headers: mine.headers });
  await started.promise;
  await setUser("U_MINE", { approved: false }); gate.resolve();
  assert.equal((await pending).status, 403);
});


test("participants share Activity, hide independently, reopen themselves and cannot complete someone else's work", async (t) => {
  const f = await fixture(t);
  await f.root();
  recordSlackThreadParticipation("C_WORK", "100.000001", "U_OTHER", "101.000001");
  const owner = await f.login(), participant = await f.login("U_OTHER");
  const feed = async (session) => (await f.request(session.url + "/api/threads", { headers: session.headers })).json();
  const action = (session, operation, body, headers = session.post) => f.request(session.url + "/api/" + operation,
    { method: "POST", headers, body: JSON.stringify({ channelId: "C_WORK", threadTs: "100.000001", ...body }) });
  assert.equal((await feed(participant)).rows[0].canComplete, false);
  assert.equal((await feed(owner)).rows[0].canComplete, true);
  assert.equal((await f.request(participant.url + "/open/C_WORK/100.000001", { headers: participant.headers })).status, 303);
  for (const operation of ["completion", "later"]) assert.equal((await action(participant, operation, { done: true, later: true })).status, 403);
  for (const [operation, body] of [["pin", { pinned: true }], ["comment", { comment: "My private note" }]]) {
    assert.equal((await action(participant, operation, body)).status, 200);
  }
  assert.equal((await action(participant, "hide", { hidden: true, userId: "U_MINE" })).status, 200);
  assert.equal((await feed(participant)).rows[0].hidden, true);
  assert.equal((await feed(owner)).rows[0].hidden, false);
  assert.equal(getSlackThread("C_WORK", "100.000001").done_ms, 0);
  assert.equal(f.markerCalls.length, 0);
  recordSlackThreadParticipation("C_WORK", "100.000001", "U_MINE", String(Date.now() / 1000 + 1));
  assert.equal((await feed(participant)).rows[0].hidden, true, "other authors never restore this viewer");
  recordSlackThreadParticipation("C_WORK", "100.000001", "U_OTHER", "101.000001");
  assert.equal((await feed(participant)).rows[0].hidden, true, "old duplicate cannot undo Hide");
  recordSlackThreadParticipation("C_WORK", "100.000001", "U_OTHER", (Date.now() / 1000 + 2).toFixed(6));
  assert.equal((await feed(participant)).rows[0].hidden, false);
  assert.equal((await action(participant, "hide", { hidden: true })).status, 200);
  assert.equal((await action(participant, "hide", { hidden: false })).status, 200);
  assert.equal((await feed(participant)).rows[0].hidden, false);
  const bulk = await action(participant, "completion-all", { confirmed: true });
  assert.equal((await bulk.json()).marked, 0);
  setSlackThreadHidden("C_WORK", "100.000001", "U_MINE", true);
  const ownerBulk = await action(owner, "completion-all", { confirmed: true });
  assert.equal((await ownerBulk.json()).marked, 0, "bulk does not complete hidden work");
});

test("Hide requires participation, current private membership and CSRF", async (t) => {
  const f = await fixture(t);
  await f.root("G_PRIVATE", "100.000001", "U_MINE", true, "group");
  f.members.set("G_PRIVATE", ["U_MINE", "U_OTHER"]);
  const other = await f.login("U_OTHER");
  const hide = (body = {}, headers = other.post) => f.request(other.url + "/api/hide", { method: "POST", headers,
    body: JSON.stringify({ channelId: "G_PRIVATE", threadTs: "100.000001", hidden: true, ...body }) });
  assert.equal((await hide()).status, 403, "membership alone is not participation");
  recordSlackThreadParticipation("G_PRIVATE", "100.000001", "U_OTHER", "101.000001");
  assert.equal((await hide({}, { ...other.post, "X-CG-CSRF": "wrong" })).status, 403);
  assert.equal((await hide({}, { ...other.post, Origin: "https://other.example" })).status, 403);
  assert.equal((await hide({ hidden: "true" })).status, 400);
  assert.equal((await hide()).status, 200);
  f.members.set("G_PRIVATE", ["U_MINE"]);
  assert.equal((await hide({ hidden: false })).status, 403);
  assert.deepEqual((await (await f.request(other.url + "/api/threads", { headers: other.headers })).json()).rows, []);
});

test("participant streams receive personal Hide and Show immediately", async (t) => {
  const f = await fixture(t);
  await f.root();
  recordSlackThreadParticipation("C_WORK", "100.000001", "U_OTHER", "101.000001");
  const other = await f.login("U_OTHER");
  const stream = await f.request(other.url + "/stream", { headers: other.headers });
  const reader = stream.body.getReader(); t.after(() => reader.cancel());
  assert.equal((await nextEvent(reader)).rows[0].hidden, false);
  setSlackThreadHidden("C_WORK", "100.000001", "U_OTHER", true);
  assert.equal((await nextEvent(reader)).rows[0].hidden, true);
  setSlackThreadHidden("C_WORK", "100.000001", "U_OTHER", false);
  assert.equal((await nextEvent(reader)).rows[0].hidden, false);
});

test("shared Done stays on other participants' Active list while the actor's completion is personal", async (t) => {
  const f = await fixture(t);
  await f.root();
  recordSlackThreadParticipation("C_WORK", "100.000001", "U_OTHER", "101.000001");
  const owner = await f.login(), other = await f.login("U_OTHER");
  const save = (session, path, body) => f.request(session.url + "/api/" + path, { method: "POST", headers: session.post,
    body: JSON.stringify({ channelId: "C_WORK", threadTs: "100.000001", ...body }) });
  assert.equal((await save(owner, "completion", { done: true })).status, 200);
  const mine = (await (await f.request(owner.url + "/api/threads", { headers: owner.headers })).json()).rows[0];
  const theirs = (await (await f.request(other.url + "/api/threads", { headers: other.headers })).json()).rows[0];
  assert.equal(mine.status, "done"); assert.equal(mine.dismissed, true); assert.equal(mine.hidden, false);
  assert.equal(theirs.status, "done"); assert.equal(theirs.dismissed, false); assert.equal(theirs.hidden, false);
  assert.equal((await activityThreadSnapshot(f.client, "U_OTHER", { filter: "active" })).rows.length, 1);
  assert.equal((await activityThreadSnapshot(f.client, "U_MINE", { filter: "active" })).rows.length, 0);
  assert.equal((await save(other, "hide", { hidden: true })).status, 200);
  assert.equal((await activityThreadSnapshot(f.client, "U_OTHER", { filter: "active" })).rows.length, 0);
  assert.equal((await save(owner, "completion", { done: false })).status, 200);
  assert.equal((await activityThreadSnapshot(f.client, "U_MINE", { filter: "active" })).rows.length, 1);
  assert.equal((await activityThreadSnapshot(f.client, "U_OTHER", { filter: "active" })).rows.length, 0, "manual Hide survives global Reopen");
});

test("combined Activity lists linked Chat and Teams threads, isolates viewers and rechecks native access", async (t) => {
  const { registerTransport, unregisterTransport } = await import('../src/platforms/live.js');
  const { setActivityIdentities } = await import('../src/config/activity-identities.js');
  const { recordPlatformThreadMessage, getPlatformThread } = await import('../src/gateway/platform-threads.js');
  const f = await fixture(t);
  await f.root();
  const roster = new Map();
  const cases = [
    { platform: 'googlechat', user: 'users/COMBINED', channel: 'gchat:spaces/COMBINED', raw: 'spaces/COMBINED', thread: 'spaces/COMBINED/threads/ROOT', messageId: 'spaces/COMBINED/messages/ROOT', payload: { message: { threadReply: false, createTime: new Date().toISOString() } } },
    { platform: 'msteams', user: '29:COMBINED', channel: 'teams:19:COMBINED@thread.tacv2', raw: '19:COMBINED@thread.tacv2', thread: '123456789', messageId: '123456789', payload: { activity: { timestamp: new Date().toISOString() } } },
  ];
  t.after(() => { unregisterTransport('googlechat'); unregisterTransport('msteams'); });
  for (const c of cases) {
    await setUser(c.user, { approved: true, platform: c.platform, activityIdentities: [] });
    await upsertChannelEntry(c.channel, { name: c.platform, type: 'channel', platform: c.platform });
    const entry = await getChannelEntry(c.channel);
    await saveChannelMeta(entry.slug, { access: 'approved', isDM: false });
    roster.set(c.platform, [{ id: c.user }]);
    registerTransport(c.platform, { getConnector: () => ({ api: { listMembers: async () => roster.get(c.platform) } }) });
    recordPlatformThreadMessage({ slug: entry.slug, threadKey: c.thread, message: { platform: c.platform, conversationId: c.channel, rawConversationId: c.raw, userId: c.user, messageId: c.messageId, threadKey: c.thread, text: 'Combined platform work', kind: 'channel', trigger: 'message', raw: c.payload } });
  }
  const mine = await f.login(), other = await f.login('U_OTHER');
  const snapshot = async (login) => (await f.request(login.url + '/api/threads', { headers: login.headers })).json();
  assert.equal((await snapshot(mine)).rows.length, 1);
  await setActivityIdentities('U_MINE', cases.map(c => c.user));
  let data = await snapshot(mine);
  assert.equal(data.rows.length, 3);
  assert.deepEqual(new Set(data.rows.map(r => r.platform)), new Set(['slack', 'googlechat', 'msteams']));
  assert.equal((await snapshot(other)).rows.length, 0);
  for (const c of cases) {
    const row = data.rows.find(r => r.platform === c.platform);
    assert.equal(row.canComplete, true);
    const open = await f.request(row.url, { headers: mine.headers });
    assert.equal(open.status, 303);
    assert.equal(new URL(open.headers.get('location')).hostname, c.platform === 'googlechat' ? 'chat.google.com' : 'teams.microsoft.com');
    for (const [operation, extra] of [['hide', { hidden: true }], ['pin', { pinned: true }], ['comment', { comment: 'Private combined note' }], ['completion', { done: true }]]) {
      const body = JSON.stringify({ channelId: c.channel, threadTs: c.thread, ...extra });
      assert.equal((await f.request(mine.url + '/api/' + operation, { method: 'POST', headers: mine.post, body })).status, 200, operation);
      assert.equal((await f.request(other.url + '/api/' + operation, { method: 'POST', headers: other.post, body })).status, 403, operation);
    }
    assert.equal(getPlatformThread(c.channel, c.thread).status, 'done');
    const completed = (await snapshot(mine)).rows.find(r => r.platform === c.platform);
    assert.equal(completed.completedMs, getPlatformThread(c.channel, c.thread).done_ms);
  }
  roster.set('googlechat', []);
  data = await snapshot(mine);
  assert.equal(data.rows.some(r => r.platform === 'googlechat'), false);
  const target = cases[0];
  assert.equal((await f.request(mine.url + '/api/hide', { method: 'POST', headers: mine.post, body: JSON.stringify({ channelId: target.channel, threadTs: target.thread, hidden: false }) })).status, 403);
  await setActivityIdentities('U_MINE', []);
  assert.deepEqual((await snapshot(mine)).rows.map(r => r.platform), ['slack']);
});

async function linkedChatActivityFixture(t, { secondParticipant = false } = {}) {
  const { registerTransport, unregisterTransport } = await import('../src/platforms/live.js');
  const { setActivityIdentities } = await import('../src/config/activity-identities.js');
  const index = await import('../src/gateway/platform-threads.js');
  const f = await fixture(t);
  const starter = 'users/ACTIVITY_RACE_STARTER', participant = 'users/ACTIVITY_RACE_PARTICIPANT';
  const channel = 'gchat:spaces/ACTIVITY_RACE', raw = 'spaces/ACTIVITY_RACE', thread = raw + '/threads/ROOT';
  for (const user of [starter, participant]) await setUser(user, { approved: true, platform: 'googlechat', activityIdentities: [] });
  await upsertChannelEntry(channel, { name: 'Race fixture', type: 'channel', platform: 'googlechat' });
  const entry = await getChannelEntry(channel);
  await saveChannelMeta(entry.slug, { access: 'approved', isDM: false });
  const record = (user, root, at) => index.recordPlatformThreadMessage({ slug: entry.slug, threadKey: thread,
    message: { platform: 'googlechat', conversationId: channel, rawConversationId: raw, userId: user,
      messageId: raw + '/messages/' + (root ? 'ROOT' : 'REPLY'), threadKey: thread,
      text: root ? 'Owned by the second linked account' : 'First linked account participates', kind: 'channel', trigger: 'message',
      raw: { message: { threadReply: !root, createTime: new Date(at).toISOString() } } } });
  record(starter, true, Date.now());
  if (secondParticipant) record(participant, false, Date.now() + 1);
  await setActivityIdentities('U_MINE', secondParticipant ? [participant, starter] : [starter]);
  const members = [{ id: starter }, { id: participant }];
  let rosterRead = async () => members;
  registerTransport('googlechat', { getConnector: () => ({ api: { listMembers: (...args) => rosterRead(...args) } }) });
  t.after(() => unregisterTransport('googlechat'));
  const mine = await f.login();
  const action = (operation, extra) => f.request(mine.url + '/api/' + operation, { method: 'POST', headers: mine.post,
    body: JSON.stringify({ channelId: channel, threadTs: thread, ...extra }) });
  return { ...f, mine, channel, thread, starter, participant, index, action, setActivityIdentities,
    setRosterRead: read => { rosterRead = read; }, members };
}

test('combined Activity prefers the linked starter over an earlier linked participant for controls and personal state', async t => {
  const f = await linkedChatActivityFixture(t, { secondParticipant: true });
  const snapshot = async () => (await (await f.request(f.mine.url + '/api/threads', { headers: f.mine.headers })).json()).rows;
  const rows = await snapshot();
  assert.equal(rows.length, 1, 'one thread is deduplicated across linked accounts');
  assert.equal(rows[0].canComplete, true, 'the second linked account owns this root');
  assert.equal((await f.action('hide', { hidden: true })).status, 200);
  assert.equal(f.index.listPlatformThreadsForUser(f.starter)[0].hidden_ms > 0, true);
  assert.equal(f.index.listPlatformThreadsForUser(f.participant)[0].hidden_ms, 0, 'the first linked participant is not selected accidentally');
  assert.equal((await f.action('completion', { done: true })).status, 200);
  assert.equal(f.index.getPlatformThread(f.channel, f.thread).status, 'done');
  assert.equal(f.index.listPlatformThreadsForUser(f.starter)[0].dismissed_ms > 0, true);
  assert.equal(f.index.listPlatformThreadsForUser(f.participant)[0].dismissed_ms, 0);
});

for (const operation of ['hide', 'completion']) {
  for (const revocation of ['unlink', 'session expiry']) {
    test(`combined Activity ${operation} refuses ${revocation} during its final native roster read`, async t => {
      const f = await linkedChatActivityFixture(t);
      const beforeThread = f.index.getPlatformThread(f.channel, f.thread);
      const beforeParticipant = f.index.listPlatformThreadsForUser(f.starter)[0];
      const started = defer(), gate = defer();
      let reads = 0;
      const finalRead = operation === 'hide' ? 1 : 2;
      f.setRosterRead(async () => {
        reads++;
        if (reads === finalRead) { started.resolve(); await gate.promise; }
        return f.members;
      });
      const pending = f.action(operation, operation === 'hide' ? { hidden: true } : { done: true });
      await started.promise;
      if (revocation === 'unlink') await f.setActivityIdentities('U_MINE', []);
      else f.advance(ACTIVITY_SESSION_TTL_MS + 1);
      gate.resolve();
      assert.equal((await pending).status, revocation === 'unlink' ? 403 : 401);
      assert.deepEqual(f.index.getPlatformThread(f.channel, f.thread), beforeThread, 'denied operation does not change shared completion');
      assert.deepEqual(f.index.listPlatformThreadsForUser(f.starter)[0], beforeParticipant, 'denied operation does not change personal Hide or dismissal');
      assert.equal(reads >= finalRead, true);
    });
  }
}
