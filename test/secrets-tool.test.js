// One tool per verb for environment secrets (src/mcp/tools/tokens.js): `list_secrets` shows every
// scope a run receives in one live call (names, never values), `set_secret` / `remove_secret` take
// the scope as an argument and the approval tier follows it. Six tools became three (owner ask,
// 2026-09-24: "why have so many different tools in your toolbox?").
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
const store = await import("../src/config/store.js");
const scoped = await import("../src/config/scoped-env.js");
const { register } = await import("../src/mcp/tools/tokens.js");
const { buildControlPlane, secretScopeTier, gateAuthz, ctxFromClaims } = await import("../src/mcp/gateway-server.js");
const { GATEWAY_TOOL_NAMES } = await import("../src/gateway/mcp-catalog.js");

test.after(() => rmSync(scratch, { recursive: true, force: true }));

const ADMIN = "U_SEC_ADMIN";
const DEV = "U_SEC_DEV";
await store.setUser(ADMIN, { name: "Admin", isAdmin: true, approved: true });
await store.setUser(DEV, { name: "Dev", approved: true });
const SLUG = "secrets-chan";
await store.saveChannelMeta(SLUG, { ...store.defaultChannelMeta({ channelId: "C_SEC", name: "secrets", type: "channel", isDM: false }), env: { CHAN_TOKEN: { provider: "local", value: "chan-value-1234567890", setBy: ADMIN, setAt: 1 } } });

function toolsFor(authorId, { trusted = true } = {}) {
  const tools = new Map();
  const ctx = ctxFromClaims({ channelId: "C_SEC", slug: SLUG, authorId, threadKey: "1700000000.000300", principalTrusted: trusted, engine: "claude" });
  register({ registerTool: (name, def, handler) => tools.set(name, { def, handler }) }, ctx);
  return tools;
}
const reply = async (tools, name, args = {}) => (await tools.get(name).handler(args)).content[0].text;

test("the tool set is three, on the allowlist, and the old six are gone", () => {
  const names = [...toolsFor(DEV).keys()].filter((n) => n.includes("secret"));
  assert.deepEqual(names.sort(), ["list_secrets", "remove_secret", "set_secret"]);
  for (const name of names) assert.ok(GATEWAY_TOOL_NAMES.includes(name), `${name} on the Claude permission allowlist`);
  for (const old of ["list_my_secrets", "list_org_secrets", "set_my_secret", "set_org_secret", "remove_my_secret", "remove_org_secret"]) {
    assert.ok(!GATEWAY_TOOL_NAMES.includes(old), `${old} retired`);
  }
});

test("list_secrets: one call, every scope, names only; filterable; the organization's tails only for admins", async () => {
  scoped.patchOrgEnv({ set: { name: "ORG_TOKEN", value: "org-value-1234567890" }, actor: ADMIN });
  await scoped.patchUserEnv(DEV, { set: { name: "MY_TOKEN", value: "my-value-1234567890" } });
  const all = await reply(toolsFor(DEV), "list_secrets");
  for (const heading of ["**Organization**", "**Personal**", "**This conversation**"]) assert.ok(all.includes(heading), heading);
  assert.ok(all.includes("`ORG_TOKEN`") && all.includes("`MY_TOKEN`") && all.includes("`CHAN_TOKEN`"));
  assert.ok(all.includes("…7890") && all.includes(`set by <@${ADMIN}>`), "the conversation's and the author's own rows carry a masked tail and the author");
  assert.ok(!all.includes("value-1234567890"), "never a value");
  assert.ok(!all.match(/ORG_TOKEN`[^\n]*…7890/), "a non-admin sees the organization NAMES (as the run prompt already does), not the tails");
  const adminAll = await reply(toolsFor(ADMIN), "list_secrets", { scope: "org" });
  assert.ok(adminAll.match(/ORG_TOKEN`[^\n]*…7890/), "an admin sees the organization tails");
  assert.ok(!adminAll.includes("**Personal**") && !adminAll.includes("**This conversation**"), "the filter narrows to one scope");
  const mine = await reply(toolsFor(DEV), "list_secrets", { scope: "personal" });
  assert.ok(mine.includes("`MY_TOKEN`") && !mine.includes("ORG_TOKEN"));
  const other = await reply(toolsFor(ADMIN), "list_secrets", { scope: "personal" });
  assert.ok(!other.includes("MY_TOKEN"), "a person only ever sees their OWN personal secrets");
  const untrusted = await reply(toolsFor(DEV, { trusted: false }), "list_secrets", { scope: "all" });
  assert.ok(untrusted.includes("No verified user context") && untrusted.includes("`CHAN_TOKEN`"), "an unverified principal gets no personal scope, the shared scopes still list");
  const chan = await reply(toolsFor(DEV), "list_secrets", { scope: "channel" });
  assert.ok(chan.includes("`CHAN_TOKEN`") && !chan.includes("**Organization**"));
});

test("set_secret / remove_secret: the scope argument picks the store and the tier; a conversation's own are not written here", async () => {
  const dev = toolsFor(DEV);
  const admin = toolsFor(ADMIN);
  assert.match(await reply(dev, "set_secret", { name: "dev_added", value: "dev-added-1234567890" }), /Saved your personal secret `DEV_ADDED`/);
  assert.match(await reply(dev, "set_secret", { name: "ORG_ADDED", value: "org-added-1234567890", scope: "organization" }), /Only organization admins/);
  assert.match(await reply(admin, "set_secret", { name: "ORG_ADDED", value: "org-added-1234567890", scope: "org" }), /Saved the organization secret `ORG_ADDED`/);
  assert.deepEqual(scoped.listOrgEnv().map((v) => v.name).sort(), ["ORG_ADDED", "ORG_TOKEN"]);
  assert.match(await reply(dev, "set_secret", { name: "X", value: "x", scope: "conversation" }), /Secrets modal or the admin UI/);
  assert.match(await reply(dev, "remove_secret", { name: "ORG_ADDED", scope: "organization" }), /Only organization admins/);
  assert.match(await reply(admin, "remove_secret", { name: "ORG_ADDED", scope: "organization" }), /Removed the organization secret `ORG_ADDED`/);
  assert.match(await reply(dev, "remove_secret", { name: "DEV_ADDED" }), /Removed your personal secret `DEV_ADDED`/);
  assert.deepEqual((await scoped.listUserEnv(DEV)).map((v) => v.name), ["MY_TOKEN"]);
  assert.match(await reply(toolsFor(DEV, { trusted: false }), "set_secret", { name: "A", value: "b" }), /No verified user context/);
  // The approval gate's tier follows the scope: an organization write needs an admin's click.
  const plane = buildControlPlane({ loadMeta: async () => ({}) });
  for (const name of ["set_secret", "remove_secret"]) {
    assert.equal(gateAuthz(plane.get(name), { scope: "organization" }), "admin");
    assert.equal(gateAuthz(plane.get(name), { scope: "org" }), "admin");
    assert.equal(gateAuthz(plane.get(name), {}), "any");
    assert.match(plane.get(name).details({ name: "T", scope: "organization" }), /ORGANIZATION-WIDE|organization-wide/);
    assert.match(plane.get(name).details({ name: "T" }), /YOUR personal/);
  }
  assert.equal(plane.has("list_secrets"), false, "a masked listing carries no card");
  assert.equal(secretScopeTier(undefined), "any");
  assert.equal(gateAuthz({ authz: "manage" }, { scope: "organization" }), "manage", "a string tier is unchanged");
});

test("list_secrets reports the remaining raw (unruled) secrets as a FINDING, worded for the strict setting in force", async () => {
  const { saveSettings } = await import("../src/config/settings.js");
  const { unruledFinding } = await import("../src/mcp/tools/tokens.js");
  // CHAN_TOKEN, ORG_TOKEN and MY_TOKEN have no egress rule; a GitHub token is ruled by the catalog.
  await scoped.patchUserEnv(DEV, { set: { name: "GITHUB_TOKEN", value: "gh-value-1234567890" } });
  saveSettings({ containerEgressSecretsStrict: true, containerEgressMode: "proxy" });
  const strict = await reply(toolsFor(DEV), "list_secrets");
  assert.match(strict, /\*\*Finding:\*\* \d+ secrets have no egress rule — [^\n]*`CHAN_TOKEN`[^\n]*: WITHHELD from containers \(strict mode\)\./);
  assert.doesNotMatch(strict.match(/\*\*Finding:\*\*[^\n]*/)[0], /GITHUB_TOKEN/, "a ruled secret is not a finding");
  assert.match(strict, /an unprotected one is withheld \(strict mode\)/);
  saveSettings({ containerEgressSecretsStrict: false });
  const raw = await reply(toolsFor(DEV), "list_secrets", { scope: "channel" });
  assert.match(raw, /\*\*Finding:\*\* 1 secret has no egress rule — `CHAN_TOKEN`: injected RAW into containers\./);
  assert.equal(unruledFinding([], { strict: true }), "", "nothing unruled, no finding");
  await scoped.patchUserEnv(DEV, { remove: "GITHUB_TOKEN" });
  saveSettings({ containerEgressSecretsStrict: true });
});

test("strict is the default when nothing is stored; the boot pin keeps an existing install off and makes a new one strict", async () => {
  const { getContainerRuntime, pinEgressSecretsStrictDefault } = await import("../src/config/settings.js");
  const saved = [];
  const save = (patch) => saved.push(patch);
  assert.equal(pinEgressSecretsStrictDefault({ configured: true, save, read: () => ({ slackBotToken: "x" }) }), false, "an upgraded install keeps raw-and-flagged");
  assert.equal(pinEgressSecretsStrictDefault({ configured: false, save, read: () => ({}) }), true, "a brand-new install is strict");
  assert.deepEqual(saved, [{ containerEgressSecretsStrict: false }, { containerEgressSecretsStrict: true }]);
  assert.equal(pinEgressSecretsStrictDefault({ configured: true, save, read: () => ({ containerEgressSecretsStrict: true }) }), true, "a stored choice is never touched");
  assert.equal(saved.length, 2);
  const { getSettings } = await import("../src/config/settings.js");
  assert.equal(typeof getSettings().containerEgressSecretsStrict, "boolean");
  assert.equal(getContainerRuntime().egressSecretsStrict, getSettings().containerEgressSecretsStrict !== false);
});
