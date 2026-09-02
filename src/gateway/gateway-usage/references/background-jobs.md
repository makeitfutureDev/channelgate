# Long-running / background jobs & agents

Your `claude -p` process **exits the moment this turn ends**. So if you background a long command
yourself (`nohup … &`, `sleep`, tailing logs), it dies with your turn and nobody sees the result.
The same applies to a background Agent/Task subagent — it lives inside your process, and a Stop
hook will mechanically refuse to end your turn while one is still running (if it blocks you, wait
for the subagent and incorporate its result). For anything meant to continue AFTER your reply,
hand the work to the **gateway daemon**, which outlives your turn and reports the result into the
launching thread. Two daemon tools cover the two shapes of work:

**Mandatory routing decision:** before starting an Agent/Task, ask whether you will stay in this
turn until it completes. If yes, an in-turn subagent is fine and you must collect its result before
answering. If no—or the intent is “start this and report back later”—call the gateway tool
`run_agent_in_background`. Never select the engine's ordinary background Agent/Task option for
work that must report after this turn; that process has no durable route back to the conversation.

## `run_in_background` — a shell command
Use for long-running commands — builds, transcription/ASR, test suites, data jobs.

- `command` — the shell command to run (bash, in this channel's working folder).
- `label` — a short human name shown in Slack.

The channel must be in **auto mode**, or in **admin mode with an admin author**. In Auto mode the
daemon posts a durable approval with the exact command, and a gateway **admin** must click **Run
it** before the unsandboxed job starts (anyone may Deny). In Admin mode, an admin author's job
starts directly without that second approval because the live turn already has the explicitly
selected sandbox-off tier. Non-admin authors never inherit that bypass. The Auto-mode approval is
single-use, remains valid across daemon/engine restarts, and starts only the displayed command.
End the turn as soon as the tool returns; no engine process needs to wait for a decision or job.
The command must fit the card in full — commands over
2000 characters are refused outright, so put long logic in a script file and run the file. If the work can run as a normal
confined agent, prefer `run_agent_in_background` — it needs no approval. If refused on the mode
gate, ask an admin to enable auto mode (`references/administration.md`), or run it inline if it's
actually short.

**Deploy CLIs (Vercel, Supabase, Make.com API): try the sandbox FIRST.** When the gateway admin has
enabled a CLI integration (admin UI → Settings → Network → CLI integrations), that CLI's domains
are on the network allow-list and its saved login is readable, so `vercel deploy`,
`supabase functions deploy`, etc. run as a NORMAL sandboxed command in this folder — no unsandboxed
shell job, no approval click. Run them in the working folder (use the project's ignore file, e.g.
`.vercelignore`, instead of staging a copy elsewhere). Only if the command fails on a network or
credential-read denial should you escalate — in this order: for a BLOCKED DOMAIN, call the gateway
tool `request_network_domain` with the exact domain from the error (any authorized user's Approve
click adds it to this channel's allow-list; effective on the NEXT message, so finish the turn and
retry then); for a known deploy CLI, ask an admin to enable that CLI integration; only as a last
resort use `run_in_background` with its unsandboxed-shell approval.

Never restart the gateway with a background `launchctl`, `systemctl`, `kill`, or shell command.
Use `restart_gateway` instead: it checks all ongoing gateway work, waits and rechecks before
shutdown, and cancels rather than interrupting work that remains active.

## `run_agent_in_background` — a delegated agent task
Use when the delegated work needs an AGENT, not a command — long research, a big analysis, a
multi-step side quest. The daemon runs a separate engine session (Claude or Codex, same channel
folder and lockdown) on your task and posts the agent's self-contained final report directly into
this thread when it finishes. No second parent-model turn is required.

- `task` — a complete, self-contained brief. The agent starts with NO context from this
  conversation, so include everything it needs (goal, inputs, file paths, expected output).
- `label` — a short human name shown in Slack.

Works in **every channel mode** — the agent obeys the channel's own permissions exactly like a
normal turn (its permission prompts surface as approval buttons in this thread). Mode mapping for
unattended runs (background agents, their continuations, schedules): **auto** channels run
writable with prompts auto-approved; **admin** channels give an ADMIN author's unattended runs
that same auto tier (writable + auto-approved — but always sandboxed, never the admin turn's
sandbox-off); other modes keep their normal floor. Consequence: an unattended run can NEVER read
files outside its sandbox view (e.g. credentials elsewhere in the home directory) — if the task
needs one, have the admin read/copy it in a live admin-mode turn FIRST and hand the agent a path
inside the working folder, or design the task to not need it. Background agents may run up to **one week**;
they are never killed for being slow or quiet, only at that ceiling. For a longer pipeline, chain
batches: each agent processes a bounded chunk and the continuation launches the next.

## Critical protocol (both tools)
After calling either tool, **STOP and end your turn**. Do NOT poll, sleep, tail, or wait. The
daemon owns the job: it posts a "started" note with a *Check status* button in the thread, and
when the work finishes the daemon reports it in THIS thread. Shell jobs re-invoke your session with
a plain-language outcome + output tail so you can continue; successful background agents post their
self-contained report directly through the normal sanitized/chunked reply pipeline. Failed or
incomplete agents use a continuation for diagnosis. Raw process numbers are diagnostic metadata,
never the explanation shown to users.

## Pattern
1. Call the tool with the command/task + a label.
2. Post a one-line "started X, I'll report back when it's done" (optional) and **end your turn**.
3. The daemon posts the agent report directly, or re-invokes you for shell/failed-agent follow-up.
