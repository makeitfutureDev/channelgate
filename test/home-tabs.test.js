import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { HOME_TABS, buildHomeTabView, createHomePublisher, registerHomeTabActions, registerHomeActions } = await import("../src/slack/home-tabs.js");
const { setUser, getUser } = await import("../src/config/store.js");
const { COMPOSIO_HOME_CLEAR_ACTION, COMPOSIO_HOME_MODAL, COMPOSIO_TOKEN_BLOCK, COMPOSIO_TOKEN_INPUT } = await import("../src/slack/home-composio.js");
const { NUDGE_HOME_TOGGLE_ACTION } = await import("../src/slack/home-nudges.js");

function fakeApp() {
  const actions = new Map(); const views = new Map();
  return { actions, views, action: (id, fn) => actions.set(String(id), fn), view: (id, fn) => views.set(id, fn),
    actionFor(id) { return [...actions].find(([key]) => key === id || (key.startsWith("/") && new RegExp(key.slice(1, key.lastIndexOf("/"))).test(id)))?.[1]; } };
}

test("Activity is the default and every section loads only its selected content", async () => {
  for (const tab of [undefined, "invalid", "__proto__", ...Object.keys(HOME_TABS)]) {
    const loaded = [];
    const sections = Object.fromEntries(Object.keys(HOME_TABS).map((name) => [name, async () => {
      loaded.push(name); return [{ type: "section", text: { type: "mrkdwn", text: `CONTENT:${name}` } }];
    }]));
    const view = await buildHomeTabView({ tab, userId: "U_VIEWER", role: "approved", sections, footer: ["version"] });
    const expected = Object.hasOwn(HOME_TABS, tab) ? tab : "activity";
    assert.deepEqual(loaded, [expected]);
    const nav = view.blocks.find((block) => block.type === "actions").elements;
    assert.deepEqual(nav.map((e) => e.text.text), ["Activity", "Connections", "Skills", "Channels", "Help & settings"]);
    assert.deepEqual(nav.filter((e) => e.style === "primary").map((e) => e.value), [expected]);
    assert.deepEqual(JSON.parse(view.private_metadata), { tab: expected });
    assert.equal(view.blocks.filter((b) => b.text?.text?.startsWith("CONTENT:")).length, 1);
    assert.equal(view.blocks.some((b) => b.type === "context" && b.elements?.[0]?.text === "version"), expected === "help");
  }
});

test("the private dashboard launch follows Help in the Activity navigation row only", async () => {
  const { activityHomeActions } = await import("../src/slack/home-activity.js");
  const launch = activityHomeActions({ ownerId: "U_VIEWER", teamId: "T_WORK", baseUrl: "https://dashboard.example", approved: true });
  for (const tab of [undefined, ...Object.keys(HOME_TABS)]) {
    const view = await buildHomeTabView({ tab, userId: "U_VIEWER", role: "approved", activityActions: launch,
      sections: Object.fromEntries(Object.keys(HOME_TABS).map((key) => [key, async () => []])) });
    const rows = view.blocks.filter((block) => block.type === "actions");
    assert.equal(rows.length, 1, "launch must not occupy a separate row");
    const nav = rows[0].elements;
    const activity = !tab || tab === "activity";
    assert.equal(nav.length, activity ? 6 : 5);
    assert.equal(nav[4].text.text, "Help & settings");
    if (activity) {
      assert.equal(nav[5].action_id, "cg_activity_open");
      assert.equal(nav[5].text.text, "Open live dashboard");
      assert.equal(nav[5].url, launch[0].url, "preserve the private launch grant");
    }
  }
  assert.deepEqual(activityHomeActions({ ownerId: "U_VIEWER", teamId: "T_WORK", baseUrl: "", approved: true }), []);
  assert.deepEqual(activityHomeActions({ ownerId: "U_VIEWER", teamId: "T_WORK", baseUrl: "https://dashboard.example", approved: false }), []);
});

test("tab clicks acknowledge first and publish only for the authenticated clicking viewer", async () => {
  const app = fakeApp(); const calls = [];
  registerHomeTabActions(app, { publishHome: async (_client, userId, state) => calls.push({ userId, state }) });
  for (const [userId, tab] of [["U_ONE", "skills"], ["U_TWO", "channels"], ["U_ONE", "connections"]]) {
    let acked = false;
    await app.actionFor(`cg_home_tab_${tab}`)({ ack: async () => { acked = true; }, body: { user: { id: userId }, userId: "U_FORGED" },
      action: { action_id: `cg_home_tab_${tab}`, value: tab }, client: {} });
    assert.equal(acked, true);
  }
  assert.deepEqual(calls, [
    { userId: "U_ONE", state: { tab: "skills" } }, { userId: "U_TWO", state: { tab: "channels" } },
    { userId: "U_ONE", state: { tab: "connections" } },
  ]);
  for (const [userId, id, value] of [["", "activity", "activity"], ["U_ONE", "activity", "connections"], ["U_ONE", "activity", "__proto__"]]) {
    await app.actionFor("cg_home_tab_activity")({ ack: async () => {}, body: { user: { id: userId } }, action: { action_id: `cg_home_tab_${id}`, value }, client: {} });
  }
  assert.equal(calls.length, 3, "invalid and mismatched navigation cannot publish");
});

test("Composio stays on Connections, reminders on Help & settings, and thread controls on Activity", async () => {
  const app = fakeApp(); const calls = [];
  registerHomeActions(app, { publishHome: async (_client, userId, state = {}) => {
    calls.push({ userId, tab: state.tab || "activity", filter: state.filter });
  } });
  await setUser("U_TAB_SELF", { approved: true, composioToken: "fixture-key-123" });
  await setUser("U_TAB_OTHER", { approved: true, composioToken: "other-key-123" });
  await app.actionFor(COMPOSIO_HOME_CLEAR_ACTION)({ ack: async () => {}, body: { user: { id: "U_TAB_SELF" } }, client: {} });
  assert.equal((await getUser("U_TAB_SELF")).composioToken, "");
  assert.equal((await getUser("U_TAB_OTHER")).composioToken, "other-key-123");
  await app.views.get(COMPOSIO_HOME_MODAL)({ ack: async () => {}, body: { user: { id: "U_TAB_SELF" } }, client: {}, view: {
    state: { values: { [COMPOSIO_TOKEN_BLOCK]: { [COMPOSIO_TOKEN_INPUT]: { value: "saved-fixture-123" } } } },
  } });
  await app.actionFor(NUDGE_HOME_TOGGLE_ACTION)({ ack: async () => {}, body: { user: { id: "U_TAB_SELF" } }, action: { value: "on" }, client: {} });
  await app.actionFor("cg_home_threads_filter")({ ack: async () => {}, body: { user: { id: "U_TAB_SELF" } },
    action: { action_id: "cg_home_threads_filter", selected_option: { value: "done" } }, client: {} });
  assert.deepEqual(calls.map((c) => c.tab), ["connections", "connections", "help", "activity"]);
  assert.ok(calls.every((c) => c.userId === "U_TAB_SELF"));
  assert.equal(calls.at(-1).filter, "done");
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("a slow obsolete Activity render cannot overwrite a newer selected tab or another viewer", async () => {
  const waiting = deferred(); const published = [];
  const publish = createHomePublisher(async (_client, _userId, state) => {
    if (state.tab === "activity") await waiting.promise;
    return { type: "home", private_metadata: state.tab };
  });
  const client = { views: { publish: async (value) => { published.push(value); } } };
  const old = publish(client, "U_SLOW", { tab: "activity" });
  await publish(client, "U_SLOW", { tab: "connections" });
  await publish(client, "U_OTHER", { tab: "skills" });
  waiting.resolve();
  assert.equal(await old, false);
  assert.deepEqual(published.map((p) => [p.user_id, p.view.private_metadata]), [["U_SLOW", "connections"], ["U_OTHER", "skills"]]);
});

test("in-flight publications are serialized per viewer and a failed write does not block later tabs", async () => {
  const firstStarted = deferred(); const firstFinish = deferred(); const sent = [];
  const client = { views: { publish: async ({ view }) => {
    sent.push(view.private_metadata);
    if (sent.length === 1) { firstStarted.resolve(); await firstFinish.promise; throw new Error("temporary publish failure"); }
  } } };
  const publish = createHomePublisher(async (_client, _userId, state) => ({ type: "home", private_metadata: state.tab }));
  const first = publish(client, "U_SERIAL", { tab: "activity" }).catch((error) => error.message);
  await firstStarted.promise;
  const second = publish(client, "U_SERIAL", { tab: "channels" });
  assert.deepEqual(sent, ["activity"]);
  firstFinish.resolve();
  assert.equal(await first, "temporary publish failure");
  assert.equal(await second, true);
  assert.deepEqual(sent, ["activity", "channels"]);
});

function fakeTimers() {
  const pending = new Map();
  return {
    pending,
    setTimer(fn, ms) { const timer = { unref() {} }; pending.set(timer, { fn, ms }); return timer; },
    clearTimer(timer) { pending.delete(timer); },
    async tick() {
      const [timer, { fn }] = pending.entries().next().value;
      pending.delete(timer); await fn();
    },
  };
}

test("Activity refreshes changed state automatically, preserves filter/page, and leaves unchanged pages alone", async () => {
  const timers = fakeTimers(); let key = "working"; const rendered = []; const sent = [];
  const publish = createHomePublisher(async (_c, user, state) => { rendered.push({ user, ...state }); return { status: key }; },
    { ...timers, refreshKey: () => key });
  const client = { views: { publish: async ({ view }) => sent.push(view.status) } };
  await publish(client, "U_ONE", { filter: "working", page: 2 });
  assert.equal([...timers.pending.values()][0].ms, 15000);
  await timers.tick();
  assert.equal(rendered.length, 1, "unchanged state does not read history or republish");
  key = "idle"; await timers.tick();
  assert.deepEqual(sent, ["working", "idle"]);
  assert.deepEqual(rendered[1], { user: "U_ONE", filter: "working", page: 2 });
  assert.equal(timers.pending.size, 1);
  await publish.stop(); assert.equal(timers.pending.size, 0);
});

test("navigation during an automatic render discards that render and stops Activity refresh", async () => {
  const timers = fakeTimers(); const started = deferred(); const finish = deferred(); const sent = []; let key = 1;
  const publish = createHomePublisher(async (_c, _u, state) => {
    if (key === 2 && !state.tab) { started.resolve(); await finish.promise; }
    return { tab: state.tab || "activity" };
  }, { ...timers, refreshKey: () => key });
  const client = { views: { publish: async ({ view }) => sent.push(view.tab) } };
  await publish(client, "U_ONE"); key = 2;
  const tick = timers.tick(); await started.promise;
  assert.equal(timers.pending.size, 0, "a slow refresh cannot overlap another timer");
  await publish(client, "U_ONE", { tab: "help" });
  finish.resolve(); await tick;
  assert.deepEqual(sent, ["activity", "help"]);
  assert.equal(timers.pending.size, 0);
  await publish.stop();
});

test("explicit history/Refresh options are consumed once and never repeated by automatic updates", async () => {
  const timers = fakeTimers(); let key = 1; const states = [];
  const publish = createHomePublisher(async (_client, _user, state) => { states.push(state); return {}; }, {
    ...timers, refreshKey: () => key,
    refreshState: ({ forceThreads: _force, discoverThreads: _discover, ...state }) => state,
  });
  const client = { views: { publish: async () => {} } };
  await publish(client, "U_ONE", { filter: "idle", page: 1, forceThreads: true, discoverThreads: true });
  key++; await timers.tick();
  assert.deepEqual(states[1], { filter: "idle", page: 1 });
  await publish.stop();
});

test("an unavailable Activity snapshot retries unchanged local state until Slack reads recover", async () => {
  const timers = fakeTimers(); let unavailable = true; let renders = 0; const sent = [];
  const publish = createHomePublisher(async () => {
    renders++;
    let failedSnapshot = false;
    return buildHomeTabView({ tab: "activity", userId: "U_ONE", role: "approved", needsActivityRetry: () => failedSnapshot,
      sections: { activity: async () => {
        failedSnapshot = unavailable;
        return [{ type: "section", text: { type: "mrkdwn", text: unavailable ? "Unavailable" : "Recovered" } }];
      } } });
  }, { ...timers, refreshKey: () => "unchanged local state" });
  const client = { views: { publish: async ({ view }) => sent.push(view) } };
  await publish(client, "U_ONE"); await timers.tick();
  assert.equal(renders, 2, "fallback or partial data does not become a stable baseline");
  unavailable = false; await timers.tick(); assert.equal(renders, 3);
  assert.ok(JSON.stringify(sent.at(-1)).includes("Recovered"));
  await timers.tick(); assert.equal(renders, 3, "successful recovery stops repeated Slack reads");
  await publish.stop();
});

test("automatic refresh retries lookup, render and publish failures without accepting stale state", async () => {
  for (const failure of ["lookup", "render", "publish"]) {
    const timers = fakeTimers(); let key = 1; let fail = false; const sent = [];
    const publish = createHomePublisher(async () => {
      if (fail && failure === "render") { fail = false; throw new Error("temporary render failure"); }
      return { key };
    }, { ...timers, refreshKey: () => {
      if (fail && failure === "lookup") { fail = false; throw new Error("temporary key failure"); }
      return key;
    } });
    const client = { views: { publish: async ({ view }) => {
      if (fail && failure === "publish") { fail = false; throw new Error("temporary API failure"); }
      sent.push(view.key);
    } } };
    await publish(client, "U_ONE"); key = 2; fail = true;
    await timers.tick(); assert.equal(timers.pending.size, 1);
    await timers.tick(); assert.deepEqual(sent, [1, 2]);
    await publish.stop();
  }
});

test("pausing Messages or evicting observers cancels timers and preserves in-flight per-viewer write order", async () => {
  const timers = fakeTimers(); const started = deferred(); const finish = deferred(); const sent = [];
  const publish = createHomePublisher(async (_c, user, state) => ({ user, tab: state.tab || "activity" }),
    { ...timers, maxViewers: 1, refreshKey: () => "state" });
  const client = { views: { publish: async ({ view }) => {
    sent.push(view);
    if (sent.length === 1) { started.resolve(); await finish.promise; }
  } } };
  const first = publish(client, "U_ONE"); await started.promise;
  publish.pause("U_ONE");
  const second = publish(client, "U_ONE", { tab: "channels" });
  await Promise.resolve(); assert.equal(sent.length, 1);
  finish.resolve(); await Promise.all([first, second]);
  assert.deepEqual(sent.map((v) => v.tab), ["activity", "channels"]);
  await publish(client, "U_ONE"); assert.equal(timers.pending.size, 1);
  await publish(client, "U_TWO"); assert.equal(timers.pending.size, 1, "old observer is evicted");
  publish.pause("U_TWO"); assert.equal(timers.pending.size, 0);
  await publish.stop(); assert.equal(await publish(client, "U_THREE"), false);
});
