// Non-secret organization policy for Composio SDK sessions. An explicit empty app list
// means no apps; null means unrestricted. Never turn malformed saved restrictions into all apps.
export function normalizeComposioSdkPolicy(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Composio SDK policy must be an object");
  const { multiAccount = true, maxAccountsPerToolkit = 5, allowedApps = null } = value;
  if (typeof multiAccount !== "boolean") throw new Error("Composio multi-account must be a boolean");
  if (!Number.isInteger(maxAccountsPerToolkit) || maxAccountsPerToolkit < 2 || maxAccountsPerToolkit > 10) {
    throw new Error("Composio accounts per app must be an integer from 2 to 10");
  }
  if (allowedApps !== null && (!Array.isArray(allowedApps) || allowedApps.length > 200
    || allowedApps.some((app) => typeof app !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(app.trim())))) {
    throw new Error("Composio allowed apps must be null or a list of up to 200 toolkit slugs");
  }
  return {
    multiAccount,
    maxAccountsPerToolkit,
    allowedApps: allowedApps === null ? null : [...new Set(allowedApps.map((app) => app.trim().toLowerCase()))].sort(),
  };
}

export function composioSessionPolicy(value) {
  const policy = normalizeComposioSdkPolicy(value);
  return {
    multiAccount: policy.multiAccount
      ? { enable: true, maxAccountsPerToolkit: policy.maxAccountsPerToolkit, requireExplicitSelection: true }
      // The live API rejects even require_explicit_selection:false when disabled.
      : { enable: false },
    toolkits: policy.allowedApps === null ? { disable: [] } : { enable: policy.allowedApps },
  };
}
