// Channel + DM admin routes: per-DM config, the channel list/members/meta, Make-toolbox and
// Drive-sync probes, the org-wide access/nudge/runtime resets, channel memory, and channel
// instructions (CLAUDE.md). Split from admin.js; mounted by createAdminRouter so every URL is
// unchanged.
import { Router } from "express";
import { getTemplate } from "../../gateway/skills/catalog.js";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { allowedFsRoot, resolveWithinRoot } from "../security.js";
// MEMORY.md and CLAUDE.md live INSIDE the channel's agent-writable working folder, so every read
// and write below is a symlink sink: a planted `CLAUDE.md -> ~/.channelgate/config/settings.json`
// would otherwise stream the gateway's secrets straight into an admin browser, and the save would
// write agent-chosen bytes over a host file. Same posture as every other managed path — operate on
// the NODE, never through it.
import { ensureRealDir, readNoFollow, writeNoFollow } from "../../gateway/safe-fs.js";
import { workspaceFolder } from "../../config/paths.js";
import {
  listChannels,
  getChannelsIndex,
  getChannelMeta,
  saveChannelMeta,
  patchChannelMeta,
  defaultChannelMeta,
  getUsers,
} from "../../config/store.js";
import { ensureChannelFolder, effectiveWorkDir, gatewayInstructionsBlock, splitGatewayBlock, channelSeed } from "../../gateway/folders.js";
import { memoryEnabled, memoryBudget, MEM_FILE, MEM_DIR } from "../../gateway/channel-memory.js";
import {
  ENGINES,
  CHANNEL_ACCESS_MODES,
  getDefaultChannelAccess,
  getDefaultNudges,
} from "../../config/settings.js";
import { testChannelSync } from "../../gateway/drivesync.js";
import { PROFILE_FLAGS } from "../../gateway/modes.js";
// Two forms on purpose. normalizeStoredDomains is TOLERANT and belongs on the read/spawn path (a
// hand-edited config must degrade to "no extras", never break run startup). An admin SAVE is the
// opposite: silently dropping the whole list because one entry has a typo destroyed every
// previously approved domain with an "ok". Writes use the strict form and 400 instead.
import { effectiveMeta } from "../../gateway/run.js";
import { logEvent } from "../../util/logger.js";
import {
  listMakeToolboxTools,
  resolveMakeToolboxUpdate,
} from "../../gateway/make-toolbox.js";
import {
  filterConversationHumanMemberIds,
  listConversationMemberRoster,
  withChannelMembershipLock,
} from "../../slack/members.js";
import { invalidModelOrEffort, sanitizeMcps, sanitizeCodexMcps } from "./helpers.js";
// Per-channel environment secrets. WRITE-ONLY: listChannelEnv is the only shape that may leave the
// process, and there is deliberately no reveal route (see config/channel-env.js and web/secrets.js).
import { listChannelEnv, patchChannelEnv } from "../../config/channel-env.js";
import { cliEnvKeys, cliIntegrationIds } from "../../config/cli-catalog.js";

const WEB_ADMIN_ACTOR = "admin UI";

// Strip stored secrets from a channel meta before it leaves the API, keeping has*/last4 for
// display. Used by BOTH the list and the save response: a PUT that changes something unrelated
// would otherwise echo back every preserved token, which is the same disclosure by another route.
export function maskChannelMeta(meta = {}) {
  const mask = (v) => ({ has: Boolean(v), last4: v ? String(v).slice(-4) : "" });
  const tok = mask(meta.composioToken);
  const tb = mask(meta.toolboxToken);
  const mk = mask(meta.makeToolboxKey);
  return {
    ...meta,
    // `...meta` would otherwise spread the env bag — VALUES included — into every save response.
    env: undefined,
    envVars: listChannelEnv(meta),
    composioToken: undefined,
    hasComposioToken: tok.has,
    composioTokenLast4: tok.last4,
    toolboxToken: undefined,
    hasToolboxToken: tb.has,
    toolboxTokenLast4: tb.last4,
    makeToolboxKey: undefined,
    hasMakeToolboxKey: mk.has,
    makeToolboxKeyLast4: mk.last4,
  };
}

export function createChannelsRouter({
  slack,
  testMakeToolbox = listMakeToolboxTools,
} = {}) {
  const router = Router();

  const currentChannelRoster = async (channelId) => {
    const client = slack?.getClient?.();
    if (!client) {
      const error = new Error("Slack is disconnected; reconnect it to edit channel guest access.");
      error.statusCode = 503;
      throw error;
    }
    try {
      return await listConversationMemberRoster(client, channelId, {
        teamId: slack?.snapshot?.().teamId || "",
      });
    } catch {
      const error = new Error("Could not load this channel's Slack members. Check the bot's channel access and Slack scopes.");
      error.statusCode = 502;
      throw error;
    }
  };

  const validatedChannelGuests = async (channelId, requestedIds) => {
    const client = slack?.getClient?.();
    if (!client) {
      const error = new Error("Slack is disconnected; reconnect it to edit channel guest access.");
      error.statusCode = 503;
      throw error;
    }
    try {
      return await filterConversationHumanMemberIds(client, channelId, requestedIds, {
        teamId: slack?.snapshot?.().teamId || "",
      });
    } catch {
      const error = new Error("Could not load this channel's Slack members. Check the bot's channel access and Slack scopes.");
      error.statusCode = 502;
      throw error;
    }
  };

  // ── DMs (org templates + per-DM config) ─────────────────────────────────────
  function resolveDmUserId(slug, users) {
    const s = (slug || "").replace(/^dm-/, "");
    for (const k of Object.keys(users)) if (k.toLowerCase() === s) return k;
    return "";
  }

  router.get("/dms", async (_req, res, next) => {
    try {
      const users = await getUsers();
      const dms = (await listChannels())
        .filter((c) => c.isDM)
        .map((c) => {
          const meta = c.meta || {};
          const uid = meta.dmUserId || resolveDmUserId(c.slug, users);
          const tok = meta.composioToken || "";
          const tb = meta.toolboxToken || "";
          return {
            channelId: c.channelId,
            slug: c.slug,
            dmUserId: uid,
            userName: users[uid]?.name || uid || c.slug,
            template: meta.template || "user",
            meta: {
              ...meta,
              // A DM is a channel too: the spread above would otherwise carry its env VALUES.
              env: undefined,
              envVars: listChannelEnv(meta),
              composioToken: undefined,
              hasComposioToken: Boolean(tok),
              composioTokenLast4: tok ? tok.slice(-4) : "",
              toolboxToken: undefined,
              hasToolboxToken: Boolean(tb),
              toolboxTokenLast4: tb ? tb.slice(-4) : "",
            },
          };
        });
      res.json({ dms });
    } catch (e) {
      next(e);
    }
  });

  router.put("/dms/:channelId", async (req, res, next) => {
    try {
      const index = await getChannelsIndex();
      const entry = index[req.params.channelId];
      if (!entry) return res.status(404).json({ error: "unknown DM" });
      const current = (await getChannelMeta(entry.slug)) ?? defaultChannelMeta({ channelId: req.params.channelId, name: entry.name, type: entry.type, isDM: true });
      const body = req.body ?? {};
      const badModel = invalidModelOrEffort(body);
      if (badModel) return res.status(400).json({ error: badModel });
      const next_ = { ...current };
      if (["user", "admin", "custom"].includes(body.template)) next_.template = body.template;
      if (Array.isArray(body.skills)) next_.skills = body.skills;
      if (typeof body.skillTemplate === "string") {
        const key = body.skillTemplate.trim();
        if (key && !getTemplate(key)) return res.status(400).json({ error: `unknown skill template "${key}"` });
        next_.skillTemplate = key ? getTemplate(key).slug : "";
      }
      if (Array.isArray(body.allowedMcps)) next_.allowedMcps = sanitizeMcps(body.allowedMcps);
      if (Array.isArray(body.allowedCodexMcps)) next_.allowedCodexMcps = sanitizeCodexMcps(body.allowedCodexMcps);
      if (typeof body.model === "string") next_.model = body.model.trim();
      if (typeof body.effort === "string") next_.effort = body.effort.trim();
      if (typeof body.adminMode === "boolean") next_.adminMode = body.adminMode;
      if (typeof body.allowBash === "boolean") next_.allowBash = body.allowBash;
      if (typeof body.allowNetwork === "boolean") next_.allowNetwork = body.allowNetwork;
      if (typeof body.autoMode === "boolean") next_.autoMode = body.autoMode;
      if (typeof body.cleanMode === "boolean") next_.cleanMode = body.cleanMode;
      if (typeof body.engine === "string" && (body.engine === "" || ENGINES.includes(body.engine))) next_.engine = body.engine;
      if (typeof body.composioToken === "string" && body.composioToken) next_.composioToken = body.composioToken.trim();
      if (body.clearComposioToken === true) next_.composioToken = "";
      if (typeof body.toolboxToken === "string" && body.toolboxToken) next_.toolboxToken = body.toolboxToken.trim();
      if (body.clearToolboxToken === true) next_.toolboxToken = "";
      await saveChannelMeta(entry.slug, next_);
      await ensureChannelFolder(entry.slug, effectiveMeta(next_)); // re-provision with effective config
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // The org DM templates are now edited under Settings → Access Templates and persist via the settings
  // PUT above (see the `body.dmTemplates` block); there's no longer a dedicated dm-templates route.

  // ── Channels ────────────────────────────────────────────────────────────────
  router.get("/channels", async (_req, res, next) => {
    try {
      // DMs aren't shown here — a DM has no per-channel settings (access is governed by the
      // user's approval in the Users tab, not allowedUsers/MCPs/skills).
      const channels = (await listChannels()).filter((c) => !c.isDM && c.type !== "im");
      // Per-channel Composio / Skills / Toolbox / Make toolbox secrets are NOT returned — only
      // has*/last4 for display. The UI fetches a value on demand via POST /secrets/reveal, which
      // re-prompts for the admin password. Only overwritten on save when a non-empty value is sent.
      for (const ch of channels) {
        if (!ch.meta) continue;
        const tok = ch.meta.composioToken || "";
        const tb = ch.meta.toolboxToken || "";
        const makeKey = ch.meta.makeToolboxKey || "";
        ch.meta = {
          ...ch.meta,
          env: undefined,
          envVars: listChannelEnv(ch.meta),
          composioToken: undefined,
          hasComposioToken: Boolean(tok),
          composioTokenLast4: tok ? tok.slice(-4) : "",
          toolboxToken: undefined,
          hasToolboxToken: Boolean(tb),
          toolboxTokenLast4: tb ? tb.slice(-4) : "",
          makeToolboxKey: undefined,
          hasMakeToolboxKey: Boolean(makeKey),
          makeToolboxKeyLast4: makeKey ? makeKey.slice(-4) : "",
        };
      }
      res.json({ channels });
    } catch (e) {
      next(e);
    }
  });

  router.get("/channels/:channelId/members", async (req, res, next) => {
    try {
      const index = await getChannelsIndex();
      const entry = index[req.params.channelId];
      if (!entry || entry.isDM || entry.type === "im") {
        return res.status(404).json({ error: "unknown channel" });
      }
      res.json({ members: await currentChannelRoster(req.params.channelId) });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      next(error);
    }
  });

  router.put("/channels/:channelId/meta", async (req, res, next) => {
    try {
      const { channelId } = req.params;
      const index = await getChannelsIndex();
      const entry = index[channelId];
      if (!entry) return res.status(404).json({ error: "unknown channel" });

      const body = req.body ?? {};
      const badModel = invalidModelOrEffort(body);
      if (badModel) return res.status(400).json({ error: badModel });
      // Custom working folder: Claude gets sandboxed to (and admin-mode runs execute in) this
      // path, so it must not be steerable to arbitrary host locations — require an existing
      // directory that realpath-resolves inside the allowlisted root (see /fs/list). Blank
      // clears back to the default workspace folder. Validated HERE (async realpath/stat) because
      // the atomic patch callback below runs synchronously inside the store transaction.
      let workDirPatch; // undefined = leave unchanged
      if (typeof body.workDir === "string") {
        const wanted = body.workDir.trim();
        // The UI round-trips the stored workDir on every save, so only validate a value that
        // actually CHANGED — otherwise a pre-existing (grandfathered) out-of-root workDir would
        // 400 every unrelated save. Unchanged → leave workDirPatch undefined (keep stored value);
        // read-time containment in effectiveWorkDir still refuses an escaping stored dir at run time.
        const cur = await getChannelMeta(entry.slug);
        if (wanted === String(cur?.workDir || "").trim()) {
          // unchanged — no validation, no patch
        } else if (!wanted) {
          workDirPatch = "";
        } else {
          const root = allowedFsRoot();
          // The folder picker returns a server-validated REAL path. If that folder's name carries
          // trailing/leading whitespace (a stray space, NBSP, tab, …), the trimmed value points at
          // a non-existent sibling and the save 400s even though Browse just accepted it. So try the
          // trimmed value first (normalizes accidentally-typed surrounding spaces), then fall back to
          // the raw value before rejecting. resolveWithinRoot still enforces containment either way.
          const real = resolveWithinRoot(root, wanted) || resolveWithinRoot(root, body.workDir);
          if (!real || !(await stat(real)).isDirectory())
            return res.status(400).json({ error: `workDir must be an existing directory under ${root}` });
          workDirPatch = real;
        }
      }
      // Validated HERE for the same reason as workDir: the merge callback below runs synchronously
      // inside the store transaction and cannot answer the request. A malformed entry rejects the
      // whole save (400) instead of quietly wiping the channel's approved egress list.
      // Atomic read-modify-write: the merge callback runs inside the store's BEGIN IMMEDIATE
      // transaction, so a concurrent writer (Slack /mode, an MCP channel-admin tool) can't be
      // clobbered by this save reading stale meta.
      const commitMeta = async () => {
        let allowedUsersPatch;
        if (Array.isArray(body.allowedUsers)) {
          allowedUsersPatch = await validatedChannelGuests(channelId, body.allowedUsers);
        }
        return patchChannelMeta(entry.slug, (existing) => {
          const current = existing ?? defaultChannelMeta({ channelId, name: entry.name, type: entry.type, isDM: entry.isDM });
          const out = {
            ...current,
            // Access model: who can USE (access) and who can MANAGE (manageAccess + managers[]).
            access: CHANNEL_ACCESS_MODES.includes(body.access) ? body.access : current.access ?? "approved",
            manageAccess: ["admins", "members", "custom"].includes(body.manageAccess) ? body.manageAccess : current.manageAccess ?? "admins",
            managers: Array.isArray(body.managers) ? body.managers.map(String) : current.managers ?? [],
            allowedUsers: allowedUsersPatch ?? current.allowedUsers,
            allowedMcps: Array.isArray(body.allowedMcps) ? sanitizeMcps(body.allowedMcps) : current.allowedMcps,
            allowedCodexMcps: Array.isArray(body.allowedCodexMcps) ? sanitizeCodexMcps(body.allowedCodexMcps) : current.allowedCodexMcps ?? [],
            skills: Array.isArray(body.skills) ? body.skills : current.skills,
            skillTemplate: typeof body.skillTemplate === "string" ? (body.skillTemplate.trim() ? getTemplate(body.skillTemplate.trim())?.slug ?? "__unknown__" : "") : (current.skillTemplate || ""),
            adminMode: typeof body.adminMode === "boolean" ? body.adminMode : current.adminMode,
            allowBash: typeof body.allowBash === "boolean" ? body.allowBash : current.allowBash,
            allowNetwork: typeof body.allowNetwork === "boolean" ? body.allowNetwork : current.allowNetwork,
            autoMode: typeof body.autoMode === "boolean" ? body.autoMode : current.autoMode,
            cleanMode: typeof body.cleanMode === "boolean" ? body.cleanMode : current.cleanMode,
            noDefaultTokens: typeof body.noDefaultTokens === "boolean" ? body.noDefaultTokens : current.noDefaultTokens,
            nudges: typeof body.nudges === "boolean" ? body.nudges : current.nudges,
            memory: typeof body.memory === "boolean" ? body.memory : current.memory,
            engine: typeof body.engine === "string" && (body.engine === "" || ENGINES.includes(body.engine)) ? body.engine : current.engine,
            approvedTools: Array.isArray(body.approvedTools) ? body.approvedTools.map(String) : current.approvedTools,
            workDir: workDirPatch !== undefined ? workDirPatch : current.workDir,
            // Google Drive sync folder link — a plain string (no filesystem validation like workDir);
            // an empty string turns the sync off. The scheduled bisync engine consumes it later.
            syncDriveFolder: typeof body.syncDriveFolder === "string" ? body.syncDriveFolder.trim() : current.syncDriveFolder,
            model: typeof body.model === "string" ? body.model.trim() : current.model,
            effort: typeof body.effort === "string" ? body.effort.trim() : current.effort,
          };
          // Capability profile: a preset expands to (and OVERRIDES) the four capability flags, so the
          // preset is authoritative even if a stale checkbox was also sent. "custom" keeps whatever
          // flags were set above (the individual toggles). An unknown/absent profile leaves things as-is.
          if (typeof body.profile === "string") {
            if (PROFILE_FLAGS[body.profile]) {
              out.profile = body.profile;
              Object.assign(out, PROFILE_FLAGS[body.profile]);
            } else if (body.profile === "custom") {
              out.profile = "custom";
            }
          }
          // Composio token is write-only: overwrite only when a non-empty value is sent; an explicit
          // clear flag empties it.
          if (typeof body.composioToken === "string" && body.composioToken.length > 0) out.composioToken = body.composioToken.trim();
          if (body.clearComposioToken === true) out.composioToken = "";
          if (typeof body.toolboxToken === "string" && body.toolboxToken.length > 0) out.toolboxToken = body.toolboxToken.trim();
          if (body.clearToolboxToken === true) out.toolboxToken = "";
          // Owner labels (who the shared channel token authenticates as). Not secret — plain strings
          // that always round-trip; an empty string clears the label.
          if (typeof body.composioTokenLabel === "string") out.composioTokenLabel = body.composioTokenLabel.trim();
          if (typeof body.toolboxTokenLabel === "string") out.toolboxTokenLabel = body.toolboxTokenLabel.trim();
          Object.assign(out, resolveMakeToolboxUpdate(current, body));
          if (out.skillTemplate === "__unknown__") throw Object.assign(new Error(`unknown skill template "${String(body.skillTemplate).trim()}"`), { statusCode: 400 });
          return out;
        });
      };
      const next_ = Array.isArray(body.allowedUsers)
        ? await withChannelMembershipLock(channelId, commitMeta)
        : await commitMeta();
      await ensureChannelFolder(entry.slug, next_); // refresh lockdown + skills now
      res.json({ ok: true, meta: maskChannelMeta(next_) });
    } catch (e) {
      if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
      if (/^Make toolbox /i.test(String(e?.message || "")))
        return res.status(400).json({ error: String(e.message) });
      next(e);
    }
  });

  // Read-only Make MCP toolbox probe. It initializes the remote MCP and calls tools/list only;
  // unsaved fields let an admin verify a toolbox before committing it to this channel.
  router.post("/channels/:channelId/make-toolbox-test", async (req, res, next) => {
    try {
      const { channelId } = req.params;
      const index = await getChannelsIndex();
      const entry = index[channelId];
      if (!entry) return res.status(404).json({ error: "unknown channel" });
      const current = (await getChannelMeta(entry.slug)) ?? {};
      let pair;
      try {
        pair = resolveMakeToolboxUpdate(current, req.body ?? {});
        if (!pair.makeToolboxUrl || !pair.makeToolboxKey)
          return res.status(400).json({ error: "Make toolbox URL and key are both required" });
      } catch (error) {
        return res.status(400).json({ error: String(error?.message || "Invalid Make toolbox configuration") });
      }
      try {
        const result = await testMakeToolbox({
          url: pair.makeToolboxUrl,
          key: pair.makeToolboxKey,
          timeoutMs: 10_000,
        });
        res.json({ ok: true, count: result.count, tools: result.tools });
      } catch {
        res.status(400).json({ error: "Could not connect to the Make toolbox" });
      }
    } catch (e) {
      next(e);
    }
  });

  // Test the Google Drive sync connection for one channel: does the service account authenticate
  // and can it see the configured folder? Read-only (rclone lsf); accepts an unsaved link in the
  // body so the admin can validate before saving. Returns { ok, output } — never a run.
  router.post("/channels/:channelId/sync-test", async (req, res, next) => {
    try {
      const { channelId } = req.params;
      const index = await getChannelsIndex();
      const entry = index[channelId];
      if (!entry) return res.status(404).json({ error: "unknown channel" });
      const body = req.body ?? {};
      const link = typeof body.syncDriveFolder === "string" && body.syncDriveFolder.trim()
        ? body.syncDriveFolder
        : (await getChannelMeta(entry.slug))?.syncDriveFolder || "";
      const result = await testChannelSync({ syncDriveFolder: link });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // Reset every channel's ACCESS to the org defaults: who-can-use → the org default access policy,
  // who-can-manage → org admins only, custom manager + guest lists cleared. Capability profile,
  // skills, connectors and tokens are deliberately left untouched (this is an access reset only).
  // Destructive → the UI confirms first; audit-logged. DMs are skipped (governed by user approval).
  router.post("/channels/reset-access", async (_req, res, next) => {
    try {
      const orgDefault = getDefaultChannelAccess();
      const channels = (await listChannels()).filter((c) => !c.isDM && c.type !== "im");
      let reset = 0;
      for (const ch of channels) {
        const current = ch.meta ?? defaultChannelMeta({ channelId: ch.channelId, name: ch.name, type: ch.type, isDM: ch.isDM });
        const next_ = { ...current, access: orgDefault, manageAccess: "admins", managers: [], allowedUsers: [] };
        await saveChannelMeta(ch.slug, next_);
        await ensureChannelFolder(ch.slug, next_);
        reset++;
      }
      await logEvent("channels_access_reset", { count: reset, orgDefault });
      res.json({ ok: true, count: reset, orgDefault });
    } catch (e) {
      next(e);
    }
  });

  // Push the org-default no-response nudge onto EVERY existing channel AND DM's meta.nudges. New
  // conversations already capture the default at join; this is the "apply to what's already here"
  // action. Only meta.nudges changes — every other capability/token is left untouched. Audit-logged.
  router.post("/channels/reset-nudges", async (_req, res, next) => {
    try {
      const nudges = getDefaultNudges();
      const all = await listChannels(); // channels + DMs
      let reset = 0;
      for (const ch of all) {
        // Function patch: atomic read-modify-write. A never-configured channel gets a full default
        // record (never a nudges-only partial); an existing one keeps every other field.
        const patched = await patchChannelMeta(ch.slug, (current) => {
          const base = current ?? defaultChannelMeta({ channelId: ch.channelId, name: ch.name, type: ch.type, isDM: ch.isDM });
          return { ...base, nudges };
        });
        if (patched) reset++;
      }
      await logEvent("channels_nudges_reset", { count: reset, nudges });
      res.json({ ok: true, count: reset, nudges });
    } catch (e) {
      next(e);
    }
  });

  // Clear every channel's engine + model overrides so future runs inherit Settings → Engine &
  // runtime again. DMs are deliberately skipped: this action says channels, and their runtime is
  // governed separately by the User/Admin DM templates. Only these two fields change; effort,
  // capabilities, access, tools and credentials are preserved. Audit-logged.
  router.post("/channels/reset-runtime", async (_req, res, next) => {
    try {
      const channels = (await listChannels()).filter((c) => !c.isDM && c.type !== "im");
      let reset = 0;
      for (const ch of channels) {
        const patched = await patchChannelMeta(ch.slug, (current) => {
          const base = current ?? defaultChannelMeta({ channelId: ch.channelId, name: ch.name, type: ch.type, isDM: ch.isDM });
          return { ...base, engine: "", model: "" };
        });
        if (patched) reset++;
      }
      await logEvent("channels_runtime_reset", { count: reset });
      res.json({ ok: true, count: reset });
    } catch (e) {
      next(e);
    }
  });

  // Resolve a channel id to its index entry, meta, and effective work dir (where CLAUDE.md /
  // MEMORY.md live). Returns null for an unknown channel. Falls back to default meta so a
  // never-configured channel still resolves.
  async function resolveChannelCtx(channelId) {
    const index = await getChannelsIndex();
    const entry = index[channelId];
    if (!entry) return null;
    const meta =
      (await getChannelMeta(entry.slug)) ??
      defaultChannelMeta({ channelId, name: entry.name, type: entry.type, isDM: entry.isDM });
    return { entry, meta, workDir: effectiveWorkDir(entry.slug, meta) };
  }

  // ── Per-channel environment secrets ─────────────────────────────────────────
  // The admin UI authenticates ONE shared admin password, so there is no per-person identity to
  // attribute a write to. Say that plainly in setBy rather than inventing a name.
  // A channel's own CLI logins, injected as process environment at spawn (config/channel-env.js).
  // GET returns names + last4 and NOTHING else; there is no reveal route here or in
  // web/secrets.js, by design — a value that cannot be read back cannot be copied out.
  router.get("/channels/:channelId/env", async (req, res, next) => {
    try {
      const ctx = await resolveChannelCtx(req.params.channelId);
      if (!ctx) return res.status(404).json({ error: "unknown channel" });
      res.json({ vars: listChannelEnv(ctx.meta), suggested: cliEnvKeys(cliIntegrationIds()) });
    } catch (e) {
      next(e);
    }
  });

  // Add or update one variable. The two are the same blind write — the stored value is never read
  // on the way through, so nothing can leak back out of an update.
  router.put("/channels/:channelId/env/:name", async (req, res, next) => {
    try {
      const ctx = await resolveChannelCtx(req.params.channelId);
      if (!ctx) return res.status(404).json({ error: "unknown channel" });
      const value = typeof req.body?.value === "string" ? req.body.value : "";
      let saved;
      try {
        // Function form: read-modify-write inside the store transaction, so two admins adding
        // different variables at the same time can't clobber each other's entry.
        saved = await patchChannelMeta(ctx.entry.slug, (existing) => ({
          env: patchChannelEnv(existing?.env, { set: { name: req.params.name, value }, actor: WEB_ADMIN_ACTOR }),
        }));
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      await ensureChannelFolder(ctx.entry.slug, effectiveMeta(saved));
      // Name only. The audit trail must never carry what was set.
      logEvent("channel_env_set", { slug: ctx.entry.slug, name: req.params.name, actor: WEB_ADMIN_ACTOR });
      res.json({ ok: true, vars: listChannelEnv(saved) });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/channels/:channelId/env/:name", async (req, res, next) => {
    try {
      const ctx = await resolveChannelCtx(req.params.channelId);
      if (!ctx) return res.status(404).json({ error: "unknown channel" });
      let saved;
      try {
        saved = await patchChannelMeta(ctx.entry.slug, (existing) => ({ env: patchChannelEnv(existing?.env, { remove: req.params.name }) }));
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      await ensureChannelFolder(ctx.entry.slug, effectiveMeta(saved));
      logEvent("channel_env_removed", { slug: ctx.entry.slug, name: req.params.name, actor: WEB_ADMIN_ACTOR });
      res.json({ ok: true, vars: listChannelEnv(saved) });
    } catch (e) {
      next(e);
    }
  });

  // ── Channel memory (MEMORY.md index + memory/ topic files) ──────────────────
  // MEMORY.md is the channel's budgeted memory INDEX (the agent maintains it via the
  // update_channel_memory tool); memory/<topic>.md files carry depth. The admin UI edits the
  // index directly and lists the topic files read-only. Saving over budget is allowed here
  // (admin override) — the response carries used/budget so the UI can warn that agent adds will
  // fail until it's consolidated. Paths come from the trusted slug + fixed names (no traversal).
  router.get("/channels/:channelId/memory", async (req, res, next) => {
    try {
      const ctx = await resolveChannelCtx(req.params.channelId);
      if (!ctx) return res.status(404).json({ error: "unknown channel" });
      const file = path.join(ctx.workDir, MEM_FILE);
      const stored = await readNoFollow(file); // null = absent OR a refused symlink
      const content = stored ?? "";
      const exists = stored !== null;
      let topics = [];
      try {
        topics = (await readdir(path.join(ctx.workDir, MEM_DIR))).filter((f) => f.endsWith(".md")).sort();
      } catch {
        /* no topics dir yet */
      }
      res.json({
        content,
        exists,
        path: file,
        enabled: memoryEnabled(ctx.meta),
        budget: memoryBudget(ctx.meta),
        used: content.length,
        topics,
      });
    } catch (e) {
      next(e);
    }
  });

  router.put("/channels/:channelId/memory", async (req, res, next) => {
    try {
      const ctx = await resolveChannelCtx(req.params.channelId);
      if (!ctx) return res.status(404).json({ error: "unknown channel" });
      const content = typeof req.body?.content === "string" ? req.body.content : "";
      const file = path.join(ctx.workDir, MEM_FILE);
      await ensureRealDir(path.dirname(file));
      await writeNoFollow(file, content);
      res.json({ ok: true, path: file, used: content.length, budget: memoryBudget(ctx.meta) });
    } catch (e) {
      next(e);
    }
  });

  // ── Channel instructions (CLAUDE.md) ────────────────────────────────────────
  // The channel's CLAUDE.md IS the channel's own instructions: user/agent-owned, persistent,
  // never regenerated. The gateway contributes only a managed block on top (global instructions +
  // Slack guide + memory note) — returned separately here so the UI can show it read-only. The
  // editor edits the channel-owned section of the REAL file; a content hash detects concurrent
  // edits (e.g. the agent adding a rule while the editor is open). Channels on a custom
  // (real-project) working folder have no managed block — the whole project file is edited raw.
  const fileHash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

  router.get("/channels/:channelId/instructions", async (req, res, next) => {
    try {
      const ctx = await resolveChannelCtx(req.params.channelId);
      if (!ctx) return res.status(404).json({ error: "unknown channel" });
      const custom = ctx.workDir !== workspaceFolder(ctx.entry.slug, ctx.meta?.platform);
      const file = path.join(ctx.workDir, "CLAUDE.md");
      let raw = await readNoFollow(file);
      if (raw === null && !custom) {
        // Default folder never provisioned yet — materialize it so the editor shows reality.
        await ensureChannelFolder(ctx.entry.slug, effectiveMeta(ctx.meta));
        raw = await readNoFollow(file); // still null when the agentsFile toggle is off
      }
      raw ??= "";
      const eff = effectiveMeta(ctx.meta);
      res.json({
        channel: custom ? raw : splitGatewayBlock(raw).rest.trim(),
        global: custom ? "" : gatewayInstructionsBlock(eff).split("\n").slice(1, -1).join("\n"),
        path: file,
        customFolder: custom,
        hash: fileHash(raw),
      });
    } catch (e) {
      next(e);
    }
  });

  router.put("/channels/:channelId/instructions", async (req, res, next) => {
    try {
      const ctx = await resolveChannelCtx(req.params.channelId);
      if (!ctx) return res.status(404).json({ error: "unknown channel" });
      const custom = ctx.workDir !== workspaceFolder(ctx.entry.slug, ctx.meta?.platform);
      const file = path.join(ctx.workDir, "CLAUDE.md");
      const body = typeof req.body?.channel === "string" ? req.body.channel : "";
      const cur = (await readNoFollow(file)) ?? ""; // absent, or a refused symlink
      const expected = typeof req.body?.hash === "string" ? req.body.hash : "";
      if (expected && expected !== fileHash(cur)) {
        return res.status(409).json({ error: "The file changed since you loaded it (agent or another editor). Reload and re-apply your edit." });
      }
      let content;
      if (custom) {
        content = body; // raw project file — written as-is, no managed block
      } else {
        const eff = effectiveMeta(ctx.meta);
        const own = body.trim() || channelSeed(ctx.entry.name || ctx.entry.slug);
        content = `${gatewayInstructionsBlock(eff)}\n\n${own.replace(/\s+$/, "")}\n`;
      }
      await ensureRealDir(path.dirname(file));
      await writeNoFollow(file, content);
      res.json({ ok: true, hash: fileHash(content) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
