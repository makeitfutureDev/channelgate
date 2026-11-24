// One-time boot step: a channel's own Codex account (the legacy `codex-channel` harness, signed in
// from the channel's Runtime tab) becomes an ordinary engine license limited to that channel.
//
// What moves, per channel whose meta says `codexAuthSource: "channel"`:
//   • a ChatGPT sign-in → a `codex-login` license limited to the channel. Its login DIRECTORY is
//     renamed into the license's own sign-in directory (engine-state/licenses/<id>), so the same
//     auth.json — refresh token included — keeps answering, and nobody signs in again. A rename,
//     never a copy: Codex rotates the refresh token, and two copies would log each other out.
//   • an API-key sign-in → a `codex-api` license on the OpenAI API with that key, limited to the
//     channel. The old directory is renamed into the license's directory too (direct-host session
//     transcripts live there); the key file inside it is removed, the record holds the key.
//   • no sign-in → nothing to carry: the channel simply stops naming the legacy harness.
// Then everything that named `codex-channel` for that channel — its default, its pool, its
// approved-harness lock, thread pins and pools, session stamps and schedules — names the new
// license id, and `codexAuthSource` returns to "gateway". `codexChannelLicense` on the meta tells
// the license's runner to carry a resumed thread's rollout from the old in-container directory
// (`~/.codex-channel`, and `~/.codex` for the oldest threads) into the license's own one.
//
// Idempotent and crash-safe: the license id chosen for a channel is recorded in `_meta`
// (`channel_codex_license:<channelId>`) BEFORE anything else moves, so a rerun after a crash
// reuses it; the whole pass is flagged done in `_meta` (`channel_codex_licenses_v1`). It never
// fails a boot: a channel that cannot be moved keeps the legacy harness, which still runs.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
// Note: a ChatGPT `codex-login` license requires a ChatGPT sign-in (engines/codex-eu.js), so an
// API-key login cannot be adopted as one and becomes a provider (`codex-api`) license instead.
import path from "node:path";
import { getDb, metaGet, metaSet } from "../db/index.js";
import { getSettings, saveSettings } from "../config/settings.js";
import { readCodexAuthState } from "../engines/codex-auth.js";
import {
  LICENSE_KINDS, MAX_LICENSE_NAME_LENGTH, cleanLicenseName, licenseKindOfId, licenseLoginHome, licenseTypeFromPlan,
  normalizeLicenseRecord, normalizeLicenseRecords,
} from "../engines/license-state.js";
import { channelCodexHome } from "./channel-codex-paths.js";

export const MIGRATION_FLAG = "channel_codex_licenses_v1";
const LEGACY = "codex-channel";
const mappingKey = (channelId) => `channel_codex_license:${channelId}`;

const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

function planOf(home) {
  const raw = parse(readFileSafe(path.join(home, "auth.json")));
  const token = raw?.tokens?.access_token;
  if (typeof token !== "string") return "";
  const claims = parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8"));
  return String(claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type || "");
}
function readFileSafe(file) { try { return readFileSync(file, "utf8"); } catch { return ""; } }

// A name no other license (added or shipped) carries; the store re-checks on every later edit.
function uniqueLabel(base, taken) {
  const lower = new Set(taken.map((label) => String(label).toLowerCase()));
  const stem = cleanLicenseName(base).slice(0, MAX_LICENSE_NAME_LENGTH) || "Codex (channel account)";
  if (!lower.has(stem.toLowerCase())) return stem;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`;
    const candidate = `${stem.slice(0, MAX_LICENSE_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem.slice(0, MAX_LICENSE_NAME_LENGTH - 9)} ${randomBytes(4).toString("hex")}`;
}

const swap = (value, id) => (value === LEGACY ? id : value);
const swapList = (list, id) => (Array.isArray(list) ? [...new Set(list.map((entry) => swap(entry, id)))] : list);
function swapPoolText(text, id) {
  const parsed = parse(text);
  return Array.isArray(parsed) ? JSON.stringify(swapList(parsed, id)) : text;
}

// Creates (or finds, on a rerun) the license for one channel's sign-in. → the license id, or "".
function adoptLogin({ channelId, name, auth, home, log }) {
  const existing = metaGet(mappingKey(channelId));
  const records = normalizeLicenseRecords(getSettings().engineLicenses);
  if (existing && records.some((record) => record.id === existing)) return existing;
  const kind = auth.method === "api-key" ? LICENSE_KINDS["codex-api"] : LICENSE_KINDS["codex-login"];
  let apiKey = "";
  if (auth.method === "api-key") {
    apiKey = String(parse(readFileSafe(path.join(home, "auth.json")))?.OPENAI_API_KEY || "").trim();
    if (!apiKey) return "";
  }
  const id = existing && licenseKindOfId(existing)?.id === kind.id ? existing : `${kind.prefix}${randomBytes(4).toString("hex")}`;
  // Recorded first: a crash after this line reuses the same id (and directory) on the next boot.
  metaSet(mappingKey(channelId), id);
  saveSettings((current) => {
    const list = normalizeLicenseRecords(current.engineLicenses);
    if (list.some((record) => record.id === id)) return {};
    const label = uniqueLabel(`Codex · ${name || channelId}`, [...list.map((record) => record.label), "Default sign-in"]);
    const type = kind.id === "codex-login" ? (licenseTypeFromPlan("codex", planOf(home)) || kind.types[0]) : kind.types[0];
    const record = normalizeLicenseRecord({
      id, kind: kind.id, label, type, createdAt: new Date().toISOString(), channelId,
      ...(kind.provider ? { baseUrl: kind.defaultBaseUrl, apiKey, authScheme: kind.authSchemes[0], models: [] } : {}),
    });
    if (!record) throw new Error("the license record could not be built");
    const enabled = current.engineEnabled && typeof current.engineEnabled === "object" ? current.engineEnabled : {};
    return { engineLicenses: [...list, record], engineEnabled: { ...enabled, [id]: true } };
  });
  log(`[licenses] channel ${channelId}: its own Codex account is now the license ${id}`);
  return id;
}

// The login directory follows the license. A rename keeps the one auth.json the CLI refreshes.
function moveLoginDirectory(home, id, { apiKey }) {
  const target = licenseLoginHome(id);
  if (existsSync(home) && !existsSync(target)) {
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    renameSync(home, target);
  }
  // The API key now lives in the (write-only) license record; the provider license never reads
  // an auth.json, and leaving the key in one would be a second, forgotten copy.
  if (apiKey && existsSync(path.join(target, "auth.json"))) {
    const parsed = parse(readFileSafe(path.join(target, "auth.json")));
    if (parsed && typeof parsed === "object" && "OPENAI_API_KEY" in parsed && !parsed.tokens) rmSync(path.join(target, "auth.json"), { force: true });
    else if (parsed && typeof parsed === "object") { delete parsed.OPENAI_API_KEY; writeFileSync(path.join(target, "auth.json"), JSON.stringify(parsed), { mode: 0o600 }); }
  }
}

// Every stored reference to the legacy harness in one channel → the license id ("" = drop it).
function repoint(db, slug, meta, id) {
  const next = { ...meta, codexAuthSource: "gateway" };
  if (id) {
    next.engine = swap(meta.engine, id);
    next.approvedEngines = swapList(meta.approvedEngines, id);
    if (Array.isArray(meta.licensePool)) next.licensePool = swapList(meta.licensePool, id);
    next.codexChannelLicense = id;
  } else {
    if (meta.engine === LEGACY) { next.engine = ""; next.licensePool = ""; }
    if (Array.isArray(meta.approvedEngines)) next.approvedEngines = meta.approvedEngines.filter((entry) => entry !== LEGACY);
    if (Array.isArray(meta.licensePool)) next.licensePool = meta.licensePool.filter((entry) => entry !== LEGACY);
  }
  if (Array.isArray(next.approvedEngines) && !next.approvedEngines.length && Array.isArray(meta.approvedEngines) && meta.approvedEngines.length) {
    next.approvedEngines = ["harness:codex"];
  }
  db.prepare("UPDATE channel_meta SET data = ? WHERE slug = ?").run(JSON.stringify(next), slug);
  if (id) {
    db.prepare("UPDATE sessions SET engine = ? WHERE slug = ? AND engine = ?").run(id, slug, LEGACY);
    db.prepare("UPDATE thread_overrides SET value = ? WHERE slug = ? AND kind = 'engine' AND value = ?").run(id, slug, LEGACY);
  } else {
    db.prepare("DELETE FROM thread_overrides WHERE slug = ? AND kind = 'engine' AND value = ?").run(slug, LEGACY);
  }
  for (const row of db.prepare("SELECT thread_key, value FROM thread_overrides WHERE slug = ? AND kind = 'license_pool'").all(slug)) {
    const value = id ? swapPoolText(row.value, id) : (() => { const list = parse(row.value); return Array.isArray(list) ? JSON.stringify(list.filter((entry) => entry !== LEGACY)) : row.value; })();
    if (value !== row.value) db.prepare("UPDATE thread_overrides SET value = ? WHERE slug = ? AND thread_key = ? AND kind = 'license_pool'").run(value, slug, row.thread_key);
  }
  for (const row of db.prepare("SELECT id, data FROM schedules WHERE channel_id = ?").all(meta.channelId || "")) {
    const data = parse(row.data);
    if (!data || (data.engine !== LEGACY && !(Array.isArray(data.licensePool) && data.licensePool.includes(LEGACY)))) continue;
    const engine = id ? swap(data.engine, id) : data.engine === LEGACY ? "" : data.engine;
    const licensePool = Array.isArray(data.licensePool) ? (id ? swapList(data.licensePool, id) : data.licensePool.filter((entry) => entry !== LEGACY)) : data.licensePool;
    db.prepare("UPDATE schedules SET data = ? WHERE id = ?").run(JSON.stringify({ ...data, engine, ...(licensePool !== undefined ? { licensePool } : {}) }), row.id);
  }
}

export async function migrateChannelCodexAccounts({ log = (line) => console.log(line), readAuth = readCodexAuthState } = {}) {
  if (metaGet(MIGRATION_FLAG) === "1") return { skipped: true, migrated: [] };
  const db = getDb();
  const migrated = [];
  let failed = false;
  for (const row of db.prepare("SELECT slug, data FROM channel_meta").all()) {
    const meta = parse(row.data);
    if (!meta || meta.codexAuthSource !== "channel" || !meta.channelId) continue;
    try {
      const home = channelCodexHome(meta.channelId);
      const mapped = metaGet(mappingKey(meta.channelId));
      // A rerun after the directory already moved reads the login where it now lives.
      const where = !existsSync(home) && mapped && licenseKindOfId(mapped) ? licenseLoginHome(mapped) : home;
      const auth = await readAuth({ codexHome: where, hostCodexHome: where, env: {} });
      let id = "";
      if (auth.authenticated) {
        id = adoptLogin({ channelId: meta.channelId, name: meta.name, auth, home: where, log });
        if (id) moveLoginDirectory(home, id, { apiKey: licenseKindOfId(id)?.id === "codex-api" });
      } else if (mapped && normalizeLicenseRecords(getSettings().engineLicenses).some((record) => record.id === mapped)) {
        id = mapped; // moved on an earlier boot whose DB step did not complete
      }
      db.exec("BEGIN IMMEDIATE");
      try { repoint(db, row.slug, meta, id); db.exec("COMMIT"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
      migrated.push({ channelId: meta.channelId, slug: row.slug, license: id });
      if (!id) log(`[licenses] channel ${meta.channelId}: its own Codex account was not signed in; it now uses the gateway's licenses`);
    } catch (error) {
      failed = true;
      log(`[licenses] channel ${meta.channelId}: its own Codex account could not become a license (it keeps the legacy sign-in): ${error?.message || error}`);
    }
  }
  if (!failed) metaSet(MIGRATION_FLAG, "1");
  return { skipped: false, migrated, failed };
}
