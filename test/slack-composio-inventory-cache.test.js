import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { createSettingsComposioCache } = await import("../src/slack/composio-inventory-cache.js");

const input = { kind: "user", id: "UVIEWER", record: { composioToken: "private-token" } };
const ready = { state: "ready", source: "user", accounts: [{ app: "gmail", id: "mail" }] };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test("inventory cache coalesces slow reads, uses its TTL and refreshes explicitly", async () => {
  let time = 100; let calls = 0;
  const pending = deferred();
  const cache = createSettingsComposioCache({ config: () => ({ mode: "personal" }), now: () => time, ttlMs: 60,
    load: async () => { calls++; return calls === 1 ? pending.promise : ready; } });
  const first = cache.load(input); const second = cache.load(input);
  assert.equal(cache.peek(input), undefined);
  await Promise.resolve(); assert.equal(calls, 1);
  pending.resolve(ready);
  assert.deepEqual(await Promise.all([first, second]), [ready, ready]);
  time = 159; assert.equal(cache.peek(input), ready);
  assert.equal(await cache.load(input), ready); assert.equal(calls, 1);
  time = 160; assert.equal(cache.peek(input), undefined);
  await cache.load(input); assert.equal(calls, 2);
  await cache.load(input, { force: true }); assert.equal(calls, 3);
  cache.invalidate(input); assert.equal(cache.peek(input), undefined);
  await cache.load(input); assert.equal(calls, 4);
});

test("cache keys separate viewer/channel identities and every credential or routing rotation", async () => {
  let config = { mode: "personal", defaultToken: "default-secret", sdkApiKey: "sdk-secret", url: "https://one.example", workspaceId: "TONE" };
  const cache = createSettingsComposioCache({ config: () => config, load: async () => ready });
  const key = cache.key(input);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(key, /private-token|default-secret|sdk-secret/);
  await cache.load(input);
  for (const change of [
    { kind: "channel" }, { id: "UOTHER" }, { record: { composioToken: "new-token" } },
    { record: { ...input.record, noDefaultTokens: true } }, { record: { ...input.record, isDM: true } },
    { record: { ...input.record, type: "im" } },
  ]) { assert.notEqual(cache.key({ ...input, ...change }), key); assert.equal(cache.peek({ ...input, ...change }), undefined); }
  for (const [field, value] of Object.entries({ mode: "sdk", defaultToken: "rotated", sdkApiKey: "rotated", url: "https://two.example", workspaceId: "TTWO" })) {
    const before = config; config = { ...config, [field]: value };
    assert.notEqual(cache.key(input), key); assert.equal(cache.peek(input), undefined); config = before;
  }
});

test("in-flight invalidation and key rotation never repopulate the current identity", async () => {
  const pending = deferred(); let calls = 0; let config = { mode: "personal", defaultToken: "before" };
  const cache = createSettingsComposioCache({ config: () => config, load: async () => ++calls === 1 ? pending.promise : ready });
  const old = cache.load(input);
  cache.invalidate(input);
  await cache.load(input);
  pending.resolve({ ...ready, accounts: [{ id: "stale" }] }); await old;
  assert.equal(cache.peek(input), ready);
  config = { ...config, defaultToken: "after" };
  assert.equal(cache.peek(input), undefined);
});

test("cache bounds retained identities and converts private backend errors to safe public state", async () => {
  const cache = createSettingsComposioCache({ maxEntries: 2, config: () => ({ mode: "sdk" }), load: async (request) => {
    if (request.id === "FAIL") throw new Error("private-token https://secret.example/auth");
    return ready;
  } });
  await cache.load(input); await cache.load({ ...input, id: "UTWO" }); await cache.load({ ...input, id: "UTHREE" });
  assert.equal(cache.peek(input), undefined);
  const failure = await cache.load({ ...input, id: "FAIL" });
  assert.equal(failure.state, "unavailable"); assert.equal(failure.mode, "sdk"); assert.deepEqual(failure.accounts, []);
  assert.doesNotMatch(JSON.stringify(failure), /private-token|secret.example/);
});
