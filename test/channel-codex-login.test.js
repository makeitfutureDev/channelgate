import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { channelCodexHome } = await import("../src/gateway/channel-codex-auth.js");
const { startChannelCodexLogin, channelCodexLoginStatus, cancelChannelCodexLogin } = await import("../src/gateway/channel-codex-login.js");

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.emit("close", null); return true; };
  return child;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("device code login exposes only the approved URL/code and selects the channel on success", async () => {
  const id = `C_DEVICE_${Date.now()}`;
  const child = fakeChild();
  let command;
  let saved = 0;
  const state = await startChannelCodexLogin(id, "device", {
    spawnImpl: (...args) => { command = args; return child; },
    onAuthenticated: async () => { saved++; },
  });
  assert.equal(state.phase, "pending");
  assert.deepEqual(command[1], ["login", "-c", 'cli_auth_credentials_store="file"', "--device-auth"]);
  assert.equal(command[2].env.CODEX_HOME, channelCodexHome(id));
  assert.equal(command[2].env.OPENAI_API_KEY, undefined);
  child.stdout.write("Open https://auth.openai.com/codex/device and enter ABCD-EFGH. Secret sk-hidden-1234567890");
  const waiting = await channelCodexLoginStatus(id);
  assert.equal(waiting.code, "ABCD-EFGH");
  assert.equal(waiting.url, "https://auth.openai.com/codex/device");
  assert.ok(!JSON.stringify(waiting).includes("sk-hidden"));
  await writeFile(path.join(channelCodexHome(id), "auth.json"), JSON.stringify({ tokens: { refresh_token: "refresh-secret" } }), { mode: 0o600 });
  child.emit("close", 0);
  await settle();
  const done = await channelCodexLoginStatus(id);
  assert.equal(done.phase, "complete");
  assert.equal(done.method, "chatgpt");
  assert.equal(done.code, "");
  assert.equal(saved, 1);
});

test("API key enters Codex through stdin and never appears in status or argv", async () => {
  const id = `C_KEY_${Date.now()}`;
  const key = "sk-test-private-example-123456789";
  const child = fakeChild();
  let command;
  let stdin = "";
  child.stdin.on("data", (chunk) => { stdin += chunk; });
  let saved = 0;
  const state = await startChannelCodexLogin(id, "api-key", {
    key,
    spawnImpl: (...args) => { command = args; return child; },
    onAuthenticated: async () => { saved++; },
  });
  assert.equal(state.phase, "pending");
  assert.equal(stdin, `${key}\n`);
  assert.ok(!JSON.stringify(command[1]).includes(key));
  assert.ok(!JSON.stringify(command[2].env).includes(key));
  assert.ok(!JSON.stringify(state).includes(key));
  await writeFile(path.join(channelCodexHome(id), "auth.json"), JSON.stringify({ OPENAI_API_KEY: key }), { mode: 0o600 });
  child.emit("close", 0);
  await settle();
  const done = await channelCodexLoginStatus(id);
  assert.equal(done.phase, "complete");
  assert.equal(done.method, "api-key");
  assert.ok(!JSON.stringify(done).includes(key));
  assert.equal(saved, 1);
  assert.equal(JSON.parse(await readFile(path.join(channelCodexHome(id), "auth.json"), "utf8")).OPENAI_API_KEY, key);
});

test("failed and cancelled sign-in never selects the channel", async () => {
  const id = `C_CANCEL_${Date.now()}`;
  const child = fakeChild();
  let saved = 0;
  await startChannelCodexLogin(id, "device", { spawnImpl: () => child, onAuthenticated: async () => { saved++; } });
  assert.equal(cancelChannelCodexLogin(id), true);
  await settle();
  assert.equal((await channelCodexLoginStatus(id)).phase, "idle");
  assert.equal(saved, 0);
  const child2 = fakeChild();
  await startChannelCodexLogin(id, "device", { spawnImpl: () => child2, onAuthenticated: async () => { saved++; } });
  child2.emit("close", 1);
  await settle();
  assert.equal((await channelCodexLoginStatus(id)).phase, "failed");
  assert.equal(saved, 0);
});
