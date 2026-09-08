// CO-04: with BOTH Composio identities injected, "check the calendar" was answered from the SHARED
// identity — a colleague's whole week, attendee names included, posted into the channel — while the
// other harness asked "which account?" first. The rule already lived in the managed instructions
// block; what was missing is the FACT it applies to: which identities THIS turn received. That
// cannot live in the channel's shared instruction file (`composio-user` is per author, so two
// concurrent authors would race each other's sentence), so it rides the per-run prompt beside the
// fresh-session memory catalog and the caller's provenance line.
//
// The prompt-echo stubs make the assertion direct: their "answer" is the prompt they were handed,
// so these tests read the exact text each engine received.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures", "prompt-echo")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
const scratch = ensureTestEnv();
const { useFakeRuntime: __useFakeRuntime } = await import("./runtime-fake.js");
await __useFakeRuntime();
process.env.CG_WORKSPACE_DIR = path.join(scratch, "identity-workspaces");

const { composioIdentitiesForRun, composioIdentityPreamble } = await import("../src/gateway/mcp.js");
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage } = await import("../src/gateway/run.js");
const { effectiveWorkDir } = await import("../src/gateway/folders.js");

async function channel(id, name, extra = {}) {
  const entry = await upsertChannelEntry(id, { name, type: extra.type || "channel" });
  const meta = {
    channelId: id, name, type: extra.type || "channel", template: "custom",
    engine: extra.engine || "claude", cleanMode: false, allowNetwork: false, memory: false,
    ...extra,
  };
  await saveChannelMeta(entry.slug, meta);
  const cwd = effectiveWorkDir(entry.slug, meta);
  await mkdir(cwd, { recursive: true });
  return { entry, meta, cwd };
}

// ── The predicate: which identities a run injects ─────────────────────────────────────────────
test("the run's identity set mirrors the servers the MCP config would carry", () => {
  assert.deepEqual(
    composioIdentitiesForRun({ composioUserToken: "ak_user", composioToken: "ak_shared" }),
    { user: true, agent: true }
  );
  // Either transport counts: a legacy token, a remote endpoint, or an SDK session.
  assert.deepEqual(
    composioIdentitiesForRun({ composioUserEndpoint: { mode: "sdk", url: "http://s/u" }, composioEndpoint: { url: "https://c/mcp" } }),
    { user: true, agent: true }
  );
  assert.deepEqual(composioIdentitiesForRun({ composioToken: "ak_shared" }), { user: false, agent: true });
  assert.deepEqual(composioIdentitiesForRun({ composioUserToken: "ak_user" }), { user: true, agent: false });
  assert.deepEqual(composioIdentitiesForRun({}), { user: false, agent: false });
  // Clean mode injects no servers at all; an untrusted principal never gets the author's identity.
  assert.deepEqual(
    composioIdentitiesForRun({ clean: true, composioUserToken: "ak_user", composioToken: "ak_shared" }),
    { user: false, agent: false }
  );
  assert.deepEqual(
    composioIdentitiesForRun({ principalTrusted: false, composioUserToken: "ak_user", composioToken: "ak_shared" }),
    { user: false, agent: true }
  );
});

test("the identity line names only servers and roles — never a token, an address or an account", () => {
  const both = composioIdentityPreamble({ user: true, agent: true });
  assert.match(both, /^\[Composio identities in THIS run: `composio-user`.*`composio-agent`/);
  assert.match(both, /which account\?" — no tool call, no read-only peek/);
  assert.ok(both.endsWith("]\n\n"), "self-closing, like the memory catalog and provenance notes");
  assert.equal(both.trim().split("\n").length, 1, "one line");

  // Only the requester's: nothing to read for a request phrased for the agent.
  const userOnly = composioIdentityPreamble({ user: true, agent: false });
  assert.match(userOnly, /`composio-user` only/);
  assert.doesNotMatch(userOnly, /and `composio-agent`/);

  // Only the shared one: this is the CO-02 shape — "my inbox" must stop, not substitute.
  const agentOnly = composioIdentityPreamble({ user: false, agent: true });
  assert.match(agentOnly, /`composio-agent` only/);
  assert.match(agentOnly, /"my inbox", "my calendar"\) cannot be served here/);
  assert.match(agentOnly, /do not read `composio-agent` to answer it/);

  assert.equal(composioIdentityPreamble({ user: false, agent: false }), "", "no identities, no line");
  assert.equal(composioIdentityPreamble(), "");

  // Nothing identity-BEARING ever reaches the prompt: no token material, no email, no account name.
  for (const line of [both, userOnly, agentOnly]) {
    assert.doesNotMatch(line, /ak_|@|sk-|Bearer/);
  }
});

// ── The run boundary: the line reaches the engine ─────────────────────────────────────────────
test("a run with BOTH identities prepends the ask-first line to the prompt", async () => {
  saveSettings({ engine: "claude", agentMemory: false, memoryReviewEvery: 0, composioMode: "personal", defaultComposioToken: "ak_org_9999" });
  await setUser("U_IDENT", { name: "Identity User", approved: true, isAdmin: false, composioToken: "ak_user_1111" });
  await channel("C_IDENT_BOTH", "identity-both");

  const r = await runMessage({ channelId: "C_IDENT_BOTH", authorId: "U_IDENT", text: "check the calendar", threadKey: "9100.001", origin: "slack_foreground", preferCold: true });
  assert.match(r.content, /^\[Composio identities in THIS run: `composio-user`.*`composio-agent`/);
  assert.match(r.content, /which account\?/);
  assert.match(r.content, /\]\n\ncheck the calendar$/, "the turn text still follows the preamble untouched");

  // Per RUN, not per session: the resumed second turn carries it too, because the identity set is
  // resolved for whoever is asking THIS time.
  const second = await runMessage({ channelId: "C_IDENT_BOTH", authorId: "U_IDENT", text: "and tomorrow?", threadKey: "9100.001", origin: "slack_foreground", preferCold: true });
  assert.match(second.content, /^\[Composio identities in THIS run: `composio-user`/);
});

test("a run with only the shared identity says so; a run with none adds nothing", async () => {
  saveSettings({ engine: "claude", agentMemory: false, memoryReviewEvery: 0, composioMode: "personal", defaultComposioToken: "ak_org_9999" });
  await setUser("U_IDENT_NOPERSONAL", { name: "No Personal", approved: true, isAdmin: false });
  await channel("C_IDENT_SHARED", "identity-shared");
  const shared = await runMessage({ channelId: "C_IDENT_SHARED", authorId: "U_IDENT_NOPERSONAL", text: "check my calendar", threadKey: "9100.002", origin: "slack_foreground", preferCold: true });
  assert.match(shared.content, /^\[Composio identities in THIS run: `composio-agent` only/);
  assert.match(shared.content, /\]\n\ncheck my calendar$/);

  saveSettings({ engine: "claude", agentMemory: false, memoryReviewEvery: 0, composioMode: "personal", defaultComposioToken: "" });
  await channel("C_IDENT_NONE", "identity-none");
  const none = await runMessage({ channelId: "C_IDENT_NONE", authorId: "U_IDENT_NOPERSONAL", text: "just a question", threadKey: "9100.003", origin: "slack_foreground", preferCold: true });
  assert.doesNotMatch(none.content, /Composio identities/, "a channel with no Composio pays nothing for the identity rule");
  assert.match(none.content, /\]\n\njust a question$/, "safe runtime facts precede the unchanged request");
});

test("Codex receives the same line through its own prompt path", async () => {
  saveSettings({ engine: "codex", agentMemory: false, memoryReviewEvery: 0, composioMode: "personal", defaultComposioToken: "ak_org_9999" });
  await setUser("U_IDENT_CODEX", { name: "Codex Identity", approved: true, isAdmin: false, composioToken: "ak_user_2222" });
  await channel("C_IDENT_CODEX", "identity-codex", { engine: "codex" });

  const r = await runMessage({ channelId: "C_IDENT_CODEX", authorId: "U_IDENT_CODEX", text: "check the calendar", threadKey: "9100.004", origin: "slack_foreground", preferCold: true });
  // Codex also prepends the current personal catalog (empty here, clearing older grants).
  // Identity facts must still occupy their own line before the unchanged user request.
  assert.match(r.content, /^\[Current personal skill grants/);
  assert.match(r.content, /^\[Composio identities in THIS run: `composio-user`.*`composio-agent`/m);
  assert.equal((r.content.match(/\[Composio identities in THIS run:/g) || []).length, 1);
  assert.match(r.content, /\]\n\ncheck the calendar$/);
});

test("both engines preserve identity routing without inventing account ownership, including resumed shared-only turns", async () => {
  for (const engine of ["claude", "codex"]) {
    // Both configured credentials can legitimately address the same service owner. Identity
    // routing must stay distinct; neither the resolver nor the prompt can infer a different human.
    saveSettings({ engine, agentMemory: false, memoryReviewEvery: 0, composioMode: "personal", defaultComposioToken: "ak_same_owner_3333" });
    const authorId = `U_OWNER_${engine}`;
    await setUser(authorId, { name: "Ownership Fixture", approved: true, isAdmin: false, composioToken: "ak_same_owner_3333" });
    const channelId = `C_OWNER_${engine}`;
    await channel(channelId, `ownership-${engine}`, { engine });
    const threadKey = engine === "claude" ? "9101.001" : "9101.002";
    for (const personal of [true, false]) {
      if (!personal) await setUser(authorId, { composioToken: "" });
      const result = await runMessage({ channelId, authorId, text: "check my inbox", threadKey, origin: "slack_foreground", preferCold: true });
      const preamble = result.content.match(/^\[Composio identities in THIS run:.*$/m)?.[0];
      assert.ok(preamble, "the actual engine prompt includes current identity guidance");
      assert.match(preamble, /do not establish the connected service owner/);
      assert.match(preamble, /not necessarily shared across channels/);
      assert.doesNotMatch(preamble, /OTHER people's|never the requester's|ak_same_owner/);
      if (personal) {
        assert.match(preamble, /`composio-user`.*`composio-agent`/);
        assert.match(preamble, /which account\?" — no tool call, no read-only peek/);
      } else {
        assert.match(preamble, /`composio-agent` only/);
        assert.match(preamble, /do not read `composio-agent` to answer it/);
      }
    }
  }
});
