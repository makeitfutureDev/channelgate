// Runtime backend registry — mirrors src/engines/registry.js and src/platforms/registry.js. Every
// backend is validated against the contract at load time (fail closed). Since 2026-09-03 the
// container backend is the ONLY channel runtime: the host OS-sandbox backend is gone, and the
// daemon's own process spawner (./local.js) is deliberately not registered here.
import { DEFAULT_RUNTIME_BACKEND, RUNTIME_BACKEND_IDS, validateRuntimeBackend } from "./contract.js";
import { containerBackend } from "./container/index.js";

const BACKENDS = new Map();
for (const backend of [containerBackend]) {
  validateRuntimeBackend(backend);
  BACKENDS.set(backend.id, backend);
}

export { RUNTIME_BACKEND_IDS, DEFAULT_RUNTIME_BACKEND };

export function isRuntimeBackendId(id) {
  return BACKENDS.has(id);
}

export function runtimeBackend(id) {
  const backend = BACKENDS.get(id);
  if (!backend) throw new Error(`unknown runtime backend "${id}"`);
  return backend;
}

// Stored records written before v0.8 name no backend at all, and rows written while the host
// backend still existed name "host"; both resolve to the one backend there is.
export function runtimeBackendOr(id, fallback = DEFAULT_RUNTIME_BACKEND) {
  return BACKENDS.get(id) || BACKENDS.get(fallback);
}

export function runtimeBackendIds() {
  return [...BACKENDS.keys()];
}
