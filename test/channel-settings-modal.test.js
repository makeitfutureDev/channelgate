import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

import {
  buildChannelSettingsView,
  maskedCredential,
  parseActionValue,
  parseSettingsMetadata,
  CHANNEL_SETTINGS_ACTION_ID,
  CHANNEL_SETTINGS_TABS,
} from "../src/slack/channel-settings.js";
import { footerButtons, settingsButton } from "../src/slack/footer.js";

const [{ channelSettingsContext }, store] = await Promise.all([
  import("../src/slack/app.js"),
  import("../src/config/store.js"),
]);

const state = {
  channelId: "C_SETTINGS",
  slug: "settings-channel",
  threadTs: "1700000000.000100",
  ownerId: "U_MANAGER",
};

const snapshot = {
  runtime: {
    configuredEngine: "",
    effectiveEngine: "Claude",
    configuredModel: "claude-opus-4-8",
    gatewayModel: "claude-sonnet-4-6",
    configuredEffort: "high",
  },
  connections: {
    composioMode: "personal",
    composioChannel: { configured: true, last4: "c123" },
    composioOrg: { configured: true, last4: "o123" },
    toolboxChannel: { configured: false, last4: "" },
    toolboxOrg: { configured: true, last4: "t123" },
    makeToolboxUrl: "https://example.test/mcp",
    makeToolboxKey: { configured: true, last4: "m123" },
    noDefaultTokens: false,
  },
  cloudMcp: {
    claude: { channel: [{ name: "github" }], organization: [{ name: "drive" }] },
    codex: { channel: [{ name: "figma" }], organization: [] },
  },
  skills: {
    template: "Development",
    additional: ["pdf"],
    channel: ["development", "pdf"],
    organization: ["gateway-usage"],
    effective: ["gateway-usage", "development", "pdf"],
  },
  secrets: [{ name: "SUPABASE_ACCESS_TOKEN", last4: "beef", setBy: "<@U_MANAGER>", setAt: Date.UTC(2026, 8, 7), provider: "local", resolvable: true }],
};

const allButtons = (view) => view.blocks.flatMap((block) => block.elements || []).filter((item) => item.type === "button");
const rendered = (view) => JSON.stringify(view);

test("Settings footer button is manager-only and requester-bound", () => {
  assert.equal(settingsButton("C1", "1.1", "U1", false), null);
  assert.equal(settingsButton("C1", "1.1", "", true), null);

  const button = settingsButton("C1", "1.1", "U1", true);
  assert.equal(button.action_id, CHANNEL_SETTINGS_ACTION_ID);
  assert.equal(button.text.text, "⚙️ Settings");
  assert.deepEqual(parseActionValue(button.value), { o: "open", c: "C1", t: "1.1", u: "U1" });
});

test("manager reply footer adds Settings after the existing workspace controls", () => {
  const buttons = footerButtons(
    { cwd: "/tmp/work", sessionId: "S1", engine: "claude", content: "" },
    { channel: "C1", threadTs: "1.1", authorId: "U1", mayManage: true },
  );
  assert.deepEqual(buttons.map((button) => button.text.text), ["💻", "📂", "🔑", "⚙️ Settings"]);

  const ordinary = footerButtons(
    { cwd: "/tmp/work", sessionId: "S1", engine: "claude", content: "" },
    { channel: "C1", threadTs: "1.1", authorId: "U1", mayManage: false },
  );
  assert.equal(ordinary.some((button) => button.action_id === CHANNEL_SETTINGS_ACTION_ID), false);
});

test("Channel Settings modal renders four working tabs with one active state", () => {
  const view = buildChannelSettingsView(snapshot, state, { channelName: "project-alpha", tab: "mcp" });
  const buttons = allButtons(view);
  assert.equal(buttons.length, CHANNEL_SETTINGS_TABS.length);
  assert.equal(new Set(buttons.map((button) => button.action_id)).size, CHANNEL_SETTINGS_TABS.length);
  assert.equal(buttons.filter((button) => button.style === "primary").length, 1);
  assert.match(buttons.find((button) => button.style === "primary").action_id, /_mcp$/);
  assert.match(rendered(view), /MCP connections/);
  assert.match(rendered(view), /Cloud MCP/);
  assert.match(rendered(view), /github/);

  const metadata = parseSettingsMetadata(view.private_metadata);
  assert.deepEqual(metadata, { ...state, tab: "mcp" });
});

test("each Settings tab renders its channel setup snapshot", () => {
  assert.match(rendered(buildChannelSettingsView(snapshot, state, { tab: "runtime" })), /claude-opus-4-8/);
  assert.match(rendered(buildChannelSettingsView(snapshot, state, { tab: "skills" })), /Development/);
  const secrets = rendered(buildChannelSettingsView(snapshot, state, { tab: "secrets" }));
  assert.match(secrets, /SUPABASE_ACCESS_TOKEN/);
  assert.match(secrets, /••••beef/);
  assert.doesNotMatch(secrets, /actual-secret-value/);
});

test("credential snapshots retain only a safe tail", () => {
  assert.deepEqual(maskedCredential("actual-secret-value-1234"), { configured: true, last4: "1234" });
  assert.deepEqual(maskedCredential("short"), { configured: true, last4: "" });
  assert.deepEqual(maskedCredential(""), { configured: false, last4: "" });
});

test("historic Settings controls re-check current manager access and membership", async () => {
  await store.ensureRoot();
  const entry = await store.upsertChannelEntry("C_SETTINGS_AUTH", {
    name: "settings-auth",
    type: "channel",
    isDM: false,
  });
  const base = {
    ...store.defaultChannelMeta({
      channelId: "C_SETTINGS_AUTH",
      name: "settings-auth",
      type: "channel",
      isDM: false,
    }),
    access: "approved",
    manageAccess: "custom",
    managers: ["U_SETTINGS_MANAGER"],
  };
  await store.saveChannelMeta(entry.slug, base);
  await store.setUser("U_SETTINGS_MANAGER", { name: "Settings Manager", approved: true });

  const memberClient = {
    conversations: {
      members: async () => ({ members: ["U_SETTINGS_MANAGER"], response_metadata: {} }),
    },
  };
  const current = await channelSettingsContext(memberClient, {
    channelId: "C_SETTINGS_AUTH",
    userId: "U_SETTINGS_MANAGER",
    expectedSlug: entry.slug,
    verifyMembership: true,
  });
  assert.equal(current.entry.slug, entry.slug);

  await store.saveChannelMeta(entry.slug, { ...base, managers: [] });
  await assert.rejects(
    () => channelSettingsContext(memberClient, {
      channelId: "C_SETTINGS_AUTH",
      userId: "U_SETTINGS_MANAGER",
      expectedSlug: entry.slug,
      verifyMembership: true,
    }),
    /not authorized to view this channel's settings/i,
  );

  await store.saveChannelMeta(entry.slug, base);
  const formerMemberClient = {
    conversations: { members: async () => ({ members: [], response_metadata: {} }) },
  };
  await assert.rejects(
    () => channelSettingsContext(formerMemberClient, {
      channelId: "C_SETTINGS_AUTH",
      userId: "U_SETTINGS_MANAGER",
      expectedSlug: entry.slug,
      verifyMembership: true,
    }),
    /no longer a member/i,
  );
});
