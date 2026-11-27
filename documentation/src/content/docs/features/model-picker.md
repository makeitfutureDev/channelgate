---
title: The model and effort picker
description: Choose the scope, harness, license, model, and effort from the Slack wizard.
---

Use `/model` to configure a runtime from one Slack card. In a channel thread, mention the bot before the typed command:

```text
@ChannelGate /model
```

## Choose the scope

**Just this thread** writes thread selections that take precedence over channel defaults. **This channel** changes the conversation defaults; **This DM** is the equivalent in a direct message. A channel selection made inside a thread also applies to the thread you are standing in, including an explicit harness or license switch when needed.

Open the picker inside the relevant thread if you need a thread-only selection. The registered Slack slash-command route may lack a thread context.

## Select harness, license, model, and effort

The normal flow is scope → harness → license → model → effort.

- **Harness** lists Claude Code and Codex. A harness is offered only when it has at least one usable license in this conversation.
- **License** offers **Any license** and each license of the harness. The harness's own sign-in is listed as **Default sign-in**; other licenses are listed by name.
- **If it fails, also use** appears when you select one named license and the harness has others. It is optional and takes several licenses. When a license cannot answer, the turn moves to the next one.
- **Model** and **Effort** are resolved from the catalog of the selected license, so an effort level available for one model need not exist for another.

The license step is not shown when the harness has a single usable license in the conversation; the wizard then goes from harness to model. A license is usable when it is switched on in gateway settings, admitted by the channel's **Approved harnesses** lock, and available in the conversation. [Engine licenses](/docs/features/engine-licenses) describes licenses, **Any license**, and the failover order.

Each selection saves immediately. **Back** navigates to an earlier step; it does not undo saved choices. Re-select a value to correct it, or choose the applicable defaults option to clear a scope's overrides. Abandoning the wizard midway retains completed selections.

A conversation's own Codex login appears in that conversation as the Codex license **Codex (channel account)**. It is not offered in any other conversation.

## Select with a mention shortcut

For a configured model shortcut, append an optional effort to select both in one message:

```text
@ChannelGate :sol :high Review this change
@ChannelGate :sonet :low
```

Both choices persist for the current thread. A message with only the selectors confirms the
change without starting an agent turn. Effort choices come from the selected model's catalog;
an unsupported effort is refused without changing the thread. Omitting effort clears the old
thread effort selection. The same suffix works in `/fork :sol :high <new message>` for the child
thread, preserving the source thread's settings.

## Keep explicit selections during recovery

An eligible Codex provider-capacity refusal after partial work can produce one bounded continuation of the existing session. A user-pinned model remains pinned; an unpinned task may use the catalog’s alternate recovery choice. This is separate from failover between licenses and harnesses.

If a selected optional Cloud MCP cannot be admitted safely, the gateway can omit that specific selection and name the omission in the answer rather than losing the whole turn. It does not quietly relay an unsafe host credential.

## Understand harness and license changes

Claude Code and Codex sessions have different identities, and a sign-in license keeps its sessions in its own directory. An explicit switch creates a session appropriate to the new selection and can replay relevant Slack conversation history; it does not transfer every private tool event or internal state. An ordinary channel-default change outside a thread does not automatically move every existing thread.

The `/model` command's channel-change policy is configurable by an administrator. Permission to use the bot does not universally imply permission to change channel runtime through this command. The [settings console](/docs/features/slack-settings) has its own authorized-user controls and scope display.

Related: [engine licenses](/docs/features/engine-licenses), [models and effort](/docs/features/models-and-effort), [runtime defaults](/docs/configuration/model-defaults), and [dedicated Codex login](/docs/features/dedicated-codex-login).
