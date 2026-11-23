// A conversation that selected more than one license of a harness moves to the next one when the
// first cannot answer, and only then to the other harness. Drives the real orchestrator against
// the stub CLIs on PATH; the stub Codex is "at its usage limit" on every login except an added
// license's own CODEX_HOME (CODEX_STUB_LIMIT_DEFAULT_LICENSE) or on all of them (…_ALL_LICENSES).
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const fixtureBin = path.join(fileURLToPath(new URL("..", import.meta.url)), "test", "fixtures");
ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
const backend = await useFakeRuntime();
process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings, getSettings } = await import("../src/config/settings.js");
const { runMessage, resetEngineCooldowns } = await import("../src/gateway/run.js");
const { getSessionEngine } = await import("../src/gateway/sessions.js");
const { setThreadEngine } = await import("../src/gateway/thread-engine.js");
const { createLicense, deleteLicense } = await import("../src/config/engine-licenses.js");
const { licenseLoginHome } = await import("../src/engines/license-state.js");

const jwt = () => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 864000, "https://api.openai.com/auth": { chatgpt_plan_type: "team", chatgpt_account_id: "lic-failover" } })).toString("base64url")}.fixture`;
const signedInLicense = (label) => {
  const record = createLicense({ kind: "codex-login", label, type: "business" });
  mkdirSync(licenseLoginHome(record.id), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(licenseLoginHome(record.id), "auth.json"), JSON.stringify({ tokens: { access_token: jwt(), refresh_token: "fixture-refresh", account_id: "lic-failover" } }), { mode: 0o600 });
  return record;
};
const fresh = (extra = {}) => {
  resetEngineCooldowns();
  saveSettings({ engineLicenses: [], engine: "codex", enginePool: "", engineFallback: true, engineFallbackMode: "auto", engineEnabled: { claude: true, codex: true }, composioMode: "personal", ...extra });
};
const channel = async (id, name, meta = {}) => {
  const entry = await upsertChannelEntry(id, { name, type: "im", isDM: true });
  await saveChannelMeta(entry.slug, { channelId: id, name: entry.name, type: "im", isDM: true, template: "custom", engine: "codex", cleanMode: true, allowNetwork: false, ...meta });
  return entry;
};
const turn = (channelId, authorId, text, threadKey, extra = {}) => runMessage({
  channelId, authorId, text, threadKey, origin: "slack_foreground", preferCold: true,
  getFallbackContext: async () => "Conversation context\n\n", ...extra,
});
const codexHomes = () => backend.calls.spawn.map((call) => call.env?.CODEX_HOME || "").filter(Boolean);

test("a limited license hands the turn to the next selected license of the same harness", async () => {
  fresh();
  const second = signedInLicense("Second seat");
  await setUser("U_LIC_MOVE", { name: "Lic Move", approved: true, isAdmin: false });
  const entry = await channel("D_LIC_MOVE", "lic-move", { licensePool: [second.id] });
  const before = backend.calls.spawn.length;

  const result = await turn("D_LIC_MOVE", "U_LIC_MOVE", "CODEX_STUB_LIMIT_DEFAULT_LICENSE", "2001.010");

  assert.equal(result.engine, second.id, "answered by the second license, not by Claude");
  assert.equal(result.fellBack, true);
  assert.equal(result.licenseSwitched, true);
  assert.equal(result.fallbackFrom, "codex");
  assert.equal(result.fellBackToCodex, false, "a move between two Codex licenses is not a move TO Codex");
  assert.match(result.content, /Codex hit its usage limit.*using Second seat/i);
  assert.match(result.content, /Codex stub reply/);
  assert.equal(await getSessionEngine(entry.slug, "2001.010"), second.id);
  const homes = codexHomes().slice(before);
  assert.ok(homes.some((home) => home.endsWith(`.cg-licenses/${second.id}`)), `the license ran on its own login directory (${homes.join(", ")})`);
  assert.ok(homes.some((home) => !home.includes(".cg-licenses")), "after the default sign-in was tried first");
});

test("`Any license` reaches a license added after the channel was configured", async () => {
  fresh();
  await setUser("U_LIC_ANY", { name: "Lic Any", approved: true, isAdmin: false });
  await channel("D_LIC_ANY", "lic-any", { licensePool: "any" });
  const later = signedInLicense("Added later");

  const result = await turn("D_LIC_ANY", "U_LIC_ANY", "CODEX_STUB_LIMIT_DEFAULT_LICENSE", "2002.010");
  assert.equal(result.engine, later.id);
  assert.equal(result.licenseSwitched, true);
});

test("a selection with no further licenses moves through every usable license of its harness", async () => {
  fresh();
  const other = signedInLicense("Unlisted seat");
  await setUser("U_LIC_ONE", { name: "Lic One", approved: true, isAdmin: false });
  await channel("D_LIC_ONE", "lic-one");

  const result = await turn("D_LIC_ONE", "U_LIC_ONE", "CODEX_STUB_LIMIT_DEFAULT_LICENSE", "2003.010");
  assert.equal(result.engine, other.id, "an empty pool is every license this conversation may use");
  assert.equal(result.licenseSwitched, true);
});

test("crossing to the other harness tries each of its licenses in turn", async () => {
  fresh({ engine: "claude" });
  const second = signedInLicense("Cross seat");
  await setUser("U_LIC_CROSS", { name: "Lic Cross", approved: true, isAdmin: false });
  await channel("D_LIC_CROSS", "lic-cross", { engine: "claude" });

  const result = await turn("D_LIC_CROSS", "U_LIC_CROSS", "CLAUDE_STUB_LIMIT_FAIL_SAFE CODEX_STUB_LIMIT_DEFAULT_LICENSE", "2003.020");
  assert.equal(result.engine, second.id, "Codex's own sign-in was limited, so its next license answered");
  assert.match(result.content, /Claude(?: Code)? and Codex could not answer — using Cross seat/);
  assert.match(result.content, /Codex stub reply/);
});

test("when every selected license is limited the turn crosses to the other harness, naming what was tried", async () => {
  fresh();
  const second = signedInLicense("Limited seat");
  await setUser("U_LIC_ALL", { name: "Lic All", approved: true, isAdmin: false });
  await channel("D_LIC_ALL", "lic-all", { licensePool: [second.id] });

  const result = await turn("D_LIC_ALL", "U_LIC_ALL", "CODEX_STUB_LIMIT_ALL_LICENSES", "2004.010");
  assert.equal(result.engine, "claude");
  assert.equal(result.licenseSwitched, false);
  assert.match(result.content, /Codex and Limited seat could not answer — using Claude/);
  assert.match(result.content, /Stub engine reply/);
});

test("with cross-harness failover off the turn fails after the pool, and says which licenses failed", async () => {
  fresh({ engineFallback: false });
  const second = signedInLicense("Also limited");
  await setUser("U_LIC_OFF", { name: "Lic Off", approved: true, isAdmin: false });
  await channel("D_LIC_OFF", "lic-off", { licensePool: [second.id] });

  await assert.rejects(turn("D_LIC_OFF", "U_LIC_OFF", "CODEX_STUB_LIMIT_ALL_LICENSES", "2005.010"), (error) => {
    assert.match(error.message, /Also limited could not answer either/);
    assert.deepEqual(error.details.alsoFailed, [second.id]);
    assert.equal(error.details.askFallback, undefined, "no other harness to offer");
    return true;
  });
});

test("`ask` mode moves within the pool silently and asks only before crossing harnesses", async () => {
  // The chat surface passes "ask" when the gateway is set to ask before switching harness.
  fresh({ engineFallbackMode: "ask" });
  const second = signedInLicense("Ask seat");
  await setUser("U_LIC_ASK", { name: "Lic Ask", approved: true, isAdmin: false });
  await channel("D_LIC_ASK", "lic-ask", { licensePool: [second.id] });

  const moved = await turn("D_LIC_ASK", "U_LIC_ASK", "CODEX_STUB_LIMIT_DEFAULT_LICENSE", "2006.010", { fallbackPolicy: "ask" });
  assert.equal(moved.engine, second.id, "the selection itself is the consent to use its licenses");

  resetEngineCooldowns();
  await assert.rejects(turn("D_LIC_ASK", "U_LIC_ASK", "CODEX_STUB_LIMIT_ALL_LICENSES", "2006.020", { fallbackPolicy: "ask" }), (error) => {
    assert.equal(error.details.askFallback.to, "claude");
    assert.deepEqual(error.details.alsoFailed, [second.id]);
    return true;
  });
});

test("a thread pinned to a license still moves within the pool it was pinned with, and never across harnesses", async () => {
  fresh();
  const second = signedInLicense("Pinned pool seat");
  await setUser("U_LIC_PIN", { name: "Lic Pin", approved: true, isAdmin: false });
  const entry = await channel("D_LIC_PIN", "lic-pin", { engine: "claude" });
  await setThreadEngine(entry.slug, "2007.010", "codex", { licensePool: [second.id] });

  const moved = await turn("D_LIC_PIN", "U_LIC_PIN", "CODEX_STUB_LIMIT_DEFAULT_LICENSE", "2007.010");
  assert.equal(moved.engine, second.id);

  resetEngineCooldowns();
  await setThreadEngine(entry.slug, "2007.020", "codex", { licensePool: [second.id] });
  await assert.rejects(turn("D_LIC_PIN", "U_LIC_PIN", "CODEX_STUB_LIMIT_ALL_LICENSES", "2007.020"), (error) => {
    assert.notEqual(error.details?.askFallback?.to, "claude", "a pinned harness is never traded away");
    return true;
  });
});

test("a license that is not signed in is stepped over without ending the turn", async () => {
  fresh();
  const signedOut = createLicense({ kind: "codex-login", label: "Signed out seat", type: "business" });
  const second = signedInLicense("Working seat");
  await setUser("U_LIC_SKIP", { name: "Lic Skip", approved: true, isAdmin: false });
  await channel("D_LIC_SKIP", "lic-skip", { licensePool: [signedOut.id, second.id] });

  const result = await turn("D_LIC_SKIP", "U_LIC_SKIP", "CODEX_STUB_LIMIT_DEFAULT_LICENSE", "2008.010");
  assert.equal(result.engine, second.id);
  assert.match(result.content, /using Working seat/);
});

// The FIRST license of a selection can be the one that is signed out — in a container that is the
// backend's credential gate, which ends a turn before anything spawns. A selection with another
// license of the same harness hands the turn to it; that gate is still never a reason to cross to
// the other harness, and with no pool it fails closed exactly as before.
const withSignedOut = async (engineId, run) => {
  backend.credentialError = (target, engine) => (engine === engineId ? "This channel runs in a container, but Codex is not signed in." : "");
  try { return await run(); } finally { delete backend.credentialError; }
};

test("a signed-out first license hands the turn to the next selected license instead of ending it", async () => {
  fresh();
  const second = signedInLicense("Spare seat");
  await setUser("U_LIC_GATE", { name: "Lic Gate", approved: true, isAdmin: false });
  const entry = await channel("D_LIC_GATE", "lic-gate", { licensePool: [second.id] });
  const before = backend.calls.spawn.length;

  const result = await withSignedOut("codex", () => turn("D_LIC_GATE", "U_LIC_GATE", "hello", "2012.010"));

  assert.equal(result.engine, second.id);
  assert.equal(result.licenseSwitched, true);
  assert.match(result.content, /Codex has no usable sign-in right now — using Spare seat/);
  assert.match(result.content, /Codex stub reply/);
  assert.equal(await getSessionEngine(entry.slug, "2012.010"), second.id);
  const homes = codexHomes().slice(before);
  assert.ok(homes.length && homes.every((home) => home.endsWith(`.cg-licenses/${second.id}`)), `the signed-out license never started (${homes.join(", ")})`);
});

test("a signed-out license with no other usable license still fails closed, and never crosses to the other harness", async () => {
  fresh();
  await setUser("U_LIC_GATE1", { name: "Lic Gate One", approved: true, isAdmin: false });
  const entry = await channel("D_LIC_GATE1", "lic-gate-one");
  const before = backend.calls.spawn.length;

  await assert.rejects(withSignedOut("codex", () => turn("D_LIC_GATE1", "U_LIC_GATE1", "hello", "2013.010")), (error) => {
    assert.match(error.message, /Codex is not signed in/);
    assert.equal(error.details.runtimeCredential, true);
    assert.equal(error.details.providerError, undefined);
    assert.equal(error.details.alsoFailed, undefined);
    return true;
  });
  assert.equal(backend.calls.spawn.length, before, "nothing started: not Claude");
  assert.equal(await getSessionEngine(entry.slug, "2013.010"), "");
});

test("when the selection's other licenses cannot answer either, the first license's sign-in message stays the error", async () => {
  fresh();
  const second = signedInLicense("Limited spare");
  await setUser("U_LIC_GATE2", { name: "Lic Gate Two", approved: true, isAdmin: false });
  await channel("D_LIC_GATE2", "lic-gate-two", { licensePool: [second.id] });
  const before = backend.calls.spawn.length;

  await assert.rejects(withSignedOut("codex", () => turn("D_LIC_GATE2", "U_LIC_GATE2", "CODEX_STUB_LIMIT_ALL_LICENSES", "2014.010")), (error) => {
    assert.match(error.message, /Codex is not signed in.* — Limited spare could not answer either: /);
    assert.equal(error.details.runtimeCredential, true);
    assert.equal(error.details.providerError, undefined, "a missing sign-in is never reclassified as a provider outage");
    assert.deepEqual(error.details.alsoFailed, [second.id]);
    return true;
  });
  const homes = codexHomes().slice(before);
  assert.ok(homes.length && homes.every((home) => home.endsWith(`.cg-licenses/${second.id}`)), "only the selected spare was tried");
  assert.ok(backend.calls.spawn.slice(before).every((call) => call.env?.CODEX_HOME), "Claude was never started for a sign-in problem");
});

test("a switched-off license with nothing else approved here refuses the turn instead of starting on a key that is no longer sent", async () => {
  fresh();
  const only = signedInLicense("Only seat");
  await setUser("U_LIC_DIS", { name: "Lic Disabled", approved: true, isAdmin: false });
  await channel("D_LIC_DIS", "lic-disabled", { engine: only.id, approvedEngines: [only.id] });
  saveSettings({ engineEnabled: { claude: true, codex: true, [only.id]: false } });
  const before = backend.calls.spawn.length;

  const refused = await turn("D_LIC_DIS", "U_LIC_DIS", "hello", "2015.010");
  assert.equal(refused.engineRefused, true);
  assert.match(refused.content, /Only seat is disabled in gateway Settings and nothing else is approved to run here/);
  assert.equal(backend.calls.spawn.length, before, "nothing was started");

  // Switched back on, the same conversation runs on it again.
  saveSettings({ engineEnabled: { claude: true, codex: true, [only.id]: true } });
  const again = await turn("D_LIC_DIS", "U_LIC_DIS", "hello", "2015.020");
  assert.equal(again.engine, only.id);
});

test("a channel locked to one harness keeps its pool and never crosses", async () => {
  fresh();
  const second = signedInLicense("Locked seat");
  await setUser("U_LIC_LOCK", { name: "Lic Lock", approved: true, isAdmin: false });
  await channel("D_LIC_LOCK", "lic-lock", { licensePool: "any", approvedEngines: ["harness:codex"] });

  const moved = await turn("D_LIC_LOCK", "U_LIC_LOCK", "CODEX_STUB_LIMIT_DEFAULT_LICENSE", "2009.010");
  assert.equal(moved.engine, second.id);

  resetEngineCooldowns();
  await assert.rejects(turn("D_LIC_LOCK", "U_LIC_LOCK", "CODEX_STUB_LIMIT_ALL_LICENSES", "2009.020"), (error) => {
    assert.equal(error.details?.askFallback, undefined, "Claude is not approved here, so it is never offered");
    return true;
  });
});

test("a removed license leaves a working channel: the selection falls back to what still exists", async () => {
  fresh();
  const second = signedInLicense("Soon removed");
  await setUser("U_LIC_GONE", { name: "Lic Gone", approved: true, isAdmin: false });
  await channel("D_LIC_GONE", "lic-gone", { engine: second.id });
  const first = await turn("D_LIC_GONE", "U_LIC_GONE", "hello", "2010.010");
  assert.equal(first.engine, second.id);

  await deleteLicense(second.id);
  assert.equal(getSettings().engineLicenses.length, 0);
  const after = await turn("D_LIC_GONE", "U_LIC_GONE", "hello again", "2010.020");
  assert.equal(after.engine, "codex", "the gateway default answers once the channel's license is gone");
});

test("a thread whose session a deleted license minted continues, fresh, on the conversation's current selection", async () => {
  fresh();
  const second = signedInLicense("Minted then removed");
  await setUser("U_LIC_HEAL", { name: "Lic Heal", approved: true, isAdmin: false });
  const entry = await channel("D_LIC_HEAL", "lic-heal", { engine: second.id });
  const first = await turn("D_LIC_HEAL", "U_LIC_HEAL", "hello", "2011.010");
  assert.equal(first.engine, second.id);
  // A second thread is pinned to the license by hand, pool and all.
  await setThreadEngine(entry.slug, "2011.020", second.id);

  await deleteLicense(second.id);
  assert.equal(await getSessionEngine(entry.slug, "2011.010"), "", "the stamp of a license that is gone names no live session");
  // The SAME thread: not "not an approved harness", not a resume of a session nothing can open.
  const again = await turn("D_LIC_HEAL", "U_LIC_HEAL", "hello again", "2011.010");
  assert.equal(again.engine, "codex");
  assert.match(again.content, /Codex stub reply/);
  assert.equal(await getSessionEngine(entry.slug, "2011.010"), "codex");
  const pinned = await turn("D_LIC_HEAL", "U_LIC_HEAL", "and here", "2011.020");
  assert.equal(pinned.engine, "codex", "a pin on a deleted license is no pin");
});

test("a harness pinned by hand is not traded for the other one when it is switched off", async () => {
  fresh({ engine: "claude", engineEnabled: { claude: true, codex: false } });
  await setUser("U_LIC_OFFPIN", { name: "Lic Offpin", approved: true, isAdmin: false });
  const entry = await channel("D_LIC_OFFPIN", "lic-offpin", { engine: "claude" });
  await setThreadEngine(entry.slug, "2012.010", "codex");
  const before = backend.calls.spawn.length;

  const refused = await turn("D_LIC_OFFPIN", "U_LIC_OFFPIN", "hello", "2012.010");
  assert.equal(refused.engineRefused, true);
  assert.equal(refused.engine, "codex");
  assert.match(refused.content, /Codex is disabled in gateway Settings and no other Codex license can run here/);
  assert.equal(backend.calls.spawn.length, before, "no engine was started for it");

  // A license of the SAME harness that is switched on answers instead: the harness did not change.
  const seat = signedInLicense("Still on");
  const moved = await turn("D_LIC_OFFPIN", "U_LIC_OFFPIN", "hello", "2012.010");
  assert.equal(moved.engine, seat.id);
  assert.notEqual(moved.engineRefused, true);

  // A channel DEFAULT is not a pin: with its harness off and no license of it, the turn still moves.
  await deleteLicense(seat.id);
  await channel("D_LIC_OFFDEFAULT", "lic-offdefault", { engine: "codex" });
  const defaulted = await turn("D_LIC_OFFDEFAULT", "U_LIC_OFFPIN", "hello", "2012.020");
  assert.equal(defaulted.engine, "claude");
});
