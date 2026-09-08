// Express app factory. Slice 1 mounts only health + static hosting of the admin UI;
// the admin REST API is added in Slice 5. Deps are injected so the app stays testable.
import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEngineHealth } from "../engines/engine-health.js";
import { gatewayRoot } from "../config/paths.js";
import { effectiveWorkDir } from "../gateway/folders.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { buildResumeCommand } from "../slack/footer.js";
import { effectiveMeta } from "../gateway/run.js";
import { listChannels } from "../config/store.js";
import { createAdminRouter } from "./routes/admin.js";
import { mountSkillsPublicRoutes } from "./skills-mcp.js";
import { triggerSourceSync } from "../gateway/skills/index.js";
import { createRunsRouter } from "./routes/runs.js";
import { platformOfConversation } from "../platforms/ids.js";
import { platformOr } from "../platforms/registry.js";
import { createFileEditorRouter } from "./file-editor.js";
import { createFileDownloadRouter } from "./file-download.js";
import { createApprovalLinkRouter } from "./routes/approve.js";
import { createFileUploadRouter } from "./file-upload.js";
import { poolStats } from "../engines/session-pool.js";
import { getEngine, isEngineEnabled } from "../config/settings.js";
import { resumeCommandFor } from "../engines/registry.js";
import { authMiddleware, noPasswordLockdown, handleLogin, handleLogout, authEnabled, isAuthenticated } from "./auth.js";
import { isLoopbackHost, hostAllowed } from "./security.js";
import { dropCounts } from "../util/drops.js";
import { fileExplorerContext, requestApproval } from "../slack/app.js";
import { canEditChannelFiles } from "../slack/file-explorer.js";
import { ADMIN_CONVERSATION_PATH_RE, ADMIN_VIEW_PATHS } from "../../public/admin-routes.js";
import { runUpdateSmoke } from "../gateway/update-smoke.js";
import { runningRevision, startUpdate } from "../gateway/updater.js";
import { publicUpdateState, readUpdateStatus } from "../gateway/update-state.js";
import { renderShell } from "./assets.js";

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "..", "public");
const adminShell = "index.html";

// The non-identifying half of the Slack manager's snapshot: is this daemon actually attached to
// Slack right now, and in which lifecycle state (connected | connecting | disconnected | error)?
// This is what /api/health serves an unauthenticated liveness probe. It deliberately drops the
// workspace/bot identity and the connect error string. A manager that is missing entirely (early
// boot, tests) reports the truthful pessimistic answer rather than an absent field: a monitor that
// reads no state at all has to guess, and guessing "down" is how a restart loop starts.
function slackLiveness(slack) {
  const snap = slack?.snapshot?.();
  return { status: snap?.status ?? "disconnected", connected: snap?.connected === true };
}

export function createWebApp({
  slack,
  transports = null,
  backgroundJobs,
  restartCoordinator,
  updateSmoke = runUpdateSmoke,
  startGatewayUpdate = startUpdate,
  // Container-runtime health (v0.8). Injected by src/server.js, which owns the lazy, never-throwing
  // load of the backend; the default keeps every other caller (and the tests) honest about the fact
  // that nothing is wired rather than pretending the feature is off.
  containerRuntimeStatus = async () => ({ ok: false, enabled: false, cli: "", reason: "container runtime is not wired in this process", running: 0 }),
} = {}) {
  const app = express();
  // Identifies this exact daemon process. The update UI compares the value returned by the old
  // process with /api/health while polling, so a restart is observable even when it happens
  // entirely between two health requests (and the browser never sees a failed request).
  const instanceId = randomUUID();
  // The run API accepts inline base64 files, so its router parses its own (larger) body — skip the
  // small app-wide parser for /api/runs, which would otherwise reject those payloads up front.
  // The skill catalog's own MCP endpoint (bearer access tokens) and the GitHub push webhook (HMAC
  // over the raw body). Both authenticate themselves and are mounted before the admin session
  // middleware and the shared JSON parser (the webhook needs the raw bytes).
  mountSkillsPublicRoutes(app, { triggerSync: (id) => triggerSourceSync(id) });

  const jsonParser = express.json({ limit: "1mb" });
  app.use((req, res, next) => (req.path.startsWith("/api/runs") || req.path.startsWith("/file-download") || req.path.startsWith("/file-editor") || req.path.startsWith("/file-upload") || req.path.startsWith("/approve/") || req.path === "/api/skills/webhook/github" || req.path === "/mcp/skills" ? next() : jsonParser(req, res, next)));

  // Auth: login/logout are always reachable; everything else is gated when ADMIN_PASSWORD is set.
  app.post("/api/login", handleLogin);
  app.post("/api/logout", handleLogout);

  // Same-machine IPC guard for /internal/*: the gateway MCP server (a child process on this
  // host) calls these over 127.0.0.1 with the per-process secret. Both are required — even on a
  // deliberately non-loopback bind these endpoints never serve network callers.
  const internalForbidden = (req) => {
    const secret = process.env.CG_APPROVAL_SECRET || "";
    if (!secret || req.headers["x-cg-secret"] !== secret) return true;
    return !isLoopbackHost(req.socket?.remoteAddress);
  };

  // Internal IPC (not behind admin auth): the gateway MCP server's run_in_background tool calls
  // this to hand a long-running shell job to the daemon. The daemon tracks it and, on completion,
  // re-injects a turn into the same thread to continue automatically. Localhost + shared secret.
  app.post("/internal/background", async (req, res) => {
    if (internalForbidden(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    if (!backgroundJobs) return res.json({ ok: false, error: "background jobs unavailable" });
    try {
      res.json(await backgroundJobs.start(req.body || {}));
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Safe lifecycle hand-off for the gateway MCP restart tool. The coordinator responds
  // immediately, lets the requesting turn finish, then checks all daemon work repeatedly before
  // it begins shutdown. Same-machine signed IPC, like background jobs and approvals.
  app.post("/internal/restart", async (req, res) => {
    if (internalForbidden(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    if (!restartCoordinator) return res.json({ ok: false, error: "safe restart is unavailable" });
    try {
      const result = restartCoordinator.request(req.body || {});
      res.status(result.conflict ? 409 : 202).json(result);
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Internal IPC (not behind admin auth): the gateway MCP server's permission_prompt tool calls
  // this to surface Slack approval buttons and block until a decision. Localhost + a per-process
  // shared secret only; never exposed to the UI. Holds the response until resolved (long-poll).
  app.post("/internal/approval", async (req, res) => {
    if (internalForbidden(req)) return res.status(403).json({ allow: false, reason: "forbidden" });
    try {
      res.json(await requestApproval(slack, req.body || {}));
    } catch (e) {
      res.json({ allow: false, reason: e.message });
    }
  });

  // Transactional self-update readiness uses a REAL Claude turn, but it must never inherit a
  // channel's tools or run in an ungated directory. The injected smoke harness owns that isolated
  // folder; this route is same-machine IPC only, using the same rotating secret as approvals.
  app.post("/internal/update-smoke", async (req, res) => {
    if (internalForbidden(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    try {
      const requiredEngines = Array.isArray(req.body?.requiredEngines) ? req.body.requiredEngines.filter((id) => typeof id === "string") : [];
      const result = await updateSmoke({ requiredEngines });
      res.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      res.status(503).json({ ok: false, error: String(error?.message || "update smoke failed").split(/\r?\n/, 1)[0].slice(0, 240) });
    }
  });

  // Microsoft Teams inbound. Azure Bot Service POSTs activities here; there is no outbound-only
  // receive path on this platform, so a public endpoint is the transport.
  //
  // Mounted AHEAD of the admin-auth stack and ahead of the Host/Origin guard, deliberately:
  //   • it authenticates every request itself, against the Bot Framework JWKS, and rejects anything
  //     that is not a token minted for THIS bot (src/platforms/msteams/verify.js)
  //   • it carries no ambient authority — no session cookie is read, so the DNS-rebinding attack
  //     that guard exists to stop (a browser page driving the admin API) has nothing to steal here
  // An unconnected Teams transport answers 503 rather than 404: "not configured" and "wrong URL"
  // are different problems for whoever is registering the endpoint in Azure.
  app.post("/api/teams/messages", async (req, res) => {
    const handler = transports?.msteams?.getTransport?.()?.handler;
    if (!handler) return res.status(503).json({ error: "Teams transport is not connected" });
    try {
      await handler(req, res);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: "teams handler failed" });
      console.error("[msteams] webhook error:", e?.message || e);
    }
  });

  // Graph basic notifications authenticate using persisted subscription identity and clientState.
  // No admin cookie is consumed; the handler also handles Graph's endpoint validation challenge.
  app.post("/api/teams/notifications", async (req, res) => {
    const handler = transports?.msteams?.getTransport?.()?.graphHandler;
    if (!handler) return res.status(503).json({ error: "Teams message events are not enabled" });
    try { await handler(req, res); }
    catch { if (!res.headersSent) res.status(503).json({ error: "Teams event delivery failed" }); }
  });

  // Short-lived, single-file browser editor links originate from an authorized Slack file modal.
  // This router sits outside the admin login because ordinary approved channel members are allowed
  // to edit in writable modes; it has its own one-time grant → HttpOnly cookie exchange and repeats
  // the full Slack authorization/membership/mode check on open, page load, and every save.
  app.use("/file-editor", createFileEditorRouter({
    authorize: async (grant) => {
      const adapter = platformOr(platformOfConversation(grant.channelId));
      if (adapter.workspaceAccess) {
        const context = await adapter.workspaceAccess(grant);
        if (!canEditChannelFiles(effectiveMeta(context.meta), { isAdminUser: context.userIsAdmin })) throw new Error("This workspace is read-only for you.");
        return context;
      }
      const client = slack?.getClient?.();
      if (!client) throw new Error("Slack is disconnected; reconnect the gateway and reopen the editor.");
      const context = await fileExplorerContext(client, {
        channelId: grant.channelId,
        userId: grant.ownerId,
        expectedSlug: grant.slug,
        verifyMembership: true,
      });
      if (!canEditChannelFiles(effectiveMeta(context.meta), { isAdminUser: context.userIsAdmin })) {
        throw new Error("Editing is no longer enabled for you in this channel mode.");
      }
      return context;
    },
  }));

  // Direct downloads are available in every channel mode when Public URL is configured. The
  // one-use link repeats the explorer's authorization and membership check before streaming one
  // re-confined file; it grants no write capability and creates no Slack file copy.
  app.use("/file-download", createFileDownloadRouter({
    authorize: async (grant) => {
      const adapter = platformOr(platformOfConversation(grant.channelId));
      if (adapter.workspaceAccess) return adapter.workspaceAccess(grant);
      const client = slack?.getClient?.();
      if (!client) throw new Error("Slack is disconnected; reconnect the gateway and reopen the file preview.");
      return fileExplorerContext(client, {
        channelId: grant.channelId,
        userId: grant.ownerId,
        expectedSlug: grant.slug,
        verifyMembership: true,
      });
    },
  }));

  // Browser file/folder upload links use the same authorization boundary as browser editing, but
  // stream one bounded raw file per request so directory trees need no multipart dependency and
  // never sit in memory as one giant archive.
  app.use("/file-upload", createFileUploadRouter({
    authorize: async (grant) => {
      const adapter = platformOr(platformOfConversation(grant.channelId));
      if (adapter.workspaceAccess) {
        const context = await adapter.workspaceAccess(grant);
        if (!canEditChannelFiles(effectiveMeta(context.meta), { isAdminUser: context.userIsAdmin })) throw new Error("This workspace is read-only for you.");
        return context;
      }
      const client = slack?.getClient?.();
      if (!client) throw new Error("Slack is disconnected; reconnect the gateway and reopen the uploader.");
      const context = await fileExplorerContext(client, {
        channelId: grant.channelId,
        userId: grant.ownerId,
        expectedSlug: grant.slug,
        verifyMembership: true,
      });
      if (!canEditChannelFiles(effectiveMeta(context.meta), { isAdminUser: context.userIsAdmin })) {
        throw new Error("Uploading is no longer enabled for you in this channel mode.");
      }
      return context;
    },
  }));

  // Link-based approvals. Public by design and mounted outside the admin login: the token in the
  // URL IS the credential, minted for one person, single-use, expiring, and re-checked against the
  // approval's own authorization on every POST. GET renders a confirmation page and changes
  // nothing — link unfurlers, preview services and scanning proxies fetch these URLs, so a GET
  // with a side effect would let the unfurler decide the request before the human saw it.
  app.use("/approve", createApprovalLinkRouter({ slack }));

  // DNS-rebinding guard: refuse API requests whose Host/Origin isn't an address we recognise, so
  // an attacker page that rebinds its hostname to 127.0.0.1 can't drive the admin API from a
  // victim's browser. Add a tunnel/reverse-proxy hostname via settings `publicUrl` (or
  // CG_ALLOWED_HOSTS). Ahead of auth: this holds even on a passwordless install, which is exactly
  // the case with no session cookie to be missing.
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    if (hostAllowed(req)) return next();
    // A machine-readable code, because the admin UI has to recognise THIS refusal specifically:
    // it is the one 403 the operator can fix, and the page that fixes it is behind the same guard.
    // The Host header itself is attacker-controlled, so it is never echoed back — the client
    // already knows the hostname it used (location.host) and shows that instead.
    return res.status(403).json({
      code: "host_not_allowed",
      error:
        "Refused: unrecognized Host/Origin. If you reach the gateway through a tunnel or reverse proxy, " +
        "set its hostname as `publicUrl` in settings (or CG_ALLOWED_HOSTS).",
    });
  });

  app.use(noPasswordLockdown); // no admin password → privileged API refused on every bind (see auth.js)
  app.use(authMiddleware);

  app.get("/api/health", async (req, res) => {
    // Health is deliberately reachable without a session (it is how the UI detects a restart), so
    // it must not volunteer reconnaissance: the absolute gateway path leaks the OS username, the
    // Slack snapshot names the workspace and bot, and authEnabled:false advertises an open API.
    // An unidentified caller gets only what a liveness check needs. Two callers can identify
    // themselves: a logged-in admin's session cookie, and a same-machine process holding this
    // process's internal secret — which is how the detached self-updater (scripts/update-runner.mjs)
    // reads the revision it gates the whole transaction on. The internal guard is strictly
    // narrower than a session (loopback + rotating per-process secret), so it widens nothing for
    // a network caller.
    //
    // The one thing a stranger DOES get beyond identity is the Slack CONNECTION STATE, because a
    // liveness probe that cannot tell "up and connected" from "up but wedged offline" is worse
    // than no probe: an operator watchdog read the missing `slack` as unknown, called a healthy
    // daemon disconnected, and restarted it every 10 minutes forever (@here each time).
    // `connected`/`status` are facts about THIS process, not reconnaissance — the workspace/bot
    // names and the connect error text (which can quote credentials) stay behind a session.
    if (!isAuthenticated(req) && internalForbidden(req)) return res.json({ ok: true, instanceId, slack: slackLiveness(slack) });

    // `engines` carries every registered harness (availability + sign-in state + whether the
    // operator has it switched on, so the UI can show the ones that actually run turns);
    // `claude` stays for the existing UI/update-flow readers that ask for it by name.
    const health = await getEngineHealth();
    const engines = Object.fromEntries(Object.entries(health).map(([id, check]) => [id, { ...check, enabled: isEngineEnabled(id) }]));
    res.json({
      ok: true,
      instanceId,
      revision: runningRevision,
      update: publicUpdateState(readUpdateStatus()),
      claude: engines.claude,
      engines,
      gatewayRoot: gatewayRoot(),
      warmSessions: poolStats().warm,
      // Dropped best-effort writes (usage ledger / event log / bg-job persists) since boot —
      // non-zero means the dashboards are silently under-counting (see src/util/drops.js).
      droppedWrites: dropCounts(),
      authEnabled: authEnabled(),
      slack: slack?.snapshot?.() ?? slackLiveness(slack),
      // Where channel runs execute: the kill switch, the detected container CLI, why it is
      // unavailable when it is, and how many channel containers are up. Behind the same identity
      // gate as the rest of this payload — it names host tooling.
      containerRuntime: await containerRuntimeStatus().catch((e) => ({ ok: false, reason: e?.message || String(e) })),
    });
  });

  app.use("/api", createAdminRouter({ slack, transports, instanceId, startGatewayUpdate, restartCoordinator }));

  // HTTP run API (start a run + poll status). Gated by the same auth middleware above, which also
  // accepts a matching X-API-Key / Bearer key for these routes specifically.
  app.use("/api/runs", createRunsRouter({ slack }));

  // Resume helper: the footer's "resume" link points here. Shows the terminal command to
  // resume the session and copies it to the clipboard on click. Renders text only (no exec).
  app.get("/resume", async (req, res) => {
    const slug = String(req.query.slug || "").replace(/[^a-zA-Z0-9._-]/g, "");
    const session = String(req.query.session || "").replace(/[^a-zA-Z0-9-]/g, "");
    if (!slug || !session) return res.status(400).send("missing slug/session");
    // The command must name the folder the session actually ran in (the channel's WORK dir — a
    // custom workDir or ~/ChannelGate/<platform>/<slug> — never the hidden metadata folder), use
    // the channel's engine, and enter the channel container first when the channel runs in one
    // (src/runtimes/). Resolved from the channel record rather than assumed.
    const meta = (await listChannels()).find((c) => c.slug === slug)?.meta || {};
    const engine = meta.engine || getEngine();
    let target = null;
    try {
      target = resolveRuntime(slug, meta);
    } catch {
      /* host form below */
    }
    const workDir = target?.workDir || effectiveWorkDir(slug, meta);
    const cmd = buildResumeCommand(workDir, session, engine, target) || `cd ${JSON.stringify(workDir)} && ${resumeCommandFor(engine, session)}`;
    const cmdJs = JSON.stringify(cmd);
    res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Resume — ${escapeHtml(slug)}</title>
<style>
  body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1117;color:#e7e9ee;display:grid;place-items:center;min-height:100vh;margin:0}
  .card{background:#171a23;border:1px solid #2a2f3d;border-radius:12px;padding:24px;max-width:680px;width:90%}
  h1{font-size:16px;margin:0 0 4px}.sub{color:#9aa3b2;font-size:12px;margin:0 0 16px}
  pre{background:#1e222e;border:1px solid #2a2f3d;border-radius:8px;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:#e7e9ee}
  button{background:#c98a3a;color:#1a1206;border:none;padding:9px 16px;border-radius:8px;cursor:pointer;font-weight:600}
  .ok{color:#45c46a;font-size:12px;margin-left:10px}
</style></head><body>
  <div class="card">
    <h1>Resume this session in your terminal</h1>
    <p class="sub">Channel: <code>${escapeHtml(slug)}</code> · session <code>${escapeHtml(session)}</code></p>
    <pre id="cmd">${escapeHtml(cmd)}</pre>
    <button onclick="copy()">Copy command</button><span id="ok" class="ok"></span>
  </div>
  <script>
    const CMD=${cmdJs};
    function copy(){navigator.clipboard.writeText(CMD).then(()=>{document.getElementById('ok').textContent='Copied ✓';}).catch(()=>{document.getElementById('ok').textContent='Press ⌘C to copy';});}
    copy();
  </script>
</body></html>`);
  });

  // Every sidebar page has a real URL. Serve the same authenticated SPA shell for direct visits
  // and refreshes; app.js restores the matching view and manages in-page browser history.
  const sendAdminShell = (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(renderShell(publicDir, adminShell));
  };
  // "/" and "/index.html" are handled here too, ahead of express.static: static would serve the
  // shell straight off disk with its `{{ASSET_V}}` placeholders unsubstituted and no import map,
  // i.e. an unversioned module graph on the one entry point most people actually type.
  app.get(["/", "/index.html"], sendAdminShell);
  app.get(ADMIN_VIEW_PATHS, sendAdminShell);
  app.get(ADMIN_CONVERSATION_PATH_RE, sendAdminShell);

  // A Cloudflare tunnel sits in front, so a new deploy was being hidden behind stale cached JS. Two
  // layers now prevent that: the content stamp on every asset URL (src/web/assets.js) makes a
  // changed file a NEW url, and `no-cache` makes every cache revalidate the unstamped ones — ETag
  // keeps that a cheap 304. `index:false` leaves the shell to sendAdminShell above, which is the
  // only path allowed to serve it (static would ship the raw, unstamped template).
  app.use(
    express.static(publicDir, {
      index: false,
      setHeaders(res, filePath) {
        if (/\.(html|js|css)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
      },
    })
  );
  return app;
}
