// `slack_share_file` — the agent-side twin of the file explorer's Share button.
//
// What this file holds down:
//   • a binary file (a PDF) reaches the uploader as its exact BYTES under its real name, in the
//     run's resolved Slack thread, and the share is audited like the explorer's
//   • the uploader receives the descriptor openConfinedFile proved, never a path to reopen
//   • a path outside the channel folder, or a symlink out of it, is refused before any upload
//   • a scheduled run (synthetic thread key) posts top-level instead of an invalid thread_ts
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";

import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();

const { register } = await import("../src/mcp/tools/slack-native.js");

const SLUG = "slack-share-file-test";
const CHANNEL = "C_SHAREFILE";
const WORKDIR = path.join(process.env.CG_WORKSPACE_DIR, "slack", SLUG);
const PDF = Buffer.from("%PDF-1.7\n\x00\xff\xfe binary body\n%%EOF\n", "latin1");
mkdirSync(path.join(WORKDIR, "artifacts"), { recursive: true });
writeFileSync(path.join(WORKDIR, "artifacts", "Contract.pdf"), PDF);
mkdirSync(path.join(scratch, "elsewhere"), { recursive: true });
writeFileSync(path.join(scratch, "elsewhere", "secret.txt"), "not yours");
symlinkSync(path.join(scratch, "elsewhere", "secret.txt"), path.join(WORKDIR, "artifacts", "link.txt"));

function tools({ threadKey = "1790529065.161219", uploads = [] } = {}) {
  const map = new Map();
  register({ registerTool: (name, _schema, handler) => map.set(name, handler) }, {
    channelId: CHANNEL,
    slug: SLUG,
    createdBy: "U_AUTHOR",
    threadKey,
    text: (t) => t,
    loadMeta: async () => ({ platform: "slack", isDM: false }),
    uploadOpenedFile: async (options) => {
      const bytes = await options.handle.readFile();
      uploads.push({ ...options, bytes, fdType: typeof options.handle?.fd });
      return { fileId: "F1", permalink: "https://slack.test/files/F1", bytes: bytes.length };
    },
  });
  return map.get("slack_share_file");
}

test("a PDF reaches Slack as its exact bytes, under its own name, in this thread", async () => {
  const uploads = [];
  const reply = await tools({ uploads })({ path: "artifacts/Contract.pdf", comment: "Signed copy" });
  assert.match(reply, /Shared `Contract\.pdf` in this thread/);
  assert.equal(uploads.length, 1);
  const [u] = uploads;
  assert.deepEqual(u.bytes, PDF, "binary content must arrive byte-for-byte");
  assert.equal(u.filename, "Contract.pdf");
  assert.equal(u.channelId, CHANNEL);
  assert.equal(u.threadTs, "1790529065.161219");
  assert.equal(u.comment, "Signed copy");
  assert.equal(u.fdType, "number", "the uploader gets the proven descriptor, not a path");
  assert.equal(u.filePath, undefined);
});

test("paths outside the folder and symlinks out of it are refused before any upload", async () => {
  const uploads = [];
  const share = tools({ uploads });
  assert.match(await share({ path: "../../elsewhere/secret.txt" }), /^Sharing refused:/);
  assert.match(await share({ path: path.join(scratch, "elsewhere", "secret.txt") }), /^Sharing refused:/);
  assert.match(await share({ path: "artifacts/link.txt" }), /^Sharing refused:/);
  assert.match(await share({ path: "artifacts/missing.pdf" }), /^Sharing refused:/);
  assert.equal(uploads.length, 0);
});

test("a scheduled run posts top-level rather than passing its session key as thread_ts", async () => {
  const uploads = [];
  const reply = await tools({ threadKey: "sched-9f2c1a7b-1700000000.000100", uploads })({ path: "artifacts/Contract.pdf" });
  assert.match(reply, /in the channel/);
  assert.equal(uploads[0].threadTs, "");
});

test("an upload failure is reported, not claimed as shared", async () => {
  const map = new Map();
  register({ registerTool: (name, _s, h) => map.set(name, h) }, {
    channelId: CHANNEL, slug: SLUG, createdBy: "U_AUTHOR", threadKey: "1790529065.161219",
    text: (t) => t, loadMeta: async () => ({ platform: "slack" }),
    uploadOpenedFile: async () => { throw new Error("Slack files.getUploadURLExternal failed: missing_scope"); },
  });
  const reply = await map.get("slack_share_file")({ path: "artifacts/Contract.pdf" });
  assert.match(reply, /^Couldn't share the file: .*missing_scope/);
});

test("the guide routes 'send me the file' to slack_share_file, not a Composio account choice", async () => {
  const { readFile } = await import("node:fs/promises");
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "gateway", "gateway-usage");
  const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
  const replies = await readFile(path.join(root, "platforms", "slack", "writing-replies.md"), "utf8");
  const sharing = await readFile(path.join(root, "references", "sharing-files.md"), "utf8");
  assert.match(skill, /file itself[\s\S]{0,200}slack_share_file/);
  assert.match(skill, /\| Send a file into this thread[^\n]*slack_share_file/);
  assert.match(replies, /## Sending the file itself[\s\S]*slack_share_file[\s\S]*No Composio account/);
  assert.match(sharing, /slack_share_file[\s\S]{0,400}do not route a file for THIS thread through Composio/);
});
