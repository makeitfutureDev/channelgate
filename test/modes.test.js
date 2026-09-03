import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { MODE_FLAGS, MODES, channelMode, modeLabel, PROFILE_FLAGS, PROFILES, channelProfile, canManage } =
  await import("../src/gateway/modes.js");

// modes.js is the mode/profile → capability-flag mapping plus the "who may manage a channel"
// authz check. Both feed directly into what a spawned engine is allowed to do, so the exact
// derivations are pinned here.

test("channelMode picks the highest capability, admin > auto > bash > read", () => {
  assert.equal(channelMode({}), "read");
  assert.equal(channelMode({ allowBash: true }), "bash");
  assert.equal(channelMode({ autoMode: true }), "auto");
  assert.equal(channelMode({ adminMode: true }), "admin");
  // admin wins even when every flag is set
  assert.equal(channelMode({ adminMode: true, autoMode: true, allowBash: true }), "admin");
  assert.equal(channelMode({ autoMode: true, allowBash: true }), "auto");
});

test("every mode round-trips through its own flags", () => {
  for (const mode of MODES) {
    assert.equal(channelMode(MODE_FLAGS[mode]), mode, `MODE_FLAGS.${mode} must derive back to ${mode}`);
  }
});

test("modeLabel reports the engine's real network capability", () => {
  assert.equal(modeLabel({}), "Read-only");
  // The network is a switch on the channel's container; both container engines support "on".
  assert.equal(modeLabel({ allowBash: true, allowNetwork: true, engine: "claude" }), "Bash · network on");
  assert.equal(modeLabel({ allowBash: true, allowNetwork: true, engine: "codex" }), "Bash · network on");
  // An engine that only declares "off" is told so rather than promised a network it will not get.
  assert.equal(modeLabel({ allowBash: true, allowNetwork: true, engine: "opencode" }), "Bash · network unsupported");
  // Admin mode lifts the engine's own sandbox, not the network switch: with the switch off the
  // label says nothing about the network — there is no "unrestricted" tier any more.
  assert.equal(modeLabel({ adminMode: true, engine: "codex" }), "Admin");
  assert.equal(modeLabel({ adminMode: true, allowNetwork: true, engine: "codex" }), "Admin · network on");
});

test("channelProfile: explicit stored profile wins; invalid ones fall back to flag derivation", () => {
  assert.equal(channelProfile({ profile: "custom", allowBash: true }), "custom");
  assert.equal(channelProfile({ profile: "lean" }), "lean");
  // a bogus stored profile must not be trusted
  assert.equal(channelProfile({ profile: "root", allowBash: true }), "worker");
  // legacy channels (no stored profile) derive from flags
  assert.equal(channelProfile({}), "read");
  assert.equal(channelProfile({ cleanMode: true }), "lean");
  assert.equal(channelProfile({ adminMode: true }), "full");
  assert.equal(channelProfile({ allowBash: true, autoMode: true }), "auto");
  assert.equal(channelProfile({ allowBash: true }), "worker");
});

test("every preset profile round-trips through its own flags", () => {
  for (const profile of Object.keys(PROFILE_FLAGS)) {
    assert.equal(channelProfile(PROFILE_FLAGS[profile]), profile, `PROFILE_FLAGS.${profile} must derive back to ${profile}`);
  }
  assert.ok(PROFILES.includes("custom"), "custom must stay a selectable profile");
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
