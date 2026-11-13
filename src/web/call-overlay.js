// The browser side of a voice call: an overlay on the personal Activity dashboard that captures
// the microphone, streams 16 kHz PCM to the daemon, plays the 24 kHz PCM the daemon relays back
// and shows the conversation the call is in, the live transcript and the tasks dispatched.
//
// Transport is deliberately plain HTTP: an SSE stream down (`…/events`) and small octet-stream
// POSTs up (`…/audio`, ~120 ms of audio each). Both ride the same reverse proxies and cookies the
// dashboard already uses, so a deployment needs no WebSocket upgrade support.
export const CALL_WORKLET_PATH = "/activity/call-worklet.js";
const INPUT_RATE = 16000, OUTPUT_RATE = 24000;

// Served as a classic module at CALL_WORKLET_PATH. It batches ~120 ms of mono audio, resamples to
// 16 kHz when the AudioContext could not be opened at that rate, and posts Int16 PCM to the page.
export const CALL_WORKLET_SOURCE = `class CgCaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.chunks = []; this.length = 0; this.target = Math.max(1, Math.round(sampleRate * 0.12)); this.muted = false;
    this.port.onmessage = (event) => { if (event.data && typeof event.data.muted === "boolean") this.muted = event.data.muted; }; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || this.muted) return true;
    this.chunks.push(Float32Array.from(channel)); this.length += channel.length;
    if (this.length >= this.target) this.flush();
    return true;
  }
  flush() {
    const joined = new Float32Array(this.length); let offset = 0;
    for (const chunk of this.chunks) { joined.set(chunk, offset); offset += chunk.length; }
    this.chunks = []; this.length = 0;
    const ratio = sampleRate / ${INPUT_RATE};
    const outLength = ratio === 1 ? joined.length : Math.floor(joined.length / ratio);
    const pcm = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const position = i * ratio, index = Math.floor(position), next = Math.min(index + 1, joined.length - 1), frac = position - index;
      const sample = joined[index] * (1 - frac) + joined[next] * frac;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
  }
}
registerProcessor("cg-capture", CgCaptureProcessor);
`;

export function callOverlayConfig({ base, csrf, agent = "" }) {
  return { callBase: base, callCsrf: csrf, callAgent: String(agent || "").trim() || "ChannelGate", workletPath: CALL_WORKLET_PATH, inputRate: INPUT_RATE, outputRate: OUTPUT_RATE };
}

export const CALL_OVERLAY_CSS = `
#call-overlay{position:fixed;inset:0;z-index:50;display:grid;place-items:center;background:color-mix(in srgb,var(--bg) 70%,transparent);backdrop-filter:blur(6px)}
#call-overlay[hidden]{display:none}
.call-panel{box-sizing:border-box;width:min(680px,calc(100% - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:22px;background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.35)}
.call-panel h2{font-size:18px;margin:0 0 4px}.call-binding{color:var(--muted);font-size:14px;margin:0 0 16px;overflow-wrap:anywhere}.call-binding strong{color:var(--ink)}
.call-controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 12px}.call-controls button{font:inherit;padding:9px 15px;border:1px solid var(--line);border-radius:9px;background:var(--panel-2);color:var(--ink);cursor:pointer}.call-controls button:disabled{opacity:.5;cursor:default}
.call-controls .primary{background:var(--orange);color:var(--brand-ink);border-color:var(--orange)}.call-controls .danger{background:#b3261e;color:#fff;border-color:#b3261e}.call-controls .timer{font-variant-numeric:tabular-nums;color:var(--muted);margin-left:auto}
.call-status{min-height:1.5em;font-size:14px;color:var(--muted);margin:0 0 12px}.call-status[data-tone=live]{color:var(--s-done,#2e9d57)}.call-status[data-tone=error]{color:#d9534f}.call-status[data-tone=warn]{color:#c9a227}
.call-transcript{max-height:38vh;overflow:auto;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--panel-2);font-size:15px;line-height:1.5}.call-transcript .line{margin:0 0 8px}.call-transcript .who{font-weight:600;margin-right:6px}.call-transcript .caller .who{color:var(--orange)}.call-transcript .agent .who{color:var(--ink-2)}
.call-tasks{margin-top:14px}.call-tasks h3{font-size:13px;margin:0 0 8px;color:var(--muted)}.call-tasks ul{list-style:none;padding:0;margin:0}.call-tasks li{padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin:0 0 6px;font-size:14px}
.call-pill{display:inline-block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:999px;margin-right:8px;background:var(--line)}.call-pill.done{background:#2e9d5733}.call-pill.failed{background:#d9534f33}.call-pill.running{background:#c9a22733}
.call-summary{margin-top:6px;color:var(--muted);white-space:pre-wrap}.call-foot{margin-top:14px;font-size:13px;color:var(--muted)}
#call-agent{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--line-2);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:13px;cursor:pointer}#call-agent:hover{border-color:var(--muted);background:var(--panel-2)}
`;

export function callOverlayMarkup({ agentName = "ChannelGate" } = {}) {
  const esc = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<div id="call-overlay" role="dialog" aria-modal="true" aria-labelledby="call-title" hidden><div class="call-panel">
<h2 id="call-title">📞 Call ${esc(agentName)}</h2>
<p class="call-binding" data-call="binding">Not in a conversation yet.</p>
<div class="call-controls"><button type="button" class="primary" data-call="start">Start call</button><button type="button" class="danger" data-call="hangup" hidden>Hang up</button><button type="button" data-call="mute" hidden aria-pressed="false">Mute</button><button type="button" data-call="close">Close</button><span class="timer" data-call="timer">00:00</span></div>
<p class="call-status" data-call="status" role="status" aria-live="polite"></p>
<div class="call-transcript" data-call="transcript" aria-label="Transcript" aria-live="polite"></div>
<section class="call-tasks" data-call="tasks-section" hidden><h3>Tasks sent to the agent</h3><ul data-call="tasks"></ul></section>
<p class="call-foot">Everything said is logged into the Slack conversation the call is in. Say which conversation to open, or ask what you are working on.</p>
</div></div>`;
}

// Runs on the dashboard. Returns { open(target), active() }: `open` shows the overlay bound to a
// conversation ({ channelId, threadTs, channelName, title }) or to none (the voice then lists the
// caller's conversations), and starts nothing until the person presses Start.
export function callOverlayBrowser(config, env) {
  const { document, fetch, EventSource, navigator, AudioContext, AudioWorkletNode, atob } = env;
  const { callBase: base, callCsrf: csrf, callAgent: agent, workletPath, inputRate, outputRate } = config;
  const root = document.getElementById("call-overlay");
  if (!root) return { open() {}, active: () => false };
  const q = (name) => root.querySelector('[data-call="' + name + '"]');
  const binding = q("binding"), status = q("status"), start = q("start"), hangup = q("hangup"), mute = q("mute"), closeButton = q("close"), transcript = q("transcript"), tasks = q("tasks"), tasksSection = q("tasks-section"), timer = q("timer");
  let callId = "", target = null, events = null, capture = null, player = null, workletNode = null, processor = null, stream = null, muted = false, startedAt = 0, tick = null;
  let playhead = 0; const playing = new Set();
  const headers = { "X-CG-CSRF": csrf, "X-CG-Request": "1" };
  function say(text, tone) { status.textContent = text; status.dataset.tone = tone || ""; }
  function fmt(ms) { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }
  function showBinding(bound) {
    binding.replaceChildren();
    if (!bound || !bound.channelName) { binding.textContent = target && target.channelName ? "Will open in " + target.channelName + (target.title ? " · " + target.title : "") : "Not in a conversation yet. Ask the agent what you are working on, or name a conversation."; return; }
    const strong = document.createElement("strong"); strong.textContent = bound.channelName;
    binding.append("In ", strong, bound.title ? " · " + bound.title : bound.threadTs ? " · thread" : "");
  }
  function line(who, text, ms) {
    const row = document.createElement("div"); row.className = "line " + who;
    const name = document.createElement("span"); name.className = "who"; name.textContent = who === "caller" ? "You" : agent;
    const body = document.createElement("span"); body.className = "text"; body.textContent = text;
    row.append(name, body); row.dataset.ms = String(ms || 0);
    return row;
  }
  function showTranscript(entries) { transcript.replaceChildren(...entries.map((row) => line(row.who, row.text, row.ms))); transcript.scrollTop = transcript.scrollHeight; }
  function updateLine(event) {
    const last = transcript.lastElementChild;
    if (last && last.classList.contains(event.who) && last.dataset.ms === String(event.ms)) last.querySelector(".text").textContent = event.text;
    else transcript.append(line(event.who, event.text, event.ms));
    transcript.scrollTop = transcript.scrollHeight;
  }
  function showTask(task) {
    let row = tasks.querySelector('[data-task="' + task.id + '"]');
    if (!row) { row = document.createElement("li"); row.dataset.task = String(task.id); tasks.append(row); }
    row.replaceChildren();
    const pill = document.createElement("span"); pill.className = "call-pill " + task.status; pill.textContent = task.status;
    const text = document.createElement("span"); text.className = "request"; text.textContent = (task.channelName ? task.channelName + ": " : "") + task.request;
    row.append(pill, text);
    if (task.summary) { const summary = document.createElement("div"); summary.className = "call-summary"; summary.textContent = task.summary; row.append(summary); }
    tasksSection.hidden = false;
  }
  function playAudio(base64) {
    if (!player) return;
    const bytes = atob(base64), samples = new Float32Array(bytes.length >> 1);
    for (let i = 0; i < samples.length; i++) { const lo = bytes.charCodeAt(2 * i), hi = bytes.charCodeAt(2 * i + 1); const v = (hi << 8) | lo; samples[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768; }
    if (!samples.length) return;
    const buffer = player.createBuffer(1, samples.length, outputRate); buffer.copyToChannel(samples, 0);
    const source = player.createBufferSource(); source.buffer = buffer; source.connect(player.destination);
    const at = Math.max(player.currentTime + 0.02, playhead);
    source.start(at); playhead = at + buffer.duration;
    playing.add(source); source.onended = () => playing.delete(source);
  }
  function stopPlayback() { for (const source of playing) { try { source.stop(); } catch (e) { /* ended */ } } playing.clear(); if (player) playhead = player.currentTime; }
  async function send(buffer) {
    if (!callId || muted) return;
    try {
      const response = await fetch(base + "/call/" + callId + "/audio", { method: "POST", credentials: "same-origin", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: buffer });
      if (response.status === 401 || response.status === 403 || response.status === 404) endLocal("The call ended.");
    } catch (e) { /* a dropped chunk is fine; the next one follows in 120 ms */ }
  }
  async function openCapture() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    try { capture = new AudioContext({ sampleRate: inputRate }); } catch (e) { capture = new AudioContext(); }
    const source = capture.createMediaStreamSource(stream);
    try {
      await capture.audioWorklet.addModule(workletPath);
      workletNode = new AudioWorkletNode(capture, "cg-capture", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      workletNode.port.onmessage = (event) => { void send(event.data); };
      source.connect(workletNode);
    } catch (e) {
      const ratio = capture.sampleRate / inputRate; let pending = [], pendingLength = 0; const batch = Math.round(capture.sampleRate * 0.12);
      processor = capture.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => {
        if (muted) return;
        const input = event.inputBuffer.getChannelData(0); pending.push(Float32Array.from(input)); pendingLength += input.length;
        if (pendingLength < batch) return;
        const joined = new Float32Array(pendingLength); let offset = 0; for (const chunk of pending) { joined.set(chunk, offset); offset += chunk.length; }
        pending = []; pendingLength = 0;
        const outLength = Math.floor(joined.length / ratio), pcm = new Int16Array(outLength);
        for (let i = 0; i < outLength; i++) { const idx = Math.min(joined.length - 1, Math.floor(i * ratio)); pcm[i] = Math.max(-32768, Math.min(32767, Math.round(joined[idx] * 32767))); }
        void send(pcm.buffer);
      };
      source.connect(processor); processor.connect(capture.destination);
    }
    player = new AudioContext({ sampleRate: outputRate });
    await player.resume();
  }
  function closeCapture() {
    try { workletNode?.disconnect(); processor?.disconnect(); } catch (e) { /* fine */ }
    for (const track of stream?.getTracks?.() || []) track.stop();
    stopPlayback();
    try { capture?.close(); player?.close(); } catch (e) { /* fine */ }
    capture = player = workletNode = processor = stream = null;
  }
  function endLocal(message) {
    if (events) { events.close(); events = null; }
    closeCapture();
    if (tick) { clearInterval(tick); tick = null; }
    callId = "";
    start.hidden = false; hangup.hidden = true; mute.hidden = true; closeButton.hidden = false;
    say(message, "ended");
  }
  function connectEvents() {
    events = new EventSource(base + "/call/" + callId + "/events");
    events.onmessage = (message) => {
      let event; try { event = JSON.parse(message.data); } catch (e) { return; }
      if (event.type === "state") { showTranscript(event.transcript || []); for (const task of event.tasks || []) showTask(task); showBinding(event.bound); if (event.status === "live") say("Connected — start talking", "live"); return; }
      if (event.type === "ready") { say("Connected — start talking", "live"); return; }
      if (event.type === "bound") { showBinding(event); return; }
      if (event.type === "audio") { playAudio(event.data); return; }
      if (event.type === "interrupted") { stopPlayback(); return; }
      if (event.type === "transcript") { updateLine(event); return; }
      if (event.type === "task") { showTask(event); return; }
      if (event.type === "error") { say("Voice service: " + event.message, "error"); return; }
      if (event.type === "ended") { endLocal("Call ended (" + (event.reason || "hung up") + "). The transcript is in the Slack conversation."); }
    };
    events.onerror = () => { if (callId) say("Reconnecting…", "warn"); };
  }
  async function begin() {
    start.disabled = true; closeButton.hidden = true; say("Asking for the microphone…", "");
    try {
      await openCapture();
      say("Calling…", "");
      const body = target && target.channelId ? { channelId: target.channelId, threadTs: target.threadTs || "" } : {};
      const response = await fetch(base + "/call/start", { method: "POST", credentials: "same-origin", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "The call could not start.");
      callId = data.id; startedAt = Date.now();
      transcript.replaceChildren(); tasks.replaceChildren(); tasksSection.hidden = true;
      showBinding(data.bound);
      connectEvents();
      start.hidden = true; hangup.hidden = false; mute.hidden = false;
      tick = setInterval(() => { timer.textContent = fmt(Date.now() - startedAt); }, 1000);
      say("Connecting to the voice service…", "");
    } catch (error) {
      closeCapture(); closeButton.hidden = false;
      say(error && error.message ? error.message : "The call could not start.", "error");
    } finally { start.disabled = false; }
  }
  async function finish() {
    const id = callId; if (!id) return;
    hangup.disabled = true;
    try { await fetch(base + "/call/" + id + "/end", { method: "POST", credentials: "same-origin", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" }); } catch (e) { /* the server times it out */ }
    hangup.disabled = false;
    endLocal("Call ended. The transcript is in the Slack conversation.");
  }
  start.addEventListener("click", () => { void begin(); });
  hangup.addEventListener("click", () => { void finish(); });
  closeButton.addEventListener("click", () => { if (!callId) root.hidden = true; });
  mute.addEventListener("click", () => { muted = !muted; mute.textContent = muted ? "Unmute" : "Mute"; mute.setAttribute("aria-pressed", String(muted)); workletNode?.port.postMessage({ muted }); });
  env.addEventListener?.("pagehide", () => { if (callId) navigator.sendBeacon?.(base + "/call/" + callId + "/end?csrf=" + encodeURIComponent(csrf)); });
  const supported = Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioContext === "function";
  function open(next) {
    if (!callId) { target = next || null; showBinding(null); timer.textContent = "00:00"; transcript.replaceChildren(); tasks.replaceChildren(); tasksSection.hidden = true; closeButton.hidden = false;
      if (!supported) { start.disabled = true; say("This browser cannot capture audio. Use a current Chrome, Edge, Safari or Firefox over HTTPS.", "error"); }
      else say("Ready. Start the call when you are.", ""); }
    root.hidden = false;
  }
  return { open, active: () => Boolean(callId) };
}
