---
title: The Slack settings console
description: Use the reply menu to manage runtime, variables, tools, skills, automation, and session handoff.
---

Every ChannelGate reply in Slack ends with **Files · Variables · Settings**. Click **Settings**, or send `/menu` for the standalone menu without starting an agent.

A reply requested by a person binds its menu to that requester. Automation menus open for the clicker, subject to their current authorization. Historic buttons do not preserve access after it is revoked.

## Navigate the six pages

| Tab | What it contains |
| --- | --- |
| General | Channel runtime, thread pins, access, network, and available VPN controls |
| Variables | Configured environment variables and add/update/remove forms |
| MCPs | Conversation connections and admin-only Cloud MCP selection |
| Skills | Direct conversation grants, template assignment, and inherited summaries |
| Automations | Conversation schedules and eligible controls |
| Resume | Current session handoff and adoption |

Runtime dropdowns in General save as soon as selected. When opened inside a thread, the view shows both **channel defaults** and **thread selections**. Follow channel default clears that thread's engine, model, and effort pins. An existing unpinned session can keep its original engine even when the channel default changes; the console identifies this state.

## Know which controls you can change

Authorized conversation users can use the regular console controls. Access and VPN changes require a conversation manager or administrator. Selecting Admin/full access additionally requires an administrator. Cloud MCP management is admin-only. Organization skill grants must be managed at their own tier in the admin UI.

Variable and connection forms do not prefill saved secrets. A blank replacement field can preserve a saved connection token; use the explicit Disconnect action to remove it. Labels can be changed separately from credentials.

Every open, navigation, and mutation rechecks identity, membership, and authorization. An expired console should be reopened from a recent reply.

Related: [channel configuration](/docs/configuration/channel-settings), [model picker](/docs/features/model-picker), [variables](/docs/configuration/environment-variables), and [files and editor](/docs/features/files-and-editor).
