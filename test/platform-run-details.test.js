import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { createIngest, createConversationProgress } = await import("../src/platforms/ingest.js");
const { makeInbound } = await import("../src/platforms/inbound.js");
const { platformOr } = await import("../src/platforms/registry.js");
const { setUser } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { createTeamsConnector } = await import("../src/platforms/msteams/connector.js");
const { footerText } = await import("../src/slack/footer.js");
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("long Teams answers keep statistics once in the final chunk and preserve the reply thread", async () => {
  await setUser("details-long", { approved: true });
  const posted = []; const edited = [];
  const connector = { platform: "msteams", post: async (body) => {
    posted.push(body); return { messageId: "123", conversationId: body.conversationId, threadKey: body.threadKey };
  }, edit: async (body) => edited.push(body) };
  const result = { content: "answer word\n".repeat(2000), engine: "codex", model: "gpt-6.1-sol", usage: { input_tokens: 100, output_tokens: 200 }, durationMs: 1000, costUSD: 0.01 };
  const ingest = createIngest({ connector, run: async () => result });
  await ingest(makeInbound({ platform: "msteams", kind: "channel", conversationId: "19:details-long@thread.tacv2", threadKey: "123456", userId: "details-long", mentionsBot: true, text: "long answer" }));
  const answerChunks = [edited[0], ...posted.slice(1)];
  assert.ok(answerChunks.length > 1);
  assert.ok(answerChunks.every((body) => body.text.length <= platformOr("msteams").capabilities.maxMessageChars));
  assert.equal(answerChunks.map((body) => body.text).join("").split(footerText(result)).length - 1, 1);
  assert.ok(answerChunks.at(-1).text.includes(footerText(result)));
  assert.ok(posted.every((body) => body.threadKey === "123456"));
});

for (const engine of ["claude", "codex"]) {
  test(`Teams ${engine} final answer carries Slack statistics through edit and post fallback`, async () => {
    await setUser(`details-${engine}`, { approved: true });
    saveSettings({ showMessageCost: false });
    const result = { content: "Answer.", engine, model: engine === "claude" ? "opus[1m]" : "gpt-6.1-sol", durationMs: 77000,
      usage: { input_tokens: 920200, output_tokens: 2000 }, costUSD: 0.31, runtime: { image: "channelgate/runtime:latest" } };
    for (const failEdit of [false, true]) {
      const sent = []; const edited = [];
      const connector = createTeamsConnector({ capabilities: platformOr("msteams").capabilities, api: {
        listMembers: async () => [],
        sendActivity: async (id, body) => { sent.push(body); return { messageId: "123" }; },
        updateActivity: async (id, messageId, body) => { if (failEdit) throw Error("deleted"); edited.push(body); },
      } });
      const ingest = createIngest({ connector, run: async (args) => {
        assert.equal(typeof args.onRuntimeResolved, "function");
        args.onRuntimeResolved({ engine, model: result.model });
        await flush();
        return result;
      }, log: { warn() {} } });
      await ingest(makeInbound({ platform: "msteams", kind: "dm", conversationId: `19:details-${engine}-${failEdit}@thread.v2`, userId: `details-${engine}`, text: "hello" }));
      const answer = failEdit ? sent.at(-1).text : edited.at(-1).text;
      assert.ok(answer.includes(footerText(result)), answer);
      assert.match(answer, /Answer\./);
      assert.match(answer, /77s · 920\.2k\/2k/);
      assert.match(answer, /channelgate\/runtime:latest/);
      assert.doesNotMatch(answer, /\$/);
      assert.equal(sent.length, failEdit ? 2 : 1);
    }
    saveSettings({ showMessageCost: true });
  });
}

test("progress exposes current model and app names, coalesces bursts and drains before the answer", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const edits = []; let release;
  const progress = createConversationProgress({ adapter: platformOr("msteams"), message: { rawConversationId: "wire" }, placeholder: { messageId: "123" }, connector: {
    edit: async (body) => { edits.push(body); if (edits.length === 3) await new Promise((r) => { release = r; }); },
  } });
  progress.runtime({ engine: "claude", model: "opus[1m]" }); await flush();
  assert.match(edits[0].text, /Opus 1M/);
  progress.event({ kind: "tool_use", name: "mcp__composio-agent__GMAIL_FETCH_EMAILS", target: "secret-target", input: { token: "secret-input" } });
  t.mock.timers.tick(2999); await flush(); assert.equal(edits.length, 1);
  t.mock.timers.tick(1); await flush();
  assert.match(edits[1].text, /Using composio-agent · GMAIL_FETCH_EMAILS/);
  assert.doesNotMatch(edits[1].text, /secret/);
  for (let i = 0; i < 100; i++) progress.event({ kind: "tool_use", name: `tool_${i}` });
  progress.runtime({ engine: "codex", model: "gpt-6.1-sol" });
  progress.event({ kind: "tool_result", name: "mcp__composio-agent__GMAIL_FETCH_EMAILS", status: "failed", result: "secret-output" });
  t.mock.timers.tick(3000); await flush();
  assert.equal(edits.length, 3);
  assert.match(edits[2].text, /gpt-6\.1-sol · Error in composio-agent · GMAIL_FETCH_EMAILS/);
  assert.doesNotMatch(edits[2].text, /secret/);
  progress.event({ kind: "thinking", summary: "secret-reasoning" });
  t.mock.timers.tick(60000); await flush(); assert.equal(edits.length, 3, "only one write in flight");
  let stopped = false;
  const stop = progress.stop().then(() => { stopped = true; }); await flush(); assert.equal(stopped, false);
  release(); await stop;
  progress.event({ kind: "tool_use", name: "late" });
  progress.runtime({ engine: "claude", model: "sonnet" });
  t.mock.timers.tick(60000); await flush(); assert.equal(edits.length, 3, "no status can overwrite the final answer");
});

test("quiet progress keeps the model, heartbeat and aliased subagent count", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const edits = [];
  const progress = createConversationProgress({ adapter: platformOr("msteams"), message: { rawConversationId: "wire" }, placeholder: { messageId: "123" }, connector: { edit: async (body) => edits.push(body) } });
  progress.runtime({ engine: "codex" }); await flush();
  progress.event({ kind: "agent_activity", id: "a", aliasIds: ["b"], status: "running" });
  progress.event({ kind: "agent_activity", id: "b", status: "running" });
  t.mock.timers.tick(30000); await flush();
  assert.match(edits.at(-1).text, /Codex CLI default/);
  assert.match(edits.at(-1).text, /30s elapsed.*1 subagent\(s\) running\. Still connected/);
  progress.event({ kind: "agent_activity", id: "b", status: "completed" });
  t.mock.timers.tick(3000); await flush();
  assert.match(edits.at(-1).text, /0 subagent/);
  await progress.stop();
});
