import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../slack-app-manifest.json", import.meta.url), "utf8"));

test("installer manifest uses import-safe commands with runtime handlers", () => {
  const commands = manifest.features.slash_commands;
  assert.deepEqual(commands.map(c => c.command), ["/menu", "/stop", "/status-cg", "/secrets", "/model"]);
  const app = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");
  for (const command of commands) {
    assert.ok(app.includes(`app.command("${command.command}"`), `${command.command} has a handler`);
    assert.equal(new URL(command.url).protocol, "https:");
    assert.ok(command.description.length > 0 && command.description.length <= 100);
    assert.equal(typeof command.should_escape, "boolean");
  }
  assert.equal(manifest.settings.socket_mode_enabled, true);
  assert.equal(manifest.settings.interactivity.is_enabled, true);
});

test("installer manifest preserves code channels and native agent controls", () => {
  assert.equal(manifest.features.code_channels.enabled, true);
  for (const scope of ["code_channels:manage", "chat:write.customize", "commands", "chat:write"]) {
    assert.ok(manifest.oauth_config.scopes.bot.includes(scope));
  }
  for (const event of ["agent_session_stopped", "agent_session_title_changed", "app_context_changed"]) {
    assert.ok(manifest.settings.event_subscriptions.bot_events.includes(event));
  }
});
