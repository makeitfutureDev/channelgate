import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { searchAgentDirectory, sanitizeAgentDirectoryProfile } = await import("../src/gateway/agent-directory.js");
const catalog = await import("../src/gateway/skills/catalog.js");
const store = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");

function fixture() {
  const entries = new Map();
  const metas = new Map();
  const skills = new Map();
  const visible = new Map();
  const checked = [];
  const add = (id, meta = {}, entry = {}) => {
    entries.set(id, { channelId: id, slug: id.toLowerCase(), name: id, type: "channel", isDM: false, ...entry });
    metas.set(id.toLowerCase(), { channelId: id, type: "channel", isDM: false, access: "approved", ...meta });
    visible.set(id, { visible: true, name: `Live ${id}`, type: "channel", isDM: false, url: `https://chat.example/${id}`, description: "Live channel purpose", verifiedAt: "2026-10-21T02:00:00Z" });
  };
  add("C_SOURCE", { agentDirectory: { hidden: true } });
  return { add, entries, metas, skills, visible, checked, options: {
    createdBy: "U_VIEWER", channelId: "C_SOURCE",
    loadChannels: async () => [...entries.values()], loadMeta: async (slug) => metas.get(slug),
    loadUser: async () => ({ approved: true, skills: ["personal-user-grant"] }),
    loadOrganization: () => ({ skills: [] }), withSkills: (meta) => meta,
    lookupSkill: (name) => skills.get(name), revisionFor: () => ({ id: 1 }),
    prepareVerifier: async ({ createdBy, channelId }) => {
      assert.equal(createdBy, "U_VIEWER"); assert.equal(channelId, "C_SOURCE");
      return async (entry) => { checked.push(entry.channelId); return visible.get(entry.channelId); };
    },
  } };
}

test("directory returns only currently authorized channel agents with proven audience access", async () => {
  const f = fixture();
  f.add("C_ALLOWED", { agentDirectory: { description: "Build presentations", examples: ["Create a sales deck"] } });
  f.add("G_PRIVATE", {}, { type: "group" });
  f.visible.set("G_PRIVATE", { ...f.visible.get("G_PRIVATE"), type: "group" });
  f.add("C_UNPROVEN"); f.visible.delete("C_UNPROVEN");
  f.add("C_RESTRICTED", { access: "admins" });
  f.add("C_EXCLUDED", { excludedUsers: ["U_VIEWER"] });
  f.add("C_DORMANT", { access: "none" });
  f.add("C_HIDDEN", { agentDirectory: { hidden: true } });
  f.add("C_LEAN", { cleanMode: true });
  f.add("C_DISABLED", { disabled: true });
  f.add("D_DM", { isDM: true }, { type: "im", isDM: true });
  f.add("G_MPIM", {}, { type: "mpim" });
  f.add("UNKNOWN", {}, { type: "" });
  const result = await searchAgentDirectory(f.options);
  assert.deepEqual(result.agents.map((agent) => agent.channelId), ["C_ALLOWED", "G_PRIVATE"]);
  assert.deepEqual(f.checked.slice().sort(), ["C_ALLOWED", "C_UNPROVEN", "G_PRIVATE"]);
  assert.equal(result.returned, 2);
  assert.equal(result.agents[0].description, "Build presentations");
  assert.deepEqual(result.agents[0].examples, ["Create a sales deck"]);
  assert.equal(result.agents[1].description, "Live channel purpose");
  assert.equal(result.agents[1].name, "Live G_PRIVATE");
});

test("named grants allow a restricted agent but source access revocation hides every result", async () => {
  const f = fixture();
  f.add("C_NAMED", { access: "none", allowedUsers: ["U_VIEWER"] });
  assert.equal((await searchAgentDirectory(f.options)).agents[0].channelId, "C_NAMED");
  f.metas.get("c_source").excludedUsers = ["U_VIEWER"];
  const empty = { agents: [], returned: 0, hasMore: false, nextOffset: null };
  assert.deepEqual(await searchAgentDirectory(f.options), empty);
  delete f.metas.get("c_source").excludedUsers;
  f.options.prepareVerifier = async () => async (entry) => {
    f.metas.get("c_source").access = "none";
    return f.visible.get(entry.channelId);
  };
  assert.deepEqual(await searchAgentDirectory(f.options), empty);
});

test("hidden channels and private dependencies contribute neither search hits nor counts", async () => {
  const f = fixture();
  f.add("C_AGENT", { skills: ["shared", "private", "disabled", "deleted", "excluded", "staged", "missing"] });
  f.add("C_HIDDEN", { agentDirectory: { hidden: true, description: "classified-keyword" } });
  const skill = (slug, extra = {}) => ({ slug, name: slug, description: `${slug} workflow`, visibility: "org", ...extra });
  f.skills.set("shared", skill("shared", { discoverable: false, requires: ["private", "public-dependency"] }));
  f.skills.set("public-dependency", skill("public-dependency"));
  f.skills.set("private", skill("private", { visibility: "personal", description: "classified-keyword", requires: ["private-descendant"] }));
  f.skills.set("private-descendant", skill("private-descendant", { description: "classified-keyword" }));
  for (const name of ["disabled", "deleted", "excluded", "staged"]) f.skills.set(name, skill(name, { [name === "disabled" ? "enabled" : name]: name !== "disabled" }));
  f.options.revisionFor = (item) => item.staged ? null : { id: 1 };
  const result = await searchAgentDirectory(f.options);
  assert.deepEqual(result.agents[0].skills.map((item) => item.slug), ["shared", "public-dependency"]);
  const hiddenQuery = await searchAgentDirectory({ ...f.options, query: "classified-keyword" });
  assert.deepEqual(hiddenQuery, { agents: [], returned: 0, hasMore: false, nextOffset: null });
  assert.equal(JSON.stringify(result).includes("classified"), false);
});

test("revocation and verification failure fail closed without revealing target diagnostics", async () => {
  const f = fixture();
  f.add("C_AGENT");
  f.options.prepareVerifier = async () => async () => {
    f.metas.set("c_agent", { ...f.metas.get("c_agent"), agentDirectory: { hidden: true } });
    return f.visible.get("C_AGENT");
  };
  const empty = { agents: [], returned: 0, hasMore: false, nextOffset: null };
  assert.deepEqual(await searchAgentDirectory(f.options), empty);
  f.options.prepareVerifier = async () => { throw new Error("private channel secret failure"); };
  assert.deepEqual(await searchAgentDirectory(f.options), empty);
  assert.deepEqual(await searchAgentDirectory({ ...f.options, createdBy: "" }), empty);
});

test("search ranks visible purpose, examples and active skills, with bounded pagination", async () => {
  const f = fixture();
  for (let i = 0; i < 55; i++) f.add(`C_${String(i).padStart(2, "0")}`, { agentDirectory: { description: "presentation" } });
  f.add("C_BEST", { agentDirectory: { description: "presentation", examples: ["sales deck"] }, skills: ["presentation"] });
  f.skills.set("presentation", { slug: "presentation", description: "presentation creation" });
  const first = await searchAgentDirectory({ ...f.options, query: "presentation", limit: 500 });
  assert.equal(first.agents[0].channelId, "C_BEST");
  assert.equal(first.agents.length, 50);
  assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 50);
  const next = await searchAgentDirectory({ ...f.options, query: "presentation", offset: first.nextOffset });
  assert.equal(next.agents.length, 6); assert.equal(next.nextOffset, null);
  assert.equal(new Set([...first.agents, ...next.agents].map((agent) => agent.channelId)).size, 56);
  const example = await searchAgentDirectory({ ...f.options, query: "sales" });
  assert.deepEqual(example.agents.map((agent) => agent.channelId), ["C_BEST"]);
});

test("production grant resolution follows live organization, template, dependency and personal visibility changes", async () => {
  const md = (name, extra = "") => ({ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${name} workflow\n${extra}---\nBody\n` });
  catalog.putSkillRevision({ files: [md("Directory Org")], ownerKind: "local" });
  catalog.putSkillRevision({ files: [md("Directory Template", "requires: [directory-dependency]\n")], ownerKind: "local" });
  catalog.putSkillRevision({ files: [md("Directory Dependency")], ownerKind: "local" });
  catalog.putSkillRevision({ files: [md("Directory Personal")], ownerKind: "local", visibility: "personal", createdBy: "U_DIRECTORY" });
  catalog.upsertTemplate({ slug: "directory-template", name: "Directory", skills: ["directory-template"] });
  await store.setUser("U_DIRECTORY", { approved: true, skills: ["directory-personal"] });
  const entry = await store.upsertChannelEntry("C_DIRECTORY_LIVE", { name: "directory-live", type: "channel", isDM: false });
  const source = await store.upsertChannelEntry("C_SOURCE", { name: "source", type: "channel", isDM: false });
  await store.saveChannelMeta(source.slug, { ...store.defaultChannelMeta({ channelId: "C_SOURCE", type: "channel" }), agentDirectory: { hidden: true } });
  await store.saveChannelMeta(entry.slug, { ...store.defaultChannelMeta({ channelId: "C_DIRECTORY_LIVE", type: "channel" }), skillTemplate: "directory-template", skills: ["directory-personal"] });
  saveSettings({ accessGrants: { skills: ["directory-org"] } });
  const options = {
    createdBy: "U_DIRECTORY", channelId: "C_SOURCE", loadChannels: async () => [{ ...entry, channelId: "C_DIRECTORY_LIVE" }, { ...source, channelId: "C_SOURCE" }],
    prepareVerifier: async () => async () => ({ visible: true, type: "channel", name: "Live", url: "https://chat.example/live" }),
  };
  const initial = await searchAgentDirectory(options);
  assert.deepEqual(initial.agents[0].skills.map((item) => item.slug).sort(), ["directory-dependency", "directory-org", "directory-template"]);
  catalog.upsertTemplate({ slug: "directory-template", name: "Directory", skills: [] });
  saveSettings({ accessGrants: { skills: [] } });
  assert.deepEqual((await searchAgentDirectory(options)).agents[0].skills, []);
  catalog.setSkillVisibility("directory-org", "personal");
  saveSettings({ accessGrants: { skills: ["directory-org"] } });
  assert.deepEqual((await searchAgentDirectory(options)).agents[0].skills, []);
});

test("curated profile and returned metadata remain bounded and strip unsafe URLs", async () => {
  const profile = sanitizeAgentDirectoryProfile({ description: `\u0000${"a".repeat(900)}`, examples: Array(20).fill("x").concat([42, "y".repeat(200)]), hidden: "true" });
  assert.equal(profile.description.length, 600);
  assert.deepEqual(profile.examples.map((item) => item.length), [1, 160]);
  assert.equal(profile.hidden, false);
  const f = fixture(); f.add("C_AGENT");
  f.visible.get("C_AGENT").url = "javascript:alert(1)";
  assert.equal((await searchAgentDirectory(f.options)).agents[0].url, "");
});

test("nightly metadata prefilters nonmatches while current shared skills bypass stale cached purpose", async () => {
  const f = fixture();
  const cache = {};
  for (let i = 0; i < 100; i++) {
    const id = `C_ACCOUNTING_${i}`;
    f.add(id);
    cache[id] = { name: "Accounting", description: "Bookkeeping and invoices" };
  }
  f.options.loadDirectoryMetadata = () => cache;
  let prepared = 0;
  const original = f.options.prepareVerifier;
  f.options.prepareVerifier = async (options) => { prepared++; return original(options); };
  assert.deepEqual(await searchAgentDirectory({ ...f.options, query: "presentation" }), { agents: [], returned: 0, hasMore: false, nextOffset: null });
  assert.equal(prepared, 0, "nonmatching cached channels need no source or target platform calls");
  f.add("C_SPECIALIST", { skills: ["decks"] });
  cache.C_SPECIALIST = { name: "Old", description: "Legacy accounting" };
  f.skills.set("decks", { slug: "decks", description: "Build presentation slides" });
  const result = await searchAgentDirectory({ ...f.options, query: "presentation" });
  assert.deepEqual(f.checked, ["C_SPECIALIST"]);
  assert.equal(result.agents[0].name, "Live C_SPECIALIST");
  assert.equal(result.agents[0].description, "Live channel purpose", "cached purpose is never returned");
  assert.deepEqual(result.agents[0].skills.map((item) => item.slug), ["decks"]);
  f.metas.get("c_specialist").skills = [];
  f.checked.length = 0;
  assert.equal((await searchAgentDirectory({ ...f.options, query: "presentation" })).returned, 0);
  assert.deepEqual(f.checked, []);
});

test("cached visibility never authorizes and stale cache matches require a live matching descriptor", async () => {
  const f = fixture();
  f.add("C_SECRET");
  f.options.loadDirectoryMetadata = () => ({ C_SECRET: { visible: true, name: "Presentation", description: "presentation", members: ["U_VIEWER"] } });
  f.visible.delete("C_SECRET");
  const empty = { agents: [], returned: 0, hasMore: false, nextOffset: null };
  assert.deepEqual(await searchAgentDirectory({ ...f.options, query: "presentation" }), empty);
  assert.deepEqual(f.checked, ["C_SECRET"]);
  f.visible.set("C_SECRET", { visible: true, type: "channel", name: "Fresh accounting", description: "Invoices" });
  assert.deepEqual(await searchAgentDirectory({ ...f.options, query: "presentation" }), empty);
  delete f.options.loadDirectoryMetadata;
  f.visible.get("C_SECRET").description = "presentation";
  assert.equal((await searchAgentDirectory({ ...f.options, query: "presentation" })).returned, 1, "uncached entries get a live attempt");
});

test("pagination offsets count live visible matches and stop after one extra visible result", async () => {
  const f = fixture();
  const cache = {};
  for (const id of ["C_A", "C_B", "C_C", "C_D", "C_E", "C_F"]) {
    f.add(id);
    cache[id] = { name: id, description: "Live channel purpose" };
  }
  f.options.loadDirectoryMetadata = () => cache;
  f.visible.delete("C_A"); f.visible.delete("C_C");
  const first = await searchAgentDirectory({ ...f.options, limit: 1 });
  assert.deepEqual(first.agents.map((agent) => agent.channelId), ["C_B"]);
  assert.deepEqual(f.checked, ["C_A", "C_B", "C_C", "C_D"]);
  assert.equal(first.nextOffset, 1);
  f.checked.length = 0;
  const next = await searchAgentDirectory({ ...f.options, limit: 1, offset: first.nextOffset });
  assert.deepEqual(next.agents.map((agent) => agent.channelId), ["C_D"]);
  assert.deepEqual(f.checked, ["C_A", "C_B", "C_C", "C_D", "C_E"]);
  assert.equal(next.nextOffset, 2);
});

test("query matches beyond the first forty skills remain searchable and lead the bounded summaries", async () => {
  const f = fixture();
  const names = Array.from({ length: 45 }, (_, i) => `shared-skill-${i}`);
  for (const slug of names) f.skills.set(slug, { slug, name: slug, description: "General workflow" });
  f.skills.get(names[44]).description = "quantum-presentation specialist";
  f.add("C_SPECIALIST", { skills: names });
  f.options.loadDirectoryMetadata = () => ({ C_SPECIALIST: { name: "Specialist", description: "Old purpose" } });
  const result = await searchAgentDirectory({ ...f.options, query: "quantum-presentation" });
  const agent = result.agents[0];
  assert.equal(agent.skills[0].slug, names[44]);
  assert.equal(agent.skills.length, 40);
  assert.equal(agent.skillsTotal, 45);
  assert.equal(agent.skillsTruncated, true);
  const ordinary = (await searchAgentDirectory(f.options)).agents[0];
  assert.equal(ordinary.skills[0].slug, names[0], "empty searches preserve the shared grant order");
  f.metas.get("c_specialist").skills = names.slice(0, 2);
  const small = (await searchAgentDirectory(f.options)).agents[0];
  assert.equal(small.skillsTotal, 2); assert.equal(small.skillsTruncated, false);
});

test("byte-limited result pages paginate by actual returned visible agents without dropping entries", async () => {
  const f = fixture();
  const names = Array.from({ length: 40 }, (_, i) => `large-skill-${i}`);
  for (const slug of names) f.skills.set(slug, { slug, name: slug, description: "x".repeat(600) });
  for (let i = 0; i < 7; i++) f.add(`C_LARGE_${i}`, { skills: names });
  let offset = 0;
  const seen = [];
  do {
    const result = await searchAgentDirectory({ ...f.options, limit: 50, offset });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
    assert.ok(result.returned > 0 && result.returned < 50);
    seen.push(...result.agents.map((agent) => agent.channelId));
    assert.equal(result.nextOffset, result.hasMore ? offset + result.returned : null);
    offset = result.nextOffset;
  } while (offset !== null);
  assert.deepEqual(seen, Array.from({ length: 7 }, (_, i) => `C_LARGE_${i}`));
});

test("a Unicode-heavy agent fits one page and reports byte-driven skill truncation", async () => {
  const f = fixture();
  const names = Array.from({ length: 40 }, (_, i) => `unicode-skill-${i}`);
  for (const slug of names) f.skills.set(slug, { slug, name: "界".repeat(160), description: "界".repeat(600) });
  f.add("C_UNICODE", { skills: names });
  const result = await searchAgentDirectory(f.options);
  assert.equal(result.returned, 1);
  assert.ok(result.agents[0].skills.length < 40);
  assert.equal(result.agents[0].skillsTotal, 40);
  assert.equal(result.agents[0].skillsTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
});
