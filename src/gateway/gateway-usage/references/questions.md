# Clarification questions

Use `gateway` → `ask_questions` when you need information from the requester and the tool is
available in this turn. It renders real Slack controls; writing button labels in a normal reply
does not create buttons. On a surface or run without this tool, ask a concise ordinary question.
Do not add questions when existing instructions or a reasonable assumption already resolve them.

## Input

Supply `title` (up to 120 characters), `questions`, and optionally `presentation` (`auto`,
`message`, or `modal`). `questions` contains 1–20 items. Each `id` must be unique, start with a
letter, and contain at most 40 letters, digits, underscores or hyphens:

- `prompt`: the question the user sees (up to 300 characters).
- `type`: `single` for one option, `multi` for several options, or `text` for a written answer.
- `options`: `{label, value}` entries for choice questions. Single choice supports up to four
  options and multiple choice up to ten, with at least one option in either case. Labels and
  values can have up to 60 characters; values must be unique within the question. Text questions
  have no options. Labels and values are your own meaningful choices;
  Yes/No is simply a single-choice question with those two options.
- `required`: defaults to `true`; use `false` only when an answer is optional.
- `allowCustom`: defaults to `true`; choice questions then also accept a custom written answer
  of up to 2,000 characters. Custom text replaces a single selection, or supplements multiple
  selections. Written text is trimmed of leading/trailing whitespace.

Example:

```json
{
  "title": "A few project decisions",
  "presentation": "auto",
  "questions": [
    {
      "id": "audience",
      "prompt": "Who should have access?",
      "type": "single",
      "options": [
        {"label": "Everyone", "value": "public"},
        {"label": "Team only", "value": "team"},
        {"label": "Invite only", "value": "invite"}
      ]
    },
    {
      "id": "features",
      "prompt": "Which features do you need?",
      "type": "multi",
      "options": [
        {"label": "Notifications", "value": "notifications"},
        {"label": "Export", "value": "export"},
        {"label": "Activity history", "value": "history"}
      ],
      "required": false
    }
  ]
}
```

## What the requester sees

`auto` puts up to four questions directly in a thread message when none is a text question.
Larger sets or sets containing text use an **Answer questions** button that opens a paged modal.
An explicit `message` (at most four questions) or `modal` chooses that presentation. Slack requires the requester's click
before a modal can open. Message cards provide choice buttons, multiple-choice controls, and a
custom-answer modal. Longer forms retain draft answers as the requester moves between pages.
Selections remain drafts until **Submit answers** (or the modal's final **Submit**).

Only the requesting user can answer. The card and any submitted summary are in the conversation,
so do not ask for passwords, tokens, or other secrets here; use the existing secret-entry flow.
The gateway validates required answers and rejects stale form revisions or already-closed controls.
Pending requests and saved drafts survive daemon restarts. Stop/clear cancels the pending request.

## Continuing work

The tool returns a pending request ID immediately; it does **not** block until the user answers.
Continue useful independent work, or end the turn with a short note that the questions are ready.
Only one request per requester/thread can be pending at a time. Do not poll, sleep waiting for
answers, post repeated copies, or interpret the pending result as an
answer. Submission queues the answers into the same author's thread so the agent can continue.
Wait for that submitted answer before doing work that depends on it. A closed modal, elapsed time,
or an unsubmitted choice supplies no answer.

This tool gathers information. It does not grant tool permissions, replace `request_approval`,
or turn channel Auto mode into human consent. Follow `references/approvals.md` for authorization.
