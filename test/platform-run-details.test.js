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

for (const engine of ["claude", "codex"]) {
  test(`Teams ${engine} tags the authenticated requester once after channel/group answers and skips DMs`, async () => {
    const userId = `29:requester-${engine}`;
    await setUser(userId, { approved: true });
    for (const kind of ["channel", "group", "dm"]) {
      for (const [failEdit, content] of [[false, "Answer."], [true, "Answer."], [false, "Answer line.\n".repeat(1000)], [true, "Answer line.\n".repeat(1000)]]) {
        const wire = [];
        const connector = createTeamsConnector({ capabilities: platformOr("msteams").capabilities, api: {
          // The authenticated sender is known even when a roster is unavailable.
          listMembers: async () => { throw new Error("roster unavailable"); },
          sendActivity: async (id, body) => { wire.push(body); return { messageId: "123" }; },
          updateActivity: async (id, messageId, body) => { if (failEdit) throw new Error("deleted"); wire.push(body); },
        }, log: { warn() {} } });
        const result = { content, engine, model: engine === "claude" ? "opus" : "gpt-6.1-sol" };
        await createIngest({ connector, run: async () => result })(makeInbound({
          platform: "msteams", kind, conversationId: `19:requester-${engine}-${kind}-${failEdit}@thread.${kind === "channel" ? "tacv2" : "v2"}`,
          threadKey: kind === "channel" ? "123456" : "", messageId: "request-message", userId, userName: "Developer", mentionsBot: kind !== "dm", text: "hello",
        }));
        const answers = wire.slice(1);
        const last = answers.at(-1);
        const mentions = answers.flatMap(body => body.entities || []);
        assert.ok(content.length < 8000 ? answers.length === 1 : answers.length > 1);
        assert.ok(answers.every(body => body.text.length <= platformOr("msteams").capabilities.maxMessageChars));
        assert.equal(mentions.length, kind === "dm" ? 0 : 1);
        if (kind !== "dm") {
          assert.ok(last.text.endsWith("\n\n<at>Developer</at>") || last.text === "<at>Developer</at>");
          assert.deepEqual(last.entities, [{ type: "mention", text: "<at>Developer</at>", mentioned: { id: userId, name: "Developer" } }]);
          assert.ok(answers.slice(0, -1).every(body => !body.text.includes("<at>Developer</at>")));
        }
        assert.equal(last.attachments[0].content.body[1].text, footerText(result));
        assert.equal(wire[0].entities?.length || 0, 0, "working placeholder has no requester notification");
      }
    }
  });
}

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
  assert.equal(answerChunks.filter((body) => body.footer).length, 1);
  assert.equal(answerChunks.at(-1).footer, footerText(result));
  assert.ok(answerChunks.every((body) => !body.text.includes(footerText(result))));
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
      const answer = failEdit ? sent.at(-1) : edited.at(-1);
      assert.equal(answer.text, "Answer.");
      const card = answer.attachments[0].content;
      assert.equal(answer.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
      assert.equal(card.body[0].minHeight, "8px");
      const stats = card.body[1];
      assert.equal(stats.text, footerText(result));
      assert.equal(stats.size, "Small");
      assert.equal(stats.isSubtle, true);
      assert.equal(stats.wrap, true);
      assert.match(stats.text, /77s · 920\.2k\/2k/);
      assert.doesNotMatch(stats.text, /channelgate\/runtime:latest/);
      assert.doesNotMatch(stats.text, /\$/);
      assert.equal(sent.length, failEdit ? 2 : 1);
    }
    saveSettings({ showMessageCost: true });
  });
}

test("Google Chat progress exposes current model and app names, coalesces bursts and drains before the answer", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const edits = []; let release;
  const progress = createConversationProgress({ adapter: platformOr("googlechat"), message: { rawConversationId: "wire" }, placeholder: { messageId: "123" }, connector: {
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

test("Google Chat quiet progress keeps the model, heartbeat and aliased subagent count", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const edits = [];
  const progress = createConversationProgress({ adapter: platformOr("googlechat"), message: { rawConversationId: "wire" }, placeholder: { messageId: "123" }, connector: { edit: async (body) => edits.push(body) } });
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

for (const engine of ["claude", "codex"]) {
  test(`Teams ${engine} leaves only answer, requester and footer after a failed placeholder edit`, async () => {
    const userId = `29:clean-${engine}`;
    await setUser(userId, { approved: true });
    const visible = new Map(); const calls = []; let sequence = 0;
    const connector = createTeamsConnector({ capabilities: platformOr("msteams").capabilities, api: {
      listMembers: async () => [],
      sendActivity: async (id, body) => { const messageId = String(++sequence); visible.set(messageId, body); calls.push(`post:${messageId}`); return { messageId }; },
      updateActivity: async () => { throw new Error("edit unavailable"); },
      deleteActivity: async (id, messageId) => { calls.push(`delete:${messageId}`); visible.delete(messageId); },
    } });
    const result = { content: "Answer.", engine, model: engine === "claude" ? "opus" : "gpt-6.1-sol" };
    await createIngest({ connector, run: async args => {
      args.onRuntimeResolved({ engine, model: result.model });
      args.onEvent({ kind: "tool_result", name: "binbash -lc cat instructions", status: "completed" });
      args.onDelta("answer"); await flush();
      assert.equal(visible.size, 1);
      assert.equal([...visible.values()][0].text, "_Working on it…_");
      return result;
    } })(makeInbound({ platform: "msteams", kind: "channel", conversationId: `19:clean-${engine}@thread.tacv2`,
      threadKey: "123456", userId, userName: "Developer", mentionsBot: true, text: "hello" }));
    assert.deepEqual(calls, ["post:1", "post:2", "delete:1"]);
    assert.equal(visible.size, 1);
    const answer = [...visible.values()][0];
    assert.equal(answer.text, "Answer.\n\n<at>Developer</at>");
    assert.equal(answer.entities[0].mentioned.id, userId);
    assert.equal(answer.attachments[0].content.body[1].text, footerText(result));
  });
}

test("Teams progress never posts detailed status or orphan messages without a placeholder", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const writes = [];
  const progress = createConversationProgress({ adapter: platformOr("msteams"), message: { rawConversationId: "wire" },
    connector: { post: async body => writes.push(body), edit: async body => writes.push(body) } });
  progress.runtime({ engine: "codex", model: "gpt-6.1-sol" });
  progress.event({ kind: "tool_result", name: "binbash -lc cat instructions" });
  progress.phase("Thinking"); progress.activity();
  t.mock.timers.tick(60000); await flush(); await progress.stop();
  assert.deepEqual(writes, []);
});
