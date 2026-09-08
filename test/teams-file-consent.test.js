import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { createTeamsFileConsent } = await import("../src/platforms/msteams/file-consent.js");
const root = await mkdtemp(path.join(os.tmpdir(), "cg-teams-files-"));
after(() => rm(root, { recursive: true, force: true }));
await writeFile(path.join(root, "report.txt"), "snapshot");
function fixture() {
  let time = 1000, allowed = true;
  const posts = [], uploads = [], auths = [];
  const source = { message: { userId: "29:user", conversationId: "teams:19:group@thread.v2", rawConversationId: "19:group@thread.v2", kind: "group" }, entry: { slug: "files" }, sessionKey: "group:1", relative: "report.txt" };
  const connector = { openDm: async () => "a:personal", api: { sendActivity: async (conversationId, body) => { posts.push({ conversationId, body }); return { messageId: "card" }; } } };
  const consent = createTeamsFileConsent({ connector, now: () => time,
    authorizeWorkspace: async input => { auths.push(input); if (!allowed) throw new Error("revoked"); return { root }; },
    fetchImpl: async (url, init) => { uploads.push({ url, init }); return { status: 201 }; },
  });
  const activity = id => ({ type: "invoke", name: "fileConsent/invoke", from: { id: "29:user" }, conversation: { id: "a:personal" },
    value: { type: "fileUpload", action: "accept", context: { id }, uploadInfo: { uploadUrl: "https://contoso.sharepoint.com/upload", contentUrl: "https://contoso.sharepoint.com/report.txt", uniqueId: "item-id", name: "report.txt" } } });
  return { consent, source, posts, uploads, auths, activity, revoke: () => { allowed = false; }, expire: () => { time += 600001; }, connector };
}
test("group file consent opens only author DM and uploads original snapshot after accept", async () => {
  const f = fixture();
  try {
    const sent = await f.consent.send(f.source);
    assert.equal(f.posts[0].conversationId, "a:personal");
    const card = f.posts[0].body.attachments[0];
    assert.equal(card.contentType, "application/vnd.microsoft.teams.card.file.consent");
    assert.equal(card.content.sizeInBytes, 8);
    await writeFile(path.join(root, "report.txt"), "changed-file");
    assert.equal((await f.consent.handle(f.activity(sent.id))).status, 200);
    await f.consent.drain();
    assert.equal(f.uploads[0].init.body.toString(), "snapshot");
    assert.deepEqual(f.uploads[0].init.headers, { "Content-Type": "application/octet-stream", "Content-Length": "8", "Content-Range": "bytes 0-7/8" });
    assert.equal(f.uploads[0].init.redirect, "error");
    assert.equal(f.auths.length, 2);
    assert.equal(f.posts[1].body.attachments[0].contentType, "application/vnd.microsoft.teams.card.file.info");
    assert.equal((await f.consent.handle(f.activity(sent.id))).status, 410);
  } finally { f.consent.stop(); await writeFile(path.join(root, "report.txt"), "snapshot"); }
});
test("forged actors, conversations and upload destinations do not consume real consent", async () => {
  const f = fixture();
  try {
    const { id } = await f.consent.send(f.source);
    const actor = f.activity(id); actor.from.id = "29:other"; actor.value.actorId = "29:user";
    assert.equal((await f.consent.handle(actor)).status, 403);
    const other = f.activity(id); other.conversation.id = "a:other";
    assert.equal((await f.consent.handle(other)).status, 403);
    for (const url of ["https://evil.example/upload", "http://contoso.sharepoint.com/upload", "https://user:password@contoso.sharepoint.com/upload"]) {
      const malicious = f.activity(id); malicious.value.uploadInfo.uploadUrl = url;
      assert.equal((await f.consent.handle(malicious)).status, 400);
    }
    const results = await Promise.all([f.consent.handle(f.activity(id)), f.consent.handle(f.activity(id))]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 410]);
    await f.consent.drain();
    assert.equal(f.uploads.length, 1);
  } finally { f.consent.stop(); }
});
test("revocation, decline and expiry prevent upload", async () => {
  for (const action of ["revoke", "decline", "expire"]) {
    const f = fixture();
    try {
      const { id } = await f.consent.send(f.source);
      const input = f.activity(id);
      if (action === "revoke") f.revoke();
      if (action === "expire") f.expire();
      if (action === "decline") input.value.action = "decline";
      assert.equal((await f.consent.handle(input)).status, { revoke: 403, decline: 200, expire: 410 }[action]);
      assert.equal(f.uploads.length, 0);
    } finally { f.consent.stop(); }
  }
});
test("escaped, oversize and empty files are refused before consent", async () => {
  const f = fixture();
  await symlink(os.tmpdir(), path.join(root, "escape"));
  await writeFile(path.join(root, "large.bin"), "");
  await truncate(path.join(root, "large.bin"), 10 * 1024 * 1024 + 1);
  await writeFile(path.join(root, "empty.txt"), "");
  try {
    for (const relative of ["../outside.txt", "escape", "large.bin", "empty.txt"]) await assert.rejects(f.consent.send({ ...f.source, relative }));
    assert.equal(f.posts.length, 0);
  } finally { f.consent.stop(); }
});
test("ten pending snapshots cap memory and expiry allows a fresh request", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 10; i++) await f.consent.send(f.source);
    await assert.rejects(f.consent.send(f.source), /Too many/);
    f.expire();
    await f.consent.send(f.source);
    assert.equal(f.posts.length, 11);
  } finally { f.consent.stop(); }
});
test("uncertain upload is consumed before network effects and is never retried", async () => {
  const f = fixture();
  const consent = createTeamsFileConsent({ connector: f.connector, authorizeWorkspace: async () => ({ root }), fetchImpl: async () => { throw new Error("network error"); } });
  try {
    const { id } = await consent.send(f.source);
    assert.equal((await consent.handle(f.activity(id))).status, 200);
    await consent.drain();
    assert.match(f.posts.at(-1).body.text, /outcome could not be confirmed/);
    assert.equal((await consent.handle(f.activity(id))).status, 410);
  } finally { consent.stop(); f.consent.stop(); }
});

test("invoke acknowledges while upload waits, and disconnect aborts without replay", async () => {
  const f = fixture();
  let started = false, aborted = false;
  const consent = createTeamsFileConsent({ connector: f.connector, authorizeWorkspace: async () => ({ root }), fetchImpl: async (_url, init) => {
    started = true;
    await new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }); });
  } });
  try {
    const { id } = await consent.send(f.source);
    assert.equal((await consent.handle(f.activity(id))).status, 200);
    assert.equal(started, true);
    assert.equal(f.posts.length, 1, "consent response did not await upload completion");
    assert.equal((await consent.handle(f.activity(id))).status, 410);
    consent.stop();
    await consent.drain();
    assert.equal(aborted, true);
    assert.equal(f.posts.at(-1).conversationId, "a:personal");
    assert.match(f.posts.at(-1).body.text, /will not be retried automatically/);
  } finally { consent.stop(); f.consent.stop(); }
});
