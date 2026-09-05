// Versioned schema migrations. Each entry is applied in order, exactly once, tracked by SQLite's
// built-in `PRAGMA user_version`. On every startup (on every machine) the runner in ./index.js
// applies whichever migrations are newer than the DB's current version, inside a single
// transaction — so updating a machine's code and restarting brings its schema up to date with no
// manual step. To evolve the schema, APPEND a new { version, up } entry; never edit an existing
// one (already-migrated machines won't re-run it).
//
// Design: config-shaped rows (users, channels, meta, sessions, schedules, acks, followups, jobs)
// store their full record as a JSON blob so every field is preserved verbatim and future fields
// need no migration; the columns pulled out alongside the blob exist only so the hot queries
// (filter by channel, enabled, etc.) are indexable. The two dashboard tables (usage, events) use
// fully typed columns + indexes because they're aggregated by day/week/month/channel/user.

import { ensureMemoryFtsTable } from "./fts.js";

export const migrations = [
  {
    version: 1,
    up(db) {
      db.exec(`
        -- Users, keyed by Slack user id.
        CREATE TABLE users (
          user_id TEXT PRIMARY KEY,
          data    TEXT NOT NULL
        );

        -- Channel index (id -> { slug, name, type, isDM }).
        CREATE TABLE channels (
          channel_id TEXT PRIMARY KEY,
          slug       TEXT NOT NULL,
          data       TEXT NOT NULL
        );
        CREATE INDEX idx_channels_slug ON channels(slug);

        -- Per-channel meta (the big lockdown/config record), keyed by slug.
        CREATE TABLE channel_meta (
          slug TEXT PRIMARY KEY,
          data TEXT NOT NULL
        );

        -- Thread -> Claude session id, per channel.
        CREATE TABLE sessions (
          slug       TEXT NOT NULL,
          thread_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          PRIMARY KEY (slug, thread_key)
        );

        -- Schedules / reminders. channel_id + enabled are columns for the hot filters.
        CREATE TABLE schedules (
          id         TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL DEFAULT '',
          enabled    INTEGER NOT NULL DEFAULT 1,
          data       TEXT NOT NULL
        );
        CREATE INDEX idx_schedules_channel ON schedules(channel_id);

        -- Pending reminder acknowledgments.
        CREATE TABLE acks (
          id         TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL DEFAULT '',
          data       TEXT NOT NULL
        );
        CREATE INDEX idx_acks_channel ON acks(channel_id);

        -- Personal follow-up state: observed threads + per-user done markers.
        CREATE TABLE followup_threads (
          thread_key TEXT PRIMARY KEY,
          data       TEXT NOT NULL
        );
        CREATE TABLE followup_done (
          user_id    TEXT NOT NULL,
          thread_key TEXT NOT NULL,
          done_ms    INTEGER NOT NULL,
          PRIMARY KEY (user_id, thread_key)
        );

        -- Durable in-flight background job records (crash recovery).
        CREATE TABLE bg_jobs (
          id   TEXT PRIMARY KEY,
          data TEXT NOT NULL
        );

        -- Usage / spend ledger — one row per run. Typed + indexed for dashboards.
        CREATE TABLE usage (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          ts             TEXT NOT NULL,
          channel_id     TEXT NOT NULL DEFAULT '',
          slug           TEXT NOT NULL DEFAULT '',
          author_id      TEXT NOT NULL DEFAULT '',
          engine         TEXT NOT NULL DEFAULT '',
          model          TEXT NOT NULL DEFAULT '',
          task_kind      TEXT NOT NULL DEFAULT '',
          tokens_in      INTEGER NOT NULL DEFAULT 0,
          tokens_out     INTEGER NOT NULL DEFAULT 0,
          cost_usd       REAL,
          cost_estimated INTEGER NOT NULL DEFAULT 0,
          duration_ms    INTEGER
        );
        CREATE INDEX idx_usage_ts ON usage(ts);
        CREATE INDEX idx_usage_channel ON usage(channel_id);
        CREATE INDEX idx_usage_author ON usage(author_id);

        -- Event log — the audit/execution stream. channel/author/slug pulled out for filtering.
        CREATE TABLE events (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          ts      TEXT NOT NULL,
          event   TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT '',
          author  TEXT NOT NULL DEFAULT '',
          slug    TEXT NOT NULL DEFAULT '',
          data    TEXT
        );
        CREATE INDEX idx_events_ts ON events(ts);
        CREATE INDEX idx_events_event ON events(event);
        CREATE INDEX idx_events_channel ON events(channel);
      `);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        -- Durable in-flight INTERACTIVE run records (restart recovery). A row exists ONLY while a
        -- Slack turn is actually running — written when the run starts, deleted in its finally. So
        -- any row still present at boot was written by the previous (now-dead) daemon and never
        -- reached its finally: that turn was interrupted by the restart and is auto-re-run. Full
        -- record in a JSON blob, same rationale as bg_jobs (no migration for new fields).
        CREATE TABLE active_runs (
          id   TEXT PRIMARY KEY,
          data TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        -- HTTP run API jobs. A run started via POST /api/runs is tracked here so its status
        -- survives a restart and GET /api/runs/:id keeps working. Unlike active_runs, these are
        -- NOT auto-re-run on boot (an API caller polls/gets a webhook, and re-firing could
        -- double-deliver): a row left as running/queued at boot is reported as "interrupted".
        -- Full record in a JSON blob (same rationale as bg_jobs); status/created_ms pulled out
        -- for the "prune old / list recent" queries.
        CREATE TABLE api_jobs (
          id         TEXT PRIMARY KEY,
          status     TEXT NOT NULL DEFAULT 'queued',
          created_ms INTEGER NOT NULL DEFAULT 0,
          data       TEXT NOT NULL
        );
        CREATE INDEX idx_api_jobs_created ON api_jobs(created_ms);
      `);
    },
  },
  {
    version: 4,
    up(db) {
      db.exec(`
        -- Which engine (claude|codex) minted a thread's session id. A session id is engine-specific
        -- — Claude mints a UUID, Codex mints its own thread_id, and neither can resume the other's —
        -- so when a thread's effective engine flips (channel/global default changed, or a
        -- "claude"/"codex" directive), the runner must start a FRESH session under the new engine
        -- instead of a cross-engine resume that errors. This column records the owning engine so the
        -- mismatch is detectable. Pre-existing rows default to '' (unknown → treated as "matches"),
        -- so no legacy thread is force-reset; the engine is stamped on the next session write.
        ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT '';
      `);
    },
  },
  {
    version: 5,
    up(db) {
      db.exec(`
        -- One-shot context for user-stopped Slack turns. If request N in a thread is stopped after
        -- request N-1 already created a resumable session, the engine can resume N-1 but may not
        -- know N. Store only the stopped user request and consume it on the next turn.
        CREATE TABLE stopped_turns (
          slug       TEXT NOT NULL,
          thread_key TEXT NOT NULL,
          data       TEXT NOT NULL,
          PRIMARY KEY (slug, thread_key)
        );
      `);
    },
  },
  {
    version: 6,
    up(db) {
      db.exec(`
        -- Composio SDK sessions are remote MCP runtimes scoped to one stable Slack identity,
        -- Slack thread, and connection-management access class. Store only non-secret remote
        -- identifiers/URLs; the organization SDK key remains in settings.json.
        CREATE TABLE composio_sessions (
          session_key TEXT PRIMARY KEY,
          identity_id TEXT NOT NULL,
          scope_kind  TEXT NOT NULL,
          thread_key  TEXT NOT NULL,
          access_kind TEXT NOT NULL,
          session_id  TEXT NOT NULL,
          mcp_url     TEXT NOT NULL,
          created_ms  INTEGER NOT NULL,
          updated_ms  INTEGER NOT NULL
        );
        CREATE INDEX idx_composio_sessions_identity
          ON composio_sessions(identity_id);
      `);
    },
  },
  {
    version: 7,
    up(db) {
      db.exec(`
        -- Scheduled follow-up digest messages map back to the exact source threads visibly listed
        -- in that Slack DM. This makes a reaction on the aggregate digest deterministic even when
        -- the recipient's live pending set changes later.
        CREATE TABLE followup_digest_messages (
          message_key TEXT PRIMARY KEY,
          created_ms  INTEGER NOT NULL,
          data        TEXT NOT NULL
        );
        CREATE INDEX idx_followup_digest_messages_created
          ON followup_digest_messages(created_ms);
      `);
    },
  },
  {
    version: 8,
    up(db) {
      // Old code allocated a slug from a process-local snapshot, so two concurrent first messages
      // could insert the same slug. Repair any legacy duplicates deterministically before making
      // uniqueness a database invariant. Preserve the JSON projection and clone shared meta for a
      // renamed row so it retains the prior channel posture.
      const rows = db.prepare("SELECT channel_id, slug, data FROM channels ORDER BY rowid").all();
      const used = new Set();
      const occupied = new Set(rows.map((row) => row.slug));
      const update = db.prepare("UPDATE channels SET slug = ?, data = ? WHERE channel_id = ?");
      const getMeta = db.prepare("SELECT data FROM channel_meta WHERE slug = ?");
      const putMeta = db.prepare("INSERT OR IGNORE INTO channel_meta(slug, data) VALUES(?, ?)");
      for (const row of rows) {
        let slug = row.slug;
        if (used.has(slug)) {
          const base = `${slug}-${String(row.channel_id).toLowerCase()}`;
          slug = base;
          for (let n = 2; occupied.has(slug) || used.has(slug); n++) slug = `${base}-${n}`;
          let data;
          try { data = JSON.parse(row.data); } catch { data = {}; }
          data.slug = slug;
          update.run(slug, JSON.stringify(data), row.channel_id);
          const meta = getMeta.get(row.slug);
          if (meta) {
            let metaData;
            try { metaData = JSON.parse(meta.data); } catch { metaData = {}; }
            metaData.channelId = row.channel_id;
            if (data.name) metaData.name = data.name;
            putMeta.run(slug, JSON.stringify(metaData));
          }
        }
        used.add(slug);
      }
      db.exec("CREATE UNIQUE INDEX idx_channels_slug_unique ON channels(slug)");
    },
  },
  {
    version: 9,
    up(db) {
      db.exec(`
        -- Durable, single-use approvals for UNSANDBOXED background-shell jobs. Unlike ordinary
        -- permission/plan approvals these requests intentionally survive daemon/engine restarts:
        -- the Slack button resolves the exact serialized action directly through the daemon.
        -- Pending rows have no expiry; terminal rows are retained briefly as an audit/replay guard.
        CREATE TABLE approval_requests (
          id         TEXT PRIMARY KEY,
          action_key TEXT NOT NULL,
          status     TEXT NOT NULL DEFAULT 'pending',
          created_ms INTEGER NOT NULL,
          updated_ms INTEGER NOT NULL,
          data       TEXT NOT NULL
        );
        CREATE INDEX idx_approval_requests_status_updated
          ON approval_requests(status, updated_ms);
        CREATE UNIQUE INDEX idx_approval_requests_pending_action
          ON approval_requests(action_key) WHERE status = 'pending';
      `);
    },
  },
  {
    version: 10,
    up(db) {
      db.exec(`
        -- Preserve the original usage row as the Slack/daemon RUN record. Canonical provider
        -- accounting lives in components so native children add tokens/value without pretending
        -- to be additional Slack runs, and historical raw evidence is never destructively erased.
        ALTER TABLE usage ADD COLUMN runtime_model TEXT NOT NULL DEFAULT '';
        ALTER TABLE usage ADD COLUMN accounting_status TEXT NOT NULL DEFAULT 'legacy-unverified';
        ALTER TABLE usage ADD COLUMN repair_batch_id TEXT NOT NULL DEFAULT '';

        CREATE TABLE usage_components (
          id                         INTEGER PRIMARY KEY AUTOINCREMENT,
          usage_id                   INTEGER NOT NULL,
          source_key                 TEXT NOT NULL UNIQUE,
          source_kind                TEXT NOT NULL DEFAULT 'root',
          provider_session_id        TEXT NOT NULL DEFAULT '',
          parent_provider_session_id TEXT NOT NULL DEFAULT '',
          provider_turn_id           TEXT NOT NULL DEFAULT '',
          started_ts                 TEXT NOT NULL DEFAULT '',
          ended_ts                   TEXT NOT NULL DEFAULT '',
          model                      TEXT NOT NULL DEFAULT '',
          tokens_in                  INTEGER NOT NULL DEFAULT 0,
          tokens_cached              INTEGER NOT NULL DEFAULT 0,
          tokens_cache_write         INTEGER NOT NULL DEFAULT 0,
          tokens_out                 INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens           INTEGER NOT NULL DEFAULT 0,
          cost_usd                   REAL,
          cost_estimated             INTEGER NOT NULL DEFAULT 0,
          pricing_basis              TEXT NOT NULL DEFAULT '',
          provenance                 TEXT NOT NULL DEFAULT '',
          confidence                 TEXT NOT NULL DEFAULT 'verified',
          duration_ms                INTEGER,
          FOREIGN KEY (usage_id) REFERENCES usage(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_usage_components_usage ON usage_components(usage_id);
        CREATE INDEX idx_usage_components_session ON usage_components(provider_session_id);

        CREATE TABLE usage_requests (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          component_id       INTEGER NOT NULL,
          request_index      INTEGER NOT NULL,
          model              TEXT NOT NULL DEFAULT '',
          tokens_in          INTEGER NOT NULL DEFAULT 0,
          tokens_cached      INTEGER NOT NULL DEFAULT 0,
          tokens_cache_write INTEGER NOT NULL DEFAULT 0,
          tokens_out         INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
          context_window     INTEGER NOT NULL DEFAULT 0,
          long_context       INTEGER NOT NULL DEFAULT 0,
          cost_usd           REAL,
          UNIQUE(component_id, request_index),
          FOREIGN KEY (component_id) REFERENCES usage_components(id) ON DELETE CASCADE
        );

        CREATE TABLE usage_repair_batches (
          id              TEXT PRIMARY KEY,
          created_ts      TEXT NOT NULL,
          cutoff_usage_id INTEGER NOT NULL,
          status          TEXT NOT NULL,
          backup_path     TEXT NOT NULL DEFAULT '',
          data            TEXT NOT NULL DEFAULT '{}'
        );

        UPDATE usage SET accounting_status = CASE
          WHEN engine = 'codex' THEN 'legacy-unverified'
          ELSE 'provider-reported'
        END;
      `);
    },
  },
  {
    version: 11,
    up(db) {
      db.exec(`
        -- Per-thread runtime overrides (engine / model / effort / clean), one keyed row per
        -- override; absence of a row = no override. Previously four JSON files per channel
        -- (thread-engines.json / thread-models.json / thread-efforts.json / thread-clean.json)
        -- maintained by unsynchronized read-modify-writeFile: two concurrent messages in different
        -- threads could drop each other's values, and a reader could see a truncated file mid-
        -- write. Single-row upsert/delete statements are atomic, so none of that can happen here.
        -- The legacy JSON is imported once at DB open (see import-legacy.js importThreadOverrides)
        -- and the old files stay on disk as inert backups.
        CREATE TABLE thread_overrides (
          slug       TEXT NOT NULL,
          thread_key TEXT NOT NULL,
          kind       TEXT NOT NULL, -- 'engine' | 'model' | 'effort' | 'clean'
          value      TEXT NOT NULL,
          PRIMARY KEY (slug, thread_key, kind)
        );
      `);
    },
  },
  {
    version: 12,
    up(db) {
      db.exec(`
        -- License enforcement ledger (src/ee/limits.js). One row per (UTC month, conversation).
        --
        -- Deliberately NOT the existing \`usage\` table, even though that table does carry a
        -- conversation id and a timestamp per run. Three reasons, all of them structural:
        --   1. \`usage\` rows are written when a run FINISHES (gateway/usage.js recordUsage), and
        --      the license cap is counted at SPAWN. Counting completed rows would let any number
        --      of concurrent turns past a cap that is already reached.
        --   2. \`usage\` records spend. A refused turn spends nothing and must not appear there,
        --      and rewriting the spend ledger's semantics to carry licensing state would make two
        --      unrelated features share one source of truth.
        --   3. The month's ADMITTED conversation set and the once-per-month 80% warning flag are
        --      licensing state with no home in a spend ledger.
        --
        -- \`conversation_id\` is the QUALIFIED id (src/platforms/ids.js) — bare for Slack,
        -- prefixed elsewhere — so two surfaces can never collide into one allowance. Nothing here
        -- leaves the install in clear: the usage report hashes every id (src/ee/limits.js).
        CREATE TABLE license_usage (
          month           TEXT NOT NULL,               -- 'YYYY-MM', UTC
          conversation_id TEXT NOT NULL,
          admitted        INTEGER NOT NULL DEFAULT 0,  -- in this month's allowed conversation set
          admitted_seq    INTEGER NOT NULL DEFAULT 0,  -- admission order within the month
          runs            INTEGER NOT NULL DEFAULT 0,  -- engine runs started this month
          warned          INTEGER NOT NULL DEFAULT 0,  -- the 80% warning has been posted once
          first_ts        TEXT NOT NULL DEFAULT '',
          last_ts         TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (month, conversation_id)
        );
        CREATE INDEX idx_license_usage_month ON license_usage(month);
      `);
    },
  },
  {
    version: 13,
    up(db) {
      db.exec(`
        -- WHERE a thread's session was last run (v0.8 container-per-channel runtime). A JSON
        -- string: { backend, fingerprint, image } — the runtime backend id, the create-time
        -- fingerprint of the environment it ran in, and the image ref for a container backend.
        --
        -- Additive with a default so older code keeps booting on the new schema: every existing
        -- row is a host row, and '' reads as "unknown, therefore host" everywhere (the runtime
        -- registry resolves an unknown/missing backend id to host for exactly this reason).
        -- Read by /status and /resume, which must name the environment a session can be reopened
        -- in — a container session is resumed with an exec into its channel's container, not with
        -- a bare CLI command on the host.
        ALTER TABLE sessions ADD COLUMN runtime TEXT NOT NULL DEFAULT '';
      `);
    },
  },
  {
    version: 14,
    up(db) {
      db.exec(`
        -- Skills platform Core (src/gateway/skills/, docs/SKILLS.md). The LOCAL skill catalog: every
        -- skill a conversation can be granted lives here as immutable, content-hashed revisions that
        -- hold the exact bytes of every file — SKILL.md included. The parsed frontmatter columns on
        -- \`skills\` are a DERIVED index (rebuilt from the revision on every activation), never the
        -- canonical content, so a key the parser does not model (allowed-tools, say) is never lost.
        -- Ownership is explicit per skill (owner_kind): a synced skill is re-synced or forked, never
        -- edited in place. Tombstones (deleted_at) keep dependents readable instead of breaking them.
        CREATE TABLE skills (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          slug                TEXT NOT NULL UNIQUE,          -- the folder name under .claude/skills/
          name                TEXT NOT NULL DEFAULT '',      -- frontmatter name (what the Skill tool fires)
          description         TEXT NOT NULL DEFAULT '',      -- frontmatter description (the always-on text)
          owner_kind          TEXT NOT NULL DEFAULT 'local', -- bundled | local | folder | git
          source_id           INTEGER,                       -- skill_sources.id for synced skills
          source_path         TEXT NOT NULL DEFAULT '',      -- skill directory inside its source
          current_revision_id INTEGER,                       -- newest ACTIVE revision; NULL = none yet
          pinned_revision_id  INTEGER,                       -- operator pin/rollback; NULL follows current
          category            TEXT NOT NULL DEFAULT '',
          tags                TEXT NOT NULL DEFAULT '[]',    -- JSON string[]
          requires            TEXT NOT NULL DEFAULT '[]',    -- JSON string[] of skill slugs (dependencies)
          version             TEXT NOT NULL DEFAULT '',      -- semver from the frontmatter (human metadata)
          meta                TEXT NOT NULL DEFAULT '{}',    -- JSON: the full parsed frontmatter
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          created_by          TEXT NOT NULL DEFAULT '',      -- platform user id for locally authored skills
          deleted_at          TEXT NOT NULL DEFAULT ''       -- tombstone ('' = live)
        );
        CREATE INDEX idx_skills_source ON skills(source_id);
        CREATE INDEX idx_skills_owner ON skills(owner_kind);

        CREATE TABLE skill_revisions (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          skill_id     INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
          revision_no  INTEGER NOT NULL,
          status       TEXT NOT NULL DEFAULT 'active',  -- active | staged (awaiting review) | rejected
          content_hash TEXT NOT NULL,                   -- sha256 over every (path, bytes) — the integrity identity
          version      TEXT NOT NULL DEFAULT '',
          source_ref   TEXT NOT NULL DEFAULT '',        -- git commit / folder / 'manual' / 'proposal:<id>'
          note         TEXT NOT NULL DEFAULT '',
          file_count   INTEGER NOT NULL DEFAULT 0,
          total_bytes  INTEGER NOT NULL DEFAULT 0,
          created_at   TEXT NOT NULL,
          created_by   TEXT NOT NULL DEFAULT '',
          UNIQUE (skill_id, revision_no)
        );
        CREATE INDEX idx_skill_revisions_skill ON skill_revisions(skill_id, status);

        CREATE TABLE skill_revision_files (
          revision_id  INTEGER NOT NULL REFERENCES skill_revisions(id) ON DELETE CASCADE,
          path         TEXT NOT NULL,                   -- posix path relative to the skill folder
          content      BLOB NOT NULL,                   -- exact bytes
          size         INTEGER NOT NULL,
          sha256       TEXT NOT NULL,
          content_type TEXT NOT NULL DEFAULT '',
          executable   INTEGER NOT NULL DEFAULT 0,      -- materialized 0755 instead of 0644
          PRIMARY KEY (revision_id, path)
        );

        -- Where synced skills come from. A git source is one GitHub repository (optionally a
        -- branch + subfolder, the /tree/<branch>/<path> form); a folder source is a directory on
        -- the daemon host. mode=review stages every new revision for an admin to approve before it
        -- can reach a channel (synced third-party skills are an instruction supply chain); mode=auto
        -- activates on sync. pinned_ref freezes a git source at one commit.
        CREATE TABLE skill_sources (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          kind            TEXT NOT NULL,                 -- git | folder
          label           TEXT NOT NULL DEFAULT '',
          url             TEXT NOT NULL DEFAULT '',      -- repository URL or host directory
          ref             TEXT NOT NULL DEFAULT '',      -- branch/tag ('' = the repository default)
          subpath         TEXT NOT NULL DEFAULT '',      -- only discover skills below this folder
          pinned_ref      TEXT NOT NULL DEFAULT '',      -- commit sha to stay on ('' = follow ref)
          mode            TEXT NOT NULL DEFAULT 'review',-- auto | review
          enabled         INTEGER NOT NULL DEFAULT 1,
          last_sync_at    TEXT NOT NULL DEFAULT '',
          last_sync_ref   TEXT NOT NULL DEFAULT '',
          last_sync_error TEXT NOT NULL DEFAULT '',
          last_sync_stats TEXT NOT NULL DEFAULT '{}',
          created_at      TEXT NOT NULL,
          created_by      TEXT NOT NULL DEFAULT ''
        );

        -- Channel skill templates ("Development", "Sales", …): data, not enums. A template names
        -- explicit skills and/or categories; applying it copies a SNAPSHOT of the resolved slugs
        -- into the conversation's own grant list (never a live link).
        CREATE TABLE skill_templates (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          slug        TEXT NOT NULL UNIQUE,
          name        TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          skills      TEXT NOT NULL DEFAULT '[]',        -- JSON string[] of skill slugs
          categories  TEXT NOT NULL DEFAULT '[]',        -- JSON string[] of categories (case-insensitive)
          builtin     INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        -- One row per observed skill use. Claude fires skills through its Skill tool, so those rows
        -- are EXACT; a Codex turn has no such tool and reads the SKILL.md file, so those rows are
        -- INFERRED from a read/shell command and labelled as such. Never carries prompt text.
        CREATE TABLE skill_usage (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          ts              TEXT NOT NULL,
          slug            TEXT NOT NULL,
          skill_id        INTEGER,
          revision_id     INTEGER,
          channel_slug    TEXT NOT NULL DEFAULT '',
          conversation_id TEXT NOT NULL DEFAULT '',
          user_id         TEXT NOT NULL DEFAULT '',
          engine          TEXT NOT NULL DEFAULT '',
          session_id      TEXT NOT NULL DEFAULT '',
          run_id          TEXT NOT NULL DEFAULT '',
          origin          TEXT NOT NULL DEFAULT '',
          signal          TEXT NOT NULL                  -- exact | inferred
        );
        CREATE INDEX idx_skill_usage_ts ON skill_usage(ts);
        CREATE INDEX idx_skill_usage_channel ON skill_usage(channel_slug, ts);
        CREATE INDEX idx_skill_usage_slug ON skill_usage(slug, ts);

        -- Proposed changes to a shared skill (anyone may propose; an admin decides). An approved
        -- change becomes one new revision of that skill.
        CREATE TABLE skill_proposals (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          slug          TEXT NOT NULL,
          kind          TEXT NOT NULL,                   -- change | promote
          status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
          files         TEXT NOT NULL DEFAULT '[]',      -- JSON [{ path, content, encoding }]
          note          TEXT NOT NULL DEFAULT '',
          proposed_by   TEXT NOT NULL DEFAULT '',
          channel_slug  TEXT NOT NULL DEFAULT '',
          created_at    TEXT NOT NULL,
          decided_at    TEXT NOT NULL DEFAULT '',
          decided_by    TEXT NOT NULL DEFAULT '',
          decision_note TEXT NOT NULL DEFAULT '',
          revision_id   INTEGER
        );
        CREATE INDEX idx_skill_proposals_status ON skill_proposals(status);
      `);
    },
  },
  {
    version: 15,
    up(db) {
      db.exec(`
        -- Skills platform, round two (docs/SKILLS.md): personal skills, Git publishing, external
        -- access tokens and gateway-to-gateway sources.
        -- visibility: 'org' (every conversation may be granted it) | 'personal' (only its author's
        -- own runs; listed only to the author and admins).
        ALTER TABLE skills ADD COLUMN visibility TEXT NOT NULL DEFAULT 'org';
        -- Where a revision was published to Git (the configured publish repository): the commit
        -- sha of the last file write, and when. '' = never published.
        ALTER TABLE skill_revisions ADD COLUMN published_ref TEXT NOT NULL DEFAULT '';
        ALTER TABLE skill_revisions ADD COLUMN published_at TEXT NOT NULL DEFAULT '';
        -- A gateway source (kind 'gateway') authenticates to its peer with an access token that
        -- peer minted; write-only, never listed, never in a channel folder.
        ALTER TABLE skill_sources ADD COLUMN secret TEXT NOT NULL DEFAULT '';
        -- Access tokens for the catalog's own MCP endpoint (/mcp/skills): laptop Claude Code, Codex,
        -- other MCP clients and peer gateways. Stored hashed; the value is shown exactly once.
        CREATE TABLE skill_access_tokens (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT NOT NULL,
          token_hash   TEXT NOT NULL UNIQUE,
          token_prefix TEXT NOT NULL DEFAULT '',
          scopes       TEXT NOT NULL DEFAULT '["read"]',  -- JSON string[]: read | propose | manage | sync
          created_at   TEXT NOT NULL,
          created_by   TEXT NOT NULL DEFAULT '',
          last_used_at TEXT NOT NULL DEFAULT '',
          revoked_at   TEXT NOT NULL DEFAULT ''
        );
      `);
    },
  },
  {
    version: 16,
    up(db) {
      db.exec(`
        -- An operator EXCLUSION is sticky: a skill an admin removed (set_skill_excluded, the admin
        -- UI's Remove, a migrated Skills Manager exclusion) stays out of the catalog when a sync or
        -- a host-folder import delivers it again — unlike a plain tombstone (deleted_at), which a
        -- returning source restores. '' = not excluded; restoring a skill clears both columns.
        ALTER TABLE skills ADD COLUMN excluded_at TEXT NOT NULL DEFAULT '';
      `);
    },
  },
  {
    version: 17,
    up(db) {
      // Derived, rebuildable search index for channel-owned Markdown memory. The files in each
      // channel work folder remain the source of truth; this table contains no unique state — so
      // an engine without FTS5 (Node 22.13's bundled SQLite) skips it instead of failing the
      // migration and with it the whole database open. src/db/index.js re-attempts the creation
      // after every open, and memory search falls back to a plain scan meanwhile.
      if (!ensureMemoryFtsTable(db)) {
        console.warn("[db] SQLite FTS5 is unavailable in this Node build; channel memory search uses a plain scan");
      }
    },
  },
  {
    version: 18,
    up(db) {
      db.exec(`
        -- Which section of the skills repository a skill belongs to (docs/SKILLS.md "Sections"):
        -- '' = the shared library; otherwise the Slack channel id whose section
        -- (channels/<channelId>/<slug>/) holds it. A source-owned skill follows its folder; a
        -- locally authored one carries the scope it was created with. The channel tier includes
        -- every skill scoped to that channel automatically.
        ALTER TABLE skills ADD COLUMN channel_scope TEXT NOT NULL DEFAULT '';
      `);
    },
  },
];
