---
title: SSH and VS Code access
description: Register a public key and connect to the same conversation container through SSH, SFTP, or VS Code.
---

SSH access lets a developer work in the same container as the assistant using a terminal, SFTP, VS Code Remote-SSH, or local app-port forwarding. You do not receive an interactive account on the gateway host. The channel container stays up while a brokered session is open.

## Operator setup

The host operator first installs the SSH broker integration. It requires the host's OpenSSH server and a current ChannelGate runtime image. The SSH hostname is the address of the host's SSH service, not an HTTP-only tunnel or the admin website URL.

```sh
sudo CG_SSH_HOST=ssh.example.com CG_SSH_PORT=22 bash scripts/install-ssh-access.sh
```

See the [SSH setup reference](/docs/ssh-access) for service-account and Node-path options. Registration reports a setup remedy until the broker is available.

## Developer setup

1. Ask the assistant to register your **public** key: `add my SSH key ssh-ed25519 AAAA… me@laptop`.
2. Ask a channel manager or organization admin to grant you SSH access in the intended channel.
3. Ask `show SSH access` there and copy the returned block into your laptop's SSH configuration.
4. Connect using the alias from that block, or use its provided VS Code command.

```sh
ssh project-channel
sftp project-channel
ssh -L 3000:localhost:3000 project-channel
```

Replace the sample alias with the one actually returned. Keys are registered per person, with up to five keys; channel access and the separate SSH grant are checked when connecting.

## Working together

You and other attached developers run as the container's `agent` user. Processes and files are shared within that conversation, so coordinate edits and set your Git identity appropriately. A daemon restart drops brokered connections; reconnect afterward.

The session receives the selected engine login, conversation tools, and prepared network environment. Protected secrets remain proxy placeholders. Personal credentials pause when another person's work/session is active in the same channel; channel and organization credentials retain their scopes.

Containers with the operator-home mount are refused SSH access. External-host `-L` database forwards do not gain a route through the container; forward local app ports or use the documented raw-host/VPN path.

## Related guides

- [Shared workspaces](/docs/features/shared-workspaces)
- [Network access](/docs/features/network-access)
- [Engine authentication](/docs/configuration/engine-authentication)
- [Full SSH reference](/docs/ssh-access)
