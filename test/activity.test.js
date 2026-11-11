import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { request as httpRequest } from "node:http";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { setUser, upsertChannelEntry, getChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { indexSlackThread, getSlackThread, setSlackThreadDone, recordSlackThreadOutcome } = await import("../src/gateway/slack-threads.js");
const { setThreadSudo } = await import("../src/gateway/thread-engine.js");
const { activityThreadSnapshot } = await import("../src/slack/home-threads.js");
const { activityHomeBlocks } = await import("../src/slack/home-activity.js");
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
    const notice = "This link expires in 10 minutes.";
    assert.equal(post.text, notice);
    assert.equal(post.blocks[0].text.text, notice);
    assert.doesNotMatch(JSON.stringify(post), /only once|just once|one.use|single.use/i);
    const url = post.blocks[1].elements[0].url;
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
  const client = { conversations: {
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
  return { base, client, request, grant, exchange, login, root, roots, members, reads,
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
  const blocks = activityHomeBlocks({ ownerId: "U_MINE", teamId: "T_WORK", baseUrl: f.base, approved: true });
  assert.equal(blocks[0].elements[0].text.text, "Open live dashboard");
  assert.equal(activityHomeBlocks({ ownerId: "U_MINE", teamId: "T_WORK", baseUrl: f.base, approved: false }).length, 0);
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
