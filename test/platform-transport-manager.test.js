import test from "node:test";
import assert from "node:assert/strict";
import { createTransportManager } from "../src/platforms/manager.js";

const quiet = { error() {} };

test("a runtime transport failure removes the live connector and reconnect clears the error", async () => {
  const callbacks = [];
  let stopped = 0;
  const manager = createTransportManager({ platform: "fixture", log: quiet,
    start: async (_config, { onFatal }) => {
      callbacks.push(onFatal);
      return { connector: { id: callbacks.length }, stop: async () => { stopped++; } };
    },
  });
  assert.equal((await manager.connect({})).connected, true);
  callbacks[0](new Error("permission denied"));
  assert.equal(manager.snapshot().status, "error");
  assert.equal(manager.snapshot().connected, false);
  assert.equal(manager.snapshot().error, "permission denied");
  assert.equal(manager.getConnector(), null);
  assert.equal((await manager.connect({})).connected, true);
  assert.equal(stopped, 1);
  assert.equal(manager.snapshot().error, null);
  callbacks[0](new Error("stale failure"));
  assert.equal(manager.snapshot().connected, true);
  assert.equal(manager.getConnector().id, 2);
  await manager.disconnect();
  callbacks[1](new Error("late failure after disconnect"));
  assert.equal(manager.snapshot().status, "disconnected");
  assert.equal(stopped, 2);
});

test("a failure during start cannot be overwritten by connected status", async () => {
  let stopped = false;
  const manager = createTransportManager({ platform: "fixture", log: quiet,
    start: async (_config, { onFatal }) => {
      onFatal(new Error("first pull denied"));
      return { connector: {}, stop: async () => { stopped = true; } };
    },
  });
  const snapshot = await manager.connect({});
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.error, "first pull denied");
  assert.equal(manager.getConnector(), null);
  await manager.disconnect();
  assert.equal(stopped, true);
});
