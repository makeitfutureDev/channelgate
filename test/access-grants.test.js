import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveAccessGrants,
  resolveRunAccessGrants,
  resolveRunUserIdentity,
  sanitizeSkillGrantNames,
  unionGrantEntries,
  userOnlySkillGrants,
} from "../src/gateway/access-grants.js";
import { cleanAccessGrants } from "../src/web/routes/helpers.js";
import {
  accessGrantSkillOptions,
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
