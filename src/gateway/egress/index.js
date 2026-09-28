// The egress proxy's public surface, in one import for the slice that wires it per channel.
//
// Why a barrel: the wiring (container lifecycle, channel env, grants storage) should depend on the
// proxy's contract, not on how it is split into files. Everything here imports only node built-ins
// and src/web/ip-policy.js — no database, no settings — so it stays unit-testable in isolation.
export { createCaCertificate, issueLeafCertificate } from "./x509.js";
export { loadOrCreateEgressCa, LEAF_CACHE_MAX, LEAF_VALIDITY_HOURS, LEAF_RENEW_BEFORE_MS } from "./ca.js";
export {
  PLACEHOLDER_PREFIX, PLACEHOLDER_RE, PLACEHOLDER_SHAPES,
  mintPlaceholder, shapePlaceholder, findPlaceholders, corePlaceholder, placeholderScope,
} from "./placeholders.js";
export {
  DEFAULT_SWAP_HEADERS, hostMatches, normalizeHost, grantAllowsHost, swapHeaders, swapRequest, placeholdersInRequest,
} from "./rules.js";
export { createScrubber, isScrubbableContentType, MIN_SCRUB_LENGTH } from "./scrub.js";
export { checkDestination, isValidDestinationHost } from "./policy.js";
export { createEgressProxy, parseAuthority } from "./proxy.js";
