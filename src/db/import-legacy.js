// One-time import of the pre-SQLite JSON/JSONL files into the DB. Runs once per database (guarded
// by a `_meta.legacy_imported` flag) the first time getDb() opens after this code ships. It reads
// the OLD files but never deletes or edits them — they stay on disk as inert backups, so the
// migration is fully reversible until you choose to delete them by hand. Uses the passed handle
// directly (not getDb(), which would recurse). Everything is best-effort per file: a missing or
// unreadable legacy file just contributes nothing.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  configDir,
  channelsDir,
  logsDir,
  usersFile,
  channelsIndexFile,
  channelMetaFile,
  channelSessionsFile,
} from "../config/paths.js";
import { platformFolderNames } from "../platforms/registry.js";
// The legacy JSON predates the retirement of some integrations, so it can still carry their dead
// secrets. This import runs AFTER the migration that cleans the existing rows, so it has to strip
// them itself or it would put one straight back (see ../config/dead-fields.js).
import { stripDeadFields } from "../config/dead-fields.js";

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

// The first of these files that parses, or the fallback. Used for the per-channel files, which
// exist at two different paths depending on how far a machine got through the folder rename.
const readFirstJson = (files, fallback) => {
  for (const file of files) {
    const value = readJson(file, null);
    if (value !== null) return value;
  }
  return fallback;
};

export function importLegacy(db) {
  const flag = db.prepare("SELECT value FROM _meta WHERE key = 'legacy_imported'").get();
  if (flag?.value === "1") return;

  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-check under the write lock (another process may have imported first).
    if (db.prepare("SELECT value FROM _meta WHERE key = 'legacy_imported'").get()?.value === "1") {
      db.exec("COMMIT");
      return;
    }
    let counts = { users: 0, channels: 0, meta: 0, sessions: 0, schedules: 0, acks: 0, followups: 0, jobs: 0, usage: 0, events: 0 };

    // Users
    const users = readJson(usersFile(), {});
    const insUser = db.prepare("INSERT OR IGNORE INTO users(user_id, data) VALUES(?, ?)");
    for (const [uid, rec] of Object.entries(users)) {
      insUser.run(uid, JSON.stringify(stripDeadFields(rec)));
      counts.users++;
    }

    // Channels index + per-channel meta/sessions (dir name === slug).
    const index = readJson(channelsIndexFile(), {});
    const insChan = db.prepare("INSERT OR IGNORE INTO channels(channel_id, slug, data) VALUES(?, ?, ?)");
    const slugTaken = db.prepare("SELECT 1 FROM channels WHERE slug = ?");
    for (const [cid, entry] of Object.entries(index)) {
      // Migrations (incl. the unique slug index) run BEFORE this import, so OR IGNORE would
      // silently DROP a legacy duplicate — that channel would lose its folder/session mapping.
      // Repair the way migration 8 does instead: first entry keeps the slug, later ones get
      // -2/-3 … suffixes.
      let slug = entry.slug || "";
      for (let n = 2; slug && slugTaken.get(slug); n++) slug = `${entry.slug}-${n}`;
      insChan.run(cid, slug, JSON.stringify(slug === (entry.slug || "") ? entry : { ...entry, slug }));
      counts.channels++;
    }
    // The legacy JSON layout predates BOTH SQLite and the per-platform channel folders, so the
    // slugs sit directly under channels/ and are all Slack's. Platform folder names are skipped
    // explicitly: on a machine that somehow reaches this after the folders moved, "slack" is a
    // directory name here, and importing it as a slug would create a phantom channel.
    let slugs = [];
    try {
      const platformDirs = new Set(platformFolderNames());
      slugs = readdirSync(channelsDir(), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !platformDirs.has(d.name))
        .map((d) => d.name);
    } catch {
      slugs = [];
    }
    const insMeta = db.prepare("INSERT OR IGNORE INTO channel_meta(slug, data) VALUES(?, ?)");
    const insSess = db.prepare("INSERT OR IGNORE INTO sessions(slug, thread_key, session_id) VALUES(?, ?, ?)");
    // Read those slugs' files from the LEGACY layout, spelled out rather than through
    // channelMetaFile()/channelSessionsFile(). Those helpers moved with the platform-folder rename
    // and now resolve to channels/<platform>/<slug>/…, which is not where the tree this function
    // exists to read keeps them — a genuine pre-SQLite install has channels/<slug>/meta.json and
    // no platform level at all. Reading through the helpers silently imported nothing: every
    // channel's lockdown record and every thread→session mapping was dropped by the one upgrade
    // that was supposed to carry them across, with counts.meta = counts.sessions = 0 in the log.
    // The rename is also why the folder move cannot have happened yet: scripts/migrate-channelgate.mjs
    // reads the channel records from the STORE, which opens the database — running this import —
    // before it moves a single folder.
    //
    // The platform path is kept as a fallback for a half-migrated tree (folders moved, database
    // still fresh). Legacy first: on such a tree the legacy file is the one the daemon last wrote.
    const legacyChannelFile = (slug, name) => path.join(channelsDir(), slug, name);
    for (const slug of slugs) {
      const meta = readFirstJson([legacyChannelFile(slug, "meta.json"), channelMetaFile(slug)], null);
      if (meta) {
        insMeta.run(slug, JSON.stringify(stripDeadFields(meta)));
        counts.meta++;
      }
      const map = readFirstJson([legacyChannelFile(slug, "sessions.json"), channelSessionsFile(slug)], {});
      for (const [threadKey, sessionId] of Object.entries(map)) {
        if (!sessionId) continue;
        insSess.run(slug, threadKey, String(sessionId));
        counts.sessions++;
      }
    }

    // Schedules
    const schedules = readJson(path.join(configDir(), "schedules.json"), []);
    const insSched = db.prepare("INSERT OR IGNORE INTO schedules(id, channel_id, enabled, data) VALUES(?, ?, ?, ?)");
    for (const s of Array.isArray(schedules) ? schedules : []) {
      insSched.run(s.id, s.channelId || "", s.enabled ? 1 : 0, JSON.stringify(s));
      counts.schedules++;
    }

    // Acks
    const acks = readJson(path.join(configDir(), "acks.json"), []);
    const insAck = db.prepare("INSERT OR IGNORE INTO acks(id, channel_id, data) VALUES(?, ?, ?)");
    for (const a of Array.isArray(acks) ? acks : []) {
      insAck.run(a.id, a.channelId || "", JSON.stringify(a));
      counts.acks++;
    }

    // Followups: { threads: { key: rec }, done: { uid: { key: ms } } }
    const fu = readJson(path.join(configDir(), "followups.json"), { threads: {}, done: {} });
    const insThread = db.prepare("INSERT OR IGNORE INTO followup_threads(thread_key, data) VALUES(?, ?)");
    for (const [key, rec] of Object.entries(fu.threads || {})) {
      insThread.run(key, JSON.stringify(rec));
      counts.followups++;
    }
    const insDone = db.prepare("INSERT OR IGNORE INTO followup_done(user_id, thread_key, done_ms) VALUES(?, ?, ?)");
    for (const [uid, map] of Object.entries(fu.done || {})) {
      for (const [key, ms] of Object.entries(map || {})) insDone.run(uid, key, Number(ms) || 0);
    }

    // Background jobs
    const jobs = readJson(path.join(configDir(), "bg-jobs.json"), []);
    const insJob = db.prepare("INSERT OR IGNORE INTO bg_jobs(id, data) VALUES(?, ?)");
    for (const j of Array.isArray(jobs) ? jobs : []) {
      if (!j?.id) continue;
      insJob.run(j.id, JSON.stringify(j));
      counts.jobs++;
    }

    // Usage ledger: logs/usage-YYYY-MM.jsonl
    const insUsage = db.prepare(
      `INSERT INTO usage(ts, channel_id, slug, author_id, engine, model, task_kind, tokens_in, tokens_out, cost_usd, cost_estimated, duration_ms)
       VALUES(@ts, @channel_id, @slug, @author_id, @engine, @model, @task_kind, @tokens_in, @tokens_out, @cost_usd, @cost_estimated, @duration_ms)`
    );
    let logFiles = [];
    try {
      logFiles = readdirSync(logsDir());
    } catch {
      logFiles = [];
    }
    for (const f of logFiles.filter((f) => /^usage-\d{4}-\d{2}\.jsonl$/.test(f)).sort()) {
      for (const line of readFileSync(path.join(logsDir(), f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        insUsage.run({
          ts: r.ts || "",
          channel_id: r.channelId || "",
          slug: r.slug || "",
          author_id: r.authorId || "",
          engine: r.engine || "",
          model: r.model || "",
          task_kind: r.taskKind || "",
          tokens_in: Number(r.tokensIn) || 0,
          tokens_out: Number(r.tokensOut) || 0,
          cost_usd: r.costUSD == null ? null : Number(r.costUSD),
          cost_estimated: r.costEstimated ? 1 : 0,
          duration_ms: r.durationMs == null ? null : Number(r.durationMs),
        });
        counts.usage++;
      }
    }

    // Event log: logs/runs-YYYY-MM-DD.log
    const insEvent = db.prepare(
      "INSERT INTO events(ts, event, channel, author, slug, data) VALUES(@ts, @event, @channel, @author, @slug, @data)"
    );
    for (const f of logFiles.filter((f) => /^runs-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()) {
      for (const line of readFileSync(path.join(logsDir(), f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        const { ts, event, channel, author, slug, ...rest } = r;
        insEvent.run({
          ts: ts || "",
          event: event || "",
          channel: channel || "",
          author: author || "",
          slug: slug || "",
          data: Object.keys(rest).length ? JSON.stringify(rest) : null,
        });
        counts.events++;
      }
    }

    db.prepare("INSERT INTO _meta(key, value) VALUES('legacy_imported', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    db.prepare("INSERT INTO _meta(key, value) VALUES('legacy_imported_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      new Date().toISOString()
    );
    db.exec("COMMIT");
    const summary = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(" ");
    console.log(`[db] legacy JSON imported (${summary || "nothing to import"}). Old files kept as backups.`);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// One-time import of the per-thread override JSON files (thread-engines/models/efforts/clean —
// see migration 11) into thread_overrides. Separate from importLegacy because existing installs
// already carry `legacy_imported=1`, so this needs its own flag; same philosophy otherwise: read
// the old files, never delete or edit them (inert backups), best-effort per file.
const THREAD_OVERRIDE_FILES = [
  ["thread-engines.json", "engine"],
  ["thread-models.json", "model"],
  ["thread-efforts.json", "effort"],
  ["thread-clean.json", "clean"],
];

export function importThreadOverrides(db) {
  if (db.prepare("SELECT value FROM _meta WHERE key = 'thread_overrides_imported'").get()?.value === "1") return;

  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-check under the write lock (another process may have imported first).
    if (db.prepare("SELECT value FROM _meta WHERE key = 'thread_overrides_imported'").get()?.value === "1") {
      db.exec("COMMIT");
      return;
    }
    let count = 0;
    let slugs = [];
    try {
      slugs = readdirSync(channelsDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      slugs = [];
    }
    const ins = db.prepare("INSERT OR IGNORE INTO thread_overrides(slug, thread_key, kind, value) VALUES(?, ?, ?, ?)");
    for (const slug of slugs) {
      for (const [file, kind] of THREAD_OVERRIDE_FILES) {
        const map = readJson(path.join(channelsDir(), slug, file), {});
        for (const [threadKey, value] of Object.entries(map || {})) {
          // The clean map stores booleans; the others store strings. Absence = no override, so a
          // falsy legacy value contributes nothing (matches the old writers, which deleted keys).
          const v = kind === "clean" ? (value ? "1" : "") : String(value || "").trim();
          if (!v) continue;
          ins.run(slug, threadKey, kind, v);
          count++;
        }
      }
    }
    db.prepare("INSERT INTO _meta(key, value) VALUES('thread_overrides_imported', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    db.exec("COMMIT");
    if (count) console.log(`[db] legacy thread overrides imported (${count}). Old files kept as backups.`);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
