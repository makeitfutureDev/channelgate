// The browser side of a voice call: one page under the caller's Activity session that captures the
// microphone, streams 16 kHz PCM to the daemon, plays the 24 kHz PCM the daemon relays back and
// shows the live transcript and the tasks dispatched into the bound Slack thread.
//
// Transport is deliberately plain HTTP: an SSE stream down (`…/events`) and small octet-stream
// POSTs up (`…/audio`, ~120 ms of audio each). Both ride the same reverse proxies and cookies the
// Activity dashboard already uses, so a deployment needs no WebSocket upgrade support.
import crypto from "node:crypto";
import { ACTIVITY_THEME_CSS, ACTIVITY_BRAND } from "./activity-theme.js";

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

function callBrowser(config, env) {
  const { document, fetch, EventSource, navigator, AudioContext, AudioWorkletNode, atob, location } = env;
  const { base, csrf, channelId, threadTs, channelName, agent, workletPath, inputRate, outputRate } = config;
  const el = (id) => document.getElementById(id);
  const status = el("status"), start = el("start"), hangup = el("hangup"), mute = el("mute"), transcript = el("transcript"), tasks = el("tasks"), timer = el("timer");
  let callId = "", events = null, capture = null, player = null, workletNode = null, processor = null, stream = null, muted = false, startedAt = 0, tick = null;
  let playhead = 0; const playing = new Set();
  const headers = { "X-CG-CSRF": csrf, "X-CG-Request": "1" };
  function say(text, tone) { status.textContent = text; status.dataset.tone = tone || ""; }
  function fmt(ms) { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }
  function line(who, text, ms) {
    const row = document.createElement("div"); row.className = "line " + who;
    const name = document.createElement("span"); name.className = "who"; name.textContent = who === "caller" ? "You" : agent;
    const body = document.createElement("span"); body.className = "text"; body.textContent = text;
    row.append(name, body); row.dataset.ms = String(ms || 0);
    return row;
  }
  function showTranscript(entries) {
    transcript.replaceChildren(...entries.map((row) => line(row.who, row.text, row.ms)));
    transcript.scrollTop = transcript.scrollHeight;
  }
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
    const pill = document.createElement("span"); pill.className = "pill " + task.status; pill.textContent = task.status;
    const text = document.createElement("span"); text.className = "request"; text.textContent = task.request;
    row.append(pill, text);
    if (task.summary) { const summary = document.createElement("div"); summary.className = "summary"; summary.textContent = task.summary; row.append(summary); }
    el("tasks-section").hidden = false;
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
  function stopPlayback() {
    for (const source of playing) { try { source.stop(); } catch (e) { /* already ended */ } }
    playing.clear(); if (player) playhead = player.currentTime;
  }
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
      // Older browsers: ScriptProcessor with the same batching and resampling.
      const ratio = capture.sampleRate / inputRate; let pending = [], pendingLength = 0; const target = Math.round(capture.sampleRate * 0.12);
      processor = capture.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => {
        if (muted) return;
        const input = event.inputBuffer.getChannelData(0); pending.push(Float32Array.from(input)); pendingLength += input.length;
        if (pendingLength < target) return;
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
    start.hidden = false; hangup.hidden = true; mute.hidden = true;
    say(message, "ended");
  }
  function connectEvents() {
    events = new EventSource(base + "/call/" + callId + "/events");
    events.onmessage = (message) => {
      let event; try { event = JSON.parse(message.data); } catch (e) { return; }
      if (event.type === "state") { showTranscript(event.transcript || []); for (const task of event.tasks || []) showTask(task); if (event.status === "live") say("Connected · " + channelName, "live"); return; }
      if (event.type === "ready") { say("Connected · " + channelName + " — start talking", "live"); return; }
      if (event.type === "audio") { playAudio(event.data); return; }
      if (event.type === "interrupted") { stopPlayback(); return; }
      if (event.type === "transcript") { updateLine(event); return; }
      if (event.type === "task") { showTask(event); return; }
      if (event.type === "error") { say("Voice service: " + event.message, "error"); return; }
      if (event.type === "ended") { endLocal("Call ended (" + (event.reason || "hung up") + "). The transcript is in the Slack thread."); }
    };
    events.onerror = () => { if (callId) say("Reconnecting…", "warn"); };
  }
  async function begin() {
    start.disabled = true; say("Asking for the microphone…", "");
    try {
      await openCapture();
      say("Calling…", "");
      const response = await fetch(base + "/call/start", { method: "POST", credentials: "same-origin", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ channelId, threadTs }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "The call could not start.");
      callId = data.id; startedAt = Date.now();
      transcript.replaceChildren(); tasks.replaceChildren(); el("tasks-section").hidden = true;
      connectEvents();
      start.hidden = true; hangup.hidden = false; mute.hidden = false;
      tick = setInterval(() => { timer.textContent = fmt(Date.now() - startedAt); }, 1000);
      say("Connecting to the voice service…", "");
    } catch (error) {
      closeCapture();
      say(error && error.message ? error.message : "The call could not start.", "error");
    } finally { start.disabled = false; }
  }
  async function finish() {
    const id = callId; if (!id) return;
    hangup.disabled = true;
    try { await fetch(base + "/call/" + id + "/end", { method: "POST", credentials: "same-origin", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" }); } catch (e) { /* the server times it out */ }
    hangup.disabled = false;
    endLocal("Call ended. The transcript is in the Slack thread.");
  }
  start.addEventListener("click", () => { void begin(); });
  hangup.addEventListener("click", () => { void finish(); });
  mute.addEventListener("click", () => {
    muted = !muted; mute.textContent = muted ? "Unmute" : "Mute"; mute.setAttribute("aria-pressed", String(muted));
    workletNode?.port.postMessage({ muted });
  });
  env.addEventListener?.("pagehide", () => { if (callId) { const id = callId; navigator.sendBeacon?.(base + "/call/" + id + "/end?csrf=" + encodeURIComponent(csrf)); } });
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext !== "function") { start.disabled = true; say("This browser cannot capture audio. Use a current Chrome, Edge, Safari or Firefox over HTTPS.", "error"); }
  else say("Ready. Start the call when you are.", "");
  void location;
}

export function callPage({ sessionId, csrf, channelId, threadTs = "", channelName = "", agent = "", theme = "system" }) {
  const base = `/activity/${encodeURIComponent(sessionId)}`;
  const nonce = crypto.randomBytes(16).toString("base64url");
  const agentName = String(agent || "").trim() || "ChannelGate";
  const config = JSON.stringify({ base, csrf, channelId, threadTs, channelName, agent: agentName, workletPath: CALL_WORKLET_PATH, inputRate: INPUT_RATE, outputRate: OUTPUT_RATE }).replaceAll("<", "\\u003c");
  const pinned = theme === "dark" || theme === "light" ? ` data-theme="${theme}"` : "";
  const esc = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return { nonce, html: `<!doctype html>
<html lang="en"${pinned}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>Call ${esc(agentName)} · ChannelGate</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style nonce="${nonce}">${ACTIVITY_THEME_CSS}
body{margin:0;min-height:100dvh;display:grid;place-items:start center}main{box-sizing:border-box;width:min(720px,calc(100% - 32px));margin:24px 16px;padding:24px;background:var(--panel);border:1px solid var(--line);border-radius:14px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);font-size:14px;margin:0 0 18px}.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 14px}
button{font:inherit;padding:10px 16px;border:1px solid var(--line);border-radius:9px;background:var(--panel-2);color:var(--ink);cursor:pointer}button:disabled{opacity:.5;cursor:default}
.primary{background:var(--orange);color:var(--brand-ink);border-color:var(--orange)}.danger{background:#b3261e;color:#fff;border-color:#b3261e}
#timer{font-variant-numeric:tabular-nums;color:var(--muted);margin-left:auto}#status{min-height:1.5em;font-size:14px;color:var(--muted);margin:0 0 14px}#status[data-tone=live]{color:var(--s-done,#2e9d57)}#status[data-tone=error]{color:#d9534f}#status[data-tone=warn]{color:#c9a227}
#transcript{max-height:46vh;overflow:auto;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--panel-2);font-size:15px;line-height:1.5}.line{margin:0 0 8px}.line .who{font-weight:600;margin-right:6px}.line.caller .who{color:var(--orange)}.line.agent .who{color:var(--ink-2)}
#tasks-section{margin-top:16px}#tasks-section h2{font-size:14px;margin:0 0 8px;color:var(--muted)}#tasks{list-style:none;padding:0;margin:0}#tasks li{padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin:0 0 6px;font-size:14px}.pill{display:inline-block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:999px;margin-right:8px;background:var(--line)}.pill.done{background:#2e9d5733}.pill.failed{background:#d9534f33}.pill.running{background:#c9a22733}
.summary{margin-top:6px;color:var(--muted);white-space:pre-wrap}.foot{margin-top:18px;font-size:13px;color:var(--muted)}.foot a{color:var(--orange)}
</style></head><body><main>${ACTIVITY_BRAND}
<h1>Call ${esc(agentName)}</h1><p class="sub">${esc(channelName || "this conversation")}${threadTs ? " · in the current thread" : " · a new thread will be opened"}</p>
<div class="controls"><button id="start" class="primary" type="button">📞 Start call</button><button id="hangup" class="danger" type="button" hidden>Hang up</button><button id="mute" type="button" hidden aria-pressed="false">Mute</button><span id="timer">00:00</span></div>
<p id="status" role="status" aria-live="polite"></p>
<div id="transcript" aria-label="Transcript" aria-live="polite"></div>
<section id="tasks-section" hidden><h2>Tasks sent to the agent</h2><ul id="tasks"></ul></section>
<p class="foot">Everything said here is logged into the Slack thread when the call ends. <a href="${base}">Back to Activity</a></p>
<noscript><p>Enable JavaScript to place a call.</p></noscript></main>
<script nonce="${nonce}">(${callBrowser.toString()})(${config}, globalThis);</script></body></html>` };
}
