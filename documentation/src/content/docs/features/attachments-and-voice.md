---
title: Attachments and voice prompts
description: Give the agent documents, images, recordings, and spoken instructions.
---

Attach source material to the message that requests work. After the normal trigger and access checks pass, ChannelGate downloads supported attachments into the conversation workspace and tells the engine where to find them.

## Work from a document or image

In a Slack channel, attach the file and mention the bot:

```text
@ChannelGate Compare this proposal with the requirements in our workspace.
```

Downloads stream to disk, with a shared inbound ceiling of 500 MB per attachment. Oversized files get an explicit limit error. Supported content still depends on the selected engine and installed tooling; a successfully downloaded file is not a promise that every file format can be interpreted.

The agent can retrieve a previously shared Slack attachment on demand from the same channel. It needs a file reference and a reason to fetch it; it does not download every old attachment as context. Thread-root files can be carried into the task when appropriate.

## Send a voice prompt

Optional local Whisper transcription converts supported Slack voice clips into text instructions. An administrator chooses whether to provision and enable it. When local transcription is disabled or unavailable, ChannelGate can use Slack's completed full transcript. If none exists, generate the transcript in Slack and trigger the agent again.

Typed text remains part of the instructions. Raw audio is not passed directly to Claude or Codex. Successfully resolved downloaded audio is removed from uploads; unresolved audio can remain for retry. With local transcription disabled, ChannelGate does not download raw audio merely to attempt transcription.

## Review a recording

Bundled media tools can extract video frames and speech inside the workspace. Ask for a concrete outcome, such as a walkthrough summary with observed steps. Processing depends on available tools, permissions, and the recording size.

Teams and Google Chat are Beta with their own attachment limitations; consult [platforms](/docs/platforms). Related: [files and editor](/docs/features/files-and-editor), [gateway settings](/docs/configuration/gateway-settings), and [privacy](/docs/privacy).
