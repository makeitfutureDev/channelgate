// Hidden secrets with no known destination (2026-09-27): the container gets a placeholder, the proxy
// swaps it in any header or query parameter on servers an admin approved, and the first request to
// any other server is refused (403) while a durable admin approval card is posted. Secrets used
// outside HTTPS (passwords, connection strings, signing keys) stay readable.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { mintPlaceholder } = await import("../src/gateway/egress/placeholders.js");
const rules = await import("../src/gateway/egress/rules.js");
const { rulesFor, secretExposure, exposureReasonText } = await import("../src/gateway/egress/catalog-rules.js");
const { patchChannelEnv, patchEnvEntry, listEnvVars } = await import("../src/config/channel-env.js");
const { engineHostsFor } = await import("../src/gateway/egress/engine-hosts.js");
const liveness = await import("../src/gateway/egress/liveness.js");
const approvals = await import("../src/gateway/secret-host-approvals.js");
const scoped = await import("../src/config/scoped-env.js");
const store = await import("../src/config/store.js");
const { channelCredentialsPreamble } = await import("../src/gateway/channel-credentials.js");

const real = (label) => `real-${label}-${crypto.randomBytes(10).toString("hex")}`;
const swap = (args) => rules.swapRequest({ ...args, headers: { host: args.hostname, ...(args.headers || {}) } });
const allowAll = () => ({ ok: true });

function approvalGrant(overrides = {}) {
  const rule = rulesFor("PAY_API_TOKEN", { approvedHosts: ["api.pay.example"] });
  return {
    placeholder: mintPlaceholder({ scope: "org" }),
    value: real("pay"),
    secretName: "PAY_API_TOKEN",
    scope: "organization",
    owner: null,
    channelId: "",
    hosts: rule.hosts,
    headers: rule.headers,
    query: rule.query,
    format: rule.format,
    approval: true,
    neverHosts: engineHostsFor(),
    ...overrides,
  };
}
const resolverFor = (grant) => (core) => (core === grant.placeholder ? grant : null);

test("kind detection: web tokens are hidden, passwords, connection strings and signing keys readable, an explicit choice wins", () => {
  // When unsure the rule errs HIDDEN (security review, 2026-09-27): web credentials whose names
  // carry SECRET, CLIENT, DB or REDIS words must never come out readable.
  for (const name of ["MAKE_API", "VERCEL_PAY_MAKEITFUTURE", "TRIGGER_ACCESS_TOKEN_DEV", "COMPOSIO_APPS", "MAILGUN_API_KEY", "GITLAB_PRIVATE_TOKEN", "OPENAI_API_KEY", "PASSAGE_TOKEN",
    "STRIPE_SECRET_KEY", "CLERK_SECRET_KEY", "SUPABASE_SECRET_KEY", "API_SECRET_KEY", "API_SECRET", "UPSTASH_REDIS_REST_TOKEN", "REDIS_TOKEN", "TURSO_DB_AUTH_TOKEN",
    "ASTRA_DB_APPLICATION_TOKEN", "IMAGEKIT_PRIVATE_KEY", "GOOGLE_CLIENT_SECRET", "DJANGO_SECRET_KEY"]) {
    assert.equal(secretExposure(name, {}, "abc-123").exposure, "hidden", name);
  }
  for (const name of ["GMAIL_APP_PASSWORD", "SMTP_PASS", "PGPASSWORD", "MYSQL_PWD", "DATABASE_URL", "PG_DSN", "REDIS_URL_X", "STRIPE_WEBHOOK_SECRET", "AWS_SECRET_ACCESS_KEY",
    "R2_SECRET_ACCESS_KEY", "AZURE_STORAGE_KEY", "JWT_SECRET", "SUPABASE_JWT_SECRET", "NEXTAUTH_SECRET", "AUTH_SECRET", "APP_SECRET", "KUBECONFIG", "GOOGLE_APPLICATION_CREDENTIALS"]) {
    assert.equal(secretExposure(name, {}, "abc-123").exposure, "readable", name);
  }
  // Configuration stored beside the secrets is not a credential: its last word says so.
  for (const name of ["VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "GH_REPO", "AWS_REGION", "SMTP_USER", "TWILIO_ACCOUNT_SID", "SENTRY_ORG"]) {
    assert.equal(secretExposure(name, {}, "abc").exposure, "readable", name);
  }
  for (const name of ["ORG_TOKEN", "TEAM_API_KEY", "ID_TOKEN_SECRET_X"]) assert.equal(secretExposure(name, {}, "abc").exposure, "hidden", name);
  // The value's shape: any URL is readable (a program needs the real address to connect at all).
  assert.equal(secretExposure("SUPA", {}, "postgres://u:p@db.example.com/x").exposure, "readable");
  assert.equal(secretExposure("SLACK_HOOK", {}, "https://hooks.slack.com/services/x").exposure, "readable");
  assert.equal(secretExposure("SUPA", {}, "sbp_1234").exposure, "hidden");
  assert.equal(secretExposure("CREDS", {}, "/home/agent/key.json").exposure, "readable", "a file path");
  // Explicit choices. Readable always wins. Hidden wins for a web-looking secret — but a secret whose
  // kind says it is used outside HTTPS (SMTP, database, signing, configuration) stays READABLE when
  // chosen hidden, because a placeholder could never work there (owner ask, 2026-09-27); declaring
  // the domains it is used on is how to hide it anyway.
  assert.equal(secretExposure("MAKE_API", { exposure: "readable" }).exposure, "readable");
  assert.equal(secretExposure("MAKE_API", { exposure: "hidden" }).exposure, "hidden");
  const kept = secretExposure("SMTP_PASSWORD", { exposure: "hidden" });
  assert.deepEqual(kept, { exposure: "readable", reason: "kind", kind: "name" });
  assert.match(exposureReasonText(kept), /kept readable although hidden was chosen: it looks like a password[^\n]*add the domains/);
  assert.equal(rulesFor("GMAIL_APP_PASSWORD", { exposure: "hidden" }), null);
  assert.equal(rulesFor("BITBUCKET_APP_PASSWORD", { exposure: "hidden", hosts: ["api.bitbucket.org"] }).source, "entry", "declared domains hide it anyway");
  assert.equal(rulesFor("GITHUB_TOKEN", { exposure: "readable" }), null, "readable wins even over a catalog rule");
  // Catalog and declared rules are untouched.
  assert.equal(rulesFor("GITHUB_TOKEN", {}).source, "catalog:github");
  assert.equal(rulesFor("MY_KEY", { hosts: ["api.example.com"] }).source, "entry");
});

test("an approved server gets the real value in ANY header or query parameter", () => {
  const grant = approvalGrant();
  for (const headers of [
    { authorization: `Bearer ${grant.placeholder}` },
    { "x-pay-secret": grant.placeholder },
    { authorization: `Basic ${Buffer.from(`${grant.placeholder}:`).toString("base64")}` },
  ]) {
    const out = swap({ headers, path: "/v1", hostname: "api.pay.example", resolveGrant: resolverFor(grant), canUse: allowAll });
    assert.deepEqual(out.refused, [], JSON.stringify(headers));
    assert.equal(out.swapped[0].secretName, "PAY_API_TOKEN");
    assert.ok(JSON.stringify(out.headers).includes(grant.value) || JSON.stringify(out.headers).includes(Buffer.from(`${grant.value}:`).toString("base64")));
  }
  const q = swap({ headers: {}, path: `/v1/charge?api_key=${grant.placeholder}&x=1`, hostname: "api.pay.example", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(q.path, `/v1/charge?api_key=${encodeURIComponent(grant.value)}&x=1`);
  // Only CREDENTIAL-LIKE field names: an ordinary header or parameter a server might store and echo
  // back unscrubbed later never receives the value.
  const plain = swap({ headers: { "user-agent": grant.placeholder, referer: grant.placeholder }, path: `/v1/search?q=${grant.placeholder}`, hostname: "api.pay.example", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(plain.swapped.length, 0);
  assert.ok(!JSON.stringify(plain).includes(grant.value));
  // Never the proxy's own routing fields.
  const proxyAuth = swap({ headers: { "proxy-authorization": grant.placeholder }, path: "/", hostname: "api.pay.example", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(proxyAuth.swapped.length, 0);
});

test("any OTHER server is refused as approval-required — a denial naming the host — and nothing is swapped", () => {
  const grant = approvalGrant();
  const out = swap({ headers: { authorization: `Bearer ${grant.placeholder}` }, path: "/", hostname: "evil.example.net", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(out.swapped.length, 0);
  assert.deepEqual(out.refused, [{ secretName: "PAY_API_TOKEN", reason: "approval-required", denied: true, scope: "organization", owner: null, host: "evil.example.net" }]);
  assert.ok(!JSON.stringify(out.headers).includes(grant.value));
});

test("no approval card for a placeholder that could never be swapped, the engines' own APIs, or a denied grant", async () => {
  const grant = approvalGrant();
  // Embedded in other text: a format refusal, not a denial.
  const embedded = swap({ headers: { "x-note": `token=${grant.placeholder};` }, path: "/", hostname: "evil.example.net", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.deepEqual(embedded.refused.map((r) => [r.reason, Boolean(r.denied)]), [["header", false]], "not a credential field");
  const embeddedAuth = swap({ headers: { authorization: `token=${grant.placeholder};` }, path: "/", hostname: "evil.example.net", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.deepEqual(embeddedAuth.refused.map((r) => [r.reason, Boolean(r.denied)]), [["format", false]], "a credential field, but not a whole-value position");
  // The model APIs: never swapped, never asked about.
  for (const host of ["api.anthropic.com", "api.openai.com", "chatgpt.com"]) {
    const out = swap({ headers: { authorization: `Bearer ${grant.placeholder}` }, path: "/", hostname: host, resolveGrant: resolverFor(grant), canUse: allowAll });
    assert.deepEqual(out.refused.map((r) => [r.reason, Boolean(r.denied)]), [["engine-host", false]], host);
    assert.equal(out.swapped.length, 0);
  }
  // Even a model API an admin somehow approved never receives it.
  const approvedEngine = approvalGrant({ hosts: ["api.anthropic.com"] });
  const out = swap({ headers: { authorization: `Bearer ${approvedEngine.placeholder}` }, path: "/", hostname: "api.anthropic.com", resolveGrant: resolverFor(approvedEngine), canUse: allowAll });
  assert.deepEqual([out.swapped.length, out.refused[0].reason], [0, "engine-host"]);
  // The credential marker and a wildcard are never honoured on an ordinary (declared) grant, and
  // can never be written as a declaration.
  const declared = { ...approvalGrant(), approval: false, headers: ["~credential"], hosts: ["api.pay.example"] };
  assert.equal(swap({ headers: { "x-pay-secret": declared.placeholder }, path: "/", hostname: "api.pay.example", resolveGrant: resolverFor(declared), canUse: allowAll }).swapped.length, 0);
  const { assertValidSwapRuleFields } = await import("../src/gateway/egress/catalog-rules.js");
  assert.throws(() => assertValidSwapRuleFields({ headers: ["*"] }), /not a header/);
  assert.throws(() => assertValidSwapRuleFields({ headers: ["~credential"] }), /not a header/);
  // Another channel's placeholder or an idle channel: that denial wins, no approval is asked.
  const other = swap({ headers: { authorization: `Bearer ${grant.placeholder}` }, path: "/", hostname: "evil.example.net", resolveGrant: resolverFor(grant), canUse: () => ({ ok: false, reason: "other-channel" }) });
  assert.equal(other.refused[0].reason, "other-channel");
});

test("storage: approved servers and the hidden/readable choice survive a value rotation; bad hosts are refused", () => {
  let env = patchChannelEnv({}, { set: { name: "PAY_API_TOKEN", value: "first-value-12345" } });
  env = patchEnvEntry(env, "PAY_API_TOKEN", { addApprovedHost: "API.Pay.Example." });
  env = patchEnvEntry(env, "pay_api_token", { addApprovedHost: "api.pay.example" });
  assert.deepEqual(env.PAY_API_TOKEN.approvedHosts, ["api.pay.example"], "normalized and de-duplicated");
  env = patchEnvEntry(env, "PAY_API_TOKEN", { exposure: "hidden" });
  env = patchChannelEnv(env, { set: { name: "PAY_API_TOKEN", value: "second-value-12345" } });
  assert.deepEqual(env.PAY_API_TOKEN.approvedHosts, ["api.pay.example"]);
  assert.equal(env.PAY_API_TOKEN.exposure, "hidden");
  env = patchEnvEntry(env, "PAY_API_TOKEN", { exposure: "auto" });
  assert.equal(env.PAY_API_TOKEN.exposure, undefined);
  assert.throws(() => patchEnvEntry(env, "PAY_API_TOKEN", { addApprovedHost: "*.pay.example" }), /single host name/);
  assert.throws(() => patchEnvEntry(env, "PAY_API_TOKEN", { addApprovedHost: "10.0.0.1" }), /single host name/);
  assert.throws(() => patchEnvEntry(env, "PAY_API_TOKEN", { exposure: "loud" }), /Unknown exposure/);
  assert.throws(() => patchEnvEntry(env, "NOPE", { exposure: "hidden" }), /not set/);
  const [row] = listEnvVars(env);
  assert.deepEqual({ protected: row.protected, exposure: row.exposure, approval: row.approval, hosts: row.hosts }, { protected: true, exposure: "hidden", approval: true, hosts: ["api.pay.example"] });
  assert.ok(!JSON.stringify(row).includes("second-value"), "a listing never carries the value");
});

test("an approval request posts ONE durable admin card per secret+server in the live turn's thread", async () => {
  const calls = [];
  approvals.__resetSecretHostApprovals();
  scoped.patchOrgEnv({ set: { name: "PAY_API_TOKEN", value: "org-pay-value-card-12345" } });
  approvals.setSecretHostApprovalRequester(async (req) => { calls.push(req); return { allow: false, pending: true }; });
  const refusal = { secretName: "PAY_API_TOKEN", reason: "approval-required", denied: true, scope: "organization", owner: null, host: "api.pay.example" };
  // No live turn: nowhere to ask (the 403 still says so; allow_secret_host covers it).
  assert.deepEqual(await approvals.requestSecretHostApprovals([refusal], { channelId: "C_APPR", slug: "appr", hostname: "api.pay.example" }), []);
  const release = liveness.markLive({ channelId: "C_APPR", ownerId: "U_MEMBER", kind: "turn", id: "1790000000.000100" });
  try {
    await approvals.requestSecretHostApprovals([refusal], { channelId: "C_APPR", slug: "appr", hostname: "api.pay.example" });
    await approvals.requestSecretHostApprovals([refusal], { channelId: "C_APPR", slug: "appr", hostname: "api.pay.example" });
    assert.equal(calls.length, 1, "a retry loop does not stack cards");
    const [req] = calls;
    assert.equal(req.threadKey, "1790000000.000100");
    assert.equal(req.requiredTier, "admin", "only an admin's click counts — never the run's own author");
    assert.equal(req.durableAction.kind, approvals.SECRET_HOST_ACTION);
    assert.deepEqual({ secretName: req.durableAction.secretName, scope: req.durableAction.scope, host: req.durableAction.host }, { secretName: "PAY_API_TOKEN", scope: "organization", host: "api.pay.example" });
    assert.match(req.toolInput.details, /^Allow the organization-wide variable `PAY_API_TOKEN` to be sent to `api\.pay\.example`\? It is shared by every conversation, so approving applies in all of them\./);
    // Never for an engine API.
    assert.deepEqual(await approvals.requestSecretHostApprovals([{ ...refusal, host: "api.anthropic.com" }], { channelId: "C_APPR", slug: "appr", hostname: "api.anthropic.com" }), []);
    assert.equal(req.durableAction.entrySetAt, scoped.getOrgEnv().PAY_API_TOKEN.setAt, "the card names the secret's current version");
    // At most a few pending cards per channel: an agent looping over new hosts cannot flood it.
    const { createApprovalRequest } = await import("../src/gateway/approval-requests.js");
    for (let i = 0; i < approvals.MAX_PENDING_PER_CHANNEL; i += 1) {
      createApprovalRequest({ id: `flood-${i}`, actionKey: `flood-${i}`, status: "pending", channelId: "C_APPR", slug: "appr", toolName: "x", authorId: "U", approvalType: "agent", requiredTier: "admin", action: { kind: approvals.SECRET_HOST_ACTION, host: `h${i}.example` } });
    }
    await approvals.requestSecretHostApprovals([{ ...refusal, host: "api.other.example" }], { channelId: "C_APPR", slug: "appr", hostname: "api.other.example" });
    assert.equal(calls.length, 1, "the channel is at its pending-card cap");
  } finally {
    release();
    approvals.__resetSecretHostApprovals();
    scoped.patchOrgEnv({ remove: "PAY_API_TOKEN" });
  }
});

test("executing an approval records the server on the secret itself — for an admin decision only", async () => {
  await store.setUser("U_APPR_ADMIN", { name: "Admin", isAdmin: true, approved: true });
  await store.setUser("U_APPR_MEMBER", { name: "Member", approved: true });
  scoped.patchOrgEnv({ set: { name: "PAY_API_TOKEN", value: "org-pay-value-1234567" } });
  const action = approvals.buildSecretHostAction({ channelId: "C_APPR", slug: "appr", secretName: "PAY_API_TOKEN", scope: "organization", host: "api.pay.example", entrySetAt: scoped.getOrgEnv().PAY_API_TOKEN.setAt });
  const record = (decidedBy, overrides = {}) => ({ status: "executing", channelId: "C_APPR", slug: "appr", decidedBy, action: { ...action, ...overrides } });

  const member = await approvals.executeSecretHostApproval(record("U_APPR_MEMBER"));
  assert.equal(member.ok, false);
  assert.match(member.error, /Only an admin/);
  assert.deepEqual(scoped.getOrgEnv().PAY_API_TOKEN.approvedHosts, undefined);

  const engine = await approvals.executeSecretHostApproval(record("U_APPR_ADMIN", { host: "api.openai.com" }));
  assert.match(engine.error, /model API/);

  // A card for an OLDER version of the secret (deleted and re-created, or re-set) blesses nothing.
  const stale = await approvals.executeSecretHostApproval({ ...record("U_APPR_ADMIN"), action: { ...action, entrySetAt: 1 } });
  assert.match(stale.error, /changed after this approval was requested/);
  const ok = await approvals.executeSecretHostApproval(record("U_APPR_ADMIN"));
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(scoped.getOrgEnv().PAY_API_TOKEN.approvedHosts, ["api.pay.example"]);
  assert.deepEqual(rulesFor("PAY_API_TOKEN", scoped.getOrgEnv().PAY_API_TOKEN).hosts, ["api.pay.example"]);
  // The admin UI and a decision link re-check authority on their own routes.
  for (const decidedBy of ["admin UI", "link"]) {
    const again = await approvals.executeSecretHostApproval(record(decidedBy, { host: `${decidedBy === "link" ? "b" : "a"}.pay.example` }));
    assert.equal(again.ok, true, again.error);
  }
  scoped.patchOrgEnv({ remove: "PAY_API_TOKEN" });
});

test("the per-attempt note tells the agent a hidden secret's first use on a new server needs an approval", () => {
  const ph = "cgph_oabcdefghijklmnopqrstuvwxyz234567";
  const prompt = channelCredentialsPreamble({ PAY_API_TOKEN: ph }, {
    scopes: { PAY_API_TOKEN: "organization" }, placeholders: { PAY_API_TOKEN: ph }, hosts: { PAY_API_TOKEN: [] }, approval: ["PAY_API_TOKEN"],
  });
  assert.match(prompt, /PAY_API_TOKEN is HIDDEN: [^\n]*on servers an admin approved \(none yet\)[^\n]*403 secret-refused[^\n]*retry the same request/);
  assert.doesNotMatch(prompt, /PAY_API_TOKEN is proxy-protected/, "not described as a fixed-destination secret");
  assert.ok(!prompt.includes(ph));
});

test("the add-variable form asks ONE thing — is it a secret? — ticked by default; the gateway decides the rest", async () => {
  const { buildSecretFormView, readSecretForm, visibilityLabel, SECRETS_KIND_BLOCK_ID, SECRETS_KIND_INPUT_ACTION_ID, SECRET_CHECKBOX_VALUE, SECRETS_DOMAINS_BLOCK_ID, SECRETS_DOMAINS_INPUT_ACTION_ID, SECRETS_NAME_BLOCK_ID, SECRETS_NAME_INPUT_ACTION_ID, SECRETS_VALUE_BLOCK_ID, SECRETS_VALUE_INPUT_ACTION_ID, SECRETS_ACTION_PATTERN } = await import("../src/slack/secret-explorer.js");
  const view = buildSecretFormView({}, { scope: "channel", channelName: "qa" });
  const kind = view.blocks.find((b) => b.block_id === SECRETS_KIND_BLOCK_ID);
  assert.equal(kind.element.type, "checkboxes");
  assert.deepEqual(kind.element.options.map((o) => o.value), [SECRET_CHECKBOX_VALUE]);
  assert.deepEqual(kind.element.initial_options.map((o) => o.value), [SECRET_CHECKBOX_VALUE], "a value is a secret unless the person says otherwise");
  assert.ok(!view.blocks.some((b) => /host|mode/i.test(b.block_id || "")), "no mode to pick");
  const domains = view.blocks.find((b) => b.block_id === SECRETS_DOMAINS_BLOCK_ID);
  assert.equal(domains.optional, true, "Allowed domains is optional");
  assert.ok(!SECRETS_ACTION_PATTERN.test(SECRETS_DOMAINS_INPUT_ACTION_ID));
  assert.ok(!SECRETS_ACTION_PATTERN.test(SECRETS_KIND_INPUT_ACTION_ID), "a form input, never a button action");
  const submitted = (extra = {}) => ({ state: { values: {
    [SECRETS_NAME_BLOCK_ID]: { [SECRETS_NAME_INPUT_ACTION_ID]: { value: "PAY_TOKEN" } },
    [SECRETS_VALUE_BLOCK_ID]: { [SECRETS_VALUE_INPUT_ACTION_ID]: { value: "value-1234567890" } },
    ...extra,
  } } });
  const ticked = { [SECRETS_KIND_BLOCK_ID]: { [SECRETS_KIND_INPUT_ACTION_ID]: { selected_options: [{ value: SECRET_CHECKBOX_VALUE }] } } };
  const unticked = { [SECRETS_KIND_BLOCK_ID]: { [SECRETS_KIND_INPUT_ACTION_ID]: { selected_options: [] } } };
  assert.deepEqual(readSecretForm(submitted(ticked)), { name: "PAY_TOKEN", value: "value-1234567890", exposure: "hidden" });
  assert.deepEqual(readSecretForm(submitted(unticked)), { name: "PAY_TOKEN", value: "value-1234567890", exposure: "readable" });
  assert.deepEqual(readSecretForm(submitted()), { name: "PAY_TOKEN", value: "value-1234567890" }, "a form without the block keeps what is stored");
  // Allowed domains restrict a SECRET: naming any makes it one, even with the box unticked.
  const withDomains = { ...unticked, [SECRETS_DOMAINS_BLOCK_ID]: { [SECRETS_DOMAINS_INPUT_ACTION_ID]: { value: " api.pay.example " } } };
  assert.deepEqual(readSecretForm(submitted(withDomains)), { name: "PAY_TOKEN", value: "value-1234567890", exposure: "hidden", hosts: "api.pay.example" });
  // Storage: an explicit choice is kept across a rotation that does not name one; auto clears it.
  let env = patchChannelEnv({}, { set: { name: "PAY_TOKEN", value: "value-1234567890", exposure: "readable" } });
  env = patchChannelEnv(env, { set: { name: "PAY_TOKEN", value: "value-0987654321" } });
  assert.equal(env.PAY_TOKEN.exposure, "readable");
  env = patchChannelEnv(env, { set: { name: "PAY_TOKEN", value: "value-0987654321", exposure: "auto" } });
  assert.equal(env.PAY_TOKEN.exposure, undefined);
  assert.throws(() => patchChannelEnv(env, { set: { name: "PAY_TOKEN", value: "value-0987654321", exposure: "loud" } }), /Unknown visibility/);
  // The row says how a container receives it, and why.
  const smtp = listEnvVars(patchChannelEnv({}, { set: { name: "SMTP_PASSWORD", value: "value-1234567890", exposure: "hidden" } }))[0];
  assert.match(visibilityLabel(smtp), /readable \(kept readable although hidden was chosen/);
  const pay = listEnvVars(patchChannelEnv({}, { set: { name: "PAY_TOKEN", value: "value-1234567890" } }))[0];
  assert.match(visibilityLabel(pay), /hidden — each new server asks an admin once/);
});

// Slack rejects the WHOLE view (views.push → invalid_arguments) when one text exceeds its Block Kit
// limit — found live on 2026-09-27: the Hidden option's description was 158 characters.
test("the add-variable form stays inside Slack's Block Kit text limits", async () => {
  const { buildSecretFormView } = await import("../src/slack/secret-explorer.js");
  for (const scope of ["channel", "personal", "organization"]) {
    const view = buildSecretFormView({}, { scope, channelName: "a-very-long-channel-name-for-limits", name: "SOME_VARIABLE_NAME" });
    assert.ok(view.title.text.length <= 24, "modal title ≤ 24");
    for (const block of view.blocks) {
      if (block.label) assert.ok(block.label.text.length <= 2000, `${block.block_id} label`);
      if (block.hint) assert.ok(block.hint.text.length <= 2000, `${block.block_id} hint`);
      for (const option of block.element?.options || []) {
        assert.ok(option.text.text.length <= 75, `${option.value} text ≤ 75`);
        if (option.description) assert.ok(option.description.text.length <= 150, `${option.value} description ≤ 150 (is ${option.description.text.length})`);
      }
      if (block.element?.placeholder) assert.ok(block.element.placeholder.text.length <= 150, `${block.block_id} placeholder ≤ 150`);
    }
  }
});

// "Allowed domains" (owner ask, 2026-09-28): a variable restricted to its declared domains swaps in
// any credential-like field THERE — not only Authorization — and is never sent, nor asked about,
// anywhere else; model APIs stay refused even if declared.
test("Allowed domains: credential fields on those domains only, no approval elsewhere", () => {
  const rule = rulesFor("PAY_API_TOKEN", { hosts: ["api.pay.example"] });
  assert.deepEqual({ source: rule.source, credentialFields: rule.credentialFields, approval: rule.approval }, { source: "entry", credentialFields: true, approval: undefined });
  const grant = { ...approvalGrant(), approval: false, credentialFields: true, hosts: rule.hosts, headers: rule.headers, query: rule.query, format: rule.format };
  const ok = swap({ headers: { "x-api-key": grant.placeholder }, path: `/v1?token=${grant.placeholder}`, hostname: "api.pay.example", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(ok.swapped.length, 1);
  assert.equal(ok.headers["x-api-key"], grant.value);
  const other = swap({ headers: { "x-api-key": grant.placeholder }, path: "/", hostname: "other.example.net", resolveGrant: resolverFor(grant), canUse: allowAll });
  assert.equal(other.swapped.length, 0);
  assert.deepEqual(other.refused.map((r) => [r.reason, Boolean(r.denied)]), [["host", false]], "not an approval request: it is restricted");
  const engine = swap({ headers: { authorization: `Bearer ${grant.placeholder}` }, path: "/", hostname: "api.anthropic.com", resolveGrant: resolverFor({ ...grant, hosts: ["api.anthropic.com"] }), canUse: allowAll });
  assert.equal(engine.refused[0].reason, "engine-host");
  // A known name keeps its catalog headers even with its own domains.
  assert.deepEqual(rulesFor("GITHUB_TOKEN", { hosts: ["ghe.example.com"] }).credentialFields, undefined);
});
