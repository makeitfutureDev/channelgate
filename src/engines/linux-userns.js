// Boot-time detection of the Linux condition that silently kills every sandboxed Bash call.
//
// Ubuntu 23.10+ (24.04 LTS included) ships kernel.apparmor_restrict_unprivileged_userns=1: an
// UNCONFINED process that creates a user namespace is stacked into the capability-stripped
// `unprivileged_userns` profile, and Claude Code's Bash sandbox — which needs a userns plus a
// nested one for its seccomp stage — dies on its first setgroups write:
//   apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; ...)
// Read/Write/MCP keep working, so from Slack it looks like the model "can't run bash" and nothing
// in the daemon explains why. The remedy is the AppArmor profile in scripts/apparmor/ (an
// exemption attached to the Claude binaries, not a sysctl that weakens the whole host).
//
// This is a cheap, spawn-free assessment from /proc + the profile's presence on disk — enough to
// say at boot WHERE to look, in the same place the engine-CLI warnings live. The authoritative
// live test (real exec attachment, nested userns) is `scripts/apparmor/claude-userns-fix.sh
// --check`; it needs python3 and a copy into the versions dir, which is not a daemon's business.
import { existsSync, readFileSync } from "node:fs";

export const USERNS_PROFILE_PATH = "/etc/apparmor.d/claude-code-userns";
export const USERNS_FIX_HINT =
  "sandboxed Bash will fail in every channel (apply-seccomp: write /proc/self/setgroups: " +
  "Permission denied) — run: sudo sh scripts/apparmor/claude-userns-fix.sh --apply " +
  "(see scripts/apparmor/README.md)";

const SYSCTL = {
  clone: "/proc/sys/kernel/unprivileged_userns_clone",
  maxNamespaces: "/proc/sys/user/max_user_namespaces",
  apparmorRestrict: "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
};

function readTrimmed(readFile, path) {
  try {
    return String(readFile(path)).trim();
  } catch {
    return null; // knob absent on this kernel (non-Ubuntu, older, or no AppArmor)
  }
}

/**
 * Assess whether unprivileged user namespaces — and therefore Claude Code's Bash sandbox — work
 * for the daemon's user on this host. Pure given its inputs so the verdicts are unit-testable
 * without a Linux kernel; production callers pass nothing.
 *
 * @returns {{applies:false} | {applies:true, broken:boolean, reason?:string, hint?:string,
 *           restricted:boolean, profileInstalled:boolean}}
 */
export function assessLinuxUserns({
  platform = process.platform,
  readFile = (p) => readFileSync(p, "utf8"),
  exists = existsSync,
} = {}) {
  if (platform !== "linux") return { applies: false };

  const restricted = readTrimmed(readFile, SYSCTL.apparmorRestrict) === "1";
  const profileInstalled = exists(USERNS_PROFILE_PATH);
  const base = { applies: true, restricted, profileInstalled };

  if (readTrimmed(readFile, SYSCTL.clone) === "0") {
    return { ...base, broken: true, reason: "unprivileged user namespaces are disabled (kernel.unprivileged_userns_clone=0)", hint: USERNS_FIX_HINT };
  }
  if (readTrimmed(readFile, SYSCTL.maxNamespaces) === "0") {
    return { ...base, broken: true, reason: "user namespaces are disabled (user.max_user_namespaces=0)", hint: USERNS_FIX_HINT };
  }
  if (restricted && !profileInstalled) {
    return {
      ...base,
      broken: true,
      reason: `AppArmor restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1) and ${USERNS_PROFILE_PATH} is not installed`,
      hint: USERNS_FIX_HINT,
    };
  }
  return { ...base, broken: false };
}
