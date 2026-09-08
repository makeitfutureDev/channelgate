// Managed automatic updates are an Enterprise feature. Manual host updates remain available.
import { getLicenseStatus } from "./license.js";

export const MANUAL_UPDATE_MESSAGE = "Automatic updates require an active Enterprise license. Manage this installation manually on its host using the update instructions in INSTALL.md.";

export function hasAutomaticUpdateEntitlement(now = Date.now()) {
  return getLicenseStatus(now).features.automaticUpdates;
}
