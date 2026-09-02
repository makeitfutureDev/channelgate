# ChannelGate Testing Plan

This document defines how ChannelGate features are converted into repeatable acceptance tests,
executed on Slack across Claude and Codex, recorded in Airtable, repaired when necessary, and
retested to completion.

The governed `channelgate-qa-testing` skill is the executable version of this procedure. The
canonical product rules remain in `AGENTS.md`; shipped behavior lives in `FEATURES.md`; repository
regression coverage lives in `TEST-PLAN.md`; and live acceptance definitions and evidence live in
the **ChannelGate QA** Airtable base.

## 1. Sources of truth

- `AGENTS.md` — engineering and security contract. `CLAUDE.md` is a symlink to it.
- `FEATURES.md` — behavior that has shipped.
- `TEST-PLAN.md` — cumulative repository and live regression plan.
- `TASKS.md` — private delivery roadmap and repair state.
- ChannelGate QA Airtable — reusable Test Cases and immutable Test Runs.
- Slack threads — authoritative live execution evidence.
- GitHub `main` — deployed code after verified landing and push.

Never declare a feature tested solely because a unit test passed or an agent said it worked. The
required evidence depends on the feature: repository tests prove code-level behavior, while live
Slack acceptance proves the deployed user experience and runtime boundaries.

## 2. Identity and data-handling rules

All ChannelGate QA Airtable reads and writes use Tiberiu's personal `composio-user` Airtable
connection, explicitly selecting **Tiberiu enterprise**. Never substitute `composio-agent`, the
management account, Apps' account, or an arbitrary default.

Testing subagents do not need Airtable access. They return structured evidence to the parent agent;
the parent writes and rereads Airtable through Tiberiu's personal connection.

Secrets are never copied into prompts, evidence, logs, Airtable, or this document. Record only safe
metadata such as presence, provider, last four characters where the product exposes them, rotation
time, and the observed success/failure class.

## 3. Standard private Slack fixtures

Use these private channels for normal engine/mode coverage:

- `cg-testing-codex-read`
- `cg-testing-codex-bash`
- `cg-testing-codex-auto`
- `cg-testing-codex-admin`
- `cg-testing-claude-read`
- `cg-testing-claude-bash`
- `cg-testing-claude-auto`
- `cg-testing-claude-admin`

Special fixtures are used only when the feature requires them: Tiberiu DM, Apps DM, Atlas, Admin
UI, Slack App Home, Run API, scheduled runs, background agent, background shell, MCP trigger,
external credentials, attachments/voice, browser/file explorer, or a disconnected transport.

Do not infer configuration from a channel name. Before each batch, read the actual engine, mode,
network policy, allowed MCPs, skills, authorized users, channel secrets, and required external
connections. Restore shared fixture state after negative or destructive tests.

Microsoft Teams and Google Chat are on hold until explicitly resumed. Do not count held platform
executions as Slack failures.

## 4. Campaign-level workflow

1. Inventory every behavior in `FEATURES.md`, `TEST-PLAN.md`, recent shipped commits, and the
   roadmap.
2. Reconcile that inventory with Airtable Test Cases.
3. Add or correct missing definitions before execution.
4. Expand each case into Claude and Codex executions whenever engine behavior can affect it.
5. Freeze the active scope and existing Test Runs so agents do not duplicate work.
6. Group independent executions into bounded, non-overlapping batches.
7. Verify fixtures, send realistic Slack prompts, and reread the exact roots until terminal.
8. Grade against the stored pass rule; never grade from tone or superficial success.
9. Write every terminal attempt to Test Runs and reread the new Airtable rows.
10. Diagnose failures, fix confirmed product defects, restart safely, and exactly retest.
11. Repeat bounded pass → fix → retest cycles.
12. Perform a final reconciliation proving every active execution is PASS or an explicitly
    documented external blocker/approved hold.

An unbounded “keep looping until green” job is not allowed. Every cycle has a defined batch, a
terminal checkpoint, and a reconciliation step.

## 5. Procedure for testing each feature

Every new or changed feature follows the procedure below in the same delivery slice.

### Step 1 — State the feature contract

Write the user-visible outcome and the boundaries that must remain true:

- Who can use it: admin, approved user, per-channel guest, unapproved user, bot, API caller.
- Where it works: channel, private channel, DM, thread, App Home, API, schedule, background job.
- Which engine can affect it: Claude, Codex, or genuinely engine-independent control plane.
- Which mode applies: Read, Bash, Auto, Admin, Clean, approved-domain network, or network off.
- Which identities apply: personal `composio-user`, shared `composio`, bot-native tool, or no
  external identity.
- What must be denied: another channel, another user, host filesystem, credential store, private
  network, unapproved domain, unavailable tool, or unauthorized setting.
- What a human should see in Slack when it succeeds or fails.

If the contract cannot be stated precisely, the feature is not ready for an acceptance test.

### Step 2 — Design the minimum complete test set

Create cases for the meaningful equivalence classes rather than every possible combination:

1. Happy path in the intended mode and identity.
2. Authorization denial for the nearest unauthorized actor.
3. Isolation/boundary denial for the nearest forbidden channel, path, network target, or identity.
4. Missing dependency or credential behavior with a human, actionable message.
5. Recovery/resume behavior if the feature persists state or spans a restart.
6. Claude and Codex variants when either engine participates.
7. Delivery/rendering behavior when the Slack surface is part of the contract.

Change one meaningful variable at a time. For example, CLI presence, CLI credentials, network
egress, and filesystem access are separate tests; one failed command cannot diagnose all four.

### Step 3 — Create or update the Airtable Test Case

Use one stable Test Case record per reusable behavior. Populate:

- **Test ID** — stable category prefix and number.
- **Group** and **Category** — filterable capability classification.
- **Engine Coverage** — Claude, Codex, or Not engine-specific.
- **Test Channels** — exact private fixture or special fixture.
- **Setup** — every prerequisite needed before the prompt is sent.
- **Action / Prompt** — realistic, human language; no artificial test jargon unless the feature
  itself is technical.
- **Expected Evidence / Pass Rule** — observable, deterministic, and sufficient to distinguish a
  pass from a plausible-sounding answer.
- **Active** and **Notes** — current applicability, holds, dependencies, and restoration details.

Do not weaken a pass rule after seeing a failure. If the product contract or the definition was
wrong, change it explicitly, record why, and rerun the corrected case.

### Step 4 — Prepare and verify the fixture

Before sending the root message:

- Confirm engine, model selection, mode, network state, MCP/skill allowlists, user authorization,
  membership, and expected channel-secret names.
- Confirm required personal/shared Composio connections without revealing tokens.
- Seed disposable files, records, URLs, lists, schedules, credentials, or external resources.
- Capture enough “before” state to restore the fixture afterward.
- Ensure the bot is mentioned correctly in a channel. A message that never triggered ChannelGate is
  a setup attempt, not a product execution.

If a prerequisite is absent, do not send a substitute prompt and call the outcome valid. Instantiate
the exact fixture or record the execution as BLOCKED at the Setup/Credential layer.

### Step 5 — Execute without duplication

- Send one fresh root per independent case unless the setup explicitly requires a follow-up.
- Preserve the stored prompt's meaning and inputs.
- Record the channel id/name, root timestamp, permalink, author, engine, model/footer, effort when
  exposed, origin, gateway, and git revision.
- When responses are slow, reread the original root. Do not resend merely because it is quiet.
- Respect Slack rate limits and the gateway's global/per-thread queues.
- Do not run concurrent cases that mutate the same fixture state.

### Step 6 — Evaluate the exact evidence

Compare the complete thread and resulting external state with the stored pass rule.

- **PASS** — every required observation is proven and no prohibited side effect occurred.
- **FAIL** — the exact setup existed and observed product behavior contradicted the contract.
- **BLOCKED** — an external prerequisite or fixture could not be provided; no product judgment is
  possible.
- **INCONCLUSIVE** — the run executed but the evidence cannot distinguish pass from fail.

Classify the narrowest proven failure layer:

- Setup
- Authorization
- Tool discovery
- Credential
- Network
- Filesystem
- Runtime
- Delivery
- Answer quality
- Product defect

“The agent said no” is not enough. Determine whether the tool was absent, permission was denied,
the credential was absent, the network was blocked, the runtime failed, or the answer was simply
incorrect.

### Step 7 — Record an immutable Test Run

Every terminal attempt—including BLOCKED and INCONCLUSIVE—gets its own linked Test Run containing:

- unique Run ID and execution date;
- gateway, revision, channel/thread, and fixture;
- author, engine, model, effort, and origin;
- actual result/evidence and Slack permalink;
- verdict and failure layer;
- diagnosis, improvement action, and retest-required state;
- link to exactly one Test Case.

After writing, reread the affected records through **Tiberiu enterprise** and verify the values and
links. Never claim writeback succeeded from the write response alone.

### Step 8 — Diagnose before editing code

A failed acceptance test is not automatically a product defect. Reproduce or inspect enough to
separate:

- stale/incorrect test definition;
- incomplete fixture;
- missing external credential;
- expected security denial;
- transient provider/rate-limit failure;
- model answer-quality variance against a valid runtime;
- confirmed ChannelGate code defect.

Only confirmed product defects authorize a repair.

### Step 9 — Repair a confirmed defect

1. Add the repair to the private roadmap before editing.
2. Create a dedicated branch and isolated worktree from current `origin/main`.
3. Add a focused regression that fails for the observed defect.
4. Implement the narrowest fix that satisfies the actual contract without weakening confinement.
5. Update `FEATURES.md`, `TEST-PLAN.md`, and applicable Airtable definitions.
6. Run focused tests, then the proportionate/full suite.
7. Commit only the repair's files.
8. Acquire the landing lock, refresh against current main, rerun tests, merge, and push `main`.
9. Safely restart the gateway when runtime code changed.

### Step 10 — Exactly retest

Rerun the same engine, channel, actor, setup, and prompt that exposed the defect. Do not replace the
failed case with an easier canary. Record the retest as a new linked Test Run and preserve the
original failed run.

When a fix applies to both engines, retest both even if only one engine first exposed it. Also run
the nearest negative/security case to prove the repair did not open a broader capability.

### Step 11 — Restore and close

- Remove disposable schedules, background jobs, records, files, grants, and credentials.
- Restore channel modes, allowlists, users, secrets, and default engine settings.
- Mark the roadmap repair complete only after the live retest passes.
- Reconcile Test Case ↔ Test Run links and report the final outcome with exact counts.

## 6. Evidence packet returned by a testing subagent

```json
{
  "test_id": "CLI-01",
  "test_case_record_id": "rec...",
  "gateway": "Xavier",
  "git_revision": "...",
  "channel": "cg-testing-codex-bash",
  "thread_url": "https://...",
  "fixture_id": "...",
  "author": "Tiberiu",
  "engine": "Codex",
  "model": "gpt-5.6-sol",
  "effort": "not exposed",
  "origin": "Foreground",
  "prompt_sent": "...",
  "actual_evidence": "...",
  "verdict": "PASS",
  "failure_layer": "None",
  "analysis": "...",
  "improvement_action": "None",
  "retest_required": false
}
```

The parent validates this packet against the live thread and stored pass rule before Airtable
writeback. A subagent must not claim Airtable was updated unless it performed and reread the write
using the authorized requester-scoped connection.

## 7. Feature completion gate

A feature is complete only when all applicable evidence exists:

- behavior is documented in `FEATURES.md`;
- repository regressions are present in `TEST-PLAN.md` and pass;
- Airtable contains complete Claude and Codex Test Cases where applicable;
- exact private channels and special fixtures are assigned;
- live Test Runs prove the happy path and material security/denial boundaries;
- confirmed defects are fixed, merged, pushed, deployed, and exactly retested;
- fixture state is restored;
- no active execution is missing, orphaned, duplicated, or supported only by indirect evidence.

The final campaign report gives exact totals by engine and verdict. Missing evidence never counts as
a pass, and a held external platform is reported separately from Slack completion.
