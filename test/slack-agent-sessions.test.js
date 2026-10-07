// Slack Agent Sessions: the native lifecycle (processing/active → the Stop button), the legacy
// bridge fallback, session renames, the `agent_session_stopped` handler and the 👍/👎 feedback
// controls (slack/agent-sessions.js, slack/agent-interface.js, slack/footer.js).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  setAgentSessionStatus, renameAgentSession, resetAgentSessionsMode, agentSessionsMode, nativeSessionStatus, stoppedSessionTarget,
} = await import("../src/slack/agent-sessions.js");
const { registerAgentInterfaceHandlers, TABLE_ROW_ACTION_PATTERN, REPLY_LINK_ACTION_PATTERN } = await import("../src/slack/agent-interface.js");
const { footerBlocks, feedbackBlocks, parseFeedbackValue, REPLY_FEEDBACK_ACTION_ID } = await import("../src/slack/footer.js");
const { setAssistantStatus } = await import("../src/slack/progress.js");

beforeEach(() => resetAgentSessionsMode());

const slackError = (code) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });

test("a status write asserts the native lifecycle once per transition and carries the phrase on the legacy surface", async () => {
  const calls = [];
  const client = { apiCall: async (method, payload) => { calls.push([method, payload]); } };
  assert.equal(await setAgentSessionStatus(client, { channel: "C1", threadTs: "1.1", phrase: "is thinking…", loadingMessages: ["Thinking…"] }), true);
  assert.equal(await setAgentSessionStatus(client, { channel: "C1", threadTs: "1.1", phrase: "is using Bash…" }), true);
  assert.equal(await setAgentSessionStatus(client, { channel: "C1", threadTs: "1.1", phrase: "" }), true);
  assert.deepEqual(calls, [
    ["agents.sessions.setStatus", { channel_id: "C1", thread_ts: "1.1", status: "processing" }],
    ["assistant.threads.setStatus", { channel_id: "C1", thread_ts: "1.1", status: "is thinking…", loading_messages: ["Thinking…"] }],
    // Still processing: no second native write for a phrase change.
    ["assistant.threads.setStatus", { channel_id: "C1", thread_ts: "1.1", status: "is using Bash…" }],
    // The clear is the transition Slack never makes on its own.
    ["agents.sessions.setStatus", { channel_id: "C1", thread_ts: "1.1", status: "active" }],
    ["assistant.threads.setStatus", { channel_id: "C1", thread_ts: "1.1", status: "" }],
  ]);
  assert.equal(nativeSessionStatus("C1", "1.1"), "active");
  assert.equal(await setAgentSessionStatus(client, { channel: "C1", threadTs: "1.1", phrase: "" }), true);
  assert.equal(calls.filter(([method]) => method === "agents.sessions.setStatus").length, 2, "a steady active is never repeated");
});

test("a workspace without agent sessions falls back to the legacy method for the rest of the process", async () => {
  const calls = [];
  const client = {
    apiCall: async (method, payload) => {
      calls.push([method, payload]);
      if (method === "agents.sessions.setStatus") throw slackError("feature_disabled");
      if (method === "agents.sessions.rename") throw slackError("unknown_method");
    },
  };
  assert.equal(await setAgentSessionStatus(client, { channel: "C1", threadTs: "1.1", phrase: "is thinking…" }), true);
  assert.equal(await setAgentSessionStatus(client, { channel: "C2", threadTs: "2.2", phrase: "is thinking…" }), true);
  assert.equal(await renameAgentSession(client, { channel: "C1", threadTs: "1.1", title: "Deploy plan" }), true);
  assert.equal(await renameAgentSession(client, { channel: "C2", threadTs: "2.2", title: "Second" }), true);
  assert.deepEqual(agentSessionsMode(), { status: "legacy", rename: "legacy" });
  assert.deepEqual(calls.map(([method]) => method), [
    "agents.sessions.setStatus", "assistant.threads.setStatus",
    "assistant.threads.setStatus", // learned: no second native attempt
    "agents.sessions.rename", "assistant.threads.setTitle",
    "assistant.threads.setTitle",
  ]);
  assert.deepEqual(calls[4][1], { channel_id: "C1", thread_ts: "1.1", title: "Deploy plan" });
});

test("a thread the native surface refuses keeps the legacy phrase, and a thread neither accepts is reported", async () => {
  const client = {
    apiCall: async (method, payload) => {
      if (method === "agents.sessions.setStatus" && payload.thread_ts === "9.9") throw slackError("not_authorized");
      if (method === "assistant.threads.setStatus" && payload.thread_ts === "8.8") throw slackError("invalid_thread");
      if (method === "agents.sessions.setStatus" && payload.thread_ts === "8.8") throw slackError("channel_not_found");
    },
  };
  assert.equal(await setAgentSessionStatus(client, { channel: "C1", threadTs: "9.9", phrase: "is thinking…" }), true);
  assert.equal(agentSessionsMode().status, "native", "a per-thread refusal does not flip the mode");
  assert.equal(await setAgentSessionStatus(client, { channel: "C1", threadTs: "8.8", phrase: "is thinking…" }), false);
  assert.equal(await setAgentSessionStatus(client, { channel: "C1", threadTs: "1.1", phrase: "" }), true);
});

test("an ordinary channel thread that only the native surface accepts still gets the Stop button lifecycle", async () => {
  const calls = [];
  const client = {
    apiCall: async (method, payload) => {
      calls.push([method, payload.status]);
      if (method === "assistant.threads.setStatus") throw slackError("invalid_thread");
    },
  };
  assert.equal(await setAssistantStatus(client, "C_CHANNEL", "3.3", "is thinking…"), true);
  assert.equal(await setAssistantStatus(client, "C_CHANNEL", "3.3", "is using Bash…"), true);
  assert.equal(await setAssistantStatus(client, "C_CHANNEL", "3.3", ""), true);
  assert.deepEqual(calls, [
    ["agents.sessions.setStatus", "processing"],
    ["assistant.threads.setStatus", "is thinking…"], // refused once, then never asked again
    ["agents.sessions.setStatus", "active"],
  ]);
});

test("renames go native with the 200-character title and empty titles are ignored", async () => {
  const calls = [];
  const client = { apiCall: async (method, payload) => { calls.push([method, payload]); } };
  assert.equal(await renameAgentSession(client, { channel: "C1", threadTs: "1.1", title: "" }), false);
  assert.equal(await renameAgentSession(client, { channel: "C1", threadTs: "", title: "x" }), false);
  assert.equal(await renameAgentSession(client, { channel: "C1", threadTs: "1.1", title: `  ${"t".repeat(250)} ` }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "agents.sessions.rename");
  assert.equal(calls[0][1].title.length, 200);
});

test("stoppedSessionTarget reads the agent_session_stopped payload and rejects malformed ones", () => {
  assert.deepEqual(stoppedSessionTarget({ channel: "C1", thread_ts: "1.1", user: "U1", streaming_message_ts: ["1.2", "1.3"] }),
    { channel: "C1", threadTs: "1.1", user: "U1", streamingMessageTs: ["1.2", "1.3"] });
  assert.equal(stoppedSessionTarget({ channel: "C1" }), null);
  assert.equal(stoppedSessionTarget(null), null);
});

// A minimal Bolt double: records event/action handlers so the test can dispatch to them.
function fakeApp() {
  const events = new Map();
  const actions = [];
  return {
    events,
    actions,
    event: (name, handler) => events.set(name, handler),
    action: (matcher, handler) => actions.push({ matcher, handler }),
    dispatchAction(actionId, args) {
      const entry = actions.find(({ matcher }) => (matcher instanceof RegExp ? matcher.test(actionId) : matcher === actionId));
      assert.ok(entry, `no handler for ${actionId}`);
      return entry.handler(args);
    },
  };
}

test("the native Stop button stops only that thread for an authorized user and clears a stale session", async () => {
  const app = fakeApp();
  const stops = [];
  const statuses = [];
  const seen = new Set();
  registerAgentInterfaceHandlers(app, {
    botUserId: "UBOT",
    seenEvents: { add: (key) => (seen.has(key) ? false : (seen.add(key), true)) },
    authorizedControlEntry: async (channel, user) => (user === "U_OK" ? { slug: `slug-${channel}` } : null),
    stopRunsInChannel: async (_client, channel, slug, user, threadKey) => { stops.push({ channel, slug, user, threadKey }); return threadKey === "1.1" ? 1 : 0; },
    setAssistantStatus: async (_client, channel, threadTs, status) => { statuses.push([channel, threadTs, status]); return true; },
  });
  const handler = app.events.get("agent_session_stopped");
  assert.ok(handler);
  const client = {};
  await handler({ event: { channel: "C1", thread_ts: "1.1", user: "U_OK", event_ts: "1.5", streaming_message_ts: ["1.2"] }, client, body: { event_id: "Ev1" } });
  assert.deepEqual(stops, [{ channel: "C1", slug: "slug-C1", user: "U_OK", threadKey: "1.1" }]);
  assert.deepEqual(statuses, [], "a stopped run already clears its own session status");
  // Redelivered envelope: no second stop.
  await handler({ event: { channel: "C1", thread_ts: "1.1", user: "U_OK", event_ts: "1.5" }, client, body: { event_id: "Ev1" } });
  assert.equal(stops.length, 1);
  // Nothing running any more: the session is still moved off `processing`, which Slack never does on its own.
  await handler({ event: { channel: "C1", thread_ts: "2.2", user: "U_OK", event_ts: "2.5" }, client, body: { event_id: "Ev2" } });
  assert.equal(stops.length, 2);
  assert.deepEqual(statuses, [["C1", "2.2", ""]]);
  // An unauthorized user stops nothing but still cannot leave the loading UX stuck.
  await handler({ event: { channel: "C1", thread_ts: "3.3", user: "U_NOPE", event_ts: "3.5" }, client, body: { event_id: "Ev3" } });
  assert.equal(stops.length, 2);
  assert.deepEqual(statuses.at(-1), ["C1", "3.3", ""]);
  // The bot's own events and malformed payloads are ignored.
  await handler({ event: { channel: "C1", thread_ts: "4.4", user: "UBOT", event_ts: "4.5" }, client, body: { event_id: "Ev4" } });
  await handler({ event: { channel: "C1" }, client, body: { event_id: "Ev5" } });
  assert.equal(stops.length, 2);
  assert.equal(statuses.length, 2);
  assert.ok(app.events.get("agent_session_title_changed"));
});

test("👍/👎 feedback is acknowledged, recorded, and a 👎 invites a correction privately", async () => {
  const app = fakeApp();
  registerAgentInterfaceHandlers(app, { seenEvents: { add: () => true }, authorizedControlEntry: async () => null, stopRunsInChannel: async () => 0 });
  const ephemerals = [];
  const client = { chat: { postEphemeral: async (payload) => { ephemerals.push(payload); } } };
  let acked = 0;
  const [block] = feedbackBlocks({ channel: "C1", threadTs: "1.1", authorId: "U_REQ" });
  const element = block.elements[0];
  await app.dispatchAction(REPLY_FEEDBACK_ACTION_ID, {
    ack: async () => { acked += 1; },
    body: { user: { id: "U_READER" }, channel: { id: "C1" }, message: { ts: "1.9", thread_ts: "1.1" } },
    action: { action_id: REPLY_FEEDBACK_ACTION_ID, value: element.negative_button.value },
    client,
  });
  assert.equal(acked, 1);
  assert.equal(ephemerals.length, 1);
  assert.deepEqual([ephemerals[0].channel, ephemerals[0].user, ephemerals[0].thread_ts], ["C1", "U_READER", "1.1"]);
  await app.dispatchAction(REPLY_FEEDBACK_ACTION_ID, {
    ack: async () => { acked += 1; },
    body: { user: { id: "U_READER" }, channel: { id: "C1" }, message: { ts: "1.9", thread_ts: "1.1" } },
    action: { action_id: REPLY_FEEDBACK_ACTION_ID, value: element.positive_button.value },
    client,
  });
  assert.equal(acked, 2);
  assert.equal(ephemerals.length, 1, "a 👍 needs no reply");
  assert.deepEqual(parseFeedbackValue(element.positive_button.value), { verdict: "up", channel: "C1", threadTs: "1.1", authorId: "U_REQ" });
  assert.equal(parseFeedbackValue("meh"), null);
  // Row buttons and composed-reply links are URL buttons: acknowledged, nothing else.
  let ackedUrl = 0;
  await app.dispatchAction("cg_table_row_3_1", { ack: async () => { ackedUrl += 1; } });
  await app.dispatchAction("cg_reply_link_0", { ack: async () => { ackedUrl += 1; } });
  assert.equal(ackedUrl, 2);
  assert.ok(TABLE_ROW_ACTION_PATTERN.test("cg_table_row_0_0") && !TABLE_ROW_ACTION_PATTERN.test("cg_table_rows"));
  assert.ok(REPLY_LINK_ACTION_PATTERN.test("cg_reply_link_2") && !REPLY_LINK_ACTION_PATTERN.test("cg_reply_feedback"));
});

test("the reply footer ends with the feedback controls unless asked for the plain form", () => {
  const result = { durationMs: 5, usage: { input_tokens: 1, output_tokens: 1 } };
  const context = { channel: "C1", threadTs: "1.1", authorId: "U1" };
  assert.deepEqual(footerBlocks(result, context).map((block) => block.type), ["context", "actions", "context_actions"]);
  assert.deepEqual(footerBlocks(result, context, { feedback: false }).map((block) => block.type), ["context", "actions"]);
  assert.deepEqual(footerBlocks(result, {}).map((block) => block.type), ["context"], "no channel, no controls at all");
  const [feedback] = feedbackBlocks(context);
  assert.equal(feedback.elements[0].type, "feedback_buttons");
  assert.equal(feedback.elements[0].positive_button.text.text, "👍");
  assert.equal(feedback.elements[0].negative_button.text.text, "👎");
});

test("the manifest subscribes to the agent session events and registers /model", () => {
  const manifest = JSON.parse(readFileSync(new URL("../slack-app-manifest.json", import.meta.url), "utf8"));
  const events = manifest.settings.event_subscriptions.bot_events;
  assert.ok(events.includes("agent_session_stopped"), "the Stop button needs this subscription");
  assert.ok(events.includes("agent_session_title_changed"));
  assert.ok(manifest.oauth_config.scopes.bot.includes("assistant:write"));
  assert.ok(manifest.oauth_config.scopes.bot.includes("chat:write"));
  assert.ok(manifest.features.slash_commands.some((command) => command.command === "/model"));
});
