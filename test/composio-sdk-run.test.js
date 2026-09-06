import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, clearTestLicense, testLicenseEnv } from "./helpers.js";

ensureTestEnv();

const { resolveComposioRuntime } = await import("../src/gateway/run.js");

test("personal mode keeps legacy token resolution and never creates SDK sessions", async () => {
  let sdkCalls = 0;
  const result = await resolveComposioRuntime({
    mode: "personal",
    userToken: "user-token",
    channelToken: "channel-token",
    defaultToken: "org-token",
    resolveSdk: async () => {
      sdkCalls += 1;
    },
  });

  assert.equal(sdkCalls, 0);
  assert.equal(result.mode, "personal");
  assert.equal(result.user.token, "user-token");
  assert.equal(result.shared.token, "channel-token");
  assert.equal(result.user.endpoint, null);
  assert.equal(result.shared.endpoint, null);
});

test("SDK mode creates personal and manager-authorized shared thread sessions", async () => {
  const calls = [];
  const result = await resolveComposioRuntime({
    mode: "sdk",
    workspaceId: "T1",
    channelId: "C1",
    authorId: "U1",
    threadKey: "171.001",
    meta: { manageAccess: "custom", managers: ["U1"] },
    authorIsAdmin: false,
    authorIsApproved: true,
    resolveSdk: async (input) => {
      calls.push(input);
      return { mode: "sdk", url: `https://app.composio.dev/${input.kind}`, source: `sdk-${input.kind}` };
    },
  });

  assert.deepEqual(calls.map(({ kind, id, accessKind, manageConnections }) => ({
    kind,
    id,
    accessKind,
    manageConnections,
  })), [
    { kind: "user", id: "U1", accessKind: "owner", manageConnections: true },
    { kind: "channel", id: "C1", accessKind: "manager", manageConnections: true },
  ]);
  assert.equal(result.user.source, "sdk-user");
  assert.equal(result.shared.source, "sdk-channel");
  assert.equal(result.shared.endpoint.url, "https://app.composio.dev/channel");
});

test("SDK shared member sessions cannot manage connections", async () => {
  const calls = [];
  await resolveComposioRuntime({
    mode: "sdk",
    workspaceId: "T1",
    channelId: "C1",
    authorId: "U2",
    threadKey: "171.001",
    meta: { manageAccess: "custom", managers: ["U1"] },
    authorIsAdmin: false,
    authorIsApproved: true,
    resolveSdk: async (input) => {
      calls.push(input);
      return { mode: "sdk", url: `https://app.composio.dev/${input.kind}` };
    },
  });

  assert.equal(calls[1].accessKind, "member");
  assert.equal(calls[1].manageConnections, false);
});

test("one failed SDK identity does not substitute or remove the other", async () => {
  const result = await resolveComposioRuntime({
    mode: "sdk",
    workspaceId: "T1",
    channelId: "C1",
    authorId: "U1",
    threadKey: "171.001",
    meta: { manageAccess: "admins" },
    authorIsAdmin: false,
    authorIsApproved: true,
    resolveSdk: async (input) => {
      if (input.kind === "user") throw new Error("personal failed");
      return { mode: "sdk", url: "https://app.composio.dev/channel" };
    },
  });

  assert.equal(result.user.endpoint, null);
  assert.equal(result.user.source, "sdk-unavailable");
  assert.equal(result.shared.endpoint.url, "https://app.composio.dev/channel");
  assert.equal(result.shared.source, "sdk-channel");
});

test("clean mode suppresses SDK session creation", async () => {
  let sdkCalls = 0;
  const result = await resolveComposioRuntime({
    clean: true,
    mode: "sdk",
    resolveSdk: async () => {
      sdkCalls += 1;
    },
  });

  assert.equal(sdkCalls, 0);
  assert.equal(result.user.source, "clean");
  assert.equal(result.shared.source, "clean");
});

test("SDK mode mints no shared channel session in a DM", async () => {
  const calls = [];
  const result = await resolveComposioRuntime({
    mode: "sdk",
    workspaceId: "T1",
    channelId: "D1",
    authorId: "U1",
    threadKey: "171.001",
    meta: { isDM: true },
    isDM: true,
    authorIsAdmin: true,
    authorIsApproved: true,
    resolveSdk: async (input) => {
      calls.push(input);
      return { mode: "sdk", url: `https://app.composio.dev/${input.kind}` };
    },
  });

  assert.deepEqual(calls.map((c) => c.kind), ["user"]);
  assert.equal(result.user.source, "sdk-user");
  assert.equal(result.shared.endpoint, null);
  assert.equal(result.shared.source, "none-dm");
});

test("personal mode in a DM drops the channel and organization tokens", async () => {
  const result = await resolveComposioRuntime({
    mode: "personal",
    userToken: "user-token",
    channelToken: "channel-token",
    defaultToken: "org-token",
    isDM: true,
  });

  assert.equal(result.user.token, "user-token");
  assert.equal(result.shared.token, "");
  assert.equal(result.shared.source, "none-dm");
  assert.equal(result.shared.endpoint, null);
});


test("untrusted API author cannot mint a personal session or manage shared connections", async () => {
  const calls = [];
  const result = await resolveComposioRuntime({
    mode: "sdk", workspaceId: "T1", channelId: "C1", authorId: "U1", threadKey: "1.001",
    principalTrusted: false, authorIsAdmin: true, authorIsApproved: true,
    meta: { manageAccess: "admins", managers: ["U1"] },
    resolveSdk: async (input) => { calls.push(input); return { mode: "sdk", url: "https://app.composio.dev/tool_router/v3/trs_channel/mcp" }; },
  });
  assert.equal(result.user.endpoint, null);
  assert.equal(result.user.source, "none-untrusted-principal");
  assert.deepEqual(calls.map(({ kind, accessKind, manageConnections }) => ({ kind, accessKind, manageConnections })), [
    { kind: "channel", accessKind: "member", manageConnections: false },
  ]);
  calls.length = 0;
  await resolveComposioRuntime({ mode: "sdk", principalTrusted: false, isDM: true, resolveSdk: async (input) => calls.push(input) });
  assert.equal(calls.length, 0);
});

test("SDK runtime requires Enterprise even when SDK resolver is injected", async () => {
  let calls = 0;
  try {
    for (const tier of ["none", "free"]) {
      if (tier === "none") clearTestLicense(); else testLicenseEnv({ tier: "free" });
      await assert.rejects(resolveComposioRuntime({ mode: "sdk", resolveSdk: async () => { calls++; } }), /Enterprise/);
    }
    assert.equal(calls, 0);
  } finally { testLicenseEnv(); }
});
