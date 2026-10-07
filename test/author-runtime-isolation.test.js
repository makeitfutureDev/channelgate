import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
process.env.PATH = `${fileURLToPath(new URL("./fixtures", import.meta.url))}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { operatorHomeGranted } = await import("../src/runtimes/container/lifecycle.js");
const { channelArtifactDir, runtimeArtifactsRoot } = await import("../src/config/paths.js");
const { createSessionPool } = await import("../src/engines/session-pool.js");
const { carrySession } = await import("../src/gateway/session-carry.js");

const settings = { fullAccessHome: true, egressMode: "proxy", image: "test-author-isolation" };
const meta = { platform: "slack", channelId: "C_AUTHOR_ISOLATION", adminMode: true, autoMode: true };
const resolve = (options = {}, channelMeta = meta) => resolveRuntime("author-isolation", channelMeta, { settings, ...options });
const contains = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};

test("Admin channels expose the operator home only to a live trusted admin author", () => {
  const admin = resolve({ isAdminAuthor: true });
  assert.equal(admin.runtimeScope, "admin");
  assert.equal(operatorHomeGranted(admin), true);
  assert.equal(admin.container.mounts.filter((mount) => mount.kind === "operator-home").length, 1);
  for (const options of [{}, { isAdminAuthor: false }, { isAdminAuthor: "true" }, { isAdminAuthor: 1 }]) {
    const member = resolve(options);
    assert.equal(member.runtimeScope, "project");
    assert.equal(operatorHomeGranted(member), false);
    assert.equal(member.container.mounts.some((mount) => mount.kind === "operator-home"), false);
  }
});

test("stored metadata cannot forge the trusted author or privileged storage lane", () => {
  const forged = {
    ...meta, isAdmin: true, isAdminAuthor: true, trustedAdminAuthor: true,
    runtimeScope: "admin", principal: { isAdmin: true }, sudoMode: true,
  };
  const member = resolve({}, JSON.parse(JSON.stringify(forged)));
  assert.equal(member.backend, "container");
  assert.equal(member.runtimeScope, "project");
  assert.equal(operatorHomeGranted(member), false);
  assert.equal(member.container.mounts.some((mount) => mount.kind === "operator-home"), false);
});

test("trusted admin home access still requires Admin mode and the boolean gateway switch", () => {
  for (const fullAccessHome of [false, "true", 1, undefined]) {
    const target = resolve({ isAdminAuthor: true, settings: { ...settings, fullAccessHome } });
    assert.equal(operatorHomeGranted(target), false);
    assert.equal(target.container.mounts.some((mount) => mount.kind === "operator-home"), false);
  }
  const worker = resolve({ isAdminAuthor: true }, { ...meta, adminMode: false });
  assert.equal(worker.runtimeScope, "admin", "an admin keeps private session storage when channel mode changes");
  assert.equal(operatorHomeGranted(worker), false);
});

test("project authors receive fresh HOME, tmp and artifacts separate from legacy admin state", () => {
  const admin = resolve({ isAdminAuthor: true });
  const member = resolve();
  assert.notEqual(member.container.name, admin.container.name);
  assert.match(member.container.name, /^cgp2-/);
  assert.notEqual(member.container.homeVolume, admin.container.homeVolume);
  for (const kind of ["tmp", "var-tmp"]) assert.notEqual(member.container.tmpVolumes[kind], admin.container.tmpVolumes[kind]);
  assert.equal(admin.artifactDir, channelArtifactDir("author-isolation", "slack"));
  assert.equal(member.artifactDir, path.join(`${runtimeArtifactsRoot()}-project-v2`, "slack", "author-isolation"));
  assert.equal(contains(admin.artifactDir, member.artifactDir), false);
  assert.equal(contains(member.artifactDir, admin.artifactDir), false);
});

test("member storage cannot collide with another channel's privileged lane", () => {
  const member = resolveRuntime("example", meta, { settings });
  for (const slug of ["example", "example-project-v2", "project-v2-example", "cgp2-example"]) {
    const admin = resolveRuntime(slug, meta, { settings, isAdminAuthor: true });
    assert.notEqual(member.container.name, admin.container.name, slug);
    assert.notEqual(member.container.homeVolume, admin.container.homeVolume, slug);
    assert.equal(contains(member.artifactDir, admin.artifactDir), false, slug);
    assert.equal(contains(admin.artifactDir, member.artifactDir), false, slug);
    for (const mount of member.container.mounts.filter((entry) => entry.type === "bind")) {
      assert.equal(contains(mount.source, admin.artifactDir), false, `${slug}: ${mount.kind}`);
    }
  }
});

test("the project runtime mounts project directories without any parent exposing admin artifacts", () => {
  const admin = resolve({ isAdminAuthor: true });
  const member = resolve();
  for (const kind of ["workdir", "clean", "artifacts"]) {
    const mount = member.container.mounts.find((entry) => entry.kind === kind);
    assert.ok(mount, kind);
    assert.equal(mount.mode, "rw", "members retain writable project mounts");
    assert.equal(mount.source, mount.target);
  }
  for (const mount of member.container.mounts.filter((entry) => entry.type === "bind")) {
    assert.equal(contains(mount.source, admin.artifactDir), false, `${mount.kind} must not expose privileged artifacts`);
  }
  assert.equal(member.workDir, admin.workDir);
  assert.equal(member.cwd, admin.cwd);
});

test("privilege lanes remain separate on every supported platform and long channel names", () => {
  for (const platform of ["slack", "googlechat", "msteams"]) {
    for (const slug of ["short", "channel-with-a-very-long-name-".repeat(8)]) {
      const admin = resolveRuntime(slug, { ...meta, platform }, { settings, isAdminAuthor: true });
      const member = resolveRuntime(slug, { ...meta, platform }, { settings });
      assert.notEqual(member.container.name, admin.container.name);
      assert.ok(member.container.name.length <= 58, "HOME volume suffix must fit the CLI name ceiling");
      assert.notEqual(member.container.homeVolume, admin.container.homeVolume);
      assert.notEqual(member.artifactDir, admin.artifactDir);
      assert.equal(operatorHomeGranted(member), false);
    }
  }
});

test("a same-thread warm admin process cannot serve a subsequent project-author turn", async () => {
  const admin = resolve({ isAdminAuthor: true });
  const member = resolve();
  assert.notEqual(admin.runtime.fingerprint(admin), member.runtime.fingerprint(member));
  const created = [];
  const pool = createSessionPool({
    createSession: ({ target }) => {
      const session = {
        target, alive: true, state: "idle", terminated: false,
        start() {},
        async send() { return target.runtimeScope; },
        terminate() { this.alive = false; this.terminated = true; },
      };
      created.push(session);
      return session;
    },
  });
  const options = { key: "same-channel::same-thread", cwd: member.cwd, args: [], env: {}, mcpConfigJson: "{}", dangerouslySkip: false, text: "hello" };
  try {
    assert.equal(await pool.runPooled({ ...options, target: admin }), "admin");
    assert.equal(await pool.runPooled({ ...options, target: member }), "project");
    assert.equal(created.length, 2);
    assert.equal(created[0].terminated, true);
    assert.equal(created[1].target.container.name, member.container.name);
  } finally {
    pool.shutdownPool();
  }
});

test("host session carry cannot import privileged native history into the project lane", async () => {
  const result = await carrySession({
    engine: "claude", sessionId: "private-admin-session", cwd: resolve().cwd,
    storedRuntime: JSON.stringify({ backend: "host", runtimeScope: "admin" }), target: resolve(),
    resolveFor() { assert.fail("project lane must refuse before resolving or reading host session state"); },
    log() {},
  });
  assert.equal(result, null);
});

test("fork recovery rechecks current rank and rejects privileged or unclassified sources for members", async () => {
  const { setUser } = await import("../src/config/store.js");
  const { saveSession } = await import("../src/gateway/sessions.js");
  const { recoveryForkSessionId } = await import("../src/gateway/active-runs.js");
  await setUser("U_FORK_ISOLATION", { approved: true, isAdmin: true });
  const rec = { slug: "fork-isolation", authorId: "U_FORK_ISOLATION", forkSourceSessionId: "privileged-source" };
  await saveSession(rec.slug, "admin-thread", rec.forkSourceSessionId, "claude", null, JSON.stringify({ backend: "container", scope: "admin" }));
  assert.equal(await recoveryForkSessionId(rec), rec.forkSourceSessionId);
  await setUser(rec.authorId, { approved: true, isAdmin: false });
  assert.equal(await recoveryForkSessionId(rec), "", "demotion must not replay an admin-native fork");
  assert.equal(await recoveryForkSessionId({ ...rec, forkSourceSessionId: "missing-source" }), "");
  await saveSession(rec.slug, "member-thread", "project-source", "claude", null, JSON.stringify({ backend: "container", scope: "project" }));
  assert.equal(await recoveryForkSessionId({ ...rec, forkSourceSessionId: "project-source" }), "project-source");
});

for (const engine of ["claude", "codex"]) {
  test(`${engine}: foreground Admin channel grants a member Worker tools in the project lane and reserves home access for an admin`, async () => {
    const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
    const { saveSettings } = await import("../src/config/settings.js");
    const { runMessage, setRuntimeResolver } = await import("../src/gateway/run.js");
    const { getSessionRuntime } = await import("../src/gateway/sessions.js");
    const { createFakeRuntimeBackend } = await import("./runtime-fake.js");
    saveSettings({ engine, codexEnabled: true, memoryReviewEvery: 0, engineFallback: false,
      composioMode: "personal", containerFullAccessHome: true, containerClaudeOauthToken: "test-author-isolation-token" });
    await setUser("U_ISOLATION_MEMBER", { name: "Member", approved: true, isAdmin: false });
    await setUser("U_ISOLATION_ADMIN", { name: "Admin", approved: true, isAdmin: true });
    const channelId = `C_FOREGROUND_ISOLATION_${engine}`;
    const entry = await upsertChannelEntry(channelId, { name: `foreground-isolation-${engine}`, type: "channel" });
    const channelMeta = { ...meta, channelId, engine, template: "custom", allowedMcps: [], allowNetwork: true, adminMode: true, autoMode: true };
    await saveChannelMeta(entry.slug, channelMeta);
    const fake = createFakeRuntimeBackend();
    const targets = [];
    const policies = [];
    const spawn = fake.spawn;
    fake.spawn = (target, spec) => {
      const settingsIndex = spec.args.indexOf("--settings");
      if (settingsIndex >= 0) policies.push(JSON.parse(readFileSync(spec.args[settingsIndex + 1], "utf8")));
      return spawn(target, spec);
    };
    setRuntimeResolver((slug, runMeta, options) => {
      const target = resolveRuntime(slug, runMeta, options);
      targets.push(target);
      mkdirSync(target.workDir, { recursive: true });
      return { ...target, runtime: fake };
    });
    try {
      const member = await runMessage({ channelId, authorId: "U_ISOLATION_MEMBER", text: "inspect this project", threadKey: "member", origin: "slack_foreground", preferCold: true });
      assert.match(member.content, /stub.*reply/i);
      assert.equal(targets[0].runtimeScope, "project");
      assert.equal(targets[0].container.mounts.some((mount) => mount.kind === "operator-home"), false);
      assert.equal((await getSessionRuntime(entry.slug, "member")).scope, "project");
      const memberSpawn = fake.calls.spawn[0];
      if (engine === "claude") {
        assert.ok(policies[0].permissions.allow.includes("Bash"), "member commands are granted");
        assert.ok(policies[0].permissions.allow.includes("Write"), "member edits are granted");
        assert.equal(policies[0].permissions.deny.includes("Bash"), false);
        assert.equal(memberSpawn.args.includes("--dangerously-skip-permissions"), false);
      } else {
        assert.equal(memberSpawn.args[memberSpawn.args.indexOf("--sandbox") + 1], "danger-full-access", "Worker edits use the project container boundary");
        assert.equal(memberSpawn.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
      }
      const admin = await runMessage({ channelId, authorId: "U_ISOLATION_ADMIN", text: "inspect this project", threadKey: "admin", origin: "slack_foreground", preferCold: true });
      assert.match(admin.content, /stub.*reply/i);
      assert.equal(targets[1].runtimeScope, "admin");
      assert.equal(targets[1].container.mounts.some((mount) => mount.kind === "operator-home"), true);
      assert.notEqual(targets[0].container.name, targets[1].container.name);
      assert.equal((await getSessionRuntime(entry.slug, "admin")).scope, "admin");
    } finally {
      setRuntimeResolver(null);
    }
  });
}
