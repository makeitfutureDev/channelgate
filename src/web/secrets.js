// Explicit, re-authenticated, audited reveal of ONE stored secret.
//
// The admin API used to return every token in cleartext on /api/settings, /api/channels and
// /api/users, purely so the UI's eye toggle could show them. That made the blast radius of any
// admin-surface weakness — a stolen session cookie, a tunnel misconfiguration — the entire
// workspace's credential set at once, including each person's personal Composio token (which
// grants their Gmail/HubSpot/Slack). Listing endpoints now return has*/last4 only, and a value is
// handed over one at a time, on request, by someone who can re-enter the admin password.
//
// The allowlist below is the whole point: the endpoint resolves a NAMED field to a getter, so it
// can never be turned into "read me an arbitrary property of the config".
import { getSettings } from "../config/settings.js";
import { getUsers, getChannelMeta } from "../config/store.js";

// scope → field → how to read it. `id` is the user id / channel slug for the scoped kinds.
const READERS = {
  settings: {
    slackBotToken: (s) => s.slackBotToken,
    slackAppToken: (s) => s.slackAppToken,
    slackSigningSecret: (s) => s.slackSigningSecret,
    slackAdminUserToken: (s) => s.slackAdminUserToken,
    defaultComposioToken: (s) => s.defaultComposioToken,
    defaultSkillsToken: (s) => s.defaultSkillsToken,
    defaultToolboxToken: (s) => s.defaultToolboxToken,
    composioSdkApiKey: (s) => s.composioSdkApiKey,
    apiKey: (s) => s.apiKey,
    driveSyncKeyJson: (s) => s.driveSyncKeyJson,
    // The ChannelGate license key. Listings return hasLicenseKey/licenseKeyLast4 only; an admin
    // who needs the value back (to move the deployment, or to hand it to a colleague) fetches it
    // here, at the cost of re-entering the admin password.
    licenseKey: (s) => s.licenseKey,
  },
  user: {
    composioToken: (u) => u.composioToken,
    skillsToken: (u) => u.skillsToken,
    toolboxToken: (u) => u.toolboxToken,
  },
  channel: {
    composioToken: (m) => m.composioToken,
    skillsToken: (m) => m.skillsToken,
    toolboxToken: (m) => m.toolboxToken,
    makeToolboxKey: (m) => m.makeToolboxKey,
  },
};

// Deliberately NOT here: adminPassword. It is stored as a scrypt hash, so there is nothing to
// reveal, and a "reveal the password" affordance is exactly what an attacker with a live session
// would reach for.

export function revealableFields(scope) {
  return Object.keys(READERS[scope] || {});
}

// Resolve one secret. Throws for an unknown scope/field so a typo fails loudly rather than
// silently returning "". Returns "" when the field simply isn't set.
export async function readSecret({ scope, field, id = "" }) {
  // Own-property checks, not truthiness: `field: "__proto__"` resolves to Object.prototype and
  // `"constructor"` to a callable, both of which would slip past a `!readers[field]` guard — the
  // first as a 500, the second as a nonsense value. An allowlist has to actually be one.
  if (!Object.hasOwn(READERS, String(scope))) throw new Error(`unknown scope "${scope}"`);
  const readers = READERS[scope];
  if (!Object.hasOwn(readers, String(field))) throw new Error(`"${field}" is not revealable`);
  const read = readers[field];

  if (scope === "settings") return String(read(getSettings()) || "");
  if (scope === "user") {
    const user = (await getUsers())[id];
    if (!user) throw new Error("unknown user");
    return String(read(user) || "");
  }
  const meta = (await getChannelMeta(id)) || {};
  return String(read(meta) || "");
}
