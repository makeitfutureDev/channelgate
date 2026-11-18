// Boot-time warnings about how the admin surface is configured. Pure: the caller passes the facts
// and prints what comes back, so every rule is unit-tested without booting the daemon. A warning
// never changes behavior and never contains a secret value.
import { isHashedPassword } from "./password-hash.js";
import { isLoopbackHost } from "./security.js";

// ADMIN_PASSWORD from the environment is verified against but never rewritten (it belongs to
// whoever wrote .env, see passwordOk in auth.js), so unlike the settings.json copy it is not
// upgraded to a hash on login: a cleartext value there stays cleartext until the operator
// replaces it. And because a password set in the admin UI wins over it, an old .env value can sit
// unused for months and then silently become the admin password again the moment the UI one is
// removed.
function adminPasswordWarnings({ envPassword, settingsPassword }) {
  const env = typeof envPassword === "string" ? envPassword : "";
  if (!env) return [];
  const cleartext = !isHashedPassword(env);
  if (typeof settingsPassword === "string" && settingsPassword) {
    return [
      "ADMIN_PASSWORD in the environment (.env) is unused while a password is set in the admin UI, but it becomes the admin " +
        `password again if that one is removed${cleartext ? ", and it is stored in cleartext" : ""}. Delete the line from .env.`,
    ];
  }
  if (!cleartext) return [];
  return [
    "ADMIN_PASSWORD in the environment (.env) is stored in cleartext: anyone who can read that file or the daemon's " +
      "environment has the password itself. Replace the value with a hash (npm run hash-password), or set the password in " +
      "the admin UI, where it is stored hashed, and delete the line from .env.",
  ];
}

// A public URL on a loopback bind means remote callers arrive through a tunnel or reverse proxy
// on this host, so the socket address of every one of them is 127.0.0.1. Until the operator
// declares that proxy, all of them share ONE backoff bucket (see clientKey in security.js): a few
// bad passwords from anywhere delay the admin's own login and every approval link.
function proxyWarnings({ publicUrl, bindHost, trustProxy }) {
  if (!publicUrl || trustProxy || !isLoopbackHost(bindHost)) return [];
  return [
    "a Public URL is configured on a loopback bind but no reverse proxy is declared: every remote client shares one login " +
      "and approval-link backoff bucket, so failed attempts from anywhere delay everyone. Set Settings → Connection → " +
      "Behind a reverse proxy (trustProxy / CG_TRUST_PROXY: cloudflare or xff).",
  ];
}

export function bootPostureWarnings({ envPassword = "", settingsPassword = "", publicUrl = "", bindHost = "", trustProxy = "" } = {}) {
  return [...adminPasswordWarnings({ envPassword, settingsPassword }), ...proxyWarnings({ publicUrl, bindHost, trustProxy })];
}
