// The one answer to "may ChannelGate run on this host?". Dependency-free on purpose: src/start.js
// dynamically imports it AFTER the Node floor check and BEFORE the server graph, so an unsupported
// host gets one plain line instead of a stack trace from the first Linux-only module it touches.
//
// ChannelGate runs on Linux only: the service is a systemd unit and every channel runs inside a
// rootless Podman container. There is no macOS/launchd or host-sandbox runtime any more.
export const SUPPORTED_PLATFORM = "linux";

// "" when the platform is supported, otherwise the exact refusal line start.js prints.
export function platformRefusal(platform = process.platform) {
  if (platform === SUPPORTED_PLATFORM) return "";
  return `ChannelGate runs on Linux only (systemd + rootless Podman); this host is ${platform}.`;
}
