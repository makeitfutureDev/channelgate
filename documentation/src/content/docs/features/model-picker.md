---
title: The model and effort picker
description: Choose the scope, engine, model, and effort from the Slack wizard.
---

Use `/model` to configure a runtime from one Slack card. In a channel thread, mention the bot before the typed command:

```text
@ChannelGate /model
```

## Choose the scope

**Just this thread** writes thread selections that take precedence over channel defaults. **This channel** changes the conversation defaults; **This DM** is the equivalent in a direct message. A channel selection made inside a thread also applies to the thread you are standing in, including an explicit engine switch when needed.

Open the picker inside the relevant thread if you need a thread-only selection. The registered Slack slash-command route may lack a thread context.

## Select engine, model, and effort

The normal flow is scope → harness → model → effort. Only enabled harnesses are offered. Models and effort choices are resolved from the engine catalog, so an effort level available for one model need not exist for another.

Each selection saves immediately. **Back** navigates to an earlier step; it does not undo saved choices. Re-select a value to correct it, or choose the applicable defaults option to clear a scope's overrides. Abandoning the wizard midway retains completed selections.

A dedicated conversation Codex login fixes the harness to Codex, so that flow skips the engine choice and offers Codex models and effort.

## Keep explicit selections during recovery

An eligible Codex provider-capacity refusal after partial work can produce one bounded continuation of the existing session. A user-pinned model remains pinned; an unpinned task may use the engine catalog’s alternate recovery choice. This is separate from the cross-engine failover policy.

If a selected optional Cloud MCP cannot be admitted safely, the gateway can omit that specific selection and name the omission in the answer rather than losing the whole turn. It does not quietly relay an unsafe host credential.

## Understand engine changes

Claude and Codex sessions have different identities. An explicit switch creates an engine-appropriate session and can replay relevant Slack conversation history; it does not transfer every private tool event or internal engine state. An ordinary channel-default change outside a thread does not automatically move every existing thread.

The `/model` command's channel-change policy is configurable by an administrator. Permission to use the bot does not universally imply permission to change channel runtime through this command. The [settings console](/docs/features/slack-settings) has its own authorized-user controls and scope display.

Related: [models and effort](/docs/features/models-and-effort), [runtime defaults](/docs/configuration/model-defaults), and [dedicated Codex login](/docs/features/dedicated-codex-login).
