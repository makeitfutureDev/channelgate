// Audit + dashboards + active runs: the read-only run history, the live active-session feed,
// and the usage dashboard rollups. Split from admin.js; mounted by createAdminRouter so every
// URL is unchanged.
import { Router } from "express";
import { readUsage, usageSummary, usageDashboard } from "../../gateway/usage.js";
import { activeRunForApi, listActiveRuns, onActiveRunsChanged } from "../../gateway/active-runs.js";
import { readEvents } from "../../util/logger.js";
import { getChannelsIndex, getUsers } from "../../config/store.js";
import { usageCountsBySlug } from "../../gateway/skills/catalog.js";

export function createObservabilityRouter() {
  const router = Router();

  const activeRunsSnapshot = async () => {
    const [index, users] = await Promise.all([getChannelsIndex(), getUsers()]);
    const runs = listActiveRuns().map((r) => activeRunForApi(r, { channels: index, users }));
    return { runs, count: runs.length };
  };

  // ── Audit (read-only run history + usage ledger) ─────────────────────────────
  // Reads the usage ledger (the `usage` table) and events (the `events` table) from gateway.db,
  // both already secret-free, filtered by month/channel/author. Read-only, admin-gated.
  router.get("/audit", async (req, res, next) => {
    try {
      const channelId = req.query.channelId ? String(req.query.channelId) : "";
      const authorId = req.query.authorId ? String(req.query.authorId) : "";
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : "";
      const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
      const usage = await readUsage({ month, channelId, authorId, limit });
      const summary = await usageSummary({ month });
      const index = await getChannelsIndex();
      const users = await getUsers();
      const named = usage.map((r) => ({
        ...r,
        channelName: index[r.channelId]?.name || r.slug || r.channelId,
        authorName: users[r.authorId]?.name || r.authorId,
      }));
      res.json({ usage: named, summary });
    } catch (e) {
      next(e);
    }
  });

  // Active sessions — the turns being processed RIGHT NOW (the `active_runs` table, written at turn
  // start and cleared on finish). Powers the Overview "Active sessions" KPI + its modal. Read-only,
  // admin-gated; channel/author ids get display names (as /audit does), and the prompt text is
  // deliberately NOT returned (only who/where/since).
  router.get("/active-runs", async (req, res, next) => {
    try {
      res.json(await activeRunsSnapshot());
    } catch (e) {
      next(e);
    }
  });

  // Event-driven active-session feed. Every mutation is only an invalidation hint: send a complete
  // database snapshot so a reconnect (or any coalesced rapid changes) always reconciles the browser
  // to the source of truth. Serializing/coalescing sends prevents an older async name lookup from
  // arriving after a newer one. EventSource reconnects automatically and receives a fresh initial
  // snapshot each time.
  router.get("/active-runs/stream", (req, res) => {
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("retry: 2000\n\n");

    let closed = false;
    let dirty = false;
    let sending = false;
    const sendSnapshot = async () => {
      dirty = true;
      if (sending || closed) return;
      sending = true;
      try {
        while (dirty && !closed) {
          dirty = false;
          const snapshot = await activeRunsSnapshot();
          if (!closed) res.write(`event: active-runs\ndata: ${JSON.stringify(snapshot)}\n\n`);
        }
      } catch (e) {
        // Keep the connection alive after a transient SQLite/config read error; the next mutation
        // or EventSource reconnect will retry without exposing internal error details to the UI.
        if (!closed) res.write(`event: active-runs-error\ndata: ${JSON.stringify({ error: "snapshot unavailable" })}\n\n`);
      } finally {
        sending = false;
        if (dirty && !closed) void sendSnapshot();
      }
    };

    const unsubscribe = onActiveRunsChanged(() => void sendSnapshot());
    const heartbeat = setInterval(() => {
      if (!closed) res.write(": keepalive\n\n");
    }, 15_000);
    heartbeat.unref?.();
    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
    void sendSnapshot();
  });

  // Dashboard — KPIs + per-bucket/per-user/per-channel rollups for a named `range` (today, last7,
  // last30, month, lastmonth, year, lastyear; default last30), aggregated in SQL. Author/channel
  // ids get their display names attached (as the audit view does) so the UI can render labels
  // without a second lookup. `harness` is all (default), claude or codex and scopes every rollup.
  router.get("/dashboard", async (req, res, next) => {
    try {
      const range = String(req.query.range || "last30");
      const harness = String(req.query.harness || "all");
      const data = usageDashboard({ range, harness });
      const index = await getChannelsIndex();
      const users = await getUsers();
      data.byUser = data.byUser.map((u) => ({ ...u, name: users[u.userId]?.name || u.userId }));
      data.byChannel = data.byChannel.map((c) => ({ ...c, name: index[c.channelId]?.name || c.slug || c.channelId }));
      data.topSkills = [...usageCountsBySlug({ since: data.start, engine: data.harness === "all" ? "" : data.harness }).values()]
        .sort((a, b) => b.total - a.total || a.slug.localeCompare(b.slug))
        .slice(0, 10)
        .map((s) => ({ name: s.name || s.slug, slug: s.slug, uses: s.total }));
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // Recent events (run_start/run_done/run_error/schedule_*/bg_*) for the Audit feed, newest-first,
  // read from the `events` table.
  router.get("/audit/events", async (req, res, next) => {
    try {
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
      res.json({ events: readEvents({ limit }) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
