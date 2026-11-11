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
    assert.deepEqual(nav.map((e) => e.text.text), ["Activity", "Connections", "Skills", "Channels"]);
    assert.deepEqual(nav.filter((e) => e.style === "primary").map((e) => e.value), [expected]);
    assert.deepEqual(JSON.parse(view.private_metadata), { tab: expected });
    assert.equal(view.blocks.filter((b) => b.text?.text?.startsWith("CONTENT:")).length, 1);
  }
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

test("Composio save/disconnect stay on Connections; reminders and thread controls stay on Activity", async () => {
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
  assert.deepEqual(calls.map((c) => c.tab), ["connections", "connections", "activity", "activity"]);
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
