// Runtime backend registry — mirrors src/engines/registry.js and src/platforms/registry.js. Every
// backend is validated against the contract at load time (fail closed).
import { DEFAULT_RUNTIME_BACKEND, RUNTIME_BACKEND_IDS, validateRuntimeBackend } from "./contract.js";
import { hostBackend } from "./host.js";
import { containerBackend } from "./container/index.js";

const BACKENDS = new Map();
for (const backend of [hostBackend, containerBackend]) {
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

// Stored records written before v0.8 have no backend at all; they are host rows.
export function runtimeBackendOr(id, fallback = DEFAULT_RUNTIME_BACKEND) {
  return BACKENDS.get(id) || BACKENDS.get(fallback);
}

export function runtimeBackendIds() {
  return [...BACKENDS.keys()];
}
