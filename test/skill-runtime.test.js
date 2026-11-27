// Model-specific skills (src/gateway/skill-runtime.js): a skill's optional `model:` frontmatter,
// the one-line `use_skill` instruction its materialized copy carries, the daemon's inline/delegate
// decision, the channel switch that gates it, and the orchestrator's same-session model swap.
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, tempDir } from "./helpers.js";

process.env.CG_TRANSIENT_RETRY_DELAY_MS = "40";
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const {
  skillModelPreference, engineForModel, withSkillRuntimeHeader, skillRuntimeHeader, decideSkillSwap, skillSwapReply, setSkillModelFrontmatter,
  registerSkillSwapHandler, requestSkillSwap, hasSkillSwapHandler, skillSwapKey, _resetSkillSwapHandlers, USE_SKILL_TOOL,
} = await import("../src/gateway/skill-runtime.js");
const catalog = await import("../src/gateway/skills/catalog.js");
const { materializeSkill } = await import("../src/gateway/skills/materialize.js");
const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage, resetEngineCooldowns } = await import("../src/gateway/run.js");
const { getThreadSkillModel, setThreadModel, clearThreadRuntimeOverrides } = await import("../src/gateway/thread-engine.js");
const { readEvents } = await import("../src/util/logger.js");
const { ctxFromClaims, createDirectDaemonIpc } = await import("../src/mcp/gateway-server.js");
const { register: registerChannelAdmin } = await import("../src/mcp/tools/channel-admin.js");
const { register: registerSkillTools } = await import("../src/mcp/tools/skills.js");
const { channelSwitchesNote } = await import("../src/gateway/folders.js");
const { POLICY_KEYS } = await import("../src/config/channel-audit.js");
const { WORKSPACE_FIELDS } = await import("../src/config/workspace-links.js");

const md = (name, description, extra = "", body = `# ${name}\n\nDo the thing.\n`) => ({ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}` });
const skillOf = (model, extra = {}) => ({ slug: "triage", name: "triage", meta: { model, ...extra } });

// ── The declaration ───────────────────────────────────────────────────────────────────────────

test("skillModelPreference reads `model:` and derives the engine; anything unusable is ignored", () => {
  assert.deepEqual(skillModelPreference(skillOf("gpt-6.1-sol")), { model: "gpt-6.1-sol", engine: "codex" });
  assert.deepEqual(skillModelPreference(skillOf(" Claude-Sonnet-5-5 ")), { model: "claude-sonnet-5-5", engine: "claude" });
  assert.deepEqual(skillModelPreference(skillOf("sonnet")), { model: "sonnet", engine: "claude" });
  assert.equal(skillModelPreference(skillOf("")), null);
  assert.equal(skillModelPreference(skillOf(undefined)), null);
  assert.equal(skillModelPreference(skillOf("two words")), null);
  assert.equal(skillModelPreference(skillOf("x".repeat(65))), null, "over-long ids never reach a CLI flag");
  assert.equal(skillModelPreference(skillOf("nonsense-model")), null, "a model no engine recognizes is ignored");
  assert.equal(skillModelPreference(skillOf({ nested: true })), null);
  assert.equal(skillModelPreference(null), null);
  assert.equal(engineForModel(""), "", "an empty id matches no engine (modelBelongsToEngine is true for empty)");
});

test("withSkillRuntimeHeader inserts the use_skill line after the frontmatter, once, only for skills with a preference", () => {
  const bundle = { revision: { id: 1 }, files: [md("triage", "Triage mail", "model: sonnet\n"), { path: "references/a.md", content: Buffer.from("A") }] };
  const out = withSkillRuntimeHeader(skillOf("sonnet"), bundle);
  assert.notEqual(out, bundle);
  const text = out.files[0].content.toString("utf8");
  assert.ok(text.startsWith("---\nname: triage\n"), "frontmatter stays first and intact");
  const header = skillRuntimeHeader("triage");
  assert.ok(text.includes(`---\n\n${header}# triage`), `header sits between the frontmatter and the body:\n${text}`);
  assert.match(header, new RegExp(`\`${USE_SKILL_TOOL}\``));
  assert.equal(out.files[1], bundle.files[1], "other files are the same objects");
  // Idempotent: materializing a bundle that already carries the header changes nothing.
  assert.equal(withSkillRuntimeHeader(skillOf("sonnet"), out), out);
  // No preference → the very same bundle object (no copy, no transform).
  assert.equal(withSkillRuntimeHeader(skillOf(undefined), bundle), bundle);
  // No frontmatter → header first.
  const bare = { revision: { id: 1 }, files: [{ path: "SKILL.md", content: Buffer.from("# bare\n") }] };
  assert.ok(withSkillRuntimeHeader(skillOf("sonnet"), bare).files[0].content.toString("utf8").startsWith(header));
  // No SKILL.md at all → untouched.
  const noSkill = { revision: { id: 1 }, files: [{ path: "x.md", content: Buffer.from("x") }] };
  assert.equal(withSkillRuntimeHeader(skillOf("sonnet"), noSkill), noSkill);
});

test("materializeSkill writes the header into the channel copy and sees it as unchanged on the next pass", async () => {
  const dir = tempDir("cg-skill-swap-mat-");
  catalog.putSkillRevision({ files: [md("Swap Mat Skill", "materialized with a model", "model: sonnet\n")], ownerKind: "local" });
  catalog.putSkillRevision({ files: [md("Swap Mat Plain", "materialized without a model")], ownerKind: "local" });
  assert.equal((await materializeSkill(dir, "swap-mat-skill")).state, "written");
  const written = await readFile(path.join(dir, "swap-mat-skill", "SKILL.md"), "utf8");
  assert.ok(written.includes(skillRuntimeHeader("swap-mat-skill")), "the on-disk SKILL.md carries the instruction");
  assert.ok(written.startsWith("---\nname: Swap Mat Skill\n"));
  assert.equal((await materializeSkill(dir, "swap-mat-skill")).state, "unchanged", "the comparison sees the transformed bytes too");
  assert.equal((await materializeSkill(dir, "swap-mat-plain")).state, "written");
  assert.equal((await readFile(path.join(dir, "swap-mat-plain", "SKILL.md"), "utf8")).includes(USE_SKILL_TOOL), false, "a skill without a preference is byte-identical to its revision");
  const stored = catalog.revisionFile(catalog.effectiveRevisionFor(catalog.getSkill("swap-mat-skill")).id, "SKILL.md").content.toString("utf8");
  assert.equal(stored.includes(USE_SKILL_TOOL), false, "the catalog revision is never rewritten");
});

test("setSkillModelFrontmatter sets, replaces, clears and validates the model line without touching the rest", () => {
  const base = "---\nname: triage\ndescription: Triage mail\ntags: [a]\n---\n\n# triage\n";
  assert.equal(setSkillModelFrontmatter(base, "Sonnet"), "---\nname: triage\ndescription: Triage mail\ntags: [a]\nmodel: sonnet\n---\n\n# triage\n");
  const withModel = "---\nname: triage\nmodel: opus\ndescription: Triage mail\n---\nbody\n";
  assert.equal(setSkillModelFrontmatter(withModel, "gpt-6.1-sol"), "---\nname: triage\nmodel: gpt-6.1-sol\ndescription: Triage mail\n---\nbody\n", "replaced in place");
  assert.equal(setSkillModelFrontmatter(withModel, ""), "---\nname: triage\ndescription: Triage mail\n---\nbody\n", "an empty model removes the line");
  assert.equal(setSkillModelFrontmatter(base, ""), base, "clearing an absent line changes nothing");
  assert.equal(setSkillModelFrontmatter("# bare\n", "sonnet"), "---\nmodel: sonnet\n---\n\n# bare\n", "no frontmatter → a minimal header");
  assert.equal(setSkillModelFrontmatter("# bare\n", ""), "# bare\n");
  assert.throws(() => setSkillModelFrontmatter(base, "made-up-model"), /not a model any engine/);
  assert.throws(() => setSkillModelFrontmatter("---\nname: x\n", "sonnet"), /not closed/);
});

test("create_skill and update_skill take an optional model that writes the frontmatter line", async () => {
  await setUser("U_SWAP_AUTHOR", { name: "Swap Author", approved: true, isAdmin: true });
  const entry = await upsertChannelEntry("C_SWAP_AUTHOR", { name: "swap-author", type: "channel" });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: "C_SWAP_AUTHOR", name: entry.name, type: "channel", isDM: false }), access: "approved" });
  const tools = new Map();
  registerSkillTools({ registerTool: (name, _def, handler) => tools.set(name, handler) },
    ctxFromClaims({ channelId: "C_SWAP_AUTHOR", slug: entry.slug, authorId: "U_SWAP_AUTHOR", threadKey: "1700000000.000400", principalTrusted: true, engine: "claude", toolset: "full" }));
  const skillMd = (slug) => catalog.revisionFile(catalog.effectiveRevisionFor(catalog.getSkill(slug)).id, "SKILL.md").content.toString("utf8");

  const created = await tools.get("create_skill")({ files: [md("Swap Authored", "a skill created with a model")], model: "Sonnet", scope: "channel" });
  assert.match(created.content[0].text, /Created channel skill `swap-authored`/);
  assert.match(skillMd("swap-authored"), /\nmodel: sonnet\n---/);
  assert.deepEqual(skillModelPreference(catalog.getSkill("swap-authored")), { model: "sonnet", engine: "claude" });
  // An unknown model is refused before anything is written.
  const refused = await tools.get("create_skill")({ files: [md("Swap Refused", "never created")], model: "no-such-model" });
  assert.match(refused.content[0].text, /not a model any engine/);
  assert.equal(catalog.getSkill("swap-refused"), null);
  // A model-only update rewrites just the frontmatter and keeps every other file.
  catalog.putSkillRevision({ files: [md("Swap Authored", "a skill created with a model", "model: sonnet\n"), { path: "references/a.md", content: "A" }], ownerKind: "local" });
  const updated = await tools.get("update_skill")({ skill: "swap-authored", model: "gpt-6.1-sol" });
  assert.match(updated.content[0].text, /is now revision/);
  assert.match(skillMd("swap-authored"), /\nmodel: gpt-6.1-sol\n---/);
  assert.match((await tools.get("get_skill_info")({ skill: "swap-authored" })).content[0].text, /preferred model: gpt-6\.1-sol/);
  assert.match((await tools.get("list_skills")({ query: "swap-authored" })).content[0].text, /prefers gpt-6\.1-sol/);
  assert.equal(catalog.revisionFiles(catalog.effectiveRevisionFor(catalog.getSkill("swap-authored")).id).length, 2, "the reference file survived a model-only update");
  const cleared = await tools.get("update_skill")({ skill: "swap-authored", model: "" });
  assert.match(cleared.content[0].text, /is now revision/);
  assert.doesNotMatch(skillMd("swap-authored"), /model:/);
  assert.equal(skillModelPreference(catalog.getSkill("swap-authored")), null);
  assert.match((await tools.get("update_skill")({ skill: "swap-authored" })).content[0].text, /Nothing to change/);
});

// ── The decision ──────────────────────────────────────────────────────────────────────────────

test("decideSkillSwap: inline when possible, delegate across engines, never over a pin or with the switch off", () => {
  const on = { skillRuntimeSwap: true };
  const available = (id) => id === "codex" || id === "claude";
  const base = { meta: on, engine: "claude", model: "opus", pinned: false, swapped: false, engineAvailable: available };
  assert.equal(decideSkillSwap({ ...base, skill: null }).reason, "unknown-skill");
  assert.equal(decideSkillSwap({ ...base, skill: skillOf(undefined) }).reason, "no-preference");
  assert.deepEqual(decideSkillSwap({ ...base, meta: {}, skill: skillOf("sonnet") }), { slug: "triage", model: "sonnet", engine: "claude", action: "none", reason: "disabled" });
  assert.equal(decideSkillSwap({ ...base, pinned: true, skill: skillOf("sonnet") }).reason, "pinned");
  assert.equal(decideSkillSwap({ ...base, model: "Sonnet", skill: skillOf("sonnet") }).reason, "already");
  assert.deepEqual(decideSkillSwap({ ...base, skill: skillOf("sonnet") }), { slug: "triage", model: "sonnet", engine: "claude", action: "inline", reason: "same-engine" });
  assert.equal(decideSkillSwap({ ...base, swapped: true, skill: skillOf("sonnet") }).action, "subagent");
  assert.deepEqual(decideSkillSwap({ ...base, skill: skillOf("gpt-6.1-sol") }), { slug: "triage", model: "gpt-6.1-sol", engine: "codex", action: "delegate", reason: "other-engine" });
  assert.equal(decideSkillSwap({ ...base, engineAvailable: () => false, skill: skillOf("gpt-6.1-sol") }).reason, "engine-unavailable");
  // The pin outranks even a cross-engine preference: nothing is delegated around a person's choice.
  assert.equal(decideSkillSwap({ ...base, pinned: true, skill: skillOf("gpt-6.1-sol") }).action, "none");
});

test("skillSwapReply tells the model exactly what to do in every branch", () => {
  const label = (id) => ({ claude: "Claude", codex: "Codex" })[id] || id;
  const inline = skillSwapReply({ action: "inline", slug: "triage", model: "sonnet", engine: "claude" }, { engineLabel: label });
  assert.match(inline, /STOP NOW/);
  assert.match(inline, /sonnet \(Claude\)/);
  const delegate = skillSwapReply({ action: "delegate", slug: "triage", model: "gpt-6.1-sol", engine: "codex" }, { engineLabel: label });
  assert.match(delegate, /run_agent_in_background with engine "codex", model "gpt-6.1-sol"/);
  assert.match(skillSwapReply({ action: "subagent", slug: "triage", model: "sonnet" }, { currentModel: "opus" }), /Continue on the current model \(opus\).*subagent using model sonnet/);
  for (const [reason, pattern] of [
    ["unknown-skill", /No skill named/], ["no-preference", /declares no preferred model/], ["disabled", /swapping is OFF/],
    ["pinned", /pinned by a person/], ["already", /Already running sonnet/], ["engine-unavailable", /not enabled/], ["no-live-turn", /No live turn/],
  ]) {
    assert.match(skillSwapReply({ action: "none", reason, slug: "triage", model: "sonnet", engine: "codex" }, { engineLabel: label }), pattern, reason);
  }
});

test("the live-turn registry answers by thread key and never acts without a registered turn", async () => {
  _resetSkillSwapHandlers();
  assert.deepEqual(await requestSkillSwap({ slug: "s", threadKey: "t", name: "triage" }), { ok: true, decision: { action: "none", reason: "no-live-turn", slug: "triage" } });
  const calls = [];
  const off = registerSkillSwapHandler(skillSwapKey("s", "t"), async ({ name }) => { calls.push(name); return { action: "inline", slug: name, model: "sonnet", engine: "claude" }; });
  assert.equal(hasSkillSwapHandler("s::t"), true);
  assert.equal((await requestSkillSwap({ slug: "s", threadKey: "t", name: "triage" })).decision.action, "inline");
  assert.equal((await requestSkillSwap({ slug: "s", threadKey: "t::agent-9", name: "triage" })).decision.reason, "no-live-turn", "a background agent's key is its own");
  assert.deepEqual(calls, ["triage"]);
  const broken = registerSkillSwapHandler(skillSwapKey("s", "u"), async () => { throw new Error("boom"); });
  assert.deepEqual(await requestSkillSwap({ slug: "s", threadKey: "u", name: "x" }), { ok: false, error: "boom" });
  off(); broken();
  assert.equal(hasSkillSwapHandler("s::t"), false);
  assert.equal(registerSkillSwapHandler("", () => {})(), undefined, "a blank key registers nothing and returns a no-op");
});

// ── The channel switch, on every surface that lists switches ──────────────────────────────────

test("skillRuntimeSwap is a curated, audited, folder-shared channel switch with a managed-block line", () => {
  assert.ok(POLICY_KEYS.includes("skillRuntimeSwap"));
  assert.ok(WORKSPACE_FIELDS.includes("skillRuntimeSwap"));
  assert.equal(defaultChannelMeta({ channelId: "C1", name: "x", type: "channel", isDM: false }).skillRuntimeSwap, false, "off by default");
  assert.match(channelSwitchesNote({ skillRuntimeSwap: true }), /Skill model swap: \*\*on\*\*/);
  assert.match(channelSwitchesNote({}), /Skill model swap: \*\*off\*\*\./);
});

test("set_channel_skill_swap: managers flip the switch, audited, and use_skill relays the live turn's decision", async () => {
  await setUser("U_SWAP_ADMIN", { name: "Swap Admin", approved: true, isAdmin: true });
  const entry = await upsertChannelEntry("C_SWAP_TOOLS", { name: "swap-tools", type: "channel" });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: entry.channelId, name: entry.name, type: "channel", isDM: false }), access: "approved", manageAccess: "admins" });
  const tools = new Map();
  const ctx = ctxFromClaims({ channelId: entry.channelId, slug: entry.slug, authorId: "U_SWAP_ADMIN", threadKey: "1700000000.000300", principalTrusted: true, engine: "claude", toolset: "full" },
    { daemon: createDirectDaemonIpc({ "skill-swap": requestSkillSwap }) });
  registerChannelAdmin({ registerTool: (name, _def, handler) => tools.set(name, handler) }, ctx);
  registerSkillTools({ registerTool: (name, _def, handler) => tools.set(name, handler) }, ctx);

  assert.match((await tools.get("set_channel_skill_swap")({ enabled: true })).content[0].text, /swapping ON/);
  assert.equal((await getChannelMeta(entry.slug)).skillRuntimeSwap, true);
  const audit = readEvents({ limit: 50 }).find((e) => e.event === "channel_meta_changed" && e.slug === entry.slug);
  assert.ok(audit && audit.keys.includes("skillRuntimeSwap"), "the flip leaves an audit row naming the key");
  assert.match((await tools.get("set_channel_skill_swap")({ enabled: false })).content[0].text, /swapping OFF/);

  // use_skill with no live turn for this thread: a plain "continue", nothing persisted.
  _resetSkillSwapHandlers();
  assert.match((await tools.get(USE_SKILL_TOOL)({ name: "triage" })).content[0].text, /No live turn/);
  // …and with one: the turn's own reply comes back verbatim.
  const off = registerSkillSwapHandler(skillSwapKey(entry.slug, "1700000000.000300"), async () => ({ action: "inline", slug: "triage", model: "sonnet", engine: "claude", reply: "STOP NOW: resumed on sonnet." }));
  assert.equal((await tools.get(USE_SKILL_TOOL)({ name: "triage" })).content[0].text, "STOP NOW: resumed on sonnet.");
  off();
  // A member who may not manage the channel is refused.
  await setUser("U_SWAP_MEMBER", { name: "Swap Member", approved: true, isAdmin: false });
  const memberTools = new Map();
  registerChannelAdmin({ registerTool: (name, _def, handler) => memberTools.set(name, handler) },
    ctxFromClaims({ channelId: entry.channelId, slug: entry.slug, authorId: "U_SWAP_MEMBER", threadKey: "1700000000.000301", principalTrusted: true, engine: "claude" }));
  assert.match((await memberTools.get("set_channel_skill_swap")({ enabled: true })).content[0].text, /Only this channel's managers/);
  assert.equal((await getChannelMeta(entry.slug)).skillRuntimeSwap, false);
});

// ── The orchestrator: same session, new model, sticky below the pin ───────────────────────────

const turn = (channelId, authorId, text, threadKey, extra = {}) => runMessage({
  channelId, authorId, text, threadKey, origin: "slack_foreground", preferCold: true,
  getFallbackContext: async () => "Conversation context\n\n",
  ...extra,
});
const until = async (check, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

test("a skill's preferred model resumes the SAME session mid-turn, sticks on the thread, and yields to a user pin", async () => {
  resetEngineCooldowns();
  _resetSkillSwapHandlers();
  saveSettings({ engine: "claude", defaultClaudeModel: "opus", engineFallback: false, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_SWAP_RUN", { name: "Swap Runner", approved: true, isAdmin: false });
  catalog.putSkillRevision({ files: [md("Swap Run Triage", "a skill that prefers sonnet", "model: sonnet\n")], ownerKind: "local" });
  const entry = await upsertChannelEntry("D_SWAP_RUN", { name: "swap-run", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: "D_SWAP_RUN", name: entry.name, type: "im", isDM: true, template: "custom",
    engine: "claude", cleanMode: true, allowNetwork: false, skillRuntimeSwap: true,
  });
  const threadKey = "1905.001";
  const key = skillSwapKey(entry.slug, threadKey);

  // Turn 1: the stub holds the turn open; the "model" calls use_skill (here: the daemon service
  // directly, which is all the tool does), is told to stop, and the orchestrator resumes on sonnet.
  const running = turn("D_SWAP_RUN", "U_SWAP_RUN", "CLAUDE_STUB_WAIT_FOR_GO please triage", threadKey);
  assert.ok(await until(() => hasSkillSwapHandler(key)), "the live turn registered its swap handler");
  const asked = await requestSkillSwap({ slug: entry.slug, threadKey, name: "swap-run-triage" });
  assert.equal(asked.decision.action, "inline", JSON.stringify(asked));
  assert.match(asked.decision.reply, /STOP NOW/);
  // The same ask repeated while the swap is pending is answered the same way; a DIFFERENT skill
  // with another model in this turn is advised to use a subagent, never swapped inline again.
  assert.equal((await requestSkillSwap({ slug: entry.slug, threadKey, name: "swap-run-triage" })).decision.action, "inline");
  catalog.putSkillRevision({ files: [md("Swap Run Other", "another skill that prefers haiku", "model: haiku\n")], ownerKind: "local" });
  assert.equal((await requestSkillSwap({ slug: entry.slug, threadKey, name: "swap-run-other" })).decision.action, "subagent");
  const { workspaceFolder } = await import("../src/config/paths.js");
  await writeFile(path.join(workspaceFolder(entry.slug), ".cg-stub-go"), "go\n");
  const result = await running;
  assert.equal(result.engine, "claude");
  assert.equal(result.model, "sonnet", "the footer names the model that answered");
  assert.match(result.content, /Switched this thread to sonnet for the swap-run-triage skill/);
  assert.match(result.content, /resume=yes.*model=sonnet/, "the continuation RESUMED the session with the new model");
  assert.equal(hasSkillSwapHandler(key), false, "the handler is gone once the turn ends");
  assert.equal(await getThreadSkillModel(entry.slug, threadKey), "sonnet", "sticky on the thread as a skill preference");
  const events = readEvents({ limit: 200 }).filter((e) => e.slug === entry.slug);
  assert.equal(events.filter((e) => e.event === "run_skill_swap").length, 1);
  const decisions = events.filter((e) => e.event === "run_skill_swap_decision").map((e) => `${e.action}:${e.reason}`);
  assert.ok(decisions.includes("inline:same-engine") && decisions.includes("subagent:second-skill"), `decisions are logged: ${decisions.join(", ")}`);
  const swapEvent = events.find((e) => e.event === "run_skill_swap");
  assert.equal(swapEvent.fromModel, "opus");
  assert.equal(swapEvent.toModel, "sonnet");

  // Turn 2: an ordinary message in the same thread stays on sonnet — no pin, no swap, just the preference.
  const second = await turn("D_SWAP_RUN", "U_SWAP_RUN", "follow-up", threadKey);
  assert.equal(second.model, "sonnet");
  assert.match(second.content, /resume=yes.*model=sonnet/);
  assert.doesNotMatch(second.content, /Switched this thread/);

  // Turn 3: a person pins the thread → the pin wins, and a skill asking again is refused as pinned.
  await setThreadModel(entry.slug, threadKey, "opus");
  const pinnedRun = turn("D_SWAP_RUN", "U_SWAP_RUN", "CLAUDE_STUB_WAIT_FOR_GO pinned", threadKey);
  assert.ok(await until(() => hasSkillSwapHandler(key)));
  assert.equal((await requestSkillSwap({ slug: entry.slug, threadKey, name: "swap-run-triage" })).decision.reason, "pinned");
  await writeFile(path.join(workspaceFolder(entry.slug), ".cg-stub-go"), "go\n");
  const third = await pinnedRun;
  assert.equal(third.model, "opus");
  assert.doesNotMatch(third.content, /Switched this thread/);

  // The runtime reset clears the preference along with the pin.
  assert.ok((await clearThreadRuntimeOverrides([entry.slug])) >= 2);
  assert.equal(await getThreadSkillModel(entry.slug, threadKey), "");

  // With the channel switch OFF the same ask is refused and the turn stays where it is.
  await saveChannelMeta(entry.slug, { ...(await getChannelMeta(entry.slug)), skillRuntimeSwap: false });
  const offRun = turn("D_SWAP_RUN", "U_SWAP_RUN", "CLAUDE_STUB_WAIT_FOR_GO off", "1905.002");
  assert.ok(await until(() => hasSkillSwapHandler(skillSwapKey(entry.slug, "1905.002"))));
  const refused = await requestSkillSwap({ slug: entry.slug, threadKey: "1905.002", name: "swap-run-triage" });
  assert.equal(refused.decision.reason, "disabled");
  assert.match(refused.decision.reply, /swapping is OFF/);
  await writeFile(path.join(workspaceFolder(entry.slug), ".cg-stub-go"), "go\n");
  const fourth = await offRun;
  assert.equal(fourth.model, "opus");
  assert.doesNotMatch(fourth.content, /Switched this thread/);
});
