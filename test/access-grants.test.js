import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  foreignPersonalSkillError,
  isForeignPersonalSkill,
  newForeignPersonalSkillGrants,
  resolveAccessGrants,
  resolveRunAccessGrants,
  skippedSkillGrantsWarning,
  resolveRunUserIdentity,
  sanitizeSkillGrantNames,
  unionGrantEntries,
  userOnlySkillGrants,
} from "../src/gateway/access-grants.js";
import { cleanAccessGrants } from "../src/web/routes/helpers.js";
import {
  accessGrantSkillOptions,
  accessGrantSkillSelection,
  captureGrantMcpSelection,
} from "../public/admin-state.js";

test("untrusted caller-supplied principals never load or inherit stored user grants", async () => {
  let loads = 0;
  const loadUser = async () => {
    loads += 1;
    return { skills: ["private-skill"], allowedMcps: [{ name: "private" }] };
  };
  const untrusted = await resolveRunAccessGrants({
    organization: { skills: ["org"] },
    channel: { skills: ["channel"] },
    authorId: "U_PUBLIC_ID",
    untrustedPrincipal: true,
    loadUser,
    lookupSkill: () => { throw new Error("untrusted principal must not consult the skill catalog"); },
  });

  assert.equal(loads, 0, "stored user lookup must be skipped completely");
  assert.deepEqual(untrusted.effective.skills, ["org", "channel"]);
  assert.deepEqual(untrusted.effective.allowedMcps, []);

  const trusted = await resolveRunAccessGrants({
    organization: { skills: ["org"] },
    channel: { skills: ["channel"] },
    authorId: "U_TRUSTED",
    loadUser,
  });
  assert.equal(loads, 1);
  assert.deepEqual(trusted.effective.skills, ["org", "channel", "private-skill"]);
});

test("personal tombstones are inactive without erasing grants or ignoring broken selections", async () => {
  const skills = {
    removed: { slug: "removed", ownerKind: "local", visibility: "personal", createdBy: "owner", deleted: true },
    staged: { slug: "staged", ownerKind: "local", visibility: "personal", createdBy: "owner", deleted: false },
    sharedRemoved: { slug: "sharedRemoved", ownerKind: "git", visibility: "org", deleted: true },
  };
  const stored = { skills: ["removed", "staged", "unknown", "sharedRemoved"], allowedMcps: ["private-mcp"] };
  const resolve = () => resolveRunAccessGrants({ authorId: "owner", loadUser: async () => stored, lookupSkill: (name) => skills[name] || null });
  assert.deepEqual((await resolve()).user.skills, ["staged", "unknown", "sharedRemoved"], "only the proven own local personal tombstone is omitted");
  assert.deepEqual(stored.skills, ["removed", "staged", "unknown", "sharedRemoved"], "persisted grants remain intact");
  assert.deepEqual((await resolve()).user.allowedMcps, ["private-mcp"]);
  skills.removed.deleted = false;
  assert.deepEqual((await resolve()).user.skills, stored.skills, "restoring the catalog skill reactivates its retained grant");
  await assert.rejects(resolveRunAccessGrants({ authorId: "owner", loadUser: async () => stored, lookupSkill: () => { throw new Error("catalog unavailable"); } }), /catalog unavailable/);
});

test("another person's personal skill is skipped, never loaded, and never fails the run", async () => {
  for (const deleted of [false, true]) {
    const foreign = { slug: "foreign", ownerKind: "local", visibility: "personal", createdBy: "other", deleted };
    const shared = { slug: "shared", visibility: "org" };
    const lookup = (name) => ({ foreign, shared })[name] || null;
    for (const authorId of ["owner", ""]) {
      const grants = await resolveRunAccessGrants({ authorId, organization: { skills: ["org"] }, loadUser: async () => ({ skills: ["foreign", "shared"] }), lookupSkill: lookup });
      assert.deepEqual(grants.user.skills, ["shared"], "the foreign personal grant is dropped from the user tier");
      assert.deepEqual(grants.effective.skills, ["org", "shared"], "and from the effective union");
      assert.deepEqual(grants.skippedSkills, [{ name: "foreign", reason: "foreign-personal" }]);
    }
    const skills = { foreign, parent: { slug: "parent", visibility: "org", requires: ["middle"] }, middle: { slug: "middle", visibility: "org", requires: ["foreign"] }, ok: { slug: "ok", visibility: "org" } };
    const viaDependency = await resolveRunAccessGrants({ authorId: "owner", loadUser: async () => ({ skills: ["parent", "ok"] }), lookupSkill: (name) => skills[name] || null });
    assert.deepEqual(viaDependency.user.skills, ["ok"], "a grant whose requires: closure reaches a foreign personal skill is skipped whole");
    assert.deepEqual(viaDependency.skippedSkills, [{ name: "parent", reason: "foreign-personal-dependency", dependency: "foreign" }]);
  }
  const own = { slug: "mine", ownerKind: "local", visibility: "personal", createdBy: "owner" };
  const ownGrants = await resolveRunAccessGrants({ authorId: "owner", loadUser: async () => ({ skills: ["mine"] }), lookupSkill: () => own });
  assert.deepEqual(ownGrants.user.skills, ["mine"], "the author keeps their own personal skill");
  assert.deepEqual(ownGrants.skippedSkills, []);
  const dependency = { slug: "removed", ownerKind: "local", visibility: "personal", createdBy: "owner", deleted: true };
  const parent = { slug: "parent", visibility: "org", requires: ["parent", "removed"] };
  const grants = await resolveRunAccessGrants({ authorId: "owner", loadUser: async () => ({ skills: ["parent"] }), lookupSkill: (name) => name === "parent" ? parent : dependency });
  assert.deepEqual(grants.user.skills, ["parent"], "a removed required dependency is not silently excised from an active parent; materialization still fails");
});

test("the skipped-grant note names each skill and says the run continues", () => {
  assert.equal(skippedSkillGrantsWarning([]), "");
  const one = skippedSkillGrantsWarning([{ name: "callbox-form", reason: "foreign-personal" }]);
  assert.match(one, /^⚠️ Skipped a skill in your personal grants: callbox-form — it is another person's personal skill/);
  assert.match(one, /Continuing without it\.\n\n$/);
  const two = skippedSkillGrantsWarning([{ name: "a", reason: "foreign-personal" }, { name: "b", reason: "foreign-personal-dependency", dependency: "a" }]);
  assert.match(two, /Skipped 2 skills in your personal grants: a, b \(requires a\) — they are/);
});

test("save paths refuse NEW foreign personal grants and leave stored ones alone", () => {
  const catalog = {
    mine: { slug: "mine", visibility: "personal", createdBy: "U1" },
    theirs: { slug: "theirs", visibility: "personal", createdBy: "U2" },
    shared: { slug: "shared", visibility: "org" },
  };
  const lookupSkill = (name) => catalog[name] || null;
  assert.equal(isForeignPersonalSkill(catalog.mine, "U1"), false);
  assert.equal(isForeignPersonalSkill(catalog.mine, ""), true, "a shared tier owns no personal skill");
  assert.equal(isForeignPersonalSkill(catalog.shared, ""), false);
  assert.deepEqual(newForeignPersonalSkillGrants(["mine", "theirs", "shared", "unknown"], [], { ownerId: "U1", lookupSkill }), ["theirs"]);
  assert.deepEqual(newForeignPersonalSkillGrants(["mine", "shared"], [], { lookupSkill }), ["mine"], "organization/channel/template tiers refuse every personal skill");
  assert.deepEqual(newForeignPersonalSkillGrants(["theirs", "shared"], ["Theirs"], { ownerId: "U1", lookupSkill }), [], "an already-stored grant never blocks an unrelated save");
  assert.match(foreignPersonalSkillError(["theirs"]), /"theirs" is another person's personal skill/);
  assert.match(foreignPersonalSkillError(["a", "b"], { tier: "shared" }), /"a", "b" are personal skills and cannot be granted here/);
});

test("untrusted caller-supplied principals never load personal tokens or role state", async () => {
  const calls = [];
  const loader = (name, value) => async (id) => {
    calls.push([name, id]);
    return value;
  };
  const deps = {
    loadComposioToken: loader("composio", "secret-composio"),
    loadToolboxToken: loader("toolbox", "secret-toolbox"),
    loadIsAdmin: loader("admin", true),
    loadIsApproved: loader("approved", true),
  };
  assert.deepEqual(await resolveRunUserIdentity({
    authorId: "U_CALLER_SELECTED",
    untrustedPrincipal: true,
    needsApproval: true,
    ...deps,
  }), { composioToken: "", toolboxToken: "", isAdmin: false, isApproved: false });
  assert.deepEqual(calls, [], "no user credential or role store may be consulted");

  assert.deepEqual(await resolveRunUserIdentity({
    authorId: "U_TRUSTED",
    needsApproval: true,
    ...deps,
  }), {
    composioToken: "secret-composio",
        toolboxToken: "secret-toolbox",
    isAdmin: true,
    isApproved: true,
  });
  assert.equal(calls.length, 4);
});

test("access grants union organization, channel, and active-user tiers", () => {
  const effective = resolveAccessGrants({
    organization: {
      skills: ["org-skill", "shared"],
      allowedMcps: [{ name: "org", namespace: "mcp__org", match: { serverName: "org" } }],
    },
    channel: {
      skills: ["channel-skill", "shared"],
      allowedCodexMcps: [{ id: "app:channel", name: "channel" }],
    },
    user: {
      skills: ["user-skill"],
      allowedMcps: [{ name: "user", namespace: "mcp__user", match: { serverName: "user" } }],
    },
  });

  assert.deepEqual(effective.skills, ["org-skill", "shared", "channel-skill", "user-skill"]);
  assert.deepEqual(effective.allowedMcps.map((m) => m.name), ["org", "user"]);
  assert.deepEqual(effective.allowedCodexMcps.map((m) => m.id), ["app:channel"]);
});

test("more-specific grant tiers replace a duplicate connector shape", () => {
  assert.deepEqual(
    unionGrantEntries(
      [{ name: "same", namespace: "mcp__old" }],
      [{ name: "same", namespace: "mcp__new" }],
    ),
    [{ name: "same", namespace: "mcp__new" }],
  );
});

test("admin grant payloads are shape-cleaned and OpenCode stays MCP-off", () => {
  assert.deepEqual(cleanAccessGrants({
    skills: [" one ", "one", 2, "visualize:visualize", "../../escape", "nested/skill", "nested\\skill", "..", "bad\u0000name"],
    allowedMcps: [
      { name: "ok", namespace: "mcp__ok", match: { serverName: "ok" } },
      { name: "bad", namespace: "mcp__bad", match: { unexpected: true } },
    ],
    allowedCodexMcps: [{ id: "local-test", name: "test", kind: "server", serverName: "local-test" }],
    allowedOpenCodeMcps: [{ name: "must-not-pass" }],
  }), {
    skills: ["one", "visualize:visualize"],
    allowedMcps: [{ name: "ok", namespace: "mcp__ok", match: { serverName: "ok" } }],
    allowedCodexMcps: [{ id: "local-test", name: "test", kind: "server", serverName: "local-test" }],
    allowedOpenCodeMcps: [],
  });
});

test("skill grants reject traversal on both persistence and runtime resolution paths", () => {
  assert.deepEqual(
    sanitizeSkillGrantNames([" channel-memory ", "channel-memory", ".", "..", "../outside", "a/b", "a\\b", "ok skill"]),
    ["channel-memory", "ok skill"],
  );
  assert.deepEqual(resolveAccessGrants({
    organization: { skills: ["org", "../org-secret"] },
    channel: { skills: ["channel", "org"] },
    user: { skills: ["user", "nested/user", "channel"] },
  }).skills, ["org", "channel", "user"]);
});

test("the former standalone video skill is retired at every grant boundary", () => {
  assert.deepEqual(
    sanitizeSkillGrantNames(["video-understanding", " Video-Understanding ", "screen-notes"]),
    ["screen-notes"],
  );
  assert.deepEqual(resolveAccessGrants({
    organization: { skills: ["video-understanding", "org"] },
    channel: { skills: ["Video-Understanding", "channel"] },
  }).skills, ["org", "channel"]);
});

test("frontend grant state preserves MCP selections while discovery is loading", () => {
  const saved = { claude: ["server-a"], codex: ["app-b"] };
  assert.deepEqual(
    captureGrantMcpSelection(saved, "claude", [], true),
    saved,
    "a loading placeholder is not an authoritative empty selection",
  );
  assert.deepEqual(
    captureGrantMcpSelection(saved, "claude", [], false),
    { claude: [], codex: ["app-b"] },
    "once checkboxes are ready an intentional clear is authoritative",
  );
  assert.deepEqual(
    captureGrantMcpSelection(saved, "codex", ["app-b", "app-b", "app-c"], false),
    { claude: ["server-a"], codex: ["app-b", "app-c"] },
  );
});

test("frontend skill options preserve saved names missing from discovery", () => {
  assert.deepEqual(
    accessGrantSkillOptions(["available", "shared", "shared"], ["shared", "offline-skill", "offline-skill"]),
    [
      { value: "shared", label: "shared", enabled: true },
      { value: "available", label: "available", enabled: false },
      { value: "offline-skill", label: "offline-skill · unavailable" },
    ],
  );
});

test("frontend skill options offer a person only their own personal skills", () => {
  const personal = [{ slug: "mine", createdBy: "U1" }, { slug: "theirs", createdBy: "U2" }];
  const forUser = accessGrantSkillOptions(["shared"], ["theirs", "shared"], { personal, ownerId: "U1" });
  assert.deepEqual(forUser, [
    { value: "shared", label: "shared", enabled: true },
    { value: "mine", label: "mine · personal", enabled: false },
    { value: "theirs", label: "theirs · another person's personal skill — not loaded; removed on save", foreign: true },
  ]);
  assert.deepEqual(accessGrantSkillSelection(forUser, ["theirs", "shared"]), ["shared"], "a foreign grant is listed unchecked so the next save removes it");
  const shared = accessGrantSkillOptions(["shared"], ["mine"], { personal });
  assert.deepEqual(shared.map((option) => option.value), ["shared", "mine"], "a shared tier offers no personal skill");
  assert.equal(shared[1].foreign, true);
  assert.equal(accessGrantSkillOptions(["shared"], [], { personal, ownerId: "U2" }).some((option) => option.value === "mine"), false);
});

test("conversation tool categories are first-class channel pages", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /id="org-grant-tier"[\s\S]*Organization[\s\S]*Channel[\s\S]*Individual user/);
  assert.doesNotMatch(html, /class="ch-grant-tier"/);
  assert.match(html, /data-pane="access">Access<[\s\S]*data-pane="connections">MCP Connections<[\s\S]*data-pane="mcps">Cloud MCP<[\s\S]*data-pane="environment">Environment tokens<[\s\S]*data-pane="skills">Skills<[\s\S]*data-pane="runtime">Runtime<[\s\S]*data-pane="instructions">Instructions<[\s\S]*data-pane="memory">Memory</);
  assert.doesNotMatch(html, /data-pane="tools"|tool-subtab|data-tool-pane/);
  assert.doesNotMatch(client, /toolSections|tool-subtab|dataToolPane/);
  assert.match(html, /class="ud-row ud-grants"/);
  assert.match(client, /function buildAccessGrantsEditor/);
  assert.match(client, /captureGrantMcpSelection\(/, "the executable loading-state helper must drive the editor");
  assert.match(client, /box\.dataset\.mcpLoading === engine/, "loading discovery must be explicit at the DOM boundary");
  assert.match(client, /accessGrantSkillOptions\(SKILLS,/, "all grant editors must preserve saved-only skills");
  assert.match(client, /buildAccessGrantsEditor\(u, \{ tier: "user", ownerId: id \}\)/, "the user editor knows whose personal skills it may offer");
  assert.equal((client.match(/checkboxList\([a-zA-Z]+, skillOptions, accessGrantSkillSelection\(skillOptions,/g) || []).length, 3, "every skill grant editor leaves foreign personal grants unchecked");
  assert.match(client, /accessGrants:\s*orgGrantsEditor\?\.getValues\(\)/);
  assert.match(client, /accessGrants:\s*userGrantsEditor\.getValues\(\)/);
});

test("userOnlySkillGrants keeps only the skills the shared channel grant does not already carry", () => {
  assert.deepEqual(
    userOnlySkillGrants({ shared: { skills: ["deploy-notes", "sales-brief"] }, effective: { skills: ["sales-brief", "private-playbook", "deploy-notes", "my-drafts"] } }),
    ["private-playbook", "my-drafts"],
  );
  assert.deepEqual(userOnlySkillGrants({ shared: {}, effective: { skills: ["my-drafts"] } }), ["my-drafts"]);
  assert.deepEqual(userOnlySkillGrants({ shared: { skills: "not-a-list" }, effective: { skills: ["my-drafts", "../escape"] } }), ["my-drafts"]);
  assert.deepEqual(userOnlySkillGrants(), []);
});
