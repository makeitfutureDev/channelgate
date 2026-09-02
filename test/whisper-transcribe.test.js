import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import {
  MAX_TRANSCRIPT_CHARS,
  composeVoicePrompt,
  isAudioFile,
  isSlackTranscriptUrl,
  parseWebVtt,
  resolveAudioTranscripts,
  runProcess,
  transcribeAudioFile,
  transcribeAudioFiles,
  transcribeSlackAudioFiles,
} from "../src/gateway/transcribe.js";

test("bounded process runner terminates commands that exceed their timeout", async () => {
  await assert.rejects(
    () => runProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeout: 25 }),
    /timed out/i,
  );
});

test("voice subprocess failures explain the outcome without exposing a numeric process code", async () => {
  await assert.rejects(
    () => runProcess(process.execPath, ["-e", "process.stderr.write('bad input'); process.exit(2)"], { timeout: 1_000 }),
    (error) => {
      assert.match(error.message, /failed because it rejected its input or options/i);
      assert.match(error.message, /bad input/);
      assert.doesNotMatch(error.message, /exit code|exit 2|code 2/i);
      return true;
    },
  );
});

test("detects Slack audio MIME types and conservative voice extensions", () => {
  assert.equal(isAudioFile({ mimetype: "audio/mp4", name: "voice.m4a" }), true);
  assert.equal(isAudioFile({ mimetype: "application/octet-stream", name: "memo.OPUS" }), true);
  assert.equal(isAudioFile({ mimetype: "video/mp4", name: "clip.mp4" }), false);
  assert.equal(isAudioFile({ mimetype: "application/pdf", name: "voice.pdf" }), false);
});

test("voice-only uses the transcript directly; typed text clearly delimits voice content", () => {
  assert.equal(
    composeVoicePrompt({ text: "", transcripts: [{ name: "voice.m4a", text: "Open the report." }], failed: [] }),
    "Open the report.",
  );
  assert.equal(
    composeVoicePrompt({ text: "Summarize this", transcripts: [{ name: "voice.m4a", text: "spoken words" }], failed: [] }),
    "Summarize this\n\n[Voice transcript — voice.m4a]\nspoken words\n[/Voice transcript]",
  );
});

test("multiple transcripts retain Slack order and failures are explicit", () => {
  assert.equal(
    composeVoicePrompt({
      text: "",
      transcripts: [
        { name: "one.m4a", text: "first" },
        { name: "two.ogg", text: "second" },
      ],
      failed: [{ name: "bad.mp3", reason: "no speech detected" }],
    }),
    "[Voice transcript — one.m4a]\nfirst\n[/Voice transcript]\n\n" +
      "[Voice transcript — two.ogg]\nsecond\n[/Voice transcript]\n\n" +
      "[Voice transcription failed — bad.mp3: no speech detected]",
  );
});

test("transcription uses argv arrays, truncates output, and cleans temporary audio", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cg-whisper-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "voice; $(touch nope).m4a");
  await writeFile(source, "audio");
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === "/usr/bin/ffmpeg-test") await writeFile(args.at(-1), "wav");
    return { stdout: command === "/usr/bin/whisper-test" ? `  ${"word ".repeat(MAX_TRANSCRIPT_CHARS)}  ` : "", stderr: "" };
  };

  const transcript = await transcribeAudioFile(source, {
    runner,
    ffmpegPath: "/usr/bin/ffmpeg-test",
    cliPath: "/usr/bin/whisper-test",
    modelPath: "/models/large.bin",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes(source), true);
  assert.equal(calls[0].args.some((arg) => arg.includes("touch nope") && arg !== source), false);
  assert.deepEqual(calls[1].args.slice(0, 2), ["-m", "/models/large.bin"]);
  assert.match(transcript, /\[transcript truncated\]$/);
  assert.ok(transcript.length <= MAX_TRANSCRIPT_CHARS + 30);
  assert.deepEqual((await readdir(dir)).sort(), [path.basename(source)]);
});

test("empty Whisper output is a bounded failure", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cg-whisper-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "silence.wav");
  await writeFile(source, "audio");
  const runner = async (_command, args) => {
    if (args.includes("-ar")) await writeFile(args.at(-1), "wav");
    return { stdout: "  \n", stderr: "" };
  };
  await assert.rejects(() => transcribeAudioFile(source, { runner, ffmpegPath: "ffmpeg", cliPath: "whisper", modelPath: "model" }), /no speech/i);
});

test("audio batches serialize the daemon-wide Whisper work and preserve failures", async () => {
  let active = 0;
  let maxActive = 0;
  const transcribe = async (filePath) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    if (filePath.includes("bad")) throw new Error("x".repeat(1000));
    return path.basename(filePath);
  };
  const [one, two] = await Promise.all([
    transcribeAudioFiles([{ name: "a.m4a", path: "/tmp/a.m4a" }, { name: "bad.m4a", path: "/tmp/bad.m4a" }], { transcribe }),
    transcribeAudioFiles([{ name: "b.ogg", path: "/tmp/b.ogg" }], { transcribe }),
  ]);
  assert.equal(maxActive, 1);
  assert.deepEqual(one.transcripts, [{ name: "a.m4a", text: "a.m4a" }]);
  assert.equal(one.failed[0].name, "bad.m4a");
  assert.ok(one.failed[0].reason.length <= 240);
  assert.deepEqual(two.transcripts, [{ name: "b.ogg", text: "b.ogg" }]);
});

test("Slack WebVTT parsing removes cue metadata but keeps complete spoken text", () => {
  assert.equal(
    parseWebVtt("WEBVTT\n\n00:00:00.579 --> 00:00:01.700\n- How are you?\n\n00:00:02.000 --> 00:00:03.000\nSecond line."),
    "How are you? Second line.",
  );
});

test("only Slack HTTPS transcript URLs are accepted", () => {
  assert.equal(isSlackTranscriptUrl("https://files.slack.com/files-tmb/T-F/file.vtt"), true);
  assert.equal(isSlackTranscriptUrl("http://files.slack.com/file.vtt"), false);
  assert.equal(isSlackTranscriptUrl("https://files.slack.com.evil.test/file.vtt"), false);
  assert.equal(isSlackTranscriptUrl("https://example.com/file.vtt"), false);
});

test("completed Slack transcripts use authenticated full VTT instead of a truncated preview", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      headers: new Headers({ "content-type": "text/vtt" }),
      text: async () => "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nComplete long transcript",
    };
  };
  const result = await transcribeSlackAudioFiles([{
    id: "F1",
    name: "voice.m4a",
    transcription: { status: "complete", preview: { content: "Complete…", has_more: true } },
    vtt: "https://files.slack.com/files-tmb/T-F/file.vtt",
  }], { botToken: "xoxb-secret", fetchImpl });

  assert.deepEqual(result, { transcripts: [{ name: "voice.m4a", text: "Complete long transcript" }], failed: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer xoxb-secret");
});

test("missing metadata refreshes files.info and accepts only a complete preview", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        ok: true,
        file: { transcription: { status: "complete", preview: { content: "How are you?", has_more: false } } },
      }),
    };
  };
  const result = await transcribeSlackAudioFiles([{ id: "F1", name: "voice.m4a" }], { botToken: "xoxb-secret", fetchImpl });
  assert.deepEqual(result, { transcripts: [{ name: "voice.m4a", text: "How are you?" }], failed: [] });
  assert.equal(calls[0].url, "https://slack.com/api/files.info");
  assert.match(String(calls[0].options.body), /file=F1/);
});

test("a truncated Slack preview without VTT is not treated as the full transcript", async () => {
  const result = await transcribeSlackAudioFiles([{
    name: "long.m4a",
    transcription: { status: "complete", preview: { content: "partial", has_more: true } },
  }], { botToken: "xoxb-secret", fetchImpl: async () => { throw new Error("unexpected fetch"); } });
  assert.equal(result.transcripts.length, 0);
  assert.match(result.failed[0].reason, /generate transcript|not ready|incomplete/i);
});

test("disabled local Whisper never downloads audio and uses Slack transcripts in order", async () => {
  let downloads = 0;
  const result = await resolveAudioTranscripts([
    { id: "F1", name: "one.m4a" },
    { id: "F2", name: "two.m4a" },
  ], {
    localEnabled: false,
    downloadLocal: async () => { downloads += 1; },
    slackTranscriber: async (files) => ({ transcripts: [{ name: files[0].name, text: files[0].id }], failed: [] }),
  });
  assert.equal(downloads, 0);
  assert.deepEqual(result.transcripts.map((item) => item.text), ["F1", "F2"]);
});

test("local failures fall back to Slack while local successes stay local", async () => {
  let slackCalls = 0;
  const result = await resolveAudioTranscripts([
    { id: "GOOD", name: "good.m4a" },
    { id: "BAD", name: "bad.m4a" },
  ], {
    localEnabled: true,
    downloadLocal: async (file) => ({ ...file, path: `/tmp/${file.id}.m4a` }),
    localTranscriber: async (files) => files[0].id === "GOOD"
      ? { transcripts: [{ name: files[0].name, text: "local text" }], failed: [] }
      : { transcripts: [], failed: [{ name: files[0].name, reason: "Whisper missing" }] },
    slackTranscriber: async (files) => {
      slackCalls += 1;
      return { transcripts: [{ name: files[0].name, text: "Slack text" }], failed: [] };
    },
  });
  assert.equal(slackCalls, 1);
  assert.deepEqual(result.transcripts.map((item) => item.text), ["local text", "Slack text"]);
  assert.equal(result.localFailed[0].name, "bad.m4a");
});
