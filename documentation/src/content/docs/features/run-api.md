---
title: HTTP run API
description: Trigger asynchronous agent work from Make.com, scripts, or other automations and retrieve its result.
---

The HTTP run API starts agent work without an incoming chat message. Use it from Make.com, an internal service, or an operator script. It returns a job ID immediately; you can poll for the result or provide a completion webhook.

## Configure authentication

In the conversation where runs should appear, ask the agent to create an API token. You can also create one in the Activity dashboard under **Settings → API tokens**. Copy it into your automation’s credential store when it is shown. The admin **API** page lists tokens and request examples.

Send the token in either the `X-API-Key` or `Authorization: Bearer` header. Runs use the token owner’s current permissions in that conversation. If a deprecated organization-wide key exists, admins can find it under **API**.

## Start and inspect a run

```sh
curl 'https://gateway.example.com/api/runs' \
  -H "X-API-Key: $CHANNELGATE_RUN_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Summarize the project README","mode":"read","idempotencyKey":"readme-check-42"}'
```

A fresh request returns `202` with `jobId` and `statusUrl`. Request `GET /api/runs/<jobId>` with the same authentication to retrieve status, result, error, duration, and recorded cost. `POST /api/runs/<jobId>/stop` requests cancellation; `GET /api/runs` lists recent jobs.

With a channel token, you can omit `channel`. If supplied, it must identify the token’s conversation.

## Automation safeguards

Set an `idempotencyKey` per logical request. Retries with that key within 15 minutes reuse the original job and return `200` instead of launching another run. At most 25 API jobs may be in flight; additional starts receive `429`.

Optional fields select the harness, licenses, model, and effort, provide a file or public file URL, and name a completion webhook. `harness` names the [license](/docs/features/engine-licenses) the run starts on, and `licenses` is `"any"` or a list of further license IDs of the same harness that the run may move to when that license cannot answer. `licenses` requires `harness`; a request that names licenses of the other harness, or `licenses` alone, is refused with `400`. Downloaded attachments are bounded at 500 MB per file. Inline files must also fit within the API’s 30 MB JSON request-body limit, including encoding overhead.

The request's `author` is attribution only. It does not unlock anyone's personal accounts or `/sudo`; API runs use shared conversation accounts. Interrupted runs are not automatically replayed after a restart. Job records are retained for seven days, so store required results in your own system.

## Related guides

- [Gateway settings](/docs/configuration/gateway-settings)
- [Connected accounts](/docs/features/connected-accounts)
- [Schedules](/docs/features/schedules)
- [Usage and costs](/docs/features/usage-and-costs)
