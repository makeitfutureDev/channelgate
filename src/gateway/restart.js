import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { runtimeActivity } from "./shutdown.js";
import { getActiveBackgroundJobs } from "./background.js";
import { listApiJobs } from "./api-runs.js";
import { isUpdateActive } from "./update-state.js";

const DEFAULT_SETTLE_MS = 2_000;
const DEFAULT_WAIT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 30_000;

function positiveMs(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function gatewayWorkActivity({
  getRuntime = runtimeActivity,
  getBackground = getActiveBackgroundJobs,
  getApiJobs = listApiJobs,
  getUpdate = isUpdateActive,
} = {}) {
  const runtime = getRuntime();
  const background = Number(getBackground?.()?.count?.()) || 0;
  const api = getApiJobs({ limit: 200 }).filter((job) => job?.status === "queued" || job?.status === "running").length;
  const update = getUpdate() ? 1 : 0;
  const engine = Number(runtime?.total) || 0;
  return {
    engine,
    background,
    api,
    update,
    total: engine + background + api + update,
  };
}

export function describeGatewayWork(activity = {}) {
  const parts = [];
  if (activity.engine) parts.push(`${activity.engine} active/queued engine signal${activity.engine === 1 ? "" : "s"}`);
  if (activity.background) parts.push(`${activity.background} background job${activity.background === 1 ? "" : "s"}`);
  if (activity.api) parts.push(`${activity.api} API run${activity.api === 1 ? "" : "s"}`);
  if (activity.update) parts.push("an update transaction");
  return parts.length ? parts.join(", ") : "no ongoing work";
}

export class RestartCoordinator {
  constructor({
    getActivity = gatewayWorkActivity,
    restart,
    notify = async () => {},
    sleep = delay,
    now = Date.now,
    settleMs = positiveMs(process.env.CG_RESTART_SETTLE_MS, DEFAULT_SETTLE_MS),
    waitMs = positiveMs(process.env.CG_RESTART_WAIT_MS, DEFAULT_WAIT_MS),
    pollMs = positiveMs(process.env.CG_RESTART_POLL_MS, DEFAULT_POLL_MS),
  } = {}) {
    if (typeof restart !== "function") throw new Error("RestartCoordinator requires a restart function.");
    this.getActivity = getActivity;
    this.restart = restart;
    this.notify = notify;
    this.sleep = sleep;
    this.now = now;
    this.settleMs = settleMs;
    this.waitMs = waitMs;
    this.pollMs = Math.max(1, pollMs);
    this.current = null;
    this.latest = null;
    this.pending = null;
    this.forceSignal = null;
    this.resolveForce = null;
  }

  request({ channelId = "", threadKey = "", requestedBy = "", reason = "gateway restart", force = false } = {}) {
    if (this.current) {
      if (force === true && !this.current.force && ["settling", "waiting"].includes(this.current.phase)) {
        this.current.force = true;
        this.current.message = "Force restart requested. Ongoing work will be interrupted.";
        this.resolveForce?.();
        return { ok: true, id: this.current.id, force: true, upgraded: true, waitMs: 0, pollMs: this.pollMs, message: this.current.message };
      }
      return {
        ok: false,
        conflict: true,
        id: this.current.id,
        message: this.current.force ? "A force gateway restart is already pending." : "A safe gateway restart is already waiting for ongoing work to finish.",
      };
    }
    const record = {
      id: randomUUID().slice(0, 8),
      channelId: String(channelId || ""),
      threadKey: String(threadKey || ""),
      requestedBy: String(requestedBy || ""),
      reason: String(reason || "gateway restart"),
      requestedAt: this.now(),
      force: force === true,
      phase: "settling",
      activity: null,
      message: force === true ? "Force restart queued. Ongoing work will be interrupted." : "Waiting for the requesting turn to finish before checking gateway activity.",
    };
    this.forceSignal = new Promise((resolve) => { this.resolveForce = resolve; });
    if (record.force) this.resolveForce();
    this.current = record;
    this.latest = record;
    this.pending = Promise.resolve()
      .then(() => this._run(record))
      .finally(() => {
        if (this.current?.id === record.id) this.current = null;
        if (this.pending) this.pending = null;
      });
    return {
      ok: true,
      id: record.id,
      force: record.force,
      waitMs: record.force ? 0 : this.waitMs,
      pollMs: this.pollMs,
      message: record.force ? "Force restart queued. Ongoing work will be interrupted." : "Safe restart queued. The gateway will wait for ongoing work to finish before restarting.",
    };
  }

  status(id = "") {
    const record = this.latest;
    if (!record || (id && record.id !== String(id))) {
      return { ok: false, error: "Safe restart request not found." };
    }
    return {
      ok: true,
      id: record.id,
      phase: record.phase,
      activity: record.activity,
      message: record.message,
      force: record.force,
      waitMs: record.force ? 0 : this.waitMs,
      pollMs: this.pollMs,
    };
  }

  whenSettled() {
    return this.pending || Promise.resolve(null);
  }

  async _notify(record, text) {
    try {
      await Promise.race([this.notify({ ...record, text }), this.forceSignal]);
    } catch {
      // Visibility is best-effort; a Slack outage must not turn the lifecycle guard into a crash.
    }
  }

  async _waitForPoll(ms) {
    const controller = new AbortController();
    try {
      await Promise.race([this.sleep(ms, undefined, { signal: controller.signal }), this.forceSignal]);
    } finally {
      controller.abort(); // retire the losing timer when a force upgrade wakes the poll
    }
  }

  async _run(record) {
    if (this.settleMs > 0) await this.sleep(this.settleMs);
    const startedAt = this.now();
    let wasBusy = false;
    let announcedBusy = false;

    for (;;) {
      let activity = this.getActivity();
      record.activity = activity;
      if (record.force) {
        record.phase = "restarting";
        record.message = "Force restarting the gateway; ongoing work will be interrupted.";
        // Status is already visible to the HTTP caller. A slow chat notification must not hold
        // an explicitly forced restart behind the activity it was requested to interrupt.
        void this._notify(record, "🔄 Force restarting the gateway now. Ongoing work will be interrupted.");
        await this.restart({ reason: record.reason, force: true });
        record.phase = "restarted";
        record.message = "Gateway force restart started.";
        return { restarted: true, force: true, activity };
      }
      if (activity.total === 0) {
        record.phase = "restarting";
        record.message = wasBusy
          ? "Ongoing work finished. Restarting the gateway now."
          : "No other work is active. Restarting the gateway now.";
        await this._notify(record, wasBusy ? "✅ Ongoing work finished. Restarting the gateway now…" : "🔄 No other work is active. Restarting the gateway now…");

        // The visibility post above yields to the event loop. Recheck once more immediately after
        // it returns, then call requestShutdown without another await so a newly accepted turn
        // cannot slip through the observation-to-shutdown gap.
        activity = this.getActivity();
        record.activity = activity;
        if (activity.total === 0) {
          await this.restart({ reason: record.reason });
          record.phase = "restarted";
          record.message = "Gateway restart started.";
          return { restarted: true, activity };
        }
        wasBusy = true;
        record.phase = "waiting";
        record.message = `New work started before shutdown; waiting for ${describeGatewayWork(activity)}.`;
        await this._notify(record, `⏳ New work started before shutdown, so the gateway is still waiting for ${describeGatewayWork(activity)}.`);
      } else {
        wasBusy = true;
        record.phase = "waiting";
        record.message = `Waiting for ${describeGatewayWork(activity)}.`;
        if (!announcedBusy) {
          announcedBusy = true;
          await this._notify(
            record,
            `⏳ Gateway restart is waiting for ${describeGatewayWork(activity)}. I’ll recheck every ${Math.round(this.pollMs / 1000)}s for up to ${Math.round(this.waitMs / 60_000)} minutes rather than interrupt it.`,
          );
        }
      }

      if (record.force) continue; // upgraded while the busy notification was in flight
      const elapsed = this.now() - startedAt;
      if (elapsed >= this.waitMs) {
        record.phase = "cancelled";
        record.message = `Restart cancelled because ${describeGatewayWork(activity)} is still active.`;
        await this._notify(
          record,
          `⚠️ Gateway restart cancelled after ${Math.round(elapsed / 60_000)} minutes because ${describeGatewayWork(activity)} is still active. Retry the restart after that work finishes.`,
        );
        return { restarted: false, reason: "busy", activity };
      }
      await this._waitForPoll(Math.min(this.pollMs, Math.max(1, this.waitMs - elapsed)));
    }
  }
}
