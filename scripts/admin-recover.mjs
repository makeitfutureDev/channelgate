#!/usr/bin/env node
// Host-operator recovery: local settings/database filesystem access is the authority. This
// intentionally prints ONE short-lived setup link, never a password or persistent fallback.
import { adminAccountByUsername, createAdminEnrollment, ensureBootstrapAdmin, ensureUserAdminAccount, adminLinkRequired } from '../src/config/admin-accounts.js';
import { getPublicUrl } from '../src/config/settings.js';
// Match daemon bootstrap before any lazy runtime-path/settings access. Existing ambient
// variables take precedence, as with process.loadEnvFile() in server.js.
try { process.loadEnvFile(); } catch { /* no .env: use the ambient environment */ }
const args = process.argv.slice(2);
if (args.length !== 2 || !['--username', '--user'].includes(args[0])) {
  console.error('Usage: node scripts/admin-recover.mjs --user <existing platform user ID> (or --username <temporary operator username>)'); process.exitCode = 1;
} else {
  try {
    const publicUrl = getPublicUrl();
    if (!publicUrl || new URL(publicUrl).protocol !== 'https:') throw new Error('Configure the HTTPS Public URL before recovery.');
    ensureBootstrapAdmin();
    const a = args[0] === '--user' ? ensureUserAdminAccount(args[1]) : adminAccountByUsername(args[1]);
    if (args[0] === '--username' && a?.userId) throw new Error('Recover a linked administrator with --user and their existing platform user ID.');
    if (adminLinkRequired(a)) throw new Error('Recover an existing administrator with --user; unlinked operator recovery cannot bypass identity verification.');
    if (!a?.enabled) throw new Error('Enabled administrator not found.');
    // Explicit recovery revokes all account keys/sessions, then grants registration only.
    const token = createAdminEnrollment(a.id, { recover: true });
    console.log(`All passkeys and sessions for ${a.userId || a.username} were revoked. Open this single-use link within 15 minutes:`);
    console.log(`${new URL(publicUrl).origin}/login.html#setup=${token}`);
  } catch (error) { console.error(`Recovery failed: ${error.message}`); process.exitCode = 1; }
}
