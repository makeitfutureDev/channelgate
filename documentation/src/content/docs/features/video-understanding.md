---
title: Video and screen-recording analysis
description: Combine sampled frames and timestamped speech to understand a recorded workflow.
---

Attach a recording and ask for a specific outcome: observed steps, exact errors, proposed fixes, or a comparison with the intended behavior. Video understanding uses both visual evidence and speech rather than treating the transcript as a complete recording.

## Start an analysis

```text
@ChannelGate Review this screen recording. List each visible validation error,
include timestamps, and distinguish what the screen shows from what I describe.
```

Inbound recordings share the 500 MB attachment ceiling. An earlier Slack file can be retrieved from the same channel with `slack_download_file`, so the agent need not ask for another upload when the original remains accessible.

The bundled analyzer probes duration and resolution, selects frames using time and visual changes, creates a contact sheet and manifest, and can generate a timestamped transcript locally. The image includes FFmpeg, OpenCV, and faster-whisper with a cached `small` model for routine video analysis. This media pipeline is separate from the configurable Slack voice-prompt transcription path.

## Inspect the important moments

A useful analysis first samples an overview, then re-samples intervals containing quick dialogs, cursor or cell selection, typed values, exact errors, or narration such as “this” and “here.” The agent should inspect original selected frames when small text matters.

For a long recording, ask for chapters and a focused deep inspection of relevant sections. Sparse screenshots alone cannot establish that every step in the recording was observed.

## Keep findings and source handling accurate

The answer should distinguish visible facts, spoken statements, combined inferences, and unresolved ambiguity. Missing audio or failed decoding must be reported. Original structured data is preferable to retyping large tables from pixels.

After successful analysis, the constrained cleanup helper can remove only a gateway-downloaded source beneath this conversation's uploads directory. It preserves the evidence pack and refuses project-managed paths and symlinks. Failed analysis keeps the source for retry. Uploading recordings or extracted media to an external service requires authorization.

Related: [attachments and voice](/docs/features/attachments-and-voice), [browser automation](/docs/features/browser-automation), and [privacy](/docs/privacy).
