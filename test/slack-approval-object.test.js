import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { requestApproval } = await import("../src/slack/app.js");

// A fake Slack client that records the approval message it posts. requestApproval() returns a
// promise that only resolves on a button click / timeout, so we never await it — we inspect the
// synchronously-posted card instead (postMessage runs before the pending promise is returned).
function capture() {
  let posted = null;
  const client = {
    chat: {
      postMessage: async (payload) => {
        posted = payload;
        return { ts: "1720000000.000100" };
      },
    },
  };
  return { slack: { getClient: () => client }, get: () => posted };
}

function allBlockText(blocks) {
  return JSON.stringify(blocks);
}
function actionIds(blocks) {
  const actions = blocks.find((b) => b.type === "actions");
  return (actions?.elements || []).map((e) => e.action_id);
}

test("agent approval card shows the FULL details, not a 60-char preview", async () => {
  const { slack, get } = capture();
  // Longer than firstStringArg()'s 60-char clip — the old toolTarget() path would have truncated it.
  const details = "Deploy the gateway to production and restart the daemon. " + "x".repeat(300);
  const p = requestApproval(slack, {
    channelId: "C1",
    slug: "chan",
    authorId: "U1",
    threadKey: "T1",
    toolName: "Deploy to production?",
    toolInput: { details },
    approvalType: "agent",
  });
  p.catch(() => {}); // never resolves in-test; swallow to avoid unhandled-rejection noise
  await new Promise((r) => setTimeout(r, 10));

  const posted = get();
  assert.ok(posted, "an approval message was posted");
  const text = allBlockText(posted.blocks);
  assert.ok(text.includes(details), "the full details string is rendered in the card");
  assert.ok(!text.includes("…"), "the details are not ellipsis-truncated");
});

test("agent approval card wires Approve / Deny / Comment buttons", async () => {
  const { slack, get } = capture();
  const p = requestApproval(slack, {
    channelId: "C1",
    slug: "chan",
    authorId: "U1",
    threadKey: "T1",
    toolName: "Ship it?",
    toolInput: { details: "short plan" },
    approvalType: "agent",
    approveText: "Ship it",
    denyText: "Hold",
  });
  p.catch(() => {});
  await new Promise((r) => setTimeout(r, 10));

  const posted = get();
  const ids = actionIds(posted.blocks);
  assert.deepEqual(ids, ["cg_approve", "cg_deny", "cg_approval_comment"]);
  const text = allBlockText(posted.blocks);
  assert.ok(text.includes("Ship it"), "custom approve label is used");
  assert.ok(text.includes("Hold"), "custom deny label is used");
});

test("requestApproval refuses cleanly when Slack is unreachable", async () => {
  const res = await requestApproval({ getClient: () => null }, {
    channelId: "C1",
    slug: "chan",
    authorId: "U1",
    threadKey: "T1",
    toolName: "x",
    toolInput: { details: "y" },
    approvalType: "agent",
  });
  assert.equal(res.allow, false);
  assert.match(res.reason, /can't reach Slack/i);
});

test("permission approvals auto-allow for an admin author in an adminMode channel (admin outranks auto)", async () => {
  const { upsertChannelEntry, saveChannelMeta, setUser } = await import("../src/config/store.js");
  const entry = await upsertChannelEntry("C-adminauto", { name: "adminauto", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { channelId: "C-adminauto", adminMode: true, autoMode: false });
  await setUser("U-boss", { isAdmin: true });
  await setUser("U-guest", { approved: true });

  const { slack, get } = capture();
  const base = { channelId: "C-adminauto", slug: entry.slug, threadKey: "T1", toolName: "Bash", toolInput: { command: "make build" } };

  // The admin's own run: no card, immediate allow — this is what keeps their unattended
  // (daemon-origin) turns from stalling on a click nobody sees.
  const admin = await requestApproval(slack, { ...base, authorId: "U-boss" });
  assert.equal(admin.allow, true);
  assert.match(admin.reason, /admin mode/);
  assert.equal(get(), null, "no approval card was posted for the admin author");

  // A non-admin author in the same channel still gets buttons (the pending promise never
  // resolves in-test; the posted card is the observable).
  const p = requestApproval(slack, { ...base, authorId: "U-guest" });
  p.catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(get(), "non-admin author still posts an approval card");

  // Never for the "agent" type: control-plane sign-offs stay human-clicked even for admins.
  const { slack: slack2, get: get2 } = capture();
  const p2 = requestApproval(slack2, { ...base, authorId: "U-boss", approvalType: "agent", toolInput: { details: "Turn AUTO MODE ON" } });
  p2.catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(get2(), "agent-type approvals still post a card for admins");
});
