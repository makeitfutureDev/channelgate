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
   its recent messages (up to 40, read before it says a word). You can interrupt it.
   The voice is the **phone line**, not the agent: it knows only what is in those messages and
   what the agent answers. Ask "what did the agent write about the deploy?" and it quotes the
   thread; ask anything that is not in a message and it tells you it is asking the agent, posts
   the question in the thread as "🎙️ *You (voice call):* …" and relays the reply when it arrives.
   It never fills in an answer of its own.
   The call opens in a side panel on the right; the dashboard stays usable beside it. While you
   are in a call the header's **📞 Call** button turns green and shows the call time — click it
   (or the panel's ×, or press Escape) to hide or show the panel and its transcript; hiding never
   ends the call. While in a call, clicking another row's **Call the agent** icon moves the
   existing call to that thread. Each thread receives the transcript of the time spent there.
3. Ask "what am I working on?", "what is waiting in #sales?", or "find the pipeline review": the
   voice lists or searches your own conversations, with a channel filter when you name one. Say
   "open that one" or "switch to #sales": the call moves there. The thread you leave receives the
   transcript of what was said while you were in it; the new thread gets a "joined by voice call"
   note and the voice tells you where it left off. Naming a channel without a conversation puts
   the call at that channel's top level: nothing is posted until you ask for something.
4. Ask for work: "build the export, run the tests, tell me when it is done". The voice hands the
   request to that channel's agent, which runs it as a normal turn in the current thread — in the
   channel's container, with its files, tools, memory and credentials, under the channel's mode
   and queue. The thread shows your request as "🎙️ *You (voice call):* …", the live progress card
   and the agent's answer with the usual footer. At a channel's top level the request itself
   becomes a **new channel message**, exactly like a typed @mention: everyone sees it in the
   channel, the agent answers in its thread, and the call follows that thread for your next
   requests (say "switch to #channel" again for a fresh top-level message). The voice tells you
   when it is done. If you have moved the call elsewhere since, it only says in one sentence that
   an answer is waiting in that other conversation and offers to switch back; the content is read
   once you switch or ask for it. Ask "is it done?" or "what
   was said here?" at any time.
5. Say **“mark this thread done”** or **“close this conversation”** to complete it directly.
   You must be the thread's starter with current access. For another conversation, open it first;
   the voice resolves ambiguous references and names the conversation in its acknowledgement.
   Completion updates Activity and the Slack root checkmark without dispatching a task, cancelling
   work or ending the call. If Slack cannot add the checkmark immediately, Done stays saved and
   the marker retries. “The agent finished” alone does not request completion. Participants can
   use personal Hide in Activity instead. A new spoken task in the thread reopens it. New threads started by a spoken task belong to the caller.
6. Say goodbye or press **Hang up**. The current thread receives the call summary: duration, the
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
- **Voice engine** — Gemini, ChatGPT or the gateway default; only the engines an administrator
  turned on are offered (see "ChatGPT voice" below).
- **Task speed** — *Normal*, or *Quick*: tasks you ask for on a call run with low reasoning effort
  on the thread's own model, so short questions come back sooner. Typed messages are unaffected.

## What the agent receives, and what you hear while it works

A spoken request reaches the agent exactly as posted in the thread, followed by a short voice note
the thread does not show: the request was spoken on a call (names and numbers may be misheard;
later words correct earlier ones; ask before acting when a misheard value matters), the answer is
read aloud so its first sentence must state the outcome, and the last few things said on the call.
A follow-up like "Thursday, not Friday" therefore keeps its meaning.

While a task runs, the call keeps its latest step as a short phrase ("reading a file: meta.json",
"running a command", "searching the web" — never a command line or a URL). Ask "how is it going?"
and the voice tells you; the panel's task list shows "Agent is …" too.

## ChatGPT voice (GPT-Live)

An administrator can also offer OpenAI's GPT-Live, running on a ChatGPT sign-in the gateway already
holds for Codex. Minutes come from that ChatGPT plan's voice allowance (it renews on a rolling
window; heavier plans have more), not from an API bill, so the end summary says "ChatGPT plan
voice" instead of a dollar estimate. Everything else is the same call: the same thread binding,
Slack logging, tasks, summary and DM memory line.

What differs:

- **Audio goes straight between your browser and OpenAI** over WebRTC. The gateway creates the call
  with its ChatGPT sign-in and joins the call's control channel for the transcript, your requests
  and the results; no credential reaches the browser. It needs a current browser with WebRTC; the
  iPhone app and older browsers use Gemini instead.
- **GPT-Live has no tools of its own.** Whatever it cannot answer, it hands to the gateway, which
  decides: "what am I working on?" lists your conversations, numbered; "open the second one",
  "switch to the sales channel" or "open the pipeline review" moves the call (several matches come
  back as a numbered choice); "is it done?" / "how is it going?" reports the tasks; "what did the
  agent say?" reads the thread; "mark this thread done" completes it; "goodbye" hangs up.
  Everything else — and anything that mixes moving with work ("switch to sales and run the
  report") — is a task for the agent in the current conversation. Say one navigation step at a
  time. These phrasings are English; in other languages your request reaches the agent as a task,
  and the dashboard still moves the call by click.
- **The voice is the ChatGPT account's own voice setting**; the gateway does not change it.
- This is the voice endpoint the Codex CLI uses, not a published API: OpenAI can change it without
  notice. If a ChatGPT call fails to connect, the panel shows OpenAI's reason (for example a used-up
  allowance).

The voice is also briefed about you on every call: your name and role, your open conversations,
the current thread's recent messages and your last five calls (from your own DM memory).

## Calling from a phone

The call is a web page, so it behaves like a call only as far as the phone's browser allows:

- While the call is up the page holds a **screen wake lock**, so the phone does not auto-lock
  mid-call (Chrome on Android, Safari on iOS 16.4 or later). Hiding the panel keeps the lock.
- Leaving the page no longer hangs up at once: the call is **suspended** for 45 seconds. Come back
  (unlock, return to the tab or app) and it continues; stay away and it ends with the usual
  summary, "the caller's device went away".
- For the most call-like experience on iOS, install the Activity dashboard to the home screen
  (Share → Add to Home Screen) and call from the installed app. Browsers still reserve the right
  to pause a background page; if a phone drops the call after a manual lock, note its OS version.

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
  gateway, at most twenty tasks per call and three in progress per conversation (tasks in
  different conversations run in parallel; tasks in the same one wait on its queue like typed
  messages).
- The list shows up to 20 conversations per request; the voice starts with the eight most
  recent open ones and asks for more when needed.
- A call ends after 60 minutes, after five minutes without audio, on hang-up, when the voice is
  asked to end it, or when the voice service drops the connection. Closing the tab (or locking
  the phone and not coming back) ends it 45 seconds later.
- Transcripts posted to a thread are capped at roughly 2,800 characters per segment; the task
  result the voice hears is capped at 1,500 characters. Nothing is spoken that the agent did not
  produce.
- A gateway restart ends active calls without posting a summary.
- A ChatGPT call whose browser never completes the WebRTC setup is dropped after 30 seconds; the
  browser reports it is still there every 20 seconds while connected.

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
- **Also offer ChatGPT voice (GPT-Live) on a ChatGPT sign-in** — off by default. Pick the
  **ChatGPT sign-in** (the default Codex sign-in, or any "ChatGPT sign-in" license under Settings →
  Engines; an API-key login does not work), the **ChatGPT voice model** (`gpt-live-1.1-codex` by
  default) and the **Default for callers**. Every caller draws on that one plan's voice allowance;
  pick a sign-in whose plan can carry your team's minutes. Voice calls work with only ChatGPT on
  (no Gemini key), except from the iPhone app.

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
kind `voice-task`. A ChatGPT call writes its row with engine `chatgpt-live`, cost 0 (the plan's
voice allowance pays) and the measured audio duration. `voice_call_started`, `voice_call_bound` and `voice_call_ended` events carry
the call id, thread, caller, duration, cost, conversations visited and reason.

## How it is built

The Activity Calls view uses `public/activity/call-history.html`, `call-history.css` and
`call-history.ts`. The gateway renders the selected HTML and CSS in the authenticated shell
and serves the stripped browser script under a URL derived from all three files. Browser
requests for call history continue to use the caller’s Activity session.

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
  `POST /:id/call/:callId/offer` (ChatGPT: the browser's WebRTC offer in, OpenAI's answer out; up to
  96 KB) and `POST /:id/call/:callId/alive` (ChatGPT heartbeat),
  `POST /:id/call/:callId/end`, the AudioWorklet module at `/activity/call-worklet.js`, and a
  redirect for the older standalone-page links. The Activity view's CSP additionally allows
  same-origin scripts for that worklet.
- `src/gateway/voice/providers.ts` — the provider ids, the ChatGPT models and sign-in ids, and the
  choice of provider per call (the caller's preference, the default, WebRTC capability).
- `src/gateway/voice/chatgpt-live.ts` — ChatGPT voice: resolves the chosen sign-in's access token
  through the Codex relay, creates the call (`POST https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`,
  `openai-alpha: quicksilver=v2`, the browser's SDP offer and a `delegation: client` session) and
  joins its control channel (`wss://api.openai.com/v1/live/<call id>`): transcripts, delegations,
  speakable and commentary context (≤500-byte chunks), usage and the allowance status.
- `src/gateway/voice/delegation-router.ts` — turns a GPT-Live delegation into one of the call's
  tools (conservative; anything unclear is a task).
- `src/gateway/voice/voice-task.ts` — the voice note added to a spoken task and the short activity
  phrases.
- `src/web/call-overlay.js` — the overlay: microphone capture through an AudioWorklet
  (ScriptProcessor fallback), 120 ms batches resampled to 16 kHz, gapless playback of the 24 kHz
  replies with interruption support, the screen wake lock, the suspend beacon on `pagehide`,
  the current conversation, live
  transcript and task list; `src/web/activity-page.js` mounts it and wires the row and top-bar
  actions.
- `src/slack/call-button.js` + `src/slack/footer.js` — the reply-menu button and its private
  launch.

## Incoming iPhone calls

On the incoming-calls feature branch, set up **Settings → Incoming iPhone calls** after enabling
voice calls. Supply your Apple team ID, APNs key ID, iPhone bundle ID and the private `.p8` text.
The key must support APNs VoIP for that app. Keep it on the gateway; never put it in the iPhone
bundle, source control, prompts or logs. Empty key input preserves the stored key; use Remove
stored APNs key to clear it. Enable the capability only when the companion app is ready.

In the iPhone app, sign in and turn on **Incoming calls** from the bell menu. Debug installations
register for APNs sandbox; distributed Release apps register for production and must be signed
with the corresponding production push entitlement. Tokens are not ordinary notification tokens.
Each phone lists its registration status; disabling the feature unregisters that phone.

Ask either supported engine in your conversation: **Call me in one minute about this thread.**
The `call_user` tool accepts `reason` and optional integer `in_minutes` (0–10080). Approve the
card now; the saved delayed invitation survives a restart. There is no arbitrary-recipient
parameter. The requester or an admin must confirm every call, even under Auto. This is separate
from a recurring schedule: each recurring call still needs its own approval. At most one incoming
invitation can be pending for a person. On answer, the existing voice service rechecks conversation
access and uses that person's identity. No voice session starts merely because the phone rings.

No card appears for a call that could not ring. When incoming calls are not configured, voice
calls are off, the requester has no registered iPhone, or a call is already pending for them, the
agent is told the reason immediately and nothing waits for approval. The checks run again when
the card is approved: if the call cannot be placed then (for example the phone was unregistered in
between, or Apple refuses the push), the card shows the failure and its reason.

Activity API (authenticated Activity session plus same-origin and CSRF checks for writes):

- `POST /activity/:id/api/devices`: `{platform:"ios",kind:"voip",token,bundleId,environment,name}`.
  `environment` is `sandbox` or `production`; the bundle must match administrator configuration.
- `GET /activity/:id/api/devices`: this person's device IDs/names/environment/last-seen only.
- `DELETE /activity/:id/api/devices/:deviceId`: unregister only this person's device.
- `GET /activity/:id/api/incoming-calls`: recent invitations without answer tokens.
- `DELETE /activity/:id/api/incoming-calls/:invitationId`: cancel an unstarted delayed call.
- `POST /activity/:id/call/accept` and `/call/decline`: `{token}` from the VoIP push. Owner-scoped,
  single-use and valid only while ringing (45 seconds). Accept returns the normal call/start
  result for the invitation's recorded conversation. No client-supplied conversation is trusted.

The daemon's five-second worker processes delayed invitations and notices. A schedule over one
minute late fails instead of ringing after prolonged downtime. Notices are retried on connector
failure with a doubling wait (30 seconds up to 30 minutes, counted from the ring); six hours after
the ring a notice that still cannot be posted is abandoned and recorded once in the Audit feed as
`incoming_call_notice_abandoned`. A process crash after posting a notice but before recording success may produce a
notification retry; do not treat chat notices as an exactly-once transport. Apple may also delay or
reject a push: delivery submission is not proof of receipt or answer.

TypeScript modules use erasable syntax and explicit `.ts` imports, which Node >=24.0.0 runs
without a build step. `npm run check:types` performs strict checking; CI also runs it on Node
24.0.0. Static/security checks inspect stripped source, and test discovery includes `.test.ts`.
Release source archives and Git-based install/update retain those source files. Container helpers
remain JavaScript: the image's closure bundler copies explicit relative imports verbatim; no new
APNs or private-key code is staged into a conversation container.
