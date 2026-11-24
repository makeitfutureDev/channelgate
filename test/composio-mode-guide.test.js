// The gateway-usage guide and the per-run identity line follow the gateway's Composio mode:
// SDK mode describes organization-project user ids (and names this run's), Personal mode
// describes per-owner accounts behind consumer keys. Guide condition markers never leak.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const settings = await import("../src/config/settings.js");
const { applyGatewayGuide, applyGuideConditions } = await import("../src/gateway/guide.js");
const { composioIdentityPreamble } = await import("../src/gateway/mcp.js");
const { sdkUserIdsFor } = await import("../src/gateway/run-integrations.js");

test("condition markers: inline lines, blocks, unknown names hidden", () => {
  settings.saveSettings({ composioMode: "personal" });
  const out = applyGuideConditions("a\n<!--if:composio-sdk-->\nsdk\n<!--endif-->\n<!--if:composio-personal-->\npers\n<!--endif-->\nx <!--if:nope-->\ny <!--if:composio-personal-->");
  assert.equal(out, "a\npers\ny");
  settings.saveSettings({ composioMode: "sdk" });
  assert.equal(applyGuideConditions("<!--if:composio-sdk-->\nsdk\n<!--endif-->\nz <!--if:composio-personal-->"), "sdk");
});

async function materialized(mode) {
  settings.saveSettings({ composioMode: mode });
  const cwd = path.join(process.env.CG_TEST_SCRATCH, `guide-${mode}`); await mkdir(cwd, { recursive: true });
  await applyGatewayGuide(cwd, { platform: "slack" });
  const dir = path.join(cwd, ".claude", "skills", "gateway-usage");
  const files = await Promise.all(["SKILL.md", "references/composio-scripts.md", "references/administration.md"].map((f) => readFile(path.join(dir, f), "utf8")));
  return files.join("\n");
}

test("the materialized guide describes only the active Composio mode", async () => {
  const sdk = await materialized("sdk");
  assert.match(sdk, /runs Composio in SDK mode/);
  assert.match(sdk, /connectedAccounts\.list\(\{ userIds: \[userId\]/);
  assert.match(sdk, /currently runs SDK mode/);
  assert.doesNotMatch(sdk, /runs Composio in Personal mode|<!--if:|<!--endif-->/);
  const personal = await materialized("personal");
  assert.match(personal, /runs Composio in Personal mode/);
  assert.match(personal, /currently runs Personal mode/);
  assert.doesNotMatch(personal, /runs Composio in SDK mode|<!--if:|<!--endif-->/);
});

test("the identity line names the mode and, in SDK mode, this run's user ids", () => {
  const sdk = composioIdentityPreamble({ user: true, agent: true, mode: "sdk", sdkUserIds: { user: "slack:T1:user:U1", agent: "slack:T1:channel:C1" } });
  assert.match(sdk, /Composio mode: SDK/);
  assert.match(sdk, /`composio-user` = `slack:T1:user:U1`, `composio-agent` = `slack:T1:channel:C1`/);
  const personal = composioIdentityPreamble({ user: true, agent: false });
  assert.match(personal, /Composio mode: Personal/);
  assert.doesNotMatch(personal, /slack:/);
  assert.equal(composioIdentityPreamble({}), "");
});

test("sdkUserIdsFor: only SDK identities this run received, never a guess", () => {
  const composio = { mode: "sdk", user: { source: "sdk-user" }, shared: { source: "sdk-channel" } };
  assert.deepEqual(sdkUserIdsFor({ composio, identities: { user: true, agent: true }, workspaceId: "T1", userSubjectId: "U1", channelId: "C1" }),
    { user: "slack:T1:user:U1", agent: "slack:T1:channel:C1" });
  assert.deepEqual(sdkUserIdsFor({ composio, identities: { user: true, agent: false }, workspaceId: "T1", userSubjectId: "U1", channelId: "C1" }), { user: "slack:T1:user:U1" });
  assert.deepEqual(sdkUserIdsFor({ composio: { ...composio, user: { source: "sdk-unavailable" } }, identities: { user: true, agent: false }, workspaceId: "T1", userSubjectId: "U1" }), {});
  assert.deepEqual(sdkUserIdsFor({ composio: { mode: "personal" }, identities: { user: true, agent: true } }), {});
  assert.deepEqual(sdkUserIdsFor({ composio, identities: { user: true, agent: true }, workspaceId: "", userSubjectId: "U1", channelId: "C1" }), {});
});
