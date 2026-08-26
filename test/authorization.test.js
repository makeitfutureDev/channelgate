// The full "who may talk" matrix against the real isAuthorized (the 2026-08 restructure notes (internal repo) Phase 0).
// This is the product's stated authorization contract from AGENTS.md: admins and approved users
// may talk in channels and DMs; unknown users are denied everywhere INCLUDING DMs; the only
// exception is an explicit per-channel guest grant (meta.allowedUsers), which never applies to
// DMs. Channel access policy: "approved" (default) | "admins" | "none" — "none" is dormant, only
// the guest grant gets in, even for admins.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

const { isAuthorized } = await import("../src/slack/app.js");
const { canManage } = await import("../src/gateway/modes.js");

const ADMIN = { isAdminUser: true, isApprovedUser: false };
const APPROVED = { isAdminUser: false, isApprovedUser: true };
const UNKNOWN = { isAdminUser: false, isApprovedUser: false };
const ADMIN_AND_APPROVED = { isAdminUser: true, isApprovedUser: true };

test("DM: admins and approved users are allowed, unknown users are denied", () => {
  assert.equal(isAuthorized({}, "U1", true, ADMIN), true);
  assert.equal(isAuthorized({}, "U1", true, APPROVED), true);
  assert.equal(isAuthorized({}, "U1", true, ADMIN_AND_APPROVED), true);
  assert.equal(isAuthorized({}, "U1", true, UNKNOWN), false);
});

test("DM: the guest grant does NOT apply — a channel allowedUsers entry never opens a DM", () => {
  const meta = { allowedUsers: ["U1"] };
  assert.equal(isAuthorized(meta, "U1", true, UNKNOWN), false);
});

test("DM: channel access policy is channel-scoped and ignored in DMs", () => {
  // Even a "none" policy on the DM's meta does not lock out an admin/approved user in the DM,
  // and an "approved" policy does not let an unknown user in.
  assert.equal(isAuthorized({ access: "none" }, "U1", true, ADMIN), true);
  assert.equal(isAuthorized({ access: "none" }, "U1", true, APPROVED), true);
  assert.equal(isAuthorized({ access: "approved" }, "U1", true, UNKNOWN), false);
});

test("channel, default policy (missing access = approved): admins + approved in, unknown out", () => {
  assert.equal(isAuthorized({}, "U1", false, ADMIN), true);
  assert.equal(isAuthorized({}, "U1", false, APPROVED), true);
  assert.equal(isAuthorized({}, "U1", false, UNKNOWN), false);
  // Explicit "approved" behaves identically to missing.
  assert.equal(isAuthorized({ access: "approved" }, "U1", false, APPROVED), true);
  assert.equal(isAuthorized({ access: "approved" }, "U1", false, UNKNOWN), false);
});

test("channel, admins policy: admins only — approval alone is not enough", () => {
  const meta = { access: "admins" };
  assert.equal(isAuthorized(meta, "U1", false, ADMIN), true);
  assert.equal(isAuthorized(meta, "U1", false, ADMIN_AND_APPROVED), true);
  assert.equal(isAuthorized(meta, "U1", false, APPROVED), false);
  assert.equal(isAuthorized(meta, "U1", false, UNKNOWN), false);
});

test("channel, none policy: dormant — denies everyone including admins", () => {
  const meta = { access: "none" };
  assert.equal(isAuthorized(meta, "U1", false, ADMIN), false);
  assert.equal(isAuthorized(meta, "U1", false, ADMIN_AND_APPROVED), false);
  assert.equal(isAuthorized(meta, "U1", false, APPROVED), false);
  assert.equal(isAuthorized(meta, "U1", false, UNKNOWN), false);
});

test("channel guest grant: allowedUsers admits an otherwise-unknown user, in channels only", () => {
  const meta = { allowedUsers: ["UGUEST"] };
  assert.equal(isAuthorized(meta, "UGUEST", false, UNKNOWN), true);
  // The grant is per-user, not per-channel-open.
  assert.equal(isAuthorized(meta, "UOTHER", false, UNKNOWN), false);
});

test("channel guest grant overrides every access policy — the manual escape hatch", () => {
  for (const access of ["approved", "admins", "none"]) {
    const meta = { access, allowedUsers: ["UGUEST"] };
    assert.equal(isAuthorized(meta, "UGUEST", false, UNKNOWN), true, `access=${access}`);
  }
  // Under "none" the grant is the ONLY way in — an admin without a grant stays out, an admin
  // listed in allowedUsers gets in.
  const dormant = { access: "none", allowedUsers: ["UADMIN"] };
  assert.equal(isAuthorized(dormant, "UADMIN", false, ADMIN), true);
  assert.equal(isAuthorized(dormant, "UOTHER", false, ADMIN), false);
});

test("guest grant requires a real array membership — malformed allowedUsers never admits", () => {
  assert.equal(isAuthorized({ allowedUsers: "UGUEST" }, "UGUEST", false, UNKNOWN), false);
  assert.equal(isAuthorized({ allowedUsers: null }, "UGUEST", false, UNKNOWN), false);
  assert.equal(isAuthorized({ allowedUsers: [] }, "UGUEST", false, UNKNOWN), false);
});

// ── The paired boundary: "who may talk" (isAuthorized) vs "who may change settings" (canManage).
// canManage's full matrix lives in test/modes.test.js; these assert the two contracts stay
// distinct — talking never implies managing, and managing is admin-true regardless of channel
// access policy (call sites gate dangerous escalations separately).

test("talk vs manage: an approved user may talk but not manage under default policies", () => {
  assert.equal(isAuthorized({}, "U1", false, APPROVED), true);
  assert.equal(canManage({}, { authorId: "U1", ...APPROVED }), false);
});

test("talk vs manage: a guest grant admits speech, never management", () => {
  const meta = { allowedUsers: ["UGUEST"] };
  assert.equal(isAuthorized(meta, "UGUEST", false, UNKNOWN), true);
  assert.equal(canManage(meta, { authorId: "UGUEST", ...UNKNOWN }), false);
  // Not even when manageAccess is relaxed to members — the guest is not APPROVED.
  assert.equal(canManage({ ...meta, manageAccess: "members" }, { authorId: "UGUEST", ...UNKNOWN }), false);
});

test("talk vs manage: an admin in a dormant (none) channel cannot talk yet still counts as manager", () => {
  const meta = { access: "none" };
  assert.equal(isAuthorized(meta, "U1", false, ADMIN), false);
  assert.equal(canManage(meta, { authorId: "U1", ...ADMIN }), true);
});
