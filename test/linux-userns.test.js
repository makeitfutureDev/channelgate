// The boot-time userns assessment must name the one Linux condition that silently kills every
// sandboxed Bash call (Ubuntu's AppArmor unprivileged-userns restriction with no exemption
// profile), stay quiet once the profile is installed or on kernels without the knob, and never
// fire on macOS. Regression: a whole fleet's channels lost Bash after an OS upgrade and nothing
// in the daemon said why — the error only surfaced inside the model's own turn.
import test from "node:test";
import assert from "node:assert/strict";
import { assessLinuxUserns, USERNS_PROFILE_PATH, USERNS_FIX_HINT, USERNS_CODEX_STALE_HINT } from "../src/engines/linux-userns.js";

function fakeProc(values) {
  return (path) => {
    if (!(path in values)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return values[path] + "\n";
  };
}
const RESTRICT = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
const CLONE = "/proc/sys/kernel/unprivileged_userns_clone";
const MAX = "/proc/sys/user/max_user_namespaces";

test("does not apply on macOS", () => {
  assert.deepEqual(assessLinuxUserns({ platform: "darwin", readFile: () => { throw new Error("must not read"); } }), { applies: false });
});

test("Ubuntu restriction on + no profile → broken, with the fix hint", () => {
  const r = assessLinuxUserns({ platform: "linux", readFile: fakeProc({ [RESTRICT]: "1", [CLONE]: "1", [MAX]: "187893" }), exists: () => false });
  assert.equal(r.applies, true);
  assert.equal(r.broken, true);
  assert.equal(r.restricted, true);
  assert.equal(r.profileInstalled, false);
  assert.match(r.reason, /apparmor_restrict_unprivileged_userns=1/);
  assert.match(r.reason, new RegExp(USERNS_PROFILE_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(r.hint, USERNS_FIX_HINT);
  assert.match(r.hint, /claude-userns-fix\.sh --apply/);
});

test("restriction on + current profile (claude + codex blocks) installed → not broken", () => {
  const readFile = fakeProc({ [RESTRICT]: "1", [CLONE]: "1", [MAX]: "187893", [USERNS_PROFILE_PATH]: "profile claude-code-userns ... {}\nprofile codex-userns ... {}" });
  const r = assessLinuxUserns({ platform: "linux", readFile, exists: (p) => p === USERNS_PROFILE_PATH });
  assert.equal(r.broken, false);
  assert.equal(r.restricted, true);
  assert.equal(r.profileInstalled, true);
  assert.equal(r.reason, undefined);
});

test("restriction on + STALE profile (no codex-userns block) → broken with the re-apply hint", () => {
  // Regression: a pre-Codex install exempts only Claude's binaries; Codex's network_proxy then
  // resets every tunnel (allowed domains included) and nothing in the turn output says why.
  const readFile = fakeProc({ [RESTRICT]: "1", [CLONE]: "1", [MAX]: "187893", [USERNS_PROFILE_PATH]: "profile claude-code-userns ... {}" });
  const r = assessLinuxUserns({ platform: "linux", readFile, exists: (p) => p === USERNS_PROFILE_PATH });
  assert.equal(r.broken, true);
  assert.match(r.reason, /predates Codex coverage/);
  assert.equal(r.hint, USERNS_CODEX_STALE_HINT);
  assert.match(r.hint, /claude-userns-fix\.sh --apply/);
});

test("restriction on + profile present but unreadable content → stays quiet (no false alarm)", () => {
  const r = assessLinuxUserns({ platform: "linux", readFile: fakeProc({ [RESTRICT]: "1", [CLONE]: "1", [MAX]: "187893" }), exists: (p) => p === USERNS_PROFILE_PATH });
  assert.equal(r.broken, false);
  assert.equal(r.profileInstalled, true);
});

test("restriction off (or knob absent: non-Ubuntu kernel) → not broken", () => {
  assert.equal(assessLinuxUserns({ platform: "linux", readFile: fakeProc({ [RESTRICT]: "0", [CLONE]: "1" }), exists: () => false }).broken, false);
  const absent = assessLinuxUserns({ platform: "linux", readFile: fakeProc({}), exists: () => false });
  assert.equal(absent.broken, false);
  assert.equal(absent.restricted, false);
});

test("Debian-style hard off and max_user_namespaces=0 are reported even with the profile", () => {
  const exists = () => true;
  const clone = assessLinuxUserns({ platform: "linux", readFile: fakeProc({ [CLONE]: "0", [RESTRICT]: "0" }), exists });
  assert.equal(clone.broken, true);
  assert.match(clone.reason, /unprivileged_userns_clone=0/);
  const max = assessLinuxUserns({ platform: "linux", readFile: fakeProc({ [CLONE]: "1", [MAX]: "0", [RESTRICT]: "1" }), exists });
  assert.equal(max.broken, true);
  assert.match(max.reason, /max_user_namespaces=0/);
});

test("the real host assessment returns a well-formed verdict without throwing", () => {
  const r = assessLinuxUserns();
  assert.equal(typeof r.applies, "boolean");
  if (r.applies) assert.equal(typeof r.broken, "boolean");
});
