# Voice calls with a channel's agent (Beta)

Talk to a channel's agent from a browser call page instead of typing. The call is bound to one
Slack conversation and one thread in it: what you ask for runs there, as you, and everything said
is logged there when the call ends.

## What a call does

1. Click **📞 Call** under any agent reply (or **Call the agent** on a row of your personal
   Activity page). You receive a private link that opens the call page bound to that thread; the
   link is yours alone and expires in ten minutes. The Call button is only shown while the gateway
   has voice calls configured.
2. Press **Start call**, allow the microphone and talk. The voice answers from the context of the
   thread (its recent messages are read when the call starts). You can interrupt it.
3. Ask for work: "build the export, run the tests, tell me when it is done". The voice hands the
   request to the channel agent, which runs it as a normal turn in the thread — in the channel's
   container, with its files, tools, memory and credentials, under the channel's mode and queue.
   The thread shows your request as "🎙️ *You (voice call):* …", the live progress card and the
   agent's answer with the usual footer. The voice tells you when it is done. Ask "is it done?"
   or "what was said in the thread?" at any time.
4. Say goodbye or press **Hang up**. The thread receives the call summary: duration, the tasks
   you dispatched, the estimated voice cost and the transcript.

A call without a thread (the Activity row of a conversation is always a thread; the Slack button
in a channel-level reply is not) opens its own root message in that conversation.

## Who may call

The same rule as the Dashboard button: an approved user or admin who may post in that
conversation (channel access policy, membership for private conversations). The call is admitted
when the link is minted, again when the call starts, and the caller is re-checked on every audio
chunk and on hang-up. Tasks dispatched by voice are turns **authored by the caller** with origin
`voice_call`. They are interactive (progress, queue position) but never get the admin permission
bypass, even for an admin caller in an Admin channel: the task runs as Worker and tool requests
appear as approval cards in the thread. Open the thread in Slack to answer them.

## Limits

- One call per person at a time (a new call replaces the previous one), at most eight calls per
  gateway, at most twenty tasks per call and three in progress at once.
- A call ends after 60 minutes, after five minutes without audio, on hang-up, when the voice is
  asked to end it, or when the voice service drops the connection. Closing the tab hangs up.
- The transcript posted to the thread is capped at roughly 2,800 characters; the task result the
  voice hears is capped at 1,500 characters. Nothing is spoken that the agent did not produce.
- A gateway restart ends active calls without posting a summary (phase 1).

## Administrator setup

Settings → **Voice calls**:

- **Enable voice calls** — off by default.
- **Gemini API key** — create one in Google AI Studio. The key is stored in gateway settings only:
  listings return configured / last four characters, the value is revealable only through
  `POST /api/secrets/reveal` with the admin password, and it never reaches a browser or a channel
  container. `GEMINI_API_KEY` in the daemon environment is accepted as a bootstrap fallback.
- **Voice model** — `gemini-3.8-live` (default) or `gemini-2.5-flash-native-audio-preview-12-2025`.
- **Voice** — one of Gemini's prebuilt voices (Kore by default).

The Activity dashboard must be reachable at the configured **Public URL** over HTTPS (browsers
only grant microphone access on secure origins). No WebSocket support is needed on the edge: the
browser sends audio as small `application/octet-stream` POSTs and receives everything over one
server-sent-events stream, the same transport the Activity dashboard already uses.

## Cost and accounting

Voice minutes are billed to the Gemini API key. At the paid-tier rates of November 2026
(audio in $3 / M tokens, audio out $12 / M, text $0.75 / $4.50) a conversational minute costs
about $0.015–0.025. Each call writes one `usage` row with engine `gemini-live` and task kind
`voice-call` (audio + text tokens in and out, the estimated cost from those rates, the duration),
and every dispatched task is accounted like any other turn under the engine that ran it, task
kind `voice-task`. `voice_call_started` and `voice_call_ended` events carry the call id, thread,
caller, duration, cost and reason.

## How it is built

- `src/gateway/voice/gemini-live.js` — the Gemini Live client: one WebSocket per connection
  (Node's built-in client), the `setup` message (audio response, prebuilt voice, system
  instruction, function declarations with `NON_BLOCKING` where the call returns immediately,
  input and output transcription, sliding-window context compression, session resumption),
  16 kHz PCM frames up, 24 kHz PCM parts down, usage deltas by modality, automatic reconnection
  with the resumption handle on `goAway`.
- `src/gateway/voice/calls.js` — the call manager: admission, thread binding, the system
  instruction with the thread's recent messages, the voice's tools, dispatching a task as a turn
  (`runMessage` with `origin: "voice_call"` behind the thread's run queue with live progress),
  transcript aggregation, hang-up summary and accounting.
- `src/web/activity.js` — the routes under the caller's Activity session: `GET /:id/call`,
  `POST /:id/call/start`, `GET /:id/call/:callId/events` (SSE), `POST /:id/call/:callId/audio`,
  `POST /:id/call/:callId/end`, plus the AudioWorklet module at `/activity/call-worklet.js`. The
  call page's CSP additionally allows same-origin scripts for that worklet.
- `src/web/call-page.js` — the page: microphone capture through an AudioWorklet (ScriptProcessor
  fallback), 120 ms batches resampled to 16 kHz, gapless playback of the 24 kHz replies with
  interruption support, live transcript and task list.
- `src/slack/call-button.js` + `src/slack/footer.js` — the reply-menu button and its private
  launch; `src/web/activity-page.js` — the Activity row action.
