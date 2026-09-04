import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const settings = await import("../src/config/settings.js");
const { footerText } = await import("../src/slack/app.js");

const result = {
  engine: "claude",
  model: "claude-opus-4-8",
  durationMs: 14_400,
  usage: { input_tokens: 36_800, output_tokens: 192 },
  costUSD: 0.31,
};

test("message cost visibility defaults on and round-trips through the Admin API shape", () => {
  assert.equal(settings.getShowMessageCost(), true);
  assert.equal(settings.settingsForApi().showMessageCost, true);

  settings.saveSettings({ showMessageCost: false });

  assert.equal(settings.getShowMessageCost(), false);
  assert.equal(settings.settingsForApi().showMessageCost, false);
});

test("the global setting hides only cost from the shared Slack footer", () => {
  settings.saveSettings({ showMessageCost: true });
  assert.match(footerText(result), /\$0\.31/);

  settings.saveSettings({ showMessageCost: false });
  const hidden = footerText(result);

  assert.doesNotMatch(hidden, /\$/);
  assert.match(hidden, /Opus 4\.8/);
  assert.match(hidden, /14s/);
  assert.match(hidden, /36\.8k\/192/);
  assert.match(hidden, /18%/);
});

test("a resumed Codex footer shows only the current message delta", () => {
  settings.saveSettings({ showMessageCost: true });
  const resumed = footerText({
    engine: "codex",
    model: "gpt-5.6-sol",
    durationMs: 295_000,
    usage: { input_tokens: 3_400_000, cached_input_tokens: 3_300_000, output_tokens: 12_200 },
  });

  assert.match(resumed, /3\.4M\/12\.2k/);
  assert.doesNotMatch(resumed, /237\.56M|858\.9k|\$177\.88/);
});

test("a resumed Claude footer keeps the provider-reported current-message cost", () => {
  settings.saveSettings({ showMessageCost: true });
  const resumed = footerText({
    engine: "claude",
    model: "claude-opus-4-8",
    durationMs: 12_000,
    usage: { input_tokens: 2_000, cache_read_input_tokens: 30_000, output_tokens: 400 },
    costUSD: 0.42,
  });

  assert.match(resumed, /32k\/400/);
  assert.match(resumed, /\$0\.42/);
});

test("Admin settings accept message-cost visibility only as a boolean", () => {
  const route = readFileSync(new URL("../src/web/routes/settings.js", import.meta.url), "utf8");
  assert.match(route, /typeof body\.showMessageCost === "boolean"/);
});

test("Admin UI exposes, loads, and saves the global message-cost checkbox", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(html, /id="set-show-message-cost"/);
  assert.match(client, /set-show-message-cost"\)\.checked = s\.showMessageCost !== false/);
  assert.match(client, /showMessageCost: document\.getElementById\("set-show-message-cost"\)\.checked/);
});
