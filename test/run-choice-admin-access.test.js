import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

const { setUser, upsertChannelEntry, saveChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const { getPendingRunChoice } = await import("../src/gateway/active-runs.js");
const { readEvents } = await import("../src/util/logger.js");
const { busyThreadChoices, handleBusyThreadChoice, BUSY_THREAD_QUEUE_ACTION, BUSY_THREAD_STEER_ACTION, BUSY_THREAD_CANCEL_ACTION } = await import("../src/slack/busy-thread-choice.js");
const { engineSwitchChoices, handleEngineSwitchChoice, ENGINE_SWITCH_ACTION, ENGINE_RETRY_ACTION } = await import("../src/slack/engine-switch-choice.js");

const OWNER = "U_RUN_CHOICE_OWNER";
const ADMIN = "U_RUN_CHOICE_ADMIN";
const MEMBER = "U_RUN_CHOICE_MEMBER";
const CHANNEL = "C_RUN_CHOICE_ADMIN";
const entry = await upsertChannelEntry(CHANNEL, { name: "run-choice-admin", type: "channel", isDM: false });

async function fixture(kind, actionId) {
  await setUser(OWNER, { approved: true, isAdmin: false });
  await setUser(ADMIN, { approved: true, isAdmin: true });
  await setUser(MEMBER, { approved: true, isAdmin: false });
  const meta = defaultChannelMeta({ channelId: CHANNEL, name: entry.name, type: "channel", isDM: false, platform: "slack" });
  await saveChannelMeta(entry.slug, meta);
  const event = { type: "message", user: OWNER, channel: CHANNEL, channel_type: "channel", thread_ts: randomUUID(), ts: randomUUID(), text: "Private pending message" };
  const options = { botUserId: "U_RUN_CHOICE_BOT", teamId: "T_RUN_CHOICE", bypassMention: true, busyTargetRunId: "original-run" };
  const store = kind === "busy_thread" ? busyThreadChoices : engineSwitchChoices;
  const handler = kind === "busy_thread" ? handleBusyThreadChoice : handleEngineSwitchChoice;
  const id = store.create({ event, options, ask: { failedEngine: "claude", otherEngine: "codex", kind: "transient" } });
  store.noteCard(id, "card.ts");
  const log = { calls: [], notices: [], updates: [], deletes: [] };
  const control = { members: [OWNER, ADMIN, MEMBER] };
  const client = {
    conversations: { members: async () => ({ members: control.members }) },
    chat: {
      update: async (payload) => { log.updates.push(payload); },
      delete: async (payload) => { log.deletes.push(payload); },
      postEphemeral: async (payload) => { log.notices.push(payload); },
    },
  };
  const click = async ({ user = ADMIN, channel = CHANNEL } = {}) => {
    let acked = 0;
    const result = await handler({ ack: async () => { acked++; }, client,
      action: { action_id: actionId, value: id }, body: { user: { id: user }, channel: { id: channel }, message: { ts: "card.ts", thread_ts: event.thread_ts } } }, {
      processMessage: async (receivedEvent, receivedClient, receivedOptions) => {
        assert.equal(receivedClient, client);
        log.calls.push({ event: receivedEvent, options: receivedOptions });
        const accept = receivedOptions.onBusyChoiceAccepted || receivedOptions.onEngineChoiceAccepted;
        assert.equal(accept({ runId: randomUUID(), rec: { channelId: CHANNEL, authorId: OWNER, slug: entry.slug, threadKey: event.thread_ts, text: event.text } }), true);
      },
    });
    assert.equal(acked, 1);
    return result;
  };
  const audit = () => readEvents().filter((row) => row.event === "run_choice_admin_action" && row.choiceId === id);
  return { id, kind, event, options, meta, store, control, log, client, click, audit };
}

for (const [kind, action, choice] of [
  ["busy_thread", BUSY_THREAD_STEER_ACTION, "steer"],
  ["busy_thread", BUSY_THREAD_QUEUE_ACTION, "queue"],
  ["busy_thread", BUSY_THREAD_CANCEL_ACTION, "cancel"],
  ["engine_switch", ENGINE_SWITCH_ACTION, "switch"],
  ["engine_switch", ENGINE_RETRY_ACTION, "retry"],
]) {
  test(`admin can choose ${kind} ${choice} while preserving the original request identity`, async () => {
    const f = await fixture(kind, action);
    const result = await f.click();
    assert.equal(result.ok, true);
    assert.equal(result.choice, choice);
    assert.equal(getPendingRunChoice(f.id), null);
    assert.equal(f.log.calls.length, choice === "cancel" ? 0 : 1);
    if (choice !== "cancel") {
      const call = f.log.calls[0];
      assert.deepEqual(call.event, f.event);
      assert.equal(call.event.user, OWNER);
      assert.equal(call.options.botUserId, f.options.botUserId);
      assert.equal(call.options.busyTargetRunId, "original-run");
      assert.equal(call.options.responderId, undefined);
    }
    assert.equal(f.audit().length, 1);
    assert.equal(f.audit()[0].author, ADMIN);
    assert.equal(f.audit()[0].requesterId, OWNER);
    assert.equal(f.audit()[0].choice, choice);
    assert.equal(JSON.stringify(f.audit()).includes(f.event.text), false);
    const stale = await f.click();
    assert.equal(stale.ok, false);
    assert.equal(f.audit().length, 1);
  });
}

for (const [kind, action] of [["busy_thread", BUSY_THREAD_QUEUE_ACTION], ["engine_switch", ENGINE_SWITCH_ACTION]]) {
  test(`${kind}: admin override rejects nonadmins, departed members, wrong conversations and denied access`, async () => {
    for (const mode of ["nonadmin", "departed", "wrong-channel", "denied", "lookup-failed"]) {
      const f = await fixture(kind, action);
      if (mode === "departed") f.control.members = [OWNER, MEMBER];
      if (mode === "denied") await saveChannelMeta(entry.slug, { ...f.meta, access: "none" });
      if (mode === "lookup-failed") f.client.conversations.members = async () => { throw new Error("membership unavailable"); };
      const result = await f.click({ user: mode === "nonadmin" ? MEMBER : ADMIN, channel: mode === "wrong-channel" ? "CWRONG" : CHANNEL });
      assert.equal(result.ok, false, mode);
      assert.equal(f.log.calls.length, 0, mode);
      assert.equal(f.audit().length, 0, mode);
      assert.equal(f.store.take(f.id, OWNER, CHANNEL).ok, true, `${mode}: the owner can still resolve the card`);
      f.store.discard(f.id);
    }
  });

  test(`${kind}: demotion during membership verification cannot claim another user's card`, async () => {
    const f = await fixture(kind, action);
    f.client.conversations.members = async () => {
      await setUser(ADMIN, { isAdmin: false });
      return { members: [OWNER, ADMIN] };
    };
    const result = await f.click();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "access");
    assert.equal(f.log.calls.length, 0);
    assert.equal(f.store.take(f.id, OWNER, CHANNEL).ok, true);
    f.store.discard(f.id);
  });
}
