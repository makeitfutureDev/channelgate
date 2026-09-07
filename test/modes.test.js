import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { MODE_FLAGS, MODES, channelMode, modeLabel, networkLabel, networkState, PROFILE_FLAGS, PROFILES, channelProfile, canManage, modeSettingsPatch, normalizeModeMeta, authorModeMeta } =
  await import("../src/gateway/modes.js");
const { NETWORK_ADVISORY_NOTE, NETWORK_POLICY_ENFORCED } = await import("../src/engines/network-policy.js");

// modes.js is the mode/profile → capability-flag mapping plus the "who may manage a channel"
// authz check. Both feed directly into what a spawned engine is allowed to do, so the exact
// derivations are pinned here.

test("channelMode picks the highest capability, admin > worker > read", () => {
  assert.equal(channelMode({}), "read");
  assert.equal(channelMode({ allowBash: true }), "worker");
  assert.equal(channelMode({ autoMode: true }), "worker");
  assert.equal(channelMode({ adminMode: true }), "admin");
  // admin wins even when every flag is set
  assert.equal(channelMode({ adminMode: true, autoMode: true, allowBash: true }), "admin");
  assert.equal(channelMode({ autoMode: true, allowBash: true }), "worker");
});

test("every mode round-trips through its own flags", () => {
  for (const mode of MODES) {
    assert.equal(channelMode(MODE_FLAGS[mode]), mode, `MODE_FLAGS.${mode} must derive back to ${mode}`);
  }
});

test("modeLabel states the network in BOTH directions, never by omission", () => {
  // The bug this pins: the suffix used to appear only when the switch was ON, so "off" and "no
  // one ever configured it" rendered identically — in the label, in /mode, and in the app-home
  // channel list. Every state now has a word.
  assert.equal(modeLabel({}), "Read-only · network off");
  assert.equal(modeLabel({ allowBash: true, engine: "claude" }), "Worker · network off");
  // The network is a switch on the channel's container; both container engines support "on".
  assert.equal(modeLabel({ allowBash: true, allowNetwork: true, engine: "claude" }), "Worker · network on");
  assert.equal(modeLabel({ allowBash: true, allowNetwork: true, engine: "codex" }), "Worker · network on");
  // An engine that only declares "off" is told so rather than promised a network it will not get.
  assert.equal(modeLabel({ allowBash: true, allowNetwork: true, engine: "opencode" }), "Worker · network unsupported");
  // Admin mode lifts the engine's own sandbox, not the network switch.
  assert.equal(modeLabel({ adminMode: true, engine: "codex" }), "Admin · network off");
  assert.equal(modeLabel({ adminMode: true, allowNetwork: true, engine: "codex" }), "Admin · network on");
});

test("the detailed label admits the switch is advisory, and only where it matters", () => {
  assert.equal(NETWORK_POLICY_ENFORCED, false, "flip this only when a container-side egress proxy actually enforces the switch");
  // OFF is the state people misread as a boundary, so that is the one that carries the caveat.
  assert.equal(modeLabel({}, { detail: true }), `Read-only · network off (${NETWORK_ADVISORY_NOTE})`);
  assert.match(NETWORK_ADVISORY_NOTE, /not enforced/i);
  // ON is simply true — the container is on the bridge network — so it gains nothing.
  assert.equal(modeLabel({ allowNetwork: true, engine: "claude" }, { detail: true }), "Read-only · network on");
  assert.equal(modeLabel({ allowBash: true, allowNetwork: true, engine: "opencode" }, { detail: true }), "Worker · network unsupported");
  // The compact form is the default: it rides the app-home channel list.
  assert.equal(modeLabel({}), "Read-only · network off");
});

test("networkState/networkLabel are the one derivation every surface shares", () => {
  assert.equal(networkState({}), "off");
  assert.equal(networkState({ allowNetwork: true, engine: "claude" }), "on");
  assert.equal(networkState({ allowNetwork: true, engine: "opencode" }), "unsupported");
  assert.equal(networkLabel({}), "network off");
  assert.equal(networkLabel({ allowNetwork: true, engine: "codex" }), "network on");
  assert.equal(networkLabel({}, { detail: true }), `network off (${NETWORK_ADVISORY_NOTE})`);
});

test("legacy presets resolve to three base modes without losing modifiers", () => {
  assert.deepEqual(PROFILES, ["read", "worker", "admin"]);
  assert.equal(channelProfile({ profile: "custom", allowBash: true }), "worker");
  assert.equal(channelProfile({ profile: "lean", cleanMode: true }), "read");
  assert.equal(channelProfile({ profile: "full", adminMode: true }), "admin");
  assert.equal(channelProfile(PROFILE_FLAGS.auto), "worker");
  assert.equal(channelProfile(PROFILE_FLAGS.read), "read");
  assert.equal(modeLabel({ adminMode: true, autoMode: true, cleanMode: true }), "Admin · Auto · Lean · network off");
});

test("base changes retain independent modifiers and Read-only/Auto stay coherent", () => {
  const current = { autoMode: true, cleanMode: true };
  const admin = { ...current, ...modeSettingsPatch(current, { mode: "admin" }, { isAdminUser: true }) };
  assert.deepEqual(admin, { adminMode: true, allowBash: true, autoMode: true, cleanMode: true, profile: "admin" });
  const worker = { ...admin, ...modeSettingsPatch(admin, { mode: "worker" }) };
  assert.equal(worker.autoMode, true);
  assert.equal(worker.cleanMode, true);
  const read = { ...worker, ...modeSettingsPatch(worker, { mode: "read" }) };
  assert.equal(read.autoMode, false);
  assert.equal(read.cleanMode, true);
  assert.equal(read.allowBash, false);
  assert.equal(modeSettingsPatch(read, { autoMode: true }).profile, "worker");
  assert.throws(() => modeSettingsPatch({}, { mode: "admin" }), /Only administrators/);
  assert.throws(() => modeSettingsPatch({}, { mode: "invalid" }), /Mode must/);
  assert.deepEqual(modeSettingsPatch(admin, { autoMode: false }), { autoMode: false });
});

test("Admin gives non-admins Worker plus modifiers and trusted admins full context", () => {
  const legacy = { adminMode: true, allowBash: false, autoMode: true, cleanMode: true };
  assert.equal(normalizeModeMeta(legacy).allowBash, true);
  assert.equal(legacy.allowBash, false, "normalization does not mutate stored settings");
  for (const isAdminAuthor of [false, true]) {
    const resolved = authorModeMeta(legacy, { isAdminAuthor });
    assert.equal(resolved.allowBash, true);
    assert.equal(resolved.autoMode, true);
    assert.equal(resolved.cleanMode, !isAdminAuthor);
  }
  assert.equal(authorModeMeta(legacy, { isAdminAuthor: true, untrustedPrincipal: true }).cleanMode, true);
  assert.equal(authorModeMeta({ cleanMode: true }, { isAdminAuthor: true }).cleanMode, true);
});

test("canManage: admins always; default policy is admins-only", () => {
  assert.equal(canManage({}, { isAdminUser: true }), true);
  assert.equal(canManage({}, { isApprovedUser: true }), false);
  assert.equal(canManage({}, { authorId: "U1" }), false);
  // an unknown manageAccess value must fail closed
  assert.equal(canManage({ manageAccess: "everyone" }, { isApprovedUser: true }), false);
});

test("canManage: members policy requires an APPROVED author, not just any author", () => {
  const meta = { manageAccess: "members" };
  assert.equal(canManage(meta, { isApprovedUser: true }), true);
  assert.equal(canManage(meta, { authorId: "U1", isApprovedUser: false }), false);
});

test("canManage: custom policy grants only the listed managers", () => {
  const meta = { manageAccess: "custom", managers: ["U1", "U2"] };
  assert.equal(canManage(meta, { authorId: "U1" }), true);
  assert.equal(canManage(meta, { authorId: "U3", isApprovedUser: true }), false);
  // malformed managers list fails closed
  assert.equal(canManage({ manageAccess: "custom", managers: "U1" }, { authorId: "U1" }), false);
  assert.equal(canManage({ manageAccess: "custom" }, { authorId: "U1" }), false);
});
