// A retired harness is deleted code, but not deleted DATA. Every place a harness id is stored as
// a plain string — a channel default, the channel/DM templates, a thread pin, an approved-harness
// policy, a session stamp, the gateway default — can still say `opencode` after the upgrade, and
// a restored backup can bring any of them back later. None of them may end a turn or make a save
// throw: each one resolves to the normal default (src/engines/retired.js names the readers).
// The rows are written with raw SQL on purpose — the store refuses to WRITE these values today,
// so only a pre-upgrade database can hold them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, clearTestLicense } from "./helpers.js";

ensureTestEnv();
clearTestLicense();

const { RETIRED_ENGINE_IDS, isRetiredEngineId } = await import("../src/engines/retired.js");
const { ENGINE_IDS, isEngineId, adapterFor } = await import("../src/engines/registry.js");
const { getDb } = await import("../src/db/index.js");
const { upsertChannelEntry, defaultChannelMeta, getChannelMeta, patchChannelMeta, saveChannelMeta, setUser, getUser } = await import("../src/config/store.js");
const { saveSettings, getSettings, getEngine, getEngineEnabledMap, isEngineEnabled, getChannelTemplate, applyChannelTemplate } = await import("../src/config/settings.js");
const { stripDeadFields, stripDeadSettings } = await import("../src/config/dead-fields.js");
const { effectiveMeta } = await import("../src/gateway/effective-meta.js");
const policy = await import("../src/gateway/channel-engines.js");
const { getThreadEngine, resolveThreadEngine } = await import("../src/gateway/thread-engine.js");
const { getSession, getSessionEngine, getSessionRuntime, resolveSession, hasThreadSession } = await import("../src/gateway/sessions.js");
const { decideThreadEngine } = await import("../src/gateway/run.js");
const { modeLabel } = await import("../src/gateway/modes.js");

const RETIRED = "opencode";
let counter = 0;

// A channel whose stored record is exactly what an older release wrote.
async function storedChannel(extra, { isDM = false } = {}) {
  const channelId = `${isDM ? "D" : "C"}_RETIRED_${++counter}`;
  const entry = await upsertChannelEntry(channelId, { name: `retired-${counter}`, type: isDM ? "im" : "channel", isDM });
  const data = { ...defaultChannelMeta({ channelId, name: entry.name, type: entry.type, isDM }), ...extra };
  getDb().prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?)").run(entry.slug, JSON.stringify(data));
  return { channelId, entry };
}
const rawMeta = (slug) => JSON.parse(getDb().prepare("SELECT data FROM channel_meta WHERE slug = ?").get(slug).data);

test("a retired harness is never a registered one", () => {
  assert.deepEqual(RETIRED_ENGINE_IDS, [RETIRED]);
  for (const id of RETIRED_ENGINE_IDS) {
    assert.equal(isRetiredEngineId(id), true);
    assert.equal(isEngineId(id), false, `${id} must not be registered again`);
    assert.equal(adapterFor(id) ?? null, null);
    assert.ok(!ENGINE_IDS.includes(id));
  }
  assert.equal(isRetiredEngineId("claude"), false);
  assert.equal(isRetiredEngineId(""), false);
  assert.equal(isRetiredEngineId(undefined), false);
});

test("a channel default naming a retired harness follows the gateway default again", async () => {
  saveSettings({ engine: "claude" });
  const { entry } = await storedChannel({ engine: RETIRED, model: "opencode/big-pickle", effort: "high", allowBash: true, allowNetwork: true });
  assert.equal(rawMeta(entry.slug).engine, RETIRED, "the fixture really is a pre-upgrade row");

  const meta = await getChannelMeta(entry.slug);
  assert.equal(meta.engine, undefined);
  // The model and effort were that harness's own; they would become another CLI's --model flag.
  assert.equal(meta.model, undefined);
  assert.equal(meta.effort, undefined);
  assert.equal(await resolveThreadEngine(entry.slug, "t-default", meta), "claude");
  assert.equal(modeLabel(meta), "Worker · network on");

  // Any later save of the channel's settings succeeds and rewrites the row without the default.
  const patched = await patchChannelMeta(entry.slug, { autoMode: true });
  assert.equal(patched.autoMode, true);
  assert.equal(Object.hasOwn(rawMeta(entry.slug), "engine"), false);
  assert.equal(Object.hasOwn(rawMeta(entry.slug), "model"), false);
  // A whole-record save prepared from a stale copy cannot write it back either.
  const saved = await saveChannelMeta(entry.slug, { ...rawMeta(entry.slug), engine: RETIRED, model: "opencode/big-pickle" });
  assert.equal(saved.engine, undefined);
  assert.equal(Object.hasOwn(rawMeta(entry.slug), "engine"), false);
});

test("templates naming a retired harness do not block registration or project it onto a DM", async () => {
  saveSettings({ engine: "codex", channelTemplate: { engine: RETIRED, model: "opencode/big-pickle" }, dmTemplates: { user: { engine: RETIRED }, admin: {} } });
  try {
    assert.equal(getChannelTemplate().engine, RETIRED, "the fixture really is a pre-upgrade setting");
    // A new channel copies the channel template once — that copy must not refuse the registration.
    const channelId = `C_RETIRED_TEMPLATE_${++counter}`;
    const entry = await upsertChannelEntry(channelId, { name: `retired-template-${counter}`, type: "channel", isDM: false });
    const initial = applyChannelTemplate(defaultChannelMeta({ channelId, name: entry.name, type: entry.type, isDM: false }));
    assert.equal(initial.engine, RETIRED);
    const meta = await saveChannelMeta(entry.slug, initial);
    assert.equal(meta.engine, undefined);
    assert.equal(meta.model, undefined);
    assert.equal(await resolveThreadEngine(entry.slug, "t-template", meta), "codex");

    // A template-managed DM resolves the template live on every run.
    const dm = effectiveMeta({ isDM: true, template: "user", engine: "", model: "", effort: "" });
    assert.equal(dm.engine, "");
    assert.equal(effectiveMeta({ isDM: true, template: "user", engine: RETIRED }).engine, "");
    assert.equal(effectiveMeta({ isDM: true, template: "user", engine: "claude" }).engine, "claude");
  } finally {
    saveSettings({ engine: "claude", channelTemplate: {}, dmTemplates: { user: {}, admin: {} } });
  }
});

test("a thread pinned to a retired harness is not pinned", async () => {
  saveSettings({ engine: "claude" });
  const { entry } = await storedChannel({ engine: "codex" });
  getDb().prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES(?, ?, 'engine', ?)").run(entry.slug, "t-pin", RETIRED);
  assert.equal(await getThreadEngine(entry.slug, "t-pin"), "");
  // …so the thread follows its channel, then the gateway default, like any unpinned thread.
  assert.equal(await resolveThreadEngine(entry.slug, "t-pin", await getChannelMeta(entry.slug)), "codex");
  assert.equal(await resolveThreadEngine(entry.slug, "t-pin", {}), "claude");
});

test("an approved-harness policy keeps its remaining harnesses when one of them was retired", async () => {
  assert.deepEqual(policy.normalizeApprovedEngines(["codex", RETIRED, "claude"]), ["claude", "codex"]);
  const mixed = { approvedEngines: [RETIRED, "codex"] };
  assert.equal(policy.isChannelEngineApproved(mixed, "codex"), true);
  assert.equal(policy.isChannelEngineApproved(mixed, "claude"), false, "retiring a harness never widens the policy");
  assert.equal(policy.isChannelEngineApproved(mixed, RETIRED), false);
  assert.doesNotThrow(() => policy.assertChannelEngineApproved(mixed, "codex"));
  // An id no release ever shipped is still a malformed policy, and still fails closed.
  assert.equal(policy.isChannelEngineApproved({ approvedEngines: ["codex", "removed"] }, "codex"), false);
  assert.throws(() => policy.normalizeApprovedEngines(["codex", "removed"]), /nonempty list/);

  // Without the Enterprise entitlement a save may not CHANGE the policy — dropping the retired id
  // is not a change, so ordinary settings saves keep working and tidy the stored list.
  const { entry } = await storedChannel({ engine: "codex", approvedEngines: [RETIRED, "codex"] });
  assert.deepEqual(policy.assertApprovedEnginesUpdate(mixed, [RETIRED, "codex"], { enterprise: false }), ["codex"]);
  const patched = await patchChannelMeta(entry.slug, { autoMode: true });
  assert.deepEqual(patched.approvedEngines, ["codex"]);
  assert.deepEqual(rawMeta(entry.slug).approvedEngines, ["codex"]);
  assert.equal(patched.engine, "codex");
});

test("a policy that approved ONLY retired harnesses stays closed, and saves still work", async () => {
  const only = { approvedEngines: [RETIRED] };
  for (const id of ENGINE_IDS) assert.equal(policy.isChannelEngineApproved(only, id), false, `${id} was never approved here`);
  // Kept exactly as stored: dropping the list would silently lift the restriction.
  assert.deepEqual(policy.normalizeApprovedEngines([RETIRED]), [RETIRED]);
  assert.deepEqual(policy.assertApprovedEnginesUpdate(only, [RETIRED], { enterprise: false }), [RETIRED]);
  assert.throws(() => policy.assertApprovedEnginesUpdate(only, null, { enterprise: false }), /Enterprise/);
  assert.deepEqual(policy.assertApprovedEnginesUpdate(only, ["claude"], { enterprise: true }), ["claude"]);

  const { entry } = await storedChannel({ engine: RETIRED, approvedEngines: [RETIRED] });
  const patched = await patchChannelMeta(entry.slug, { autoMode: true });
  assert.equal(patched.autoMode, true);
  assert.equal(patched.engine, undefined);
  assert.deepEqual(rawMeta(entry.slug).approvedEngines, [RETIRED]);
});

test("a session minted by a retired harness is not resumable and does not hold the thread", async () => {
  const { entry } = await storedChannel({});
  getDb().prepare("INSERT INTO sessions(slug, thread_key, session_id, engine, runtime) VALUES(?, ?, ?, ?, ?)")
    .run(entry.slug, "t-session", "oc-minted-thread-id", RETIRED, JSON.stringify({ backend: "container" }));

  // Nothing offers the id for a resume, names its harness, or renders its runtime…
  assert.equal(await getSession(entry.slug, "t-session"), "");
  assert.equal(await getSessionEngine(entry.slug, "t-session"), "");
  assert.equal(await getSessionRuntime(entry.slug, "t-session"), null);
  assert.equal(await resolveThreadEngine(entry.slug, "t-session", {}), getEngine());
  // …but the thread is still one the bot engaged, and the run still sees the stamp, which is what
  // makes it start a fresh session with the chat transcript replayed instead of a blind one.
  assert.equal(await hasThreadSession(entry.slug, "t-session"), true);
  const row = await resolveSession(entry.slug, "t-session", "claude");
  assert.equal(row.isNew, false);
  assert.equal(row.engine, RETIRED);
  for (const explicit of [false, true]) {
    assert.deepEqual(
      decideThreadEngine({ requested: "claude", sessionEngine: row.engine, isNew: row.isNew, explicit }),
      { engine: "claude", switch: true },
    );
  }
  // A current harness's stamp still holds its thread against a mere default.
  assert.deepEqual(decideThreadEngine({ requested: "claude", sessionEngine: "codex", isNew: false, explicit: false }), { engine: "codex", switch: false });
  // A thread with no session at all is unchanged.
  assert.equal(await getSession(entry.slug, "t-none"), null);
});

test("gateway settings naming a retired harness resolve to the default and shed its fields", () => {
  saveSettings({ engine: RETIRED, engineEnabled: { claude: true, codex: true, [RETIRED]: true }, defaultOpenCodeModel: "opencode/big-pickle", defaultOpenCodeEffort: "high" });
  try {
    assert.equal(getEngine(), "claude");
    assert.equal(isEngineEnabled(RETIRED), false);
    assert.equal(Object.hasOwn(getEngineEnabledMap(), RETIRED), false);
    assert.equal(Object.hasOwn(getSettings(), "defaultOpenCodeModel"), false);
    assert.equal(Object.hasOwn(getSettings(), "defaultOpenCodeEffort"), false);
  } finally {
    saveSettings({ engine: "claude", engineEnabled: { claude: true, codex: true } });
  }
  const settings = stripDeadSettings({ engine: "claude", defaultOpenCodeModel: "x", defaultOpenCodeEffort: "y" });
  assert.deepEqual(settings, { engine: "claude" });
});

test("the retired harness's connector selection is stripped from channel and user records", async () => {
  assert.deepEqual(stripDeadFields({ allowedMcps: ["a"], allowedOpenCodeMcps: ["b"] }), { allowedMcps: ["a"] });
  const { entry } = await storedChannel({ allowedOpenCodeMcps: ["legacy"] });
  await patchChannelMeta(entry.slug, { autoMode: true });
  assert.equal(Object.hasOwn(rawMeta(entry.slug), "allowedOpenCodeMcps"), false);
  await setUser("U_RETIRED", { name: "Retired fields", approved: true, allowedOpenCodeMcps: ["legacy"] });
  assert.equal(Object.hasOwn(await getUser("U_RETIRED"), "allowedOpenCodeMcps"), false);
});
