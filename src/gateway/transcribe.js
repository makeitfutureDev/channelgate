// Speech-to-text for accepted Slack audio attachments. Local Whisper remains the preferred path
// when enabled; completed Slack-generated transcripts provide an optional-install fallback.
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { buildChildEnv } from "../engines/child-env.js";
import { whisperCliPath, whisperModelPath } from "../config/paths.js";
import { createSemaphore } from "../util/semaphore.js";
import { processFailureMessage } from "../util/process-outcome.js";

const AUDIO_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".mp4", ".mpeg", ".mpga", ".oga", ".ogg", ".opus", ".wav", ".webm"]);
const MAX_PROCESS_OUTPUT = 1024 * 1024;
const MAX_VTT_BYTES = 1024 * 1024;
const MAX_REASON_CHARS = 240;
export const MAX_TRANSCRIPT_CHARS = 80_000;
export const DEFAULT_WHISPER_TIMEOUT_MS = 5 * 60 * 1000;

// Loading large-v3-turbo more than once at a time can exhaust a small gateway host. This queue is
// daemon-wide because ES modules are singletons inside the Node process.
const whisperSemaphore = createSemaphore(1);

export function isAudioFile(file = {}) {
  const mime = String(file.mimetype || "").trim().toLowerCase();
  if (mime.startsWith("audio/")) return true;
  if (mime.startsWith("video/")) return false;
  const ext = path.extname(String(file.name || file.path || "")).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

function safeLabel(value) {
  return (path.basename(String(value || "voice clip")) || "voice clip")
    .replace(/[\x00-\x1f\x7f\[\]]/g, "_")
    .slice(0, 120);
}

function boundedReason(error) {
  const raw = String(error?.message || error || "transcription failed").replace(/[\r\n]+/g, " ").trim();
  return (raw || "transcription failed").slice(0, MAX_REASON_CHARS);
}

function normalizeTranscript(value, emptyMessage = "Local Whisper detected no speech in this audio clip.") {
  const text = String(value || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!text) throw new Error(emptyMessage);
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  return `${text.slice(0, MAX_TRANSCRIPT_CHARS).trimEnd()}\n[transcript truncated]`;
}

export function isSlackTranscriptUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname === "files.slack.com";
  } catch {
    return false;
  }
}

function decodeVttText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

export function parseWebVtt(value) {
  const lines = String(value || "").replace(/\r/g, "").split("\n");
  const spoken = [];
  let inNote = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) {
      inNote = false;
      continue;
    }
    if (line === "WEBVTT" || line.startsWith("WEBVTT ")) continue;
    if (line.startsWith("NOTE")) {
      inNote = true;
      continue;
    }
    if (inNote || line.includes("-->")) continue;
    if (lines[index + 1]?.includes("-->")) continue; // cue identifier
    const clean = decodeVttText(line).replace(/^[-–—]\s+/, "").trim();
    if (clean) spoken.push(clean);
  }
  return normalizeTranscript(spoken.join(" "), "Slack's generated transcript was empty.");
}

async function boundedResponseText(response, maxBytes = MAX_VTT_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Slack transcript is too large.");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error("Slack transcript is too large.");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("Slack transcript is too large.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function refreshSlackFile(file, { botToken, fetchImpl, timeout }) {
  if (!file?.id) return file || {};
  const response = await fetchImpl("https://slack.com/api/files.info", {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ file: file.id }).toString(),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(`Slack transcript metadata is unavailable (${data.error || `HTTP ${response.status}`}).`);
  return { ...file, ...(data.file || {}) };
}

async function slackTranscriptForFile(source, { botToken, fetchImpl, timeout }) {
  if (!botToken) throw new Error("Slack bot token is unavailable.");
  let file = source || {};
  const preview = file.transcription?.preview;
  if (file.transcription?.status !== "complete" || (!file.vtt && preview?.has_more)) {
    file = await refreshSlackFile(file, { botToken, fetchImpl, timeout });
  }
  if (file.transcription?.status !== "complete") {
    throw new Error("Slack transcript is not ready — click Generate transcript, then re-trigger the bot.");
  }

  if (file.vtt && isSlackTranscriptUrl(file.vtt)) {
    try {
      const response = await fetchImpl(file.vtt, {
        headers: { Authorization: `Bearer ${botToken}` },
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseWebVtt(await boundedResponseText(response));
    } catch (error) {
      if (file.transcription?.preview?.has_more !== false) {
        throw new Error(`Slack transcript is incomplete or unavailable (${boundedReason(error)}).`);
      }
    }
  }

  const completePreview = file.transcription?.preview;
  if (completePreview?.has_more === false && String(completePreview.content || "").trim()) {
    return normalizeTranscript(completePreview.content, "Slack's generated transcript was empty.");
  }
  throw new Error("Slack transcript is incomplete or not ready — click Generate transcript, then re-trigger the bot.");
}

export async function transcribeSlackAudioFiles(files, {
  botToken = "",
  fetchImpl = fetch,
  timeout = 20_000,
} = {}) {
  const transcripts = [];
  const failed = [];
  for (const file of files || []) {
    try {
      transcripts.push({ name: safeLabel(file?.name), text: await slackTranscriptForFile(file, { botToken, fetchImpl, timeout }) });
    } catch (error) {
      failed.push({ name: safeLabel(file?.name), reason: boundedReason(error) });
    }
  }
  return { transcripts, failed };
}

// Resolve each source clip in Slack order. Local Whisper is preferred when enabled, but any local
// download/transcription failure falls through to Slack's generated transcript for that same clip.
// Keeping the download callback inside the enabled branch is the guarantee that no-Whisper servers
// do not download raw audio at all.
export async function resolveAudioTranscripts(files, {
  localEnabled = true,
  downloadLocal = async () => { throw new Error("Local audio download is unavailable."); },
  localTranscriber = transcribeAudioFiles,
  localOptions = {},
  slackTranscriber = transcribeSlackAudioFiles,
  slackOptions = {},
} = {}) {
  const transcripts = [];
  const failed = [];
  const localFailed = [];
  for (const source of files || []) {
    const name = safeLabel(source?.name);
    if (localEnabled) {
      try {
        const saved = await downloadLocal(source);
        if (!saved?.path) throw new Error(saved?.skipped || "Local audio download failed.");
        const local = await localTranscriber([saved], localOptions);
        if (local.transcripts?.[0]?.text) {
          transcripts.push({ name, text: local.transcripts[0].text });
          continue;
        }
        throw new Error(local.failed?.[0]?.reason || "Local Whisper produced no transcript.");
      } catch (error) {
        localFailed.push({ name, reason: boundedReason(error) });
      }
    }

    const slack = await slackTranscriber([source], slackOptions);
    if (slack.transcripts?.[0]?.text) {
      transcripts.push({ name, text: slack.transcripts[0].text });
    } else {
      failed.push({ name, reason: boundedReason(slack.failed?.[0]?.reason || "Slack transcript is not ready — click Generate transcript, then re-trigger the bot.") });
    }
  }
  return { transcripts, failed, localFailed };
}

export function composeVoicePrompt({ text = "", transcripts = [], failed = [] } = {}) {
  const typed = String(text || "").trim();
  const good = (transcripts || []).filter((item) => String(item?.text || "").trim());
  const bad = (failed || []).map((item) => ({ name: safeLabel(item?.name), reason: boundedReason(item?.reason) }));
  if (!typed && good.length === 1 && bad.length === 0) return String(good[0].text).trim();

  const parts = typed ? [typed] : [];
  for (const item of good) {
    parts.push(`[Voice transcript — ${safeLabel(item.name)}]\n${String(item.text).trim()}\n[/Voice transcript]`);
  }
  for (const item of bad) parts.push(`[Voice transcription failed — ${item.name}: ${item.reason}]`);
  return parts.join("\n\n").trim();
}

function timeoutMs(value = process.env.WHISPER_TIMEOUT_MS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30 * 60 * 1000) : DEFAULT_WHISPER_TIMEOUT_MS;
}

export function runProcess(command, args, { cwd, timeout = DEFAULT_WHISPER_TIMEOUT_MS, maxOutput = MAX_PROCESS_OUTPUT, envExtra = {}, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || Object.assign(new Error("Transcription cancelled"), { name: "AbortError" })); return; }
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: buildChildEnv(envExtra),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      reject(new Error(processFailureMessage(path.basename(command), { spawnError: error })));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const append = (current, chunk) => `${current}${chunk}`.slice(-maxOutput);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref?.();
      finish(reject, new Error(`${path.basename(command)} timed out after ${Math.round(timeout / 1000)}s`));
    }, timeout);
    timer.unref?.();
    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref?.();
      // Wait for close before rejecting: scratch cleanup must not race a still-writing child.
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on("error", (error) => finish(reject, new Error(processFailureMessage(path.basename(command), { spawnError: error }))));
    child.on("close", (code, exitSignal) => {
      if (signal?.aborted) { finish(reject, signal.reason || Object.assign(new Error("Transcription cancelled"), { name: "AbortError" })); return; }
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(processFailureMessage(path.basename(command), {
        code,
        signal: exitSignal,
        diagnostic: stderr.trim().slice(-1000) || "No diagnostic output was provided",
        maxDiagnosticChars: 1000,
      })));
    });
  });
}

async function transcribeCore(filePath, {
  runner = runProcess,
  ffmpegPath = process.env.WHISPER_FFMPEG_PATH || "ffmpeg",
  cliPath = whisperCliPath(),
  modelPath = whisperModelPath(),
  timeout = timeoutMs(),
  signal = null,
} = {}) {
  signal?.throwIfAborted();
  const source = path.resolve(filePath);
  const scratch = await mkdtemp(path.join(path.dirname(source), ".whisper-"));
  const wav = path.join(scratch, "audio.wav");
  const runtimeBin = path.dirname(cliPath);
  const runtimeLib = path.join(path.dirname(runtimeBin), "lib");
  const runtimeEnv = {
    LD_LIBRARY_PATH: [runtimeBin, runtimeLib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
    DYLD_LIBRARY_PATH: [runtimeBin, runtimeLib, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
  };
  try {
    await runner(ffmpegPath, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-i", source, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav,
    ], { cwd: scratch, timeout, maxOutput: MAX_PROCESS_OUTPUT, signal });
    signal?.throwIfAborted();
    const result = await runner(cliPath, ["-m", modelPath, "-f", wav, "-nt"], {
      cwd: scratch,
      timeout,
      maxOutput: MAX_PROCESS_OUTPUT,
      envExtra: runtimeEnv,
      signal,
    });
    return normalizeTranscript(result?.stdout);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export async function transcribeAudioFile(filePath, options = {}) {
  const release = await whisperSemaphore.acquire({ signal: options.signal });
  try {
    return await transcribeCore(filePath, options);
  } finally {
    release();
  }
}

export async function transcribeAudioFiles(files, options = {}) {
  const transcripts = [];
  const failed = [];
  const custom = typeof options.transcribe === "function" ? options.transcribe : null;
  for (const file of files || []) {
    options.signal?.throwIfAborted();
    try {
      let text;
      if (custom) {
        const release = await whisperSemaphore.acquire({ signal: options.signal });
        try { text = await custom(file.path, options); } finally { release(); }
      } else {
        text = await transcribeAudioFile(file.path, options);
      }
      transcripts.push({ name: safeLabel(file.name), text });
    } catch (error) {
      failed.push({ name: safeLabel(file?.name), reason: boundedReason(error) });
    }
  }
  return { transcripts, failed };
}
