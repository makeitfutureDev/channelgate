---
title: Browser automation
description: Open websites, inspect interactive pages, fill authorized forms, and collect screenshots.
---

The conversation image includes Chromium, Playwright, and the `agent-browser` driver. A permitted agent can inspect an interactive website inside the conversation runtime rather than relying only on page text.

## Request a browser workflow

```text
@ChannelGate Open the staging checkout, inspect the cart, and report the
visible product names and totals. Capture a screenshot of any validation error.
```

Describe the target, the allowed interactions, and the evidence you need. Reading a page or exercising reversible test controls is different from submitting a purchase, sending a message, or publishing a change; the latter needs the user's authorization for that action.

The browser can follow links, inspect accessibility snapshots, fill inputs, and take screenshots. The task still needs shell/tool permission, the network routes admitted for the turn, and any necessary login. Having a browser installed does not establish account access.

## Understand isolation

Browser state is scoped to the conversation runtime, with a gateway-assigned namespace. Separate conversations do not share the default browser daemon, live tabs, or cookies. Threads within a conversation still need to coordinate use of shared resources.

The gateway supplies proxy settings so Chromium uses the same enforced egress path as other network clients. Turning Allow network off can refuse a public website even though the browser starts successfully. The proxy error is the evidence; do not replace it with a cached description and call that a new inspection.

## Reproduce and preserve evidence

Ask for the URL, visible steps, actual result, and screenshot or trace needed to reproduce a failure. Generated screenshots belong in the workspace and can be shared through **Files** or [Slack file delivery](/docs/features/file-sharing).

Dependencies and browser versions belong to the versioned container image. If Chromium cannot launch because the image is incomplete or stale, an operator repairs or rebuilds that image. Installing an unrelated browser into a channel home can hide the underlying compatibility problem.

Related: [workspace toolchain](/docs/features/workspace-toolchain), [network access](/docs/features/network-access), and [attachments](/docs/features/attachments-and-voice).
