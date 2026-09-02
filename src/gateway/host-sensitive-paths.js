// Host identity sits outside every channel workspace and can correlate the daemon machine.
// Restricted engine baselines still need selected OS paths to launch ordinary tools, so deny
// these identity-bearing exceptions explicitly. A qualifying foreground admin turn bypasses the
// sandbox entirely and therefore does not depend on these restricted-profile exceptions.
export const HOST_IDENTITY_PATHS = Object.freeze([
  "/etc/hostname",
  "/etc/machine-id",
  "/var/lib/dbus/machine-id",
  "/proc/sys/kernel/hostname",
]);
