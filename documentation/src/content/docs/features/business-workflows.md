---
title: Business workflow examples
description: Combine skills, approved accounts, and review points for repeatable team work.
---

ChannelGate can coordinate recurring work across connected services. The examples below are patterns you can build; they are not a claim that a particular CRM, inbox, meeting service, or private company skill is installed.

## Prepare a customer update

```text
Using the connected project tracker and CRM, gather this customer's open tasks and recent notes. Draft a weekly update with sources and unresolved questions for my review.
```

Grant a suitable reporting skill or create one for the procedure. Select the intended connected identities and restrict the request to the named customer. Read-only gathering can proceed with authorized access; posting or emailing the update needs an explicit intended account and authorization.

## Triage an inbox

```text
Read my work inbox through my connected account. Group messages by urgency and action, and suggest replies for approval.
```

An inbox workflow should define its account, categorization rules, what counts as an action, and which operations require review. Reading email does not itself authorize sending replies, archiving messages, or changing labels. Provider permissions and channel tool policy still apply.

## Summarize a meeting

```text
Find the transcript of our kickoff meeting in the connected service. Summarize decisions and proposed tasks, linking each conclusion to its source.
```

A skill can specify how transcripts are located and how uncertain decisions are handled. A provider connection or readable uploaded transcript is needed; ChannelGate does not provide every transcription service by default.

## Schedule a repeatable report

After the workflow works interactively, create a [schedule](/docs/features/schedules) with the inputs, destination, scope, and review expectations. A background report does not gain extra account permissions and must not guess missing identity choices.

Templates can group reporting, sales, or operational workflows; channel grants keep project-specific instructions local. Related: [skill authoring](/docs/features/skill-authoring), [accounts](/docs/features/connected-accounts), [MCP](/docs/features/mcp), and [interactive questions](/docs/features/interactive-questions).
