// The inbound half of Google Chat: a Pub/Sub PULL subscription.
//
// This is why Chat is the cheap second surface. A Chat app configured with a Cloud Pub/Sub
// connection has Google publish its events to a topic we own, and we pull them over an outbound
// HTTPS connection — no public endpoint, no tunnel, no inbound firewall rule. It is the same
// posture as Slack's Socket Mode, which is the posture the whole daemon is built around.
//
// Implemented against the REST API rather than @google-cloud/pubsub for the dependency reason in
// auth.js. A REST `pull` with returnImmediately unset is a bounded long-poll, so the loop is not a
// busy poll: it blocks server-side until a message arrives or the request times out.
import { setTimeout as delay } from "node:timers/promises";

const BASE = "https://pubsub.googleapis.com/v1";
const SUBSCRIPTION_RE = /^projects\/[a-z0-9-]+\/subscriptions\/[A-Za-z0-9_.~+%-]+$/;

export const isSubscriptionName = (v) => SUBSCRIPTION_RE.test(String(v || ""));

// Pub/Sub delivers at-least-once, so the same Chat message can arrive twice (a redelivery after a
// slow ack, a retried publish). Running the same turn twice is the worst possible failure here —
// the user sees two answers and pays twice — so ids are remembered for a bounded window.
export function createDedupe(limit = 500) {
  const seen = new Set();
  return {
    isDuplicate(id) {
      if (!id) return false;
      if (seen.has(id)) return true;
      seen.add(id);
      if (seen.size > limit) seen.delete(seen.values().next().value);
      return false;
    },
    get size() { return seen.size; },
  };
}

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;

export function createPubSubPuller({
  auth,
  subscription,
  onEvent,
  onFatal = () => {},
  maxMessages = 10,
  fetchImpl = fetch,
  sleep = delay,
  random = Math.random,
  log = console,
} = {}) {
  if (!auth?.token) throw new TypeError("createPubSubPuller requires a Google auth provider");
  if (!isSubscriptionName(subscription)) {
    throw new Error('Pub/Sub subscription must look like "projects/<project>/subscriptions/<name>"');
  }
  if (typeof onEvent !== "function") throw new TypeError("createPubSubPuller requires an onEvent handler");

  let running = false;
  let controller = null;
  let loop = null;
  let generation = 0;
  let attempt = 0;
  let lastError = "";

  async function post(path, body, gen) {
    const requestController = new AbortController();
    controller = requestController;
    const token = await auth.token();
    if (!running || gen !== generation) throw new DOMException("Puller stopped", "AbortError");
    const res = await fetchImpl(`${BASE}/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: requestController.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`Pub/Sub ${path} failed (${res.status}): ${text.slice(0, 300)}`);
      err.status = res.status;
      // 401/403/404 are configuration facts, not weather: a revoked key, a service account without
      // roles/pubsub.subscriber, or a subscription that does not exist. Backing off and retrying
      // those forever hides a setup error behind an infinite quiet loop.
      err.fatal = res.status === 401 || res.status === 403 || res.status === 404;
      if (res.status === 401) auth.reset?.();
      throw err;
    }
    return res.json().catch(() => ({}));
  }

  async function pullOnce(gen) {
    const res = await post(`${subscription}:pull`, { maxMessages }, gen);
    const received = res?.receivedMessages || [];
    if (!received.length) return 0;

    // The handler accepts durably into the local inbox. ACK only accepted events; engine work
    // runs independently of the pull loop and cannot hold another conversation or transport stop.
    const ackIds = [];
    for (const entry of received) {
      if (!running || gen !== generation) break;
      const message = entry?.message || {};
      let envelope = null;
      try {
        envelope = JSON.parse(Buffer.from(String(message.data || ""), "base64").toString("utf8"));
      } catch {
        log.warn?.("[googlechat] dropping a Pub/Sub payload that is not JSON");
        if (entry.ackId) ackIds.push(entry.ackId);
        continue;
      }
      try {
        await onEvent(envelope, message.attributes || {}, { messageId: message.messageId || "" });
        if (entry.ackId) ackIds.push(entry.ackId);
      } catch (err) {
        // One bad event must not kill the subscription; the next message is unrelated to it.
        log.error?.(`[googlechat] event handler threw: ${err?.message || err}`);
      }
    }
    if (running && gen === generation && ackIds.length) await post(`${subscription}:acknowledge`, { ackIds }, gen);
    return received.length;
  }

  async function run(gen) {
    while (running && gen === generation) {
      try {
        await pullOnce(gen);
        if (attempt) log.info?.(`[googlechat] Pub/Sub pull recovered after ${attempt} failed attempts`);
        attempt = 0;
        lastError = "";
      } catch (err) {
        if (!running || gen !== generation || err?.name === "AbortError") return;
        lastError = err?.message || String(err);
        if (err?.fatal) {
          running = false;
          log.error?.(`[googlechat] Pub/Sub pull stopped: ${lastError}`);
          onFatal(err);
          return;
        }
        attempt += 1;
        // Full jitter (uniform in [0, cap]) rather than plain exponential: several gateways
        // reconnecting after the same Google blip should not retry in lockstep.
        const cap = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(attempt - 1, 6));
        log.warn?.(`[googlechat] Pub/Sub pull failed (attempt ${attempt}): ${lastError}`);
        controller = new AbortController();
        try { await sleep(random() * cap, undefined, { signal: controller.signal }); } catch { if (!running) return; }
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      loop = run(++generation);
      return loop;
    },
    async stop() {
      running = false;
      generation++;
      try { controller?.abort(); } catch { /* already gone */ }
      // Do not wait for an auth provider or an already accepted engine turn. Both may be slow;
      // the generation's running flag prevents dispatch after stop and the inbox owns the work.
      loop = null;
    },
    get running() { return running; },
    get lastError() { return lastError; },
  };
}
