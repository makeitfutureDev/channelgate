// Harness ids an earlier release shipped and this one does not.
//
// Removing an engine deletes its adapter, but not the rows that name it: a channel default, a
// thread pin, an approved-harness policy and a session stamp are all plain strings in SQLite, and
// a restored backup can bring any of them back long after the upgrade. A retired id is therefore
// not "unknown input" (which the API boundary still refuses) — it is stored data every reader has
// to step over without ending a turn:
//   - a channel default naming one follows the gateway default again (config/store.js);
//   - a thread pin naming one is no pin (gateway/thread-engine.js already ignores unknown ids);
//   - an approved-harness policy keeps its remaining harnesses (gateway/channel-engines.js);
//   - a session stamped by one has nothing to resume: the thread continues on a current harness
//     in a fresh session with its chat transcript replayed (gateway/sessions.js, gateway/run.js).
//
// Dependency-free on purpose, so the store and the session map can import it without pulling in
// the adapter graph. Retiring an engine means adding its id here in the same change, and an id on
// this list is never registered again (test/retired-engine.test.js).
export const RETIRED_ENGINE_IDS = Object.freeze(["opencode"]);

export const isRetiredEngineId = (value) => RETIRED_ENGINE_IDS.includes(value);
