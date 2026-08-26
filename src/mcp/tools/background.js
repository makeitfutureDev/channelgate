// Background-work + approval tools for the gateway control MCP server: daemon-owned background
// jobs and agents, Slack plan approvals, progress-report snapshots, and Claude's
// permission-prompt target. Split out of gateway-server.js — registered via
// register(server, ctx); the tool contracts are unchanged.
import { z } from "zod";
import { progressReportInputSchema } from "../../engines/progress-report.js";

export function register(server, ctx) {
  const { channelId, slug, createdBy, text, approvalSecret, approvalPort } = ctx;

  // ── Background jobs (auto/admin channels) ───────────────────────────────────────
  // Hand a long-running shell command to the DAEMON instead of backgrounding it yourself with
  // `nohup … &`. Your `claude -p` process exits the moment this turn ends, so a self-detached job
  // would finish with nobody to react. The daemon tracks the job and, when it finishes, RE-INVOKES
  // you in this same thread (your session resumes with full context) to continue automatically.
  server.registerTool(
    "run_in_background",
    {
      description:
        "Run a long-running shell COMMAND in the background and CONTINUE AUTOMATICALLY when it finishes. " +
        "The gateway daemon owns the job (not your turn), so you MUST end your turn right after calling " +
        "this — do NOT poll, sleep, tail logs, or wait. When the job exits, you will be re-invoked in " +
        "THIS thread with a plain-language outcome + output tail, and your session resumes with full " +
        "context so you can pick up where you left off. The command runs with bash in this channel's " +
        "working folder. `label` is a short human name shown in Slack. Use this for builds, long " +
        "transcriptions/ASR, test suites, data jobs — anything over a minute. Requires the channel to be " +
        "in auto mode (or admin mode with an admin author). Auto mode posts a durable Slack approval with the " +
        "exact command that a gateway admin must click before the job starts; Admin mode starts directly only for " +
        "an admin author. For an approval, the tool returns immediately after saving the request; the Run it button " +
        "remains valid across daemon/engine restarts and directly starts that one exact command once. Shell jobs run " +
        "outside the engine sandbox, so prefer run_agent_in_background when the work can run as a " +
        "normal confined agent (no approval needed there). The initial call returns a pending approval id; " +
        "the Slack card gains the job id after approval. In either case, STOP and end your turn.",
      inputSchema: { command: z.string(), label: z.string().optional() },
    },
    async ({ command, label }) => {
      if (!channelId) return text("No channel context — can't run a background job here.");
      const secret = approvalSecret();
      const port = approvalPort();
      if (!secret) return text("Background jobs are unavailable right now.");
      try {
        const res = await fetch(`http://127.0.0.1:${port}/internal/background`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-cg-secret": secret },
          body: JSON.stringify({ channelId, slug, authorId: createdBy, threadKey: process.env.CG_THREAD_KEY || "", command, label: label || "" }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!data.ok) return text(`Couldn't start the background job: ${data.error || "unknown error"}`);
        if (data.pendingApproval) {
          return text(
            `⏳ Approval saved for background job *${data.label}*. The exact-command *Run it* button remains active across restarts. ` +
              `END YOUR TURN — when a gateway admin clicks it, the daemon starts the job directly and posts its status/result here. ` +
              `Do not wait or poll.`
          );
        }
        return text(
          `✅ Started background job *${data.label}* (id ${data.id}). It's running on the daemon now. ` +
            `END YOUR TURN — I'll be re-invoked in this thread automatically when it finishes, and continue from there. ` +
            `Do not wait or poll.`
        );
      } catch (e) {
        return text(`Couldn't start the background job: ${e.message}`);
      }
    }
  );

  // The durable form of a subagent. The engine's own Agent/Task background option dies with your
  // process (a Stop hook blocks you from orphaning one mid-turn), so for delegated work that should
  // continue AFTER your reply, hand the task to the daemon: it runs a fresh engine session in this
  // channel's folder and re-invokes this thread with the agent's report when it finishes.
  server.registerTool(
    "run_agent_in_background",
    {
      description:
        "Launch a BACKGROUND AGENT: the gateway daemon runs a separate engine session (Claude or Codex, " +
        "same channel folder/lockdown/mode) on the given TASK and CONTINUES THIS THREAD AUTOMATICALLY when " +
        "it finishes — you are re-invoked here with the agent's full report. Use this INSTEAD of the " +
        "built-in Agent/Task background option whenever delegated work should outlive your current turn " +
        "(long research, big builds/analyses, multi-step side quests). The daemon owns the job, so you MUST " +
        "end your turn right after calling this — do NOT poll or wait. Write `task` as a complete, " +
        "self-contained brief (the agent starts with no context from this conversation); `label` is a short " +
        "human name shown in Slack. Works in every channel mode — the agent obeys the channel's own " +
        "permissions exactly like a normal turn; in an ADMIN channel an admin's agent runs at the auto tier " +
        "(writable + auto-approved, still sandboxed — never sandbox-off). Agents may run up to a week. " +
        "Returns a job id; after that, STOP and end your turn.",
      inputSchema: { task: z.string(), label: z.string().optional() },
    },
    async ({ task, label }) => {
      if (!channelId) return text("No channel context — can't run a background agent here.");
      const secret = approvalSecret();
      const port = approvalPort();
      if (!secret) return text("Background agents are unavailable right now.");
      try {
        const res = await fetch(`http://127.0.0.1:${port}/internal/background`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-cg-secret": secret },
          body: JSON.stringify({ kind: "agent", channelId, slug, authorId: createdBy, threadKey: process.env.CG_THREAD_KEY || "", task, label: label || "" }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!data.ok) return text(`Couldn't start the background agent: ${data.error || "unknown error"}`);
        return text(
          `✅ Started background agent *${data.label}* (id ${data.id}). It's running on the daemon now. ` +
            `END YOUR TURN — this thread will be re-invoked automatically with the agent's report when it finishes. ` +
            `Do not wait or poll.`
        );
      } catch (e) {
        return text(`Couldn't start the background agent: ${e.message}`);
      }
    }
  );

  server.registerTool(
    "request_approval",
    {
      description:
        "Ask the Slack user to approve a plan or proposed action before continuing. Use this instead " +
        "of ending your reply with a plain approval question. The gateway posts a visual Slack approval " +
        "object in this thread with Approve, Deny, and Comment/request-changes controls, waits for the " +
        "decision, and returns JSON: { approved, feedback, decided_by }. If approved, continue. If denied " +
        "or feedback is present, incorporate the feedback before proceeding.",
      inputSchema: {
        title: z.string().optional(),
        details: z.string(),
        approve_label: z.string().optional(),
        deny_label: z.string().optional(),
      },
    },
    async ({ title, details, approve_label, deny_label }) => {
      if (!channelId) return text(JSON.stringify({ approved: false, feedback: "No channel context — cannot request Slack approval.", decided_by: "" }));
      const secret = approvalSecret();
      const port = approvalPort();
      if (!secret) return text(JSON.stringify({ approved: false, feedback: "Approvals are unavailable right now.", decided_by: "" }));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/internal/approval`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-cg-secret": secret },
          body: JSON.stringify({
            approvalType: "agent",
            channelId,
            slug,
            authorId: createdBy,
            threadKey: process.env.CG_THREAD_KEY || "",
            toolName: title || "Approval requested",
            toolInput: { details },
            approveText: approve_label || "Approve",
            denyText: deny_label || "Deny",
          }),
          signal: AbortSignal.timeout(280_000),
        });
        const data = await res.json().catch(() => ({}));
        return text(JSON.stringify({ approved: Boolean(data.allow), feedback: data.comment || data.reason || "", decided_by: data.decidedBy || "" }));
      } catch (e) {
        return text(JSON.stringify({ approved: false, feedback: `Approval request failed: ${e.message}`, decided_by: "" }));
      }
    }
  );

  // ── Progress report (any allowed user) ──────────────────────────────────────
  // The daemon renders this tool's normalized engine event in Slack. The MCP handler only
  // acknowledges the already-validated snapshot; it intentionally owns no rendering or state.
  if (process.env.CG_PROGRESS_REPORT === "1") {
    server.registerTool(
      "report_progress",
      {
        description:
          "Publish a progress-report snapshot for long work with known stages. Call this " +
          "before substantive work, then send the full authoritative snapshot at stage boundaries. " +
          "Preserve stable step IDs and order across updates, keep at most one step in_progress, and " +
          "use semantic user-facing stages rather than Read, Bash, or other internal tool calls. Mark " +
          "failed stages as error. This is distinct from the automatic tool-call trace: it communicates " +
          "the work's meaningful stages, while the daemon renders the snapshot in Slack.",
        inputSchema: progressReportInputSchema,
      },
      async () => text("Foreground Slack Plan accepted.")
    );
  }

  // ── Permission prompt (Claude's --permission-prompt-tool target) ────────────────
  // Claude calls this for any tool that isn't pre-approved (non-bypass runs). We forward the
  // request to the daemon, which posts Slack approval buttons and blocks until someone decides,
  // then return Claude's required decision JSON. Fail-safe: anything unexpected → deny.

  // Mask secret-bearing argument values (token/secret/password/api-key keys — e.g. the personal
  // set_my_*_token tools) in the COPY of the input that travels to the daemon: it gets rendered in
  // Slack approval buttons and could end up logged. The original input is still returned untouched
  // in `updatedInput` so the approved tool call runs with the real value.
  const SECRET_KEY_RE = /token|secret|password|api[-_]?key|credential/i;
  function maskSecrets(value) {
    if (Array.isArray(value)) return value.map(maskSecrets);
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEY_RE.test(k) && typeof v === "string" && v ? "(redacted)" : maskSecrets(v);
      }
      return out;
    }
    return value;
  }
  server.registerTool(
    "permission_prompt",
    {
      description:
        "Internal — Claude Code's permission-prompt target. Routes a tool-permission request to " +
        "Slack approval buttons and returns allow/deny. Not meant to be called directly.",
      // Accept whatever Claude sends (field names vary across versions); unknown keys are dropped.
      inputSchema: { tool_name: z.string().optional(), input: z.any().optional(), tool_input: z.any().optional(), tool_use_id: z.string().optional() },
    },
    async (args) => {
      const toolName = args?.tool_name || "a tool";
      const toolInput = args?.input ?? args?.tool_input ?? {};
      const decide = (allow, message) =>
        text(JSON.stringify(allow ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: message || "Denied" }));
      const secret = approvalSecret();
      const port = approvalPort();
      if (!secret) return decide(false, "Approvals are unavailable right now.");
      try {
        const res = await fetch(`http://127.0.0.1:${port}/internal/approval`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-cg-secret": secret },
          body: JSON.stringify({ channelId, slug, authorId: createdBy, threadKey: process.env.CG_THREAD_KEY || "", toolName, toolInput: maskSecrets(toolInput) }),
          signal: AbortSignal.timeout(280_000),
        });
        const data = await res.json().catch(() => ({}));
        return decide(Boolean(data.allow), data.reason || "Denied in Slack");
      } catch (e) {
        return decide(false, `Approval request failed: ${e.message}`);
      }
    }
  );
}
