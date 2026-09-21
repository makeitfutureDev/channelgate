// Non-serializable proof that this turn passed the live `/sudo` admin check. A stored channel row,
// JSON API override, plugin payload, or stale database field can spell `sudoMode: true`, but none
// can recreate this process-local Symbol. Only sudoModeMeta() mints it after authorization.
const SUDO_RUNTIME_AUTHORITY = Symbol("channelgate.sudo-runtime-authority");

export function authorizeSudoRuntime(meta = {}) {
  return { ...meta, [SUDO_RUNTIME_AUTHORITY]: true };
}

export function hasSudoRuntimeAuthority(meta = {}) {
  return meta?.[SUDO_RUNTIME_AUTHORITY] === true;
}
