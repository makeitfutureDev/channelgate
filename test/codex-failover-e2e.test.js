// The other direction: a channel whose PRIMARY harness is Codex hits its ChatGPT plan limit and
// the turn is answered by Claude instead of hard-failing until the quota resets — plus the
// per-harness on/off switch, which must re-point a channel that is still configured for a disabled
// engine. Drives the real orchestrator against the stub CLIs on PATH.
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureBin = path.join(projectRoot, "test", "fixtures");
ensureTestEnv();
const { useFakeRuntime: __useFakeRuntime, fakeTarget: __fakeTarget } = await import("./runtime-fake.js");
const __fakeBackend = await __useFakeRuntime();
// A direct runner call (no run.js in front of it) needs the container-shaped target the runner requires.
const __directTarget = () => __fakeTarget(__fakeBackend, "codex-failover-direct", { platform: "slack", channelId: "D_CODEX_FAILOVER" });
process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage, resetEngineCooldowns } = await import("../src/gateway/run.js");
const { runCodex } = await import("../src/engines/codex.js");
const { setThreadEngine, setThreadModel } = await import("../src/gateway/thread-engine.js");

const codexChannel = async (id, name) => {
  const entry = await upsertChannelEntry(id, { name, type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: id, name: entry.name, type: "im", isDM: true, template: "custom",
    engine: "codex", cleanMode: true, allowNetwork: false,
  });
  return entry;
};

test("a Codex usage limit reported as a JSON error event falls back to Claude", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_CODEX_LIMIT", { name: "Codex Limit", approved: true, isAdmin: false });
  await codexChannel("D_CODEX_LIMIT", "codex-limit");

  const result = await runMessage({
    channelId: "D_CODEX_LIMIT",
    authorId: "U_CODEX_LIMIT",
    text: "CODEX_STUB_LIMIT_FAIL_SAFE",
    threadKey: "1901.010",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  assert.equal(result.engine, "claude");
  assert.equal(result.fellBack, true);
  assert.equal(result.fallbackFrom, "codex");
  assert.equal(result.fellBackToCodex, false, "the legacy flag names the TARGET, and Claude is not Codex");
  assert.match(result.content, /Codex hit its usage limit.*using Claude/i);
  assert.match(result.content, /Stub engine reply/);
});

test("the same limit printed on stderr with a nonzero exit also falls back", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_CODEX_LIMIT_ERR", { name: "Codex Limit Stderr", approved: true, isAdmin: false });
  await codexChannel("D_CODEX_LIMIT_ERR", "codex-limit-stderr");

  const result = await runMessage({
    channelId: "D_CODEX_LIMIT_ERR",
    authorId: "U_CODEX_LIMIT_ERR",
    text: "CODEX_STUB_LIMIT_STDERR",
    threadKey: "1901.020",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  assert.equal(result.engine, "claude");
  assert.match(result.content, /Codex hit its usage limit.*using Claude/i);
  assert.match(result.content, /Stub engine reply/);
});

test("a Codex sign-in lost mid-turn is answered by Claude, with the reason on the message", async () => {
  // The incident this covers: Codex printed its logged-out line on stderr and then kept running,
  // producing nothing. The user saw only a ticking heartbeat, pressed stop, and never learned the
  // credential was gone. Now the runner ends that turn and the orchestrator answers with Claude.
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_CODEX_AUTH", { name: "Codex Auth", approved: true, isAdmin: false });
  await codexChannel("D_CODEX_AUTH", "codex-auth");

  const result = await runMessage({
    channelId: "D_CODEX_AUTH",
    authorId: "U_CODEX_AUTH",
    text: "CODEX_STUB_AUTH_HANG",
    threadKey: "1901.025",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  assert.equal(result.engine, "claude");
  assert.equal(result.fellBack, true);
  assert.equal(result.fallbackFrom, "codex");
  assert.match(result.content, /Codex authentication failed.*using Claude/i);
  assert.match(result.content, /Stub engine reply/);
});

test("the auth cooldown holds for the SAME service API credential and releases after rotation", async (t) => {
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-service-before-rotation";
  t.after(() => { if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey; });
  // A cooldown is a memory of a broken credential. Holding it for a fixed window after the
  // operator has already run `codex login` is its own confusing failure ("I fixed it — why is it
  // still answering as Claude?"), so the release is keyed on the credential actually changing.
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_CODEX_COOL", { name: "Codex Cooldown", approved: true, isAdmin: false });
  await codexChannel("D_CODEX_COOL", "codex-cooldown");

  const send = (text, threadKey) => runMessage({
    channelId: "D_CODEX_COOL",
    authorId: "U_CODEX_COOL",
    text,
    threadKey,
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  const broke = await send("CODEX_STUB_AUTH_HANG", "1901.026");
  assert.equal(broke.engine, "claude", "the failing turn is answered by the other harness");

  const during = await send("hello again", "1901.027");
  assert.equal(during.engine, "claude", "the same credential is not retried during the cooldown");
  assert.match(during.content, /authentication is unavailable right now/i);

  // `codex login` rewrites auth.json; the engine home reaches it through a symlink.
  process.env.OPENAI_API_KEY = "test-service-after-rotation";

  const after = await send("hello once more", "1901.028");
  assert.equal(after.engine, "codex", "a replaced credential ends the cooldown immediately");
  assert.match(after.content, /Codex stub reply/);
});

test("a Codex limit that lands after a tool ran is NOT replayed on the other harness", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_CODEX_LIMIT_TOOL", { name: "Codex Limit Tool", approved: true, isAdmin: false });
  await codexChannel("D_CODEX_LIMIT_TOOL", "codex-limit-tool");

  await assert.rejects(
    runMessage({
      channelId: "D_CODEX_LIMIT_TOOL",
      authorId: "U_CODEX_LIMIT_TOOL",
      text: "CODEX_STUB_LIMIT_AFTER_TOOL",
      threadKey: "1901.030",
      origin: "slack_foreground",
      preferCold: true,
      getFallbackContext: async () => "Conversation context\n\n",
    }),
    (error) => {
      assert.match(error.message, /usage limit/i);
      assert.equal(error.details?.providerKind, "usage_limit");
      assert.equal(error.details?.replaySafe, false, "a tool may have mutated something — the turn must not run twice");
      return true;
    },
  );
});

// ── A runtime the user pinned ──────────────────────────────────────────────────
// Failover exists so a DEFAULT never strands a thread. A thread someone pinned by hand is the
// opposite case: answering it as the other harness, with a different model, is not a smaller
// version of what was asked — it is a different answer than the one they chose.

test("a thread pinned to a harness fails with its own error instead of switching", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_PIN_ENGINE", { name: "Pinned Engine", approved: true, isAdmin: false });
  const entry = await codexChannel("D_PIN_ENGINE", "pin-engine");
  await setThreadEngine(entry.slug, "1902.010", "codex");

  await assert.rejects(
    runMessage({
      channelId: "D_PIN_ENGINE",
      authorId: "U_PIN_ENGINE",
      text: "CODEX_STUB_LIMIT_FAIL_SAFE",
      threadKey: "1902.010",
      origin: "slack_foreground",
      preferCold: true,
      getFallbackContext: async () => "Conversation context\n\n",
    }),
    (error) => {
      assert.match(error.message, /purchase more credits/, "the harness's own error is what surfaces");
      assert.equal(error.details?.runtimePinned, true, "the reason nothing switched is on the error");
      assert.equal(error.details?.pinnedEngine, "codex");
      return true;
    },
  );
});

test("a thread pinned to a MODEL is just as pinned — the harness is part of that choice", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_PIN_MODEL", { name: "Pinned Model", approved: true, isAdmin: false });
  const entry = await codexChannel("D_PIN_MODEL", "pin-model");
  await setThreadModel(entry.slug, "1902.020", "gpt-5.6-sol");

  await assert.rejects(
    runMessage({
      channelId: "D_PIN_MODEL",
      authorId: "U_PIN_MODEL",
      text: "CODEX_STUB_LIMIT_FAIL_SAFE",
      threadKey: "1902.020",
      origin: "slack_foreground",
      preferCold: true,
      getFallbackContext: async () => "Conversation context\n\n",
    }),
    (error) => {
      assert.equal(error.details?.runtimePinned, true);
      assert.equal(error.details?.pinnedModel, "gpt-5.6-sol", "the model that was pinned is named back");
      return true;
    },
  );
});

test("a model override left behind for the OTHER harness does not pin anything", async () => {
  // A stale value never reaches the CLI (the spawn-time compatibility gate drops it), so it must
  // not silently disable failover either — that would be a pin the user cannot see.
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_PIN_STALE", { name: "Stale Pin", approved: true, isAdmin: false });
  const entry = await codexChannel("D_PIN_STALE", "pin-stale");
  await setThreadModel(entry.slug, "1902.030", "opus");

  const result = await runMessage({
    channelId: "D_PIN_STALE",
    authorId: "U_PIN_STALE",
    text: "CODEX_STUB_LIMIT_FAIL_SAFE",
    threadKey: "1902.030",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  assert.equal(result.engine, "claude", "an unpinned thread still gets the failover it depends on");
});

test("failover turned off leaves the limit as an ordinary failure", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: false, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_CODEX_NO_FB", { name: "Codex No Fallback", approved: true, isAdmin: false });
  await codexChannel("D_CODEX_NO_FB", "codex-no-fallback");

  await assert.rejects(
    runMessage({
      channelId: "D_CODEX_NO_FB",
      authorId: "U_CODEX_NO_FB",
      text: "CODEX_STUB_LIMIT_FAIL_SAFE",
      threadKey: "1901.040",
      origin: "slack_foreground",
      preferCold: true,
    }),
    /usage limit/i,
  );
});

test("a disabled fallback harness is never resurrected as a failover target", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: false, codex: true }, composioMode: "personal" });
  await setUser("U_CODEX_FB_OFF", { name: "Codex Fallback Off", approved: true, isAdmin: false });
  await codexChannel("D_CODEX_FB_OFF", "codex-fallback-off");

  await assert.rejects(
    runMessage({
      channelId: "D_CODEX_FB_OFF",
      authorId: "U_CODEX_FB_OFF",
      text: "CODEX_STUB_LIMIT_FAIL_SAFE",
      threadKey: "1901.050",
      origin: "slack_foreground",
      preferCold: true,
    }),
    /usage limit/i,
  );
});

test("a channel still configured for a DISABLED harness runs on an enabled one", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: false }, composioMode: "personal" });
  await setUser("U_ENGINE_OFF", { name: "Engine Off", approved: true, isAdmin: false });
  await codexChannel("D_ENGINE_OFF", "engine-off");

  const result = await runMessage({
    channelId: "D_ENGINE_OFF",
    authorId: "U_ENGINE_OFF",
    text: "hello",
    threadKey: "1901.060",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  assert.equal(result.engine, "claude", "the stored channel engine points at a harness the admin turned off");
  assert.match(result.content, /Stub engine reply/);
});

test("the Codex runner types the plan-limit rejection as a replay-safe provider failure", async () => {
  await assert.rejects(
    runCodex({
      cwd: fixtureBin,
      prompt: "CODEX_STUB_LIMIT_FAIL_SAFE",
      sessionId: "",
      isNewSession: true,
      timeoutMs: 5_000,
      maxSilenceMs: 5_000,
      ...(() => { const target = __directTarget(); return { target, artifactDir: target.artifactDir }; })(),
    }),
    (error) => {
      assert.match(error.message, /purchase more credits/);
      assert.equal(error.details?.engine, "codex");
      assert.equal(error.details?.providerError, true);
      assert.equal(error.details?.providerKind, "usage_limit");
      assert.equal(error.details?.replaySafe, true);
      return true;
    },
  );
});


test("a native Codex login failure in one channel does not suppress another channel", async () => {
  const oldOpenAiKey = process.env.OPENAI_API_KEY;
  const oldCodexKey = process.env.CODEX_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
  try {
    resetEngineCooldowns();
    saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
    await setUser("U_NATIVE_AUTH", { name: "Native Auth", approved: true, isAdmin: false });
    await codexChannel("D_NATIVE_AUTH_FIRST", "native-auth-first");
    await codexChannel("D_NATIVE_AUTH_SECOND", "native-auth-second");
    const send = (channelId, text, threadKey) => runMessage({
      channelId, authorId: "U_NATIVE_AUTH", text, threadKey, origin: "slack_foreground", preferCold: true,
      getFallbackContext: async () => "Conversation context\n\n",
    });
    const failed = await send("D_NATIVE_AUTH_FIRST", "CODEX_STUB_AUTH_HANG", "1910.001");
    assert.equal(failed.engine, "claude");
    const healthy = await send("D_NATIVE_AUTH_SECOND", "hello", "1910.002");
    assert.equal(healthy.engine, "codex", "a different container's login must still be tried");
    assert.match(healthy.content, /Codex stub reply/);
  } finally {
    if (oldOpenAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAiKey;
    if (oldCodexKey === undefined) delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY = oldCodexKey;
    resetEngineCooldowns();
  }
});
