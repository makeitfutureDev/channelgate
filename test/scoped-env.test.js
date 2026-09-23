// The two credential scopes that are NOT the channel's: the ORGANIZATION's (every conversation)
// and a PERSON's (only runs they authored). config/scoped-env.js owns the stores and the merge;
// the rules about names, values and masking are channel-env.js's and are covered there.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  getOrgEnv, listOrgEnv, patchOrgEnv, resolveOrgEnv,
  listUserEnv, patchUserEnv, resolveUserEnv,
  mergeRunEnv, resolveRunEnv,
} = await import("../src/config/scoped-env.js");
const { setUser } = await import("../src/config/store.js");
const { getSettings } = await import("../src/config/settings.js");
const { channelCredentialsPreamble } = await import("../src/gateway/channel-credentials.js");

const ALICE = "U_SCOPED_ALICE";
const BOB = "U_SCOPED_BOB";

// ── Organization scope ──────────────────────────────────────────────────────
test("an organization secret round-trips write-only and reaches every conversation", async () => {
  const vars = patchOrgEnv({ set: { name: "gh_token", value: "ghp_orgtokenvalue123" }, actor: "admin UI" });
  // Case is folded on write, exactly like the channel scope.
  assert.deepEqual(vars.map((v) => v.name), ["GH_TOKEN"]);
  assert.equal(vars[0].last4, "e123");
  assert.equal(vars[0].setBy, "admin UI");
  // The masked shape is the ONLY thing a surface gets: no value, no ref.
  assert.ok(!Object.hasOwn(vars[0], "value"));
  assert.ok(!Object.hasOwn(vars[0], "ref"));
  // Resolution hands the real value to a spawn.
  assert.deepEqual(await resolveOrgEnv(), { GH_TOKEN: "ghp_orgtokenvalue123" });
});

test("organization secrets live in settings.json, never in the daemon's own process.env", async () => {
  patchOrgEnv({ set: { name: "ORG_ONLY", value: "org-only-value-123" }, actor: "admin UI" });
  // Stored where the other org-level secrets already are...
  assert.ok(Object.hasOwn(getSettings(), "orgEnv"));
  assert.ok(Object.hasOwn(getOrgEnv(), "ORG_ONLY"));
  // ...and NOT copied into the daemon's environment: settings.js applies only its ENV_MAP keys,
  // so an arbitrary org name can never become a variable the daemon itself runs with.
  const { applySettingsToEnv } = await import("../src/config/settings.js");
  applySettingsToEnv();
  assert.equal(process.env.ORG_ONLY, undefined);
  patchOrgEnv({ remove: "ORG_ONLY" });
});

test("removing an organization secret takes it out of every future run", async () => {
  patchOrgEnv({ set: { name: "TEMP_ORG_KEY", value: "temp-org-key-value" }, actor: "admin UI" });
  assert.ok("TEMP_ORG_KEY" in (await resolveOrgEnv()));
  const left = patchOrgEnv({ remove: "temp_org_key" }); // same case folding on the remove side
  assert.ok(!left.some((v) => v.name === "TEMP_ORG_KEY"));
  assert.ok(!("TEMP_ORG_KEY" in (await resolveOrgEnv())));
  assert.throws(() => patchOrgEnv({ remove: "TEMP_ORG_KEY" }), /is not set on the organization/);
});

// ── Personal scope ──────────────────────────────────────────────────────────
test("a personal secret belongs to one person and is invisible to another", async () => {
  await setUser(ALICE, { name: "Alice", approved: true });
  await setUser(BOB, { name: "Bob", approved: true });
  await patchUserEnv(ALICE, { set: { name: "NPM_TOKEN", value: "npm-alice-token-1234" } });

  assert.deepEqual((await listUserEnv(ALICE)).map((v) => v.name), ["NPM_TOKEN"]);
  assert.deepEqual(await listUserEnv(BOB), []);
  assert.deepEqual(await resolveUserEnv(ALICE), { NPM_TOKEN: "npm-alice-token-1234" });
  assert.deepEqual(await resolveUserEnv(BOB), {});
});

test("an unverified principal never receives anyone's personal secrets", async () => {
  await patchUserEnv(ALICE, { set: { name: "NPM_TOKEN", value: "npm-alice-token-1234" } });
  // The HTTP run API authenticates its key, not the author it names — so naming Alice must not
  // hand the caller Alice's credentials. Same rule as the personal Composio/Toolbox tokens.
  assert.deepEqual(await resolveUserEnv(ALICE, { untrustedPrincipal: true }), {});
  const { env } = await resolveRunEnv({ meta: {}, authorId: ALICE, untrustedPrincipal: true });
  assert.ok(!("NPM_TOKEN" in env), "personal scope is withheld from an untrusted principal");
});

test("a personal secret write is attributed to the person, or to the admin UI when it saves one", async () => {
  let vars = await patchUserEnv(BOB, { set: { name: "SELF_SET", value: "bob-own-value-123" } });
  assert.equal(vars.find((v) => v.name === "SELF_SET").setBy, BOB);
  vars = await patchUserEnv(BOB, { set: { name: "ADMIN_SET", value: "admin-set-value-123" }, actor: "admin UI" });
  assert.equal(vars.find((v) => v.name === "ADMIN_SET").setBy, "admin UI");
  await patchUserEnv(BOB, { remove: "SELF_SET" });
  await patchUserEnv(BOB, { remove: "ADMIN_SET" });
});

// ── The merge ───────────────────────────────────────────────────────────────
test("precedence is organization → person → channel, most specific last", () => {
  const { env, scopes } = mergeRunEnv({
    org: { SHARED: "org", ORG_ONLY: "o" },
    user: { SHARED: "user", USER_ONLY: "u" },
    channel: { SHARED: "channel", CHANNEL_ONLY: "c" },
  });
  // The channel's own account is never displaced by a personal token answering for the room.
  assert.equal(env.SHARED, "channel");
  assert.equal(scopes.SHARED, "channel");
  // Each scope still fills the names the more specific ones do not define.
  assert.deepEqual(
    { ORG_ONLY: env.ORG_ONLY, USER_ONLY: env.USER_ONLY, CHANNEL_ONLY: env.CHANNEL_ONLY },
    { ORG_ONLY: "o", USER_ONLY: "u", CHANNEL_ONLY: "c" },
  );
  assert.deepEqual(
    { ORG_ONLY: scopes.ORG_ONLY, USER_ONLY: scopes.USER_ONLY, CHANNEL_ONLY: scopes.CHANNEL_ONLY },
    { ORG_ONLY: "organization", USER_ONLY: "personal", CHANNEL_ONLY: "channel" },
  );
});

test("a personal secret outranks the organization's but not the channel's", () => {
  assert.equal(mergeRunEnv({ org: { K: "org" }, user: { K: "user" } }).env.K, "user");
  assert.equal(mergeRunEnv({ org: { K: "org" }, channel: { K: "channel" } }).env.K, "channel");
});

test("resolveRunEnv composes all three scopes for one spawn", async () => {
  patchOrgEnv({ set: { name: "GH_TOKEN", value: "ghp_orgtokenvalue123" }, actor: "admin UI" });
  await patchUserEnv(ALICE, { set: { name: "NPM_TOKEN", value: "npm-alice-token-1234" } });
  const meta = { env: { SUPABASE_TOKEN: { provider: "local", value: "sb-channel-token-99" } } };

  const { env, scopes } = await resolveRunEnv({ meta, authorId: ALICE });
  assert.equal(env.GH_TOKEN, "ghp_orgtokenvalue123");
  assert.equal(env.NPM_TOKEN, "npm-alice-token-1234");
  assert.equal(env.SUPABASE_TOKEN, "sb-channel-token-99");
  assert.deepEqual(scopes, { GH_TOKEN: "organization", NPM_TOKEN: "personal", SUPABASE_TOKEN: "channel" });

  // Bob in the SAME conversation gets the org and channel scopes, and none of Alice's.
  const bob = await resolveRunEnv({ meta, authorId: BOB });
  assert.equal(bob.env.GH_TOKEN, "ghp_orgtokenvalue123");
  assert.equal(bob.env.SUPABASE_TOKEN, "sb-channel-token-99");
  assert.ok(!("NPM_TOKEN" in bob.env), "one author's personal secret never reaches another's turn");
});

test("clean mode runs bare — every credential scope, not just the channel's", async () => {
  patchOrgEnv({ set: { name: "GH_TOKEN", value: "ghp_orgtokenvalue123" }, actor: "admin UI" });
  await patchUserEnv(ALICE, { set: { name: "NPM_TOKEN", value: "npm-alice-token-1234" } });
  const meta = { env: { SUPABASE_TOKEN: { provider: "local", value: "sb-channel-token-99" } } };
  assert.deepEqual(await resolveRunEnv({ meta, authorId: ALICE, clean: true }), { env: {}, scopes: {} });
});

// ── What the turn is told ───────────────────────────────────────────────────
test("the preamble names each variable's scope so the agent can say which account it used", () => {
  const preamble = channelCredentialsPreamble(
    { GH_TOKEN: "x", NPM_TOKEN: "y", SUPABASE_TOKEN: "z" },
    { scopes: { GH_TOKEN: "organization", NPM_TOKEN: "personal", SUPABASE_TOKEN: "channel" } },
  );
  assert.match(preamble, /Organization-wide variables[^\n]*\["GH_TOKEN"\]/);
  assert.match(preamble, /Personal variables belonging to the author[^\n]*\["NPM_TOKEN"\]/);
  assert.match(preamble, /This conversation's own variables[^\n]*\["SUPABASE_TOKEN"\]/);
  // Names only — a scope line must never carry a value.
  assert.ok(!preamble.includes("ghp_"), "no value reaches the transcript");
  // Clean mode says nothing at all.
  assert.equal(channelCredentialsPreamble({ GH_TOKEN: "x" }, { clean: true }), "");
});

test("the fingerprint separates two authors, so a warm process is never reused across them", async () => {
  const { channelEnvFingerprint, safeSpawnEnv } = await import("../src/config/channel-env.js");
  patchOrgEnv({ set: { name: "GH_TOKEN", value: "ghp_orgtokenvalue123" }, actor: "admin UI" });
  await patchUserEnv(ALICE, { set: { name: "NPM_TOKEN", value: "npm-alice-token-1234" } });
  const meta = { env: {} };
  const alice = channelEnvFingerprint(safeSpawnEnv((await resolveRunEnv({ meta, authorId: ALICE })).env));
  const bob = channelEnvFingerprint(safeSpawnEnv((await resolveRunEnv({ meta, authorId: BOB })).env));
  assert.notEqual(alice, bob, "the pool key must change with the author, or Bob's turn reuses Alice's process");
});

test("a reserved name is refused in every scope, so no scope can rewrite what the agent executes", async () => {
  for (const name of ["LD_PRELOAD", "NODE_OPTIONS", "PATH", "ANTHROPIC_BASE_URL", "CG_TOOLSET"]) {
    assert.throws(() => patchOrgEnv({ set: { name, value: "x" }, actor: "admin UI" }), /reserved/, `org: ${name}`);
    await assert.rejects(() => patchUserEnv(ALICE, { set: { name, value: "x" } }), /reserved/, `user: ${name}`);
  }
});
