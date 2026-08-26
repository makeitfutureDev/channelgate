// Permission approvals (extracted from slack/app.js — the 2026-08 restructure notes (internal repo) Phase 2.2).
// A non-admin run can hit a tool that needs permission. Claude's --permission-prompt-tool then
// calls our MCP `permission_prompt` tool, which POSTs to /internal/approval → requestApproval()
// here: we post Approve/Deny buttons in the thread and resolve the awaiting MCP call (→ Claude)
// when an authorized person clicks. "Approve for this thread" remembers the tool so a multi-step
// task isn't re-prompted for the same kind of action.
import { randomUUID } from "node:crypto";

import { logEvent } from "../util/logger.js";
import { getChannelMeta, patchChannelMeta, isAdmin, isApproved } from "../config/store.js";
import { effectiveMeta } from "../gateway/run.js";
import { canManage, isAuthorized } from "../gateway/modes.js";
import { toolTarget } from "../engines/stream.js";
import {
  approvalActionKey,
  createApprovalRequest,
  deleteApprovalRequest,
  findPendingApproval,
  getApprovalRequest,
  patchPendingApproval,
  transitionApprovalRequest,
} from "../gateway/approval-requests.js";

// The live Slack client of the currently-connected app (set from connectAndWire); the approval
// flow is driven by the daemon's /internal/approval route rather than an event, so it can't take
// the client from a Bolt handler argument.
let currentClient = null;
export function setApprovalClient(client) {
  currentClient = client;
}

// Registered by server.js after BackgroundJobs is constructed. Durable approval rows contain
// only the exact narrow action; the executor re-validates live channel mode/identity before spawn.
let durableApprovalExecutor = null;
export function setDurableApprovalExecutor(executor) {
  durableApprovalExecutor = typeof executor === "function" ? executor : null;
}

// ── Permission approvals (interactive buttons) ──────────────────────────────────
// A non-admin run can hit a tool that needs permission. Claude's --permission-prompt-tool then
// calls our MCP `permission_prompt` tool, which POSTs to /internal/approval → requestApproval()
// here: we post Approve/Deny buttons in the thread and resolve the awaiting MCP call (→ Claude)
// when an authorized person clicks. "Approve for this thread" remembers the tool so a multi-step
// task isn't re-prompted for the same kind of action.
const pendingApprovals = new Map(); // id -> { finish, channelId, msgTs, runKey, toolName, authorId, approvalType }
const threadAllow = new Map(); // runKey -> Set(toolName) pre-approved for the rest of the thread
export const APPROVAL_ACTIONS = ["cg_approve_once", "cg_approve_thread", "cg_approve_always", "cg_approve", "cg_deny", "cg_approval_comment"];
const APPROVAL_TIMEOUT_MS = 4 * 60 * 1000;

// The preview is model-controlled text inside a mrkdwn fence: a ``` in the content would close
// the fence early and let the remainder render as styled prose (disguising what's approved), and
// silent clipping would let a long command's tail execute unseen. Break embedded fences with a
// zero-width space and always SAY when content was cut.
const PREVIEW_MAX = 2800;
function fencedPreview(raw) {
  if (!raw) return "";
  const text = String(raw);
  const safe = text.slice(0, PREVIEW_MAX).replaceAll("```", "`​`​`");
  const hidden = text.length - PREVIEW_MAX;
  return `\n\`\`\`${safe}\`\`\`${hidden > 0 ? `\n⚠️ _+${hidden} more characters NOT shown above._` : ""}`;
}

// Session-key → real Slack thread resolution now lives in slack/thread-keys.js so the MCP tool
// servers (separate processes, which must not import this module's run/engine graph) apply the
// identical rule. Re-exported here because this is where callers and tests already look for it:
// posting an unresolved key as thread_ts is what made every scheduled/background-agent approval
// card fail to appear.
export { isSlackTs, slackThreadFor } from "./thread-keys.js";
import { isSlackTs, slackThreadFor } from "./thread-keys.js";

function approvalBlocks(id, toolName, target, authorId, { approvalType = "permission", approveText = "Approve", denyText = "Deny", durable = false } = {}) {
  const preview = fencedPreview(target);
  if (approvalType === "agent") {
    return [
      { type: "section", text: { type: "mrkdwn", text: `*${toolName}*${preview}\n<@${authorId}> asked for approval${durable ? ". This exact request remains actionable across gateway restarts until handled." : " before continuing."}` } },
      {
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: approveText.slice(0, 75) || "Approve" }, action_id: "cg_approve", value: id },
          { type: "button", style: "danger", text: { type: "plain_text", text: denyText.slice(0, 75) || "Deny" }, action_id: "cg_deny", value: id },
          { type: "button", text: { type: "plain_text", text: "Comment" }, action_id: "cg_approval_comment", value: id },
        ],
      },
    ];
  }
  return [
    { type: "section", text: { type: "mrkdwn", text: `🔒 *Permission needed* — \`${toolName}\`${preview}\n<@${authorId}>'s request wants to do this. Approve?` } },
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve once" }, action_id: "cg_approve_once", value: id },
        { type: "button", text: { type: "plain_text", text: "Approve for this thread" }, action_id: "cg_approve_thread", value: id },
        { type: "button", text: { type: "plain_text", text: "Approve forever" }, action_id: "cg_approve_always", value: id },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Deny" }, action_id: "cg_deny", value: id },
      ],
    },
  ];
}

// Post one approval card and return the message ts the decision is anchored to. `threadTs` null
// posts TOP-LEVEL, which is what turns a synthetic session key into a real, replyable thread.
// Fails loudly when Slack answers without a usable ts: an un-updatable card is a request nobody
// can ever resolve or expire, and swallowing that is how scheduled approvals went missing.
async function postApprovalCard(client, { channelId, threadTs, text, blocks, context = {} }) {
  const posted = await client.chat.postMessage({ channel: channelId, thread_ts: threadTs || undefined, text, blocks });
  const ts = posted?.ts;
  if (!isSlackTs(ts)) {
    await logEvent("approval_post_bad_ts", { channel: channelId, ts: String(ts ?? ""), ...context }).catch(() => {});
    throw new Error(`Slack returned no usable message ts for the approval card (got ${JSON.stringify(ts ?? null)})`);
  }
  return ts;
}

// Called by the daemon's /internal/approval route. Posts buttons, returns { allow, reason } once
// resolved (click or timeout). Pre-approves via the per-thread cache without re-asking.
export async function requestApproval(slack, { channelId, slug, authorId, threadKey, toolName, toolInput, approvalType = "permission", approveText = "Approve", denyText = "Deny", requiredTier = "", durableAction = null } = {}) {
  const client = slack?.getClient?.() || currentClient;
  const durable = durableAction?.kind === "background_shell";
  if (!channelId || !threadKey) return { allow: false, reason: "gateway can't reach Slack to ask for approval" };
  const runKey = `${slug}::${threadKey}`;
  // Auto mode → approve without asking; tools "approved forever" here → likewise. Still sandboxed.
  if (approvalType === "permission") {
    try {
      const meta = effectiveMeta((await getChannelMeta(slug)) || {});
      if (meta.autoMode) return { allow: true, reason: "auto mode (auto-approved)" };
      // Admin outranks auto (run.js adminUnattendedTier): the admin's own runs in an adminMode
      // channel behave at least like auto mode, so their unattended turns don't stall on a click
      // nobody sees. Non-admin authors in the same channel still get buttons.
      if (meta.adminMode && authorId && (await isAdmin(authorId))) {
        return { allow: true, reason: "admin mode (auto-approved for the admin author)" };
      }
      if ((meta.approvedTools || []).includes(toolName)) return { allow: true, reason: "approved forever for this channel" };
    } catch {
      /* fall through to buttons */
    }
    if (threadAllow.get(runKey)?.has(toolName)) return { allow: true, reason: "pre-approved for this thread" };
  }

  let target = "";
  try {
    // Agent approvals carry the full plan/action text in `details` — show it (the card slices to
    // 2800). toolTarget()'s 60-char preview is for short tool-call previews, not sign-off context.
    target = approvalType === "agent" ? String(toolInput?.details || "") : toolTarget(toolName, toolInput) || "";
  } catch {
    /* best-effort preview */
  }
  // Durable shell approvals do not hold the engine/MCP HTTP request open. Persist the exact
  // authority-bearing action, post one reusable card, and return immediately. A click — including
  // after a daemon restart — loads the row and invokes the daemon executor directly.
  if (durable) {
    const actionKey = approvalActionKey(durableAction);
    const existing = findPendingApproval(actionKey);
    if (existing) {
      // A crash between INSERT and postMessage can leave a valid row without a visible card.
      // Re-post the same id on the next identical request. A crash after Slack accepted the post
      // but before msgTs was patched may create two cards; the SQLite CAS still lets only one win.
      if (!existing.msgTs && client) {
        try {
          const ts = await postApprovalCard(client, {
            channelId: existing.channelId,
            threadTs: slackThreadFor(existing.action?.threadKey || threadKey),
            text: `Approval requested: ${existing.toolName}`,
            blocks: approvalBlocks(existing.id, existing.toolName, existing.target, existing.authorId, {
              approvalType: existing.approvalType,
              approveText: existing.approveText,
              denyText: existing.denyText,
              durable: true,
            }),
            context: { approvalId: existing.id, toolName: existing.toolName },
          });
          patchPendingApproval(existing.id, { msgTs: ts });
        } catch {
          return { allow: false, pending: true, approvalId: existing.id, reason: "approval is saved but Slack couldn't restore its card yet" };
        }
      }
      return {
        allow: false,
        pending: true,
        approvalId: existing.id,
        reason: "approval is still pending; the existing Run it button remains active",
      };
    }
    if (!client) return { allow: false, reason: "gateway can't reach Slack to ask for approval" };
    const id = randomUUID();
    try {
      createApprovalRequest({
        id,
        actionKey,
        status: "pending",
        channelId,
        msgTs: "",
        runKey,
        slug,
        toolName,
        authorId,
        approvalType,
        requiredTier,
        target,
        approveText,
        denyText,
        action: durableAction,
      });
    } catch (error) {
      // A concurrent duplicate insert loses the partial-unique-index race; reuse the winner.
      const winner = findPendingApproval(actionKey);
      if (winner) return { allow: false, pending: true, approvalId: winner.id, reason: "approval is already pending" };
      return { allow: false, reason: `couldn't persist the approval request: ${error.message}` };
    }
    try {
      const ts = await postApprovalCard(client, {
        channelId,
        threadTs: slackThreadFor(threadKey),
        text: `Approval requested: ${toolName}`,
        blocks: approvalBlocks(id, toolName, target, authorId, { approvalType, approveText, denyText, durable: true }),
        context: { approvalId: id, toolName, slug },
      });
      patchPendingApproval(id, { msgTs: ts });
    } catch (error) {
      deleteApprovalRequest(id);
      return { allow: false, reason: `couldn't post the approval prompt: ${error.message}` };
    }
    return {
      allow: false,
      pending: true,
      approvalId: id,
      reason: "approval saved; click Run it now or after a gateway restart",
    };
  }

  if (!client) return { allow: false, reason: "gateway can't reach Slack to ask for approval" };
  const id = randomUUID();
  let msgTs = null;
  try {
    msgTs = await postApprovalCard(client, {
      channelId,
      threadTs: slackThreadFor(threadKey),
      text: approvalType === "agent" ? `Approval requested: ${toolName}` : `🔒 Permission needed: ${toolName}`,
      blocks: approvalBlocks(id, toolName, target, authorId, { approvalType, approveText, denyText }),
      context: { approvalId: id, toolName, slug },
    });
  } catch (error) {
    return { allow: false, reason: `couldn't post the approval prompt: ${error.message}` };
  }
  return new Promise((resolve) => {
    const finish = (decision) => {
      if (!pendingApprovals.has(id)) return;
      clearTimeout(timer);
      pendingApprovals.delete(id);
      resolve(decision);
    };
    const timer = setTimeout(() => {
      finish({ allow: false, reason: "approval timed out (no one clicked)" });
      // Best-effort: flip the card so dead buttons can't be mistaken for a live request. The
      // deny itself already surfaced in-thread via the tool's refusal reply.
      client.chat
        .update({ channel: channelId, ts: msgTs, text: "Approval expired", blocks: [{ type: "section", text: { type: "mrkdwn", text: `⏱ *${toolName}* — nobody clicked within ${Math.round(APPROVAL_TIMEOUT_MS / 60000)} minutes; the request was refused.` } }] })
        .catch(() => {});
    }, APPROVAL_TIMEOUT_MS);
    timer.unref?.();
    pendingApprovals.set(id, { finish, channelId, msgTs, runKey, slug, toolName, authorId, approvalType, requiredTier });
  });
}

async function canResolveApproval(entry, clicker) {
  const clickerIsAdmin = await isAdmin(clicker);
  const clickerIsApproved = await isApproved(clicker);
  const m = await getChannelMeta(entry.slug).catch(() => null);
  const allowed =
    clicker === entry.authorId ||
    clickerIsAdmin ||
    (m ? isAuthorized(m, clicker, Boolean(m.isDM), { isAdminUser: clickerIsAdmin, isApprovedUser: clickerIsApproved }) : false);
  // The gated action's authority tier. Being eligible to click is NOT the same as being allowed
  // to APPROVE: an admin-tier control-plane change (or an unsandboxed shell job) must get its
  // human factor from someone who could have authorized the action themselves — never from a
  // bystander member or per-channel guest, and never via the author's own click.
  const tier = entry.requiredTier || "";
  const meetsTier =
    tier === "admin"
      ? clickerIsAdmin
      : tier === "manage"
        ? clickerIsAdmin || canManage(m || {}, { authorId: clicker, isAdminUser: clickerIsAdmin, isApprovedUser: clickerIsApproved })
        : true;
  return { allowed, clickerIsAdmin, meetsTier, tier };
}

export async function handleApprovalClick({ ack, body, action, client }) {
  await ack();
  const id = action?.value;
  const volatileEntry = pendingApprovals.get(id);
  const persistedEntry = volatileEntry ? null : getApprovalRequest(id);
  const durable = Boolean(persistedEntry?.action?.kind === "background_shell");
  const entry = volatileEntry || persistedEntry;
  const clicker = body?.user?.id;
  const channel = body?.channel?.id;
  const ts = body?.message?.ts;
  if (!entry || (durable && entry.status !== "pending")) {
    try {
      await client.chat.update({ channel, ts, text: "Approval handled", blocks: [{ type: "section", text: { type: "mrkdwn", text: durable ? "✅ _This durable approval was already handled and cannot be used twice._" : "⏱ _This approval expired or was already handled._" } }] });
    } catch {
      /* message gone */
    }
    return;
  }
  // Deciding is scoped to who could have STARTED the run: the run's author plus anyone the
  // channel's own access policy authorizes (same isAuthorized check as message gating — approved
  // members in an access:"approved" channel can approve a teammate's prompt, but in an
  // admins-only/"none" channel a non-admin still can't, because they couldn't run the bot there).
  const { allowed, clickerIsAdmin, meetsTier, tier } = await canResolveApproval(entry, clicker);
  if (!allowed) {
    try {
      await client.chat.postEphemeral({ channel, user: clicker, thread_ts: ts, text: "You're not allowed to approve actions for this run." });
    } catch {
      /* no ephemeral scope — ignore */
    }
    return;
  }
  // Tier applies to APPROVING only — anyone eligible may still Deny or Comment (stopping a job
  // or leaving feedback never escalates anything).
  const isApproveAction = action.action_id !== "cg_deny" && action.action_id !== "cg_approval_comment";
  if (isApproveAction && !meetsTier) {
    try {
      await client.chat.postEphemeral({
        channel,
        user: clicker,
        thread_ts: ts,
        text: `This approval needs ${tier === "admin" ? "a gateway *admin*" : "a channel *manager*"} to click Approve — you can still Deny or Comment.`,
      });
    } catch {
      /* no ephemeral scope — ignore */
    }
    return;
  }
  if (action.action_id === "cg_approval_comment") {
    if (!body?.trigger_id) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "cg_approval_comment_modal",
        private_metadata: id,
        title: { type: "plain_text", text: "Approval comment" },
        submit: { type: "plain_text", text: "Send" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `Send feedback for *${entry.toolName}*.` } },
          {
            type: "input",
            block_id: "comment",
            element: { type: "plain_text_input", action_id: "text", multiline: true },
            label: { type: "plain_text", text: "Comment" },
          },
        ],
      },
    });
    return;
  }
  // Persisting a forever-approval changes the channel's security posture — admins only.
  if (action.action_id === "cg_approve_always" && !clickerIsAdmin) {
    try {
      await client.chat.postEphemeral({ channel, user: clicker, thread_ts: ts, text: "Only admins can approve a tool forever — use *Approve once* or *Approve for this thread*." });
    } catch {
      /* no ephemeral scope — ignore */
    }
    return;
  }
  const deny = action.action_id === "cg_deny";
  if (durable) {
    const messageTs = entry.msgTs || ts;
    if (deny) {
      const denied = transitionApprovalRequest(id, "pending", "denied", { decidedBy: clicker, reason: `Denied by <@${clicker}>` });
      if (!denied) return;
      try {
        await client.chat.update({ channel: entry.channelId, ts: messageTs, text: "Denied", blocks: [{ type: "section", text: { type: "mrkdwn", text: `🔒 *${entry.toolName}* — 🚫 Denied by <@${clicker}>.` } }] });
      } catch { /* message gone */ }
      return;
    }
    if (typeof durableApprovalExecutor !== "function") {
      try {
        await client.chat.postEphemeral({ channel, user: clicker, thread_ts: ts, text: "The gateway cannot start durable approvals right now. This request remains pending; try the button again after restart." });
      } catch { /* no ephemeral scope */ }
      return;
    }
    const claimed = transitionApprovalRequest(id, "pending", "executing", {
      decidedBy: clicker,
      reason: `Approved by <@${clicker}>`,
    });
    if (!claimed) return;
    let result;
    try {
      result = await durableApprovalExecutor(claimed);
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    if (result?.ok) {
      transitionApprovalRequest(id, "executing", "consumed", {
        jobId: result.id || "",
        jobLabel: result.label || claimed.action?.label || "background job",
      });
      const blocks = [
        { type: "section", text: { type: "mrkdwn", text: `🔒 *${entry.toolName}* — ✅ Approved by <@${clicker}> and started *${result.label || "background job"}*. This exact approval is now consumed.` } },
      ];
      if (result.id) {
        blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Check status" }, action_id: "cg_bgjob_status", value: result.id }] });
      }
      try {
        await client.chat.update({ channel: entry.channelId, ts: messageTs, text: "Approved and started", blocks });
      } catch { /* message gone; the job's own started note still posts */ }
    } else {
      transitionApprovalRequest(id, "executing", "failed", { error: String(result?.error || "the job could not be started").slice(0, 500) });
      try {
        await client.chat.update({
          channel: entry.channelId,
          ts: messageTs,
          text: "Approved action could not start",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: `⚠️ *${entry.toolName}* was approved by <@${clicker}>, but the exact job could not start: ${String(result?.error || "unknown error").slice(0, 500)}` } }],
        });
      } catch { /* message gone */ }
    }
    return;
  }
  if (action.action_id === "cg_approve_thread") {
    if (!threadAllow.has(entry.runKey)) threadAllow.set(entry.runKey, new Set());
    threadAllow.get(entry.runKey).add(entry.toolName);
  } else if (action.action_id === "cg_approve_always") {
    // Persist: this tool is approved forever in this channel (auto-approved on future prompts).
    try {
      await patchChannelMeta(entry.slug, (meta) => ({
        approvedTools: [...new Set([...(meta?.approvedTools || []), entry.toolName])],
      }));
    } catch {
      /* persist failed — still approve this one */
    }
  }
  entry.finish(deny ? { allow: false, reason: `Denied by <@${clicker}>`, decidedBy: clicker } : { allow: true, reason: `Approved by <@${clicker}>`, decidedBy: clicker });
  const outcome = deny
    ? `🚫 Denied by <@${clicker}>.`
    : action.action_id === "cg_approve_thread"
      ? `✅ Approved by <@${clicker}> — won't ask again for \`${entry.toolName}\` in this thread.`
      : action.action_id === "cg_approve_always"
        ? `✅ Approved by <@${clicker}> — \`${entry.toolName}\` is now approved forever in this channel.`
        : `✅ Approved by <@${clicker}>.`;
  try {
    await client.chat.update({ channel: entry.channelId, ts: entry.msgTs, text: "Resolved", blocks: [{ type: "section", text: { type: "mrkdwn", text: `🔒 *${entry.toolName}* — ${outcome}` } }] });
  } catch {
    /* message gone */
  }
}

export async function handleApprovalCommentSubmit({ ack, body, view, client }) {
  const id = view?.private_metadata;
  const volatileEntry = pendingApprovals.get(id);
  const persistedEntry = volatileEntry ? null : getApprovalRequest(id);
  const durable = Boolean(persistedEntry?.action?.kind === "background_shell");
  const entry = volatileEntry || (persistedEntry?.status === "pending" ? persistedEntry : null);
  const clicker = body?.user?.id;
  const comment = view?.state?.values?.comment?.text?.value?.trim() || "";
  if (!entry) {
    await ack();
    return;
  }
  if (!comment) {
    await ack({ response_action: "errors", errors: { comment: "Add a comment first." } });
    return;
  }
  const { allowed } = await canResolveApproval(entry, clicker);
  if (!allowed) {
    await ack({ response_action: "errors", errors: { comment: "You're not allowed to decide this approval." } });
    return;
  }
  await ack();
  if (durable) {
    transitionApprovalRequest(id, "pending", "denied", {
      reason: `Changes requested by <@${clicker}>`,
      comment,
      decidedBy: clicker,
    });
  } else {
    entry.finish({ allow: false, reason: `Changes requested by <@${clicker}>`, comment, decidedBy: clicker });
  }
  try {
    await client.chat.update({
      channel: entry.channelId,
      ts: entry.msgTs,
      text: "Resolved",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `💬 *${entry.toolName}* — changes requested by <@${clicker}>:\n>${comment.replace(/\n/g, "\n>")}` } }],
    });
  } catch {
    /* message gone */
  }
}
