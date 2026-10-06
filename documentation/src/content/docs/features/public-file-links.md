---
title: Temporary public file links
description: Give a file a limited download URL for a person or a service that ingests files by URL.
---

A public file link lets anyone holding its token download one file from the conversation workspace without signing in. Use it only when the destination needs a URL. An ordinary Slack attachment or Composio staging does not require this public route.

## Enable the feature

An administrator must turn on **Public file links** and configure the gateway's **Public URL**. The URL must reach the gateway's download route through the deployment's configured network and reverse proxy.

Files remain confined to the conversation's working folder. Moving a file outside that folder or replacing it with an escaping symlink does not broaden the link's access.

## Share with a person

```text
Give me a public link to deliverables/report.pdf that expires in two hours.
```

The duration must be explicit, with a maximum of **48 hours**. Human sharing requires an approval click naming the file and duration. After approval, the tool returns the URL and expiry. Share links have no configured fetch-count cap, but expiry, revocation, and the gateway-wide switch still apply.

Do not publish a link for a longer duration by guessing what the requester intended. Ask for the desired duration when it is missing.

## Supply a machine upload URL

An API that fetches a file by URL uses purpose `upload`. These links last five minutes by default, at most fifteen minutes, and allow five fetches. Give the link to the authorized API call; do not also post it in the chat.

For a Composio tool that takes a file object, prefer `stage_file_for_composio` on the same execution identity. It returns the required file object without publishing a download URL.

## Revoke and inspect

The live-link listing shows IDs, paths, purpose, expiry, and fetch counts. URLs cannot be recovered from that listing. Revoke by ID from the same conversation. Revocation stops later fetches but cannot recall completed downloads. Turning off public links disables outstanding links at fetch time.

Related: [file sharing](/docs/features/file-sharing), [privacy](/docs/privacy), and [workspace and file controls](/docs/controls/workspace-and-files).
