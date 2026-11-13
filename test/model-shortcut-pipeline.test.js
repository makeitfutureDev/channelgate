import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
const runtime = await useFakeRuntime();
process.env.PATH = `${fileURLToPath(new URL("./fixtures", import.meta.url))}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings, getModelShortcuts, getDefaultModel, getEngine } = await import("../src/config/settings.js");
const { getThreadEngine, getThreadModel, getThreadEffort, setThreadEffort } = await import("../src/gateway/thread-engine.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { runQueue } = await import("../src/slack/message-lifecycle.js");
const { listActiveRuns } = await import("../src/gateway/active-runs.js");
const { stripMentions } = await import("../src/slack/message-normalize.js");
const { parseModelShortcut } = await import("../src/config/model-shortcuts.js");

const USER = "U_SHORTCUT";
const BOT = "BSHORTCUT";
const CHANNEL = "D_SHORTCUT";
const messages = [];
const client = {
  chat: { postMessage: async (message) => { messages.push(message); return { ok: true, ts: "bot.1" }; }, update: async () => ({ ok: true }) },
  apiCall: async () => ({ ok: true }),
  users: { info: async ({ user }) => ({ user: { id: user, real_name: "Shortcut User" } }), list: async () => ({ members: [] }) },
  chatStream: ({ channel, thread_ts }) => {
    let text = "";
    return { ts: "stream.1", append: async ({ markdown_text = "" }) => { text += markdown_text; },
      stop: async ({ markdown_text = "" } = {}) => { messages.push({ channel, thread_ts, text: text + markdown_text }); return { ok: true }; } };
  },
  conversations: {
    info: async () => ({ channel: { id: CHANNEL, is_im: true } }),
    replies: async () => ({ messages: [] }),
    history: async () => ({ messages: [] }),
  },
};

test("fresh-install defaults select supported Sonnet and Sol without changing gateway defaults", async () => {
  await setUser(USER, { name: "Shortcut User", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(CHANNEL, { name: "shortcut-dm", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, { channelId: CHANNEL, name: entry.name, type: "im", isDM: true, template: "custom", engine: "claude" });
  const engine = getEngine();
  const defaults = {claude: getDefaultModel("claude"), codex: getDefaultModel("codex")};
  const shortcuts = getModelShortcuts();
  for (const [index, name] of ["sonet", "sol"].entries()) {
    const ts = `122.00${index}`;
    await processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: `<@${BOT}> :${name} short task`, ts }, client, { botUserId: BOT });
    assert.equal(await getThreadModel(entry.slug, ts), shortcuts[name].model);
    assert.equal(await getThreadEngine(entry.slug, ts), shortcuts[name].engine);
  }
  assert.equal(getEngine(), engine);
  assert.deepEqual({claude: getDefaultModel("claude"), codex: getDefaultModel("codex")}, defaults);
});

test("Slack's inserted space before :astra switches a DM thread and clears an old effort pin", async () => {
  await setUser(USER, { name: "Shortcut User", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(CHANNEL, { name: "shortcut-dm", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, { channelId: CHANNEL, name: entry.name, type: "im", isDM: true, template: "custom", engine: "claude" });
  saveSettings({ modelShortcuts: { astra: { engine: "codex", model: "gpt-6-astra" } } });
  await setThreadEffort(entry.slug, "123.001", "high");
  assert.equal(stripMentions(`<@${BOT}> :astra`, BOT), ":astra");
  assert.deepEqual(parseModelShortcut(stripMentions(`<@${BOT}> :astra review this`, BOT)), { name: "astra", task: "review this" });
  await processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: `<@${BOT}> :astra`, ts: "123.001" }, client, { botUserId: BOT });
  assert.equal(await getThreadEngine(entry.slug, "123.001"), "codex");
  assert.equal(await getThreadModel(entry.slug, "123.001"), "gpt-6-astra");
  assert.equal(await getThreadEffort(entry.slug, "123.001"), "");
  assert.match(messages.at(-1).text, /gpt-6-astra/);
});

test("unknown shortcut cannot change the thread", async () => {
  const entry = await upsertChannelEntry(CHANNEL, { name: "shortcut-dm", type: "im", isDM: true });
  await processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: `<@${BOT}> :unknown`, ts: "123.002" }, client, { botUserId: BOT });
  assert.equal(await getThreadEngine(entry.slug, "123.002"), "");
  assert.match(messages.at(-1).text, /Unknown model shortcut/);
});

test("explicit shortcut efforts reach both engines, resume, and strip prefixes on retries", async () => {
  const entry = await upsertChannelEntry(CHANNEL, { name: "shortcut-dm", type: "im", isDM: true });
  saveSettings({ modelShortcuts: { sol: { engine: "codex", model: "gpt-6.1-sol" }, opus: { engine: "claude", model: "claude-opus-5-5" } } });
  for (const [index, name] of ["sol", "opus"].entries()) {
    const engine = name === "sol" ? "codex" : "claude";
    const root = `126.00${index}`;
    const send = (text, ts, extra = {}) => processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text, ts, thread_ts: root }, client, { botUserId: BOT, ...extra });
    const before = runtime.calls.spawn.length;
    await send(`<@${BOT}> :${name} :LOW`, root);
    assert.equal(runtime.calls.spawn.length, before, "selector-only messages do not start an engine");
    assert.equal(await getThreadEffort(entry.slug, root), "low");
    assert.match(messages.at(-1).text, /`low`/);
    for (const [step, text, extra] of [
      [1, `<@${BOT}> :${name} :HIGH effort task`, {}],
      [2, "continue effort task", {}],
      [3, `<@${BOT}> :${name} :HIGH retry effort task`, { engineChoice: engine }],
    ]) {
      await send(text, `${root}${step}`, extra);
      const spawn = runtime.calls.spawn.at(-1);
      if (engine === "codex") assert.ok(spawn.args.includes('model_reasoning_effort="high"'));
      else assert.equal(spawn.args[spawn.args.indexOf("--effort") + 1], "high");
      const prompt = spawn.args.find(arg => arg.includes("effort task"));
      assert.ok(prompt);
      assert.doesNotMatch(prompt, new RegExp(`:${name}|:HIGH`));
      assert.equal(await getThreadEffort(entry.slug, root), "high");
    }
    await send(`<@${BOT}> :${name}`, `${root}4`);
    assert.equal(await getThreadEffort(entry.slug, root), "", "omitting effort still clears the old pin");
  }
});

test("invalid and model-incompatible efforts preserve all pins without starting a turn", async () => {
  const entry = await upsertChannelEntry(CHANNEL, { name: "shortcut-dm", type: "im", isDM: true });
  saveSettings({ modelShortcuts: { sol: { engine: "codex", model: "gpt-6.1-sol" }, opus: { engine: "claude", model: "claude-opus-5-5" } } });
  const root = "127.001";
  const send = (suffix, ts) => processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: `<@${BOT}> ${suffix}`, ts, thread_ts: root }, client, { botUserId: BOT });
  await send(":sol :low", root);
  for (const [index, suffix] of [":sol :bogus task", ":opus :ultra task", ":sol :"].entries()) {
    const before = runtime.calls.spawn.length;
    await send(suffix, `127.00${index + 2}`);
    assert.match(messages.at(-1).text, /Invalid effort.*Choose/);
    assert.equal(runtime.calls.spawn.length, before);
    assert.equal(await getThreadEngine(entry.slug, root), "codex");
    assert.equal(await getThreadModel(entry.slug, root), "gpt-6.1-sol");
    assert.equal(await getThreadEffort(entry.slug, root), "low");
  }
});

test("queued shortcut tasks retain their own runtime selections and durable snapshots", async () => {
  const entry = await upsertChannelEntry(CHANNEL, { name: "shortcut-dm", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, { channelId: CHANNEL, name: entry.name, type: "im", isDM: true, template: "custom", engine: "claude", effort: "medium" });
  saveSettings({ modelShortcuts: { sol: { engine: "codex", model: "gpt-6.1-sol" }, opus: { engine: "claude", model: "claude-opus-5-5" } } });
  for (const [index, name] of ["sol", "opus"].entries()) {
    const root = `128.00${index}`;
    const key = `${entry.slug}::${root}`;
    const blocker = { aborted: false, controller: new AbortController(), authorId: USER, runId: `${key}::blocker` };
    await runQueue.acquire(key, blocker);
    const pending = [];
    try {
      for (const [step, effort] of ["low", "", "high"].entries()) {
        pending.push(processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER,
          text: `<@${BOT}> :${name} ${effort ? `:${effort} ` : ""}queued-${name}-${step}`,
          ts: `${root}${step + 1}`, thread_ts: root }, client, { botUserId: BOT }));
        for (let tries = 0; runQueue.count(key) < step + 2 && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(runQueue.count(key), step + 2);
        const stored = listActiveRuns().find(row => row.id === `${key}::${root}${step + 1}`);
        assert.deepEqual(stored.runtimeOverrides, { engine: name === "sol" ? "codex" : "claude",
          model: name === "sol" ? "gpt-6.1-sol" : "claude-opus-5-5", effort });
      }
    } finally {
      runQueue.release(key, blocker);
      await Promise.all(pending);
    }
    for (const [step, effort] of ["low", "medium", "high"].entries()) {
      const spawn = runtime.calls.spawn.find(call => call.args.some(arg => arg.includes(`queued-${name}-${step}`)));
      assert.ok(spawn);
      if (name === "sol") assert.ok(spawn.args.includes(`model_reasoning_effort="${effort}"`));
      else assert.equal(spawn.args[spawn.args.indexOf("--effort") + 1], effort);
    }
  }
  await saveChannelMeta(entry.slug, { channelId: CHANNEL, name: entry.name, type: "im", isDM: true, template: "custom", engine: "claude" });
});

test("shortcut tasks start and resume the mapped model, switch engines, and strip the prefix on card retries", async () => {
  const entry = await upsertChannelEntry(CHANNEL, { name: "shortcut-dm", type: "im", isDM: true });
  saveSettings({ modelShortcuts: { astra: { engine: "codex", model: "gpt-6-astra" }, opus: { engine: "claude", model: "claude-opus-5-5" } } });
  const send = (text, ts, extra = {}) => processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text, ts, thread_ts: "124.001" }, client, { botUserId: BOT, ...extra });
  await send(`<@${BOT}> :astra first task`, "124.001");
  assert.ok(messages.some((m) => /Codex stub reply.*model=gpt-6-astra/.test(m.text)), JSON.stringify(messages));
  assert.equal(await getThreadModel(entry.slug, "124.001"), "gpt-6-astra");
  saveSettings({ modelShortcuts: { astra: { engine: "codex", model: "gpt-6.1-sol" }, opus: { engine: "claude", model: "claude-opus-5-5" } } });
  await send("continue", "124.002");
  assert.ok(messages.some((m) => /Codex stub reply.*resume=yes.*model=gpt-6-astra/.test(m.text)), "repointing a name must not change a thread's resolved pin");
  await send(`<@${BOT}> :opus next task`, "124.003");
  assert.equal(await getThreadEngine(entry.slug, "124.001"), "claude");
  assert.ok(messages.some((m) => /Stub engine reply.*model=claude-opus-5-5/.test(m.text)), "a new Claude process uses the shortcut's model");
  await send(`<@${BOT}> :opus next task`, "124.004", { engineChoice: "claude" });
  const retryPrompt = runtime.calls.spawn.at(-1).args.find((arg) => arg.includes("next task"));
  assert.ok(retryPrompt, "a card retry still sends the task to the engine");
  assert.doesNotMatch(retryPrompt, /:opus/, "the shortcut prefix is stripped from a card retry");
});

test("runtime permission, disabled engine and dedicated Codex login refuse a shortcut before changing pins", async () => {
  const channel = "CSHORTCUT";
  const entry = await upsertChannelEntry(channel, { name: "shortcut-channel", type: "channel", isDM: false });
  const meta = { channelId: channel, name: entry.name, type: "channel", isDM: false, template: "custom", allowedUsers: [USER], engine: "claude" };
  await saveChannelMeta(entry.slug, meta);
  const shortcuts = { astra: { engine: "codex", model: "gpt-6-astra" }, opus: { engine: "claude", model: "claude-opus-5-5" } };
  const send = (name, ts) => processMessageEvent({ type: "message", channel, channel_type: "channel", user: USER, text: `<@${BOT}> :${name}`, ts }, client, { botUserId: BOT });
  saveSettings({ modelShortcuts: shortcuts, modelChangeAccess: "admins" });
  await send("astra", "125.001");
  assert.match(messages.at(-1).text, /Only admins/);
  assert.equal(await getThreadEngine(entry.slug, "125.001"), "");
  saveSettings({ modelChangeAccess: "users", engineEnabled: { claude: true, codex: false } });
  await send("astra", "125.002");
  assert.match(messages.at(-1).text, /enabled engine/);
  assert.equal(await getThreadModel(entry.slug, "125.002"), "");
  saveSettings({ engineEnabled: { claude: true, codex: true } });
  await saveChannelMeta(entry.slug, { ...meta, codexAuthSource: "channel", engine: "codex" });
  await send("opus", "125.003");
  assert.equal(await getThreadEngine(entry.slug, "125.003"), "claude");
  assert.equal(await getThreadModel(entry.slug, "125.003"), "claude-opus-5-5");
});
