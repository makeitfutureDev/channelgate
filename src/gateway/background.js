// Daemon-side background job runner. The headless `claude -p` subprocess is one-shot: it exits
// the moment it posts its reply, so anything it backgrounds with `nohup … &` outlives it with
// nobody left to react when the work finishes. This module moves ownership of long-running shell
// work to the DAEMON (which outlives every per-message subprocess): the agent calls the gateway
// MCP tool `run_in_background`, we spawn + track the command here, and when it exits we re-inject
// a turn into the SAME Slack thread (same threadKey → same Claude session resumes with full
// context) and post the continuation. This is a local reimplementation of the interactive
// harness's <task-notification> auto-continue.
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getChannelEntry, getChannelMeta, defaultChannelMeta, isAdmin } from "../config/store.js";
import { buildChildEnv } from "../engines/child-env.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { newRunId, runtimeSupports } from "../runtimes/contract.js";
import { killGroup, killTree, processStartTime } from "../util/proc.js";
import { describeProcessOutcome } from "../util/process-outcome.js";
import { appendTail } from "../util/tail.js";
import { effectiveWorkDir } from "./folders.js";
import { gatewayRoot } from "../config/paths.js";
import { runMessage, effectiveMeta } from "./run.js";
import { deliverResult } from "../slack/deliver.js";
import { runQueue } from "../slack/message-lifecycle.js";
import { logEvent } from "../util/logger.js";
import { recordUsage, createUsageBank } from "./usage.js";
import { countDrop } from "../util/drops.js";
import { getDb, toJson, fromJson } from "../db/index.js";
import { postNotice } from "../platforms/notify.js";
import { resolveChannelEnv, safeSpawnEnv } from "../config/channel-env.js";
import { browserNamespaceFor, browserSpawnEnv } from "./browser-env.js";
import { createSecretRedactor, redactSecretValues } from "../util/redact.js";

const MAX_TAIL = 6_000; // chars of combined stdout/stderr fed back to the agent
const MAX_AGENT_REPORT = 12_000; // chars of a background agent's final report fed back to the thread
// Runtime caps are a runaway backstop, NOT a budget — the same philosophy as the turn watchdog
// (a run is never killed for being quiet or merely long). Agent jobs are confined engine runs, so
// they get a week; shell jobs run unsandboxed on the daemon, so they keep a short default unless
// the caller explicitly asks for more. Everything is clamped to the one-week ceiling.
const SHELL_DEFAULT_MAX_MS = 60 * 60 * 1000; // unsandboxed shell default (60 min)
const AGENT_DEFAULT_MAX_MS = 7 * 24 * 60 * 60 * 1000; // confined agent default (1 week)
const HARD_MAX_MS = 7 * 24 * 60 * 60 * 1000; // absolute ceiling for any background job
const DEFAULT_MAX_MS = SHELL_DEFAULT_MAX_MS; // recovery fallback for legacy records without maxMs
const MAX_SHELL_APPROVAL_CMD = 2_000; // a shell command must fit the approval card IN FULL — no hidden tail
const MAX_GLOBAL = 20; // total concurrent background jobs (runaway backstop)
const MAX_PER_THREAD = 3; // concurrent jobs per Slack thread
// How many boot-recovery delivery attempts a finished-but-undelivered job gets before we give up
// loudly (mirrors active-runs' MAX_RECOVER_ATTEMPTS). Slack being unreachable never burns an
// attempt — only a crash/failure mid-delivery does.
const MAX_DELIVERY_ATTEMPTS = 2;

const fmtDur = (ms) =>
  ms < 1000 ? `${ms}ms`
  : ms < 60_000 ? `${(ms / 1000).toFixed(0)}s`
  : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)}m`
  : ms < 86_400_000 ? `${(ms / 3_600_000).toFixed(1)}h`
  : `${(ms / 86_400_000).toFixed(1)}d`;

// The effective runtime cap for a job: the kind's default when none was requested, always clamped
// to the one-week ceiling. Exported for tests.
export function resolveJobCap(kind, requested = 0) {
  const fallback = kind === "agent" ? AGENT_DEFAULT_MAX_MS : SHELL_DEFAULT_MAX_MS;
  const asked = Number(requested);
  return Math.min(Number.isFinite(asked) && asked > 0 ? asked : fallback, HARD_MAX_MS);
}

// What the approval card (and the refusal that follows a Deny) tells an admin about WHERE a shell
// job runs. On the host it is plain bash on the daemon account with the whole filesystem in reach —
// the risk the second click exists for, and the wording stays exactly as it was. In an ISOLATED
// runtime the opposite is true: the job runs inside this channel's own container, on the image's
// toolchain, with only the channel's mounts, and calling that "unsandboxed on the daemon" asks the
// approver to sign off on a danger that is not there (and hides the one thing they'd want to know —
// which image). Driven by the declared capability, never by a backend id.
export function shellJobRuntimeNotice({ isolated = false, image = "" } = {}) {
  if (!isolated) {
    return {
      toolName: "Background shell job (unsandboxed)",
      where: "Runs OUTSIDE the engine sandbox as the daemon user.",
      why: "Shell jobs run unsandboxed on the daemon, so Auto mode needs an explicit admin approval.",
    };
  }
  const tag = String(image || "").trim();
  return {
    toolName: "Background shell job (in this channel's container)",
    where: `Runs inside this channel's container${tag ? ` (${tag})` : ""}, not on the daemon — the image's toolchain, only this channel's mounts.`,
    why: "Shell jobs run outside the engine's own confinement, so Auto mode needs an explicit admin approval.",
  };
}

export function backgroundCompletionNotice({ what = "Background job", label = "job", outcome } = {}) {
  const resolved = outcome || describeProcessOutcome();
  const icon = resolved.ok === true ? "✅" : "⚠️";
  const continuation = resolved.ok === true
    ? "Continuing…"
    : "Continuing so I can review what happened…";
  return `${icon} ${what} *${label}* ${resolved.summary}. ${continuation}`;
}

// The live BackgroundJobs instance, registered at boot so the Slack layer (/status) can read it
// without threading the dependency through the Slack manager.
let active = null;
export function setActiveBackgroundJobs(instance) {
  active = instance;
}
export function getActiveBackgroundJobs() {
  return active;
}

// Durable record of in-flight jobs, so a daemon restart doesn't orphan a running child and lose
// its auto-continue. We persist the serializable fields (NOT the child handle) on every start +
// finish, and on boot recover(): a still-alive PID is watched to completion; a dead one (the
// daemon was down when it finished) gets a forced continuation with an "interrupted" note.
// Persistence lives in the `bg_jobs` table (see ../db).
// Is a pid still a live process this user owns? signal 0 = existence check.
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours (shouldn't happen) — treat as alive
  }
}

// Is this pid still OUR recovered child? Aliveness alone is not identity: across a long daemon
// outage the OS can recycle the pid onto an unrelated process, and trusting it would let recovery
// watch — and eventually SIGTERM — a stranger's process group. The kernel start time recorded at
// spawn is the identity check; a mismatch means the child is gone and the pid is an impostor.
// "" (unverifiable — e.g. `ps` unavailable, or a legacy record without a stored start time) falls
// back to the alive-only answer. Exported for tests.
export function pidIdentityAlive(pid, expectedStart, { probe = processStartTime } = {}) {
  if (!pidAlive(pid)) return false;
  if (!expectedStart) return true; // legacy record — no identity captured at spawn
  const current = probe(pid);
  return !current || current === expectedStart;
}

// What one poll of a RECOVERED job should do, given the two facts the poll establishes. Pure and
// exported because the ordering is the whole guarantee: IDENTITY FIRST, then signals. Across a
// long daemon outage the OS can recycle our pid onto an unrelated process, and the old code
// signalled the process GROUP before checking identity — an over-cap recovered job could
// SIGTERM/SIGKILL a group that was never ours. A pid we can't vouch for is never signalled; it is
// simply declared finished.
export function recoveredWatchAction({ alive, overCap }) {
  return { signal: Boolean(alive && overCap), finish: Boolean(!alive || overCap) };
}

// ── Jobs in an isolated runtime ───────────────────────────────────────────────────────────────
// A shell job outlives the turn that launched it, so it resolves WHERE it runs at its OWN spawn
// (plan §5) and holds a lease for its whole life so the idle reaper cannot stop the environment
// under it. Inside an isolated runtime the job is a DETACHED exec: the client the daemon holds
// returns immediately while the work keeps running in its own session, so there is no stdio to
// attach and no exit code to read from the child. Two consequences, both handled here:
//
//   output — the job writes its own log at a path the artifact mount makes identical on both
//            sides, and the daemon tails that file (same `logFile` field, same `_tailFromLog`);
//   exit   — the wrapper appends a status marker as its last act, so a job that ends normally
//            still reports a real exit code instead of "unknown".
const JOB_EXIT_RE = /\[cg-exit:(\d{1,3})\]\s*$/;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function containerJobScript(command, logFile) {
  return `exec >${shellQuote(logFile)} 2>&1\n${command}\n__cg_exit=$?\nprintf '\\n[cg-exit:%s]\\n' "$__cg_exit"\n`;
}

// The exit code a finished container job left behind, or null when the wrapper never got to write
// it (the job called `exit`, was killed, or the log is gone) — null means "unknown", never 0.
export function parseContainerJobExit(text) {
  const m = JOB_EXIT_RE.exec(String(text || "").trimEnd());
  return m ? Number(m[1]) : null;
}

// The marker is bookkeeping, not output: strip it before anyone reads the tail.
export function stripContainerJobExit(text) {
  return String(text || "").replace(JOB_EXIT_RE, "").replace(/\n+$/, "");
}

export class BackgroundJobs {
  constructor({ slack, requestShellApproval, runner, deliver, resolveTarget } = {}) {
    this.slack = slack;
    // WHERE a shell job runs. Resolved per job at spawn time (a job outlives the turn that queued
    // it, and the channel may have been moved between backends since), and injectable for the same
    // reason `runner`/`deliver` are: the durability boundary must be testable without a container.
    this.resolveTarget = resolveTarget || resolveRuntime;
    // Out-of-band human sign-off for shell jobs (the 2026-08 update plan (internal repo) A1). Injected from
    // server.js (→ slack/approvals.requestApproval) so this module stays testable without Bolt.
    this.requestShellApproval = requestShellApproval || null;
    // The continuation turn + its reply, injectable for the same reason: the delivery boundary is
    // the whole point of this module's durability and must be testable without a real engine.
    this.runner = runner || runMessage;
    this.deliver = deliver || deliverResult;
    this.jobs = new Map(); // id -> record
    // Boot-recovery gate — see armRecovery().
    this._recoveryGate = null;
    this._releaseRecovery = null;
  }

  // _persist() rewrites the WHOLE bg_jobs table from this.jobs, but the daemon opens its HTTP
  // listener BEFORE recover() runs: an API- or approval-triggered start landing in that window
  // persisted only its own job and wiped every row recovery had not re-tracked yet. Arm this gate
  // before the listener opens and _start blocks until recover() releases it. Unarmed (tests and
  // embedders that never call recover) it costs nothing.
  armRecovery() {
    if (this._recoveryGate) return;
    this._recoveryGate = new Promise((resolve) => {
      this._releaseRecovery = resolve;
    });
  }

  _releaseRecoveryGate() {
    this._releaseRecovery?.();
    this._recoveryGate = null;
    this._releaseRecovery = null;
  }

  _client() {
    return this.slack?.snapshot?.().connected ? this.slack.getClient?.() ?? null : null;
  }
  _threadCount(threadKey) {
    let n = 0;
    for (const j of this.jobs.values()) if (j.threadKey === threadKey && !j.pendingDelivery) n++;
    return n;
  }

  // Persist the serializable view of every tracked job (no child handles). Best-effort.
  _persist() {
    try {
      const db = getDb();
      db.exec("BEGIN");
      try {
        db.exec("DELETE FROM bg_jobs");
        const ins = db.prepare("INSERT INTO bg_jobs(id, data) VALUES(?, ?)");
        for (const j of this.jobs.values()) {
          // `startTime` is the spawn-time process identity (see pidIdentityAlive) and
          // `pendingDelivery` the finished-but-undelivered outcome — both exist so a restart in
          // the wrong second reconciles against reality instead of guessing.
          // `runtime` is WHERE the job runs: { backend, runId, container }. A host row keeps
          // behaving exactly as before (pid + kernel start time are its identity); a job in an
          // isolated runtime is found again by its runId, because its pid belongs to a client
          // process that is already gone.
          ins.run(j.id, toJson({ id: j.id, kind: j.kind || "shell", channelId: j.channelId, slug: j.slug, authorId: j.authorId, threadKey: j.threadKey, label: j.label, command: j.command, task: j.task || "", startedAt: j.startedAt, pid: j.pid || null, startTime: j.startTime || "", maxMs: j.maxMs, logFile: j.logFile || "", approvalId: j.approvalId || "", runtime: j.runtime || null, pendingDelivery: j.pendingDelivery || null, deliveryAttempts: j.deliveryAttempts || 0 }));
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } catch (err) {
      countDrop("bg_jobs", err); // persistence is best-effort, but drops cost crash recovery
    }
  }

  // Start a tracked background job. Returns { ok, id?, label?, error? }. Two kinds:
  //   - "shell" (default): a bash command. Gating is authoritative here (the security boundary),
  //     and it is gated by the selected trust tier: Auto mode requires a gateway admin to approve
  //     the exact command via Slack buttons; Admin mode skips that second click only for an admin
  //     author, matching the foreground sandbox-off contract they explicitly selected. The Auto
  //     approval exists because a shell job runs OUTSIDE every engine sandbox — plain bash on the
  //     daemon account with unrestricted filesystem/network — so prompt-injected Auto turns must
  //     never reach it on channel mode alone.
  //   - "agent": a full engine run (Claude or Codex via runMessage) on a FRESH session in this
  //     channel's folder — the durable form of a subagent. No extra gate: the run enforces the
  //     channel's own mode exactly like a foreground turn (permission prompts still surface as
  //     Slack approval buttons in the thread), so it grants nothing a normal message couldn't.
  async start(args) {
    return this._start(args);
  }

  // Called only by the durable Slack approval executor registered in server.js. The persisted
  // action is still re-validated against current mode/channel limits; this bypasses only the
  // already-satisfied exact-command click, never the underlying authorization boundary.
  async startApproved(record) {
    if (record?.action?.kind !== "background_shell") return { ok: false, error: "Unsupported durable approval action." };
    return this._start({ ...record.action, kind: "shell" }, {
      approvalGranted: true,
      approvalId: record.id || "",
      approvedBy: record.decidedBy || "",
      approvedWorkDir: record.action.workDir || "",
    });
  }

  async _start({ channelId, slug, authorId, threadKey, command, label, maxMs = 0, kind = "shell", task }, approval = {}) {
    // Never persist a new job while boot recovery still has un-re-tracked rows in bg_jobs.
    if (this._recoveryGate) await this._recoveryGate;
    const isAgent = kind === "agent";
    maxMs = resolveJobCap(kind, maxMs);
    const cmd = (command || "").trim();
    const taskText = (task || "").trim();
    let approvedBy = String(approval.approvedBy || "").replace(/[<@>]/g, ""); // audit trail for unsandboxed exec
    if (isAgent ? !taskText : !cmd) return { ok: false, error: isAgent ? "No task provided." : "No command provided." };
    if (!channelId || !threadKey) return { ok: false, error: "Missing channel/thread context." };
    if (this.count() >= MAX_GLOBAL) return { ok: false, error: "Too many background jobs are already running on the gateway. Try again shortly." };
    if (this._threadCount(threadKey) >= MAX_PER_THREAD) return { ok: false, error: `This thread already has ${MAX_PER_THREAD} background jobs running.` };

    const entry = await getChannelEntry(channelId);
    if (!entry) return { ok: false, error: "This channel isn't registered." };
    const meta = effectiveMeta(
      (await getChannelMeta(entry.slug)) ??
        defaultChannelMeta({ channelId, name: entry.name, type: entry.type, isDM: entry.isDM })
    );

    // WHERE this shell job runs. Agent jobs go through runMessage, which resolves its own target
    // per turn, so only the shell branch needs one here. Resolved BEFORE the approval gate because
    // the card has to tell the approver which environment they are signing off on.
    let target = null;
    let isolatedJob = false;
    if (!isAgent) {
      try {
        target = this.resolveTarget(entry.slug, meta);
        isolatedJob = runtimeSupports(target, "isolated");
      } catch (e) {
        return { ok: false, error: `Background job could not resolve this channel's runtime: ${e.message}` };
      }
    }

    // How the approval card and its refusal describe this job's environment.
    const runtimeNotice = shellJobRuntimeNotice({ isolated: isolatedJob, image: target?.container?.image || "" });

    if (!isAgent) {
      const adminAuthorInAdminMode = meta.adminMode === true && (await isAdmin(authorId));
      const allowed = meta.autoMode === true || adminAuthorInAdminMode;
      if (adminAuthorInAdminMode && !approval.approvalGranted) {
        approvedBy = String(authorId || "").replace(/[<@>]/g, "");
      }
      if (!allowed) {
        return {
          ok: false,
          error:
            "Background jobs aren't allowed in this channel. They run un-prompted, so they need AUTO mode " +
            "(or ADMIN mode with an admin author). Run the command in the foreground instead, or ask an admin to enable auto mode.",
        };
      }
      // The approver signs off on the EXACT command, so the whole command must fit the card —
      // a sliced preview would let a hidden tail execute unseen. Over-budget commands are
      // refused outright (put the logic in a script file and run that instead).
      if (cmd.length > MAX_SHELL_APPROVAL_CMD) {
        return { ok: false, error: `Shell command is ${cmd.length} chars — too long to display fully on the approval card (max ${MAX_SHELL_APPROVAL_CMD}). Write it to a script file and run the file instead.` };
      }
      if (!approval.approvalGranted && !adminAuthorInAdminMode) {
        // Gate 2 — fail closed: without an approval channel there is no legitimate way to run
        // daemon-side unsandboxed shell.
        if (typeof this.requestShellApproval !== "function") {
          return { ok: false, error: "Background shell jobs are unavailable (no approval channel). Use run_agent_in_background instead — it runs inside the channel's normal confinement." };
        }
        let decision = null;
        try {
          const workDir = effectiveWorkDir(entry.slug, meta);
          decision = await this.requestShellApproval({
            channelId,
            slug: entry.slug,
            authorId,
            threadKey,
            approvalType: "agent", // never auto-approved — auto mode must not bypass this
            requiredTier: "admin", // agent-authored exec outside the engine's own confinement: only an admin's click counts
            toolName: runtimeNotice.toolName,
            toolInput: { details: `$ ${cmd}\n\n${runtimeNotice.where}\nWorking folder: ${workDir}` },
            approveText: "Run it",
            denyText: "Deny",
            durableAction: {
              kind: "background_shell",
              channelId,
              slug: entry.slug,
              authorId,
              threadKey,
              command: cmd,
              workDir,
              label: (label || cmd).slice(0, 80),
              maxMs,
            },
          });
        } catch (e) {
          return { ok: false, error: `Couldn't request approval for the shell job: ${e.message}` };
        }
        if (decision?.pending) {
          return {
            ok: true,
            pendingApproval: true,
            approvalId: decision.approvalId || "",
            label: (label || cmd).slice(0, 80),
          };
        }
        if (!decision?.allow) {
          return {
            ok: false,
            error:
              `Background shell job was not approved${decision?.reason ? ` (${decision.reason})` : ""}. ` +
              `${runtimeNotice.why} ` +
              "Prefer run_agent_in_background — it needs no approval because it runs inside the channel's normal confinement.",
          };
        }
        approvedBy = String(decision.decidedBy || "").replace(/[<@>]/g, "");
      }
    }

    const cwd = effectiveWorkDir(entry.slug, meta);
    if (approval.approvalGranted && approval.approvedWorkDir !== cwd) {
      return {
        ok: false,
        error: "The channel working folder changed after this command was approved. Request a new exact-command approval.",
      };
    }
    const id = randomUUID().slice(0, 8);
    const name = (label || (isAgent ? taskText : cmd)).slice(0, 80);
    const startedAt = Date.now();

    // Capture output to a central log (out of any real project dir) plus a rolling in-memory tail.
    // A detached exec inside an isolated runtime has no stdio to attach, so its log is written by
    // the job itself into the channel's artifact dir — the same absolute path on both sides of the
    // mount, which is what lets the daemon tail it exactly as if it had captured the stream.
    let logStream = null;
    let logFile = "";
    try {
      if (isolatedJob) {
        const dir = path.join(target.artifactDir, "jobs");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        logFile = path.join(dir, `${id}.log`);
      } else {
        const dir = path.join(gatewayRoot(), "logs", "bg");
        mkdirSync(dir, { recursive: true });
        logFile = path.join(dir, `${entry.slug}__${id}.log`);
        logStream = createWriteStream(logFile, { flags: "a" });
        // A WriteStream emits 'error' ASYNCHRONOUSLY (disk full, the log dir removed under us, an
        // EBADF on a stream we already ended). An unhandled 'error' on a stream is a process-level
        // throw — it would take the whole daemon down over one job's log file. Handle it here so the
        // damage is exactly "this job stops being logged": drop the stream and keep the in-memory
        // tail, which is what the continuation actually reports.
        logStream.on("error", (err) => {
          logStream = null;
          countDrop("bg_log", err);
        });
      }
    } catch {
      /* logging is best-effort */
    }

    const rec = { id, kind, channelId, slug: entry.slug, authorId, threadKey, label: name, command: cmd, task: taskText, startedAt, child: null, pid: null, maxMs, logFile, tail: "", timedOut: false, approvalId: approval.approvalId || "", target };
    const writeChunk = (chunk) => {
      try {
        logStream?.write(chunk);
      } catch {
        /* ignore */
      }
      rec.tail = appendTail(rec.tail, chunk, MAX_TAIL);
    };
    // The channel's own environment secrets, resolved at THIS spawn rather than inherited from the
    // run that queued the job: a background job outlives its run, and a provider's lease may not.
    const jobEnv = safeSpawnEnv(await resolveChannelEnv(meta));
    let onChunk = writeChunk;
    let flushChunks = () => {};

    if (isAgent) {
      this.jobs.set(id, rec);
      this._persist();
      this._runAgent(rec, logStream, onChunk);
    } else {
      let child;
      // This branch is where a CLI echoes a token into its own error line, so its output is
      // value-redacted on the way to the thread and the job log. The agent branch above needs no
      // redactor: everything it emits already came through runMessage, which redacts its own.
      const shellRedactor = createSecretRedactor(Object.values(jobEnv));
      onChunk = (chunk) => {
        const safe = shellRedactor.push(chunk);
        if (safe) writeChunk(safe);
      };
      flushChunks = () => {
        const rest = shellRedactor.flush();
        if (rest) writeChunk(rest);
      };
      // The runtime must be ready before anything is spawned into it, and the job must hold a
      // lease for its whole life — a job is exactly the kind of work the idle reaper would
      // otherwise stop out from under. Both are no-ops on the host backend.
      const runId = newRunId("job");
      try {
        await target.runtime.ensureUp(target, { announce: () => {} });
      } catch (e) {
        logStream?.end();
        return { ok: false, error: `Background job could not start: this channel's runtime is unavailable (${e.message}).` };
      }
      rec.runtime = { backend: target.backend, runId, container: target.container?.name || "" };
      rec.lease = target.runtime.acquireLease(target, { kind: "job", id: runId });
      try {
        // Minimal allowlisted env plus THIS channel's own secrets — this IS agent-authored shell,
        // so the daemon's secrets must not be visible, and another channel's never are. The browser
        // namespace is merged HERE rather than into jobEnv: jobEnv's values are what the redactor
        // above blanks out of the job's output, and the namespace is not a secret. A background job
        // outlives its run and is not confined by the Bash sandbox, so it needs the same
        // per-channel browser as the run that queued it (see gateway/browser-env.js).
        // detached → own process group, so the cap-kill takes any grandchildren too (see util/proc.js).
        const shellEnv = { ...jobEnv, ...browserSpawnEnv(browserNamespaceFor({ platform: meta.platform, slug: entry.slug })) };
        child = target.runtime.spawn(target, {
          cmd: "bash",
          // Isolated: the job redirects itself into the log the daemon tails, because a detached
          // exec hands back no stdio (see containerJobScript). Host: today's exact argv.
          args: ["-lc", isolatedJob ? containerJobScript(cmd, logFile) : cmd],
          cwd,
          env: buildChildEnv(shellEnv),
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          // A job is a BACKGROUND spawn: no client stdio, outlives the daemon, found again by runId
          // (host: today's detached bash; container: `exec -d`). `detached` alone is the host
          // process-group flag every engine spawn also sets — it must not mean "no stdio".
          background: true,
          runId,
          kind: "job",
        });
      } catch (e) {
        rec.lease?.release?.();
        logStream?.end();
        const outcome = describeProcessOutcome({ spawnError: e });
        return { ok: false, error: `Background job ${outcome.summary}.` };
      }
      rec.child = child;
      rec.pid = child.pid;
      // Record the kernel start time NOW, while the pid provably belongs to this child. After a
      // long daemon outage the pid alone proves nothing (see pidIdentityAlive).
      rec.startTime = processStartTime(child.pid);
      this.jobs.set(id, rec);
      this._persist();

      if (isolatedJob) {
        // The client process the daemon holds has already done its job (it asked the runtime to
        // start the group and returned), so its exit says nothing about the work. Liveness comes
        // from the backend's probe on the recorded runId, and output from the log file.
        rec.runtimeChild = child;
        rec.secretValues = Object.values(jobEnv);
        child.on?.("error", (err) => {
          this._finish(rec, { spawnError: err });
        });
        this._watchByProbe(rec, { recovered: false });
      } else {
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", onChunk);
        child.stderr.on("data", onChunk);

        const timer = setTimeout(() => {
          rec.timedOut = true;
          killTree(child, "SIGTERM");
          setTimeout(() => killTree(child, "SIGKILL"), 2_000).unref();
        }, maxMs);
        timer.unref?.();

        child.on("error", (err) => {
          clearTimeout(timer);
          flushChunks();
          logStream?.end();
          this._finish(rec, { spawnError: err });
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          flushChunks();
          logStream?.end();
          this._finish(rec, { code, signal });
        });
      }
    }

    await this._postStarted(rec);
    await logEvent("bg_start", { id, kind, slug: entry.slug, channel: channelId, label: name, cwd, logFile, approvedBy: approvedBy || "", approvalId: approval.approvalId || "" });
    return { ok: true, id, label: name };
  }

  // Run an agent-kind job: a full engine turn (Claude/Codex per the channel's config, with the
  // channel lockdown + the launching author's tokens) on a SYNTHETIC thread key, so it gets a
  // fresh session and can never collide with the launching thread's own session. The daemon owns
  // the promise; when it settles, the normal _finish path re-injects the report into the real
  // thread. Progress deltas/tool steps stream into the job tail for the status button.
  _runAgent(rec, logStream, onChunk) {
    const controller = new AbortController();
    rec.abort = controller;
    const timer = setTimeout(() => {
      rec.timedOut = true;
      controller.abort();
    }, rec.maxMs);
    timer.unref?.();

    const prompt =
      `[background agent] You are a background agent launched from a Slack thread in this channel. ` +
      `Work autonomously; you cannot ask questions mid-task. Your FINAL message is delivered back to the ` +
      `launching thread when you finish, so make it a complete, self-contained report of what you did and found.\n\n` +
      `Task:\n${rec.task}`;

    runMessage({
      channelId: rec.channelId,
      authorId: rec.authorId,
      text: prompt,
      threadKey: `${rec.threadKey}::agent-${rec.id}`,
      origin: "background_agent", // daemon-triggered: structurally never escalates
      preferCold: true, // one-shot: don't leave a warm process idling after the agent finishes
      signal: controller.signal,
      onDelta: onChunk,
      onEvent: (ev) => {
        if (ev?.kind === "tool_use") onChunk(`\n[${ev.name}${ev.target ? ` ${ev.target}` : ""}]\n`);
      },
    })
      .then(async (result) => {
        clearTimeout(timer);
        logStream?.end();
        rec.result = result;
        // The agent run's own usage is real spend — record it apart from the continuation turn.
        try {
          await recordUsage({ channelId: rec.channelId, slug: rec.slug, authorId: rec.authorId, engine: result.engine, taskKind: "background-agent", result });
        } catch {
          /* accounting is best-effort */
        }
        await this._finish(rec, { outcome: describeProcessOutcome({ code: 0 }) });
      })
      .catch(async (err) => {
        clearTimeout(timer);
        logStream?.end();
        const outcome = rec.timedOut
          ? describeProcessOutcome({ timedOut: true, timeout: fmtDur(Date.now() - rec.startedAt) })
          : { ok: false, kind: "failed", summary: `failed: ${err.message}` };
        await this._finish(rec, { outcome });
      });
  }

  // Visible lifecycle: a small in-thread note with a status button, so anyone in the thread can
  // see the job is running and check on it without waiting for the finish notification.
  async _postStarted(rec) {
    const client = this._client();
    if (!client) return;
    const what = rec.kind === "agent" ? "🤖 Background agent" : "⚙️ Background job";
    try {
      // The "Check status" button is a Block Kit surface. postNotice drops `blocks` on any platform
      // without Block Kit, so the plain `text` still delivers there — a job that starts silently is
      // exactly what this notice exists to prevent. Re-authoring the control as a Chat card /
      // Adaptive Card is per-platform work tracked separately.
      await postNotice(client, {
        conversationId: rec.channelId,
        threadKey: rec.threadKey,
        text: `${what} *${rec.label}* started (id ${rec.id}) — the result will be posted in this thread when it finishes.`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `${what} *${rec.label}* is running — I'll post the result in this thread when it finishes.` } },
          {
            type: "actions",
            elements: [{ type: "button", text: { type: "plain_text", text: "Check status" }, action_id: "cg_bgjob_status", value: rec.id }],
          },
        ],
      });
    } catch {
      /* visibility is best-effort — the finish notification still lands */
    }
  }

  // Live status for the "Check status" button (and any other UI). Serializable; null = not found.
  // A tracked job whose work is done but whose continuation hasn't been delivered yet reports
  // `finished` — the "Check status" button must not claim it is still working.
  status(id) {
    const j = this.jobs.get(id);
    if (!j) return null;
    return { id: j.id, kind: j.kind || "shell", label: j.label, runtimeMs: Date.now() - j.startedAt, maxMs: j.maxMs, tail: j.tail || "", finished: Boolean(j.pendingDelivery) };
  }

  // The job's process (or engine run) ended. This is NOT the terminal boundary: the thread is
  // still owed a completion notice and the auto-continuation, and deleting the durable row first
  // (as this used to) means a crash — or a Slack outage — in the seconds between exit and delivery
  // loses the job with nobody ever told. Persist the finished outcome as a PENDING DELIVERY
  // instead, then deliver; only a delivered (or explicitly given-up) job drops its row.
  async _finish(rec, { code = null, signal = "", spawnError = null, outcome = null } = {}) {
    if (!this.jobs.has(rec.id) || rec.pendingDelivery) return; // already finished (avoid a double continuation)
    // The work is over: stop holding the runtime up, and stop polling its log.
    try { rec.lease?.release?.(); } catch { /* the job is finished either way */ }
    rec.lease = null;
    if (rec.tailTimer) { clearInterval(rec.tailTimer); rec.tailTimer = null; }
    if (rec.watchTimer) { clearInterval(rec.watchTimer); rec.watchTimer = null; }
    const durMs = Date.now() - rec.startedAt;
    const resolvedOutcome = outcome || describeProcessOutcome({
      code,
      signal,
      spawnError,
      timedOut: rec.timedOut,
      timeout: fmtDur(durMs),
    });
    rec.pendingDelivery = {
      outcome: resolvedOutcome,
      durMs,
      // The agent's final report lives only in memory otherwise; persist it so a redelivery after
      // a restart still carries the report instead of degrading to the log tail.
      report: rec.kind === "agent" && rec.result?.content ? String(rec.result.content).slice(0, MAX_AGENT_REPORT) : "",
    };
    this._persist();
    await logEvent("bg_finish", {
      id: rec.id,
      slug: rec.slug,
      status: resolvedOutcome.summary,
      outcome: resolvedOutcome.kind,
      ok: resolvedOutcome.ok,
      exitCode: code,
      signal: signal || "",
      durMs,
    });
    await this._deliver(rec);
  }

  // Deliver a finished job: the in-thread notice, then the auto-continuation turn (which resumes
  // the same session and runs as the original author, so their tokens/mode apply unchanged). The
  // durable row is deleted ONLY after that delivery — or after the attempt budget is spent, which
  // is the explicit terminal failure. Slack being unreachable is not an attempt: the row simply
  // survives to the next boot.
  async _deliver(rec) {
    if (!this.jobs.has(rec.id) || rec.delivering) return;
    const pending = rec.pendingDelivery || {};
    const resolvedOutcome = pending.outcome || describeProcessOutcome();
    const durMs = Number(pending.durMs) || Math.max(0, Date.now() - (rec.startedAt || Date.now()));
    const status = resolvedOutcome.summary;
    const isAgent = rec.kind === "agent";
    const what = isAgent ? "Background agent" : "Background job";

    const client = this._client();
    if (!client) {
      await logEvent("bg_skip_post", { id: rec.id, reason: "slack not connected" });
      return; // row survives — the next boot redelivers
    }
    const attempts = (rec.deliveryAttempts || 0) + 1;
    if (attempts > MAX_DELIVERY_ATTEMPTS) {
      // Every attempt died mid-delivery. Stop retrying, but say so in the thread — a job that
      // vanishes silently is exactly what this whole path exists to prevent.
      this.jobs.delete(rec.id);
      this._persist();
      await logEvent("bg_deliver_giveup", { id: rec.id, slug: rec.slug, attempts });
      try {
        await postNotice(client, {
          conversationId: rec.channelId,
          threadKey: rec.threadKey,
          text: `⚠️ ${what} *${rec.label}* ${status}, but I couldn't deliver the follow-up after ${MAX_DELIVERY_ATTEMPTS} attempts — check the job log and tell me how to continue.`,
        });
      } catch {
        /* ignore */
      }
      return;
    }
    rec.delivering = true;
    // Persist the bumped attempt counter BEFORE delivering: that's the durable claim which stops a
    // job that crashes the daemon mid-delivery from retrying forever.
    rec.deliveryAttempts = attempts;
    this._persist();
    try {
      // Heads-up so the thread shows the job fired before the (possibly slow) continuation turn runs.
      try {
        await postNotice(client, {
          conversationId: rec.channelId,
          threadKey: rec.threadKey,
          text: backgroundCompletionNotice({ what, label: rec.label, outcome: resolvedOutcome }),
        });
      } catch {
        /* non-fatal */
      }

      // Agent jobs deliver their final message as the payload; the streamed tail is only the
      // fallback (a failed/interrupted agent still shows its partial progress). Shell jobs keep
      // the output tail.
      const report = pending.report || "";
      const body = report
        ? `\n--- agent report ---\n${report.trim()}\n--- end report ---`
        : rec.tail
          ? `\n--- ${isAgent ? "partial progress" : "output"} (last ${MAX_TAIL} chars) ---\n${rec.tail.trim()}\n--- end ---`
          : `\n(no ${isAgent ? "report" : "output"} captured)`;
      const text =
        `[automatic continuation] The ${what.toLowerCase()} you launched — "${rec.label}" (id ${rec.id}) — ended. ` +
        `Outcome: ${status}. Runtime: ${fmtDur(durMs)}.` +
        body +
        (isAgent
          ? `\n\nPresent the outcome to the user in this thread (concise Slack mrkdwn). If the agent failed, its success ` +
            `could not be confirmed, or the ` +
            `report is incomplete, say so plainly and decide the next step. Do not re-launch the same agent.`
          : `\n\nContinue the task you were doing before you launched this job. The recorded outcome is ` +
            `${resolvedOutcome.ok === true ? "success" : resolvedOutcome.ok === false ? "failure" : "unknown"}. ` +
            `Proceed only on confirmed success; otherwise diagnose from the output above. Do not re-launch the same job.`);

      if (isAgent && report && resolvedOutcome.ok === true) {
        // The background-agent prompt requires a complete, self-contained final report. Deliver
        // that report directly instead of asking the launching thread's model to paraphrase it in
        // a SECOND engine turn. Besides wasting time/tokens, that dependency stranded completed
        // reports when a pinned model hit its usage limit: the durable row survived, but nothing
        // retried it until the daemon restarted. `deliverResult` still applies the full unattended
        // sanitization, mention resolution, and chunking pipeline.
        await this.deliver(client, {
          channel: rec.channelId,
          threadKey: rec.threadKey,
          result: { content: report, engine: rec.result?.engine || "" },
        });
      } else {
        // Shell output and failed/incomplete agent runs still need interpretation. Their
        // continuation is a real turn in a real Slack thread, so it takes the SAME per-thread
        // queue as a live message. Calling runMessage directly let it resume the thread's session
        // concurrently with whatever a human had just sent — two engines in one session/cwd.
        const runKey = `${rec.slug || rec.channelId}::${rec.threadKey}`;
        const handle = { aborted: false, controller: new AbortController(), authorId: rec.authorId, background: true };
        const bankUsage = createUsageBank();
        await runQueue.acquire(runKey, handle);
        try {
          // A stop that landed while we were queued is itself terminal — the stop handler already
          // answered the thread, so skip the turn but still retire the row.
          if (!handle.aborted) {
            const result = await this.runner({
              channelId: rec.channelId,
              authorId: rec.authorId,
              text,
              threadKey: rec.threadKey,
              origin: "continuation",
              signal: handle.controller.signal,
            });
            // The continuation's tokens are spent before Slack sees a word of it — bank them first.
            await bankUsage({ channelId: rec.channelId, slug: rec.slug, authorId: rec.authorId, engine: result.engine, taskKind: "background", result });
            // Same sanitize/chunk pipeline as every unattended reply (deliverResult) — background
            // continuations are prompt-injection bait.
            await this.deliver(client, { channel: rec.channelId, threadKey: rec.threadKey, result });
          }
        } finally {
          runQueue.release(runKey, handle);
        }
      }
      // Delivered: this is the terminal boundary, so now the durable row goes.
      this.jobs.delete(rec.id);
      this._persist();
    } catch (err) {
      // Keep the row: the job finished for real, and its thread still hasn't been told properly.
      // Boot recovery redelivers it (up to MAX_DELIVERY_ATTEMPTS).
      await logEvent("bg_continue_error", { id: rec.id, error: err.message });
      try {
        await postNotice(client, { conversationId: rec.channelId, threadKey: rec.threadKey, text: `⚠️ ${what} *${rec.label}* ${status}, but I couldn't continue: ${err.message}` });
      } catch {
        /* ignore */
      }
    } finally {
      rec.delivering = false;
    }
  }

  // How many jobs are actually RUNNING. A job that finished and is only waiting to deliver its
  // continuation still holds a durable row, but it is no longer work in flight — it must not show
  // up as running, nor keep occupying a concurrency slot.
  count() {
    let n = 0;
    for (const j of this.jobs.values()) if (!j.pendingDelivery) n++;
    return n;
  }

  // Live jobs for a thread/channel (for the /status view). Returns serializable summaries.
  listForChannel(slug) {
    const out = [];
    for (const j of this.jobs.values()) {
      if (j.slug !== slug || j.pendingDelivery) continue;
      out.push({ id: j.id, kind: j.kind || "shell", label: j.label, command: j.kind === "agent" ? j.task : j.command, threadKey: j.threadKey, runtimeMs: Date.now() - j.startedAt });
    }
    return out;
  }

  // Read a finished/recovered job's output tail from its log file (the in-memory tail is gone
  // after a restart). Best-effort.
  // `rec` is optional: a job whose output was written from INSIDE an isolated runtime never passed
  // through the streaming redactor, so its secrets are blanked here instead — write-only in the UI
  // has to mean write-only in the thread too — and the exit marker the wrapper appended is
  // bookkeeping, not output.
  async _tailFromLog(logFile, rec = null) {
    if (!logFile) return "";
    try {
      const txt = await readFile(logFile, "utf8");
      const tail = txt.slice(-MAX_TAIL);
      if (!rec?.runtimeChild) return tail;
      return redactSecretValues(stripContainerJobExit(tail), rec.secretValues || []);
    } catch {
      return "";
    }
  }

  // Boot recovery: read the persisted job list and reconcile each against reality.
  //  - Pending delivery → it finished before the restart but its thread was never told; redeliver.
  //  - PID still alive AND still ours → the job outlived the restart; watch it, then continue.
  //  - PID gone (or recycled onto a stranger) → it finished (or died) while the daemon was down;
  //    force the continuation now with an "interrupted by restart" note so the thread never stalls.
  async recover() {
    try {
      await this._recoverJobs();
    } finally {
      // A failed recovery must never wedge every future start behind a gate nobody will open.
      this._releaseRecoveryGate();
    }
  }

  async _recoverJobs() {
    let saved = [];
    try {
      saved = getDb().prepare("SELECT data FROM bg_jobs ORDER BY rowid").all().map((r) => fromJson(r.data, null)).filter(Boolean);
    } catch {
      return; // DB unreadable — nothing to recover
    }
    if (!saved.length) return;
    // Reconcile IN PLACE — no destructive wipe first. Re-track every persisted job before touching
    // any of them, so any _persist() fired mid-recovery (e.g. by an early _finish) rewrites the
    // FULL surviving set; a crash in this window can no longer orphan rows that weren't yet
    // reconciled. Rows only leave the table via _finish (which deletes its own job and persists).
    const recs = [];
    for (const s of saved) {
      if (this.jobs.has(s.id)) continue; // already tracked (recover should only run once at boot)
      const rec = { ...s, child: null, tail: "", timedOut: false };
      this.jobs.set(rec.id, rec);
      recs.push(rec);
    }
    // Every persisted row is tracked now, so a concurrent _persist() can no longer drop one — the
    // exact invariant the start gate was protecting. Open it HERE, before the reconciliation loop:
    // that loop awaits whole continuation turns, and an agent inside one may itself launch a
    // background job, which would otherwise deadlock against a gate this same call has to release.
    this._releaseRecoveryGate();
    for (const rec of recs) {
      // A row that recorded a non-host runtime needs its target rebuilt before anything can be
      // asked about it: its pid belonged to a client process that died with the old daemon, and
      // only the backend can answer whether the job's own process group is still alive. If the
      // channel has since been moved to a different backend (or the runtime can't be resolved at
      // all) we deliberately do NOT guess — the job falls through to the "could not be confirmed"
      // continuation below, which is what an unverifiable job has always produced.
      if (rec.runtime?.backend && rec.runtime.backend !== "host") await this._attachRecoveredRuntime(rec);
      rec.tail = await this._tailFromLog(rec.logFile, rec);
      if (rec.pendingDelivery) {
        // The job already ran to completion; only its notice/continuation is outstanding.
        await logEvent("bg_recover_redeliver", { id: rec.id, slug: rec.slug, attempts: rec.deliveryAttempts || 0 });
        await this._deliver(rec);
      } else if (await this._jobAlive(rec)) {
        await logEvent("bg_recover_watch", { id: rec.id, slug: rec.slug, pid: rec.pid, runtime: rec.runtime?.backend || "host" });
        this._watchByProbe(rec, { recovered: true });
      } else {
        // Already tracked above, so _finish's guard passes → force the continuation.
        await logEvent("bg_recover_interrupted", { id: rec.id, slug: rec.slug });
        const durMs = Date.now() - (rec.startedAt || Date.now());
        await this._finish(rec, {
          outcome: {
            ok: null,
            kind: "restart_unknown",
            summary: `was no longer running after the gateway restart, so its result could not be confirmed after ${fmtDur(durMs)}`,
          },
        });
      }
    }
  }

  // Rebuild the runtime target a recovered row was spawned into, so its process group can be
  // probed and signalled. Only a target for the SAME backend the row recorded is accepted: if the
  // channel has been flipped between backends since, probing the new one would answer a question
  // about a different environment.
  async _attachRecoveredRuntime(rec) {
    try {
      const meta = effectiveMeta((await getChannelMeta(rec.slug)) || {});
      const target = this.resolveTarget(rec.slug, meta);
      if (!target || target.backend !== rec.runtime.backend) return;
      rec.target = target;
      // The minimal runtime child the backend needs: the runId IS the handle to the job's process
      // group inside the runtime (attachRuntime records the same shape at spawn).
      rec.runtimeChild = { pid: rec.pid || undefined, runtime: { backend: target.backend, runId: rec.runtime.runId || "", kind: "job", target } };
      // A job inside an isolated runtime wrote its log itself, so unlike a host job it never passed
      // through the streaming redactor — the channel's secrets are blanked when the tail is READ,
      // and after a restart the values have to be resolved again to do that.
      try {
        rec.secretValues = Object.values(safeSpawnEnv(await resolveChannelEnv(meta)));
      } catch {
        rec.secretValues = [];
      }
    } catch {
      /* unresolvable channel/runtime — the job stays unverifiable, which the caller handles */
    }
  }

  // Is the job's work still running? A host job is its pid (plus the kernel start time, which is
  // what makes the pid an identity). A job in an isolated runtime is its process group inside that
  // runtime, which only the backend can see — and a probe that fails to ANSWER is "unknown", never
  // "dead": the same rule the turn watchdog follows, for the same reason.
  async _jobAlive(rec) {
    if (rec.target && rec.runtimeChild && runtimeSupports(rec.target, "isolated")) {
      try {
        return Boolean(await rec.target.runtime.probe(rec.runtimeChild));
      } catch {
        return true;
      }
    }
    return pidIdentityAlive(rec.pid, rec.startTime);
  }

  // Deliver a signal to the job's WHOLE process group, wherever that group lives. The host
  // backend's signal() IS killTree/killGroup, so a host job behaves exactly as before.
  async _signalJob(rec, signal) {
    const child = rec.child?.runtime ? rec.child : rec.runtimeChild;
    const target = rec.target || child?.runtime?.target;
    if (child && typeof target?.runtime?.signal === "function") {
      try {
        await target.runtime.signal(child, signal);
        return;
      } catch {
        /* fall through to the pid path — better a best-effort kill than none */
      }
    }
    if (rec.child) killTree(rec.child, signal);
    else if (rec.pid) killGroup(rec.pid, signal);
  }

  // Poll a job whose exit we cannot be told about — a recovered one (we can't re-attach to its
  // stdio) or a detached job inside an isolated runtime (the client that started it has already
  // returned) — honoring the remaining time cap, then continue the thread with the tail read from
  // the log file.
  _watchByProbe(rec, { recovered = true } = {}) {
    const deadline = (rec.startedAt || Date.now()) + (rec.maxMs || DEFAULT_MAX_MS);
    let escalation = null;
    // A live isolated job's log is the only view of its progress, so keep the in-memory tail (the
    // "Check status" button) fresh while it runs.
    if (!recovered && rec.logFile) {
      rec.tailTimer = setInterval(async () => {
        if (!this.jobs.has(rec.id) || rec.pendingDelivery) return;
        rec.tail = await this._tailFromLog(rec.logFile, rec);
      }, 5_000);
      rec.tailTimer.unref?.();
    }
    const tick = async () => {
      if (!this.jobs.has(rec.id) || rec.pendingDelivery) return; // finished elsewhere
      const alive = await this._jobAlive(rec);
      const overCap = Date.now() > deadline;
      const { signal, finish } = recoveredWatchAction({ alive, overCap });
      if (signal) {
        // Mirror the live cap-kill: ask politely, then insist. A TERM the job ignores would
        // otherwise leave it running forever with the daemon convinced it had been stopped.
        // Recovered jobs were spawned detached → the pid is a process-group leader.
        await this._signalJob(rec, "SIGTERM");
        escalation = setTimeout(() => {
          // Re-verify: the TERM may have worked and the pid may already have been reused.
          this._jobAlive(rec).then((stillAlive) => { if (stillAlive) this._signalJob(rec, "SIGKILL"); }).catch(() => {});
        }, 2_000);
        escalation.unref?.();
        rec.timedOut = true;
      }
      if (finish) {
        clearInterval(timer);
        if (!alive && escalation) {
          clearTimeout(escalation); // the process is already gone — never fire a stray KILL
          escalation = null;
        }
        const raw = await this._tailFromLog(rec.logFile);
        rec.tail = await this._tailFromLog(rec.logFile, rec);
        // A job that ran to completion inside an isolated runtime left its exit status as the last
        // line of its own log — so a container job reports a real outcome instead of "unknown".
        const exitCode = rec.runtimeChild && !rec.timedOut ? parseContainerJobExit(raw) : null;
        await this._finish(rec, {
          outcome: rec.timedOut
            ? describeProcessOutcome({ timedOut: true, timeout: fmtDur(Date.now() - rec.startedAt) })
            : exitCode != null
              ? describeProcessOutcome({ code: exitCode })
              : {
                  ok: null,
                  kind: recovered ? "restart_unknown" : "unknown",
                  summary: recovered
                    ? "finished after the gateway restart, but its result could not be confirmed"
                    : "finished, but its exit status could not be read back from the channel runtime",
                },
        });
      }
    };
    const timer = setInterval(tick, 5_000);
    timer.unref?.();
    // _finish can also be reached from outside this loop (a spawn error, a cap-kill elsewhere), so
    // it owns clearing the poller too — otherwise the interval survives the job it was watching.
    rec.watchTimer = timer;
  }
}
