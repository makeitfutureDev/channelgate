// Admin approvals API: see what is waiting on a human, and resolve it without a Slack client.
//
// Until this existed, an approval card could ONLY be answered by clicking it in a real Slack
// client — which blocks every automation and every QA pass that has to get past a permission
// prompt, a control-plane sign-off or a durable background-shell request. These routes resolve the
// SAME request through the SAME code (slack/approvals.applyApprovalDecision, and for busy-thread
// cards slack/busy-thread-choice.applyBusyThreadChoice), so scope semantics (once / thread /
// forever / deny), the durable state machine, the requester binding, the awaiting MCP call, the
// card update and the expiry all behave exactly as a click does. Nothing here re-implements a
// decision, and nothing here fakes a Slack `body`/`ack` payload.
//
//   GET  /api/approvals                     → { approvals, threadChoices, count }
//   POST /api/approvals/:id                 → { decision: "approve"|"deny", scope?: once|thread|forever }
//   POST /api/approvals/thread-choice/:id   → { choice: "steer"|"queue"|"cancel" }
//
// Authority: the admin session cookie IS the principal (see web/auth.js — this path never accepts
// the /api/runs API key), so it satisfies the request's `requiredTier` the way an admin's click
// does, including "approve forever", which changes the channel's posture. Every resolution writes
// an `approval_resolved_by_admin` audit event naming the principal and the decision — never a
// value, a command or a token.
import { Router } from "express";
import { applyApprovalDecision, APPROVAL_SCOPES, listPendingApprovals, lookupApproval } from "../../slack/approvals.js";
import { applyBusyThreadChoice, busyThreadChoices, BUSY_THREAD_CHOICE_KIND, BUSY_THREAD_CHOICES } from "../../slack/busy-thread-choice.js";
import { processMessageEvent } from "../../slack/message-pipeline.js";
import { getChannelsIndex, getUsers } from "../../config/store.js";
import { logEvent } from "../../util/logger.js";

// The principal recorded on the card, in the audit trail, and as the decider handed back to the
// waiting agent. There is no Slack user id behind an admin session, and inventing one would put a
// person's name on a decision they did not make — so the principal is named, not faked. The label
// is the same fact in prose, for the card text.
const ADMIN_PRINCIPAL = "admin UI";
const ADMIN_ACTOR_LABEL = "the admin UI";

// The scope and choice vocabularies come from the modules that implement them — this router
// validates against the real lists, never a second copy that could drift.
const DECISIONS = ["approve", "deny"];
const SCOPES = APPROVAL_SCOPES;
const CHOICES = BUSY_THREAD_CHOICES;

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export function createApprovalsRouter({ slack, processMessage = processMessageEvent } = {}) {
  const router = Router();

  const named = async (rows, map) => {
    const [index, users] = await Promise.all([getChannelsIndex(), getUsers()]);
    return rows.map((row) => map(row, index, users));
  };

  // ── What is waiting on a human right now ─────────────────────────────────────
  // Both kinds in one read: permission / control-plane cards held open by their MCP call, and
  // durable background-shell rows that survive a restart. `threadChoices` carries the busy-thread
  // cards (Steer / Add to Queue / Cancel), which are the same "a message is stuck behind a click"
  // problem stored in `active_runs`.
  router.get("/approvals", async (_req, res, next) => {
    try {
      const approvals = await named(listPendingApprovals(), (a, index, users) => ({
        ...a,
        createdAt: iso(a.createdAt),
        expiresAt: iso(a.expiresAt),
        channelName: index[a.channelId]?.name || a.slug || a.channelId,
        requesterName: users[a.requesterId]?.name || a.requesterId,
        scopes: a.durable ? ["once"] : SCOPES,
      }));
      const threadChoices = await named(
        busyThreadChoices.list().map((record) => ({
          id: record.id,
          channelId: record.channelId || record.event?.channel || "",
          slug: record.slug || "",
          threadKey: record.threadKey || "",
          requesterId: record.authorId || record.event?.user || "",
          createdAt: record.choiceCreatedAt || 0,
        })),
        (c, index, users) => ({
          ...c,
          createdAt: iso(c.createdAt),
          channelName: index[c.channelId]?.name || c.slug || c.channelId,
          requesterName: users[c.requesterId]?.name || c.requesterId,
          choices: CHOICES,
        }),
      );
      res.json({ approvals, threadChoices, count: approvals.length + threadChoices.length });
    } catch (e) {
      next(e);
    }
  });

  // ── Resolve one approval, exactly as the Slack button would ──────────────────
  // 400 = malformed decision/scope · 404 = never existed or already expired · 409 = already
  // decided (by a click, by an earlier call, or by the durable state machine's compare-and-swap).
  router.post("/approvals/:id", async (req, res, next) => {
    try {
      const id = String(req.params.id || "");
      const decision = String(req.body?.decision || "").toLowerCase();
      const scope = String(req.body?.scope || "once").toLowerCase();
      if (!DECISIONS.includes(decision)) return res.status(400).json({ error: `decision must be one of: ${DECISIONS.join(", ")}` });
      if (decision === "approve" && !SCOPES.includes(scope)) return res.status(400).json({ error: `scope must be one of: ${SCOPES.join(", ")}` });

      const { entry, durable, resolved } = lookupApproval(id);
      if (!entry) return res.status(resolved ? 409 : 404).json({ error: resolved ? "this approval was already resolved" : "no such approval" });

      const result = await applyApprovalDecision({
        id,
        entry,
        durable,
        decision,
        scope,
        actorId: ADMIN_PRINCIPAL,
        actorLabel: ADMIN_ACTOR_LABEL,
        // The live Slack client so the card in the thread is retired the same way a click retires
        // it. A disconnected Slack is not a reason to refuse: the decision itself is daemon-side,
        // and leaving the request pending because a card cannot be edited is the worse failure.
        client: slack?.getClient?.() || null,
      });
      if (!result.ok && result.code !== 502) return res.status(result.code || 400).json({ ok: false, error: result.error });

      // Audit AFTER the decision so a failed one is not recorded as a resolution. Ids and the
      // decision only — never the command, the plan text, or any value the request carried.
      await logEvent("approval_resolved_by_admin", {
        channel: entry.channelId || "",
        author: entry.authorId || "",
        slug: entry.slug || "",
        approvalId: id,
        principal: ADMIN_PRINCIPAL,
        decision: result.decision || decision,
        scope: result.scope || "",
        tool: entry.toolName || "",
        durable: Boolean(durable),
        ...(result.ok ? {} : { started: false, error: String(result.error || "").slice(0, 240) }),
      });

      // 502: the decision stuck (the request is consumed and can never be replayed) but the
      // approved job could not start. Reporting 200 would claim work that is not running.
      if (!result.ok) return res.status(502).json({ ok: false, id, decision: "approve", started: false, error: result.error });
      res.json({
        ok: true,
        id,
        decision: result.decision,
        scope: result.scope,
        outcome: result.outcome,
        resolvedBy: ADMIN_PRINCIPAL,
        ...(result.jobId ? { jobId: result.jobId, jobLabel: result.jobLabel || "" } : {}),
      });
    } catch (e) {
      next(e);
    }
  });

  // ── Resolve one busy-thread card (Steer / Add to Queue / Cancel) ─────────────
  // Durable state (`active_runs` rows flagged awaitingChoice), so it is resolvable from here;
  // steer/queue re-enter the ordinary message pipeline with the exact stored event, which needs a
  // live Slack client. Cancel is daemon-side and works even while Slack is down.
  router.post("/approvals/thread-choice/:id", async (req, res, next) => {
    try {
      const id = String(req.params.id || "");
      const choice = String(req.body?.choice || "").toLowerCase();
      if (!CHOICES.includes(choice)) return res.status(400).json({ error: `choice must be one of: ${CHOICES.join(", ")}` });

      const client = slack?.getClient?.() || null;
      if (choice !== "cancel" && !client) {
        return res.status(503).json({ error: "Slack is disconnected — steer and queue re-enter the message pipeline, so only cancel works right now." });
      }
      const outcome = busyThreadChoices.takeAsAdmin(id);
      if (!outcome.ok) {
        const code = outcome.reason === "claimed" ? 409 : 404;
        return res.status(code).json({
          ok: false,
          error: outcome.reason === "claimed" ? "this choice is already being handled" : "this choice has already been used, stopped, or expired",
        });
      }
      const record = outcome.record;
      const channel = record.channelId || record.event?.channel || "";
      const result = await applyBusyThreadChoice({
        choiceId: id,
        record,
        choice,
        client,
        channel,
        messageTs: record.choiceMessageTs || "",
        processMessage,
      });
      await logEvent("approval_resolved_by_admin", {
        channel,
        author: record.authorId || record.event?.user || "",
        slug: record.slug || "",
        approvalId: id,
        principal: ADMIN_PRINCIPAL,
        decision: choice,
        kind: BUSY_THREAD_CHOICE_KIND,
      });
      res.json({ ok: true, id, choice, resolvedBy: ADMIN_PRINCIPAL, accepted: Boolean(result?.accepted), cancelled: Boolean(result?.cancelled) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
