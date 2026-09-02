#!/bin/sh
# claude-userns-fix.sh — audit (--check) or fix (--apply) the AppArmor unprivileged-user-
# namespace restrictions that break Claude Code's Bash sandbox on Ubuntu 23.10+ gateway hosts
# (verified on 24.04-style hosts and on 26.04 / AppArmor 5.0).
#
#   sudo sh scripts/apparmor/claude-userns-fix.sh --check   # read-only audit, exit 1 if broken
#   sudo sh scripts/apparmor/claude-userns-fix.sh --apply   # install + load the profile, then verify
#
# Env:
#   CG_CLAUDE_ATTACH   override the claude profile's attachment glob (AppArmor syntax), e.g.
#                      "/opt/claude/versions/*" or "/{home,srv}/*/.local/share/claude/versions/*"
#                      when the claude binary does not live under /home/*/ or /var/lib/*/.
#   CG_CODEX_ATTACH    same override for the codex-userns profile block (the Codex standalone
#                      binary), when codex does not live under
#                      /home/*/.codex/packages/standalone/releases/*/bin/codex.
#   SUDO_USER          (set by sudo) the user whose ~/.local/share/claude/versions is used for
#                      the live verification; the daemon's service account on a systemd install.
#
# Root cause: Ubuntu 23.10+ ships kernel.apparmor_restrict_unprivileged_userns=1 (25.04+ also
# apparmor_restrict_unprivileged_unconfined=1). An UNCONFINED process calling
# unshare(CLONE_NEWUSER) is stacked into the capability-stripped `unprivileged_userns`
# profile, so the sandbox's setgroups/uid_map writes and its NESTED userns (apply-seccomp
# stage) fail. Claude Code's exact error, in every channel, on every Bash call:
#   apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller
#   must provide CAP_SYS_ADMIN): Permission denied
# The fix is a MEDIATING allow-all profile (bwrap-style) attached to the Claude version
# binaries — see claude-code-userns next to this script and README.md for the reasoning.
#
# Verification pitfalls (each one produced a false verdict while this was being built):
#  - `unshare -U -r true` passes on broken hosts: Ubuntu profiles /usr/bin/unshare separately.
#  - `aa-exec -p <profile>` FAILS on healthy hosts under AppArmor 5.0: it yields a
#    `profile//&unconfined` STACK and the restriction still fires (stock lxc-usernsexec too).
#  - getuid() AFTER unshare reads 65534, so a "0 65534 1" uid_map is rightly refused (EPERM).
#  The only faithful test is real exec ATTACHMENT with ids captured up front: we copy python3
#  into the versions dir and run it from there, as the target user.

set -u

PROFILE_NAME=claude-code-userns
PROFILE_DST=/etc/apparmor.d/$PROFILE_NAME
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROFILE_SRC=$SCRIPT_DIR/$PROFILE_NAME
TARGET_USER=${SUDO_USER:-$(id -un)}
TARGET_HOME=$(getent passwd "$TARGET_USER" | cut -d: -f6)
VERSIONS_DIR=$TARGET_HOME/.local/share/claude/versions

fail=0
note() { printf '%s\n' "$*"; }

# The sandbox's full sequence: userns + setgroups/uid_map/gid_map + NESTED userns with its
# own maps (mirrors Claude's apply-seccomp stage).
USERNS_TEST='
import os, ctypes, sys
libc = ctypes.CDLL(None, use_errno=True)
UID, GID = os.getuid(), os.getgid()   # BEFORE unshare (afterwards they read 65534)
def die(m): print(m); sys.exit(1)
def w(p, s):
    fd = os.open(p, os.O_WRONLY)
    try: os.write(fd, s.encode())
    finally: os.close(fd)
if libc.unshare(0x10000000) != 0:
    die("unshare: " + os.strerror(ctypes.get_errno()))
try:
    w("/proc/self/setgroups", "deny")
    w("/proc/self/uid_map", "0 %d 1" % UID)
    w("/proc/self/gid_map", "0 %d 1" % GID)
except OSError as e:
    die("map write: %s" % e)
if libc.unshare(0x10000000) != 0:
    die("NESTED unshare: " + os.strerror(ctypes.get_errno()))
try:
    w("/proc/self/setgroups", "deny")
    w("/proc/self/uid_map", "0 0 1")
    w("/proc/self/gid_map", "0 0 1")
except OSError as e:
    die("nested setgroups/maps (the apply-seccomp failure): %s" % e)
print("ok")
'

as_user() {
    if [ "$(id -u)" = 0 ] && [ "$TARGET_USER" != root ]; then
        sudo -u "$TARGET_USER" "$@"
    else
        "$@"
    fi
}

# Faithful test: run python3 FROM a profile-attached path so the profile genuinely attaches
# on exec. $1 = "attached" | "plain".
run_userns_test() {
    if [ "$1" = attached ]; then
        [ -d "$VERSIONS_DIR" ] || { echo "versions dir missing: $VERSIONS_DIR (is claude installed for $TARGET_USER?)"; return 1; }
        tmpbin=$VERSIONS_DIR/aa-verify-python
        cp "$(readlink -f "$(command -v python3)")" "$tmpbin" || return 1
        chown "$TARGET_USER" "$tmpbin" 2>/dev/null || true
        out=$(as_user "$tmpbin" -c "$USERNS_TEST" 2>&1)
        rm -f "$tmpbin"
        printf '%s' "$out"
    else
        as_user python3 -c "$USERNS_TEST" 2>&1
    fi
}

check() {
    note "== claude-userns audit =="

    if [ -f /run/.containerenv ] || [ -f /.dockerenv ] || grep -qa container= /proc/1/environ 2>/dev/null; then
        note "CONTAINER detected: an AppArmor host profile will NOT help here."
        note "  LXC: set security.nesting=true.  Docker: permissive seccomp/AppArmor runtime config."
        fail=1
    fi

    v=$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo missing)
    [ "$v" = 0 ] && { note "BROKEN: kernel.unprivileged_userns_clone=0 (Debian-style hard off)"; fail=1; }
    v=$(sysctl -n user.max_user_namespaces 2>/dev/null || echo missing)
    [ "$v" = 0 ] && { note "BROKEN: user.max_user_namespaces=0"; fail=1; }

    note "kernel.apparmor_restrict_unprivileged_userns = $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo n/a)"
    note "kernel.apparmor_restrict_unprivileged_unconfined = $(sysctl -n kernel.apparmor_restrict_unprivileged_unconfined 2>/dev/null || echo n/a)"

    [ -f "$PROFILE_DST" ] && note "profile installed: $PROFILE_DST" || note "profile NOT installed"

    if [ -f "$PROFILE_DST" ] && [ -d "$VERSIONS_DIR" ]; then
        out=$(run_userns_test attached)
        if [ "$out" = ok ]; then
            note "live test (profile-attached, as $TARGET_USER): OK — full sandbox sequence works"
        else
            note "BROKEN even with profile: $out"; fail=1
        fi
    else
        out=$(run_userns_test plain)
        if [ "$out" = ok ]; then
            note "live test (unconfined python3): OK — host does not need the profile"
        else
            note "BROKEN: $out"
            note "  (this is exactly how Claude Code's Bash sandbox fails; run --apply)"
            fail=1
        fi
    fi

    [ "$fail" = 0 ] && note "RESULT: host OK" || note "RESULT: host is (or will be) broken for Claude Code Bash"
    exit "$fail"
}

apply() {
    [ "$(id -u)" = 0 ] || { note "run with sudo"; exit 2; }
    [ -f "$PROFILE_SRC" ] || { note "profile source missing: $PROFILE_SRC"; exit 2; }
    command -v apparmor_parser >/dev/null || { note "apparmor_parser not found (is AppArmor installed?)"; exit 2; }

    if [ -n "${CG_CLAUDE_ATTACH:-}" ] || [ -n "${CG_CODEX_ATTACH:-}" ]; then
        # Swap the attachment globs on the profile header lines only.
        cp "$PROFILE_SRC" "$PROFILE_DST.tmp"
        if [ -n "${CG_CLAUDE_ATTACH:-}" ]; then
            sed -i "s|^profile $PROFILE_NAME [^ ]* flags=|profile $PROFILE_NAME $CG_CLAUDE_ATTACH flags=|" "$PROFILE_DST.tmp"
            note "claude attachment overridden: $CG_CLAUDE_ATTACH"
        fi
        if [ -n "${CG_CODEX_ATTACH:-}" ]; then
            sed -i "s|^profile codex-userns [^ ]* flags=|profile codex-userns $CG_CODEX_ATTACH flags=|" "$PROFILE_DST.tmp"
            note "codex attachment overridden: $CG_CODEX_ATTACH"
        fi
        install -m 0644 "$PROFILE_DST.tmp" "$PROFILE_DST" && rm -f "$PROFILE_DST.tmp"
    else
        install -m 0644 "$PROFILE_SRC" "$PROFILE_DST"
    fi
    apparmor_parser -r "$PROFILE_DST" || { note "apparmor_parser failed"; exit 2; }
    note "installed + loaded $PROFILE_DST"

    # The codex-userns block cannot reuse the python3-copy verification (its attachment matches
    # only the literal .../bin/codex filename), so prove the parser accepted and loaded it.
    if grep -q "^codex-userns " /sys/kernel/security/apparmor/profiles 2>/dev/null; then
        note "codex-userns profile loaded (Codex approved-domain networking exemption active)"
        note "  live proof: a fresh approved-network Codex turn can now reach an allowed domain."
    else
        note "WARNING: codex-userns did not appear in loaded profiles — Codex approved-domain"
        note "  networking will keep failing (tunnel resets). Check the codex install path and"
        note "  re-run with CG_CODEX_ATTACH=<glob> if codex lives somewhere unusual."
    fi

    out=$(run_userns_test attached)
    if [ "$out" = ok ]; then
        note "verified: full sandbox sequence (incl. nested userns) succeeds under real attachment"
        note "No gateway restart needed — the next Bash call in a channel just works."
    else
        note "VERIFY FAILED: $out"
        note "If claude is installed somewhere the glob does not cover, re-run with CG_CLAUDE_ATTACH=<glob>."
        exit 1
    fi
}

case "${1:-}" in
    --check) check ;;
    --apply) apply ;;
    *) note "usage: sudo sh $0 --check | --apply"; exit 2 ;;
esac
