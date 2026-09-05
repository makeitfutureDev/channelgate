// HTTP run API routes. Mounted at /api/runs (auth: an admin session cookie OR a matching
// X-API-Key / Bearer key — see ../auth.js). This router carries its own JSON body parser with a
// higher limit than the app default so a small inline base64 file fits.
//
//   POST /api/runs        → start a run. Body: { message, channel?, author?, file?, fileUrl?,
//                           fileName?, webhook? }. Returns { jobId, sessionId, resumeCommand,
//                           statusUrl, engine, slackThread }.
//   GET  /api/runs/:id    → the job's status + result.
import express from "express";
import { startApiRun, getApiJob, listApiJobs, stopApiRun } from "../../gateway/api-runs.js";

// A public (caller-facing) view of a job record — the internal webhook secret is never echoed.
function publicJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    engine: job.engine,
    slug: job.slug,
    channelId: job.slackThread ? job.channelId : null,
    slackThread: Boolean(job.slackThread),
    sessionId: job.sessionId,
    resumeCommand: job.resumeCommand,
    createdAt: job.createdMs ? new Date(job.createdMs).toISOString() : null,
    completedAt: job.completedMs ? new Date(job.completedMs).toISOString() : null,
    costUSD: job.costUSD ?? null,
    // True when the figure is the usage ledger's priced estimate rather than an engine-reported
    // amount (Codex reports no cost of its own) — the same distinction the Audit view draws.
    costEstimated: Boolean(job.costEstimated),
    durationMs: job.durationMs ?? null,
    result: job.result ? job.result.content : null,
    error: job.error || null,
  };
}

export function createRunsRouter({ slack } = {}) {
  const router = express.Router();
  // Bigger than the app-wide 1mb so a modest inline base64 file fits; large files should use fileUrl.
  router.use(express.json({ limit: "30mb" }));

  router.post("/", async (req, res, next) => {
    try {
      const { message, channel, author, file, fileUrl, fileName, webhook, engine, model, effort, mode, idempotencyKey } = req.body ?? {};
      const started = await startApiRun({ message, channel, author, file, fileUrl, fileName, webhook, engine, model, effort, mode, idempotencyKey, slack });
      if (!started.ok) return res.status(started.code || 400).json({ ok: false, error: started.error });
      // 200 for an idempotent hit on an existing job (nothing new started), 202 for a fresh run.
      res.status(started.reused ? 200 : 202).json({
        ok: true,
        jobId: started.jobId,
        status: started.status,
        engine: started.engine,
        slug: started.slug,
        channelId: started.channelId,
        slackThread: started.slackThread,
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
    res.json({ ok: true, jobs: listApiJobs({ status, limit }).map(publicJob) });
  });

  // Stop an in-flight run.
  router.post("/:id/stop", (req, res) => {
    const r = stopApiRun(String(req.params.id || ""));
    if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
    res.status(202).json({ ok: true, jobId: r.jobId, status: r.status });
  });

  router.get("/:id", (req, res) => {
    const job = getApiJob(String(req.params.id || ""));
    if (!job) return res.status(404).json({ ok: false, error: "No such run." });
    res.json({ ok: true, ...publicJob(job) });
  });

  return router;
}
