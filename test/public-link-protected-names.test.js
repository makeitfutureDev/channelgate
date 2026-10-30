// Protected names never leave the channel (security audit 2026-10-23, batch 2). The export
// door (`openConfinedFile`) refuses hidden files and directories anywhere in the path, the managed
// `.claude` tree and credential-shaped names — for BOTH public-link purposes, for `slack_share_file`
// and for Composio staging, and for a link that was minted before the rule. The physical path of the
// opened descriptor is checked too, so an internal symlinked directory cannot launder one.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { isProtectedExportPath, isProtectedWritePath } = await import("../src/slack/file-explorer.js");
const { openConfinedFile } = await import("../src/gateway/confined-file.js");
const { register: registerSharing } = await import("../src/mcp/tools/file-sharing.js");
const { register: registerSlack } = await import("../src/mcp/tools/slack-native.js");
const { createPublicFileLink } = await import("../src/gateway/public-file-links.js");
const { createPublicFileRouter } = await import("../src/web/public-files.js");
const { saveSettings } = await import("../src/config/settings.js");
const { upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");

const CHANNEL = "C_PROTECTED_EXPORT";
const entry = await upsertChannelEntry(CHANNEL, { name: "protected-export", type: "channel", isDM: false });
const SLUG = entry.slug;
await saveChannelMeta(SLUG, { channelId: CHANNEL, platform: "slack" });
const ROOT = path.join(process.env.CG_WORKSPACE_DIR, "slack", SLUG);
for (const dir of ["work", ".claude", ".git", "docs", ".github/workflows"]) mkdirSync(path.join(ROOT, dir), { recursive: true });
writeFileSync(path.join(ROOT, "work", "REPORT.md"), "# fine\n");
writeFileSync(path.join(ROOT, ".env"), "SECRET=1\n");
writeFileSync(path.join(ROOT, ".env.local"), "SECRET=2\n");
writeFileSync(path.join(ROOT, ".claude", "settings.json"), "{}\n");
writeFileSync(path.join(ROOT, ".git", "config"), "[core]\n");
writeFileSync(path.join(ROOT, "work", "service-account-credentials.json"), "{}\n");
writeFileSync(path.join(ROOT, "work", "server.pem"), "---\n");
writeFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "on: push\n");
// An internal symlinked DIRECTORY: the relative path looks innocent, the bytes are .claude's.
symlinkSync(path.join(ROOT, ".claude"), path.join(ROOT, "docs", "cfg"));

test("the export predicate refuses hidden, managed and credential-shaped paths and nothing else", () => {
  for (const bad of [".env", ".env.local", ".claude/settings.json", ".git/config", ".github/workflows/ci.yml", "work/service-account-credentials.json", "work/server.pem", "work/.hidden/x.txt", "CLAUDE.md", "id_rsa", "", "..", "../x"]) {
    assert.equal(isProtectedExportPath(bad), true, bad);
  }
  for (const fine of ["work/REPORT.md", "README.md", "src/index.js", "data/export.csv", "build/app.zip"]) {
    assert.equal(isProtectedExportPath(fine), false, fine);
  }
  // The WRITE policy is unchanged: .env stays editable in the explorer, it just cannot be exported.
  assert.equal(isProtectedWritePath(".env"), false);
  // The lenient form (slack_share_file, Composio staging, mail attachments, the Slack footer
  // download) still refuses every hidden path and credential-shaped file, but lets the channel's
  // instruction/memory files and a report that merely mentions a token through.
  for (const bad of [".env", ".claude/settings.json", ".git/config", "work/.hidden/x.txt", "work/server.pem", "work/credentials.json", "id_rsa", "", ".."]) {
    assert.equal(isProtectedExportPath(bad, { strict: false }), true, `lenient refuses ${bad}`);
  }
  for (const fine of ["CLAUDE.md", "AGENTS.md", "MEMORY.md", "reports/token-usage.csv", "secrets-rotation-plan.md", "work/REPORT.md"]) {
    assert.equal(isProtectedExportPath(fine, { strict: false }), false, `lenient allows ${fine}`);
    assert.equal(isProtectedExportPath(fine), fine === "work/REPORT.md" ? false : true, `strict decides ${fine}`);
  }
});

test("openConfinedFile's lenient door lets MEMORY.md out but never a hidden or credential-shaped file", async () => {
  writeFileSync(path.join(ROOT, "MEMORY.md"), "# memory\n");
  const ok = await openConfinedFile(ROOT, "MEMORY.md", { protectedNames: "lenient" });
  await ok.handle.close();
  await assert.rejects(() => openConfinedFile(ROOT, "MEMORY.md"), /protected file/);
  for (const bad of [".env", "docs/cfg/settings.json", "work/server.pem"]) {
    await assert.rejects(() => openConfinedFile(ROOT, bad, { protectedNames: "lenient" }), /protected file/, bad);
  }
});

test("openConfinedFile refuses protected names by requested path AND by physical path", async () => {
  for (const bad of [".env", ".claude/settings.json", "docs/cfg/settings.json", "work/server.pem"]) {
    await assert.rejects(() => openConfinedFile(ROOT, bad), /protected file .* cannot leave this channel/, bad);
  }
  const ok = await openConfinedFile(ROOT, "work/REPORT.md");
  assert.equal(ok.relative, "work/REPORT.md");
  assert.ok(ok.rootReal);
  await ok.handle.close();
  // Internal consumers can opt out explicitly; exports never do.
  const internal = await openConfinedFile(ROOT, ".env", { protectedNames: false });
  await internal.handle.close();
});

function sharingTools() {
  const map = new Map();
  registerSharing({ registerTool: (name, _schema, handler) => map.set(name, handler) }, {
    channelId: CHANNEL, slug: SLUG, createdBy: "U_AUTHOR", text: (t) => ({ content: [{ type: "text", text: t }] }),
    loadMeta: async () => ({ platform: "slack", isDM: false, composioToken: "ck_test" }),
    stageFile: async () => { throw new Error("staging must not be reached for a protected file"); },
  });
  return map;
}

test("create_public_file_link refuses protected names for BOTH purposes; ordinary files still link", async () => {
  saveSettings({ publicFileLinksEnabled: true, publicUrl: "https://gateway.example.com" });
  const create = sharingTools().get("create_public_file_link");
  for (const purpose of ["upload", "share"]) {
    for (const bad of [".env", ".claude/settings.json", "docs/cfg/settings.json", ".github/workflows/ci.yml", "work/service-account-credentials.json"]) {
      const result = await create({ path: bad, purpose, minutes: 10 });
      assert.match(result.content[0].text, /^Public link refused: .*protected file/, `${purpose} ${bad}`);
    }
  }
  const ok = await create({ path: "work/REPORT.md", purpose: "upload" });
  assert.match(ok.content[0].text, /Public link for `work\/REPORT\.md`/);
  saveSettings({ publicFileLinksEnabled: false, publicUrl: "" });
});

test("stage_file_for_composio and slack_share_file refuse protected names before any delivery", async () => {
  const stage = sharingTools().get("stage_file_for_composio");
  const staged = await stage({ path: ".env", tool: "GOOGLEDRIVE_UPLOAD_FILE", identity: "agent" });
  assert.match(staged.content[0].text, /^Staging refused: .*protected file/);

  const slack = new Map();
  registerSlack({ registerTool: (name, _schema, handler) => slack.set(name, handler) }, {
    channelId: CHANNEL, slug: SLUG, createdBy: "U_AUTHOR", threadKey: "1790529065.161219", text: (t) => t,
    loadMeta: async () => ({ platform: "slack", isDM: false }),
    uploadOpenedFile: async () => { throw new Error("upload must not be reached for a protected file"); },
  });
  for (const bad of [".env", ".claude/settings.json", "docs/cfg/settings.json"]) {
    assert.match(await slack.get("slack_share_file")({ path: bad }), /^Sharing refused: .*protected file/, bad);
  }
});

test("a link minted for a protected name before the rule stops serving", async (t) => {
  const app = express();
  app.use("/f", createPublicFileRouter({ enabled: () => true, audit: async () => {}, resolveRoot: async () => ROOT }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const old = createPublicFileLink({ channelId: CHANNEL, slug: SLUG, relative: ".env", filename: ".env", purpose: "share", minutes: 60, createdBy: "U1" });
  assert.equal((await fetch(`${base}/f/${old.token}`)).status, 404);
  assert.equal((await fetch(`${base}/f/${old.token}`, { method: "HEAD" })).status, 404);
  const fine = createPublicFileLink({ channelId: CHANNEL, slug: SLUG, relative: "work/REPORT.md", filename: "REPORT.md", purpose: "share", minutes: 60, createdBy: "U1" });
  assert.equal((await fetch(`${base}/f/${fine.token}`)).status, 200);
});
