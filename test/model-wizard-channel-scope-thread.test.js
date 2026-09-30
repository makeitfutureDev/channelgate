// `/model` → "This channel" clicked from INSIDE a thread must land in that thread too, not only in
// threads opened later. Drives the real wizard handler against a fake Slack client and then asks
// the run-time resolvers what the current thread would actually spawn with.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { saveSession } = await import("../src/gateway/sessions.js");
const { getThreadEngine, getThreadModel, getThreadEffort, setThreadModel, setThreadEffort, setThreadEngine } = await import("../src/gateway/thread-engine.js");
const { decideThreadEngine } = await import("../src/gateway/run.js");
const { resolveThreadEngine } = await import("../src/gateway/thread-engine.js");
const {
  MODEL_WIZARD_SCOPE_CHANNEL_ACTION,
  MODEL_PICKER_ACTION,
  EFFORT_PICKER_ACTION,
  handleModelWizard,
} = await import("../src/slack/model-wizard.js");

const THREAD = "1901000000.000100";
const ADMIN = "U_MW_ADMIN";

// Every button the wizard renders carries this compact state; the handler reads scope + thread off
// it, so a test click is just the same JSON.
const wizardValue = (value) => JSON.stringify({ s: "c", t: THREAD, ...(value === undefined ? {} : { v: value }) });

function fakeClient() {
  const updates = [];
  const ephemerals = [];
  return {
    updates,
    ephemerals,
    chat: {
      update: async (args) => { updates.push(args); return { ok: true }; },
      postEphemeral: async (args) => { ephemerals.push(args); return { ok: true }; },
      postMessage: async () => ({ ok: true }),
    },
  };
}

async function click(client, channelId, actionId, value) {
  await handleModelWizard({
    ack: async () => {},
    body: { user: { id: ADMIN }, channel: { id: channelId }, container: { channel_id: channelId, message_ts: "1901000000.000200" } },
    action: { action_id: actionId, value },
    client,
    respond: async () => {},
  });
}

async function channel(id, name, meta = {}) {
  const entry = await upsertChannelEntry(id, { name, type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, {
    channelId: id, name: entry.name, type: "channel", isDM: false, template: "custom",
    engine: "claude", model: "sonnet", effort: "medium", allowNetwork: false, ...meta,
  });
  return entry;
}

test("a channel-scope model pick applies to the thread it was made in", async () => {
  saveSettings({ engine: "claude", modelChangeAccess: "admins", engineEnabled: { claude: true, codex: true } });
  await setUser(ADMIN, { name: "Admin", approved: true, isAdmin: true });
  const entry = await channel("C_MW_SAME", "mw-same-harness");
  // A live Claude session in this thread, plus the stale thread overrides a previous
  // thread-scoped pick (or a "claude" directive) would have left behind.
  await saveSession(entry.slug, THREAD, "session-claude-1", "claude");
  await setThreadEngine(entry.slug, THREAD, "claude");
  await setThreadModel(entry.slug, THREAD, "haiku");
  await setThreadEffort(entry.slug, THREAD, "low");

  const client = fakeClient();
  await click(client, "C_MW_SAME", MODEL_WIZARD_SCOPE_CHANNEL_ACTION, wizardValue());
  await click(client, "C_MW_SAME", "cg_mw_engine_claude", wizardValue());
  await click(client, "C_MW_SAME", `${MODEL_PICKER_ACTION}_1`, wizardValue("claude-opus-5-5"));
  await click(client, "C_MW_SAME", `${EFFORT_PICKER_ACTION}_1`, wizardValue("high"));

  const meta = await getChannelMeta(entry.slug);
  assert.deepEqual([meta.engine, meta.model, meta.effort], ["claude", "claude-opus-5-5", "high"]);
  // Nothing of the thread's own is left to shadow the channel: the next turn in THIS thread
  // resolves Opus 5.5/high from the channel, and the harness it was already on needs no pin.
  assert.equal(await getThreadModel(entry.slug, THREAD), "");
  assert.equal(await getThreadEffort(entry.slug, THREAD), "");
  assert.equal(await getThreadEngine(entry.slug, THREAD), "", "a thread already on the chosen harness stays unpinned");

  const done = client.updates.at(-1);
  assert.match(done.text, /Runtime updated/);
  assert.doesNotMatch(JSON.stringify(done.blocks), /fresh Claude session/, "nothing moved, so nothing to warn about");
});

test("a dedicated channel Codex login offers only Codex models and rejects an old Claude button", async () => {
  saveSettings({ engine: "claude", modelChangeAccess: "admins", engineEnabled: { claude: true, codex: true } });
  await setUser(ADMIN, { name: "Admin", approved: true, isAdmin: true });
  const entry = await channel("C_MW_LOCKED", "mw-codex-locked", { codexAuthSource: "channel", engine: "codex", model: "" });
  await saveSession(entry.slug, THREAD, "old-claude-session", "claude");
  await setThreadEngine(entry.slug, THREAD, "claude");
  assert.equal(await resolveThreadEngine(entry.slug, THREAD, await getChannelMeta(entry.slug)), "codex");
  const client = fakeClient();
  await click(client, "C_MW_LOCKED", MODEL_WIZARD_SCOPE_CHANNEL_ACTION, wizardValue());
  const card = JSON.stringify(client.updates.at(-1).blocks);
  assert.match(card, /Choose a Codex model/);
  assert.doesNotMatch(card, /cg_mw_engine_claude/);
  await click(client, "C_MW_LOCKED", "cg_mw_engine_claude", wizardValue());
  assert.equal((await getChannelMeta(entry.slug)).engine, "codex");
  assert.match(client.ephemerals.at(-1).text, /engine stays Codex/);
});

test("Fable 5.1 saves its exact ID while an older Fable button remains usable", async () => {
  const entry = await channel("C_MW_FABLE", "mw-fable-model");
  const client = fakeClient();
  await click(client, "C_MW_FABLE", MODEL_WIZARD_SCOPE_CHANNEL_ACTION, wizardValue());
  await click(client, "C_MW_FABLE", "cg_mw_engine_claude", wizardValue());
  await click(client, "C_MW_FABLE", `${MODEL_PICKER_ACTION}_2`, wizardValue("claude-fable-5-1"));
  assert.equal((await getChannelMeta(entry.slug)).model, "claude-fable-5-1");
  await click(client, "C_MW_FABLE", `${MODEL_PICKER_ACTION}_7`, wizardValue("fable"));
  assert.equal((await getChannelMeta(entry.slug)).model, "fable");
  assert.equal(client.ephemerals.length, 0);
});

test("a channel-scope harness pick moves a thread whose session belongs to the other harness", async () => {
  saveSettings({ engine: "claude", modelChangeAccess: "admins", engineEnabled: { claude: true, codex: true } });
  await setUser(ADMIN, { name: "Admin", approved: true, isAdmin: true });
  const entry = await channel("C_MW_MOVE", "mw-cross-harness");
  await saveSession(entry.slug, THREAD, "session-claude-2", "claude");

  const client = fakeClient();
  await click(client, "C_MW_MOVE", MODEL_WIZARD_SCOPE_CHANNEL_ACTION, wizardValue());
  await click(client, "C_MW_MOVE", "cg_mw_engine_codex", wizardValue());
  await click(client, "C_MW_MOVE", `${MODEL_PICKER_ACTION}_1`, wizardValue("gpt-5.5"));
  await click(client, "C_MW_MOVE", `${EFFORT_PICKER_ACTION}_1`, wizardValue("high"));

  const meta = await getChannelMeta(entry.slug);
  assert.equal(meta.engine, "codex");
  assert.equal(meta.model, "gpt-5.5");
  // The pin is what makes run.js actually switch a LIVE thread — without it the session's own
  // harness wins (decideThreadEngine) and the Codex model is dropped as foreign to Claude.
  const pinned = await getThreadEngine(entry.slug, THREAD);
  assert.equal(pinned, "codex");
  assert.equal(
    decideThreadEngine({ requested: pinned, sessionEngine: "claude", isNew: false, explicit: true }).switch,
    true,
  );
  // Model + effort still come from the channel, so a later channel change reaches this thread too.
  assert.equal(await getThreadModel(entry.slug, THREAD), "");
  assert.equal(await getThreadEffort(entry.slug, THREAD), "");

  assert.match(JSON.stringify(client.updates.at(-1).blocks), /fresh Codex session/);
});

test("a thread with no session of its own is never pinned by a channel-scope pick", async () => {
  saveSettings({ engine: "claude", modelChangeAccess: "admins", engineEnabled: { claude: true, codex: true } });
  await setUser(ADMIN, { name: "Admin", approved: true, isAdmin: true });
  const entry = await channel("C_MW_FRESH", "mw-fresh-thread");

  const client = fakeClient();
  await click(client, "C_MW_FRESH", MODEL_WIZARD_SCOPE_CHANNEL_ACTION, wizardValue());
  await click(client, "C_MW_FRESH", "cg_mw_engine_codex", wizardValue());

  assert.equal((await getChannelMeta(entry.slug)).engine, "codex");
  assert.equal(await getThreadEngine(entry.slug, THREAD), "", "nothing to move, so the thread keeps following the channel");
});
