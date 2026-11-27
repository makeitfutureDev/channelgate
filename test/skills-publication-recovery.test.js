import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const catalog = await import("../src/gateway/skills/catalog.js");
const authoring = await import("../src/gateway/skills/authoring.js");
const publishing = await import("../src/gateway/skills/publish.js");
const { migrations } = await import("../src/db/migrations.js");
const { getSettings, saveSettings } = await import("../src/config/settings.js");
const { setUser } = await import("../src/config/store.js");
const { register } = await import("../src/mcp/tools/skills.js");

const files = (slug, version) => [{ path: "SKILL.md", content: `---\nname: ${slug}\ndescription: Disposable publication recovery fixture\nversion: ${version}\n---\nReply ${version}.\n` }];
const success = async (_url, init = {}) => (init.method || "GET") === "GET"
  ? new Response("", { status: 404 })
  : new Response(JSON.stringify({ commit: { sha: "published" } }), { status: 200 });
const failure = async () => new Response("simulated outage", { status: 500 });

async function fixture(slug, run) {
  const settings = getSettings();
  const source = catalog.addSource({ kind: "git", url: `https://github.com/example/${slug}`, mode: "auto" });
  saveSettings({ skillsPublishRepo: source.url, skillsPublishGithubToken: "fake-test-token", skillsPublishMode: "commit" });
  catalog.putSkillRevision({ slug, files: files(slug, 1), ownerKind: "git", sourceId: source.id, sourcePath: `skills/${slug}`, status: "active" });
  const update = (version, fetchImpl = success) => authoring.updateLocalSkill({ skill: catalog.getSkill(slug), files: files(slug, version), fetchImpl });
  try { await run({ source, update, skill: () => catalog.getSkill(slug) }); }
  finally {
    saveSettings({ skillsPublishRepo: settings.skillsPublishRepo, skillsPublishGithubToken: settings.skillsPublishGithubToken, skillsPublishMode: settings.skillsPublishMode });
    catalog.removeSource(source.id);
  }
}

test("publication retry clears only its recovery pin, restores published bytes after sync, then follows future source updates", async () => {
  await fixture("retry-recovery", async ({ source, update, skill }) => {
    const good = await update(2);
    assert.equal(good.pinned, false);
    assert.equal(skill().pinReason, "");
    const saved = await update(3, failure);
    assert.equal(saved.pinned, true);
    assert.equal(skill().pinReason, "publication");
    catalog.putSkillRevision({ slug: skill().slug, files: files(skill().slug, 1), ownerKind: "git", sourceId: source.id, sourcePath: skill().sourcePath, sourceRef: "stale-source", status: "active" });
    assert.equal(catalog.effectiveRevisionFor(skill()).id, saved.revision.id);
    const published = await publishing.publishRevision({ slug: skill().slug, fetchImpl: success });
    assert.equal(published.publicationPinCleared, true);
    assert.equal(skill().pinnedRevisionId, null);
    assert.equal(skill().currentRevisionId, saved.revision.id);
    assert.match(catalog.skillBundle(skill()).files.find((f) => f.path === "SKILL.md").content.toString(), /Reply 3/);
    catalog.putSkillRevision({ slug: skill().slug, files: files(skill().slug, 4), ownerKind: "git", sourceId: source.id, sourcePath: skill().sourcePath, sourceRef: "new-source", status: "active" });
    assert.equal(catalog.effectiveRevisionFor(skill()).version, "4");
  });
});

test("a later successful update clears a recovery pin without another manual unpin", async () => {
  await fixture("update-recovery", async ({ update, skill }) => {
    await update(2, failure);
    const result = await update(3);
    assert.equal(result.published.publicationPinCleared, true);
    assert.equal(result.pinned, false);
    assert.equal(skill().currentRevisionId, result.revision.id);
  });
});

test("retrying identical update bytes retries pending publication without adding a revision", async () => {
  await fixture("identical-recovery", async ({ update, skill }) => {
    const first = await update(2, failure);
    const failedRetry = await update(2, failure);
    assert.equal(failedRetry.changed, false);
    assert.equal(failedRetry.published.failed, true);
    const retry = await update(2);
    assert.equal(retry.changed, false);
    assert.equal(retry.published.publicationPinCleared, true);
    assert.equal(skill().currentRevisionId, first.revision.id);
    assert.equal(skill().pinnedRevisionId, null);
    assert.equal(catalog.listRevisions(skill().id).length, 2);
  });
});

for (const reason of ["manual", "proposal"]) {
  test(`publication and later updates preserve ${reason} pins`, async () => {
    await fixture(`${reason}-recovery`, async ({ update, skill }) => {
      catalog.pinSkill(skill().slug, 1, { reason });
      const failed = await update(2, failure);
      assert.equal(skill().pinReason, reason);
      assert.equal(skill().pinnedRevisionId, failed.revision.id);
      const result = await publishing.publishRevision({ slug: skill().slug, fetchImpl: success });
      assert.equal(result.publicationPinCleared, false);
      assert.equal(skill().pinReason, reason);
      const next = await update(3);
      assert.equal(skill().pinnedRevisionId, next.revision.id);
      assert.equal(skill().pinReason, reason);
      catalog.pinSkill(skill().slug, null);
      assert.equal(skill().pinReason, "");
    });
  });
}

test("a manual pin selected while publication is running is never cleared or replaced", async () => {
  await fixture("operator-race", async ({ update, skill }) => {
    await update(2, failure);
    const pinned = skill().pinnedRevisionId;
    await publishing.publishRevision({ slug: skill().slug, fetchImpl: async (url, init) => {
      catalog.pinSkill(skill().slug, 1);
      return success(url, init);
    } });
    assert.notEqual(skill().pinnedRevisionId, pinned);
    assert.equal(skill().pinReason, "manual");
    assert.equal(catalog.effectiveRevisionFor(skill()).revisionNo, 1);
  });
});

test("an older failed attempt cannot pin over a newer successfully published update", async () => {
  await fixture("failed-attempt-race", async ({ update, skill }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = update(2, async () => { await gate; return failure(); });
    const next = await update(3);
    release();
    await first;
    assert.equal(skill().pinnedRevisionId, null);
    assert.equal(skill().currentRevisionId, next.revision.id);
  });
});

test("an older successful publication cannot clear a newer failed edit's recovery pin", async () => {
  await fixture("successful-attempt-race", async ({ update, skill }) => {
    await update(2, failure);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const retry = publishing.publishRevision({ slug: skill().slug, fetchImpl: async (url, init) => { await gate; return success(url, init); } });
    const next = await update(3, failure);
    release();
    const result = await retry;
    assert.equal(result.publicationPinCleared, false);
    assert.equal(skill().pinnedRevisionId, next.revision.id);
    assert.equal(skill().pinReason, "publication");
  });
});

test("migration 42 preserves legacy pins without guessing their origin", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE skills (id INTEGER PRIMARY KEY, pinned_revision_id INTEGER); INSERT INTO skills VALUES(1, 7), (2, NULL)");
    migrations.find((m) => m.version === 42).up(db);
    assert.deepEqual({ ...db.prepare("SELECT * FROM skills WHERE id = 1").get() }, { id: 1, pinned_revision_id: 7, pin_reason: "manual" });
  } finally { db.close(); }
});

for (const engine of ["claude", "codex"]) {
  test(`${engine} gateway metadata explicitly distinguishes no pin, publication recovery and manual pins`, async () => {
    await fixture(`metadata-${engine}`, async ({ update, skill }) => {
      await setUser("U_RECOVERY_ADMIN", { role: "admin" });
      const tools = new Map();
      register({ registerTool: (name, _def, handler) => tools.set(name, handler) }, {
        engine, channelId: "C_RECOVERY", slug: "recovery", createdBy: "U_RECOVERY_ADMIN",
        text: (text) => ({ content: [{ type: "text", text }] }),
        requireAdmin: async () => true, requireManage: async () => true, loadMeta: async () => ({ channelId: "C_RECOVERY" }),
      });
      const info = async () => (await tools.get("get_skill_info")({ skill: skill().slug })).content[0].text;
      assert.match(await info(), /Pin: none \(following current\)/);
      await update(2, failure);
      assert.match(await info(), /Pin: publication recovery/);
      assert.match(await info(), /Current revision: #2/);
      assert.match(await info(), /Effective revision: #2 \(pinned\)/);
      await publishing.publishRevision({ slug: skill().slug, fetchImpl: success });
      assert.match(await info(), /Pin: none \(following current\)/);
      catalog.pinSkill(skill().slug, 1);
      assert.match(await info(), /Pin: manual or legacy/);
      assert.match(await info(), /Effective revision: #1 \(pinned\)/);
    });
  });
}
