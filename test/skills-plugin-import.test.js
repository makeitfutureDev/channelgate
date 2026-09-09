import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";
ensureTestEnv();
const { buildPluginSkill, parsePluginPackage } = await import("../src/gateway/skills/plugin-package.js");
const { discoverSkills } = await import("../src/gateway/skills/git-sync.js");
const { importSkillTree } = await import("../src/gateway/skills/import-folder.js");
const { hashSkillFiles } = await import("../src/gateway/skills/files.js");
const f = (path, content) => ({ path, content: Buffer.from(typeof content === "string" ? content : JSON.stringify(content)) });
const plugin = () => [f(".claude-plugin/plugin.json", { name: "sample", description: "Sample package", hooks: "./hooks/hooks.json" }), f("skills/hello/SKILL.md", "---\nname: hello\ndescription: hello\n---\nHello"), f("hooks/hooks.json", { hooks: {} }), f("assets/image.bin", "\0binary")];

test("plugin is one lossless revision with validated metadata and component paths", () => {
  const original = plugin();
  const bundle = buildPluginSkill(original);
  const parsed = parsePluginPackage(bundle);
  assert.equal(parsed.name, "sample");
  assert.deepEqual(parsed.components.skills, ["skills"]);
  assert.deepEqual(parsed.components.hooks, ["hooks/hooks.json"]);
  for (const file of original) assert.deepEqual(parsed.files.find((x) => x.path === file.path).content, file.content);
  assert.equal(bundle.filter((x) => x.path === "SKILL.md").length, 1);
  assert.equal(parsePluginPackage([f("SKILL.md", "---\nname: ordinary\ndescription: plain\n---")]), null);
});

test("plugin discovery suppresses nested skills and includes root manifests", () => {
  const map = new Map(plugin().map((x) => [x.path, { content: x.content, mode: 0o644 }]));
  assert.equal(discoverSkills(map).length, 1);
  const nested = new Map([...map].map(([p, v]) => [`plugins/sample/${p}`, v]));
  nested.set("plain/SKILL.md", { content: Buffer.from("plain"), mode: 0o644 });
  assert.deepEqual(discoverSkills(nested).map((s) => s.dir), ["plugins/sample", "plain"]);
});

test("malformed, escaping, incomplete and oversized plugin packages fail atomically", () => {
  for (const manifest of ["{", { name: "bad", skills: "../outside" }, { name: "bad", skills: "/etc" }, { name: "bad", skills: "https://example.com" }, { name: "bad", skills: "missing" }]) {
    assert.throws(() => buildPluginSkill([f(".codex-plugin/plugin.json", manifest)]));
  }
  const files = plugin();
  files.push(f("huge.bin", Buffer.alloc(2 * 1024 * 1024 + 1).toString()));
  assert.throws(() => discoverSkills(new Map(files.map((x) => [x.path, { content: x.content, mode: 0o644 }]))), /exceeds/);
});

test("folder source accepts root or child package and rejects package symlinks", async () => {
  const root = await tempDir("plugin-folder");
  for (const file of plugin()) {
    const target = path.join(root, "sample", file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  const first = await importSkillTree(root);
  assert.deepEqual(first.presentSlugs, ["sample"]);
  assert.deepEqual((await importSkillTree(path.join(root, "sample"))).presentSlugs, ["sample"]);
  await symlink("/etc/passwd", path.join(root, "sample", "linked"));
  const failed = await importSkillTree(root);
  assert.match(failed.errors[0].error, /symlinks/);
  assert.deepEqual(failed.presentSlugs, []);
});

test("executable permission changes produce distinct revision hashes", () => {
  const file = f("script.sh", "echo ok");
  assert.notEqual(hashSkillFiles([file]), hashSkillFiles([{ ...file, executable: true }]));
});

test("failed plugin sync preserves the last approved package", async () => {
  const { gzipSync } = await import("node:zlib");
  const { addSource, getSkill } = await import("../src/gateway/skills/catalog.js");
  const { syncGitSource } = await import("../src/gateway/skills/git-sync.js");
  const tarball = (files) => gzipSync(Buffer.concat([...files.map((file) => {
    const header = Buffer.alloc(512);
    header.write(`repo-sha/${file.path}`);
    header.write("0000644\0", 100);
    header.write(`${file.content.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    return Buffer.concat([header, file.content, Buffer.alloc((512 - file.content.length % 512) % 512)]);
  }), Buffer.alloc(1024)]));
  const fetcher = (files) => async (url) => url.includes("tarball") ? { ok: true, arrayBuffer: async () => tarball(files) } : { ok: true, json: async () => ({ sha: "1234567" }) };
  const src = addSource({ kind: "git", url: "https://github.com/example/plugin-fixture", mode: "auto" });
  const original = plugin().map((file) => file.path.endsWith("plugin.json") ? f(file.path, { name: "last-good-package", description: "Fixture" }) : file);
  assert.equal((await syncGitSource(src, { fetchImpl: fetcher(original) })).ok, true);
  const before = getSkill("last-good-package");
  const invalid = original.map((file) => file.path.endsWith("plugin.json") ? f(file.path, "{") : file);
  const failed = await syncGitSource(src, { fetchImpl: fetcher(invalid) });
  assert.equal(failed.ok, false);
  const after = getSkill("last-good-package");
  assert.equal(after.deleted, false);
  assert.equal(after.activeRevisionId, before.activeRevisionId);
});

test("manifest edits regenerate catalog metadata and cannot disguise a plugin as a plain skill", async () => {
  const { putSkillRevision, getSkill } = await import("../src/gateway/skills/catalog.js");
  const bundle = buildPluginSkill([f(".claude-plugin/plugin.json", { name: "metadata-plugin", description: "Before" })]);
  const saved = putSkillRevision({ files: bundle });
  const edited = bundle.map((file) => file.path === "SKILL.md" ? f(file.path, "---\nname: disguised\ndescription: spoof\n---") : f(file.path, { name: "metadata-plugin", description: "After" }));
  putSkillRevision({ slug: saved.skill.slug, files: edited });
  assert.equal(getSkill("metadata-plugin").description, "After");
  assert.equal(getSkill("metadata-plugin").meta.plugin.kind, "plugin");
  assert.throws(() => putSkillRevision({ slug: saved.skill.slug, files: [f("SKILL.md", "---\nname: ordinary\ndescription: no manifest\n---")] }), /retain its package manifest/);
});

test("publishing and moving plugins writes original package paths and preserves unrelated files", async () => {
  const { saveSettings } = await import("../src/config/settings.js");
  const { putSkillRevision, addSource, getSkill } = await import("../src/gateway/skills/catalog.js");
  const { publishRevision, moveSkillFiles } = await import("../src/gateway/skills/publish.js");
  saveSettings({ skillsPublishGithubToken: "fixture", skillsPublishRepo: "example/plugin-publish", skillsPublishSubpath: "skills", skillsPublishMode: "commit" });
  const source = addSource({ kind: "git", url: "https://github.com/example/plugin-publish", mode: "auto" });
  putSkillRevision({ files: buildPluginSkill([f(".codex-plugin/plugin.json", { name: "publish-plugin" }), f("obsolete.txt", "previously owned")]) });
  putSkillRevision({ files: buildPluginSkill([f(".codex-plugin/plugin.json", { name: "publish-plugin" }), f("skills/a/SKILL.md", "Instructions")]) });
  const remote = new Map([["skills/publish-plugin/unrelated.txt", "keep"], ["skills/publish-plugin/obsolete.txt", "previously owned"]]);
  const fetchImpl = async (url, init = {}) => {
    const p = decodeURIComponent(new URL(url).pathname.split("/contents/")[1] || "");
    let payload;
    let status = 200;
    if (init.method === "PUT") { remote.set(p, Buffer.from(JSON.parse(init.body).content, "base64").toString()); payload = { commit: { sha: "written" } }; }
    else if (init.method === "DELETE") { remote.delete(p); payload = { commit: { sha: "deleted" } }; }
    else {
      const children = [...remote.keys()].filter((key) => !p || key.startsWith(`${p}/`));
      const entries = new Map();
      for (const key of children) {
        const rest = p ? key.slice(p.length + 1) : key;
        const dir = rest.split("/")[0];
        if (rest.includes("/")) entries.set(dir, { type: "dir", path: p ? `${p}/${dir}` : dir });
        else entries.set(rest, { type: "file", path: key, sha: "old" });
      }
      payload = [...entries.values()];
      if (!payload.length) status = 404;
    }
    return { ok: status < 400, status, text: async () => JSON.stringify(payload) };
  };
  const published = await publishRevision({ slug: "publish-plugin", fetchImpl });
  assert.equal(published.adopted, true);
  assert.deepEqual([...remote.keys()].sort(), ["skills/publish-plugin/.codex-plugin/plugin.json", "skills/publish-plugin/skills/a/SKILL.md", "skills/publish-plugin/unrelated.txt"]);
  assert.equal(getSkill("publish-plugin").ownerKind, "git");
  await publishRevision({ slug: "publish-plugin", fetchImpl });
  const moved = await moveSkillFiles({ slug: "publish-plugin", channelId: "C_PLUGIN_MOVE", fetchImpl });
  assert.equal(moved.moved, true);
  assert.ok(remote.has("channels/C_PLUGIN_MOVE/publish-plugin/.codex-plugin/plugin.json"));
  assert.deepEqual([...remote.keys()].filter((p) => p.startsWith("skills/publish-plugin/")), ["skills/publish-plugin/unrelated.txt"]);
  assert.ok(![...remote.keys()].some((p) => p.includes("/package/")));
  // A repository-root package stays at root on publish and survives a move into a child.
  remote.clear();
  remote.set("unrelated/keep.txt", "keep");
  putSkillRevision({ files: buildPluginSkill([f(".claude-plugin/plugin.json", { name: "root-publish-plugin" })]), ownerKind: "git", sourceId: source.id, sourcePath: "." });
  await publishRevision({ slug: "root-publish-plugin", fetchImpl });
  assert.deepEqual([...remote.keys()].sort(), [".claude-plugin/plugin.json", "unrelated/keep.txt"]);
  await moveSkillFiles({ slug: "root-publish-plugin", channelId: "C_PLUGIN_ROOT", fetchImpl });
  assert.ok(remote.has("channels/C_PLUGIN_ROOT/root-publish-plugin/.claude-plugin/plugin.json"));
  assert.ok(!remote.has(".claude-plugin/plugin.json"));
  assert.ok(remote.has("unrelated/keep.txt"));
  putSkillRevision({ files: buildPluginSkill([f(".claude-plugin/plugin.json", { name: "executable-publish" }), { ...f("run.sh", "echo ok"), executable: true }]) });
  await assert.rejects(() => publishRevision({ slug: "executable-publish", fetchImpl }), /mode-preserving/);
});


test("folder plugins derive manifest slugs just like Git sources", async () => {
  const root = await tempDir("plugin-slug");
  const dir = path.join(root, "Different Folder Name");
  await mkdir(path.join(dir, ".codex-plugin"), { recursive: true });
  await writeFile(path.join(dir, ".codex-plugin/plugin.json"), JSON.stringify({ name: "manifest-slug-fixture" }));
  const result = await importSkillTree(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.presentSlugs, ["manifest-slug-fixture"]);
  const again = await importSkillTree(dir);
  assert.deepEqual(again.presentSlugs, ["manifest-slug-fixture"]);
  assert.equal(again.unchanged.length, 1);
});
