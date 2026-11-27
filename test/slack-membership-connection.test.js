import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createSlackManager } = await import("../src/slack/manager.js");
const {
  assertChannelMembership, invalidateSlackMembership, confirmSlackMembership,
} = await import("../src/gateway/channel-membership.js");

test("Socket Mode loss pauses membership admission synchronously until its new connection is verified", async () => {
  const socket = new EventEmitter();
  const app = { receiver: { client: socket }, client: {}, stop: async () => {} };
  const manager = createSlackManager({ start: async () => ({ app, botUserId: "U_BOT" }) });
  const target = { channelId: "C_CONNECTION", type: "channel" };
  manager.onDisconnected(() => invalidateSlackMembership());
  await manager.connect({});
  confirmSlackMembership(target.channelId);
  assert.doesNotThrow(() => assertChannelMembership(target));
  socket.emit("reconnecting");
  assert.equal(manager.snapshot().connected, false, "offline Socket Mode must not look connected to recovery retries");
  assert.throws(() => assertChannelMembership(target), { code: "channel_membership_unverified" });
  socket.emit("connected");
  assert.equal(manager.snapshot().connected, true);
  assert.throws(() => assertChannelMembership(target), { code: "channel_membership_unverified" }, "the socket opening alone cannot prove channel membership");
  confirmSlackMembership(target.channelId);
  assert.doesNotThrow(() => assertChannelMembership(target));
  const disconnecting = manager.disconnect();
  assert.throws(() => assertChannelMembership(target), { code: "channel_membership_unverified" }, "explicit disconnect closes admission before teardown awaits");
  await disconnecting;
  assert.equal(socket.listenerCount("connected"), 0);
  assert.equal(socket.listenerCount("reconnecting"), 0);
  assert.equal(socket.listenerCount("disconnected"), 0);
});

test("Socket Mode connected notifications invalidate previous membership even if no disconnect event was delivered", async () => {
  const socket = new EventEmitter();
  const app = { receiver: { client: socket }, client: {}, stop: async () => {} };
  const manager = createSlackManager({ start: async () => ({ app, botUserId: "U_BOT" }) });
  const target = { channelId: "C_CONNECTION_GAP", type: "channel" };
  manager.onDisconnected(() => invalidateSlackMembership());
  await manager.connect({});
  confirmSlackMembership(target.channelId);
  socket.emit("connected");
  assert.throws(() => assertChannelMembership(target), { code: "channel_membership_unverified" });
  await manager.disconnect();
});
