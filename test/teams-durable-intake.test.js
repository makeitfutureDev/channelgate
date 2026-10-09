import test from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const [{ startTeams }, { createTeamsWebhook }, { activityFingerprint }, { getDb, toJson }] = await Promise.all([
  import("../src/platforms/msteams/transport.js"),
  import("../src/platforms/msteams/webhook.js"),
  import("../src/platforms/msteams/verify.js"),
  import("../src/db/index.js"),
]);
const [{ createIngest }, { setUser, getChannelEntry, patchChannelMeta }, { teamsAdapter }, { normalizeActivity }] = await Promise.all([
  import("../src/platforms/ingest.js"), import("../src/config/store.js"),
  import("../src/platforms/msteams.js"), import("../src/platforms/msteams/activity.js"),
]);
const SERVICE = "https://smba.trafficmanager.net/emea/";
const log = { error() {}, warn() {} };
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "durable-key", alg: "RS256" };
const jwks = { get: async () => jwk };
function token(appId) {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: "https://api.botframework.com", aud: appId,
    exp: Math.floor(Date.now() / 1000) + 60, serviceurl: SERVICE })).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(privateKey, "base64url")}`;
}
function activity(appId, overrides = {}) {
  return { type: "message", id: randomUUID(), timestamp: new Date().toISOString(), text: "hello",
    conversation: { id: "19:chat@thread.v2", conversationType: "personal" },
    from: { id: "29:author", name: "Test author" }, recipient: { id: `28:${appId}` },
    serviceUrl: SERVICE, ...overrides };
}
function response(check = () => {}) {
  return { code: null, body: null, status(code) { this.code = code; return this; },
    json(body) { check(this.code, body); this.body = body; return this; } };
}
const request = (appId, body) => ({ body, headers: { authorization: `Bearer ${token(appId)}` } });
const row = (appId, body, controls = false) => getDb().prepare("SELECT * FROM inbound_events WHERE namespace = ? AND event_id = ?")
  .get(`msteams-bot${controls ? "-controls" : ""}:${appId}`, activityFingerprint(body));
async function until(predicate) {
  for (let count = 0; count < 200; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Durable Teams event did not reach the expected state");
}
function seed(appId, body, status = "queued") {
  getDb().prepare("INSERT INTO inbound_events(namespace, event_id, conversation_id, status, created_ms, owner, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(`msteams-bot:${appId}`, activityFingerprint(body), body.conversation.id, status, Date.now(), "previous-process",
      toJson({ activity: body, serviceUrl: SERVICE }));
}
async function transport(appId, onMessage, options = {}) {
  return startTeams({ appId, onMessage, log, ...options,
    deps: { auth: { token: async () => "test-token" }, api: {}, jwks,
      connector: { post: async () => {} }, ...options.deps } });
}

test("verified Bot activity is persisted before HTTP 200, then normalized for dispatch", async t => {
  const appId = randomUUID(), body = activity(appId), received = [];
  let finish;
  const hold = new Promise(resolve => { finish = resolve; });
  const current = await transport(appId, async message => { received.push(message); await hold; });
  t.after(async () => { finish(); await current.stop(); });
  const res = response(code => {
    assert.equal(code, 200);
    const saved = row(appId, body);
    assert.ok(saved, "successful acknowledgement must follow SQLite acceptance");
    assert.ok(["queued", "running"].includes(saved.status), "the pump may claim accepted work before the response continuation");
    assert.deepEqual(JSON.parse(saved.data), { activity: body, serviceUrl: SERVICE });
    assert.equal(received.length, 0, "engine dispatch must not delay HTTP acknowledgement");
  });
  await current.handler(request(appId, body), res);
  await until(() => received.length === 1);
  assert.equal(received[0].conversationId, "teams:19:chat@thread.v2");
  finish();
  await until(() => row(appId, body)?.status === "done");
});

test("Teams queue acceptance failure returns 503 without running or acknowledging work", async () => {
  const appId = randomUUID();
  let dispatched = 0, accepted = 0;
  const handler = createTeamsWebhook({ appId, jwks, log, onMessage: () => { dispatched++; },
    acceptActivity: async () => { accepted++; throw new Error("queue full private-detail"); } });
  const res = response();
  await handler(request(appId, activity(appId)), res);
  assert.equal(res.code, 503);
  assert.equal(accepted, 1);
  assert.equal(dispatched, 0);
  assert.doesNotMatch(JSON.stringify(res.body), /private-detail/);
});

test("Teams durable acceptance waits for async persistence before acknowledgement", async () => {
  const appId = randomUUID();
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const handler = createTeamsWebhook({ appId, jwks, log, onMessage() {}, acceptActivity: () => pending });
  const res = response(), running = handler(request(appId, activity(appId)), res);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(res.code, null);
  finish(); await running;
  assert.equal(res.code, 200);
});

test("unverified activities never enter durable intake, signed invokes still return immediate results", async () => {
  const appId = randomUUID();
  let accepted = 0, invoked = 0;
  const handler = createTeamsWebhook({ appId, jwks, log, onMessage() {}, acceptActivity: () => { accepted++; },
    onInvoke: async () => { invoked++; return { status: 200, body: { statusCode: 200, value: "Saved" } }; } });
  const body = activity(appId);
  const unauthorized = response();
  await handler({ body, headers: { authorization: "Bearer invalid" } }, unauthorized);
  assert.equal(unauthorized.code, 401);
  const hostile = response();
  await handler(request(appId, { ...body, serviceUrl: "https://evil.example/" }), hostile);
  assert.equal(hostile.code, 401);
  const invoke = { ...body, type: "invoke", name: "adaptiveCard/action",
    value: { action: { type: "Action.Execute", verb: "settings.open", data: {} } } };
  const res = response();
  await handler(request(appId, invoke), res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { statusCode: 200, value: "Saved" });
  assert.equal(accepted, 0);
  assert.equal(invoked, 1);
});

test("Teams rejects incomplete stable identity before durable acknowledgement", async () => {
  const appId = randomUUID();
  let accepted = 0;
  const handler = createTeamsWebhook({ appId, jwks, log, onMessage() {}, acceptActivity: () => { accepted++; } });
  for (const partial of [{ id: "" }, { conversation: {} }]) {
    const res = response();
    await handler(request(appId, activity(appId, partial)), res);
    assert.equal(res.code, 400);
  }
  assert.equal(accepted, 0);
});

test("completed Teams activity retries across transport recreation dispatch only once", async t => {
  const appId = randomUUID(), body = activity(appId), delivered = [];
  const first = await transport(appId, async message => { delivered.push(message); });
  t.after(() => first.stop());
  await first.handler(request(appId, body), response());
  await until(() => row(appId, body)?.status === "done");
  await first.stop();
  const second = await transport(appId, async message => { delivered.push(message); });
  t.after(() => second.stop());
  const res = response();
  await second.handler(request(appId, body), res);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(res.code, 200);
  assert.equal(delivered.length, 1);
});

test("queued Teams activities recover raw attachments and resolver closures after restart", async t => {
  const appId = randomUUID(), delivered = [];
  const body = activity(appId, { attachments: [
    { name: "personal.txt", contentType: "application/vnd.microsoft.teams.file.download.info",
      content: { downloadUrl: "https://example.sharepoint.com/personal.txt", fileType: "txt" } },
    { name: "reference.txt", contentType: "reference", contentUrl: "https://example.sharepoint.com/Documents/reference.txt" },
  ] });
  seed(appId, body);
  const current = await transport(appId, async (message, context) => { delivered.push({ message, context }); },
    { filesEnabled: true, fileDriveIds: ["allowed-drive"], deps: { graphAuth: { token: async () => assert.fail("downloads remain lazy") } } });
  t.after(() => current.stop());
  await until(() => row(appId, body)?.status === "done");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message.attachments.length, 2);
  for (const file of delivered[0].message.attachments) assert.equal(typeof file.download, "function");
  assert.deepEqual(delivered[0].context, { serviceUrl: SERVICE });
});

test("ambiguous running Teams work receives a routed interruption notice and never reruns", async t => {
  const appId = randomUUID(), notices = [], remembered = [];
  const body = activity(appId, { conversation: { id: "19:channel;messageid=root-1", conversationType: "channel" } });
  seed(appId, body, "running");
  const current = await transport(appId, async () => assert.fail("ambiguous external effects must not run twice"),
    { deps: { connector: { rememberServiceUrl: (id, url) => remembered.push([id, url]), post: async payload => { notices.push(payload); } } } });
  t.after(() => current.stop());
  await until(() => row(appId, body)?.status === "done");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].conversationId, "19:channel");
  assert.equal(notices[0].threadKey, "root-1");
  assert.deepEqual(remembered, [["19:channel", SERVICE]]);
  assert.match(notices[0].text, /not run again automatically/);
  await current.handler(request(appId, body), response());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notices.length, 1);
});

test("failed Teams dispatch records an interruption and does not repeat unknown tool effects", async t => {
  const appId = randomUUID(), body = activity(appId), notices = [];
  let executions = 0;
  const current = await transport(appId, async () => { executions++; throw new Error("tool effects unknown"); },
    { deps: { connector: { post: async payload => { notices.push(payload); } } } });
  t.after(() => current.stop());
  await current.handler(request(appId, body), response());
  await until(() => row(appId, body)?.status === "done");
  assert.equal(executions, 1);
  assert.equal(notices.length, 1);
});

test("stopped Teams transport cannot acknowledge new work through a retained handler", async () => {
  const appId = randomUUID(), body = activity(appId);
  const current = await transport(appId, async () => assert.fail("stopped transport cannot dispatch"));
  await current.stop();
  const res = response();
  await current.handler(request(appId, body), res);
  assert.equal(res.code, 503);
  assert.equal(row(appId, body), undefined);
});

test("four active Teams turns cannot starve durable text commands and reaction controls", async t => {
  const appId = randomUUID(), received = [];
  let finish;
  const hold = new Promise(resolve => { finish = resolve; });
  const current = await transport(appId, async message => {
    received.push(message);
    if (message.text === "hello") await hold;
  });
  t.after(async () => { finish(); await current.stop(); });
  const normal = Array.from({ length: 4 }, (_, i) => activity(appId, {
    conversation: { id: `19:channel;messageid=root-${i}`, conversationType: "channel" },
  }));
  for (const body of normal) await current.handler(request(appId, body), response());
  await until(() => received.length === 4);
  const controls = [activity(appId, { text: "/stop" }), activity(appId, { text: "/status" }),
    activity(appId, { type: "messageReaction", replyToId: "target-1", reactionsAdded: [{ type: "stop_sign" }] }),
    activity(appId, { type: "messageReaction", replyToId: "target-1", reactionsAdded: [{ type: "white_check_mark" }] })];
  for (const body of controls) await current.handler(request(appId, body), response());
  await until(() => controls.every(body => row(appId, body, true)?.status === "done"));
  assert.equal(received.length, 8);
  assert.deepEqual(received.slice(4).map(message => message.reactionAction || message.text), ["/stop", "/status", "stop", "ack"]);
  assert.ok(normal.every(body => row(appId, body)?.status === "running"));
  finish();
  await until(() => normal.every(body => row(appId, body)?.status === "done"));
});

test("Teams intake preserves same-session FIFO and runs independent channel roots concurrently", async t => {
  const appId = randomUUID(), received = [];
  let finish;
  const hold = new Promise(resolve => { finish = resolve; });
  const first = activity(appId, { text: "first", conversation: { id: "19:channel;messageid=root-a", conversationType: "channel" } });
  const second = activity(appId, { text: "second", conversation: first.conversation });
  const independent = activity(appId, { text: "other root", conversation: { id: "19:channel;messageid=root-b", conversationType: "channel" } });
  const current = await transport(appId, async (message, context) => {
    if (context.queuedNoticeOnly) return;
    received.push(message.text); if (message.text === "first") await hold;
  });
  t.after(async () => { finish(); await current.stop(); });
  for (const body of [first, second, independent]) await current.handler(request(appId, body), response());
  await until(() => row(appId, independent)?.status === "done");
  assert.deepEqual(received, ["first", "other root"]);
  assert.equal(row(appId, second)?.status, "queued");
  finish();
  await until(() => row(appId, second)?.status === "done");
  assert.deepEqual(received, ["first", "other root", "second"]);
});

test("actual process exit recovers accepted queued Teams work and notices interrupted running work", async t => {
  const appId = randomUUID(), first = activity(appId), pending = activity(appId), delivered = [], notices = [];
  // The child shares only this test's scratch database. It accepts two verified activities,
  // holds the first turn and exits after the second receives its acknowledgement.
  const script = `
    const { startTeams } = await import('./src/platforms/msteams/transport.js');
    const { getDb } = await import('./src/db/index.js');
    const appId = ${JSON.stringify(appId)};
    const current = await startTeams({ appId, onMessage: async () => new Promise(() => {}),
      log: { error() {}, warn() {} }, deps: { auth: { token: async () => 'test-token' }, api: {},
        connector: {}, jwks: { get: async () => (${JSON.stringify(jwk)}) } } });
    const response = () => ({ status(code) { if (code !== 200) throw new Error('unexpected HTTP acknowledgement'); return this; }, json() { return this; } });
    const first = ${JSON.stringify(request(appId, first))};
    const pending = ${JSON.stringify(request(appId, pending))};
    await current.handler(first, response());
    await new Promise(resolve => setImmediate(resolve));
    await current.handler(pending, response());
    const states = getDb().prepare('SELECT status FROM inbound_events WHERE namespace = ? ORDER BY rowid').all('msteams-bot:' + appId);
    if (states.map(row => row.status).join(',') !== 'running,queued') throw new Error('unexpected pre-exit states');
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(row(appId, first)?.status, "running");
  assert.equal(row(appId, pending)?.status, "queued");
  const current = await transport(appId, async message => { delivered.push(message.messageId); },
    { deps: { connector: { post: async payload => { notices.push(payload); } } } });
  t.after(() => current.stop());
  await until(() => row(appId, first)?.status === "done" && row(appId, pending)?.status === "done");
  assert.deepEqual(delivered, [pending.id]);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /not run again automatically/);
});

async function integratedTransport(appId, run, options = {}) {
  const posted = [], edited = [];
  const connector = { platform: "msteams", capabilities: teamsAdapter.capabilities,
    async post(payload) { posted.push(payload); return { conversationId: payload.conversationId, messageId: `sent-${posted.length}`, threadKey: payload.threadKey || "" }; },
    async edit(payload) { edited.push(payload); },
    async directory() { return { map: new Map(), maxWords: 1 }; },
  };
  await setUser("29:author", { name: "Test author", approved: true });
  let ingest;
  const current = await transport(appId, (message, context) => ingest(message, context),
    { ...options, deps: { ...options.deps, connector } });
  ingest = createIngest({ connector, run, onCommand: options.onCommand || null, log: { ...log, info() {} } });
  return { current, connector, posted, edited, ingest };
}
function heldRuns() {
  const seen = [];
  let finish;
  const hold = new Promise(resolve => { finish = resolve; });
  const run = async args => {
    seen.push(args);
    await Promise.race([hold, new Promise((resolve, reject) => {
      if (args.signal.aborted) { reject(new Error("stopped")); return; }
      args.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
    })]);
    return { content: "done", engine: "claude" };
  };
  return { seen, finish: () => finish(), run };
}
function mentioned(appId, conversationId, root, text = "hello", author = "29:author") {
  return activity(appId, { text, from: { id: author, name: "Test author" },
    conversation: { id: `${conversationId};messageid=${root}`, conversationType: "channel" },
    entities: [{ type: "mention", mentioned: { id: `28:${appId}` } }] });
}

for (const command of ["/stop", "/clear", "reaction stop"]) {
  test(`authenticated ${command} cancels the active turn and SQLite pending work while other sessions continue`, async t => {
    const appId = randomUUID(), held = heldRuns();
    const integrated = await integratedTransport(appId, held.run);
    const { current, posted, connector } = integrated;
    t.after(async () => { held.finish(); await current.stop(); });
    const conversationId = `19:${randomUUID()}`;
    const active = Array.from({ length: 4 }, (_, i) => mentioned(appId, conversationId, `root-${i}`));
    for (const body of active) await current.handler(request(appId, body), response());
    await until(() => held.seen.length === 4);
    const queued = [mentioned(appId, conversationId, "root-0", "pending first"), mentioned(appId, conversationId, "root-0", "pending second")];
    for (const body of queued) await current.handler(request(appId, body), response());
    await until(() => posted.filter(payload => /Queued in this session/.test(payload.text)).length === 2);
    assert.match(posted.find(payload => /position 1/.test(payload.text)).text, /position 1/);
    assert.match(posted.find(payload => /position 2/.test(payload.text)).text, /position 2/);
    const status = mentioned(appId, conversationId, "root-0", "/status");
    await current.handler(request(appId, status), response());
    await until(() => row(appId, status, true)?.status === "done");
    assert.ok(posted.some(payload => /3 active\/queued request/.test(payload.text)));
    const stop = command === "reaction stop" ? mentioned(appId, conversationId, "root-0", "") : mentioned(appId, conversationId, "root-0", command);
    if (command === "reaction stop") Object.assign(stop, { type: "messageReaction", replyToId: active[0].id, reactionsAdded: [{ type: "stop_sign" }] });
    await current.handler(request(appId, stop), response());
    await until(() => row(appId, stop, true)?.status === "done" && row(appId, active[0])?.status === "done");
    assert.ok(queued.every(body => row(appId, body)?.status === "done"));
    assert.equal((await connector.pendingForSession({ conversationId: `teams:${conversationId}`, sessionKey: "root-0" })).count, 0);
    assert.equal(held.seen.length, 4, "accepted queued prompts never enter the engine after cancellation");
    assert.ok(active.slice(1).every(body => row(appId, body)?.status === "running"), "different channel roots remain active");
    held.finish();
    await until(() => active.every(body => row(appId, body)?.status === "done"));
  });
}

test("an approved nonauthor cannot cancel another author's durable quoted-session pending work", async t => {
  const appId = randomUUID(), held = heldRuns();
  await setUser("29:other", { name: "Other author", approved: true });
  const { current, posted } = await integratedTransport(appId, held.run);
  t.after(async () => { held.finish(); await current.stop(); });
  const group = { id: `19:${randomUUID()}@thread.v2`, conversationType: "groupChat" };
  const first = activity(appId, { conversation: group, entities: [{ type: "mention", mentioned: { id: `28:${appId}` } }] });
  const quoted = { type: "quotedReply", quotedReply: { messageId: first.id, validatedMessageReference: true } };
  const pending = activity(appId, { conversation: group, text: "pending", entities: [...first.entities, quoted] });
  await current.handler(request(appId, first), response());
  await until(() => held.seen.length === 1);
  await current.handler(request(appId, pending), response());
  await until(() => posted.some(payload => /Queued in this session/.test(payload.text)));
  const unauthorizedStop = activity(appId, { conversation: group, text: "/stop", from: { id: "29:other" }, entities: [...first.entities, quoted] });
  await current.handler(request(appId, unauthorizedStop), response());
  await until(() => row(appId, unauthorizedStop, true)?.status === "done");
  assert.equal(row(appId, pending)?.status, "queued");
  assert.equal(held.seen[0].signal.aborted, false);
  assert.ok(posted.some(payload => /Only the run author/.test(payload.text)));
  const authorStop = { ...unauthorizedStop, id: randomUUID(), from: first.from };
  await current.handler(request(appId, authorStop), response());
  await until(() => row(appId, authorStop, true)?.status === "done" && row(appId, first)?.status === "done");
  assert.equal(row(appId, pending)?.status, "done");
  assert.equal(held.seen.length, 1);
});

test("queue notice preflight cannot disclose positions or run work for an unapproved author", async t => {
  const appId = randomUUID();
  const { current, posted, connector } = await integratedTransport(appId, async () => assert.fail("notice cannot run an engine"));
  t.after(() => current.stop());
  const body = activity(appId, { from: { id: "29:unapproved" } });
  const ingest = createIngest({ connector, run: async () => assert.fail("notice cannot run an engine"), log: { ...log, info() {} } });
  const result = await ingest(normalizeActivity(body, { botId: `28:${appId}` }), { queuedNoticeOnly: true, position: 7, isQueued: () => true });
  assert.equal(result.skipped, "unauthorized");
  assert.ok(posted.some(payload => /not approved/.test(payload.text)));
  assert.ok(posted.every(payload => !/position 7|Queued in this session/.test(payload.text)));
});

for (const command of ["/stop", "/clear"]) {
  test(`${command} ignores unapproved and unmentioned queued actors when checking session ownership`, async t => {
    const appId = randomUUID(), held = heldRuns();
    await setUser("29:approved-other", { name: "Other approved author", approved: true });
    const { current, posted } = await integratedTransport(appId, held.run);
    t.after(async () => { held.finish(); await current.stop(); });
    const nativeId = `19:${randomUUID()}`;
    const first = mentioned(appId, nativeId, "root");
    await current.handler(request(appId, first), response());
    await until(() => held.seen.length === 1);
    const denied = mentioned(appId, nativeId, "root", "unapproved prompt", "29:unapproved-queued");
    const unmentioned = mentioned(appId, nativeId, "root", "unmentioned prompt", "29:approved-other");
    unmentioned.entities = [];
    for (const body of [denied, unmentioned]) await current.handler(request(appId, body), response());
    const status = mentioned(appId, nativeId, "root", "/status");
    await current.handler(request(appId, status), response());
    await until(() => row(appId, status, true)?.status === "done");
    assert.ok(posted.some(payload => /1 active\/queued request/.test(payload.text)));
    assert.ok(posted.every(payload => !/3 active\/queued request/.test(payload.text)));
    const stop = mentioned(appId, nativeId, "root", command);
    await current.handler(request(appId, stop), response());
    await until(() => row(appId, stop, true)?.status === "done" && row(appId, first)?.status === "done");
    assert.ok([denied, unmentioned].every(body => row(appId, body)?.status === "done"));
    assert.equal(held.seen.length, 1);
    assert.equal(held.seen[0].signal.aborted, true);
    assert.ok(posted.every(payload => !/Only the run author/.test(payload.text)));
  });
}

test("Graph Stop traverses durable notification, snapshot and controls intake while four engines are busy", async t => {
  const appId = randomUUID(), held = heldRuns(), subscriptions = [];
  let graphOptions;
  const nativeId = `19:${randomUUID()}`;
  const active = Array.from({ length: 4 }, (_, i) => mentioned(appId, nativeId, `root-${i}`));
  const graph = {
    start() {}, async stop() {},
    async refresh(row) { return subscriptions.find(current => current.conversationId === row.conversationId) || null; },
    async ensure() {},
    async processNotifications(accepted) { for (const item of accepted) await graphOptions.onMessage(item.message, item.row); },
    handle() {},
  };
  const options = { allMessageEvents: true, tenantId: "fixture-tenant", publicUrl: "https://gateway.example",
    deps: { graphAuth: { token: async () => "test-graph-token" }, eventStore: { list: () => subscriptions },
      apiForServiceUrl: () => ({ listMembers: async () => [] }),
      createGraphEvents: opts => { graphOptions = opts; return graph; },
      normalizeGraphEvents: async snapshot => {
        const body = snapshot.kind === "stop" ? { ...active[0], id: snapshot.id, type: "messageReaction", replyToId: active[0].id, reactionsAdded: [{ type: "stop_sign" }] }
          : { ...active[0], id: snapshot.id, text: "graph queued prompt" };
        const inbound = normalizeActivity(body, { botId: `28:${appId}` });
        inbound.raw.eventId = `graph:${snapshot.id}`;
        return [inbound];
      },
    },
  };
  const { current, posted } = await integratedTransport(appId, held.run, options);
  t.after(async () => { held.finish(); await current.stop(); });
  for (const body of active) await current.handler(request(appId, body), response());
  await until(() => held.seen.length === 4);
  const subscription = { conversationId: `teams:${nativeId}`, startedAt: "fixture-start",
    context: { conversation: { id: nativeId, conversationType: "channel" }, serviceUrl: SERVICE } };
  subscriptions.push(subscription);
  const queuedId = randomUUID(), stopId = randomUUID();
  await graphOptions.enqueueNotifications([{ row: subscription, message: { id: queuedId, kind: "queued" } }]);
  const graphRow = id => getDb().prepare("SELECT * FROM inbound_events WHERE namespace = ? AND event_id = ?")
    .get(`msteams-graph-dispatch:${appId}`, `graph:${id}`);
  await until(() => graphRow(queuedId)?.status === "queued");
  await graphOptions.enqueueNotifications([{ row: subscription, message: { id: stopId, kind: "stop" } }]);
  await until(() => row(appId, active[0])?.status === "done");
  assert.equal(graphRow(queuedId)?.status, "done");
  assert.equal(held.seen.length, 4);
  assert.ok(posted.some(payload => /Stop requested/.test(payload.text)));
  assert.ok(active.slice(1).every(body => row(appId, body)?.status === "running"));
  held.finish();
  await until(() => active.every(body => row(appId, body)?.status === "done"));
});

test("legacy Graph dispatch scheduling keys recover into the same authorized pending cancellation scope", async t => {
  const busyApp = randomUUID(), appId = randomUUID(), held = heldRuns();
  const busy = await integratedTransport(busyApp, held.run);
  t.after(async () => { held.finish(); await busy.current.stop(); });
  const busyBodies = Array.from({ length: 4 }, (_, i) => mentioned(busyApp, `19:${randomUUID()}`, `busy-${i}`));
  for (const body of busyBodies) await busy.current.handler(request(busyApp, body), response());
  await until(() => held.seen.length === 4);
  const nativeId = `19:${randomUUID()}`, body = mentioned(appId, nativeId, "legacy-root", "legacy queued prompt");
  const inbound = normalizeActivity(body, { botId: `28:${appId}` });
  inbound.raw.eventId = `legacy:${body.id}`;
  const subscription = { conversationId: `teams:${nativeId}`, startedAt: "legacy-fixture-start",
    context: { conversation: { id: nativeId, conversationType: "channel" }, serviceUrl: SERVICE } };
  getDb().prepare("INSERT INTO inbound_events(namespace,event_id,conversation_id,status,created_ms,owner,data) VALUES(?,?,?,'queued',?,'',?)")
    .run(`msteams-graph-dispatch:${appId}`, inbound.raw.eventId, inbound.raw.eventId, Date.now(), toJson({ inbound, serviceUrl: SERVICE, subscription }));
  const graph = { start() {}, async stop() {}, async refresh(row) { return row; }, async ensure() {}, handle() {} };
  const recovered = await integratedTransport(appId, async () => assert.fail("legacy queued work must remain pending until authorized cancellation"),
    { allMessageEvents: true, tenantId: "fixture-tenant", publicUrl: "https://gateway.example",
      deps: { graphAuth: { token: async () => "test-graph-token" }, eventStore: { list: () => [subscription] }, createGraphEvents: () => graph } });
  t.after(() => recovered.current.stop());
  const legacy = () => getDb().prepare("SELECT * FROM inbound_events WHERE namespace = ? AND event_id = ?")
    .get(`msteams-graph-dispatch:${appId}`, inbound.raw.eventId);
  assert.equal(legacy().conversation_id, JSON.stringify([`teams:${nativeId}`, "legacy-root"]));
  const status = mentioned(appId, nativeId, "legacy-root", "/status");
  await recovered.current.handler(request(appId, status), response());
  await until(() => row(appId, status, true)?.status === "done");
  assert.ok(recovered.posted.some(payload => /1 active\/queued request/.test(payload.text)));
  const stop = mentioned(appId, nativeId, "legacy-root", "/stop");
  await recovered.current.handler(request(appId, stop), response());
  await until(() => row(appId, stop, true)?.status === "done");
  assert.equal(legacy().status, "done");
  assert.ok(recovered.posted.some(payload => /Stop requested/.test(payload.text)));
  assert.equal(held.seen.length, 4);
  held.finish();
  await until(() => busyBodies.every(body => row(busyApp, body)?.status === "done"));
});

test("native command state pending callbacks recheck current guest grants after the card was opened", async t => {
  const appId = randomUUID(), held = heldRuns();
  let nativeState;
  const { current } = await integratedTransport(appId, held.run, {
    onCommand: async args => {
      if (args.message.text !== "/model") return false;
      nativeState = args;
      return true;
    },
  });
  t.after(async () => { held.finish(); await current.stop(); });
  const nativeId = `19:${randomUUID()}`, first = mentioned(appId, nativeId, "root");
  await current.handler(request(appId, first), response());
  await until(() => held.seen.length === 1);
  const entry = await getChannelEntry(`teams:${nativeId}`);
  await patchChannelMeta(entry.slug, () => ({ allowedUsers: ["29:temporary-guest"] }));
  const guest = mentioned(appId, nativeId, "root", "guest queued prompt", "29:temporary-guest");
  await current.handler(request(appId, guest), response());
  const open = mentioned(appId, nativeId, "root", "/model");
  await current.handler(request(appId, open), response());
  await until(() => Boolean(nativeState));
  const scope = { conversationId: `teams:${nativeId}`, sessionKey: "root" };
  assert.equal((await nativeState.pendingForSession(scope)).count, 1);
  await patchChannelMeta(entry.slug, () => ({ allowedUsers: [] }));
  assert.equal((await nativeState.pendingForSession(scope)).count, 0, "the native state must not retain its opening guest authorization");
  const stop = mentioned(appId, nativeId, "root", "/stop");
  await current.handler(request(appId, stop), response());
  await until(() => row(appId, stop, true)?.status === "done" && row(appId, first)?.status === "done");
  assert.equal(row(appId, guest)?.status, "done");
  assert.equal(held.seen.length, 1);
});

test("legacy queued Graph Stop recovers into the control lane while four normal turns are running", async t => {
  const appId = randomUUID(), held = heldRuns();
  const original = await integratedTransport(appId, held.run);
  t.after(async () => { held.finish(); await original.current.stop(); });
  const nativeId = `19:${randomUUID()}`;
  const active = Array.from({ length: 4 }, (_, i) => mentioned(appId, nativeId, `root-${i}`));
  // Start the target session last: dispatch order is independent of the native root identity.
  for (const body of [...active].reverse()) {
    await original.current.handler(request(appId, body), response());
    await until(() => held.seen.some(run => run.threadKey === body.conversation.id.split(';messageid=')[1]));
  }
  await until(() => held.seen.length === 4);
  await original.current.stop();
  const legacyActivity = { ...active[0], id: randomUUID(), type: "messageReaction", replyToId: active[0].id, reactionsAdded: [{ type: "stop_sign" }] };
  const inbound = normalizeActivity(legacyActivity, { botId: `28:${appId}` });
  inbound.raw.eventId = `legacy-control:${legacyActivity.id}`;
  const subscription = { conversationId: `teams:${nativeId}`, startedAt: "fixture-start",
    context: { conversation: { id: nativeId, conversationType: "channel" }, serviceUrl: SERVICE } };
  getDb().prepare("INSERT INTO inbound_events(namespace,event_id,conversation_id,status,created_ms,owner,data) VALUES(?,?,?,'queued',?,'',?)")
    .run(`msteams-graph-dispatch:${appId}`, inbound.raw.eventId, inbound.raw.eventId, Date.now(), toJson({ inbound, serviceUrl: SERVICE, subscription }));
  const uncertainActivity = { ...active[1], id: randomUUID(), type: "messageReaction", replyToId: active[1].id, reactionsAdded: [{ type: "stop_sign" }] };
  const uncertain = normalizeActivity(uncertainActivity, { botId: `28:${appId}` });
  uncertain.raw.eventId = `legacy-running-control:${uncertainActivity.id}`;
  getDb().prepare("INSERT INTO inbound_events(namespace,event_id,conversation_id,status,created_ms,owner,data) VALUES(?,?,?,'running',?,'previous-process',?)")
    .run(`msteams-graph-dispatch:${appId}`, uncertain.raw.eventId, uncertain.raw.eventId, Date.now(), toJson({ inbound: uncertain, serviceUrl: SERVICE, subscription }));
  const graph = { start() {}, async stop() {}, async refresh(row) { return row; }, async ensure() {}, handle() {} };
  const recovered = await transport(appId, original.ingest, { allMessageEvents: true, tenantId: "fixture-tenant", publicUrl: "https://gateway.example",
    deps: { connector: original.connector, graphAuth: { token: async () => "test-graph-token" }, eventStore: { list: () => [subscription] }, createGraphEvents: () => graph } });
  t.after(() => recovered.stop());
  const control = () => getDb().prepare("SELECT status FROM inbound_events WHERE namespace = ? AND event_id = ?")
    .get(`msteams-graph-controls:${appId}`, inbound.raw.eventId);
  await until(() => control()?.status === "done" && row(appId, active[0])?.status === "done");
  const uncertainRow = () => getDb().prepare("SELECT status FROM inbound_events WHERE namespace = ? AND event_id = ?")
    .get(`msteams-graph-dispatch:${appId}`, uncertain.raw.eventId);
  await until(() => uncertainRow()?.status === "done");
  assert.equal(getDb().prepare("SELECT 1 FROM inbound_events WHERE namespace = ? AND event_id = ?")
    .get(`msteams-graph-controls:${appId}`, uncertain.raw.eventId), undefined, "ambiguous running controls must receive an interruption notice, never a new control dispatch");
  assert.equal(held.seen.find(run => run.threadKey === "root-0").signal.aborted, true);
  assert.ok(held.seen.filter(run => run.threadKey !== "root-0").every(run => !run.signal.aborted));
  assert.ok(original.posted.some(payload => /Stop requested/.test(payload.text)));
  assert.ok(active.slice(1).every(body => row(appId, body)?.status === "running"));
  held.finish();
  await until(() => active.every(body => row(appId, body)?.status === "done"));
});
