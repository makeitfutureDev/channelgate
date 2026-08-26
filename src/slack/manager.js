// Slack lifecycle manager: lets the gateway connect, disconnect, and reconnect the Socket Mode
// app at runtime so saving new tokens in the admin UI takes effect without restarting the whole
// process. Holds the current app + a status snapshot for the settings page.
//
// Lifecycle safety (H10): connect/disconnect transitions are serialized on a promise chain so two
// concurrent calls can never each start a Socket Mode app and race for `current` (the loser would
// keep running untracked — processing every event twice, or staying live on rotated credentials
// after a "Disconnect"). A generation counter claimed at REQUEST time backs the chain up, because
// serialization alone can't help a connect that is already inside startSlack when the next one
// arrives: such a connect discovers it was superseded and stops the app IT started instead of
// publishing it, so rotated credentials never leave an orphaned Socket Mode app behind.
import { startSlack } from "./app.js";

export function createSlackManager({ start = startSlack } = {}) {
  let current = null; // { app, botUserId, user, team, teamId }
  let status = "disconnected"; // disconnected | connecting | connected | error
  let error = null;
  let generation = 0; // bumped by every transition; identifies stale in-flight connects
  let chain = Promise.resolve(); // serializes all connect/disconnect transitions

  // Claim the newest intent SYNCHRONOUSLY, then queue the work behind every earlier transition.
  // Claiming up front is what makes the generation guard real: a connect still awaiting startSlack
  // learns it was superseded the moment a newer connect/disconnect is REQUESTED, not whenever it
  // happens to get scheduled. The stored chain always resolves (failures propagate to the caller
  // only) so one bad transition can never wedge the manager.
  function transition(work) {
    const gen = (generation += 1);
    const run = chain.then(() => work(gen));
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async function stopApp(app) {
    if (!app) return;
    try {
      await app.stop();
    } catch {
      /* already stopped */
    }
  }

  // Teardown always runs, even when a newer transition has already superseded it: stopping is
  // idempotent and can only ever leave LESS running, never an orphan.
  function disconnect() {
    return transition(async () => {
      const app = current?.app;
      current = null;
      status = "disconnected";
      error = null;
      await stopApp(app);
      return snapshot();
    });
  }

  // (Re)connect with the given config. Tears down any existing connection first. Never throws —
  // failures are captured in the status snapshot so the UI can show them.
  function connect(config) {
    return transition(async (gen) => {
      // Superseded while queued: a newer connect/disconnect already owns the manager, so don't
      // start an app it would immediately have to tear down again. That transition also owns the
      // teardown of whatever is currently live, so leave state untouched.
      if (gen !== generation) return snapshot();
      const previous = current?.app;
      current = null;
      status = "connecting";
      error = null;
      await stopApp(previous);
      try {
        const started = await start(config);
        if (gen !== generation) {
          // A later transition superseded this connect while startSlack ran — its app must not win
          // `current`, and it must not be left running against the credentials we were replacing.
          // Stop the one WE started and leave the newer transition's state alone.
          await stopApp(started?.app);
          return snapshot();
        }
        current = started;
        status = "connected";
      } catch (err) {
        console.error("[slack] connect failed:", err.message);
        if (gen === generation) {
          status = "error";
          error = err.message;
          current = null;
        }
      }
      return snapshot();
    });
  }

  function snapshot() {
    return {
      status,
      connected: status === "connected",
      user: current?.user ?? null,
      team: current?.team ?? null,
      teamId: current?.teamId ?? null,
      botUserId: current?.botUserId ?? null,
      error,
    };
  }

  function getClient() {
    return current?.app?.client ?? null;
  }

  return { connect, disconnect, snapshot, getClient };
}
