// The gateway-wide Email accounts switch (Settings → Email accounts, `emailAccountsEnabled`): OFF
// by default, it hides every Email accounts section, refuses new accounts and gives runs no email
// tool; ON restores all of it, stored accounts included.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const settings = await import("../src/config/settings.js");
const { saveChannelEmailAccount, saveUserEmailAccount } = await import("../src/gateway/email-account-store.js");
const { activityPage } = await import("../src/web/activity-page.js");
const { register } = await import("../src/mcp/tools/email.js");

function toolNames() {
  const names = [];
  register({ registerTool: (name) => names.push(name) }, { createdBy: "U1", text: (t) => t, principalTrusted: true, loadMeta: async () => ({}), slug: "x" });
  return names;
}

test("off by default: no tools, no saves, no Settings section", async () => {
  assert.equal(settings.getEmailAccountsEnabled(), false);
  assert.deepEqual(toolNames(), []);
  await assert.rejects(saveChannelEmailAccount("any", { name: "work" }), /turned off/);
  await assert.rejects(saveUserEmailAccount("U1", { name: "work" }), /turned off/);
  const html = activityPage({ sessionId: "s", csrf: "c", view: "skills" }).html;
  assert.doesNotMatch(html, /settings#email/);
  assert.match(activityPage({ sessionId: "s", csrf: "c", view: "settings" }).html, /"emailAccounts":false/);
});

test("on: the tools and the Settings section come back", () => {
  settings.saveSettings({ emailAccountsEnabled: true });
  assert.equal(settings.getEmailAccountsEnabled(), true);
  assert.ok(toolNames().length > 0);
  assert.match(activityPage({ sessionId: "s", csrf: "c", view: "skills" }).html, /settings#email/);
  assert.equal(settings.settingsForApi?.().emailAccountsEnabled ?? true, true);
});
