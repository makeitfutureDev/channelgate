// The suite must not see the serving deployment's configuration: the live updater runs `npm test`
// with the daemon's environment (real Slack tokens, public URL, license payload, approval secret).
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { testEnvironment, isDeploymentVariable } = await import("../scripts/test-env.mjs");

test("deployment configuration is stripped; the OS environment and test switches survive", () => {
  const daemon = {
    PATH: "/usr/bin", HOME: "/home/op", LANG: "C.UTF-8", TZ: "Europe/Bucharest", NODE_OPTIONS: "--x",
    SLACK_BOT_TOKEN: "xoxb-live", SLACK_APP_TOKEN: "xapp-live", SLACK_SIGNING_SECRET: "s",
    GATEWAY_PUBLIC_URL: "https://gw.example", GATEWAY_APPLE_APP_IDS: "x",
    CHANNELGATE_DIR: "/srv/cg", CHANNELGATE_DB: "/srv/cg/gateway.db", CHANNELGATE_LICENSE_PAYLOAD: "p",
    CLAUDE_GATEWAY_DIR: "/old", CG_APPROVAL_SECRET: "secret", CG_UPDATE_OWNER_TOKEN: "t",
    CG_SLACK_TEAM_ID: "T1", CG_WORKSPACE_DIR: "/w", CG_TEST_SCRATCH: "/tmp/x", CG_TRUST_PROXY: "cloudflare",
    COMPOSIO_MCP_URL: "u", SUPABASE_ACCESS_TOKEN: "sbp", TEAMS_APP_PASSWORD: "p", GOOGLE_CHAT_SUBSCRIPTION: "s",
    PORT: "3000", ADMIN_PASSWORD: "pw", SESSION_KEEPALIVE: "1", MCP_TOOL_TIMEOUT: "9",
    CG_LIVE_CONTAINER: "1", CG_LIVE_IMAGE: "img", CG_BROWSER_EXECUTABLE: "/chrome", CG_UI_SCREENSHOTS: "1",
    CG_ACTIVITY_SCREENSHOT: "1",
  };
  const env = testEnvironment(daemon);
  assert.deepEqual(Object.keys(env).sort(), [
    "CG_ACTIVITY_SCREENSHOT", "CG_BROWSER_EXECUTABLE", "CG_LIVE_CONTAINER", "CG_LIVE_IMAGE", "CG_UI_SCREENSHOTS",
    "HOME", "LANG", "NODE_OPTIONS", "PATH", "TZ",
  ]);
  assert.equal(isDeploymentVariable("CG_GATEWAY_CAPABILITY"), true);
  assert.equal(isDeploymentVariable("PATHEXT"), false);
});

test("run-tests.mjs spawns the suite with the scrubbed environment", async () => {
  const { readFileSync } = await import("node:fs");
  const runner = readFileSync(new URL("../scripts/run-tests.mjs", import.meta.url), "utf8");
  assert.match(runner, /import \{ testEnvironment \} from "\.\/test-env\.mjs";/);
  assert.match(runner, /const testEnv = testEnvironment\(process\.env\);/);
  assert.match(runner, /env: testEnv,/);
});
