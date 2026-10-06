---
title: HTTP run API
description: Trigger asynchronous agent work from Make.com, scripts, or other automations and retrieve its result.
---

The HTTP run API starts agent work without an incoming chat message. Use it from Make.com, an internal service, or an operator script. It returns a job ID immediately; you can poll for the result or provide a completion webhook.

## Configure authentication

In the admin website, open **Settings → System** and generate the run API token. **Save** it, then copy it into your automation's secure credential store. The **API** page shows the installation's base URL and request examples.

Send `X-API-Key` or `Authorization: Bearer`. This key can access `/api/runs`; it cannot read general admin settings or the file browser. Its runs nevertheless act as the fixed administrative API principal, so protect it as a credential that can launch work.

## Start and inspect a run

```sh
curl 'https://gateway.example.com/api/runs' \
  -H "X-API-Key: $CHANNELGATE_RUN_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Summarize the project README","mode":"read","idempotencyKey":"readme-check-42"}'
```

A fresh request returns `202` with `jobId` and `statusUrl`. Request `GET /api/runs/<jobId>` with the same authentication to retrieve status, result, error, duration, and recorded cost. `POST /api/runs/<jobId>/stop` requests cancellation; `GET /api/runs` lists recent jobs.

Omit `channel` for the headless `api` workspace. Supply a Slack channel ID, slug, or name to create a real thread when Slack delivery is available. If kickoff cannot post, the run can fall back to headless execution; inspect `slackThread` in the response.

## Automation safeguards

Set an `idempotencyKey` per logical request. Retries with that key within 15 minutes reuse the original job and return `200` instead of launching another run. At most 25 API jobs may be in flight; additional starts receive `429`.

Optional fields select engine/model/effort, provide a file or public file URL, and name a completion webhook. Downloaded attachments are bounded at 500 MB per file. Inline files must also fit within the API’s 30 MB JSON request-body limit, including encoding overhead.

The request's `author` is attribution only. It does not unlock anyone's personal accounts or `/sudo`; API runs use shared conversation accounts. Interrupted runs are not automatically replayed after a restart. Job records are retained for seven days, so store required results in your own system.

## Related guides

- [Gateway settings](/docs/configuration/gateway-settings)
- [Connected accounts](/docs/features/connected-accounts)
- [Schedules](/docs/features/schedules)
- [Usage and costs](/docs/features/usage-and-costs)
