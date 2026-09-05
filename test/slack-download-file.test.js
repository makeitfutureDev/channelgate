// The on-demand Slack attachment download (`slack_download_file`) and the thread-root retry: a
// file the person posted earlier is fetched by id with the bot token into the thread's uploads/
// folder — only when Slack says it is shared in THIS channel, under the shared cap, reused when its
// bytes are already there — and a root attachment carried into a reply is downloaded only while it
// is still missing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
process.env.CG_WORKSPACE_DIR ||= await mkdtemp(path.join(os.tmpdir(), "cg-ws-"));

const download = await import("../src/slack/download.js");
const pipeline = await import("../src/slack/message-pipeline.js");

async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const slackFile = (over = {}) => ({
  id: "F0BV4TU6T5L",
  name: "CleanShot 2026-09-05 at 09.21.10.mp4",
  mimetype: "video/quicktime",
  size: 11,
  url_private_download: "https://files.slack.test/F0BV4TU6T5L/download",
  channels: ["C0BE4F6TR3Q"],
  shares: { public: { C0BE4F6TR3Q: [{ ts: "1788589702.011849" }] } },
  ...over,
});

test("parseSlackFileId accepts a bare id or a pasted Slack file link and refuses anything else", () => {
  assert.equal(download.parseSlackFileId("F0BV4TU6T5L"), "F0BV4TU6T5L");
  assert.equal(download.parseSlackFileId(" f0bv4tu6t5l "), "F0BV4TU6T5L");
  assert.equal(download.parseSlackFileId("https://makeitfuturecom.slack.com/files/U04MC5JQ51B/F0BV4TU6T5L/cleanshot.mp4"), "F0BV4TU6T5L");
  assert.equal(download.parseSlackFileId("https://files.slack.com/files-pri/T04M8FGDHFG-F0BV4TU6T5L/download/x.mp4"), "");
  assert.equal(download.parseSlackFileId("../../etc/passwd"), "");
  assert.equal(download.parseSlackFileId("C0BE4F6TR3Q"), "");
});

test("fetchChannelFile refuses a file Slack does not report as shared in this channel", async () => {
  const call = async (method, params) => {
    assert.equal(method, "files.info");
    assert.equal(params.file, "F0BV4TU6T5L");
    return { ok: true, file: slackFile({ channels: ["C_ELSEWHERE"], shares: { private: { G_OTHER: [] } } }) };
  };
  await assert.rejects(download.fetchChannelFile("C0BE4F6TR3Q", "F0BV4TU6T5L", { call }), (err) => err.code === "ENOTINCHANNEL");
  await assert.rejects(download.fetchChannelFile("", "F0BV4TU6T5L", { call }), /No channel context/);
  await assert.rejects(download.fetchChannelFile("C0BE4F6TR3Q", "not-an-id", { call }), /not a Slack file id/);
  // Shared here (a DM or a private group counts the same way) → the descriptor comes back.
  const okCall = async () => ({ ok: true, file: slackFile({ channels: [], shares: { private: { C0BE4F6TR3Q: [] } } }) });
  const file = await download.fetchChannelFile("C0BE4F6TR3Q", "F0BV4TU6T5L", { call: okCall });
  assert.equal(file.id, "F0BV4TU6T5L");
});

test("downloadChannelFile streams the file into uploads/<thread>/ with the bot token and reuses it next time", async (t) => {
  const root = await scratch(t);
  const fetched = [];
  const fetchImpl = async (url, init) => {
    fetched.push({ url, auth: init?.headers?.Authorization });
    return new Response(Buffer.from("video bytes"), { status: 200, headers: { "content-type": "video/quicktime" } });
  };
  const call = async () => ({ ok: true, file: slackFile() });

  const first = await download.downloadChannelFile({
    channelId: "C0BE4F6TR3Q", fileId: "F0BV4TU6T5L", root, sub: "1788589702.011849", botToken: "xoxb-test", call, fetchImpl,
  });
  assert.equal(first.reused, false);
  assert.equal(first.bytes, 11);
  assert.equal(first.path, path.join(root, "uploads", "1788589702.011849", "F0BV4TU6T5L-CleanShot 2026-09-05 at 09.21.10.mp4"));
  assert.equal(await readFile(first.path, "utf8"), "video bytes");
  assert.deepEqual(fetched, [{ url: "https://files.slack.test/F0BV4TU6T5L/download", auth: "Bearer xoxb-test" }]);

  const second = await download.downloadChannelFile({
    channelId: "C0BE4F6TR3Q", fileId: "F0BV4TU6T5L", root, sub: "1788589702.011849", botToken: "xoxb-test", call, fetchImpl,
  });
  assert.equal(second.reused, true);
  assert.equal(second.path, first.path);
  assert.equal(fetched.length, 1, "a file already in the folder is not downloaded again");
});

test("downloadChannelFile relays an oversize refusal with the size and never writes anything", async (t) => {
  const root = await scratch(t);
  const call = async () => ({ ok: true, file: slackFile({ size: 600 * 1024 * 1024 }) });
  let fetched = 0;
  const result = await download.downloadChannelFile({
    channelId: "C0BE4F6TR3Q", fileId: "F0BV4TU6T5L", root, sub: "t", botToken: "xoxb-test", call, fetchImpl: async () => { fetched += 1; },
  });
  assert.equal(result.skipped, "600 MB exceeds the 500 MB attachment limit");
  assert.equal(fetched, 0);
  await assert.rejects(readdir(path.join(root, "uploads", "t")), { code: "ENOENT" });
});

test("filterCarriedRootFiles retries a root attachment only while it is missing and fits the cap", async (t) => {
  const root = await scratch(t);
  const sub = "1788589702.011849";
  const onDisk = { id: "FONDISK", name: "seen.pdf", size: 10, carriedFrom: "root" };
  await mkdir(path.join(root, "uploads", sub), { recursive: true });
  await writeFile(path.join(root, "uploads", sub, download.attachmentFileName(onDisk)), "already here");
  const files = [
    onDisk,
    { id: "FTOOBIG", name: "huge.mov", size: 600 * 1024 * 1024, carriedFrom: "root" },
    { id: "FMISSING", name: "recording.mp4", size: 253445073, carriedFrom: "root" },
    { id: "FOWN", name: "mine.png", size: 5 }, // attached to the reply itself — always wanted
  ];
  const wanted = await pipeline.filterCarriedRootFiles(files, { root, sub });
  assert.deepEqual(wanted.map((f) => f.id), ["FMISSING", "FOWN"]);
  assert.equal(download.uploadsSubFor("1788589702.011849"), "1788589702.011849");
  assert.equal(download.uploadsSubFor("sched-abc-1788589702"), "__________1788589702"); // every non-digit becomes "_" — the pipeline's long-standing rule
  assert.equal(download.uploadsSubFor(""), "thread");
});
