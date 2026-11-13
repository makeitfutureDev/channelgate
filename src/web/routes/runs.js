// HTTP run API routes. Mounted at /api/runs (auth: an admin session cookie OR a matching
// X-API-Key / Bearer key — see ../auth.js). This router carries its own JSON body parser with a
// higher limit than the app default so a small inline base64 file fits.
//
//   POST /api/runs        → start a run. Body: { message, channel?, author?, file?, fileUrl?,
//                           fileName?, webhook? }. Returns { jobId, sessionId, resumeCommand,
//                           statusUrl, harness, engine, slackThread }.
//   GET  /api/runs/:id    → the job's status + result.
import express from "express";
import { costHistoryStart, costVisibleAt } from "../../ee/cost-history.js";
import { startApiRun, getApiJob, listApiJobs, stopApiRun } from "../../gateway/api-runs.js";

// A public (caller-facing) view of a job record — the internal webhook secret is never echoed.
function publicJob(job, now = new Date(), historyStart = costHistoryStart(now)) {
  const costVisible = costVisibleAt(job.completedMs ?? job.createdMs, now, historyStart);
  return {
    jobId: job.id,
    status: job.status,
    engine: job.engine,
    harness: job.engine,
    slug: job.slug,
    channelId: job.slackThread ? job.channelId : null,
    slackThread: Boolean(job.slackThread),
    conversationKey: job.conversationKey || null,
    threadTs: job.slackThread ? job.threadKey : null,
    threadReused: Boolean(job.threadReused),
    threadPermalink: job.threadPermalink || null,
    sessionId: job.sessionId,
    resumeCommand: job.resumeCommand,
    createdAt: job.createdMs ? new Date(job.createdMs).toISOString() : null,
    completedAt: job.completedMs ? new Date(job.completedMs).toISOString() : null,
    costUSD: costVisible ? job.costUSD ?? null : null,
    // True when the figure is the usage ledger's priced estimate rather than an engine-reported
    // amount (Codex reports no cost of its own) — the same distinction the Audit view draws.
    costEstimated: costVisible && Boolean(job.costEstimated),
    durationMs: job.durationMs ?? null,
    result: job.result ? job.result.content : null,
    error: job.error || null,
  };
}

export function createRunsRouter({ slack } = {}) {
  const router = express.Router();
  // Bigger than the app-wide 1mb so a modest inline base64 file fits; large files should use fileUrl.
  router.use(express.json({ limit: "30mb" }));

  // A channel token (src/gateway/api-tokens.js) resolved by the auth layer: the run acts as its
  // creator in its conversation, and the job routes below answer only for that conversation.
  const tokenPrincipal = (req) => {
    const token = req.cgApiCredential?.kind === "channel" ? req.cgApiCredential.token : null;
    return token ? { channelId: token.channelId, slug: token.slug, createdBy: token.createdBy, tokenId: token.id } : null;
  };
  const visible = (req, job) => {
    const principal = tokenPrincipal(req);
    return !principal || (job && job.channelId === principal.channelId);
  };

  router.post("/", async (req, res, next) => {
    try {
      const { message, channel, author, file, fileUrl, fileName, webhook, harness, engine, model, effort, mode, idempotencyKey, conversationKey } = req.body ?? {};
      const started = await startApiRun({ message, channel, author, file, fileUrl, fileName, webhook, harness, engine, model, effort, mode, idempotencyKey, conversationKey, slack, principal: tokenPrincipal(req) });
      if (!started.ok) return res.status(started.code || 400).json({ ok: false, error: started.error });
      // 200 for an idempotent hit on an existing job (nothing new started), 202 for a fresh run.
      res.status(started.reused ? 200 : 202).json({
        ok: true,
        jobId: started.jobId,
        status: started.status,
        engine: started.engine,
        harness: started.harness,
        slug: started.slug,
        channelId: started.channelId,
        slackThread: started.slackThread,
        conversationKey: started.conversationKey,
        threadTs: started.threadTs,
        threadReused: started.threadReused,
        threadPermalink: started.threadPermalink,
        sessionId: started.sessionId,
        resumeCommand: started.resumeCommand,
        reused: Boolean(started.reused),
        statusUrl: `/api/runs/${started.jobId}`,
      });
    } catch (e) {
      next(e);
    }
  });

  // List recent jobs (newest first). Optional ?status= filter and ?limit= (default 50, max 200).
  router.get("/", (req, res) => {
    const status = String(req.query.status || "").trim();
    const limit = Number(req.query.limit) || 50;
    const now = new Date();
    const historyStart = costHistoryStart(now);
    res.json({ ok: true, jobs: listApiJobs({ status, limit }).filter((job) => visible(req, job)).map((job) => publicJob(job, now, historyStart)) });
  });

  // Stop an in-flight run.
  router.post("/:id/stop", (req, res) => {
    if (!visible(req, getApiJob(String(req.params.id || "")))) return res.status(404).json({ ok: false, error: "No such run." });
    const r = stopApiRun(String(req.params.id || ""));
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
    res.status(202).json({ ok: true, jobId: r.jobId, status: r.status });
  });

  router.get("/:id", (req, res) => {
    const job = getApiJob(String(req.params.id || ""));
    if (!job || !visible(req, job)) return res.status(404).json({ ok: false, error: "No such run." });
    res.json({ ok: true, ...publicJob(job) });
  });

  router.use((error, _req, res, next) => {
    if (error?.code === "license_registration_limit") return res.status(403).json({ error: error.message, code: error.code });
    next(error);
  });
  return router;
}
