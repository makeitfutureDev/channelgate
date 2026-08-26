# Claude Code Bash sandbox on Ubuntu (AppArmor user-namespace restriction)

## Symptom

On a Linux gateway host, **every Bash call in every channel fails** while Read/Write/MCP keep
working. The engine reports:

```
apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted;
caller must provide CAP_SYS_ADMIN): Permission denied
```

The daemon says so at boot too (`[gateway] WARNING: AppArmor restricts unprivileged user
namespaces … sandboxed Bash will fail in every channel`) — see `src/engines/linux-userns.js`.

## Root cause

Claude Code's Bash sandbox is built on an unprivileged user namespace (plus a *nested* one for
its seccomp stage). Ubuntu 23.10+ (including **24.04 LTS**) ships
`kernel.apparmor_restrict_unprivileged_userns = 1`; 25.04+ adds
`kernel.apparmor_restrict_unprivileged_unconfined = 1`. Under those, any **unconfined** process
that calls `unshare(CLONE_NEWUSER)` is stacked into the stock capability-stripped
`unprivileged_userns` profile, so the follow-up `setgroups` / `uid_map` writes get EPERM and
the sandbox never comes up. Interactive `claude` sessions look fine because they run unsandboxed;
gateway channels have `sandbox.enabled` and are hit on the first Bash call.

Any host **upgraded to or provisioned on** one of those releases flips to restricted by
default, so this reappears on "healthy" fleets after an OS upgrade — bake the profile into
provisioning.

## Fix (targeted, host hardening stays on)

`claude-code-userns` is an AppArmor profile attached to the Claude version binaries. It is a
*mediating* profile that allows everything (`allow all, allow userns, allow capability,`) — the
same shape Ubuntu uses for `/usr/bin/bwrap`. A confined process is exempt from the
unprivileged restriction, keeps its capabilities inside the namespace, and its children
(bash, tools) inherit the profile, so the nested seccomp namespace works too. Claude Code's own
seccomp/landlock sandbox remains the real confinement for those children.

Why not `sysctl kernel.apparmor_restrict_unprivileged_userns=0`? That reopens unprivileged user
namespaces for **every** process on the host — a real kernel attack-surface increase. The profile
weakens nothing else.

```
sudo sh scripts/apparmor/claude-userns-fix.sh --check    # audit; exit 1 if (or when) broken
sudo sh scripts/apparmor/claude-userns-fix.sh --apply    # install + load + live-verify
```

No daemon restart is needed; the next spawn picks the profile up. The attachment glob
`/{home,var/lib}/*/.local/share/claude/versions/*` covers every user's native install and
the `install-systemd.sh` service home; it survives Claude self-updates (new versions are new
files under `versions/`) and new users. If `claude` lives elsewhere, pass the glob:
`CG_CLAUDE_ATTACH='/opt/claude/versions/*' sudo -E sh scripts/apparmor/claude-userns-fix.sh --apply`.

Note the layout: the native installer stores each version as a **file**
(`~/.local/share/claude/versions/2.1.246` *is* the executable) — a `versions/*/claude` glob
would never attach.

### Provisioning snippet (cloud-init / Ansible)

```yaml
# cloud-init
runcmd:
  - [ sh, -c, "cd /opt/channelgate && sh scripts/apparmor/claude-userns-fix.sh --apply" ]
```

```yaml
# ansible
- name: Claude Code userns AppArmor profile
  ansible.builtin.command: sh scripts/apparmor/claude-userns-fix.sh --apply
  args: { chdir: /opt/channelgate }
  become: true
```

`scripts/install-systemd.sh` prints the same instruction when it detects the restriction.

## Verification pitfalls (all three produced a wrong verdict while building this)

1. **`unshare -U -r true` passes on broken hosts.** Ubuntu ships its own profile for
   `/usr/bin/unshare`, so it is exempt while Claude is not.
2. **`aa-exec -p claude-code-userns` fails on healthy hosts** (AppArmor 5.0): `aa-exec` from an
   unconfined shell produces a `profile//&unconfined` *stack* and the restriction still fires —
   Ubuntu's own stock `lxc-usernsexec` profile "fails" that test too. Only real exec
   **attachment** is faithful; the script copies `python3` into the versions dir and runs it from
   there as the target user.
3. **Capture `getuid()` before `unshare`.** Afterwards it reads the unmapped `65534`, and a
   `0 65534 1` uid_map is rightly refused with EPERM — a false negative that looks exactly like
   capability stripping.

The end-to-end proof is a sandboxed run: in a folder whose `.claude/settings.json` has
`{"sandbox":{"enabled":true}}`, `claude -p "run: echo ok"` must print `ok`, and
`cat /proc/self/attr/apparmor/current` from inside shows `claude-code-userns (enforce)`.

## Not covered by this profile

- **Containers** (LXC/Docker): the host profile does not reach inside. LXC needs
  `security.nesting=true`; Docker needs a permissive seccomp/AppArmor runtime config. `--check`
  detects and flags this rather than applying the wrong fix.
- **Debian-style hard off** (`kernel.unprivileged_userns_clone=0`) or `user.max_user_namespaces=0`:
  `--check` reports these; they are sysctl decisions, not AppArmor ones.
