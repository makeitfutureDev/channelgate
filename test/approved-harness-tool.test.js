// The approved list of a channel — which harnesses and licenses it may run on — outside the
// Settings window: `set_channel_approved_harnesses` / `get_channel_approved_harnesses` on the
// gateway control MCP. Anyone in a channel may pick among the approved entries; only an
// organization admin may change which entries those are, and the tool must hold every rule the
// Settings control holds: the Enterprise entitlement, the audit row, and never a list that
// excludes the license the channel runs on.
import test from "node:test";
import assert from "node:assert/strict";
import { clearTestLicense, ensureTestEnv, testLicenseEnv } from "./helpers.js";

ensureTestEnv();

const { readEvents } = await import("../src/util/logger.js");
const { defaultChannelMeta, getChannelMeta, saveChannelMeta, upsertChannelEntry, setUser } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { createLicense, deleteLicense } = await import("../src/config/engine-licenses.js");
const { isChannelEngineApproved } = await import("../src/gateway/channel-engines.js");
const { register: registerChannelAdmin } = await import("../src/mcp/tools/channel-admin.js");
const { ctxFromClaims } = await import("../src/mcp/gateway-server.js");

const ADMIN_ID = "U_HARNESS_ADMIN";
const MEMBER_ID = "U_HARNESS_MEMBER";
await setUser(ADMIN_ID, { name: "Harness Admin", isAdmin: true, approved: true });
await setUser(MEMBER_ID, { name: "Harness Member", isAdmin: false, approved: true });
saveSettings({ engine: "claude", engineEnabled: { claude: true, codex: true } });

let seq = 0;
async function fixture() {
  testLicenseEnv({ tier: "enterprise" });
  const channelId = `C_HARNESS_TOOL_${++seq}`;
  const entry = await upsertChannelEntry(channelId, { name: `harness-tool-${seq}`, type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId, name: entry.name, type: "channel", isDM: false }), engine: "claude", template: "custom" });
  const toolsFor = (authorId) => {
    const tools = new Map();
    registerChannelAdmin({ registerTool: (name, _definition, handler) => tools.set(name, handler) }, ctxFromClaims({ channelId, slug: entry.slug, authorId, threadKey: "1700000000.000100", principalTrusted: true, engine: "claude" }));
    return async (name, args = {}) => (await tools.get(name)(args)).content[0].text;
  };
  const events = () => readEvents({ limit: 200 }).filter((e) => e.event === "channel_meta_changed" && e.slug === entry.slug);
  return { entry, admin: toolsFor(ADMIN_ID), member: toolsFor(MEMBER_ID), events, policy: async () => (await getChannelMeta(entry.slug)).approvedEngines ?? null };
}

test("an admin narrows a channel to a harness and one license, by id or by name, and it is audited", async () => {
  const f = await fixture();
  const seat = createLicense({ kind: "codex-login", label: "Team seat", type: "business" });
  saveSettings({ engineEnabled: { [seat.id]: true } });
  try {
    const said = await f.admin("set_channel_approved_harnesses", { approved: ["harness:claude", "Team seat"] });
    assert.match(said, /✅ Approved for this channel: Claude Code \(any license\), Team seat\./);
    assert.deepEqual(await f.policy(), ["harness:claude", seat.id]);
    const meta = await getChannelMeta(f.entry.slug);
    assert.equal(isChannelEngineApproved(meta, seat.id), true);
    assert.equal(isChannelEngineApproved(meta, "codex"), false, "the Codex default sign-in was not approved");

    const [event] = f.events();
    assert.deepEqual(event.keys, ["approvedEngines"]);
    assert.equal(event.actor, ADMIN_ID);
    assert.equal(event.source, "mcp");

    // The full "Harness · name" form and the id are the same entry; a repeat changes nothing.
    const before = f.events().length;
    await f.admin("set_channel_approved_harnesses", { approved: ["Codex · Team seat", seat.id, "harness:claude"] });
    assert.deepEqual(await f.policy(), ["harness:claude", seat.id]);
    assert.equal(f.events().length, before, "the same list is not a change");

    assert.match(await f.admin("set_channel_approved_harnesses", { approved: "all" }), /every harness and license \(no restriction\)/);
    assert.equal(await f.policy(), null);
  } finally {
    await deleteLicense(seat.id);
  }
});

test("someone who is not an admin can read the list and cannot change it", async () => {
  const f = await fixture();
  await f.admin("set_channel_approved_harnesses", { approved: ["claude", "codex"] });
  const refused = await f.member("set_channel_approved_harnesses", { approved: "all" });
  assert.match(refused, /Only organization admins/);
  assert.deepEqual(await f.policy(), ["claude", "codex"]);

  const seen = await f.member("get_channel_approved_harnesses");
  assert.match(seen, /Approved here: Claude, Codex\./);
  assert.match(seen, /Only an organization admin can change this list/);
  assert.ok(!seen.includes("harness:codex"), "what could be approved is an admin's list");

  const adminSees = await f.admin("get_channel_approved_harnesses");
  assert.match(adminSees, /`harness:codex` — Codex \(any license\)/);
  assert.match(adminSees, /`claude` — Claude Code · /);
});

test("an entry that names nothing changes nothing and lists what can be approved", async () => {
  const f = await fixture();
  const said = await f.admin("set_channel_approved_harnesses", { approved: ["harness:claude", "gpt-seat-that-is-not-there"] });
  assert.match(said, /Nothing was changed/);
  assert.match(said, /gpt-seat-that-is-not-there/);
  assert.match(said, /`harness:codex` — Codex \(any license\)/, "the entries that do exist are listed");
  assert.equal(await f.policy(), null);
  assert.equal(f.events().length, 0);
});

test("a list that leaves out the license the channel runs on is refused", async () => {
  const f = await fixture();
  const said = await f.admin("set_channel_approved_harnesses", { approved: ["harness:codex"] });
  assert.match(said, /Nothing was changed: this channel currently runs on Claude, which that list leaves out/);
  assert.match(said, /\/model/);
  assert.equal(await f.policy(), null);
  assert.equal(f.events().length, 0, "a refused change leaves no audit row");
});

test("without the Enterprise entitlement the list cannot be changed, and an existing one stays", async () => {
  const f = await fixture();
  await f.admin("set_channel_approved_harnesses", { approved: ["claude"] });
  clearTestLicense();
  try {
    const said = await f.admin("set_channel_approved_harnesses", { approved: "all" });
    assert.match(said, /Nothing was changed: .*requires an active Enterprise license/);
    assert.deepEqual(await f.policy(), ["claude"], "a downgrade never widens a restriction");
  } finally {
    testLicenseEnv({ tier: "enterprise" });
  }
});
