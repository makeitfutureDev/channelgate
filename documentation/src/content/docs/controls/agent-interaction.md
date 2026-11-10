---
title: Agent interaction controls
description: Reference for background work, plan approval, progress, permission prompts, and questions.
---

These gateway MCP tools use the signed current-run conversation and author context. Most act only in the current conversation; `send_agent_message` accepts a target channel. Availability depends on the toolset and origin; effective Clean turns omit the control MCP. Background work is separate from an engine's in-turn subagents. See [agent teams](/docs/features/subagents), [background work](/docs/features/background-jobs), and [interactive questions](/docs/features/interactive-questions).

## run_in_background

**Required:** `command` (string). **Optional:** `label` (string; empty by default, with the daemon supplying a display label).

```json
{
  "command": "npm run build",
  "label": "Build project"
}
```

**Scope and result:** Hands a Bash command in the current workspace to the daemon. Requires an eligible Auto conversation or an admin author in Admin mode. Auto-mode shell work requires a durable exact-command approval from a gateway administrator; an eligible admin foreground author starts directly. Returns a started-job acknowledgement or a saved pending-approval acknowledgement. On completion the daemon resumes the originating thread with outcome and output tail.

**Limits:** The launching agent must end its turn immediately, without polling. The shell command uses the conversation's resolved runtime, outside the engine's own tool-approval loop. This is separate from background-agent execution. The ordinary shell job ceiling is 60 minutes. Approval buttons survive restarts; shell jobs persist and have restart recovery.

## run_agent_in_background

**Required:** `task` (string, a complete self-contained brief). **Optional:** `label` (string; empty by default).

```json
{
  "task": "Review the import modules under src/import. Read existing files and report correctness risks with file references. Do not modify files.",
  "label": "Import review"
}
```

**Scope and result:** Starts a fresh separate Claude or Codex session in the current conversation workspace under the launching author and applicable policy. Works in every conversation mode; an administrator’s unattended agent in an Admin conversation uses the writable Auto tier, not foreground bypass. Returns a job acknowledgement. The daemon posts a completed self-contained final report directly into the original thread.

**Limits:** The agent starts without the parent conversation transcript, so task scope, inputs, and deliverable must be explicit. End the launching turn immediately. The maximum agent run is one week. Successful reports use the normal sanitized, chunked message delivery. Restarted unfinished agents are recorded as interrupted; they are not a promise of uninterrupted process survival.

## send_agent_message

**Required:** `to` (string, the `channelId` or exact name a `search_agents` result returned), `message` (string, a self-contained question or request of up to 8,000 characters).

```json
{
  "to": "C0123456789",
  "message": "What deployment steps does your channel use for the staging environment? A short ordered list is enough."
}
```

**Scope and result:** Sends a question or request to another channel's agent on behalf of the requesting person, when the user names a channel or [search_agents](/docs/controls/knowledge-and-instructions/#search_agents) finds a suitable target. A named channel can accept a message even when the directory did not list it. The call posts a confirmation card in the current thread; when the requesting person approves it, the daemon delivers the text as a new thread in the target channel, that channel's agent answers there with its own tools and permissions, and the reply is posted back into the originating thread as a new turn. Returns a sent acknowledgement (or a refusal naming the gate that failed).

**Limits:** Only an authenticated conversation member with current channel access can send; API runs and messages delivered by another agent are refused. The requester must be authorized and a current member of both the originating conversation and the target channel; the daemon checks this live. The target must be a registered, enabled channel, not a direct message. Text only; one conversation in flight per originating thread and target channel, at most three new conversations for that pair and twenty from the originating channel per hour. The sending agent ends its turn after the call instead of waiting for the reply.

## continue_agent_conversation

**Optional:** `message` (string). Omit it while answering the other agent; from an ordinary user turn, supply a nonblank message of up to 8,000 characters.

```json
{
  "message": "Please include the rollback steps too."
}
```

**Scope and result:** Continues the agent conversation associated with this thread and its original requester, without another approval card. During a turn that begins with `[agent conversation] … just said`, call with `{}` to mark the final reply for delivery to the other agent when the turn ends. Write only what that agent should read. When the other agent has delivered the final result, present it to the user without calling this tool. From an ordinary turn, `message` starts the next exchange immediately; the answer returns here as a new turn. Returns a delivery acknowledgement or a refusal.

**Limits:** Requires the authenticated original requester and current channel access; API and untrusted agent principals are refused. A message argument is refused while answering the other agent. An ordinary-turn continuation rechecks the requester's authorization and membership in both conversations, refuses an exchange at its ten-message limit, and requires activity within the last hour. End the turn after sending instead of polling for a reply.

## request_approval

**Required:** `details` (string). **Optional:** `title` (defaults to “Approval requested”), `approve_label` (defaults to “Approve”), `deny_label` (defaults to “Deny”).

```json
{
  "title": "Publish the reviewed change",
  "details": "Publish the tested documentation candidate to the production website.",
  "approve_label": "Publish",
  "deny_label": "Keep preview"
}
```

**Scope and result:** Posts a plan/action approval in the originating thread and waits for its decision. Returns text containing JSON with `approved` (boolean), `feedback` (comment or reason), and `decided_by`. Continue dependent work only after an affirmative decision, and incorporate feedback.

**Limits:** The tool call has a bounded wait of approximately 280 seconds; a failure returns approved false. This is not a clarification form. Human approval of a plan does not remove tool-specific authorization or make a failed mutation successful.

## report_progress

**Required:** `title` (trimmed nonblank string, maximum 80 characters) and `steps` (1–20 objects). Each step requires `id` (nonblank, maximum 80), `title` (nonblank, maximum 240), and `status` (`pending`, `in_progress`, `complete`, or `error`). **Optional per step:** `details` and `output` (maximum 2,000 each), `sources` (at most 10 objects, each with absolute HTTP(S) `url`, maximum 2,000, and nonblank `text`, maximum 240).

```json
{
  "title": "Review the import pipeline",
  "steps": [
    {
      "id": "inventory",
      "title": "Map source files",
      "status": "complete",
      "output": "12 modules identified"
    },
    {
      "id": "review",
      "title": "Review correctness",
      "status": "in_progress"
    },
    {
      "id": "report",
      "title": "Summarize findings",
      "status": "pending"
    }
  ]
}
```

**Scope and result:** Publishes the foreground Slack Plan snapshot. Returns “Foreground Slack Plan accepted.” The daemon renders the normalized event; the tool is advertised only when this run has the progress-report capability.

**Limits:** Step IDs must be unique; at most one step may be in progress. Send the full authoritative snapshot each time and preserve stable IDs/order. Use for substantial semantic stages, not every tool call. Unattended or reduced-tool runs do not universally have this capability.

## permission_prompt

**Optional:** `tool_name` (string; defaults to “a tool”), `input` (any value), `tool_input` (any value; fallback when `input` is absent), `tool_use_id` (string). Unknown keys are dropped by the schema.

```json
{
  "tool_name": "Bash",
  "input": {
    "command": "npm run build"
  }
}
```

**Scope and result:** Internal Claude Code permission-prompt target; normally called by the engine, not by an agent directly. Forwards a permission request to the gateway approval path. Returns Claude’s JSON decision: `{ "behavior": "allow", "updatedInput": ... }` or `{ "behavior": "deny", "message": ... }`.

**Limits:** Unexpected conditions deny safely. The approximately 280-second daemon wait is bounded. Secret-bearing argument keys are masked in the approval copy; approved updated input remains the original input. Codex headless permission behavior does not use this Claude protocol.

## ask_questions

**Required:** `title` (trimmed 1–120 characters), `questions` (1–20 objects). **Optional:** `presentation` (`auto`, `message`, `modal`; default `auto`). Each question requires `id` (starts with a letter, then letters/digits/underscore/hyphen, at most 40), `prompt` (trimmed 1–300), and `type` (`single`, `multi`, `text`). Optional fields: `options` (default `[]`, objects with trimmed `label` and `value` each 1–60), `required` (default true), and `allowCustom` (default true).

```json
{
  "title": "Choose the report scope",
  "questions": [
    {
      "id": "scope",
      "prompt": "Which period should the report cover?",
      "type": "single",
      "options": [
        {
          "label": "This week",
          "value": "week"
        },
        {
          "label": "This month",
          "value": "month"
        }
      ]
    }
  ]
}
```

**Scope and result:** Advertised only for trusted authenticated Slack foreground turns with a real Slack thread key. Saves a pending card/form for the requesting user and returns an acknowledgement, not answers. The gateway queues a continuation only after Submit.

**Limits:** Question IDs and option values must be unique in their respective scopes. Single choice supports at most 4 options, multi at most 10; text accepts no options. Message presentation supports at most 4 questions. Only one distinct pending request per requesting user/thread is admitted. Custom answer text is capped at 2,000 characters. Continue only independent work; do not infer a selected default or use this tool for permission approval.
