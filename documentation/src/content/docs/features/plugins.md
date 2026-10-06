---
title: Plugin packages
description: Manage approved engine plugins through the skill catalog.
---

Plugins package skills together with engine components such as commands, agents, hooks, or MCP servers. ChannelGate imports them through the same source, review, revision, and grant controls used for skills.

## Import and grant a package

An administrator adds the plugin repository under **Skills → Sources**. Claude or Codex plugin manifests identify a package. The catalog shows a **Plugin** badge and a component summary. The complete package becomes one catalog revision rather than many unrelated nested skills.

Review and approve the source revision, then grant the package to the intended conversation or template. A personal grant stays scoped to its author. For a documentation workflow, for example, grant the reviewed plugin containing your writing skills, then ask the agent to use its named workflow in the next request.

## Match the package to the engine

Claude supports native plugin skills, commands, agents, and eligible hooks. Hooks require an authorized live administrator turn in Admin/Full-access mode; unattended and non-admin turns cannot activate them.

Codex receives an explicit catalog of approved plugin skills and supported MCP definitions. Native plugin commands, agents, and hooks are refused when unsupported. Having a Codex manifest is not a promise that every declared component can run through ChannelGate.

Apps, language-server components, and engine-settings overrides are currently unsupported at runtime. Incompatible packages fail with a specific error rather than silently loading only part of the package.

## Configure tools separately

Plugin MCP servers use explicitly granted, namespaced definitions. Stdio commands need Worker or Admin permissions. A plugin's source credentials and arbitrary authentication declarations do not become live connections: configure and select a supported connection separately.

Updating a package changes the runtime snapshot. Revoking it removes future skills and MCP definitions, but cannot erase text already read into an existing session. Use a fresh thread when you need clean context after removing a package. Lean supplies no optional plugin grants.

Related: [skills](/docs/features/skills), [MCP integrations](/docs/features/mcp), [skill sources](/docs/configuration/skill-sources), and the [plugin compatibility reference](/docs/skills#plugin-packages-in-the-same-library).
