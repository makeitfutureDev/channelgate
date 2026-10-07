---
title: Conversation and operator controls
description: Exact gateway control arguments for modes, work folders, Drive sync, VPN, updates, restart, and the operating guide.
---

These controls are capability-bound to the current conversation, except the explicitly gateway-wide update, restart, and operating-guide controls. Tool availability still depends on the run's verified toolset and platform.

Persistent control changes require the current authorized human decision through the gateway approval path. Auto approval of engine tools does not approve these control-plane changes. The managed updater has an explicit Auto/Admin exception; restart has an Admin exception, described below. Read-only tools do not require that extra sign-off.

## set_channel_admin_mode

**Required:** `enabled` (boolean). **Optional:** none. **Authority:** gateway admin, with control approval.

Changes the conversation's Admin tool preset for the next message. Admin authors can bypass engine permission prompts; non-admin tool restrictions and the resolved container boundary still apply. It does not change the global operator-home switch or network setting. A separately enabled home mount is a material access grant; inspect current resolved mount facts.

Example arguments:

```json
{"enabled":false}
```

## set_channel_bash

**Required:** `enabled` (boolean). **Optional:** none. **Authority:** current conversation manager or gateway admin, with control approval.

Changes the Bash/file-edit preset for the next message. Turning it off selects read-only policy only when another active mode does not enable writes. It adds no host mounts and does not enable network access.

Example arguments:

```json
{"enabled":true}
```

## set_channel_auto_mode

**Required:** `enabled` (boolean). **Optional:** none. **Authority:** current conversation manager or admin, with control approval.

Changes Auto mode for the next message. Auto enables workspace writes and auto-approves eligible engine tool prompts. Explicit control-plane decisions still require their human authority. Mounts and network policy remain separate.

Example arguments:

```json
{"enabled":true}
```

## set_channel_network

**Required:** `enabled` (boolean). **Optional:** none. **Authority:** admin, with control approval.

Changes network policy on the next request. Proxy-mode containers enforce off by permitting only engine endpoints and selected connectors. On allows public internet destinations, with no per-domain allowlist; private, loopback, and metadata destinations remain blocked. Legacy open-bridge or authorized raw-socket configurations have different enforcement and must be reported as such.

Example arguments:

```json
{"enabled":false}
```

## get_channel_vpn_status

**Arguments:** none. **Authority:** current conversation access and valid capability.

Returns safe JSON describing the already configured isolated VPN service, readiness states, and missing secret names. It never returns profile or credential contents. Off, connecting, connected, and failed are distinct outcomes.

Example arguments:

```json
{}
```

## set_channel_vpn

**Required:** `enabled` (boolean). **Optional:** none. **Authority:** current conversation manager or admin, valid capability/access, with control approval.

Enables/disables the operator-provisioned VPN service and automatic startup. It cannot provision a profile, change routes, or grant container rights. A starting result is not proof of connection; read status again. The service rechecks authorization before applying the action.

Example arguments:

```json
{"enabled":true}
```

## get_channel_workdir

**Arguments:** none. **Authority:** authorized participant.

Reports the current custom workspace or the default `~/ChannelGate/<platform>/<conversation>/` location. It does not browse its contents or mutate the folder.

Example arguments:

```json
{}
```

## set_channel_workdir

**Required:** `path` (absolute string). **Optional:** none. **Authority:** admin, with control approval.

Sets an existing directory as this conversation's workspace for the next message. The real path must lie inside the operator's allowed filesystem root; nonexistent directories, files, and paths outside that root are refused. It changes the configured folder rather than copying an old workspace into it. Container adoption can wait for active conflicting leases.

Example arguments:

```json
{"path":"/home/gateway/Code/project"}
```

## clear_channel_workdir

**Arguments:** none. **Authority:** admin, with control approval.

Clears the custom path and restores the default workspace on the next message. Existing files are not deleted or migrated by this control.

Example arguments:

```json
{}
```

## list_folders

**Optional:** `path` (absolute string). **Required:** none. **Default:** the allowed filesystem root. **Authority:** admin.

Lists subfolders and parent navigation inside that root. It is a daemon-side authorized browse, not evidence that an ordinary conversation container has all those host paths mounted. Refused paths are not retried outside the root.

Example arguments:

```json
{"path":"/home/gateway/Code"}
```

## get_channel_drive_folder

**Arguments:** none. **Authority:** authorized participant.

Reports this conversation's linked Drive folder, global enable/key readiness, and last safe sync status when the daemon is reachable. A link alone does not enable sync. Instructions, memory, secrets, and excluded files stay local.

Example arguments:

```json
{}
```

## sync_channel_drive

**Arguments:** none. **Authority:** authorized participant in this conversation.

Requests two-way sync of the already linked folder. Needs global sync enabled, service-account configuration, and the daemon service. It waits about **40 seconds** for completion; a longer pass continues in the daemon and can be checked through folder status. A busy result does not start a duplicate pass. It cannot target another conversation.

Example arguments:

```json
{}
```

## set_channel_drive_folder

**Required:** `link` (string). **Optional:** none. **Authority:** admin, with control approval.

Accepts a Drive `/folders/<id>` URL, an `?id=<id>` link, or a bare folder ID. Stores the link and runs a read-only connection test. A failed test is reported and does not turn the saved link into a verified connection. Also needs global sync enabled, the service-account key, and Editor access to that folder. First sync/resync and exclusions follow the Drive guide.

Example arguments:

```json
{"link":"https://drive.google.com/drive/folders/example-folder-id"}
```

## clear_channel_drive_folder

**Arguments:** none. **Authority:** admin, with control approval.

Unlinks the folder and disables scheduled sync for this conversation. Already synced files remain on both sides; this is not a delete operation.

Example arguments:

```json
{}
```

## update_gateway

**Arguments:** none. **Authority:** entitled Enterprise gateway admin.

Starts the managed transactional update. An admin author in Auto or Admin mode skips the extra control click; other modes require a decision. One transaction can run at once. Returns transaction status rather than a completed upgrade. The detached runner reports the final result, verifies readiness, and can roll back a failed candidate. Other editions retain the host `npm run update` workflow.

Example arguments:

```json
{}
```

## restart_gateway

**Arguments:** none. **Authority:** admin.

Queues a safe daemon restart, allowing the current turn to finish and checking ongoing engine, background, API, and update work. Default polling is **30 seconds**, for up to **five minutes**. If work remains, it cancels and reports. Admin mode skips the extra control click; Auto alone does not. End the requesting agent turn after the queued response so it can drain. This tool has no force argument.

Example arguments:

```json
{}
```

## get_gateway_guide

**Optional:** `file` (path inside the guide). **Required:** none. **Default:** list guide files. **Authority:** authorized participant.

With no file, lists built-in and overridden operating-guide files. With a file such as `references/reminders.md`, returns its current content and origin. This is the gateway-wide operating guide, distinct from a conversation's standing instructions.

Example arguments:

```json
{"file":"SKILL.md"}
```

## update_gateway_guide

**Required:** `content` (full Markdown string). **Optional:** `file` (guide-relative path). **Default file:** `SKILL.md`. **Authority:** admin, with control approval.

Replaces one override file; new reference names are allowed within the guide's supported path rules. The overlay takes effect for conversations on their next message. Use general operating guidance; organization facts belong in appropriate instructions/memory. Omitted source files still inherit shipped defaults.

Example arguments:

```json
{"file":"references/reporting.md","content":"# Reporting\n\nLink each actionable item to its source."}
```

## reset_gateway_guide

**Optional:** `file` (guide-relative path). **Required:** none. **Default:** reset all customizations. **Authority:** admin, with control approval.

Drops the named override or the entire overlay, restoring shipped defaults on next message. It does not erase channel memory or custom standing instructions.

Example arguments:

```json
{"file":"references/reporting.md"}
```

## Related guides

- [Channel settings](/docs/configuration/channel-settings)
- [Runtime lifecycle](/docs/features/runtime-lifecycle)
- [Drive sync](/docs/features/drive-sync)
- [Updates and rollback](/docs/features/updates)
- [Restart and recovery](/docs/features/restart-and-recovery)
