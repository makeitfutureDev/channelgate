# Voice calls with a channel's agent (Beta)

Talk to your agents from a voice-call overlay on your personal Activity dashboard instead of
typing. A call is in one Slack conversation at a time: what you ask for runs there, as you, and
everything said is logged there. You can ask what you are working on, move the call to another
conversation or channel, and keep talking.

## What a call does

1. Open a call from any of three places: the **📞 Call** button under an agent reply (a private
   link, yours alone, valid ten minutes, opens the dashboard with the overlay bound to that
   thread), the **Call the agent** icon on an Activity row, or the dashboard's own **📞 Call**
   button, which starts a call in no conversation yet. The Slack button is only shown while the
   gateway has voice calls configured.
2. Press **Start call**, allow the microphone and talk. The voice knows your eight most recent
   open conversations (the same list as your Activity page) and, when the call is in a thread,
   its recent messages. You can interrupt it.
   The call opens in a side panel on the right; the dashboard stays usable beside it. While you
   are in a call the header's **📞 Call** button turns green and shows the call time — click it
   (or the panel's ×, or press Escape) to hide or show the panel and its transcript; hiding never
   ends the call. While in a call, clicking another row's **Call the agent** icon moves the
   existing call to that thread. Each thread receives the transcript of the time spent there.
3. Ask "what am I working on?", "what is waiting in #sales?", or "find the pipeline review": the
   voice lists or searches your own conversations, with a channel filter when you name one. Say
   "open that one" or "switch to #sales": the call moves there. The thread you leave receives the
   transcript of what was said while you were in it; the new thread gets a "joined by voice call"
   note and the voice tells you where it left off. Naming a channel without a conversation opens
   a new thread there.
4. Ask for work: "build the export, run the tests, tell me when it is done". The voice hands the
   request to that channel's agent, which runs it as a normal turn in the current thread — in the
   channel's container, with its files, tools, memory and credentials, under the channel's mode
   and queue. The thread shows your request as "🎙️ *You (voice call):* …", the live progress card
   and the agent's answer with the usual footer. The voice tells you when it is done, and says
   where it ran if you have moved on since. Ask "is it done?" or "what was said here?" at any time.
5. Say goodbye or press **Hang up**. The current thread receives the call summary: duration, the
   tasks you dispatched, the estimated voice cost, the other conversations you visited and the
   last segment's transcript. One line about the call (date, duration, conversations, tasks) is
   saved to your DM memory, so your personal agent remembers what you were working on.

## Make it talk the way you want

Activity → Settings → **Voice calls** is yours alone and applies to your next call:

- **Language** — the default it speaks; leave it empty and it follows whatever language you use.
  Switching language mid-call works either way.
- **Style** — *Brief* (short answers, gets on with it), *Conversational* (a little more, elaborates
  when asked) or *Thinking partner* (listens while you think aloud, reflects back, asks one
  question at a time, proposes only when asked).
- **Patience** — how long it waits after you stop talking: *Quick*, *Normal* or *Patient*, which
  waits through pauses and asks whether you are done rather than answering a half-sentence.
- **Your instructions** — free text up to 2,000 characters, read at the start of every call after
  the gateway's own rules: how to address you, what to confirm before doing, what to keep short.

The voice is also briefed about you on every call: your name and role, your open conversations,
the current thread's recent messages and your last five calls (from your own DM memory).

## Who may call, and what the voice can see

The same rule as the Dashboard button: an approved user or admin who may post in that
conversation (channel access policy, membership for private conversations). The call is admitted
when the link is minted, again at every switch, and the caller is re-checked on every audio
chunk and on hang-up.

The voice sees exactly what you see on your Activity page: **your own conversations**, never
somebody else's threads. Thread contents are read only for the conversation the call is in. For
anything beyond that — "search #sales for what Alex said about pricing" — the voice offers to
hand the search to the channel agent as a task, which then runs with that agent's own reach
(channel memory, files, agent mail). The voice never guesses what is happening elsewhere.

Tasks dispatched by voice are turns **authored by the caller** with origin `voice_call`. They are
interactive (progress, queue position) but never get the admin permission bypass, even for an
admin caller in an Admin channel: the task runs as Worker and tool requests appear as approval
cards in the thread. Open the thread in Slack to answer them.

## Limits

- One call per person at a time (a new call replaces the previous one), at most eight calls per
  gateway, at most twenty tasks per call and three in progress at once.
- The list shows up to 20 conversations per request; the voice starts with the eight most
  recent open ones and asks for more when needed.
- A call ends after 60 minutes, after five minutes without audio, on hang-up, when the voice is
  asked to end it, or when the voice service drops the connection. Closing the tab hangs up.
- Transcripts posted to a thread are capped at roughly 2,800 characters per segment; the task
  result the voice hears is capped at 1,500 characters. Nothing is spoken that the agent did not
  produce.
- A gateway restart ends active calls without posting a summary.

## Administrator setup

Settings → **Voice calls**:

- **Enable voice calls** — off by default.
- **Gemini API key** — create one in Google AI Studio (both the classic `AIza…` and the newer
  dotted `AQ.…` shapes work). The key is stored in gateway settings only: listings return
  configured / last four characters, the value is revealable only through
  `POST /api/secrets/reveal` with the admin password, and it never reaches a browser or a channel
  container. `GEMINI_API_KEY` in the daemon environment is accepted as a bootstrap fallback.
- **Voice model** — `gemini-3.8-live` (default) or `gemini-2.5-flash-native-audio-preview-12-2025`.
- **Voice** — one of Gemini's prebuilt voices (Kore by default).

The Activity dashboard must be reachable at the configured **Public URL** over HTTPS (browsers
only grant microphone access on secure origins). No WebSocket support is needed on the edge: the
browser sends audio as small `application/octet-stream` POSTs and receives everything over one
server-sent-events stream, the same transport the dashboard already uses. A gateway restart is
needed after the first deployment of the feature, like any server-side change.

## Cost and accounting

Voice minutes are billed to the Gemini API key. At the paid-tier rates of November 2026
(audio in $3 / M tokens, audio out $12 / M, text $0.75 / $4.50) a conversational minute costs
about $0.015–0.025. Each call writes one `usage` row with engine `gemini-live` and task kind
`voice-call` (audio + text tokens in and out, the estimated cost from those rates, the duration),
and every dispatched task is accounted like any other turn under the engine that ran it, task
kind `voice-task`. `voice_call_started`, `voice_call_bound` and `voice_call_ended` events carry
the call id, thread, caller, duration, cost, conversations visited and reason.

## How it is built

- `src/gateway/voice/gemini-live.js` — the Gemini Live client: one WebSocket per connection
  (Node's built-in client, binary frames), the `setup` message (audio response, prebuilt voice,
  system instruction, function declarations with `NON_BLOCKING` where the call returns
  immediately, input and output transcription, sliding-window context compression, session
  resumption), 16 kHz PCM frames up, 24 kHz PCM parts down, usage deltas by modality, automatic
  reconnection with the resumption handle on `goAway`.
- `src/gateway/voice/calls.js` — the call manager: admission, binding and switching (with the
  segment transcript posted to the thread left behind), the system instruction with the caller's
  recent conversations and the current thread's messages, the voice's tools (`list_conversations`
  and `search_conversations` over the caller's Activity snapshot, `switch_conversation`,
  `run_task` as a `runMessage` turn with `origin: "voice_call"` behind the thread's run queue with
  live progress, `check_tasks`, `read_thread`, `end_call`), hang-up summary, accounting and the
  DM memory line.
- `src/web/activity.js` — the routes under the caller's Activity session: the dashboard with
  `?call=<channel>[&thread=<ts>]`, `POST /:id/call/start` (bound or not),
  `GET /:id/call/:callId/events` (SSE), `POST /:id/call/:callId/audio`,
  `POST /:id/call/:callId/switch` (owner-only, CSRF-protected destination change),
  `POST /:id/call/:callId/end`, the AudioWorklet module at `/activity/call-worklet.js`, and a
  redirect for the older standalone-page links. The Activity view's CSP additionally allows
  same-origin scripts for that worklet.
- `src/web/call-overlay.js` — the overlay: microphone capture through an AudioWorklet
  (ScriptProcessor fallback), 120 ms batches resampled to 16 kHz, gapless playback of the 24 kHz
  replies with interruption support, the current conversation, live transcript and task list;
  `src/web/activity-page.js` mounts it and wires the row and top-bar actions.
- `src/slack/call-button.js` + `src/slack/footer.js` — the reply-menu button and its private
  launch.
