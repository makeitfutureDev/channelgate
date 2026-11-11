---
title: Account and secret controls
description: Seventeen controls for connected accounts, email, and scoped environment credentials.
---

Credential tools change saved account or environment state. Prefer the private UI fields so secrets never enter chat history. No tool on this page reveals a stored secret value. Process environment availability and connected-account identity are separate concepts.

## set_my_composio_token

Save the requester’s personal Composio consumer key.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `token` | Yes | Token text; trimmed value must have at least six characters. |

**Authority and scope:** Verified trusted person; affects only their Composio user identity.

**Result:** Saved confirmation without token echo.

**Restrictions:** Prefer private credential forms. If this chat tool is used, send the credential in a DM and delete the source message immediately; the tool cannot erase Slack history. API attribution is not a verified personal principal.

## clear_my_composio_token

Remove the requester’s personal Composio key.

**Arguments:** none.

**Authority and scope:** Verified trusted person, personal scope.

**Result:** Removal confirmation.

**Restrictions:** Also revokes active daemon remote-MCP author relays so a removed token stops working; shared credentials remain unchanged.

## set_my_toolbox_token

Save the requester’s personal Toolbox bearer token.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `token` | Yes | Trimmed token of at least six characters. |

**Authority and scope:** Verified trusted person; personal Toolbox credential.

**Result:** Saved confirmation without token echo.

**Restrictions:** Use a DM and delete its source message if this chat path is used. The connected server determines account permissions.

## clear_my_toolbox_token

Remove the requester’s personal Toolbox credential.

**Arguments:** none.

**Authority and scope:** Verified trusted person, personal scope.

**Result:** Removal confirmation.

**Restrictions:** Revokes the author’s active remote-MCP relay registrations; conversation/organization fallback credentials are independent.

## list_secrets

List configured environment secret metadata without values.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `scope` | No | `all` (default), `organization`, `personal`, `conversation`; aliases `org`, `my`, `channel`. |

**Authority and scope:** Admitted current conversation; personal details require a verified author, organization masked tails/setter details require admin.

**Result:** Names, providers, protection/exposure/host state, resolvability and authorized masked metadata by scope.

**Restrictions:** Never returns raw values. Effective precedence is conversation over personal over organization. Listings are live; an already-running process retains its start environment. Strict runtime guard can withhold readable/unprotected secrets.

## set_secret

Write a personal or organization environment secret.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `name` | Yes | Environment-variable name; validated and normalized by storage. |
| `value` | Yes | Secret value; never returned. |
| `scope` | No | `personal` (default), `organization`; aliases `my`, `org`. |
| `hosts` | No | Up to 16 declared destination patterns; omitted preserves existing rule choice. |
| `mode` | No | `auto`, `hidden`, `readable`; new entries default auto, omitted on updates preserves choice. |
| `headers` | No | Up to 8 supported credential header names; optional. |
| `format` | No | `bearer`, `raw`, `basic-password`, `basic-user`; optional credential-format rule. |

**Authority and scope:** Verified self for personal; administrator for organization, subject to scope-dependent approval policy.

**Result:** Saved name and protection state, without value.

**Restrictions:** Conversation values use its Variables/Secrets form or admin UI. Never paste into a shared channel. Built-in and declared HTTPS rules determine placeholder use; broad multi-tenant destination suffixes are refused. Delete a chat credential source message after saving.

## remove_secret

Remove an environment secret entry.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `name` | Yes | Variable name. |
| `scope` | No | `personal` (default), `organization`; aliases `my`, `org`. |

**Authority and scope:** Verified self for personal; administrator for organization; scope-dependent approval applies.

**Result:** Removed-name confirmation.

**Restrictions:** Conversation entries are managed through their private form. Other scopes remain; in-flight processes retain their existing environment.

## set_secret_mode

Change hidden/readable exposure without changing its value.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `name` | Yes | Existing secret name. |
| `mode` | Yes | `hidden`, `readable`, or `auto`. |
| `scope` | No | `personal` (default), `organization`, `conversation`; aliases `my`, `org`, `channel`. |

**Authority and scope:** Verified self for personal; administrator for organization; conversation manager/admin for conversation. For personal `readable`, the control-plane gate also requires an administrator; personal hidden/auto stays the owner’s call.

**Result:** Resolved exposure and destination metadata; next-process effect.

**Restrictions:** Hidden requests carry placeholders; readable is for non-HTTPS use, subject to the strict runtime guard. Declared/known destination rules and automatic non-HTTPS recognition still apply. Existing process env is unchanged.

## allow_secret_host

Approve an exact host for a hidden secret awaiting destination approval.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `name` | Yes | Existing secret name. |
| `host` | Yes | One hostname, no wildcard. |
| `scope` | No | `personal` (default), `organization`, `conversation`; aliases `my`, `org`, `channel`. |

**Authority and scope:** Organization administrator acting from the conversation chat; scope access is checked too.

**Result:** Approved-host confirmation or note that known/declared rules still govern this entry.

**Restrictions:** Model API hosts are refused. Does not enable arbitrary network access or override known destination restrictions. Useful when a background job/SSH request posted no approval card.

## Email account tools

An email account is a mailbox's IMAP and SMTP settings entered once on one form — in the admin UI (a conversation's Connections, or a person under Users), in Slack's ⚙️ Settings (the **MCP** page for the conversation's account, the **You** page for your own), in Teams' Settings → MCPs, or through Google Chat's private settings form. Both logins are tested before the account is stored, passwords are write-only, and the mail clients run in the gateway. There is no tool that connects an account: a password typed into chat would stay in the conversation's history.

| Tool | Purpose |
| --- | --- |
| `list_email_accounts` | The accounts this turn may use: the conversation's (`channel/<name>`) and the requester's own (`personal/<name>`), with address and whether sending is enabled. |
| `email_mailboxes` | Folders and their roles. |
| `email_search` | Newest-first listing with `query`, `from`, `to`, `subject`, `since`, `before`, `unseen`, `flagged` and `limit` (≤ 50). |
| `email_read` | One message by uid: headers, text body (HTML converted), attachments with part ids. |
| `email_download_attachment` | Saves one attachment under `uploads/email/<account>/` in the working folder (≤ 50 MB). |
| `email_move` / `email_set_flag` | File a message elsewhere; mark seen, unseen, flagged, unflagged or answered. |
| `email_send` | Send as the account, with attachments from the working folder (10 files, 25 MB total) and `in_reply_to` threading; a copy goes to the Sent folder when the server has one. |

**Authority and scope:** channel accounts are usable by anyone authorized in the conversation; personal accounts exist only in runs their owner authored — never in another person's turn, a scheduled run or an HTTP run-API turn. `account` takes a name, `personal/<name>`, `channel/<name>` or the address, and a bare name present in both scopes is refused until qualified.

**Restrictions:** sending is refused on an account whose *allow sending* is off. Replies, streams and job output are redacted of every stored password.

## list_email_accounts

**Arguments:** none.

**Scope and result:** Lists available channel and verified requester's personal accounts, their names, addresses, scopes, mail servers and whether sending is enabled. Never returns passwords. Connect accounts through the private settings forms described above.

**Limits:** Personal results in a shared channel are visible to that thread's audience; explain this before reading personal mail. HTTP run-API attribution does not grant access to personal accounts.

## email_mailboxes

**Optional:** `account` (account selector described above; optional only when exactly one account is available).

**Scope and result:** Lists selectable folders and their special roles for the chosen account.

## email_search

**Optional:** `account`, `mailbox` (defaults to `INBOX`), `query`, `from`, `to`, `subject`, `since` (inclusive ISO date), `before` (exclusive ISO date), `unseen`, `flagged`, and `limit` (integer 1–50; default 20).

**Scope and result:** Returns matching message UIDs, dates, senders, subjects, unread/flag marks and attachment counts, newest first. Filters combine with AND; omit filters to list recent messages. Use the UID with the same account and mailbox in subsequent controls.

## email_read

**Required:** `uid` (positive integer from search). **Optional:** `account`, `mailbox` (default `INBOX`), `max_chars` (integer 500–100,000; default 20,000).

**Scope and result:** Returns headers, text body (plain text preferred, HTML converted), and attachment part IDs. Reports truncated bodies; raw body reads are bounded to 2 MiB.

## email_download_attachment

**Required:** `uid` (positive integer), `part` (part ID from `email_read`, such as `2` or `1.2`). **Optional:** `account`, `mailbox` (default `INBOX`).

**Scope and result:** Saves one attachment under `uploads/email/<account>/` in the current working folder and returns its relative path, size and content type.

**Limits:** 50 MiB per attachment; confined no-follow writes. Read the returned file or share it through the current conversation's file tool.

## email_move

**Required:** `uid` (positive integer), `to` (destination mailbox path from `email_mailboxes`). **Optional:** `account`, `mailbox` (source; default `INBOX`).

**Scope and result:** Moves the message, returning source, destination and the new UID when the server provides one. Use for archiving, trash or filing only within the selected account.

## email_set_flag

**Required:** `uid` (positive integer), `flag` (`seen`, `unseen`, `flagged`, `unflagged`, `answered`). **Optional:** `account`, `mailbox` (default `INBOX`).

**Scope and result:** Changes the selected message's flag and returns a confirmation identifying account, mailbox and UID.

## email_send

**Required:** `to` (nonempty array of recipient strings), `subject`, `text` (plain-text body). **Optional:** `account`, `cc`, `bcc` (recipient arrays), `html` (HTML alternative), `attachments` (up to 10 working-folder-relative paths), `in_reply_to` (original Message-ID for threading), `reply_to` (Reply-To header).

**Scope and result:** Sends from the connected account's address, returns accepted and rejected recipients and Message-ID when available, and reports whether a Sent copy was saved. Names such as `Name <person@example.com>` are accepted as recipient strings.

**Limits:** Sending must be enabled for the selected account. Attachments must be confined to the working folder and total at most 25 MiB. Confirm recipients and content unless the user already supplied them; personal accounts send as that person. A Sent copy depends on the server exposing a Sent mailbox.

## Related guides

[Accounts](/docs/features/connected-accounts), [environment configuration](/docs/configuration/environment-variables), [secrets](/docs/features/secrets), [Composio SDK](/docs/features/composio-sdk), and [Toolbox/Make](/docs/features/toolbox-and-make).

## create_api_token

**Required:** `name` (string label).

**Scope and result:** Creates a personal HTTP run API token bound to this conversation. Runs act as the token owner with their current role, conversation authorization, and personal connections. Returns the token value once with an example request; subsequent listings never reveal it. Runs appear as threads in this conversation.

**Restrictions:** Requires a trusted human requester. The token stops working when revoked or when its owner loses access. Store the returned value securely.

## list_api_tokens

**Inputs:** None.

**Scope and result:** Lists this requester's HTTP run API tokens in the current conversation. A channel manager or administrator can list all tokens here. Returns IDs, labels, status, and last four characters, never token values. Requires a trusted human requester.

## revoke_api_token

**Required:** `id` (integer token ID from `list_api_tokens`).

**Scope and result:** Revokes a token in the current conversation. Its next API request is refused with HTTP 401. Repeated revocation reports that it is already revoked.

**Restrictions:** Requires a trusted human requester who owns the token, manages this channel, or is an administrator. Cannot revoke a token belonging to another conversation.
