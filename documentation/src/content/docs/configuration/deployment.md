---
title: Deployment configuration
description: Configure a Linux daemon, authenticated admin access, public URLs, and service startup.
---

ChannelGate's gateway is a self-hosted Linux daemon. The public website and documentation can be hosted separately on a static platform; that does not provide the gateway's container runtime, persistent storage, or engine processes.

## Host prerequisites

Follow [Installation](/docs/installation) for the complete installer. The daemon needs Node.js **22.13 or later** and a usable container CLI. Rootless Podman is the preferred runtime; the daemon probes Podman and then Docker. Build the runtime image for the installed checkout before expecting agent turns to run.

Choose the daemon's Linux account and persistent disk location before connecting your team. The optional systemd installer creates a dedicated non-login service account; it is a separate root-only operation. An interactive operator deployment and a dedicated service do not necessarily use the same home or engine login.

## Bootstrap values

The checked-in `.env.example` describes supported environment variables. Copy its structure for your deployment, keeping real credentials out of version control.

| Variable or setting | Default or purpose |
| --- | --- |
| `PORT` | `4747`, admin interface and gateway HTTP endpoints |
| `CHANNELGATE_DIR` | Overrides `~/.channelgate` runtime state |
| `CHANNELGATE_DB` | Overrides the database file within that runtime root |
| `CG_WORKSPACE_DIR` | Overrides `~/ChannelGate` workspace root |
| `ADMIN_PASSWORD` | Bootstrap authentication; a new install generates a first-boot password when unset |
| Public URL / `GATEWAY_PUBLIC_URL` | Externally reachable HTTPS address for links and inbound integrations |
| `CG_ALLOWED_HOSTS` | Additional permitted admin/API hostnames when a proxy requires them |

Saved Settings values take precedence over corresponding bootstrap environment values. Runtime-root and service identity choices belong in service/startup configuration, not a conversation's environment-secret list.

## Configure the external address

1. Start the daemon and retrieve the first-boot admin password using the installation instructions.
2. Sign in to the admin interface and configure chat credentials and engine authentication.
3. If external links or inbound webhooks are needed, place a persistent HTTPS reverse proxy or tunnel in front of the daemon.
4. Set **Settings → Connection → Public URL**, for example `https://gateway.example.com`, and save.
5. Verify the public URL and each required endpoint from outside the host.

Slack Socket Mode and Google Chat Pub/Sub pull do not require a public incoming chat webhook. Microsoft Teams needs its HTTPS messaging endpoint, displayed as `<public-url>/api/teams/messages`. Browser approval links, temporary public file links, skill webhooks, and outside clients also need a reachable public address when used.

## Save, restart, and recovery

Chat credentials can be reconnected live through the admin controls. Startup environment, listener, service identity, or filesystem relocation changes require the relevant service restart or migration procedure. Use the safe restart controls so active work can drain.

Back up the gateway configuration and persistent conversation storage before a migration. A new path or Linux account does not automatically inherit the old user's state. Consult [Storage and runtime](/docs/configuration/storage-and-runtime), [Engine authentication](/docs/configuration/engine-authentication), [Updates](/docs/features/updates), and [Backup and restore](/docs/features/backup-and-restore).
