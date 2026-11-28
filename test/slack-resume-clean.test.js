// Bare `/resume` in a `/clean` thread must print the clean workspace the session was minted in —
// the same answer /menu's Resume button and Settings → Diagnostics give for that session id.
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();
const { saveSettings } = await import("../src/config/settings.js");
const { setUser, upsertChannelEntry, getChannelMeta } = await import("../src/config/store.js");
const { setThreadClean } = await import("../src/gateway/thread-engine.js");
const { saveSession } = await import("../src/gateway/sessions.js");
const { effectiveWorkDir } = await import("../src/gateway/folders.js");
const { resolveResumeSession } = await import("../src/slack/resume-session.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");

function slack() {
  const posted = [];
  const ok = async () => ({ ok: true });
  let nextTs = 3000;
  return {
    posted,
    chat: { postMessage: async (m) => { posted.push(m); return { ok: true, ts: `${++nextTs}.001` }; }, update: ok, postEphemeral: ok, getPermalink: async () => ({ permalink: "https://slack.test/p1" }) },
    users: { info: async ({ user }) => ({ user: { id: user, real_name: "Resume User" } }), list: async () => ({ members: [], response_metadata: {} }) },
    conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [], response_metadata: {} }) },
    apiCall: async () => ({ ok: true }),
  };
}

for (const engine of ["claude", "codex"]) {
  test(`${engine} bare /resume in a /clean thread names the clean workspace, matching Diagnostics`, async () => {
    saveSettings({ engine, engineEnabled: { claude: true, codex: true } });
    const user = `U_RESUME_CLEAN_${engine.toUpperCase()}`;
    const channel = `D_RESUME_CLEAN_${engine.toUpperCase()}`;
    await setUser(user, { name: "Resume User", approved: true });
    const entry = await upsertChannelEntry(channel, { name: `resume-clean-${engine}`, isDM: true, type: "im" });
    const thread = "7100.001";
    const sessionId = `clean-session-${engine}`;
    await saveSession(entry.slug, thread, sessionId, engine, null, JSON.stringify({ backend: "container", scope: "project" }));
    await setThreadClean(entry.slug, thread, true);
    const meta = (await getChannelMeta(entry.slug)) || {};
    const normalDir = effectiveWorkDir(entry.slug, meta);
    const cleanDir = effectiveWorkDir(entry.slug, { ...meta, cleanMode: true });
    assert.notEqual(cleanDir, normalDir, "fixture: the clean workspace differs from the channel folder");

    const diagnostics = await resolveResumeSession({ entry, meta }, thread);
    assert.equal(diagnostics.workDir, cleanDir);

    const client = slack();
    await processMessageEvent({ type: "message", channel, channel_type: "im", user, thread_ts: thread, ts: "7100.002", text: "/resume" }, client, { botUserId: "UBOT" });
    const reply = client.posted.find((m) => String(m.text || "").includes(sessionId))?.text || "";
    assert.ok(reply.includes(diagnostics.command), `the /resume reply carries the Diagnostics command:\n${reply}\n---\n${diagnostics.command}`);
    assert.ok(reply.includes(cleanDir), "names the clean workspace");
    assert.ok(!reply.includes(JSON.stringify(normalDir)) && !reply.includes(`'${normalDir}'`), "does not name the normal channel folder");
  });
}

test("bare /resume of an admin-scope session still refuses a non-admin author", async () => {
  saveSettings({ engine: "claude", engineEnabled: { claude: true, codex: true } });
  const user = "U_RESUME_ADMIN_SCOPE", channel = "D_RESUME_ADMIN_SCOPE";
  await setUser(user, { name: "Resume User", approved: true });
  const entry = await upsertChannelEntry(channel, { name: "resume-admin-scope", isDM: true, type: "im" });
  await saveSession(entry.slug, "7200.001", "admin-scope-session", "claude", null, JSON.stringify({ backend: "container", scope: "admin" }));
  const client = slack();
  await processMessageEvent({ type: "message", channel, channel_type: "im", user, thread_ts: "7200.001", ts: "7200.002", text: "/resume" }, client, { botUserId: "UBOT" });
  assert.ok(client.posted.some((m) => /under your own access level/.test(m.text || "")));
  assert.equal(client.posted.some((m) => String(m.text || "").includes("admin-scope-session")), false);
});
