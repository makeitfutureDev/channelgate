// Only provider-supplied identity data may enter this module. Never use message text,
// a display name, a stored editable profile or a caller-supplied run-API author as an email.
import { domainToASCII } from "node:url";
import { getSettings } from "../config/settings.js";
import { getUser, setUser } from "../config/store.js";
import { logEvent } from "../util/logger.js";

export function normalizeApprovalDomains(value) {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError("Provide at most 100 email domains.");
  return [...new Set(value.map(raw => {
    if (typeof raw !== "string") throw new TypeError("Each domain must be text.");
    const input = raw.trim().toLowerCase();
    if (!/^[\p{L}\p{N}\p{M}.-]+$/u.test(input)) throw new TypeError("Enter exact email domains, without @, URLs or wildcards.");
    const domain = domainToASCII(input);
    if (!domain || domain.length > 253 || !domain.includes(".") ||
        !domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new TypeError("Enter exact email domains, without @, URLs or wildcards.");
    }
    return domain;
  }))];
}

export function getAutoApprovalPolicy() {
  const settings = getSettings();
  try {
    return { enabled: settings.userAutoApprovalEnabled === true,
      domains: normalizeApprovalDomains(settings.userAutoApprovalDomains || []) };
  } catch { return { enabled: false, domains: [] }; }
}

export function matchingApprovalDomain(email, policy = getAutoApprovalPolicy()) {
  if (!policy.enabled || typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email)) return "";
  try {
    const [domain] = normalizeApprovalDomains([email.split("@")[1]]);
    return policy.domains.includes(domain) ? domain : "";
  } catch { return ""; }
}

export function eligibleForAutoApproval(user) {
  return Boolean(user && !user.isAdmin && !user.approved && !user.autoApprovalBlocked);
}

export function slackIdentityEmail(user, userId) {
  if (!user || user.id !== userId || user.deleted || user.is_bot || user.is_app_user || userId === "USLACKBOT") return "";
  return user.profile?.email || "";
}

export async function autoApproveUser(userId, email, platform) {
  if (!matchingApprovalDomain(email)) return false;
  let domain = "";
  await setUser(userId, current => {
    if (!eligibleForAutoApproval(current)) return null;
    // Policy and manual revocation are rechecked inside the store's SQLite write lock.
    domain = matchingApprovalDomain(email);
    return domain ? { approved: true, approvalSource: "domain", approvalDomain: domain,
      approvedAt: new Date().toISOString() } : null;
  });
  if (!domain) return false;
  await logEvent("user_domain_auto_approved", { author: userId, platform, domain });
  return true;
}

export async function autoApproveSlackUser(client, userId) {
  if (!getAutoApprovalPolicy().enabled || !eligibleForAutoApproval(await getUser(userId))) return false;
  try {
    const info = await client.users.info({ user: userId });
    return await autoApproveUser(userId, slackIdentityEmail(info.user, userId), "slack");
  } catch { return false; } // Missing email scope/provider failure never grants access.
}
