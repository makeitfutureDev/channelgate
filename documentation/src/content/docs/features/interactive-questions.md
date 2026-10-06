---
title: Interactive questions
description: Answer agent clarification requests with choice cards, written answers, and paged forms.
---

Interactive questions let an agent collect the decisions it needs before continuing a task. In Slack, a short set of choices appears in the thread; longer requests and written questions open a form from **Answer questions**.

## Answer a request

1. Read the request and choose an option, several options, or a written answer.
2. Use a custom answer when the provided choices do not fit.
3. Complete required questions. Longer forms preserve drafts as you move between pages.
4. Select **Submit answers**, or the final **Submit** in the form.

The submitted answers continue the same requester's thread. Selecting a choice on the message card saves a draft. Use the form’s **Next**, **Back**, or **Save answer** controls to save form changes; closing an unsaved page does not save its new fields or submit a decision. Only the requester can answer their request.

## Ask for a structured decision

For example, tell the agent:

> Before preparing the rollout, ask me which team, chat platform, and first workflow to use. Show choices where possible.

The agent can create single-choice, multiple-choice, and written questions when the tool is available. A request supports up to 20 questions. A short message can contain up to four choice questions; longer sets use a form.

## Understand the boundary

Question cards gather information. They do not grant permission to execute a tool or change a conversation's access policy. A task can need both an answer and a separate [approval](/docs/features/approvals).

Requests and draft answers survive a daemon restart. Stopping or clearing a thread cancels its pending questions; the old controls cannot continue the cancelled request. When interactive questions are unavailable on a surface or run, the agent can ask in an ordinary message.

Answers and submission summaries are visible in the conversation. Enter credentials through [Variables and secrets](/docs/configuration/environment-variables), rather than in a question form.

## Related guides

- [Steer, queue, and stop](/docs/features/collaboration-and-steering)
- [Approvals](/docs/features/approvals)
- [Threads and sessions](/docs/features/threads-and-sessions)
