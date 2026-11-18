import test from "node:test";
import assert from "node:assert/strict";
import { normalizeComposioSdkPolicy, composioSessionPolicy } from "../src/config/composio-sdk-policy.js";
import { paintComposioPolicy, readComposioPolicy, syncComposioPolicyUi } from "../public/admin-composio-policy.js";

test("multi-account defaults require explicit selection; empty restrictions never widen access", () => {
  assert.deepEqual(composioSessionPolicy(), {
    multiAccount: { enable: true, maxAccountsPerToolkit: 5, requireExplicitSelection: true }, toolkits: { disable: [] },
  });
  assert.deepEqual(composioSessionPolicy({ allowedApps: [] }).toolkits, { enable: [] });
  assert.deepEqual(normalizeComposioSdkPolicy({ allowedApps: [" Gmail ", "gmail", "custom_aioutreach"] }).allowedApps, ["custom_aioutreach", "gmail"]);
  for (const value of [null, "gmail", ["gmail"]]) assert.throws(() => normalizeComposioSdkPolicy(value));
  for (const allowedApps of [false, {}, ["gmail,slack"], ["https://example.com"], ["*"]]) assert.throws(() => composioSessionPolicy({ allowedApps }));
});

test("settings controls preserve selected-empty versus all, repaint changes and entitlement", () => {
  const controls = Object.fromEntries([".csdk-multi", ".csdk-max", ".csdk-app-mode", ".csdk-apps", ".csdk-app-list"].map((key) => [key, {}]));
  const root = { querySelector: (key) => controls[key], querySelectorAll: () => Object.values(controls) };
  paintComposioPolicy(root, { multiAccount: true, maxAccountsPerToolkit: 3, allowedApps: [] });
  syncComposioPolicyUi(root, { sdkMode: true, entitled: true });
  assert.equal(root.hidden, false);
  assert.equal(controls[".csdk-app-list"].hidden, false);
  assert.deepEqual(readComposioPolicy(root), { multiAccount: true, maxAccountsPerToolkit: 3, allowedApps: [] });
  controls[".csdk-apps"].value = "gmail, slack\ncustom_aioutreach";
  assert.deepEqual(readComposioPolicy(root).allowedApps, ["gmail", "slack", "custom_aioutreach"]);
  paintComposioPolicy(root, { multiAccount: false, allowedApps: null });
  syncComposioPolicyUi(root, { sdkMode: true, entitled: true });
  assert.equal(controls[".csdk-max"].disabled, true);
  assert.equal(controls[".csdk-app-list"].hidden, true);
  assert.equal(readComposioPolicy(root).allowedApps, null);
  syncComposioPolicyUi(root, { sdkMode: false, entitled: false });
  assert.equal(root.hidden, true);
  assert.equal(controls[".csdk-multi"].disabled, true);
});
