// A channel whose stored model no longer exists (a typo, a retired id) must never fail silently or
// speak in JSON. Three facts, end to end through the real Slack pipeline:
//   1. the gateway substitutes its default and SAYS SO in the thread — the note has to reach the
//      message the reader sees, which for a native-streaming turn is the stream, not the finished
//      `content` string the orchestrator returns;
//   2. a provider that reports the rejection by handing back its whole JSON response body is still
//      classified as a model rejection, so the same substitution happens on Codex;
//   3. whatever still ends as an error is a sentence naming the model and the remedy — never the
//      provider's raw JSON document.
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { resetEngineCooldowns } = await import("../src/gateway/run.js");
const { readEvents } = await import("../src/util/logger.js");

// A Slack client that records what a reader would actually SEE: every markdown chunk written into
// a native answer stream (append + the terminal stop payload), plus the plain messages posted
// beside it. The card/timeline stream writes `chunks`, never markdown, so it never lands in
// `delivered`.
function fakeSlack() {
  const posted = [];
  const delivered = [];
  let seq = 0;
  const ok = async () => ({ ok: true });
  const write = (payload) => {
    if (typeof payload?.markdown_text === "string") delivered.push(payload.markdown_text);
  };
  return {
    posted,
    delivered,
    text: () => `${delivered.join("")}\n${posted.map((m) => m.text || "").join("\n")}`,
    chat: {
      postMessage: async (message) => { posted.push(message); return { ok: true, ts: `bot.${++seq}` }; },
      update: async (message) => { posted.push(message); return { ok: true }; },
      delete: ok,
      postEphemeral: async (message) => { posted.push(message); return { ok: true }; },
    },
    users: {
      info: async ({ user }) => ({ user: { id: user, real_name: "Model Tester" } }),
      list: async () => ({ members: [{ id: "U_MODEL", real_name: "Model Tester" }], response_metadata: {} }),
    },
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
      info: async ({ channel }) => ({ channel: { id: channel } }),
      members: async () => ({ members: ["U_MODEL"], response_metadata: {} }),
    },
    apiCall: ok,
    chatStream: () => ({
      ts: `stream.${++seq}`,
      append: async (payload) => { write(payload); return { ok: true }; },
      stop: async (payload) => { write(payload); return { ok: true }; },
    }),
  };
}

async function channel(id, { engine, model }) {
  await setUser("U_MODEL", { name: "Model Tester", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(id, { name: id.toLowerCase().replace(/_/g, "-"), type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: id, name: entry.name, type: "im", isDM: true, template: "custom",
    engine, model, cleanMode: true, allowNetwork: false,
  });
  return entry;
}

const event = (channelId, ts, text) => ({ type: "message", channel: channelId, channel_type: "im", user: "U_MODEL", text, thread_ts: ts, ts });
const errorsFor = (slug) => readEvents({ limit: 200 }).filter((e) => e.event === "run_error" && e.slug === slug);
const fallbacksFor = (slug) => readEvents({ limit: 200 }).filter((e) => e.event === "run_model_fallback" && e.slug === slug);

test("Claude: the substituted model is announced in the thread the reader sees", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "claude", defaultClaudeModel: "sonnet", engineFallback: false, composioMode: "personal" });
  const entry = await channel("D_MODEL_CLAUDE", { engine: "claude", model: "opus" });
  const client = fakeSlack();

  await processMessageEvent(event("D_MODEL_CLAUDE", "5100.100", "CLAUDE_STUB_REJECT_MODEL CLAUDE_STUB_STREAM_TEXT"), client, { botUserId: "U_BOT", teamId: "T_MODEL" });

  const text = client.text();
  assert.match(text, /opus was rejected before the turn started — using gateway default sonnet/,
    `the substitution must be visible in the thread: ${JSON.stringify(text)}`);
  assert.match(text, /model=sonnet/, "the answer itself is still delivered");
  assert.equal(errorsFor(entry.slug).length, 0, "a substituted model is not an error");
  assert.equal(fallbacksFor(entry.slug).length, 1);
  // Exactly once: the orchestrator also carries the note on the finished content (for surfaces
  // that never see a stream), and a Slack turn must not print it twice.
  assert.equal(text.match(/was rejected before the turn started/g).length, 1);
});

test("Codex: the substituted model is announced in the thread the reader sees", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", defaultCodexModel: "gpt-5.6-sol", engineFallback: false, composioMode: "personal" });
  const entry = await channel("D_MODEL_CODEX", { engine: "codex", model: "gpt-5.6" });
  const client = fakeSlack();

  await processMessageEvent(event("D_MODEL_CODEX", "5100.200", "CODEX_STUB_REJECT_MODEL CODEX_STUB_STREAM_TEXT"), client, { botUserId: "U_BOT", teamId: "T_MODEL" });

  const text = client.text();
  assert.match(text, /gpt-5\.6 was rejected before the turn started — using gateway default gpt-5\.6-sol/,
    `the substitution must be visible in the thread: ${JSON.stringify(text)}`);
  assert.match(text, /model=gpt-5\.6-sol/, "the answer itself is still delivered");
  assert.equal(errorsFor(entry.slug).length, 0);
  assert.equal(text.match(/was rejected before the turn started/g).length, 1);
});

test("Codex: a rejection reported as the provider's raw JSON body is still a model rejection", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", defaultCodexModel: "gpt-5.6-sol", engineFallback: false, composioMode: "personal" });
  const entry = await channel("D_MODEL_BODY", { engine: "codex", model: "gpt-5.6" });
  const client = fakeSlack();

  await processMessageEvent(event("D_MODEL_BODY", "5100.300", "CODEX_STUB_REJECT_MODEL_BODY CODEX_STUB_STREAM_TEXT"), client, { botUserId: "U_BOT", teamId: "T_MODEL" });

  const text = client.text();
  assert.match(text, /gpt-5\.6 was rejected before the turn started — using gateway default gpt-5\.6-sol/,
    `the wrapped provider body must classify as a model rejection: ${JSON.stringify(text)}`);
  assert.equal(errorsFor(entry.slug).length, 0, "a classified rejection never reaches the error path");
  assert.equal(fallbacksFor(entry.slug).length, 1);
});

test("a failure that survives the substitution is a sentence with a remedy, never provider JSON", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", defaultCodexModel: "gpt-5.6-sol", engineFallback: false, composioMode: "personal" });
  const entry = await channel("D_MODEL_DEAD", { engine: "codex", model: "gpt-5.6" });
  const client = fakeSlack();

  await processMessageEvent(event("D_MODEL_DEAD", "5100.400", "CODEX_STUB_REJECT_ALL_MODELS_BODY"), client, { botUserId: "U_BOT", teamId: "T_MODEL" });

  const failure = client.posted.map((m) => String(m.text || "")).find((t) => /Something went wrong/.test(t));
  assert.ok(failure, `the turn must report its failure: ${JSON.stringify(client.posted.map((m) => m.text))}`);
  assert.ok(!/[{}]/.test(failure), `no raw provider JSON in the thread: ${JSON.stringify(failure)}`);
  assert.match(failure, /is not supported when using Codex with a ChatGPT account/, "the provider's own sentence survives");
  assert.match(failure, /gpt-5\.6/, "the rejected model is named");
  assert.match(failure, /\/model/, "the remedy is named");
  assert.equal(errorsFor(entry.slug).length, 1);
});
