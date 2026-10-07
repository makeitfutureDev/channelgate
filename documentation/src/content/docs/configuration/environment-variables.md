---
title: Environment variables and secrets
description: Add scoped credentials, set approved destinations, and understand write-only secret storage.
---

Use environment variables for project API tokens and CLI credentials. Store them in ChannelGate's secret controls instead of placing them in chat, instructions, or a committed `.env` file. Secret storage is write-only: a saved value cannot be read back from the secret listing, even by an administrator.

## Choose the scope

| Scope | Where to configure | Precedence for the same name |
| --- | --- | --- |
| Conversation | **Conversations → Environment** or Slack **Secrets** | Overrides personal and organization values here |
| Organization | **Settings → Integrations → Environment variables** | Base value across conversations unless overridden |
| Personal | The person's secret controls | Overrides organization values on this person's runs |

The effective order is **conversation → personal → organization**. A personal token of the same name overrides the organization value on its owner's runs, but does not replace an existing conversation token. Variables are supplied when a run starts; they are not a project configuration file.

## Add a token

1. Choose the narrowest scope that meets the task.
2. Add an uppercase variable name such as `PROJECT_API_TOKEN` and paste only its value.
3. Set **Used on hosts** to the service destinations that need it, for example `api.example.com`.
4. Save through the secret control, then inspect the name, scope, and protection status.
5. Test an authorized request without printing the token or dumping the environment.

A suitable agent request is:

```text
Use PROJECT_API_TOKEN to read the project status from api.example.com.
Do not print the credential. Report the request result.
```

Names are normalized to uppercase and must start with a letter, using letters, digits, and underscores, up to 64 characters. Interpreter, engine, gateway, proxy, and other reserved names are refused. Each secret collection allows up to 32 entries; a value is limited to 16,384 bytes and cannot contain a line break or NUL.

## Hidden and readable values

With the default egress proxy, protected values are replaced by placeholders inside the container and swapped into authorized HTTPS request headers or query parameters at declared destinations. A placeholder is not useful as a database password or signing key inside a request body.

For an undeclared destination, a hidden secret can trigger an administrator host-approval request. An authorized secret owner or manager can choose readable exposure when a workflow needs the raw value. **Withhold readable variables** still withholds those readable values in proxy mode when enabled; new installations enable this guard. An administrator must review that deployment setting before relying on raw-variable injection.

Personal protected credentials are additionally gated by their owner's live activity. A concurrent turn, background job, or SSH session from another person can pause their use.

## Rotate or revoke

Save a replacement value under the same name to rotate it, or remove the entry to revoke future use. These changes apply to subsequent runs and live proxy resolution; do not expect an already running process's environment to be rewritten. Issue a new token at the provider if the original value is lost.

See [Secrets](/docs/features/secrets), [Network access](/docs/features/network-access), and [Engine authentication](/docs/configuration/engine-authentication).
