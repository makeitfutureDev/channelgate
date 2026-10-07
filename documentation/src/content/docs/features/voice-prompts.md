---
title: Voice prompts
description: Turn a Slack voice clip into text instructions with local transcription or Slack’s completed transcript.
---

A voice prompt lets you speak instructions instead of typing them. Incoming clips share the 500 MB attachment ceiling. ChannelGate resolves supported Slack voice clips after the normal DM, mention, or engagement-reaction and access checks.

## Send spoken instructions

Record or attach the clip, then give the agent a clear outcome. In a channel, include its mention in the typed message or use the configured engagement reaction.

```text
@ChannelGate Use my voice instructions to draft a checklist. Keep any
uncertain names or numbers marked for confirmation.
```

Typed text remains part of the task. If speech and typed instructions appear to conflict, the agent should clarify rather than silently assume one recording detail authorizes a change.

## Choose the transcription path

An operator can provision and enable local Whisper voice transcription. Fresh installation offers optional setup, and the stored enablement is honored during updates. Enabled local processing is tried first for each supported clip.

When local transcription is disabled, unavailable, or fails for a clip, the gateway can use Slack’s **completed full transcript** for that clip. An incomplete preview is not a full transcript. If Slack has not finished, click **Generate transcript** in Slack and trigger the agent again once it is ready.

With local transcription disabled, the gateway does not download raw audio merely to attempt a local transcription. Raw audio is not passed directly to Claude or Codex; successfully resolved text is added to the prompt.

## Handle retention and uncertainty

A gateway-downloaded source clip is removed after successful resolution, including a completed Slack fallback after a local failure. An unresolved clip remains available for retry. Cleanup failure is distinct from transcription failure and should not be hidden.

Names, identifiers, amounts, and ambiguous audio deserve confirmation before consequential actions. A transcript is evidence of speech, not a guarantee that every word was recognized correctly.

This voice-prompt path is a Slack workflow. [Video analysis](/docs/features/video-understanding) uses a separate frame-and-speech analyzer and image toolchain; the two should not be confused.

Related: [gateway settings](/docs/configuration/gateway-settings), [attachments and voice](/docs/features/attachments-and-voice), and [privacy](/docs/privacy).
