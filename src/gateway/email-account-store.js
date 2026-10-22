// The write side of email accounts (src/gateway/email-accounts.js holds the rules): add, update
// and remove one account on a channel or on a person. Every surface — the admin UI routes, the
// Slack Settings modal, the Teams/Google Chat settings and their private browser form — goes
// through here, so validation, the connection test and the audit line cannot differ between them.
// A save LOGS IN to both servers first (email-client.js) and refuses the record when either side
// fails: a stored account is one that worked. Audit rows carry the name, the address and the
// server hosts — never a password.
import { getChannelMeta, getUser, patchChannelMeta, setUser } from "../config/store.js";
import { logEvent } from "../util/logger.js";
import { verifyEmailAccount } from "./email-client.js";
import {
  findEmailAccount,
  listEmailAccounts,
  normalizeEmailAccountInput,
  normalizeEmailAccountName,
  patchEmailAccounts,
} from "./email-accounts.js";

function audit(record) {
  return { name: record.name, address: record.address, imapHost: record.imap.host, smtpHost: record.smtp.host };
}

// The connection test every save runs. Surfaces that reach the store through several layers (the
// Slack modal, the Teams/Google Chat settings) cannot pass `verify` down, so tests swap it here.
let defaultVerifier = verifyEmailAccount;
export function setEmailAccountVerifierForTests(fn) {
  defaultVerifier = typeof fn === "function" ? fn : verifyEmailAccount;
}

async function prepare(existingList, input, { verify, lookup }) {
  const existing = findEmailAccount(existingList, input?.name);
  const record = normalizeEmailAccountInput(input, existing);
  await (verify || defaultVerifier)(record, lookup ? { lookup } : {});
  return record;
}

/** Add or update one of a channel's email accounts (tested first). Returns the masked list. */
export async function saveChannelEmailAccount(slug, input = {}, { actor = "", verify, lookup, authorize, now } = {}) {
  if (!slug) throw new Error("No conversation to change.");
  const current = await getChannelMeta(slug);
  const record = await prepare(current?.emailAccounts, input, { verify, lookup });
  // Interactive surfaces may need to re-check access after the slow connection test.
  if (authorize) await authorize();
  const saved = await patchChannelMeta(slug, (existing) => ({
    emailAccounts: patchEmailAccounts(existing?.emailAccounts, { set: record, actor, now }),
  }));
  logEvent("channel_email_account_set", { slug, ...audit(record), actor });
  return listEmailAccounts(saved?.emailAccounts, "channel");
}

/** Remove one of a channel's email accounts. Returns the masked list. */
export async function removeChannelEmailAccount(slug, name, { actor = "" } = {}) {
  const stored = normalizeEmailAccountName(name);
  const saved = await patchChannelMeta(slug, (existing) => ({
    emailAccounts: patchEmailAccounts(existing?.emailAccounts, { remove: stored }),
  }));
  logEvent("channel_email_account_removed", { slug, name: stored, actor });
  return listEmailAccounts(saved?.emailAccounts, "channel");
}

/** A person's own email accounts, masked. */
export async function listUserEmailAccounts(userId) {
  return listEmailAccounts((await getUser(userId))?.emailAccounts, "user");
}

/** Add or update one of a person's own email accounts (tested first). Returns the masked list. */
export async function saveUserEmailAccount(userId, input = {}, { actor = "", verify, lookup, authorize, now } = {}) {
  if (!userId) throw new Error("No user to change.");
  const record = await prepare((await getUser(userId))?.emailAccounts, input, { verify, lookup });
  if (authorize) await authorize();
  const next = patchEmailAccounts((await getUser(userId))?.emailAccounts, { set: record, actor: actor || userId, now });
  const saved = await setUser(userId, { emailAccounts: next });
  logEvent("user_email_account_set", { userId, ...audit(record), actor: actor || userId });
  return listEmailAccounts(saved?.emailAccounts, "user");
}

/** Remove one of a person's own email accounts. Returns the masked list. */
export async function removeUserEmailAccount(userId, name, { actor = "" } = {}) {
  if (!userId) throw new Error("No user to change.");
  const stored = normalizeEmailAccountName(name);
  const next = patchEmailAccounts((await getUser(userId))?.emailAccounts, { remove: stored });
  const saved = await setUser(userId, { emailAccounts: next });
  logEvent("user_email_account_removed", { userId, name: stored, actor: actor || userId });
  return listEmailAccounts(saved?.emailAccounts, "user");
}
