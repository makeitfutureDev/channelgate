// The one home for per-platform FACTS — capabilities, id namespacing, outbound formatter, transport
// — mirroring src/engines/registry.js. Add a chat platform by adding an adapter plus a connector,
// never by adding another `platform === "slack"` branch somewhere in the daemon.
import { BUILTIN_PLATFORM_ADAPTERS } from "./adapters.js";
import { createPlatformRegistry, CAPABILITY_SPEC } from "./contract.js";

export const platformRegistry = createPlatformRegistry(BUILTIN_PLATFORM_ADAPTERS);
export const PLATFORM_IDS = platformRegistry.ids;

// The surface that existed before this seam. Any stored record without a platform is Slack's —
// there is no other possibility, and defaulting is what keeps every pre-existing row resolvable.
export const DEFAULT_PLATFORM = "slack";

export const isPlatformId = (value) => Boolean(platformRegistry.get(value));
export const platformFor = (id) => platformRegistry.get(id);
export function requirePlatform(id) { return platformRegistry.require(id); }
// Read a platform id off a stored record. Unknown/missing → Slack, so legacy rows keep working;
// an id we do not recognize must NOT fall through to "least capable", because that would silently
// degrade a live Slack channel's replies.
export function platformOr(id, fallbackId = DEFAULT_PLATFORM) { return platformFor(id) || requirePlatform(fallbackId); }

export function platformLabel(id) { return platformFor(id)?.label ?? String(id || ""); }
// The on-disk folder component for a platform (`slack`, `teams`, `google-chat`). Same fail-closed
// rule as everything else here: an unknown/missing id is Slack's, because every stored row written
// before multi-platform support is a Slack row and its folder must keep resolving.
export function platformFolderName(id) { return platformOr(id).folderName; }
// Every folder component in use, for the migration and for the sandbox's sibling-deny sweep.
export function platformFolderNames() { return PLATFORM_IDS.map((id) => requirePlatform(id).folderName); }
export function capabilitiesFor(id) { return platformOr(id).capabilities; }
// The capability check every caller should use. An unknown capability key is a programming error,
// not a "no" — a typo that silently reads false would disable a feature on every platform at once.
export function platformSupports(id, capability) {
  if (!Object.hasOwn(CAPABILITY_SPEC, capability)) throw new TypeError(`Unknown platform capability "${capability}"`);
  return capabilitiesFor(id)[capability];
}
export function formatOutboundFor(id, markdown, options = {}) {
  const adapter = platformOr(id);
  return adapter.formatOutbound(markdown, { capabilities: adapter.capabilities, ...options });
}
export function platformUiManifest() { return platformRegistry.manifests(); }
export function platformStatus(id) { return platformOr(id).status; }
// Platforms whose transport is actually wired. Everything else is a descriptor + formatter only,
// and its connector throws on write rather than pretending to deliver.
export function livePlatformIds() { return PLATFORM_IDS.filter((id) => requirePlatform(id).status !== "scaffold"); }

export async function platformHealth(options) {
  return Promise.all(PLATFORM_IDS.map(async (id) => ({ id, label: platformLabel(id), status: platformStatus(id), ...(await requirePlatform(id).health(options)) })));
}
