import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("admin UI exposes Personal and SDK Composio modes with a write-only SDK key", () => {
  assert.match(html, /id="set-composio-mode"/);
  assert.match(html, /value="personal"/);
  assert.match(html, /value="sdk"/);
  assert.match(html, /id="set-composio-sdk-key"[^>]*type="password"/);
  assert.match(html, /id="clear-composio-sdk-key"/);
  assert.match(html, /Switching modes never deletes saved personal, channel, or organization tokens/);
});

test("admin UI loads masked SDK-key state and saves mode independently from credentials", () => {
  assert.match(client, /set-composio-mode"\)\.value = s\.composioMode/);
  assert.match(client, /tokenState\(s\.hasComposioSdkApiKey, s\.composioSdkApiKeyLast4\)/);
  assert.match(client, /attachReveal\(document\.getElementById\("set-composio-sdk-key"\), ""\)/);
  assert.match(client, /composioMode: document\.getElementById\("set-composio-mode"\)\.value/);
  assert.match(client, /composioSdkApiKey: tokenValue\(document\.getElementById\("set-composio-sdk-key"\)\)/);
  assert.match(client, /clearComposioSdkApiKey: true/);
});

test("SDK mode explains stable identities, per-thread sessions, and manager-owned shared connections", () => {
  assert.match(client, /Stable identity per Slack user\/channel/);
  assert.match(client, /separate sessions per Slack thread/);
  assert.match(client, /Only channel managers manage shared connections/);
  assert.match(client, /saved · inactive in SDK mode/);
});
