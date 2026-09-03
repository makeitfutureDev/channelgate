// Which transports are actually RUNNING right now.
//
// The registry (registry.js) holds per-platform FACTS — they are static and load with the module.
// Whether a transport is connected is not a fact, it is state, and it changes when an operator saves
// credentials in the admin UI. Keeping it here rather than inside the adapters is what lets an
// adapter stay a pure descriptor while `createConnector()` still hands back a LIVE connector when
// one exists and the throwing null connector when it does not.
//
// Deliberately dependency-free: adapters import this, so it must import nothing back from them.
const managers = new Map(); // platform id → transport manager

export function registerTransport(platform, manager) {
  if (!platform || !manager) return;
  managers.set(String(platform), manager);
}

export function unregisterTransport(platform) {
  managers.delete(String(platform));
}

export function transportManager(platform) {
  return managers.get(String(platform)) || null;
}

// The live connector for a platform, or null when its transport is not connected. Callers must
// treat null as "cannot deliver" — the adapter's null connector is what turns that into a THROW at
// the point of a write, because a silent no-op looks like a delivered answer to the scheduler.
export function liveConnector(platform) {
  return transportManager(platform)?.getConnector?.() || null;
}

export function transportSnapshot(platform) {
  return transportManager(platform)?.snapshot?.() || null;
}

// Test hook: drop every registration. Nothing in the daemon calls this — the manager's own
// disconnect() is the operator-facing path.
export function resetTransports() {
  managers.clear();
}
