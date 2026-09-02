// Lifecycle manager for a chat transport: connect, disconnect, reconnect at runtime so saving
// credentials in the admin UI takes effect without restarting the daemon.
//
// The serialization discipline is lifted from src/slack/manager.js, and for the same reason it was
// written there: two concurrent connects would each start a live transport and race for `current`,
// and the loser keeps running untracked — processing every event twice, or staying connected on
// credentials the operator just rotated away. A generation counter claimed SYNCHRONOUSLY at request
// time is what lets a connect still inside start() discover it was superseded and tear down the
// transport it started instead of publishing it.
//
// Slack keeps its own copy because its snapshot carries Slack-specific identity (team, botUserId)
// and rewiring a live surface to prove a point is not worth the risk; this is the shape every
// SUBSEQUENT platform shares.
export function createTransportManager({ platform, start, log = console } = {}) {
  if (!platform) throw new TypeError("createTransportManager requires a platform id");
  if (typeof start !== "function") throw new TypeError("createTransportManager requires a start()");

  let current = null; // { stop(), connector, detail }
  let status = "disconnected"; // disconnected | connecting | connected | error
  let error = null;
  let generation = 0;
  let chain = Promise.resolve();

  function transition(work) {
    const gen = (generation += 1);
    const run = chain.then(() => work(gen));
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function stopTransport(transport) {
    if (!transport?.stop) return;
    try {
      await transport.stop();
    } catch {
      /* already stopped */
    }
  }

  function disconnect() {
    return transition(async () => {
      const transport = current;
      current = null;
      status = "disconnected";
      error = null;
      await stopTransport(transport);
      return snapshot();
    });
  }

  function connect(config) {
    return transition(async (gen) => {
      if (gen !== generation) return snapshot();
      const previous = current;
      current = null;
      status = "connecting";
      error = null;
      await stopTransport(previous);
      try {
        const started = await start(config);
        if (gen !== generation) {
          await stopTransport(started);
          return snapshot();
        }
        current = started;
        status = "connected";
      } catch (err) {
        log.error?.(`[${platform}] connect failed: ${err?.message || err}`);
        if (gen === generation) {
          status = "error";
          error = err?.message || String(err);
          current = null;
        }
      }
      return snapshot();
    });
  }

  function snapshot() {
    return {
      platform,
      status,
      connected: status === "connected",
      detail: current?.detail || "",
      error,
    };
  }

  return {
    connect,
    disconnect,
    snapshot,
    getConnector: () => current?.connector ?? null,
    // The live transport, for the few things that need more than a connector (the Teams webhook
    // handler the Express route mounts, the Chat puller's health).
    getTransport: () => current,
  };
}
