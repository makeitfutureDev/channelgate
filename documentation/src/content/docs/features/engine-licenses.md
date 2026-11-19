---
title: Engine licenses
description: Give Claude Code and Codex several credentials, select them per conversation, and move to the next one when a license cannot answer.
---

ChannelGate runs two harnesses: **Claude Code** and **Codex**. A harness is the CLI that executes a turn. A **license** is one credential together with the server that credential talks to. Each harness has at least one license, and an administrator can add more.

A runtime selection therefore has four parts, in this order: harness → license → model → effort. Codex EU, Qwen, Claude Extra, and a conversation's own Codex login are licenses of one of the two harnesses. They are not separate harnesses.

An engine license is not the ChannelGate product license. The product license key under **Settings → License** sets the tier and usage limits of the installation; see [license keys and limits](/docs/features/licensing). The licenses on this page are provider credentials for Claude Code and Codex.

## Know the built-in licenses

Every installation has these licenses. The harness's own sign-in is named **Default sign-in** inside a license picker.

| License | Harness | Credential and server |
| --- | --- | --- |
| Default sign-in (`claude`) | Claude Code | The gateway's Claude authentication, sent to Anthropic |
| Claude Extra (`claude-bedrock`) | Claude Code | A second Claude sign-in, or an Amazon Bedrock API key and region, set up in a terminal on the gateway host |
| Qwen (Claude Code) (`qwen`) | Claude Code | A QwenCloud API key and its Anthropic-compatible endpoint |
| Qwen EU (Claude Code) (`qwen-eu`) | Claude Code | An Alibaba Cloud Model Studio key and the workspace's EU endpoint |
| Default sign-in (`codex`) | Codex | The gateway's Codex login |
| Codex EU (`codex-eu`) | Codex | A separate ChatGPT sign-in kept in its own directory on the gateway host |
| Codex (channel account) (`codex-channel`) | Codex | One conversation's own Codex login; it exists only in the conversation that signed it in and requires Enterprise |

Claude Extra, Codex EU, and the Qwen licenses are off until an administrator switches them on. Their setup is described in [engine authentication](/docs/configuration/engine-authentication), [Qwen](/docs/features/qwen), and [a dedicated Codex login](/docs/features/dedicated-codex-login).

## Add a license

An administrator adds licenses in the admin web interface, in the engine settings under the harness they belong to. A license needs a name, a kind, and a type. There are three kinds:

| Kind | Harness | What it is | Allowed types |
| --- | --- | --- | --- |
| ChatGPT sign-in | Codex | A separate ChatGPT sign-in, kept in its own directory on the gateway host | Subscription, Business, Enterprise, Education |
| Claude sign-in | Claude Code | A separate Claude sign-in, kept in its own directory on the gateway host | Subscription, Business, Enterprise |
| API key | Claude Code | An API key for the Anthropic API or an Anthropic-compatible endpoint, run through Claude Code | API, Business, Enterprise |

The type states what the credential is: **Subscription (personal plan)**, **Business / Team plan**, **Enterprise plan**, **Education plan**, or **API (pay per token)**. A new license starts with its kind's first type unless you choose another one.

The name is required, is at most 60 characters, and must differ from every other license name, including the built-in ones. The kind cannot be changed after the license is created; the name and type can. An installation can hold up to 200 added licenses. Adding a license switches it on and registers it without a restart.

An API key license also needs:

- an endpoint that starts with `https://`;
- the key, which is write-only: afterwards the interface shows only that a key is stored and its last four characters, and a blank key field keeps the stored key when you edit the license;
- how the key is sent, as an `x-api-key` header (the default) or as a bearer token;
- the model IDs the endpoint serves, up to 40. The list may stay empty only for `api.anthropic.com`, which offers Claude's own catalog.

### Sign in

A ChatGPT sign-in license signs in from the browser with a device code, the same flow as the gateway's Codex login: start the sign-in, open the displayed link, and enter the code.

A Claude sign-in license is signed in with a command on the gateway host. The license shows the exact command with a copy control. Run it in a terminal as the gateway service user, sign in to the intended Claude plan, and exit. The browser cannot complete this sign-in.

Each sign-in license keeps its login in its own directory under the gateway's runtime root. That directory is never mounted into a conversation's container.

### Verify

A license is verified against what the provider reports, not only against what you declared.

- **Sign-in licenses.** The gateway reads the plan that the sign-in itself reports and compares it with the declared type. A match is shown as verified. A mismatch makes the license not ready, and its status names both the declared type and the reported plan: sign in with the intended plan, or correct the type. When the sign-in reports no plan, or a plan the gateway cannot map to a type, the license stays ready and its status says the type could not be verified. A license that is not signed in is not ready.
- **API key licenses.** The gateway checks the key against the endpoint when the license is added, when its key, endpoint, or key scheme changes, and when you ask for verification. It does not check on every turn. A key the endpoint rejects makes the license not ready until you correct it or verify again. Some endpoints have no model list to check a key against; such a license is saved as unverified and is confirmed by the first turn that uses it.

### Switch off or remove

Switching a license off keeps its record and its login. It disappears from every picker and is skipped as a failover candidate. A selection that still names it runs on the selection's other licenses first, then on another switched-on license of the same harness, and only then on any other switched-on license the channel admits. A switched-off conversation Codex login is refused instead of replaced. At least one license must stay switched on; the gateway refuses to switch off the last one.

Removing a license deletes its record, its default model and effort, and, for a sign-in license, its login directory. The effects on existing selections are:

- A conversation or thread that selected the removed license falls back to its defaults. A thread pin that names it no longer counts, so the thread follows its conversation; a conversation follows the gateway default.
- If it was the gateway default, the default returns to that harness's own sign-in with no further licenses.
- It is dropped from the gateway default's **If it fails, also use** list, and it is no longer a candidate in any other selection.
- A channel lock that names only the removed license stays closed. See [Lock a channel](#lock-a-channel-to-licenses-or-harnesses).

Built-in licenses cannot be removed.

## Select a harness and a license

Every place that selects a runtime uses the same steps:

1. **Harness** — Claude Code or Codex. Only harnesses with at least one usable license in this conversation are listed.
2. **License** — **Any license**, or one named license. With one named license, **If it fails, also use** optionally adds more licenses of the same harness, in the order the gateway should try them. When a license cannot answer, the turn moves to the next one.
3. **Model** — from the catalog of the selected license.
4. **Effort** — from the efforts that model supports.

A license is usable in a conversation when it is switched on in Settings, admitted by the channel's lock, and available there. **Any license** covers every usable license of the harness, including licenses added after the selection was saved. A turn starts on the harness's own sign-in when that is usable, otherwise on the first usable license.

**The license step is not shown when the harness has a single usable license in that conversation.** An installation with no added licenses and no optional licenses switched on sees only harness, model, and effort.

A selection never mixes harnesses. Summaries name it as `Codex`, `Codex · any license`, or `Codex · Work ChatGPT, then Second seat`.

| Scope | Where to select |
| --- | --- |
| Gateway default | **Settings → Agent defaults → Engine & runtime** in the admin web interface |
| One conversation | The conversation's **Runtime** settings in the admin web interface, `/model` with the channel scope, or the chat platform's settings view |
| One thread | `/model` with **Just this thread**, or the thread controls in the settings view |
| One run API call | `harness` and `licenses` in the request body |

The usual inheritance applies: a run override, then the thread, then the conversation, then the gateway default.

A `claude` or `codex` word at the start of a message selects the harness without a license step. When the conversation's default is already on that harness, the thread uses the conversation's license selection. Otherwise it uses the harness's own sign-in alone; **Any license** is never implied.

Each license has its own default model and effort in gateway settings. See [models and effort](/docs/features/models-and-effort) and [the model picker](/docs/features/model-picker).

### Select licenses for a run API call

`harness` names the license the run starts on, by ID. `licenses` is `"any"` or a list of license IDs of the same harness:

```json
{
  "channel": "C0123456789",
  "harness": "codex",
  "licenses": "any",
  "message": "Review the latest changes."
}
```

`licenses` without `harness` answers 400, as does an unknown ID or an ID from the other harness. See [the run API](/docs/features/run-api).

## Understand the failover order

A turn that fails before doing any work can be answered by another license. The failure must be one the gateway can replay safely: a usage limit, failed authentication, or a temporary provider failure after the harness's own retries, with no tool call and no streamed output.

1. **The selection's other licenses, in order.** This happens automatically, also when failover is set to ask first, and also for a pinned thread and a run API call that names `licenses`. The model and effort you picked are kept. A license is skipped when it is switched off, not admitted by the channel's lock, not available in the conversation, or cannot serve the picked model. A license that is not signed in is stepped over, and a license known to be at its limit is tried last.
2. **The other harness.** Only after every license of the selection has failed, only when the gateway's failover setting is on, and only when the other harness's own sign-in is switched on and admitted by the channel's lock. In ask-before-switching mode, the card appears at this point. A pinned thread and a run that names a harness never cross to the other harness.

The reply names each move, for example that Codex hit its usage limit and the answer comes from the named license. When nothing could answer, the error lists the licenses that were tried.

A conversation with one selected license and no **If it fails, also use** list never borrows another license of the same harness. The move to the other harness starts from a harness's own sign-in or from an added license, and it lands on the other harness's own sign-in. Codex EU, Claude Extra, the Qwen licenses, and a conversation's own Codex login are never its source or target; they take part in failover only as licenses of a selection that names them. [Automatic failover](/docs/features/multi-engine-failover) describes the setting and the ask-first mode.

## Lock a channel to licenses or harnesses

**Approved harnesses** restricts what a channel may run. Changing it requires an Enterprise product license; a saved lock stays enforced after a downgrade.

A lock holds any mix of two entry types:

- **A whole harness**, shown as `Claude Code (any license)`. It admits every license of that harness, including licenses added later.
- **One license**. It admits only that license.

The lock applies to the channel default, **If it fails, also use** candidates, thread pins, run API overrides, and cross-harness failover. A channel locked to Codex never moves to Claude Code, and the switch is not offered. A selection outside the lock is refused with a notice; it is not replaced by an approved one.

A lock saved before licenses existed that names Claude or Codex admits only that harness's default sign-in. It does not widen to licenses added later.

A lock that names only a removed license approves nothing, so the channel stays closed until an Enterprise administrator selects again. Removing one license from a longer lock leaves the remaining entries in force.

## Check the limits

- Claude sign-in licenses are signed in with a command on the gateway host, not from the browser.
- Codex licenses with an API key are not offered. An added Codex license is always a ChatGPT sign-in.
- Amazon Bedrock exists only as the built-in Claude Extra license. An added Claude sign-in license whose directory holds a Bedrock setup is not ready.
- Usage windows for a single license are shown only where the provider reports them.
- A picked model that a license cannot serve makes the gateway skip that license.
- Added licenses run cold. A Claude Code turn on an added license has no warm process and no live steering.
- A Claude sign-in license's session cannot be taken over in a container terminal, and an API key license's session cannot be taken over in any terminal. Continue such a session in chat.
- An API key license records provider cost only when its endpoint is Anthropic's. Other endpoints record tokens without a dollar amount. `/fork` is not available on an API key license.
- An added ChatGPT sign-in license does not use the Cloud MCP connections of the gateway's default Codex sign-in, and it discovers its own model catalog.

Related: [automatic failover](/docs/features/multi-engine-failover), [engine authentication](/docs/configuration/engine-authentication), [model defaults](/docs/configuration/model-defaults), [channel settings](/docs/configuration/channel-settings), and [engine capabilities](/docs/engines).
