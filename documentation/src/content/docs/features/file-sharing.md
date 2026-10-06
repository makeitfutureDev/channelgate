---
title: Share and export files
description: Deliver workspace artifacts in chat, upload through connected accounts, or create an expiring public link.
---

Files created by an agent live in the conversation's working folder. Choose how to deliver them based on their destination: the same chat, a connected service, or a temporary public download.

## Deliver a file in Slack

Ask the agent to send the artifact into the current thread:

> Export the report as a PDF and attach the PDF here.

The gateway can upload files directly with its bot identity, subject to its file-size limit. A folder-relative filename in the reply also provides an explorer entry for browsing or downloading the file. See [Files and editor](/docs/features/files-and-editor).

This does not require a personal Slack integration merely to deliver a file back to the current conversation. Delivery capabilities differ on the Beta chat platforms.

## Upload to a connected service

For Drive, email attachments, or another supported service, specify the destination and intended account:

> Upload the report to the shared team's Drive folder using the shared connection.

The agent stages the file for the selected connected identity, then passes the returned file object to the service's tool. Staging and upload must use the same identity. A path in a container is not a file attachment that an external service can read.

If staging is refused or fails, the agent should report that outcome. It cannot bypass the export boundary by sending the file's bytes through a different tool.

## Create a public download link

Public links require an administrator to enable the feature and configure a reachable public URL. Ask for a duration, for example:

> Create a public link for this report that expires in 24 hours.

A share link requires the corresponding approval. Anyone holding the URL can download the file until it expires or is revoked. The maximum duration is 48 hours. A download that already happened cannot be recalled.

Only eligible regular files within the conversation's working folder can be exported. A readable path outside that folder is not automatically shareable.

## Related guides

- [Connected accounts](/docs/features/connected-accounts)
- [Approvals](/docs/features/approvals)
- [Gateway settings](/docs/configuration/gateway-settings)
