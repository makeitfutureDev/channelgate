import test from "node:test";
import assert from "node:assert/strict";

const { createToolHandlers, validateSessionUrl } = await import("../src/mcp/composio-sdk-bridge.js");

test("SDK bridge forwards tool listing and calls without changing payloads", async () => {
  const calls = [];
  const remote = {
    listTools: async () => ({ tools: [{ name: "COMPOSIO_SEARCH_TOOLS" }] }),
    callTool: async (params) => {
      calls.push(params);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  const handlers = createToolHandlers(remote);

  assert.deepEqual(await handlers.listTools(), {
    tools: [{ name: "COMPOSIO_SEARCH_TOOLS" }],
  });
  assert.deepEqual(
    await handlers.callTool({ name: "COMPOSIO_SEARCH_TOOLS", arguments: { query: "gmail" } }),
    { content: [{ type: "text", text: "ok" }] }
  );
  assert.deepEqual(calls, [
    { name: "COMPOSIO_SEARCH_TOOLS", arguments: { query: "gmail" } },
  ]);
});

test("SDK bridge accepts only hosted HTTPS Composio session URLs", () => {
  assert.equal(
    validateSessionUrl("https://app.composio.dev/tool_router/v3/trs_1/mcp").hostname,
    "app.composio.dev"
  );
  assert.throws(() => validateSessionUrl("http://app.composio.dev/tool_router/v3/trs_1/mcp"), /HTTPS/i);
  assert.throws(() => validateSessionUrl("https://composio.dev.evil.example/mcp"), /Composio/i);
  assert.throws(() => validateSessionUrl("file:///etc/passwd"), /HTTPS/i);
});
