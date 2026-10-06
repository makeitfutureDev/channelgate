---
title: Usage and costs
description: Understand run accounting, token estimates, model attribution, and the admin usage views.
---

ChannelGate records engine runs, token usage, duration, and available cost evidence. Use this to understand which conversations, people, models, and automations consume resources. Provider billing and ChannelGate license message limits are separate measurements.

## Find usage

Open **Overview** in the admin website. Choose a date range, harness, and source. The default source includes gateway work and detected usage outside the gateway. Select gateway-only when investigating chat automation, or outside-only when investigating terminal/editor activity on the installation.

The overview shows token cost, run counts, tokens, models, conversations, users, and skills. Model colors remain consistent across charts. Hover or keyboard-focus a chart to inspect the bucket breakdown rather than inferring a model from the total bar height.

Open **Activity** to examine individual run records and failures. Slack replies also include a compact usage summary for the completed task.

## Interpret cost correctly

A recorded provider amount and a token-priced estimate are different. Codex does not report its own monetary cost, so its figure uses the gateway's dated rate table and token evidence. An estimate is not an invoice or an amount necessarily charged to a subscription.

Unknown models or incomplete pricing evidence remain unknown/incomplete. Older runs without a resolved model can use a configured attribution fallback for the chart, marked as assumed. This changes the displayed model band, not the recorded cost.

Subagent usage can contribute to several model bands within one run. Run totals count the run once; component-level token/cost accounting attributes work to the model that performed it.

## Example investigation

If this week's spend increased, compare runs, tokens, and model cost shares. Check the conversation breakdown, then filter Activity for the affected source and engine. A rise may come from more scheduled work, larger context, model selection, or usage outside chat—not necessarily more people messaging the bot.

Background agents and scheduled tasks use provider tokens. Plain reminders do not launch a model. License counters count admitted engine starts under their own rules, excluding memory review.

Administrators can maintain pricing and inspect external-usage evidence through the operator tools. Do not edit ledger rows merely to make a chart match an assumed provider bill.

## Related guides

- [Models and effort](/docs/features/models-and-effort)
- [Model defaults](/docs/configuration/model-defaults)
- [Schedules](/docs/features/schedules)
- [Licensing](/docs/features/licensing)

- [Pricing and usage repair](/docs/features/pricing-and-usage-repair)
- [Activity and audit](/docs/features/activity-and-audit)
