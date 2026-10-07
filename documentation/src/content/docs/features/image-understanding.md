---
title: Images and screenshots
description: Give the agent visual evidence and receive generated image previews in Slack.
---

Attach an image to the request when a screenshot, diagram, photograph, or visual state carries information the agent needs. The gateway downloads supported attachments into the conversation workspace and passes their local locations to the selected engine.

## Ask for a visual inspection

```text
@ChannelGate Inspect this screenshot. List the exact visible validation
messages and explain which part of the form needs attention.
```

For a comparison, attach both images and state which is the expected result. For a small label or dense diagram, provide an original-resolution image rather than a compressed thumbnail. The agent should identify what it can actually see and state uncertainty when text is unreadable.

Image interpretation depends on the selected engine/model and available image tools. Downloading a file successfully does not establish that a visual model inspected it. The ordinary incoming attachment limit is 500 MB, but that ceiling is not a recommendation to send an enormous image.

## Reuse an earlier screenshot

An image already shared in the same Slack conversation can be retrieved on demand by file ID through [Slack history and downloads](/docs/features/slack-history). Project screenshots already inside the workspace can be inspected through permitted engine tools.

The gateway’s `workspace_read` control returns UTF-8 text, not image pixels. The agent must use its image-capable path to make a visual claim rather than treating a filename or attachment metadata as image evidence.

## Receive visual output

When an answer references workspace images with Markdown image syntax, the gateway can upload up to five unique contained image files as native Slack previews after the text answer. Each native upload is subject to the 25 MiB file-sharing limit; a failed preview does not discard the completed text answer. Public HTTP(S) image references can use Slack image blocks. Missing files, invalid image references, duplicates, and paths outside the workspace do not produce a preview.

Creating or editing an image requires an available image-generation capability or a suitable permitted local tool; image-reading support does not imply image-generation access. Ask for the file itself when you need the original output attached.

Related: [attachments](/docs/features/attachments-and-voice), [browser screenshots](/docs/features/browser-automation), [video analysis](/docs/features/video-understanding), and [file sharing](/docs/features/file-sharing).
