// Link-based approvals — the platform-neutral form of an approval card.
//
// Hermetic: the real Express app on an ephemeral loopback port against a scratch gateway dir, real
// approvals raised through requestApproval() with a fake Slack client. No engine, no Slack socket.
//
// What this file pins, and why each one is load-bearing:
//   • the token is signed — an edited scope/expiry/id is rejected, and a link works exactly once
//   • GET decides NOTHING (Slack/Teams/proxies prefetch links; a GET with a side effect would let
//     the unfurler approve the request before a human ever saw it)
//   • POST resolves through the same applier the Slack button uses — same card, same decision,
//     same channel state, differing only in the principal
//   • the links reach the requester PRIVATELY (ephemeral), never the shared thread
//   • a busy-thread card is answerable the same way, and names its conversation by slug
//   • bad tokens are rate-limited per REAL client, not per proxy hop
//   • the `approvalLinks` setting's three values do what they say
import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
delete process.env.ADMIN_PASSWORD;

const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { createWebApp } = await import("../src/web/app.js");
const { createApprovalLinkRouter } = await import("../src/web/routes/approve.js");
const { requestApproval, handleApprovalClick, setApprovalClient, listPendingApprovals } = await import("../src/slack/approvals.js");
const { busyThreadChoices, deliverBusyThreadChoiceLinks } = await import("../src/slack/busy-thread-choice.js");
const {
  mintApprovalLinkToken,
  verifyApprovalLinkToken,
  approvalLinkBase,
  approvalLinkUrl,
  APPROVAL_LINK_TTL_MS,
} = await import("../src/web/approval-links.js");
const { clientKey, createLoginLimiter } = await import("../src/web/security.js");
const { readEvents } = await import("../src/util/logger.js");

const SLUG = "approval-links";
const CHANNEL = "C_APPROVAL_LINKS";
const ADMIN = "UALADMIN";
const MEMBER = "UALMEMBER";

await setUser(ADMIN, { name: "AL Admin", approved: true, isAdmin: true });
await setUser(MEMBER, { name: "AL Member", approved: true, isAdmin: false });
await upsertChannelEntry(CHANNEL, { name: SLUG, type: "channel", isDM: false });
await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), channelId: CHANNEL, access: "approved", autoMode: false, adminMode: false, approvedTools: [] });

// Fake Slack client: records the card, every edit, and every ephemeral. `postEphemeral` is the
// delivery channel under test, so it is recorded separately from the shared-thread posts.
const posted = [];
const updates = [];
const ephemerals = [];
const dms = [];
const client = {
  chat: {
    postMessage: async (payload) => {
      // A DM opened through conversations.open posts here too; keep the two apart by channel id.
      if (payload.channel === "D_AL_DM") dms.push(payload);
      else posted.push(payload);
      return { ts: `1800.${posted.length}` };
    },
    postEphemeral: async (payload) => {
      ephemerals.push(payload);
      return { message_ts: `1801.${ephemerals.length}` };
    },
    update: async (payload) => updates.push(payload),
    delete: async () => {},
  },
  conversations: { open: async () => ({ channel: { id: "D_AL_DM" } }) },
};
setApprovalClient(client);

const app = createWebApp({ slack: { snapshot: () => ({ status: "connected", connected: true }), getClient: () => client } });
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

// The links must point at THIS server, so the settings' public URL is the test server's own base.
saveSettings({ publicUrl: base, approvalLinks: "auto", aiTestingUsers: [ADMIN, MEMBER] });

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};
const cardId = () => posted.at(-1).blocks.find((b) => b.type === "actions").elements[0].value;
const linksIn = (text) => [...String(text || "").matchAll(/• \*(.+?)\* — (\S+)/g)].map((m) => ({ label: m[1], url: m[2] }));
const lastLinks = () => linksIn(ephemerals.at(-1)?.text);
const findLink = (label) => lastLinks().find((l) => l.label.toLowerCase().includes(label.toLowerCase()))?.url || "";

// Raise one real permission approval; the card is posted, the promise pends, the links are sent.
async function raise(threadKey, toolName = "Bash", toolInput = { command: "npm test" }, authorId = MEMBER) {
  const pending = requestApproval(null, { channelId: CHANNEL, slug: SLUG, authorId, threadKey, toolName, toolInput });
  await settle();
  return { pending, id: cardId() };
}

// ── The token itself ────────────────────────────────────────────────────────────

test("a token is signed over id, action, scope and expiry — editing any of them invalidates it", () => {
  const minted = mintApprovalLinkToken({ id: "abc-123", action: "approve", scope: "once" });
  const ok = verifyApprovalLinkToken(minted.token);
  assert.equal(ok.ok, true);
  assert.equal(ok.claims.id, "abc-123");
  assert.equal(ok.claims.action, "approve");
  assert.equal(ok.claims.scope, "once");
  assert.equal(ok.claims.nonce, minted.nonce);

  // Promoting "approve once" to "approve forever" by editing the URL is the whole reason the
  // scope is inside the signature.
  const promoted = minted.token.replace(".approve.once.", ".approve.forever.");
  assert.notEqual(promoted, minted.token);
  assert.equal(verifyApprovalLinkToken(promoted).reason, "bad-signature");
  // …as is pointing a valid link at somebody else's approval, or stretching its expiry.
  assert.equal(verifyApprovalLinkToken(minted.token.replace("abc-123", "abc-124")).reason, "bad-signature");
  assert.equal(verifyApprovalLinkToken(`${minted.token}x`).reason, "bad-signature");
  // …and turning the one link a bystander is allowed to have into the opposite decision.
  const refusal = mintApprovalLinkToken({ id: "abc-123", action: "deny", scope: "" });
  assert.equal(verifyApprovalLinkToken(refusal.token).ok, true);
  assert.equal(verifyApprovalLinkToken(refusal.token.replace(".deny.", ".approve.")).reason, "bad-signature");

  // Shape guards come before any crypto work.
  assert.equal(verifyApprovalLinkToken("").reason, "malformed");
  assert.equal(verifyApprovalLinkToken("not-a-token").reason, "malformed");
  assert.equal(verifyApprovalLinkToken(`x/${minted.token}`).reason, "malformed");
  assert.equal(verifyApprovalLinkToken("a".repeat(500)).reason, "malformed");

  // A token signed with a different secret is not ours.
  const foreign = mintApprovalLinkToken({ id: "abc-123", action: "approve", scope: "once", secret: "some-other-daemon" });
  assert.equal(verifyApprovalLinkToken(foreign.token).reason, "bad-signature");
});

test("a token expires, and the expiry is the one inside the signature", () => {
  const past = mintApprovalLinkToken({ id: "expired-1", action: "deny", expiresAt: Date.now() - 1_000 });
  const verified = verifyApprovalLinkToken(past.token);
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, "expired");
  // Still readable — the router needs the claims to say WHICH kind of dead end this is.
  assert.equal(verified.claims.id, "expired-1");
  // The default TTL is the ceiling every link gets, durable approvals included.
  const fresh = mintApprovalLinkToken({ id: "fresh-1", action: "deny" });
  const ttl = verifyApprovalLinkToken(fresh.token).claims.expiresAt - Date.now();
  assert.ok(ttl > 0 && ttl <= APPROVAL_LINK_TTL_MS + 1_000, `default TTL is bounded (got ${ttl}ms)`);
});

test("a link URL is built only from an http(s) base, and always lands on /approve/<token>", () => {
  const { token } = mintApprovalLinkToken({ id: "url-1", action: "deny" });
  assert.equal(approvalLinkUrl("https://gw.example/", token), `https://gw.example/approve/${token}`);
  assert.equal(approvalLinkUrl("https://gw.example/base", token), `https://gw.example/base/approve/${token}`);
  assert.equal(approvalLinkUrl("javascript:alert(1)", token), "");
  assert.equal(approvalLinkUrl("https://user:pw@gw.example", token), "");
  assert.equal(approvalLinkUrl("", token), "");
});

// ── Delivery ────────────────────────────────────────────────────────────────────

test("the links go to the requester in an ephemeral, never into the shared thread", async () => {
  const before = posted.length;
  const { pending, id } = await raise("3.001");
  assert.equal(ephemerals.length > 0, true, "an ephemeral was sent");
  const ephemeral = ephemerals.at(-1);
  assert.equal(ephemeral.user, MEMBER, "addressed to the person who raised the request");
  assert.equal(ephemeral.channel, CHANNEL);
  assert.equal(dms.length, 0, "an ephemeral succeeded, so no DM fallback");
  // Exactly one shared-thread message (the card). The links never appear in it.
  assert.equal(posted.length, before + 1, "no second public message");
  assert.doesNotMatch(JSON.stringify(posted.at(-1)), /\/approve\//, "the card carries no link");

  const links = lastLinks();
  assert.deepEqual(links.map((l) => l.label), ["Approve once", "Approve for this thread", "Deny"]);
  // "Approve forever" changes the channel's posture — admins only, on a link exactly as on the
  // button, and the requester here is not an admin.
  assert.equal(links.some((l) => /forever/i.test(l.label)), false);
  for (const link of links) assert.ok(link.url.startsWith(`${base}/approve/`), link.url);
  assert.match(ephemeral.text, /works once/i);
  assert.match(ephemeral.text, /Only you can see this message/i);
  // Every link is for THIS approval.
  for (const link of links) {
    assert.equal(verifyApprovalLinkToken(link.url.split("/approve/")[1]).claims.id, id);
  }

  await fetch(findLink("Deny"), { method: "POST" });
  assert.equal((await pending).allow, false);
});

test("an admin requester also gets the forever link; a tiered request gets deny only", async () => {
  const asAdmin = await raise("3.002", "Grep", { pattern: "x" }, ADMIN);
  assert.deepEqual(lastLinks().map((l) => l.label), ["Approve once", "Approve for this thread", "Approve forever (this channel)"]
    .concat(["Deny"]));
  await fetch(findLink("Deny"), { method: "POST" });
  await asAdmin.pending;

  // An admin-tier control-plane sign-off must get its human factor from someone who could have
  // authorized it themselves — never from the requester. So no approve link is minted at all.
  const tiered = requestApproval(null, {
    channelId: CHANNEL,
    slug: SLUG,
    authorId: MEMBER,
    threadKey: "3.003",
    toolName: "set_license_key",
    toolInput: { details: "change the licence" },
    approvalType: "agent",
    requiredTier: "admin",
  });
  await settle();
  assert.deepEqual(lastLinks().map((l) => l.label), ["Deny"], "a non-admin requester may only refuse");
  await fetch(findLink("Deny"), { method: "POST" });
  assert.equal((await tiered).allow, false);
});

// ── GET is inert ────────────────────────────────────────────────────────────────

test("GET renders the request and leaves the card pending; only POST decides", async () => {
  const { pending, id } = await raise("3.010", "Bash", { command: "rm -rf build" });
  const url = findLink("Approve once");

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") || "", /text\/html/);
  assert.match(page.headers.get("cache-control") || "", /no-store/);
  assert.match(page.headers.get("x-robots-tag") || "", /noindex/);
  const html = await page.text();
  assert.match(html, /Approval requested/);
  assert.match(html, /rm -rf build/, "the page shows what is being approved");
  assert.match(html, /AL Member/, "and who asked");
  assert.match(html, /This link performs: Approve once/);
  assert.match(html, /<form method="post"/, "the decision needs a form submission");
  // A relative action, so the page survives a reverse proxy that mounts the gateway under a prefix.
  assert.match(html, new RegExp(`action="${url.split("/approve/")[1].replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}"`));
  assert.doesNotMatch(html, /<script/i, "the confirmation page runs no script at all");

  // Nothing moved. A prefetching unfurler could have fetched that page a dozen times.
  await fetch(url);
  await fetch(url);
  assert.ok(listPendingApprovals().some((a) => a.id === id), "still waiting on a human");
  assert.equal(updates.length, 0 || updates.length, "no card edit is implied by a GET");
  const stillPending = await Promise.race([pending, Promise.resolve("pending")]);
  assert.equal(stillPending, "pending");

  // …and the very same link still works when the person actually presses Confirm.
  const done = await fetch(url, { method: "POST" });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Approved/);
  const decision = await pending;
  assert.equal(decision.allow, true);
  assert.equal(decision.decidedBy, "link");
});

test("a link works exactly once, and every other link for that card dies with it", async () => {
  const { pending, id } = await raise("3.011");
  const approve = findLink("Approve once");
  const deny = findLink("Deny");

  assert.equal((await fetch(approve, { method: "POST" })).status, 200);
  assert.equal((await pending).allow, true);

  const replay = await fetch(approve, { method: "POST" });
  assert.equal(replay.status, 410);
  assert.match(await replay.text(), /already used/i);
  // The sibling "Deny" link was never used — but the request is decided, so it is dead too.
  const sibling = await fetch(deny, { method: "POST" });
  assert.equal(sibling.status, 410);
  // A GET on a spent link is the same dead end, and still decides nothing.
  assert.equal((await fetch(approve)).status, 410);
  assert.equal(listPendingApprovals().some((a) => a.id === id), false);
});

test("scope thread and scope forever mean on a link what they mean on the button", async () => {
  const threadScoped = await raise("3.020", "WebFetch");
  assert.equal((await fetch(findLink("Approve for this thread"), { method: "POST" })).status, 200);
  assert.equal((await threadScoped.pending).allow, true);
  const cardsBefore = posted.length;
  const again = await requestApproval(null, { channelId: CHANNEL, slug: SLUG, authorId: MEMBER, threadKey: "3.020", toolName: "WebFetch", toolInput: {} });
  assert.equal(again.allow, true);
  assert.match(again.reason, /pre-approved for this thread/);
  assert.equal(posted.length, cardsBefore, "a thread-approved tool posts no second card");

  const forever = await raise("3.021", "Glob", { pattern: "*" }, ADMIN);
  assert.equal((await fetch(findLink("forever"), { method: "POST" })).status, 200);
  assert.equal((await forever.pending).allow, true);
  assert.ok((await getChannelMeta(SLUG)).approvedTools.includes("Glob"), "forever persists to meta.approvedTools");
});

test("authority is re-checked at Confirm time, and a refusal does not burn the link", async () => {
  const { pending, id } = await raise("3.030", "Bash", { command: "npm run deploy" }, ADMIN);
  const forever = findLink("forever");
  assert.ok(forever, "an admin requester was offered the forever link");

  // The link was minted while this person was an admin. Take that away and the link stops being
  // honourable — "approve forever" changes the channel's posture and is an admin's call, on a link
  // exactly as on the button.
  await setUser(ADMIN, { name: "AL Admin", approved: true, isAdmin: false });
  const refused = await fetch(forever, { method: "POST" });
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /authority you do not have/i);
  assert.ok(listPendingApprovals().some((a) => a.id === id), "the request is untouched");

  // …and the link itself survives the refusal: a link that could not be honoured must still be
  // there once the reason is fixed, or a transient state would silently destroy a credential.
  await setUser(ADMIN, { name: "AL Admin", approved: true, isAdmin: true });
  assert.equal((await fetch(forever, { method: "POST" })).status, 200);
  assert.equal((await pending).allow, true);
  assert.ok((await getChannelMeta(SLUG)).approvedTools.includes("Bash"));
  // Undo the channel-wide grant this test just made, so later cards still ask.
  await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), approvedTools: [] });
});

// ── Parity with the button ──────────────────────────────────────────────────────

test("a link decision and a click leave identical state, differing only in the principal", async () => {
  const viaLink = await raise("3.100", "Read");
  assert.equal((await fetch(findLink("Approve for this thread"), { method: "POST" })).status, 200);
  const linkDecision = await viaLink.pending;
  const linkCard = updates.at(-1);

  const viaClick = await raise("3.101", "Read");
  await handleApprovalClick({
    ack: async () => {},
    body: { user: { id: MEMBER }, channel: { id: CHANNEL }, message: { ts: posted.at(-1).ts } },
    action: { action_id: "cg_approve_thread", value: viaClick.id },
    client,
  });
  const clickDecision = await viaClick.pending;
  const clickCard = updates.at(-1);

  assert.equal(linkDecision.allow, clickDecision.allow);
  assert.equal(linkCard.text, clickCard.text);
  const normalize = (blocks, who) => JSON.stringify(blocks).replaceAll(who, "<DECIDER>");
  assert.equal(
    normalize(linkCard.blocks, `<@${MEMBER}> (approval link)`),
    normalize(clickCard.blocks, `<@${MEMBER}>`),
    "both paths render the same outcome card",
  );
  // The waiting agent is told HOW the decision arrived, not a user id that would claim a click.
  assert.equal(linkDecision.decidedBy, "link");
  assert.equal(clickDecision.decidedBy, MEMBER);
});

test("every link decision writes approval_resolved_by_link — ids and the decision, never a value", async () => {
  const { pending, id } = await raise("3.110", "Bash", { command: "curl https://example.test/link-secret-token" });
  await fetch(findLink("Deny"), { method: "POST" });
  await pending;
  const event = readEvents({ limit: 80 }).find((e) => e.event === "approval_resolved_by_link" && e.approvalId === id);
  assert.ok(event, "the resolution is auditable");
  assert.equal(event.principal, "link");
  assert.equal(event.decision, "deny");
  assert.equal(event.channel, CHANNEL);
  assert.equal(event.author, MEMBER);
  assert.equal(event.tool, "Bash");
  assert.doesNotMatch(JSON.stringify(event), /link-secret-token/, "the audit row records the decision, never the value");
});

// ── Busy-thread cards ───────────────────────────────────────────────────────────

test("a busy-thread card is answerable by link, and cancel drops the waiting message", async () => {
  const event = { channel: CHANNEL, user: MEMBER, ts: "3.200", text: "and also check the logs" };
  const choiceId = busyThreadChoices.create({ event, options: {} });
  await deliverBusyThreadChoiceLinks(client, choiceId, { channelId: CHANNEL, threadTs: "3.200", userId: MEMBER });
  const links = lastLinks();
  assert.deepEqual(links.map((l) => l.label), ["Steer Conversation", "Add to Queue", "Cancel Request"]);
  assert.equal(ephemerals.at(-1).user, MEMBER, "only the person whose message is waiting gets them");

  const cancel = links.find((l) => l.label === "Cancel Request").url;
  const page = await fetch(cancel);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Cancel this message/);
  assert.ok(busyThreadChoices.list().some((r) => r.id === choiceId), "GET left the card waiting");

  const done = await fetch(cancel, { method: "POST" });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Done/);
  assert.equal(busyThreadChoices.list().some((r) => r.id === choiceId), false, "the row is gone");
  assert.equal(busyThreadChoices.take(choiceId, MEMBER).ok, false, "no click can resurrect it");
  // The sibling steer link died with the card.
  assert.equal((await fetch(links[0].url, { method: "POST" })).status, 410);
  assert.ok(readEvents({ limit: 40 }).some((e) => e.event === "approval_resolved_by_link" && e.approvalId === choiceId && e.decision === "cancel"));
});

test("a busy-thread link names the conversation by slug, on the page and in the audit row", async () => {
  // The record is built from a raw Slack event, so it carries a channel id and no slug. Without a
  // lookup the page says "C_APPROVAL_LINKS" — a string the person clicking has never seen — and the
  // audit row lands with an empty slug, which is the field every other approval event is queried by.
  const event = { channel: CHANNEL, user: MEMBER, ts: "3.210", text: "one more thing" };
  const choiceId = busyThreadChoices.create({ event, options: {} });
  assert.equal(busyThreadChoices.list().find((r) => r.id === choiceId)?.slug, undefined, "the stored record has no slug");
  await deliverBusyThreadChoiceLinks(client, choiceId, { channelId: CHANNEL, threadTs: "3.210", userId: MEMBER });
  const cancel = lastLinks().find((l) => l.label === "Cancel Request").url;

  const html = await (await fetch(cancel)).text();
  assert.match(html, new RegExp(`<dt>Conversation</dt><dd>${SLUG}</dd>`), "the page names the conversation");
  assert.doesNotMatch(html, new RegExp(CHANNEL), "not the raw channel id");

  assert.equal((await fetch(cancel, { method: "POST" })).status, 200);
  const logged = readEvents({ limit: 40 }).find((e) => e.event === "approval_resolved_by_link" && e.approvalId === choiceId);
  assert.ok(logged, "the resolution is auditable");
  assert.equal(logged.slug, SLUG, "and queryable by conversation, like every permission-card row");
  assert.equal(logged.channel, CHANNEL);
});

// ── Rate limiting ───────────────────────────────────────────────────────────────

test("bad tokens are rate-limited per IP; a valid one is never slowed down", async () => {
  // Its own app + limiter: the shared one is per IP, and every other test in this file comes from
  // the same loopback address.
  const limited = express();
  limited.use("/approve", createApprovalLinkRouter({ slack: { getClient: () => client }, limiter: createLoginLimiter({ freeAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 }) }));
  const listener = await new Promise((resolve) => {
    const instance = limited.listen(0, "127.0.0.1", () => resolve(instance));
  });
  after(() => listener.close());
  const url = (token) => `http://127.0.0.1:${listener.address().port}/approve/${token}`;

  for (let i = 0; i < 3; i++) assert.equal((await fetch(url(`bogus-${i}`))).status, 404);
  const blocked = await fetch(url("bogus-4"));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.match(await blocked.text(), /Too many/i);
  // Even a perfectly good token is refused while the backoff holds — the limiter is about the
  // address, not about the token.
  const { pending, id } = await raise("3.300");
  const good = lastLinks()[0].url.split("/approve/")[1];
  assert.equal((await fetch(url(good))).status, 429);
  assert.equal(verifyApprovalLinkToken(good).claims.id, id);
  await fetch(findLink("Deny"), { method: "POST" });
  await pending;
});

test("the backoff counts the forwarded client, not the loopback proxy hop everyone shares", async () => {
  // The daemon binds 127.0.0.1 and is reached through cloudflared, so `req.ip` is loopback for
  // every caller on earth: keyed on that, a handful of bad tokens from anywhere locks out every
  // legitimate approval link — including one opened from the same machine.
  const proxied = express();
  proxied.use("/approve", createApprovalLinkRouter({ slack: { getClient: () => client }, limiter: createLoginLimiter({ freeAttempts: 2, baseDelayMs: 60_000, maxDelayMs: 60_000 }) }));
  const listener = await new Promise((resolve) => {
    const instance = proxied.listen(0, "127.0.0.1", () => resolve(instance));
  });
  after(() => listener.close());
  const url = (token) => `http://127.0.0.1:${listener.address().port}/approve/${token}`;
  const from = (ip, token, init = {}) => fetch(url(token), { ...init, headers: { "X-Forwarded-For": ip, ...(init.headers || {}) } });

  for (let i = 0; i < 2; i++) assert.equal((await from("203.0.113.5", `bogus-a${i}`)).status, 404);
  assert.equal((await from("203.0.113.5", "bogus-a9")).status, 429, "that client is backing off");
  assert.equal((await from("203.0.113.6", "bogus-b0")).status, 404, "a different client through the same tunnel is untouched");
  // CF-Connecting-IP is written by cloudflared and cannot be prepended to, so it outranks a
  // client-supplied X-Forwarded-For — here one naming the address that IS backing off.
  assert.equal((await from("203.0.113.5", "bogus-c0", { headers: { "CF-Connecting-IP": "198.51.100.7" } })).status, 404);

  // …and a real link still works from an address that never failed, which is the whole point.
  const { pending } = await raise("3.310");
  const good = findLink("Deny").split("/approve/")[1];
  assert.equal((await from("203.0.113.6", good)).status, 200, "GET renders the page");
  assert.equal((await from("203.0.113.6", good, { method: "POST" })).status, 200);
  assert.equal((await pending).allow, false);

  // A non-loopback socket is a client, not a proxy hop, so its header is just a claim — asserted on
  // the helper itself, since a hermetic test cannot open a non-loopback socket to this server.
  assert.equal(clientKey({ socket: { remoteAddress: "198.51.100.9" }, headers: { "x-forwarded-for": "203.0.113.5" } }), "198.51.100.9");
  assert.equal(clientKey({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "203.0.113.5" } }), "203.0.113.5");
});

// ── The setting ─────────────────────────────────────────────────────────────────

test("approvalLinks: off mints nothing, auto needs a public URL on Slack, always falls back to loopback", async () => {
  const slackCaps = { buttons: true, richCards: "block-kit" };
  const textOnly = { buttons: false, richCards: "none" };

  saveSettings({ approvalLinks: "off" });
  assert.equal(approvalLinkBase({ capabilities: slackCaps, requester: MEMBER }), "");
  assert.equal(approvalLinkBase({ capabilities: textOnly }), "");
  const before = ephemerals.length;
  const off = await raise("3.400");
  assert.equal(ephemerals.length, before, "no ephemeral at all while links are off");
  await handleApprovalClick({
    ack: async () => {},
    body: { user: { id: MEMBER }, channel: { id: CHANNEL }, message: { ts: posted.at(-1).ts } },
    action: { action_id: "cg_deny", value: off.id },
    client,
  });
  await off.pending;

  // auto: an addition on a surface that already has working buttons, and only once the operator
  // has said where the gateway is reachable from.
  saveSettings({ approvalLinks: "auto", publicUrl: "" });
  assert.equal(approvalLinkBase({ capabilities: slackCaps, requester: MEMBER }), "");
  // …but on a surface with no buttons to press, links are the only way, so they are built anyway.
  assert.match(approvalLinkBase({ capabilities: textOnly }), /^http:\/\/127\.0\.0\.1:/);
  saveSettings({ publicUrl: "https://gw.example" });
  assert.equal(approvalLinkBase({ capabilities: slackCaps, requester: MEMBER }), "https://gw.example");

  // always: everywhere, loopback included.
  saveSettings({ approvalLinks: "always", publicUrl: "" });
  assert.match(approvalLinkBase({ capabilities: slackCaps, requester: MEMBER }), /^http:\/\/127\.0\.0\.1:/);
  saveSettings({ approvalLinks: "auto", publicUrl: base });
});


test("Slack testing allowlist gates minting and delivery for both card types, including admins and always mode", async () => {
  const { getDb } = await import("../src/db/index.js");
  const countTokens = () => getDb().prepare("SELECT count(*) AS n FROM approval_link_tokens").get().n;
  let thread = 500;
  try {
    for (const mode of ["auto", "always", "off"]) {
      for (const selected of [[], [MEMBER], [ADMIN, MEMBER], []]) {
        saveSettings({ approvalLinks: mode, aiTestingUsers: selected, publicUrl: base });
        for (const authorId of [MEMBER, ADMIN]) {
          const allowed = mode !== "off" && selected.includes(authorId);
          const before = ephemerals.length;
          const tokens = countTokens();
          const approval = await raise(`5.${thread++}`, "Bash", { command: "echo testing" }, authorId);
          assert.equal(ephemerals.length - before, allowed ? 1 : 0, `${mode}: approval for ${authorId}`);
          assert.equal(countTokens() > tokens, allowed, "unlisted recipients mint no bearer tokens");
          assert.ok(posted.at(-1).blocks.some((b) => b.type === "actions"), "native buttons remain available");
          await handleApprovalClick({
            ack: async () => {},
            body: { user: { id: authorId }, channel: { id: CHANNEL }, message: { ts: posted.at(-1).ts } },
            action: { action_id: "cg_deny", value: approval.id }, client,
          });
          assert.equal((await approval.pending).allow, false);
          const busyBefore = ephemerals.length;
          const busyTokens = countTokens();
          const links = await deliverBusyThreadChoiceLinks(client, `testing-${thread++}`, { channelId: CHANNEL, userId: authorId });
          assert.equal(links.length, allowed ? 3 : 0);
          assert.equal(ephemerals.length - busyBefore, allowed ? 1 : 0);
          assert.equal(countTokens() - busyTokens, allowed ? 3 : 0);
          if (allowed) assert.equal(ephemerals.at(-1).user, authorId);
        }
      }
    }
    saveSettings({ approvalLinks: "always", aiTestingUsers: [MEMBER] });
    assert.equal(approvalLinkBase({ capabilities: { buttons: true, richCards: "block-kit" } }), "", "missing requester fails closed");
    saveSettings({ aiTestingUsers: [] });
    assert.equal(approvalLinkBase({ capabilities: { buttons: false, richCards: "none" }, publicUrl: base }), base, "non-native surfaces retain their links");
  } finally {
    saveSettings({ approvalLinks: "auto", publicUrl: base, aiTestingUsers: [ADMIN, MEMBER] });
  }
});
