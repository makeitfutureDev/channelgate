import test from "node:test";
import assert from "node:assert/strict";

import {
  listMakeToolboxTools,
  normalizeMakeToolboxUrl,
  resolveMakeToolboxRuntime,
  resolveMakeToolboxUpdate,
} from "../src/gateway/make-toolbox.js";

test("normalizes official Make and Celonis toolbox server URLs", () => {
  assert.equal(
    normalizeMakeToolboxUrl(" https://eu2.make.com/mcp/server/abc-123/ "),
    "https://eu2.make.com/mcp/server/abc-123",
  );
  assert.equal(
    normalizeMakeToolboxUrl("https://eu1.make.celonis.com/mcp/server/123e4567-e89b-12d3-a456-426614174000"),
    "https://eu1.make.celonis.com/mcp/server/123e4567-e89b-12d3-a456-426614174000",
  );
});

test("rejects unsafe or non-toolbox Make URLs", () => {
  const invalid = [
    "",
    "http://eu1.make.com/mcp/server/abc",
    "https://evil.example/mcp/server/abc",
    "https://make.com.evil.example/mcp/server/abc",
    "https://key@eu1.make.com/mcp/server/abc",
    "https://eu1.make.com:8443/mcp/server/abc",
    "https://eu1.make.com/mcp/stateless",
    "https://eu1.make.com/mcp/server/abc/t/secret/stateless",
    "https://eu1.make.com/mcp/server/abc?key=secret",
    "https://eu1.make.com/mcp/server/abc#fragment",
  ];

  for (const value of invalid) {
    assert.throws(() => normalizeMakeToolboxUrl(value), /Make toolbox URL/i, value);
  }
});

function fakeMcp({ tools = [], listError = null, neverResolve = false } = {}) {
  const state = { transport: null, connected: false, listed: 0, closed: 0 };
  class Transport {
    constructor(url, options) {
      state.transport = { url: String(url), options };
    }
  }
  class Client {
    async connect(transport) {
      state.connected = transport === state.transportInstance;
    }
    async listTools() {
      state.listed += 1;
      if (neverResolve) return new Promise(() => {});
      if (listError) throw listError;
      return { tools };
    }
    async close() {
      state.closed += 1;
    }
  }
  const TransportClass = class extends Transport {
    constructor(url, options) {
      super(url, options);
      state.transportInstance = this;
    }
  };
  return { state, deps: { ClientClass: Client, TransportClass } };
}

test("tests a Make toolbox with a Bearer header and returns a bounded tools/list summary", async () => {
  const tools = Array.from({ length: 24 }, (_, i) => ({ name: `tool_${String(i + 1).padStart(2, "0")}` }));
  const { state, deps } = fakeMcp({ tools });

  const result = await listMakeToolboxTools({
    url: "https://eu2.make.com/mcp/server/abc-123/",
    key: "make-secret-key",
  }, deps);

  assert.equal(state.transport.url, "https://eu2.make.com/mcp/server/abc-123");
  assert.equal(state.transport.options.requestInit.headers.Authorization, "Bearer make-secret-key");
  assert.equal(state.connected, true);
  assert.equal(state.listed, 1);
  assert.equal(state.closed, 1);
  assert.deepEqual(result, {
    count: 24,
    tools: tools.slice(0, 20).map((tool) => tool.name),
  });
});

test("requires a key, times out, closes the client, and never echoes secrets in failures", async () => {
  await assert.rejects(
    () => listMakeToolboxTools({ url: "https://eu2.make.com/mcp/server/abc", key: "" }),
    /key is required/i,
  );

  const { state, deps } = fakeMcp({ neverResolve: true });
  const secret = "must-never-appear";
  await assert.rejects(
    () => listMakeToolboxTools({
      url: "https://eu2.make.com/mcp/server/abc",
      key: secret,
      timeoutMs: 5,
    }, deps),
    (error) => {
      assert.match(error.message, /timed out/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.equal(state.closed, 1);

  const failed = fakeMcp({ listError: new Error(`remote rejected ${secret}`) });
  await assert.rejects(
    () => listMakeToolboxTools({
      url: "https://eu2.make.com/mcp/server/abc",
      key: secret,
    }, failed.deps),
    (error) => {
      assert.match(error.message, /could not connect/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.equal(failed.state.closed, 1);
});

test("runtime resolution enables only a complete valid non-clean toolbox pair", () => {
  assert.deepEqual(resolveMakeToolboxRuntime({
    makeToolboxUrl: "https://eu2.make.com/mcp/server/abc/",
    makeToolboxKey: " key ",
  }), {
    makeToolboxUrl: "https://eu2.make.com/mcp/server/abc",
    makeToolboxKey: "key",
  });
  assert.deepEqual(resolveMakeToolboxRuntime({
    makeToolboxUrl: "https://eu2.make.com/mcp/server/abc",
  }), { makeToolboxUrl: "", makeToolboxKey: "" });
  assert.deepEqual(resolveMakeToolboxRuntime({
    makeToolboxUrl: "https://evil.example/mcp/server/abc",
    makeToolboxKey: "key",
  }), { makeToolboxUrl: "", makeToolboxKey: "" });
  assert.deepEqual(resolveMakeToolboxRuntime({
    makeToolboxUrl: "https://eu2.make.com/mcp/server/abc",
    makeToolboxKey: "key",
    clean: true,
  }), { makeToolboxUrl: "", makeToolboxKey: "" });
});

test("channel updates preserve, replace, clear, and reject partial Make toolbox pairs", () => {
  const current = {
    makeToolboxUrl: "https://eu2.make.com/mcp/server/old",
    makeToolboxKey: "old-key",
  };

  assert.deepEqual(resolveMakeToolboxUpdate(current, {
    makeToolboxUrl: "https://eu2.make.com/mcp/server/old",
  }), current);
  assert.deepEqual(resolveMakeToolboxUpdate(current, {
    makeToolboxUrl: "https://eu1.make.celonis.com/mcp/server/new/",
    makeToolboxKey: " new-key ",
  }), {
    makeToolboxUrl: "https://eu1.make.celonis.com/mcp/server/new",
    makeToolboxKey: "new-key",
  });
  assert.deepEqual(resolveMakeToolboxUpdate(current, { clearMakeToolbox: true }), {
    makeToolboxUrl: "",
    makeToolboxKey: "",
  });
  assert.throws(
    () => resolveMakeToolboxUpdate({}, { makeToolboxUrl: "https://eu2.make.com/mcp/server/new" }),
    /URL and key are both required/i,
  );
  assert.throws(
    () => resolveMakeToolboxUpdate(current, { makeToolboxUrl: "" }),
    /URL and key are both required/i,
  );
});
