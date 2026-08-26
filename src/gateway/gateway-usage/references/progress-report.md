# Long-work orchestration and progress report

`gateway` → `report_progress` shows the user a compact live plan for substantial work. Native
subagent rows show what each worker is doing; the semantic plan explains the larger effort,
ownership, evidence coverage, measurable progress, and reconciliation. Use both surfaces together
for qualifying foreground work.

## When delegation is mandatory

Treat the work as qualifying long/high-volume knowledge work when **any** of these is true:

- it is a long analysis, research, audit, review, investigation, evidence-validation, or
  reconciliation task likely to take many minutes;
- it must inspect or process **100+ files, rows, accounts, documents, records, or other independent
  items**;
- it naturally separates into multiple evidence sources or batches; or
- accuracy warrants an independent second pass before the result can be accepted.

Qualifying work is not a solo turn. Before substantive work, split it into bounded, non-overlapping
scopes and dispatch one or more in-turn Agent/Task subagents. Run independent scopes in parallel.
For high-consequence validation or ambiguous evidence, use an independent verifier and reconcile the
two results; do not let the primary worker certify itself. Keep dependent stages sequential, and
never have multiple agents edit the same file or output range concurrently.

If the subagent interface is unavailable, do not pretend delegation happened. State the constraint
in the plan/final result and use a bounded serial fallback only when there is no supported delegated
path. If the work should continue **after the current reply**, use the daemon-owned
`run_agent_in_background` instead and follow `references/background-jobs.md`; an in-turn subagent
cannot outlive its parent turn.

## When a live Plan exists

Only when `report_progress` is actually available in the current foreground chat turn may a
live Plan be claimed. It is intentionally unavailable for clean, daemon-owned background-agent/job,
scheduled, recovery, and headless contexts; those runs must not claim a live Plan. Visible, non-recovery
chat-backed API runs are eligible only when the tool is present.

When available, a semantic plan is required for qualifying long/high-volume work. For other work,
use it only when the specific/domain skill defines 3+ meaningful stages and the work is long or
substantive enough that stage visibility materially helps. Routine or short work never qualifies,
even if it can be decomposed into 3+ steps. Never invent filler stages merely to make a plan.

## Show the execution roster in the plan

The specific/domain skill defines the semantic stages. Stage names describe user-recognizable
outcomes; the roster below describes who owns them.

Before launching workers, publish the complete plan. Put the following compact roster in each
delegated stage's `details`:

- **agent/role** — a stable user-facing name such as `primary-validator` or `invoice-researcher`;
- **model** — the model actually selected or resolved for that agent;
- **effort** — the actual reasoning/effort setting;
- **scope** — exact batch, source, file range, or responsibility; and
- **progress** — a measurable `completed/total` counter when a total is knowable.

If the spawn interface cannot independently select model or effort, write `inherits parent`. If the
runtime does not expose the resolved value, write `not exposed`. Never infer a model from a product
name, copy the parent's value as though it were observed, or claim `high` effort merely because the
task is difficult. When a model or effort choice **is** supported, select it intentionally before
dispatch and report that actual choice.

The semantic stage should still name an outcome the user recognizes, such as “Validate every
subscription row”; do not turn `Read`, `Bash`, internal API calls, or subagent tool calls into plan
stages. Slack renders the stages inside the answer's same expandable toolbox as automatic tool and
subagent history; it does not post a separate Plan message. The shimmering assistant status remains temporary and
shows only what is happening right now.

## Track progress continuously and measurably

Call `report_progress` before substantive work starts, then resend the **whole authoritative
snapshot** at real stage boundaries and these additional high-volume checkpoints:

- every completed batch or returned subagent result;
- any disagreement, evidence gap, retry, or error that changes the outcome; and
- during a long batch, roughly every five minutes when a new meaningful counter is available.

Ask long-running subagents to return or message checkpoint counts when their interface supports it.
Show exact evidence coverage such as `343/1,750 rows`, `batches 008–009 active`, `37/100 files`, and
`1 disagreement awaiting reconciliation`; do not use a vague “still working” when a count exists.
Continuous tracking does not mean one update per item: batch updates should be frequent enough to
show movement without flooding Slack. The gateway heartbeat and native subagent rows provide
liveness between meaningful semantic snapshots.

Preserve stable step IDs and order throughout the run; change statuses and concise context,
not the plan's identity. At most one semantic stage may be `in_progress`, even when that stage owns
multiple parallel subagents. Mark completed work with `complete` and known failures with `error`
truthfully. A failed stage should not remain active or appear successful. `details`, `output`, and
`sources` are optional; use them only when they add concise user value. Send a final snapshot before
the final answer so the plan reflects the actual outcome. Unexpected interruptions are handled by
the gateway, but the agent should mark known failures itself.

## Consolidated-subscription validation example

Before processing begins, publish the complete roster and scopes:

```json
{
  "title": "Final verification of consolidated subscriptions",
  "steps": [
    {
      "id": "freeze-evidence",
      "title": "Freeze and normalize source evidence",
      "status": "complete",
      "output": "1,750 rows across 1,326 accounts; 37 completed import batches"
    },
    {
      "id": "dual-validation",
      "title": "Validate every subscription row",
      "status": "in_progress",
      "details": "Agents: primary-validator — gpt-5.6-sol — high — batches 001–019; independent-validator — gpt-5.6-sol — high — same evidence, isolated pass. Progress: primary 0/1,750; independent 0/1,750; disagreements 0."
    },
    {
      "id": "reconcile-reviews",
      "title": "Reconcile both reviews",
      "status": "pending",
      "details": "Agent: reconciler — inherits parent — effort inherits parent — disagreement rows only"
    },
    {
      "id": "write-verified-columns",
      "title": "Update and verify final AI columns",
      "status": "pending",
      "details": "Agent: writeback-checker — inherits parent — effort inherits parent — write only approved status/comment columns, then read back"
    }
  ]
}
```

When batches return, keep the same active stage and refresh exact counters:

```json
{
  "title": "Final verification of consolidated subscriptions",
  "steps": [
    {
      "id": "freeze-evidence",
      "title": "Freeze and normalize source evidence",
      "status": "complete",
      "output": "1,750 rows across 1,326 accounts; 37 completed import batches"
    },
    {
      "id": "dual-validation",
      "title": "Validate every subscription row",
      "status": "in_progress",
      "details": "Agents: primary-validator — gpt-5.6-sol — high; independent-validator — gpt-5.6-sol — high. Progress: primary 343/1,750 (batches 008–009 active); independent 100/1,750; disagreements 1 awaiting reconciliation."
    },
    {
      "id": "reconcile-reviews",
      "title": "Reconcile both reviews",
      "status": "pending",
      "details": "Agent: reconciler — inherits parent — effort inherits parent — disagreement rows only"
    },
    {
      "id": "write-verified-columns",
      "title": "Update and verify final AI columns",
      "status": "pending",
      "details": "Agent: writeback-checker — inherits parent — effort inherits parent — approved rows only"
    }
  ]
}
```

After reconciliation and read-back finish, send the terminal snapshot before the final answer:

```json
{
  "title": "Final verification of consolidated subscriptions",
  "steps": [
    {
      "id": "freeze-evidence",
      "title": "Freeze and normalize source evidence",
      "status": "complete",
      "output": "1,750 rows across 1,326 accounts; 37 completed import batches"
    },
    {
      "id": "dual-validation",
      "title": "Validate every subscription row",
      "status": "complete",
      "output": "Primary 1,750/1,750; independent 1,750/1,750; 6 disagreements routed to reconciliation"
    },
    {
      "id": "reconcile-reviews",
      "title": "Reconcile both reviews",
      "status": "complete",
      "output": "6/6 disagreements resolved against source evidence"
    },
    {
      "id": "write-verified-columns",
      "title": "Update and verify final AI columns",
      "status": "complete",
      "output": "1,750/1,750 final statuses/comments written and read back"
    }
  ]
}
```

Keep normal Slack replies concise; the live plan carries the stage-by-stage detail.
