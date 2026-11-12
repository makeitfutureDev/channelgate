import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { request as httpRequest } from "node:http";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { setUser, getUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { indexSlackThread, getSlackThread, setSlackThreadDone, recordSlackThreadOutcome } = await import("../src/gateway/slack-threads.js");
const { registerAgentInterfaceHandlers } = await import("../src/slack/agent-interface.js");
const { setThreadSudo } = await import("../src/gateway/thread-engine.js");
const { activityThreadSnapshot } = await import("../src/slack/home-threads.js");
const { recordActiveRun, clearActiveRun } = await import("../src/gateway/active-runs.js");
const { activityHomeActions } = await import("../src/slack/home-activity.js");
const { handleReplyDashboardAction, registerReplyDashboardActions, REPLY_DASHBOARD_ACTION_ID } = await import("../src/slack/reply-dashboard.js");
const { menuButtons } = await import("../src/slack/footer.js");
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests, ACTIVITY_GRANT_TTL_MS, ACTIVITY_SESSION_TTL_MS } = await import("../src/web/activity.js");

beforeEach(async () => {
  resetActivityStateForTests();
  for (const table of ["slack_threads", "sessions", "channels", "channel_meta", "active_runs", "bg_jobs", "question_requests", "approval_requests", "followup_threads", "followup_done", "thread_overrides"]) getDb().exec(`DELETE FROM ${table}`);
  await setUser("U_MINE", { approved: true, isAdmin: false });
  await setUser("U_OTHER", { approved: true, isAdmin: false });
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
  let buffer = "";
  const timer = setTimeout(() => reader.cancel(), 2500);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`SSE ended before ${event}`);
      buffer += new TextDecoder().decode(value);
      for (const frame of buffer.split("\n\n").slice(0, -1)) {
        if (frame.includes(`event: ${event}\n`)) return JSON.parse(frame.split("data: ")[1]);
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
    }
  } finally { clearTimeout(timer); }
}

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

test("launch fragment is removed before reusable exchange; cookies, origin and expiry fail closed", async (t) => {
  const f = await fixture(t), url = f.grant();
  assert.ok(new URL(url).hash);
  const launch = await f.request("/activity/open");
  assert.equal(launch.status, 200);
  assert.equal(launch.headers.get("referrer-policy"), "no-referrer");
  const html = await launch.text(), script = /<script nonce="[^"]+">([\s\S]+?)<\/script>/.exec(html)[1];
  assert.doesNotMatch(html, /already used/i);
  const calls = [];
  await new Function("location", "history", "fetch", "document", `return ${script}`)(
    { hash: new URL(url).hash, pathname: "/activity/open", replace: (value) => calls.push(value) },
    { replaceState: () => calls.push("cleared") },
    async (path, init) => { assert.equal(calls[0], "cleared"); calls.push(path); return f.request(path, { ...init, headers: { ...init.headers, Origin: f.base } }); },
    { getElementById: () => ({ textContent: "" }) });
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
  assert.equal(open.status, 303); assert.match(open.headers.get("location"), /^https:\/\/example.slack.com\/archives\//);
  assert.equal((await f.request(user.url + "/open/C_OTHER/102.000001", { headers: user.headers })).status, 403);
  assert.match(user.html, /<table/);
  f.setTeam("T_DIFFERENT");
  assert.equal((await f.request(user.url + "/api/threads", { headers: user.headers })).status, 403);
});

test("Open thread targets the newest exact reply on each click and includes its conversation context", async (t) => {
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
    assert.equal(target.pathname, "/archives/C_WORK/p" + latest.replace(".", ""));
    assert.equal(target.searchParams.get("thread_ts"), root.ts);
    assert.equal(target.searchParams.get("cid"), "C_WORK");
    assert.deepEqual(linkCalls.at(-1), { channel: "C_WORK", message_ts: latest });
  }
  assert.deepEqual(calls, Array(2).fill({ channel: "C_WORK", ts: root.ts, limit: 1 }), "one root lookup per click even with hundreds of replies");
  delete root.latest_reply; root.reply_count = 0;
  const response = await f.request(url, { headers: user.headers });
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get("location"));
  assert.equal(target.pathname, "/archives/C_WORK/p100000001");
  assert.equal(target.searchParams.get("thread_ts"), root.ts, "empty thread still opens its conversation pane");
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
  assert.equal(target.pathname, "/archives/C_WORK/p102123457");
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
  test(`${engine} durable run events push Working/Waiting and restore completion without polling`, async (t) => {
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
    assert.equal((await nextEvent(reader)).rows[0].status, "working");
    recordActiveRun("activity-live", { ...run, awaitingChoice: true });
    assert.equal((await nextEvent(reader)).rows[0].status, "waiting");
    clearActiveRun("activity-live");
    assert.equal((await nextEvent(reader)).rows[0].status, "done");
    assert.equal(getSlackThread("C_WORK", "100.000001").done_ms, doneAt);
    setSlackThreadDone("C_WORK", "100.000001", "U_MINE", false);
    assert.equal((await nextEvent(reader)).rows[0].status, "idle");
    recordActiveRun("activity-live", run);
    assert.equal((await nextEvent(reader)).rows[0].status, "working");
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
