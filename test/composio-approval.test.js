import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { composioApprovalDetails, normalizeComposioCall, withComposioApproval } from "../src/mcp/composio-approval.js";

const invite = { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{
  tool_slug: "SLACK_INVITE_USERS_TO_A_SLACK_CHANNEL", account: "requester",
  arguments: { channel: "C_PRIVATE", users: "U_BOT" },
}] } };
const claims = { channelId: "C_SOURCE", slug: "source", authorId: "U_AUTHOR", threadKey: "1.000" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t, { identity = "composio-user", requestApproval = async () => ({ allow: false }), authorize = () => claims } = {}) {
  const calls = [], cards = [];
  const server = new Server({ name: "upstream", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    calls.push(request.params);
    return { content: [{ type: "text", text: "executed" }] };
  });
  const [engineSide, serverSide] = InMemoryTransport.createLinkedPair();
  const guarded = withComposioApproval(serverSide, { identity, authorize, requestApproval: async (body) => { cards.push(body); return requestApproval(body); } });
  await server.connect(guarded);
  const client = new Client({ name: "engine", version: "1" }, { capabilities: {} });
  await client.connect(engineSide);
  t.after(() => { client.close(); server.close(); });
  return { client, calls, cards, guarded };
}

test("direct, batched, admin and alternate membership actions show identity, account, channel and invitees", () => {
  for (const name of ["SLACK_JOIN_AN_EXISTING_CONVERSATION", "SLACK_INVITE_USER_TO_CHANNEL", "SLACK_ADMIN_CONVERSATIONS_INVITE", "SLACK_CREATE_CHANNEL", "SLACK_CONVERSATIONS_CREATE", "SLACK_ADMIN_CONVERSATIONS_CREATE", "SLACK_ACCEPT_SHARED_INVITE", "conversations.join"]) {
    assert.match(composioApprovalDetails({ name, arguments: { channel: "C_PRIVATE", users: "U_BOT" } }, "composio-agent"), /C_PRIVATE/);
  }
  const details = composioApprovalDetails(invite, "composio-user");
  assert.match(details, /composio-user/);
  assert.match(details, /U_BOT/);
  assert.match(details, /requester/);
  assert.match(details, /sha256:[a-f0-9]{64}/);
  assert.equal(composioApprovalDetails({ name: "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION", arguments: {} }, "composio-user"), null);
  assert.equal(composioApprovalDetails({ name: "COMPOSIO_SEARCH_TOOLS", arguments: { queries: [{ use_case: "invite bot" }] } }, "composio-user"), null);
  assert.equal(composioApprovalDetails({ name: "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL", arguments: { text: "SLACK_INVITE_USER_TO_CHANNEL" } }, "composio-user"), null);
});

for (const identity of ["composio-user", "composio-agent"]) {
  test(`${identity}: no upstream mutation before a click; deny/error/timeout fail closed`, async (t) => {
    let decide;
    const f = await fixture(t, { identity, requestApproval: () => new Promise((resolve) => { decide = resolve; }) });
    const pending = f.client.callTool(invite);
    await tick();
    assert.equal(f.calls.length, 0);
    assert.equal(f.cards.length, 1);
    assert.equal(f.cards[0].approvalType, "agent", "Auto/Admin/remembered permission grants cannot approve agent requests");
    assert.equal(f.cards[0].channelId, "C_SOURCE");
    decide({ allow: false });
    assert.equal((await pending).isError, true);
    assert.equal(f.calls.length, 0);
    for (const decision of [undefined, { pending: true }, { allow: false, reason: "approval timed out" }]) {
      const denied = await fixture(t, { identity, requestApproval: async () => decision });
      assert.equal((await denied.client.callTool(invite)).isError, true);
      assert.equal(denied.calls.length, 0);
    }
    const error = await fixture(t, { identity, requestApproval: async () => { throw new Error("unavailable with secret"); } });
    const result = await error.client.callTool(invite);
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, /with secret/);
  });
}

test("approval executes the exact snapshot once; a repeated action requires another card", async (t) => {
  const f = await fixture(t, { requestApproval: async () => ({ allow: true }) });
  for (let n = 0; n < 2; n++) assert.equal((await f.client.callTool(invite)).content[0].text, "executed");
  assert.deepEqual(f.calls, [invite, invite]);
  assert.equal(f.cards.length, 2);
});

for (const identity of ["composio-user", "composio-agent"]) {
  test(`${identity}: Workbench forwards exact code and session without a membership card`, async (t) => {
    const f = await fixture(t, { identity });
    const request = { name: "COMPOSIO_REMOTE_WORKBENCH", arguments: {
      code_to_execute: "from pathlib import Path\nprint(Path('/mnt/files/checkpoint.json').read_text())",
      session_id: "existing-workflow",
    } };
    for (let turn = 0; turn < 2; turn++) {
      assert.equal((await f.client.callTool(request)).content[0].text, "executed");
    }
    const batched = { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{
      tool_slug: request.name, arguments: request.arguments,
    }] } };
    assert.equal((await f.client.callTool(batched)).content[0].text, "executed");
    assert.deepEqual(f.calls, [request, request, batched]);
    assert.equal(f.cards.length, 0);
    // An admitted Workbench item must not skip a later membership action in the same batch.
    const mixed = structuredClone(batched);
    mixed.arguments.tools.push(invite.arguments.tools[0]);
    assert.equal((await f.client.callTool(mixed)).isError, true);
    assert.equal(f.calls.length, 3);
    assert.equal(f.cards.length, 1);
  });
}

test("Workbench still requires current run authority", async (t) => {
  const f = await fixture(t, { authorize: () => { throw new Error("revoked"); } });
  const result = await f.client.callTool({ name: "COMPOSIO_REMOTE_WORKBENCH", arguments: { code_to_execute: "print(1)" } });
  assert.equal(result.isError, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.cards.length, 0);
});

for (const identity of ["composio-user", "composio-agent"]) {
  test(`${identity}: Remote Bash forwards exact code and session without a membership card`, async (t) => {
    const f = await fixture(t, { identity });
    const request = { name: "COMPOSIO_REMOTE_BASH_TOOL", arguments: {
      command: "jq .total /mnt/files/checkpoint.json",
      session_id: "existing-workflow",
    } };
    for (let turn = 0; turn < 2; turn++) {
      assert.equal((await f.client.callTool(request)).content[0].text, "executed");
    }
    const batched = { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{
      tool_slug: request.name, arguments: request.arguments,
    }] } };
    assert.equal((await f.client.callTool(batched)).content[0].text, "executed");
    assert.deepEqual(f.calls, [request, request, batched]);
    assert.equal(f.cards.length, 0);
    // An admitted Remote Bash item must not skip a later membership action in the same batch.
    const mixed = structuredClone(batched);
    mixed.arguments.tools.push(invite.arguments.tools[0]);
    assert.equal((await f.client.callTool(mixed)).isError, true);
    assert.equal(f.calls.length, 3);
    assert.equal(f.cards.length, 1);
  });
}

test("Remote Bash still requires current run authority", async (t) => {
  const f = await fixture(t, { authorize: () => { throw new Error("revoked"); } });
  const result = await f.client.callTool({ name: "COMPOSIO_REMOTE_BASH_TOOL", arguments: { command: "printf 1" } });
  assert.equal(result.isError, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.cards.length, 0);
});

test("other opaque executors fail closed without an unverifiable approval card", async (t) => {
  const f = await fixture(t);
  for (const name of ["COMPOSIO_REMOTE_WORKBENCH_UNKNOWN", "COMPOSIO_REMOTE_BASH_TOOL_UNKNOWN", "COMPOSIO_PROXY_EXECUTE", "SLACK_CUSTOM_API_CALL", "COMPOSIO_EXECUTE_UNKNOWN"]) {
    assert.equal((await f.client.callTool({ name, arguments: { code: "saved_helper()" } })).isError, true);
  }
  assert.equal(f.cards.length, 0);
  assert.equal(f.calls.length, 0);
});

test("reads continue while membership approval waits; revocation wins over a later click", async (t) => {
  let decide, valid = true;
  const f = await fixture(t, {
    authorize: () => { if (!valid) throw new Error("revoked"); return claims; },
    requestApproval: () => new Promise((resolve) => { decide = resolve; }),
  });
  const pending = f.client.callTool(invite);
  await tick();
  assert.equal((await f.client.callTool({ name: "SLACK_FIND_CHANNELS", arguments: { query: "general" } })).content[0].text, "executed");
  valid = false;
  decide({ allow: true });
  assert.equal((await pending).isError, true);
  assert.equal(f.calls.length, 1);
});

test("cancelled and disconnected calls cannot execute after a late approval", async (t) => {
  for (const disconnect of [false, true]) {
    let decide;
    const f = await fixture(t, { requestApproval: () => new Promise((resolve) => { decide = resolve; }) });
    const controller = new AbortController();
    const pending = f.client.callTool(invite, undefined, { signal: controller.signal }).catch(() => null);
    await tick();
    if (disconnect) await f.client.close();
    else controller.abort();
    await pending;
    await tick();
    decide({ allow: true });
    await tick();
    assert.equal(f.calls.length, 0);
  }
});

test("malformed batch execution fails closed rather than forwarding opaque actions", async (t) => {
  const f = await fixture(t);
  for (const args of [{}, { tools: [{ arguments: {} }] }]) {
    assert.equal((await f.client.callTool({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: args })).isError, true);
  }
  assert.equal(f.calls.length, 0);
});

test("preview shows every channel/account alias and arrays; oversized previews are refused", () => {
  const d = composioApprovalDetails({ name: "SLACK_INVITE_USER_TO_CHANNEL", arguments: { channel: "C_SAFE", channel_id: "C_OTHER", user_ids: ["U_A", "U_B"], account: "one", connected_account_id: "two" } }, "composio-user");
  for (const v of ["channel=C_SAFE", "channel_id=C_OTHER", "user_ids=[U_A, U_B]", "account=one", "connected_account_id=two"]) assert.ok(d.includes(v), v);
  assert.throws(() => composioApprovalDetails({ name: "SLACK_INVITE_USER_TO_CHANNEL", arguments: { users: "U".repeat(200) } }, "composio-user"));
});

const upload = { tool_slug: "GOOGLEDRIVE_UPLOAD_FILE", arguments: { file_to_upload: { name: "offer.pptx", mimetype: "application/vnd.openxmlformats-officedocument.presentationml.presentation", s3key: "k/offer.pptx" } } };

test("a batch whose tools arrive as a JSON string is decoded, inspected and forwarded as the array", async (t) => {
  const f = await fixture(t);
  const encoded = { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: JSON.stringify([upload]), sync_response_to_workbench: false } };
  assert.equal((await f.client.callTool(encoded)).content[0].text, "executed");
  assert.deepEqual(f.calls, [{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [upload], sync_response_to_workbench: false } }]);
  assert.equal(f.cards.length, 0);
  // An item whose arguments are an encoded object is decoded the same way.
  const itemEncoded = { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: upload.tool_slug, arguments: JSON.stringify(upload.arguments) }] } };
  assert.equal((await f.client.callTool(itemEncoded)).content[0].text, "executed");
  assert.deepEqual(f.calls[1], { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [upload] } });
});

test("string encoding cannot hide a membership action from the approval card", async (t) => {
  const f = await fixture(t);
  const encoded = { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: JSON.stringify([upload, invite.arguments.tools[0]]) } };
  const result = await f.client.callTool(encoded);
  assert.equal(result.isError, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.cards.length, 1);
  assert.match(f.cards[0].toolInput.details, /SLACK_INVITE_USERS_TO_A_SLACK_CHANNEL: channel=C_PRIVATE; users=U_BOT/);
  assert.match(result.content[0].text, /changes Slack channel membership/);
  const approved = await fixture(t, { requestApproval: async () => ({ allow: true }) });
  assert.equal((await approved.client.callTool(encoded)).content[0].text, "executed");
  assert.deepEqual(approved.calls[0].arguments.tools, [upload, invite.arguments.tools[0]]);
});

test("refusals name the actual reason so the engine can correct the call", async (t) => {
  const f = await fixture(t);
  const text = async (params) => (await f.client.callTool(params)).content[0].text;
  const notArray = await text({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: "[{\"tool_slug\": \"GOOGLEDRIVE_UPLOAD_FILE\"" } });
  assert.match(notArray, /nothing was sent to the connector/);
  assert.match(notArray, /JSON array of \{"tool_slug"/);
  assert.match(notArray, /a string that is not a JSON array/);
  assert.doesNotMatch(notArray, /membership/);
  assert.match(await text({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: {} }), /got no tools/);
  assert.match(await text({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ arguments: {} }] } }), /has no tool_slug/);
  const proxy = await text({ name: "COMPOSIO_PROXY_EXECUTE", arguments: { endpoint: "/x" } });
  assert.match(proxy, /COMPOSIO_PROXY_EXECUTE is disabled/);
  assert.match(proxy, /COMPOSIO_REMOTE_WORKBENCH/);
  assert.equal(f.calls.length, 0);
  const denied = await fixture(t, { requestApproval: async () => ({ allow: false }) });
  assert.match((await denied.client.callTool(invite)).content[0].text, /needs a one-use human approval, and that approval was denied/);
  const revoked = await fixture(t, { authorize: () => { throw new Error("capability rejected with detail"); } });
  const revokedText = (await revoked.client.callTool({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [upload] } })).content[0].text;
  assert.match(revokedText, /authority is no longer valid/);
  assert.doesNotMatch(revokedText, /with detail|membership/);
});

test("normalizeComposioCall leaves undecodable or non-executor shapes untouched", () => {
  const odd = { name: "GMAIL_SEND_EMAIL", arguments: { tools: "[1]", body: "{\"a\":1}" } };
  assert.deepEqual(normalizeComposioCall(odd), odd);
  const bad = { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: "{\"tool_slug\":\"X\"}" } };
  assert.deepEqual(normalizeComposioCall(bad), bad);
  const input = { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: JSON.stringify([upload]) } };
  normalizeComposioCall(input);
  assert.equal(typeof input.arguments.tools, "string", "the caller's object is not mutated");
});
