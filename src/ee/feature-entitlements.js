// Enterprise capabilities follow the same verified/offline grace state as existing entitlements.
import { getLicenseStatus } from "./license.js";

export const ENTERPRISE_FEATURES = Object.freeze({
  skillModelRouting: "Skill-specific engine and model switching",
  companyDomainApproval: "Company-domain automatic approval",
  channelCodexLogin: "Dedicated channel Codex sign-in",
  skillCatalogMcp: "Skill-catalog MCP access",
  organizationVariables: "Organization variables",
  driveSync: "Google Drive synchronization",
  skillTemplates: "Channel skill templates",
  channelSpendingLimits: "Per-channel spending limits",
});

export function enterpriseFeatureEnabled(key, now = Date.now()) {
  if (!Object.hasOwn(ENTERPRISE_FEATURES, key)) throw new TypeError(`Unknown Enterprise capability: ${key}`);
  return getLicenseStatus(now).features[key] === true;
}

export function requireEnterpriseFeature(key, now = Date.now()) {
  if (enterpriseFeatureEnabled(key, now)) return;
  const error = new Error(`${ENTERPRISE_FEATURES[key]} requires an active Enterprise license.`);
  error.status = error.statusCode = 403;
  error.code = "enterprise_required";
  throw error;
}
