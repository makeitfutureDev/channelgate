#!/usr/bin/env node
// Host-operator recovery: local settings/database filesystem access is the authority. This
// intentionally prints ONE short-lived setup link, never a password or persistent fallback.
import { adminAccountByUsername, createAdminEnrollment, ensureBootstrapAdmin } from '../src/config/admin-accounts.js';
import { getPublicUrl } from '../src/config/settings.js';
// Match daemon bootstrap before any lazy runtime-path/settings access. Existing ambient
// variables take precedence, as with process.loadEnvFile() in server.js.
try { process.loadEnvFile(); } catch { /* no .env: use the ambient environment */ }
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--username') {
  console.error('Usage: node scripts/admin-recover.mjs --username <admin username>'); process.exitCode = 1;
} else {
  try {
    const publicUrl = getPublicUrl();
    if (!publicUrl || new URL(publicUrl).protocol !== 'https:') throw new Error('Configure the HTTPS Public URL before recovery.');
    ensureBootstrapAdmin();
    const a = adminAccountByUsername(args[1]);
    if (!a?.enabled) throw new Error('Enabled administrator not found.');
    // Explicit recovery revokes all account keys/sessions, then grants registration only.
    const token = createAdminEnrollment(a.id, { recover: true });
    console.log(`All passkeys and sessions for ${a.username} were revoked. Open this single-use link within 15 minutes:`);
    console.log(`${new URL(publicUrl).origin}/login.html#setup=${token}`);
  } catch (error) { console.error(`Recovery failed: ${error.message}`); process.exitCode = 1; }
}
