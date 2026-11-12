// A person's OWN settings, independent of any chat surface: the masked snapshot the browser
// Settings page renders and the closed set of changes it may make. Every write targets the
// authenticated owner only and goes through the same stores as Slack Settings → You, so
// validation, audit lines and live-relay revocation cannot differ between surfaces. Secret
// values are write-only: the snapshot carries configured/last4 facts and never a value.
import { getComposioMode, userNudgesEnabled } from "../config/settings.js";
import { toolboxUrl } from "./mcp-catalog.js";
import { getUser, setUser } from "../config/store.js";
import { MIN_MASKABLE_LENGTH, assertValidEnvName, assertValidEnvValue } from "../config/channel-env.js";
import { listUserEnv, patchUserEnv } from "../config/scoped-env.js";
import { revokeRemoteMcpsForAuthor } from "../mcp/remote-mcp-registry.js";
import { CUSTOM_MCP_LIMIT } from "./custom-mcps.js";
import { listUserCustomMcps, removeUserCustomMcp, saveUserCustomMcp } from "./custom-mcp-store.js";
import { listUserEmailAccounts, removeUserEmailAccount, saveUserEmailAccount } from "./email-account-store.js";
import { canSeeSkill, grantSkillsToUser, revokeSkillsFromUser } from "./skills/authoring.js";
import { isForeignPersonalSkill, sanitizeSkillGrantNames } from "./access-grants.js";
import { getSkill, listSkills } from "./skills/catalog.js";
import { MAX_KEYS_PER_USER, addSshKey, exportHostAuthorizedKeys, listSshKeys, removeSshKey } from "./ssh-access.js";
import { logEvent } from "../util/logger.js";

export class UserSettingsError extends Error {
  constructor(message, { status = 400, field = "" } = {}) {
    super(String(message || "That change couldn't be saved.").slice(0, 240));
    this.status = status;
    this.field = field;
  }
}

const masked = (value) => {
  const text = typeof value === "string" ? value : "";
  return { configured: Boolean(text), last4: text.length >= MIN_MASKABLE_LENGTH ? text.slice(-4) : "" };
};
const str = (value, max = 4096) => typeof value === "string" ? value.trim().slice(0, max) : "";
const fail = (message, field = "") => { throw new UserSettingsError(message, { field }); };

/** The skills a person may add to their own runs, those already added, and stale foreign grants. */
export async function personalSkillPicker(userId, isAdmin) {
  const stored = sanitizeSkillGrantNames((await getUser(userId))?.skills || []);
  const mine = new Set(stored.map((slug) => slug.toLowerCase()));
  const rows = listSkills({ viewer: isAdmin ? "*" : userId })
    .filter((skill) => canSeeSkill(skill, { userId, isAdmin, active: mine.has(skill.slug.toLowerCase()) }) && (skill.visibility !== "personal" || skill.createdBy === userId));
  // Stored grants of someone else's personal skill are never offered; they are named so the
  // person knows why they are not loaded (the run skips them — src/gateway/access-grants.js).
  const offered = new Set(rows.map((skill) => skill.slug.toLowerCase()));
  const foreign = stored.filter((slug) => !offered.has(slug.toLowerCase()) && isForeignPersonalSkill(getSkill(slug), userId));
  return {
    options: rows.map((skill) => ({ key: skill.slug, label: skill.slug, description: skill.description || "" })),
    selected: rows.filter((skill) => mine.has(skill.slug.toLowerCase())).map((skill) => skill.slug),
    foreign,
  };
}

/** Everything the Settings page shows for `userId`, masked. */
export async function userSettingsSnapshot(userId) {
  const user = (await getUser(userId)) || {};
  const isAdmin = Boolean(user.isAdmin);
  const [variables, mcps, email, skills, keys] = await Promise.all([
    listUserEnv(userId).catch(() => []),
    listUserCustomMcps(userId).catch(() => []),
    listUserEmailAccounts(userId).catch(() => []),
    personalSkillPicker(userId, isAdmin).catch(() => ({ options: [], selected: [], foreign: [] })),
    listSshKeys(userId).catch(() => []),
  ]);
  return {
    account: { id: userId, name: str(user.name, 120), role: isAdmin ? "admin" : user.approved ? "member" : "guest" },
    general: { nudges: userNudgesEnabled(user) },
    connections: {
      composioMode: getComposioMode() === "sdk" ? "sdk" : "personal",
      composio: { ...masked(user.composioToken), label: str(user.composioTokenLabel, 80) },
      toolbox: masked(user.toolboxToken),
      toolboxServer: String(toolboxUrl() || "").replace(/^https:\/\//, "").slice(0, 200),
      email: email.map((account) => ({ name: account.name, address: account.address, displayName: account.displayName || "",
        imap: account.imap, smtp: account.smtp, sendEnabled: account.sendEnabled !== false, verifiedAt: account.verifiedAt || "" })),
    },
    mcps: {
      limit: CUSTOM_MCP_LIMIT,
      servers: mcps.map((entry) => ({ name: entry.name, serverName: entry.serverName, url: entry.url, authType: entry.authType,
        tokenLast4: entry.tokenLast4 || "", headers: (entry.headers || []).length, queryParams: (entry.queryParams || []).length, setAt: entry.setAt || "" })),
    },
    variables: variables.map((entry) => ({ name: entry.name, exposure: entry.exposure, hosts: entry.hosts || [],
      last4: entry.last4 || "", provider: entry.provider, setAt: entry.setAt || 0 })),
    skills,
    ssh: { max: MAX_KEYS_PER_USER, keys: keys.map((key) => ({ id: key.id, fingerprint: key.fingerprint, type: key.type,
      label: key.label || "", createdAt: key.createdAt || 0, lastUsedAt: key.lastUsedAt ?? null })) },
  };
}

function exportSshKeys() {
  try { return exportHostAuthorizedKeys(); } catch (error) { return { written: false, reason: String(error?.message || error) }; }
}

const EMAIL_FIELDS = ["address", "displayName", "imapHost", "imapPort", "imapUser", "imapPassword", "smtpHost", "smtpPort", "smtpUser", "smtpPassword"];

/**
 * Apply ONE change to `userId`'s own settings. `input.action` picks it from a closed set; any
 * other field (an owner, a role, a scope) is ignored. `authorize` re-checks the caller's
 * authority after slow work (DNS, mail logins) right before the write. → `{ notice }`.
 */
export async function applyUserSettingsChange(userId, input = {}, { authorize = async () => {} } = {}) {
  if (!userId) throw new UserSettingsError("No user to change.", { status: 403 });
  const action = typeof input?.action === "string" ? input.action : "";
  const user = (await getUser(userId)) || {};
  switch (action) {
    case "nudges": {
      if (typeof input.enabled !== "boolean") fail("Choose on or off.");
      await authorize();
      await setUser(userId, { nudges: input.enabled });
      await logEvent("user_nudges_changed", { author: userId, enabled: input.enabled, via: "activity_settings" });
      return { notice: `Quiet-thread reminders are ${input.enabled ? "on" : "off"}.` };
    }
    case "composio.save": {
      if (getComposioMode() === "sdk") fail("Composio runs in SDK mode on this gateway; your session is created automatically.");
      const token = str(input.token), label = input.label === undefined ? undefined : str(input.label, 80);
      if (token && token.length < 6) fail("That doesn't look like a valid Composio token.", "token");
      if (!token && !user.composioToken) fail("Enter the token.", "token");
      await authorize();
      await setUser(userId, { ...(token ? { composioToken: token } : {}), ...(label !== undefined ? { composioTokenLabel: label } : {}) });
      await logEvent("user_connection_updated", { user: userId, connection: "composio", via: "activity_settings" });
      return { notice: "Saved your Composio account. Your next run uses it." };
    }
    case "toolbox.save": {
      const token = str(input.token);
      if (!token) fail("Enter the token.", "token");
      if (token.length < 6) fail("That doesn't look like a valid Toolbox token.", "token");
      await authorize();
      await setUser(userId, { toolboxToken: token });
      await logEvent("user_connection_updated", { user: userId, connection: "toolbox", via: "activity_settings" });
      return { notice: "Saved your Toolbox token. Your next run uses it." };
    }
    case "composio.remove":
    case "toolbox.remove": {
      const kind = action.split(".")[0];
      await authorize();
      await setUser(userId, kind === "composio" ? { composioToken: "", composioTokenLabel: "" } : { toolboxToken: "" });
      revokeRemoteMcpsForAuthor(userId);
      await logEvent("user_connection_removed", { user: userId, connection: kind, via: "activity_settings" });
      return { notice: `Removed your ${kind === "composio" ? "Composio account" : "Toolbox token"}. Runs in progress stop using it.` };
    }
    case "mcp.save": {
      const name = str(input.name, 80), url = str(input.url, 2048), token = str(input.token);
      const authType = input.authType === undefined ? undefined : str(input.authType, 20);
      if (authType !== undefined && !["bearer", "composio"].includes(authType)) fail("Choose Bearer token or Composio consumer key.", "authType");
      try {
        const servers = await saveUserCustomMcp(userId, { name, url, token, ...(authType ? { authType } : {}) }, { actor: userId, authorize });
        const saved = servers.find((item) => item.name === name.toLowerCase());
        return { notice: `Saved ${saved?.serverName || name}. Its tools reach your next run.` };
      } catch (error) {
        if (error instanceof UserSettingsError || error?.status) throw error;
        fail(error.message, /token|key/i.test(error.message) ? "token" : /url|address|host/i.test(error.message) ? "url" : "name");
      }
      break;
    }
    case "mcp.remove": {
      const name = str(input.name, 80);
      if (!name) fail("Choose a server.");
      await authorize();
      try { await removeUserCustomMcp(userId, name, { actor: userId }); } catch (error) { fail(error.message); }
      return { notice: `Removed my-${name.toLowerCase()}. Runs stop receiving it, including any in progress.` };
    }
    case "email.save": {
      const fields = { name: str(input.name, 80) };
      for (const key of EMAIL_FIELDS) if (input[key] !== undefined && input[key] !== null) fields[key] = String(input[key]).slice(0, 1024);
      if (input.sendEnabled !== undefined) fields.sendEnabled = input.sendEnabled === true;
      try {
        await saveUserEmailAccount(userId, fields, { actor: userId, authorize });
        return { notice: `Email account ${fields.name.toLowerCase()} saved (IMAP and SMTP logins verified).` };
      } catch (error) {
        if (error?.status) throw error;
        fail(error.message);
      }
      break;
    }
    case "email.remove": {
      const name = str(input.name, 80);
      if (!name) fail("Choose an account.");
      await authorize();
      try { await removeUserEmailAccount(userId, name, { actor: userId }); } catch (error) { fail(error.message); }
      return { notice: `Removed email account ${name.toLowerCase()}. Runs stop using it, including any in progress.` };
    }
    case "variable.save": {
      let name;
      try { name = assertValidEnvName(input.name); } catch (error) { fail(error.message, "name"); }
      if (typeof input.value !== "string" || !input.value) fail("Enter a value.", "value");
      try { assertValidEnvValue(input.value); } catch (error) { fail(error.message, "value"); }
      const exists = (await listUserEnv(userId)).some((entry) => entry.name === name);
      await authorize();
      // A replaced value keeps its type and allowed servers; a new one is hidden unless the
      // person says it must be readable (a password or connection string used outside HTTPS).
      const set = exists ? { name, value: input.value } : { name, value: input.value, exposure: input.readable === true ? "readable" : "hidden" };
      try { await patchUserEnv(userId, { set }); } catch (error) { fail(error.message, "name"); }
      await logEvent("user_env_set", { user: userId, name, actor: userId, via: "activity_settings" });
      return { notice: exists ? `Replaced ${name}. The old value stops working now.` : `Added ${name}. It reaches your next run.` };
    }
    case "variable.remove": {
      const name = str(input.name, 80);
      if (!(await listUserEnv(userId)).some((entry) => entry.name === name)) fail(`${name || "That variable"} no longer exists.`);
      await authorize();
      await patchUserEnv(userId, { remove: name });
      await logEvent("user_env_removed", { user: userId, name, actor: userId, via: "activity_settings" });
      return { notice: `Removed ${name}.` };
    }
    case "skills.save": {
      if (!Array.isArray(input.selected) || input.selected.length > 200 || !input.selected.every((slug) => typeof slug === "string")) fail("Choose skills from the list.");
      const picker = await personalSkillPicker(userId, Boolean(user.isAdmin));
      const allowed = new Map(picker.options.map((option) => [option.key.toLowerCase(), option.key]));
      const picked = [...new Set(input.selected.map((slug) => slug.toLowerCase()))];
      const refused = picked.find((slug) => !allowed.has(slug));
      if (refused) fail(`${refused} is not available to you.`);
      const current = new Set(picker.selected.map((slug) => slug.toLowerCase()));
      const added = picked.filter((slug) => !current.has(slug)).map((slug) => allowed.get(slug));
      const removed = picker.selected.filter((slug) => !picked.includes(slug.toLowerCase()));
      await authorize();
      if (added.length) await grantSkillsToUser(userId, added);
      if (removed.length) await revokeSkillsFromUser(userId, removed);
      await logEvent("user_skills_updated", { user: userId, added, removed, via: "activity_settings" });
      return { notice: added.length || removed.length ? "Your skills are saved. They apply to the next run you start." : "No skill changes." };
    }
    case "ssh.add": {
      const key = str(input.publicKey, 16_384), label = str(input.label, 80);
      if (!key) fail("Paste your public key.", "publicKey");
      await authorize();
      let result;
      try { result = await addSshKey(userId, key, { label }); } catch (error) { fail(error.message, "publicKey"); }
      const exported = exportSshKeys();
      return { notice: `${result.created ? "Registered" : "Already registered"} ${result.key.fingerprint}.${exported.written ? "" : " The gateway host is not set up for SSH yet; the key is stored and exported once it is."}` };
    }
    case "ssh.remove": {
      const id = str(input.id, 200);
      await authorize();
      const removed = await removeSshKey(userId, id);
      if (!removed) fail("That key is no longer registered.");
      exportSshKeys();
      return { notice: `Removed ${removed.fingerprint}. Channel grants stop working for it now.` };
    }
    default:
      fail("Unknown setting.");
  }
  return { notice: "" };
}
