// Channel settings → Runtime: "Licenses for this channel" replaced the legacy "Connect a Codex
// account for this channel" block, and reuses the Settings → Licenses manager rather than a copy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const manager = readFileSync(new URL("../public/admin-licenses.js", import.meta.url), "utf8");

test("the legacy channel and gateway Codex sign-in blocks are gone", () => {
  for (const legacy of ["Connect a Codex account for this channel", "ch-codex-auth-source", "ch-auth-channel-panel", "This channel's Codex setup", 'id="gateway-codex-login"']) {
    assert.ok(!html.includes(legacy), legacy);
  }
  assert.ok(!app.includes("/codex-login`"), "no channel sign-in route is called");
});

test("the runtime pane lists this channel's licenses through the one licenses manager", () => {
  const runtime = html.slice(html.indexOf('data-pane="runtime"'));
  assert.ok(runtime.includes('class="setcard ch-licenses-card"'));
  assert.ok(runtime.includes("Licenses for this channel"));
  assert.ok(runtime.includes('class="ch-licenses-all"'), "a link to Settings → Engine licenses");
  assert.match(app, /mountLicensesManager\(\{\s*root: card\.querySelector\("\.ch-licenses"\)/);
  assert.match(app, /scope: \{ channelId: ch\.channelId/);
  // Scoped: the add button, the harness choice, and the limit locked to the conversation.
  assert.ok(manager.includes("Add a license for this channel"));
  assert.ok(manager.includes('make("select", "lic-harness")'));
  assert.match(manager, /if \(scope\) \{\s*\/\/ Locked to this conversation/);
  assert.ok(manager.includes("licenses.filter((license) => license.channelId === scope.channelId)"));
});

test("the gateway's own Codex sign-in moved onto its license row", () => {
  assert.match(app, /gatewayCodexLogin: \{\s*url: "\/api\/gateway\/codex-login"/);
  assert.ok(manager.includes("manifest.defaultLicense && harness === \"codex\""));
});
