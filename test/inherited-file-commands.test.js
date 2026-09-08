import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();
process.env.PATH = `${fileURLToPath(new URL("fixtures", import.meta.url))}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
const { saveSettings } = await import("../src/config/settings.js");
saveSettings({ memoryReviewEvery: 0 });
const { setUser } = await import("../src/config/store.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { readEvents } = await import("../src/util/logger.js");
const USER = "U_FILE_COMMAND";
const BOT = "UFILECOMMANDBOT";
// Oversize metadata deliberately avoids any network download if the pipeline wrongly runs.
const file = { id: "FCOMMAND", name: "owned.txt", size: Number.MAX_SAFE_INTEGER, url_private_download: "https://files.slack.test/owned" };
let sequence = 0;
function fixture(text, variant, { canonicalText = text, lookupFails = false } = {}) {
  const channel = `D_FILE_COMMAND_${++sequence}`;
  const event = { type: "message", channel, channel_type: "im", user: USER, ts: "103.1", thread_ts: "100.1", text,
    ...(variant === "trigger-current" ? { files: [file] } : {}) };
  const exact = { ...event, text: canonicalText, ...(variant === "canonical-current" ? { files: [file] } : {}) };
  const root = { ts: "100.1", user: USER, text: "subject", ...(variant === "root" ? { files: [file] } : {}) };
  const previous = { ts: "102.1", user: BOT, text: "prior reply", ...(variant === "previous" ? { files: [file] } : {}) };
  const posted = [];
  const ok = async () => ({ ok: true });
  const client = {
    posted,
    chat: { postMessage: async m => { posted.push(m); return { ok: true, ts: `bot.${posted.length}` }; }, postEphemeral: async m => { posted.push(m); return { ok: true }; }, update: ok, delete: ok },
    conversations: { replies: async args => { if (lookupFails) throw new Error("read unavailable"); return { messages: args.oldest ? [exact] : [root, previous, exact] }; }, history: async () => ({ messages: [] }), info: async () => ({ channel: { id: channel } }), members: async () => ({ members: [USER], response_metadata: {} }) },
    users: { info: async () => ({ user: { real_name: "File command tester" } }), list: async () => ({ members: [], response_metadata: {} }) },
    apiCall: ok,
  };
  return { client, event, channel };
}
async function execute(text, variant, opts) {
  await setUser(USER, { name: "File command tester", approved: true });
  const f = fixture(text, variant, opts);
  await processMessageEvent(f.event, f.client, { botUserId: BOT });
  return { ...f, starts: readEvents({ limit: 1000 }).filter(e => e.event === "run_start" && e.channel === f.channel), text: f.client.posted.map(m => m.text || "").join("\n") };
}
for (const variant of ["previous", "root", "none"]) {
  test(`current controls bypass the engine with ${variant} historical attachments`, async () => {
    for (const [command, expected] of [["/menu", /Channel menu/], ["/files", /The \/files command has been removed/], ["stop", /Nothing is running/], ["pending", /follow|pending|waiting/i], ["/help", /ChannelGate|Commands|commands/], ["/next", /Add the task after/]]) {
      const result = await execute(`<@${BOT}> ${command}`, variant);
      assert.equal(result.starts.length, 0, `${command} must not start an engine`);
      assert.match(result.text, expected);
      if (command === "/files") assert.ok(result.client.posted.every(m => !m.blocks?.some(b => b.accessory?.text?.text === "Open files")));
    }
  });
}
test("canonical current attachments omitted from a trigger retain attachment semantics", async () => {
  const result = await execute("/files", "canonical-current");
  assert.equal(result.starts.length, 1);
  assert.doesNotMatch(result.text, /The \/files command has been removed/);
});
test("failed canonical reads preserve current trigger attachments", async () => {
  const result = await execute("/files", "trigger-current", { lookupFails: true });
  assert.equal(result.starts.length, 1);
  assert.doesNotMatch(result.text, /The \/files command has been removed/);
});
test("canonical text controls routing even when the trigger text is incomplete", async () => {
  const result = await execute("earlier envelope text", "previous", { canonicalText: `<@${BOT}> /files` });
  assert.equal(result.starts.length, 0);
  assert.match(result.text, /The \/files command has been removed/);
});
test("unknown commands and ordinary followups retain preceding attachment recovery", async () => {
  for (const prompt of ["/unknown-command", "read that file", "/next read that file", "/compact"]) {
    const result = await execute(prompt, "previous");
    assert.equal(result.starts.length, 1);
    assert.equal(result.starts[0].files, 1);
  }
});
