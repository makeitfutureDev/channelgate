// Admin approvals API (GET /api/approvals, POST /api/approvals/:id, POST
// /api/approvals/thread-choice/:id) — the surface that lets an approval be resolved WITHOUT a real
// Slack client click, which is what previously blocked automation and QA.
//
// Hermetic: it boots the real Express app on an ephemeral loopback port against a scratch gateway
// dir, and raises real approvals through requestApproval() with a fake Slack client — no engine and
// no Slack socket. The point of the file is PARITY: the same request resolved through the API and
// through the Slack button must produce the same decision, the same channel/thread state and the
// same card, differing only in the principal.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
delete process.env.ADMIN_PASSWORD;

const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { hashPassword } = await import("../src/web/security.js");
const { createWebApp } = await import("../src/web/app.js");
const { requestApproval, handleApprovalClick, setApprovalClient, setDurableApprovalExecutor } = await import("../src/slack/approvals.js");
const { busyThreadChoices, applyBusyThreadChoice } = await import("../src/slack/busy-thread-choice.js");
const { readEvents } = await import("../src/util/logger.js");

const PASSWORD = "approvals-api-password";
const SLUG = "approvals-api";
const CHANNEL = "C_APPROVALS_API";
const ADMIN = "U_AA_ADMIN";
const MEMBER = "U_AA_MEMBER";

await setUser(ADMIN, { name: "AA Admin", approved: true, isAdmin: true });
await setUser(MEMBER, { name: "AA Member", approved: true, isAdmin: false });
await upsertChannelEntry(CHANNEL, { name: SLUG, type: "channel", isDM: false });
await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), channelId: CHANNEL, access: "approved", autoMode: false, adminMode: false, approvedTools: [] });
saveSettings({ adminPassword: await hashPassword(PASSWORD) });

// Fake Slack client: records the card it posts and every edit made to it.
const posted = [];
const updates = [];
const client = {
  chat: {
    postMessage: async (payload) => {
      posted.push(payload);
      return { ts: `1900.${posted.length}` };
    },
    postEphemeral: async () => {},
    update: async (payload) => updates.push(payload),
    delete: async () => {},
  },
};
setApprovalClient(client);

const app = createWebApp({ slack: { snapshot: () => ({ status: "connected", connected: true }), getClient: () => client } });
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const login = await fetch(`${base}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: PASSWORD }),
});
const cookie = login.headers.get("set-cookie").split(";", 1)[0];

const get = (path, headers = {}) => fetch(base + path, { headers });
const post = (path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
const admin = (path, body) => post(path, body, { cookie, "x-cg-request": "1" });

const tick = () => new Promise((r) => setImmediate(r));
const cardId = () => posted.at(-1).blocks.find((b) => b.type === "actions").elements[0].value;

// Raise one real permission approval and return its id (the card is posted, the promise pends).
async function raise(threadKey, toolName = "Bash", toolInput = { command: "npm test" }) {
  const pending = requestApproval(null, { channelId: CHANNEL, slug: SLUG, authorId: MEMBER, threadKey, toolName, toolInput });
  await tick();
  return { pending, id: cardId() };
}

test("every route needs an admin session, and a state-changing one needs the CSRF header", async () => {
  assert.equal((await get("/api/approvals")).status, 401);
  assert.equal((await post("/api/approvals/whatever", { decision: "deny" })).status, 401);
  assert.equal((await post("/api/approvals/thread-choice/whatever", { choice: "cancel" })).status, 401);

  const { pending, id } = await raise("2.001");
  const noCsrf = await post(`/api/approvals/${id}`, { decision: "deny" }, { cookie });
  assert.equal(noCsrf.status, 403);
  assert.match((await noCsrf.json()).error, /X-CG-Request/i);
  // Refused before any decision was applied — the request is still pending and still resolvable.
  assert.equal((await admin(`/api/approvals/${id}`, { decision: "deny" })).status, 200);
  assert.equal((await pending).allow, false);
});

test("GET /api/approvals lists what is waiting, with names and no internal state", async () => {
  const { pending, id } = await raise("2.002", "Bash", { command: "rm -rf build" });
  const body = await (await get("/api/approvals", { cookie })).json();
  const row = body.approvals.find((a) => a.id === id);
  assert.ok(row, "the pending approval is listed");
  assert.equal(row.kind, "permission");
  assert.equal(row.channelId, CHANNEL);
  assert.equal(row.channelName, SLUG);
  assert.equal(row.requesterId, MEMBER);
  assert.equal(row.requesterName, "AA Member");
  assert.equal(row.tool, "Bash");
  assert.equal(row.threadKey, "2.002");
  assert.deepEqual(row.scopes, ["once", "thread", "forever"]);
  assert.match(row.createdAt, /^\d{4}-/);
  assert.ok(Date.parse(row.expiresAt) > Date.parse(row.createdAt), "a volatile card advertises its expiry");
  assert.equal(body.count, body.approvals.length + body.threadChoices.length);
  // The list is a summary, never the machinery: no continuation, no durable action record.
  for (const leaky of ["finish", "action", "workDir", "runKey"]) {
    assert.equal(row[leaky], undefined, `${leaky} must not be served`);
  }
  await admin(`/api/approvals/${id}`, { decision: "deny" });
  await pending;
});

test("approve/deny resolve the waiting run exactly as a click does, and say who decided", async () => {
  const approved = await raise("2.003");
  const okRes = await admin(`/api/approvals/${approved.id}`, { decision: "approve" });
  assert.equal(okRes.status, 200);
  const okBody = await okRes.json();
  assert.equal(okBody.ok, true);
  assert.equal(okBody.decision, "approve");
  assert.equal(okBody.scope, "once");
  assert.equal(okBody.resolvedBy, "admin UI");
  const decision = await approved.pending;
  assert.equal(decision.allow, true);
  assert.match(decision.reason, /Approved by the admin UI/);
  // The waiting agent is told a real principal, not a blank that reads like a timeout.
  assert.equal(decision.decidedBy, "admin UI");
  assert.match(JSON.stringify(updates.at(-1)), /Approved by the admin UI/);

  const denied = await raise("2.004");
  await admin(`/api/approvals/${denied.id}`, { decision: "deny" });
  const refusal = await denied.pending;
  assert.equal(refusal.allow, false);
  assert.match(refusal.reason, /Denied by the admin UI/);
});

test("scope thread and scope forever carry the same meaning they do on the buttons", async () => {
  const threadScoped = await raise("2.005", "WebFetch");
  await admin(`/api/approvals/${threadScoped.id}`, { decision: "approve", scope: "thread" });
  assert.equal((await threadScoped.pending).allow, true);
  // The thread allow-list is what makes a multi-step task stop re-asking: the next identical
  // request in the same thread resolves with no card at all.
  const cardsBefore = posted.length;
  const again = await requestApproval(null, { channelId: CHANNEL, slug: SLUG, authorId: MEMBER, threadKey: "2.005", toolName: "WebFetch", toolInput: {} });
  assert.equal(again.allow, true);
  assert.match(again.reason, /pre-approved for this thread/);
  assert.equal(posted.length, cardsBefore, "a thread-approved tool posts no second card");

  const forever = await raise("2.006", "Grep");
  await admin(`/api/approvals/${forever.id}`, { decision: "approve", scope: "forever" });
  assert.equal((await forever.pending).allow, true);
  assert.ok((await getChannelMeta(SLUG)).approvedTools.includes("Grep"), "forever persists to meta.approvedTools");
});

test("unknown id → 404, a second resolution → 409, a malformed decision → 400", async () => {
  assert.equal((await admin("/api/approvals/does-not-exist", { decision: "deny" })).status, 404);

  const { pending, id } = await raise("2.007");
  assert.equal((await admin(`/api/approvals/${id}`, { decision: "approve" })).status, 200);
  await pending;
  const replay = await admin(`/api/approvals/${id}`, { decision: "approve" });
  assert.equal(replay.status, 409);
  assert.match((await replay.json()).error, /already resolved/i);

  const bad = await raise("2.008");
  assert.equal((await admin(`/api/approvals/${bad.id}`, { decision: "maybe" })).status, 400);
  assert.equal((await admin(`/api/approvals/${bad.id}`, { decision: "approve", scope: "everywhere" })).status, 400);
  await admin(`/api/approvals/${bad.id}`, { decision: "deny" });
  await bad.pending;
});

test("an API resolution and a Slack click leave identical state, and differ only in the principal", async () => {
  const viaApi = await raise("2.100", "Read");
  await admin(`/api/approvals/${viaApi.id}`, { decision: "approve", scope: "thread" });
  const apiDecision = await viaApi.pending;
  const apiCard = updates.at(-1);

  const viaClick = await raise("2.101", "Read");
  await handleApprovalClick({
    ack: async () => {},
    body: { user: { id: ADMIN }, channel: { id: CHANNEL }, message: { ts: posted.at(-1).ts } },
    action: { action_id: "cg_approve_thread", value: viaClick.id },
    client,
  });
  const clickDecision = await viaClick.pending;
  const clickCard = updates.at(-1);

  assert.equal(apiDecision.allow, clickDecision.allow);
  assert.equal(apiCard.text, clickCard.text);
  const normalize = (blocks, who) => JSON.stringify(blocks).replaceAll(who, "<DECIDER>");
  assert.equal(
    normalize(apiCard.blocks, "the admin UI"),
    normalize(clickCard.blocks, `<@${ADMIN}>`),
    "both paths render the same outcome card",
  );
});

test("a durable background-shell approval executes once through the API and cannot be replayed", async () => {
  const started = [];
  setDurableApprovalExecutor(async (record) => {
    started.push(record.action?.command);
    return { ok: true, id: "job-api-1", label: "durable api job" };
  });
  const decision = await requestApproval(null, {
    channelId: CHANNEL,
    slug: SLUG,
    authorId: ADMIN,
    threadKey: "2.200",
    toolName: "Background shell job (unsandboxed)",
    toolInput: { details: "$ echo durable-api" },
    approvalType: "agent",
    requiredTier: "admin",
    approveText: "Run it",
    durableAction: {
      kind: "background_shell",
      channelId: CHANNEL,
      slug: SLUG,
      authorId: ADMIN,
      threadKey: "2.200",
      command: "echo durable-api",
      label: "durable api job",
      maxMs: 60_000,
    },
  });
  assert.equal(decision.pending, true);
  const id = decision.approvalId;

  const listed = (await (await get("/api/approvals", { cookie })).json()).approvals.find((a) => a.id === id);
  assert.equal(listed.kind, "background_shell");
  assert.equal(listed.durable, true);
  assert.equal(listed.requiredTier, "admin");
  assert.equal(listed.expiresAt, null, "a durable approval never expires — that is the point of it");
  assert.deepEqual(listed.scopes, ["once"], "there is no thread/forever scope for a one-shot action");

  const res = await admin(`/api/approvals/${id}`, { decision: "approve" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).jobId, "job-api-1");
  assert.deepEqual(started, ["echo durable-api"]);

  const replay = await admin(`/api/approvals/${id}`, { decision: "approve" });
  assert.equal(replay.status, 409);
  assert.deepEqual(started, ["echo durable-api"], "the exact action never runs twice");
  setDurableApprovalExecutor(null);
});

test("every resolution writes an approval_resolved_by_admin event naming the principal, never a value", async () => {
  const { pending, id } = await raise("2.300", "Bash", { command: "curl https://example.test/secret-token" });
  await admin(`/api/approvals/${id}`, { decision: "deny" });
  await pending;
  const event = readEvents({ limit: 50 }).find((e) => e.event === "approval_resolved_by_admin" && e.approvalId === id);
  assert.ok(event, "the resolution is auditable");
  assert.equal(event.principal, "admin UI");
  assert.equal(event.decision, "deny");
  assert.equal(event.channel, CHANNEL);
  assert.equal(event.author, MEMBER);
  assert.equal(event.tool, "Bash");
  assert.doesNotMatch(JSON.stringify(event), /secret-token/, "the audit row records the decision, never the value");
});

test("busy-thread cards: cancel drops the waiting message; unknown and claimed ids refuse", async () => {
  assert.equal((await admin("/api/approvals/thread-choice/nope", { choice: "cancel" })).status, 404);
  const choiceId = busyThreadChoices.create({
    event: { channel: CHANNEL, user: MEMBER, ts: "2.400", text: "and also check the logs" },
    options: {},
  });
  const listed = (await (await get("/api/approvals", { cookie })).json()).threadChoices.find((c) => c.id === choiceId);
  assert.ok(listed, "the busy-thread card is listed beside the approvals");
  assert.equal(listed.requesterId, MEMBER);
  assert.deepEqual(listed.choices, ["steer", "queue", "cancel"]);

  assert.equal((await admin(`/api/approvals/thread-choice/${choiceId}`, { choice: "sideways" })).status, 400);
  const res = await admin(`/api/approvals/thread-choice/${choiceId}`, { choice: "cancel" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).cancelled, true);
  assert.equal(busyThreadChoices.take(choiceId, MEMBER).ok, false, "the row is gone, so no click can resurrect it");
  assert.equal((await admin(`/api/approvals/thread-choice/${choiceId}`, { choice: "cancel" })).status, 404);
});

test("steer re-enters the message pipeline with the exact stored event", async () => {
  const event = { channel: CHANNEL, user: MEMBER, ts: "2.500", text: "actually, do the other thing" };
  const choiceId = busyThreadChoices.create({ event, options: { botUserId: "U_BOT" } });
  const seen = [];
  const claimed = busyThreadChoices.takeAsAdmin(choiceId);
  assert.equal(claimed.ok, true);
  const result = await applyBusyThreadChoice({
    choiceId,
    record: claimed.record,
    choice: "steer",
    client,
    channel: CHANNEL,
    messageTs: "1900.1",
    processMessage: async (replayed, _client, options) => {
      seen.push({ replayed, options });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.choice, "steer");
  assert.deepEqual(seen[0].replayed, event);
  assert.equal(seen[0].options.busyChoice, "steer");
  assert.equal(seen[0].options.botUserId, "U_BOT", "the stored options ride along unchanged");
  busyThreadChoices.discard(choiceId);
});
