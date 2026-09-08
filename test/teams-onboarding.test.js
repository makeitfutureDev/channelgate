import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const docs = readFileSync(new URL("../docs/PLATFORMS.md", import.meta.url), "utf8");

test("Teams onboarding uses the official CLI and the ChannelGate event endpoint", () => {
  for (const text of [html, docs]) {
    assert.match(text, /npm install -g @microsoft\/teams\.cli/);
    assert.match(text, /teams login --device-code/);
    assert.match(text, /teams app create/);
    assert.match(text, /\/api\/teams\/messages/);
    assert.match(text, /teams app get .* --install-link/);
  }
});

test("the admin UI builds the create command from the configured messaging endpoint", () => {
  assert.match(html, /id="teams-create-command"/);
  assert.match(app, /teams-create-command/);
  assert.match(app, /s\.teams\?\.messagingEndpoint/);
});
