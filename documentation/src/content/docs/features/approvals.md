---
title: Approvals
description: Review tool requests and proposed actions using scoped decisions, native controls, or browser links.
---

Approvals let a human review work before the assistant performs it. You may see an approval when a tool exceeds the conversation's current policy, when the assistant asks you to sign off on a proposed action, or when an administrative control requires a human decision.

## Review a request

In Slack, the request appears in the task thread with its tool or action and the relevant input. Read the exact command or proposed changes, then choose the available decision:

- **Approve once** allows that request.
- **Approve for this thread** allows the matching tool scope within the thread.
- **Approve forever** persists the allowed tool scope for the conversation and is admin-only.
- **Deny** prevents the action.

Plan approvals also accept feedback/requested changes. A denial or comment returns to the assistant so it can revise the proposal. Ordinary live permission prompts time out if no decision arrives; durable background-shell approvals and instruction approvals remain available across restarts.

For example, a review-only task might inspect configuration successfully and then ask before running a command. Approving the command does not change every permission in the channel.

## Engine differences

Claude supports interactive tool permission prompts through Slack. Codex runs headlessly: denied native tool calls do not create the same interactive permission card, and Auto can use eligible automatic review. Gateway plan approvals and administrative controls retain their shared human decision flow. See [Engine capabilities](/docs/engines) for the exact engine-specific behavior.

## Browser links and Teams

Configure **Settings → Connection → Approval links** and **Public URL** to make approval confirmations reachable outside the host. The default `auto` setting enables link delivery where the surface lacks native controls, with selected Slack testing support; `always` and `off` are also available.

Links are sent privately to the requester. Opening a link shows a confirmation page and makes no decision. Pressing Confirm submits the specific action once. Used or expired links cannot decide a request again, and current authority is checked at confirmation time.

The current Teams beta supplies native approval cards alongside the shared link mechanism. Google Chat relies on links/text rather than Slack's button flow.

## Limits

An approval cannot give its recipient an admin-only capability. Auto mode affects normal tool approvals, while privileged control actions retain their own authorization. Background shell jobs in Auto still need an admin to approve their exact command; use a confined background agent for ordinary delegated work.

## Related guides

- [Permissions](/docs/features/permissions)
- [Background jobs](/docs/features/background-jobs)
- [Channel settings](/docs/configuration/channel-settings)
- [Deployment and Public URL](/docs/configuration/deployment)
