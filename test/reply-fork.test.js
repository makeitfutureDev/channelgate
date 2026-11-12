import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { setThreadSudo } = await import("../src/gateway/thread-engine.js");
const { FORK_ACTION_ID, registerReplyForkActions } = await import("../src/slack/reply-fork.js");

const OWNER = "U_FORK_OWNER";
const MEMBER = "U_FORK_MEMBER";
const ADMIN = "U_FORK_ADMIN";
const BOT = "U_FORK_BOT";
const TEAM = "T_FORK";
const CHANNEL = "C_FORK";
const THREAD = "1000.000001";
const SOURCE = "1000.000002";
const ACTION_TS = "2000.123456";
let slug;

beforeEach(async () => {
  const db = getDb();
  for (const table of ["thread_overrides", "channel_meta", "channels", "users"]) db.exec(`DELETE FROM ${table}`);
  await setUser(OWNER, { approved: true, isAdmin: false });
  await setUser(MEMBER, { approved: true, isAdmin: false });
  await setUser(ADMIN, { approved: true, isAdmin: true });
  const entry = await upsertChannelEntry(CHANNEL, { name: "fork", type: "channel", isDM: false });
  slug = entry.slug;
  await saveChannelMeta(slug, { channelId: CHANNEL, type: "channel", access: "approved" });
});

function harness({ processMessage, botUserId = BOT } = {}) {
  const actions = new Map();
  const views = new Map();
  const opened = [];
  const ephemeral = [];
  const dispatched = [];
  const members = new Set([OWNER, MEMBER]);
  const client = {
    views: { open: async (request) => { opened.push(request); return { ok: true }; } },
    chat: { postEphemeral: async (request) => { ephemeral.push(request); return { ok: true }; } },
    conversations: { members: async () => ({ members: [...members], response_metadata: {} }) },
  };
  registerReplyForkActions({ action: (id, handler) => actions.set(id, handler), view: (id, handler) => views.set(id, handler) },
    processMessage || (async (...args) => { dispatched.push(args); }), { botUserId, teamId: TEAM });
  return {
    actions, views, opened, ephemeral, dispatched, client, members,
    async open({ user = OWNER, channel = CHANNEL, owner = OWNER, mutate = () => {} } = {}) {
      let acknowledgements = 0;
      const body = { user: { id: user }, team: { id: TEAM }, channel: { id: channel },
        container: { channel_id: channel, message_ts: SOURCE },
        message: { user: BOT, ts: SOURCE, thread_ts: THREAD }, trigger_id: "trigger" };
      const action = { action_id: FORK_ACTION_ID, action_ts: ACTION_TS, value: JSON.stringify({ c: channel, t: THREAD, u: owner }) };
      mutate(body, action);
      await actions.get(FORK_ACTION_ID)({ ack: async () => { acknowledgements++; }, body, action, client });
      assert.equal(acknowledgements, 1);
      return opened.at(-1)?.view;
    },
    async submit(view, { user = OWNER, teamId = TEAM, message = "Take another approach" } = {}) {
      const acknowledgements = [];
      await views.get(view.callback_id)({ ack: async (response) => { acknowledgements.push(response); },
        body: { user: { id: user }, team: { id: teamId } },
        view: { ...view, state: { values: { fork_request: { message: { value: message } } } } }, client });
      assert.equal(acknowledgements.length, 1);
      return acknowledgements[0];
    },
  };
}

test("Fork opens a bounded form and dispatches the selected reply's cutoff under the clicker's identity", async () => {
  const h = harness();
  const view = await h.open();
  assert.equal(view.title.text, "Fork conversation");
  assert.match(view.private_metadata, /^[0-9a-f-]{36}$/);
  assert.equal(view.blocks[1].element.max_length, 6000);
  assert.equal(view.blocks[1].element.multiline, true);
  assert.match(view.blocks[0].text.text, /recent visible Slack messages through this reply/);
  assert.match(view.blocks[0].text.text, /Later messages and private tool history are excluded/);
  assert.match(view.blocks[0].text.text, /Files and channel memory remain shared/);
  await h.submit(view, { message: "  Explore a second approach\nwith examples  " });
  assert.equal(h.dispatched.length, 1);
  assert.deepEqual(h.dispatched[0][0], { type: "message", channel: CHANNEL, channel_type: "channel", user: OWNER,
    thread_ts: THREAD, ts: ACTION_TS, text: "/fork Explore a second approach\nwith examples", files: [] });
  assert.equal(h.dispatched[0][1], h.client);
  assert.deepEqual(h.dispatched[0][2], { botUserId: BOT, teamId: TEAM, bypassMention: true, forkMessageTs: SOURCE });
});

test("reply owner binding rejects other members and permits an authorized admin as themselves", async () => {
  const h = harness();
  assert.equal(await h.open({ user: MEMBER }), undefined);
  assert.match(h.ephemeral[0].text, /not authorized/);
  const view = await h.open({ user: ADMIN });
  await h.submit(view, { user: ADMIN });
  assert.equal(h.dispatched[0][0].user, ADMIN);
});

test("unbound automation buttons admit an approved member", async () => {
  const h = harness();
  const view = await h.open({ owner: "", user: MEMBER });
  await h.submit(view, { user: MEMBER });
  assert.equal(h.dispatched[0][0].user, MEMBER);
});

test("an unthreaded bot reply with an empty footer thread binding uses its own timestamp", async () => {
  const h = harness();
  const view = await h.open({ mutate: (body, action) => {
    delete body.message.thread_ts;
    action.value = JSON.stringify({ c: CHANNEL, t: "", u: OWNER });
  } });
  await h.submit(view);
  assert.equal(h.dispatched[0][0].thread_ts, SOURCE);
  assert.equal(h.dispatched[0][2].forkMessageTs, SOURCE);
});

test("empty footer thread bindings cannot replace an actual parent thread", async () => {
  const h = harness();
  await h.open({ mutate: (_body, action) => {
    action.value = JSON.stringify({ c: CHANNEL, t: "", u: OWNER });
  } });
  assert.equal(h.opened.length, 0);
});

test("code-channel buttons give an explicit refusal for top-level and threaded replies", async () => {
  const channel = "C_FORK_CODE";
  const entry = await upsertChannelEntry(channel, { name: "fork-code", type: "channel" });
  await saveChannelMeta(entry.slug, { channelId: channel, access: "approved", codeChannel: { originSlug: slug } });
  for (const threaded of [false, true]) {
    const h = harness();
    await h.open({ channel, mutate: (body, action) => {
      if (!threaded) {
        delete body.message.thread_ts;
        action.value = JSON.stringify({ c: channel, t: "", u: OWNER });
      }
    } });
    assert.equal(h.opened.length, 0);
    assert.match(h.ephemeral[0].text, /Code channels share one session/);
    assert.equal(h.dispatched.length, 0);
  }
});

test("forged channels, teams, thread cutoffs and non-bot messages cannot open a Fork form", async (t) => {
  const cases = [
    ["command channel", (_body, action) => { action.value = JSON.stringify({ c: "C_OTHER", t: THREAD, u: OWNER }); }],
    ["envelope channel", (body) => { body.container.channel_id = "C_OTHER"; }],
    ["team", (body) => { body.team.id = "T_OTHER"; }],
    ["missing team", (body) => { delete body.team; }],
    ["thread", (_body, action) => { action.value = JSON.stringify({ c: CHANNEL, t: "9999.000001", u: OWNER }); }],
    ["source timestamp", (body) => { body.container.message_ts = "9999.000001"; }],
    ["author", (body) => { body.message.user = MEMBER; }],
    ["invalid timestamp", (_body, action) => { action.action_ts = "2000.1;secret"; }],
    ["malformed value", (_body, action) => { action.value = "sensitive-invalid-json"; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const h = harness();
    assert.equal(await h.open({ mutate }), undefined);
    assert.equal(h.opened.length, 0);
    assert.equal(h.ephemeral.length, 1);
    assert.doesNotMatch(h.ephemeral[0].text, /sensitive-invalid-json|secret/);
    assert.equal(h.dispatched.length, 0);
  });
});

test("private Slack membership is checked for members and admins", async () => {
  const channel = "G_FORK";
  const entry = await upsertChannelEntry(channel, { name: "private-fork", type: "group" });
  await saveChannelMeta(entry.slug, { channelId: channel, type: "group", access: "approved" });
  const h = harness();
  h.members.clear();
  assert.equal(await h.open({ channel }), undefined);
  assert.equal(await h.open({ channel, user: ADMIN }), undefined);
  assert.equal(h.opened.length, 0);
  h.members.add(OWNER);
  const view = await h.open({ channel });
  await h.submit(view);
  assert.equal(h.dispatched[0][0].channel_type, "group");
});

test("live approval and channel authorization are checked again on submission", async (t) => {
  for (const kind of ["user", "channel", "admin", "membership"]) await t.test(kind, async () => {
    const h = harness();
    const user = kind === "admin" ? ADMIN : OWNER;
    let channel = CHANNEL;
    if (kind === "membership") {
      channel = "G_REVOKED";
      const entry = await upsertChannelEntry(channel, { name: "revoked", type: "group" });
      await saveChannelMeta(entry.slug, { channelId: channel, access: "approved" });
    }
    const view = await h.open({ user, channel });
    if (kind === "user") await setUser(OWNER, { approved: false });
    if (kind === "channel") await saveChannelMeta(slug, { channelId: CHANNEL, access: "none" });
    if (kind === "admin") await setUser(ADMIN, { isAdmin: false });
    if (kind === "membership") h.members.clear();
    await h.submit(view, { user });
    assert.equal(h.dispatched.length, 0);
    assert.match(h.ephemeral.at(-1).text, /not authorized/);
    await setUser(OWNER, { approved: true });
    await setUser(ADMIN, { isAdmin: true });
    await saveChannelMeta(slug, { channelId: CHANNEL, access: "approved" });
  });
});

test("sudo sources are refused for admins on both opening and submission", async () => {
  const h = harness();
  await setThreadSudo(slug, THREAD, true);
  assert.equal(await h.open({ user: ADMIN }), undefined);
  assert.match(h.ephemeral.at(-1).text, /sudo thread cannot be forked/);
  await setThreadSudo(slug, THREAD, false);
  const view = await h.open({ user: ADMIN });
  await setThreadSudo(slug, THREAD, true);
  await h.submit(view, { user: ADMIN });
  assert.equal(h.dispatched.length, 0);
  assert.match(h.ephemeral.at(-1).text, /sudo thread cannot be forked/);
});

test("a modal cannot be submitted by another user or team and blank input can be corrected", async () => {
  const h = harness();
  const view = await h.open();
  assert.equal((await h.submit(view, { user: MEMBER })).response_action, "errors");
  assert.equal((await h.submit(view, { teamId: "T_OTHER" })).response_action, "errors");
  assert.equal((await h.submit(view, { message: " \n " })).response_action, "errors");
  assert.equal((await h.submit(view, { message: "x".repeat(6001) })).response_action, "errors");
  assert.equal(h.dispatched.length, 0);
  await h.submit(view);
  assert.equal(h.dispatched.length, 1);
});

test("concurrent duplicate submissions consume one token and dispatch once", async () => {
  const h = harness();
  const view = await h.open();
  const results = await Promise.all([h.submit(view), h.submit(view)]);
  assert.equal(h.dispatched.length, 1);
  assert.equal(results.filter((result) => result?.response_action === "errors").length, 1);
});

test("expired forms cannot dispatch", async (t) => {
  const h = harness();
  const view = await h.open();
  const later = Date.now() + 15 * 60_000;
  t.mock.method(Date, "now", () => later);
  assert.equal((await h.submit(view)).response_action, "errors");
  assert.equal(h.dispatched.length, 0);
});

test("abandoned forms are bounded to 500 and evict the oldest token", async () => {
  const h = harness();
  const oldest = await h.open();
  for (let i = 0; i < 500; i++) await h.open();
  assert.equal((await h.submit(oldest)).response_action, "errors");
  await h.submit(h.opened.at(-1).view);
  assert.equal(h.dispatched.length, 1);
});

test("a failed modal open invalidates its draft and hides the underlying error", async () => {
  const h = harness();
  h.client.views.open = async (request) => {
    h.opened.push(request);
    throw new Error("private-trigger-and-api-key");
  };
  const view = await h.open();
  assert.equal((await h.submit(view)).response_action, "errors");
  assert.match(h.ephemeral[0].text, /Couldn't open Fork/);
  assert.doesNotMatch(h.ephemeral[0].text, /private-trigger-and-api-key/);
});

test("failed dispatches report a fixed error without exposing API payloads", async () => {
  const h = harness({ processMessage: async () => { throw new Error("api-key-and-private-message"); } });
  const view = await h.open();
  await h.submit(view);
  assert.match(h.ephemeral.at(-1).text, /Couldn't start the fork/);
  assert.doesNotMatch(h.ephemeral.at(-1).text, /api-key-and-private-message/);
  assert.equal((await h.submit(view)).response_action, "errors");
});
