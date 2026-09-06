# Conversation operations

## Work that outlives a turn

Foreground runs, daemon-owned background agents, approved background shell jobs, schedules, and
memory reviews all resolve their own runtime target at spawn and execute inside the same
conversation container. Background work that must outlive the current engine turn belongs to the
gateway daemon, not an engine subagent. It keeps a container lease and posts its result through the
active platform connector.

Schedules and reminders are thread-aware, durable, and re-resolve the channel configuration when
they fire. A missing platform transport throws instead of pretending delivery. Restart requests
wait for active turns/jobs/update transactions to drain and cancel loudly if the gateway cannot
become idle.

## User-visible liveness

Substantial live work has an elapsed/activity heartbeat and, where available, semantic progress.
Global and per-thread queues report position. A quiet engine process is probed and reported as
still connected rather than killed at the ordinary inactivity interval. Any new waiting state must
be visible to the requester.

## Attachments and files

Inbound files are streamed into the conversation's `uploads/` tree with exclusive no-follow writes
and a shared 500 MB cap; declared or running over-size bodies are refused without leaving a partial
destination. Later thread replies can recover a root attachment, and `slack_download_file` can
fetch an earlier current-channel Slack file by id/link while enforcing the same channel and size
scope. Paths are handed to the engine inside the mounted work folder.

The built-in `gateway-usage` skill also carries local video understanding: ffmpeg/ffprobe,
OpenCV, faster-whisper, and the cached model ship in the image. Do not require or grant a separate
video skill.

## Platform capabilities

Slack, Google Chat, and Microsoft Teams normalize into one inbound shape and declare their
rendering, streaming, threading, edit, mention, modal, chart/table/list, and attachment capabilities
in adapters. Unknown capabilities fail closed; unknown legacy platform ids resolve as Slack.
Outbound formatting degrades by declared capability, and unattended writes go through the platform
connector. Read the injected `gateway-usage/references/platform.md` before choosing a native
artifact or promising a chat behavior.

