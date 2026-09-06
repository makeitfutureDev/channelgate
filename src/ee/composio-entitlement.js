// Enterprise-only Composio SDK integration (Beta). See LICENSE-EE.md.
import { getLicenseStatus } from "./license.js";

export function hasComposioSdkEntitlement(now = Date.now()) {
  return getLicenseStatus(now).features.composioSdk;
}

export function requireComposioSdkEntitlement() {
  if (!hasComposioSdkEntitlement()) {
    throw new Error("Composio SDK (Beta) requires an active Enterprise license");
  }
}
