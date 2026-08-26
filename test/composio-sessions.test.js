import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const sessions = await import("../src/gateway/composio-sessions.js");

test("Composio identities are stable and workspace scoped", () => {
  assert.equal(
    sessions.composioIdentity({ workspaceId: "T1", kind: "user", id: "U1" }),
    "slack:T1:user:U1"
  );
  assert.equal(
    sessions.composioIdentity({ workspaceId: "T1", kind: "channel", id: "C1" }),
    "slack:T1:channel:C1"
  );
  assert.notEqual(
    sessions.composioIdentity({ workspaceId: "T1", kind: "user", id: "U1" }),
    sessions.composioIdentity({ workspaceId: "T2", kind: "user", id: "U1" })
  );
});

test("Composio identity validation rejects unsafe or ambiguous inputs", () => {
  assert.throws(() => sessions.composioIdentity({ workspaceId: "", kind: "user", id: "U1" }), /workspace/i);
  assert.throws(() => sessions.composioIdentity({ workspaceId: "T1", kind: "org", id: "U1" }), /kind/i);
  assert.throws(() => sessions.composioIdentity({ workspaceId: "T1", kind: "user", id: "../U1" }), /identifier/i);
});

test("session keys isolate identity, thread, and access class", () => {
  const identityId = sessions.composioIdentity({ workspaceId: "T1", kind: "channel", id: "C1" });
  const manager = sessions.composioSessionKey({ identityId, threadKey: "171.001", accessKind: "manager" });
  const member = sessions.composioSessionKey({ identityId, threadKey: "171.001", accessKind: "member" });
  const otherThread = sessions.composioSessionKey({ identityId, threadKey: "171.002", accessKind: "manager" });

  assert.match(manager, /^cs_[a-f0-9]{64}$/);
  assert.notEqual(manager, member);
  assert.notEqual(manager, otherThread);
  assert.equal(
    manager,
    sessions.composioSessionKey({ identityId, threadKey: "171.001", accessKind: "manager" })
  );
});

test("session mappings persist, replace, and delete without storing credentials", () => {
  const identityId = sessions.composioIdentity({ workspaceId: "T1", kind: "user", id: "U1" });
  const sessionKey = sessions.composioSessionKey({ identityId, threadKey: "171.001", accessKind: "owner" });

  sessions.saveComposioSession({
    sessionKey,
    identityId,
    scopeKind: "user",
    threadKey: "171.001",
    accessKind: "owner",
    sessionId: "trs_first",
    mcpUrl: "https://app.composio.dev/tool_router/v3/trs_first/mcp",
  });
  assert.deepEqual(sessions.getComposioSession(sessionKey), {
    sessionKey,
    identityId,
    scopeKind: "user",
    threadKey: "171.001",
    accessKind: "owner",
    sessionId: "trs_first",
    mcpUrl: "https://app.composio.dev/tool_router/v3/trs_first/mcp",
    createdMs: sessions.getComposioSession(sessionKey).createdMs,
    updatedMs: sessions.getComposioSession(sessionKey).updatedMs,
  });

  sessions.saveComposioSession({
    sessionKey,
    identityId,
    scopeKind: "user",
    threadKey: "171.001",
    accessKind: "owner",
    sessionId: "trs_second",
    mcpUrl: "https://app.composio.dev/tool_router/v3/trs_second/mcp",
  });
  assert.equal(sessions.getComposioSession(sessionKey).sessionId, "trs_second");
  assert.equal(sessions.deleteComposioSession(sessionKey), true);
  assert.equal(sessions.getComposioSession(sessionKey), null);
  assert.equal(sessions.deleteComposioSession(sessionKey), false);
});
