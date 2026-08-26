// Public browser uploader for multiple files and directory trees.
//
// Slack provides the entry point, but never receives a filesystem path or reusable credential.
// A one-time, user/channel/folder-scoped grant becomes an HttpOnly session cookie; every page load
// and file write repeats Slack authorization/membership/mode checks through `authorize`.
import crypto from "node:crypto";
import express from "express";
import { MAX_BROWSER_UPLOAD_BYTES, normalizeBrowserUploadPath, resolveVisiblePath, saveBrowserUploadedFile } from "../slack/file-explorer.js";
import { logEvent } from "../util/logger.js";
import { timingSafeEqualStr } from "./security.js";

export const BROWSER_UPLOAD_MAX_FILES = 200;
export const BROWSER_UPLOAD_MAX_TOTAL_BYTES = 250 * 1024 * 1024;
export const FILE_UPLOAD_GRANT_TTL_MS = 10 * 60_000;
export const FILE_UPLOAD_SESSION_TTL_MS = 60 * 60_000;

const grants = new Map();
const sessions = new Map();
const MAX_GRANTS = 2_000;
const MAX_SESSIONS = 1_000;

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function prune(now = Date.now()) {
  for (const [key, value] of grants) if (value.expiresAt <= now) grants.delete(key);
  for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key);
}

function capMap(map, max) {
  while (map.size >= max) map.delete(map.keys().next().value);
}

export function resetFileUploadStateForTests() {
  grants.clear();
  sessions.clear();
}

export function createFileUploadGrantUrl({ baseUrl, channelId, slug, ownerId, relative = "", threadTs = "", now = Date.now() } = {}) {
  let base;
  try {
    base = new URL(String(baseUrl || ""));
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return "";
  if (!channelId || !slug || !ownerId) return "";
  prune(now);
  capMap(grants, MAX_GRANTS);
  const token = randomToken();
  grants.set(digest(token), {
    channelId: String(channelId),
    slug: String(slug),
    ownerId: String(ownerId),
    relative: String(relative || ""),
    threadTs: String(threadTs || ""),
    expiresAt: now + FILE_UPLOAD_GRANT_TTL_MS,
  });
  base.search = "";
  base.hash = "";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/file-upload/open/${token}`;
  return base.toString();
}

function consumeGrant(token, now = Date.now()) {
  prune(now);
  const key = digest(token);
  const grant = grants.get(key);
  grants.delete(key);
  return grant?.expiresAt > now ? grant : null;
}

function parseCookies(header) {
  const result = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function secureRequest(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return Boolean(req.secure || forwarded === "https");
}

function cookieName(uploadId) {
  return `cg_file_upload_${uploadId}`;
}

function cookieFor(req, uploadId, secret, maxAgeSeconds) {
  const secure = secureRequest(req) ? "; Secure" : "";
  return `${cookieName(uploadId)}=${secret}; HttpOnly; SameSite=Strict; Path=/file-upload/${uploadId}; Max-Age=${maxAgeSeconds}${secure}`;
}

function getSession(req, uploadId, now = Date.now()) {
  prune(now);
  const session = sessions.get(uploadId);
  const secret = parseCookies(req.headers.cookie)[cookieName(uploadId)] || "";
  if (!session || !secret || !timingSafeEqualStr(digest(secret), session.cookieHash)) return null;
  if (session.expiresAt <= now) {
    sessions.delete(uploadId);
    return null;
  }
  return session;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 ** 2) return `${Math.ceil(value / 1024)} KB`;
  return `${Math.round(value / 1024 / 1024)} MB`;
}

function pageHeaders(res, nonce = "") {
  const script = nonce ? ` 'nonce-${nonce}'` : "";
  res.set({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; style-src${script}; script-src${script}; connect-src 'self'`,
  });
}

function errorPage(res, status, message) {
  const nonce = randomToken(16);
  pageHeaders(res, nonce);
  return res.status(status).type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>File upload</title><style nonce="${nonce}">body{margin:0;background:#f7f6f3;color:#252421;font:15px system-ui;display:grid;place-items:center;min-height:100vh}.card{max-width:560px;margin:24px;padding:28px;background:#fff;border:1px solid #ddd8cf;border-radius:16px;box-shadow:0 12px 40px #0001}h1{margin:0 0 10px;font-size:22px}p{line-height:1.55;color:#625f58}</style></head><body><main class="card"><h1>File upload unavailable</h1><p>${escapeHtml(message)}</p></main></body></html>`);
}

function uploadPage(session) {
  const nonce = randomToken(16);
  const csrfJson = JSON.stringify(session.csrf).replaceAll("<", "\\u003c");
  const destination = session.grant.relative ? `/${session.grant.relative}` : "/";
  return { nonce, html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload channel files</title><style nonce="${nonce}">
:root{--ink:#201f1c;--muted:#746f67;--line:#ddd8cf;--paper:#f7f6f3;--panel:#fff;--accent:#087a5b;--bad:#b33030}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:760px;margin:42px auto;padding:0 18px}.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:0 14px 45px #0001;overflow:hidden}.head{padding:22px 24px;border-bottom:1px solid var(--line)}h1{font-size:23px;margin:0 0 6px}.sub{color:var(--muted);font-size:13px}.body{padding:24px}.pickers{display:grid;grid-template-columns:1fr 1fr;gap:12px}.pick{display:grid;place-items:center;min-height:110px;padding:18px;border:2px dashed var(--line);border-radius:12px;cursor:pointer;text-align:center;font-weight:700}.pick:hover{border-color:var(--accent)}.pick small{display:block;color:var(--muted);font-weight:400;margin-top:6px}.pick input{position:absolute;opacity:0;pointer-events:none}.summary{margin:18px 0 10px;color:var(--muted)}.files{max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:10px;display:none}.row{display:flex;gap:10px;justify-content:space-between;padding:8px 11px;border-bottom:1px solid #eeeae3;font-size:12px}.row:last-child{border-bottom:0}.row span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.actions{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:18px}button{border:0;border-radius:9px;padding:10px 17px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer}button:disabled{opacity:.5;cursor:wait}.status{color:var(--muted);font-size:13px}.status.bad{color:var(--bad)}.note{margin-top:16px;color:var(--muted);font-size:12px;line-height:1.5}@media(max-width:620px){.pickers{grid-template-columns:1fr}.shell{margin:18px auto}.actions{align-items:flex-start;flex-direction:column}button{width:100%}}
</style></head><body><main class="shell"><section class="card"><header class="head"><h1>Upload files or a folder</h1><div class="sub">Destination: ${escapeHtml(destination)} · ${escapeHtml(session.grant.slug)}</div></header><div class="body"><div class="pickers"><label class="pick">Choose files<small>Multiple files are supported</small><input id="files" type="file" multiple></label><label class="pick">Choose folder<small>Keeps its folder structure</small><input id="folder" type="file" webkitdirectory directory multiple></label></div><div id="summary" class="summary">Nothing selected.</div><div id="list" class="files"></div><div class="actions"><span id="status" class="status">Ready</span><button id="upload" type="button" disabled>Upload</button></div><p class="note">Limits: ${BROWSER_UPLOAD_MAX_FILES} files, ${formatBytes(MAX_BROWSER_UPLOAD_BYTES)} per file, ${formatBytes(BROWSER_UPLOAD_MAX_TOTAL_BYTES)} total. Existing files are kept; colliding uploads receive a numbered name. Empty folders are not included by browser folder pickers.</p></div></section></main>
<script nonce="${nonce}">
const CSRF=${csrfJson},MAX_FILES=${BROWSER_UPLOAD_MAX_FILES},MAX_FILE_BYTES=${MAX_BROWSER_UPLOAD_BYTES},MAX_TOTAL_BYTES=${BROWSER_UPLOAD_MAX_TOTAL_BYTES};const filesInput=document.getElementById("files"),folderInput=document.getElementById("folder"),summary=document.getElementById("summary"),list=document.getElementById("list"),statusEl=document.getElementById("status"),upload=document.getElementById("upload");let selected=[];
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}function bytes(n){if(n<1048576)return Math.ceil(n/1024)+" KB";return Math.round(n/1048576)+" MB"}function relative(file){return file.webkitRelativePath||file.name}function choose(input){selected=Array.from(input.files||[]);filesInput!==input&&(filesInput.value="");folderInput!==input&&(folderInput.value="");render()}
function render(){const total=selected.reduce((sum,file)=>sum+file.size,0),bad=selected.length>MAX_FILES||total>MAX_TOTAL_BYTES||selected.some(file=>file.size>MAX_FILE_BYTES);summary.textContent=selected.length?selected.length.toLocaleString()+" file(s) · "+bytes(total):"Nothing selected.";list.style.display=selected.length?"block":"none";list.innerHTML=selected.slice(0,200).map(file=>'<div class="row"><span>'+esc(relative(file))+'</span><span>'+bytes(file.size)+'</span></div>').join("");statusEl.textContent=bad?"Selection exceeds an upload limit":"Ready";statusEl.className=bad?"status bad":"status";upload.disabled=!selected.length||bad}filesInput.addEventListener("change",()=>choose(filesInput));folderInput.addEventListener("change",()=>choose(folderInput));
upload.addEventListener("click",async()=>{upload.disabled=true;let done=0;try{for(const file of selected){statusEl.textContent="Uploading "+(done+1)+" / "+selected.length+"…";const response=await fetch(location.pathname+"/api/upload?path="+encodeURIComponent(relative(file)),{method:"POST",headers:{"Content-Type":"application/octet-stream","X-CG-CSRF":CSRF},body:file});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||"Upload failed");done++}selected=[];filesInput.value="";folderInput.value="";render();statusEl.textContent="Uploaded "+done+" file(s). You can close this window.";statusEl.className="status"}catch(error){selected=selected.slice(done);render();statusEl.textContent=(done?done+" uploaded · ":"")+error.message;statusEl.className="status bad"}});render();
</script></body></html>` };
}

function enqueue(session, operation) {
  const run = session.queue.then(operation, operation);
  session.queue = run.catch(() => {});
  return run;
}

export function createFileUploadRouter({ authorize, audit = logEvent } = {}) {
  if (typeof authorize !== "function") throw new Error("file upload authorize callback is required");
  const router = express.Router();

  router.get("/open/:token", async (req, res) => {
    const grant = consumeGrant(req.params.token);
    if (!grant) return errorPage(res, 410, "This upload link expired or was already used. Reopen the channel file browser in Slack.");
    try {
      const context = await authorize(grant);
      await resolveVisiblePath(context.root, grant.relative, { kind: "directory" });
      const uploadId = randomToken(12);
      const cookieSecret = randomToken();
      capMap(sessions, MAX_SESSIONS);
      sessions.set(uploadId, {
        grant,
        cookieHash: digest(cookieSecret),
        csrf: randomToken(),
        expiresAt: Date.now() + FILE_UPLOAD_SESSION_TTL_MS,
        files: 0,
        bytes: 0,
        queue: Promise.resolve(),
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Set-Cookie", cookieFor(req, uploadId, cookieSecret, Math.floor(FILE_UPLOAD_SESSION_TTL_MS / 1000)));
      return res.redirect(303, `/file-upload/${uploadId}`);
    } catch (error) {
      return errorPage(res, 403, error.message || "You are no longer allowed to upload here.");
    }
  });

  router.get("/:uploadId", async (req, res) => {
    const session = getSession(req, req.params.uploadId);
    if (!session) return errorPage(res, 401, "This upload session expired. Reopen the channel file browser in Slack.");
    try {
      const context = await authorize(session.grant);
      await resolveVisiblePath(context.root, session.grant.relative, { kind: "directory" });
      const page = uploadPage(session);
      pageHeaders(res, page.nonce);
      return res.type("html").send(page.html);
    } catch (error) {
      return errorPage(res, 403, error.message || "You are no longer allowed to upload here.");
    }
  });

  router.post(
    "/:uploadId/api/upload",
    (req, res, next) => {
      const session = getSession(req, req.params.uploadId);
      if (!session) return res.status(401).set("Cache-Control", "no-store").json({ error: "Upload session expired. Reopen Files in Slack." });
      if (!timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) {
        return res.status(403).set("Cache-Control", "no-store").json({ error: "Invalid upload request." });
      }
      const uploadPath = String(req.query.path || "");
      if (uploadPath.length > 1200) return res.status(400).set("Cache-Control", "no-store").json({ error: "Upload path is too long." });
      let cleanPath;
      try {
        cleanPath = normalizeBrowserUploadPath(uploadPath);
      } catch (error) {
        return res.status(400).set("Cache-Control", "no-store").json({ error: error.message });
      }
      req.gatewayUpload = { session, cleanPath };
      return next();
    },
    express.raw({ type: "application/octet-stream", limit: MAX_BROWSER_UPLOAD_BYTES }),
    async (req, res) => {
      const { session, cleanPath } = req.gatewayUpload;
      const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        const saved = await enqueue(session, async () => {
          if (session.files >= BROWSER_UPLOAD_MAX_FILES) throw new Error(`This session is limited to ${BROWSER_UPLOAD_MAX_FILES} files.`);
          if (session.bytes + content.length > BROWSER_UPLOAD_MAX_TOTAL_BYTES) throw new Error(`This session is limited to ${formatBytes(BROWSER_UPLOAD_MAX_TOTAL_BYTES)} total.`);
          const context = await authorize(session.grant);
          const result = await saveBrowserUploadedFile(context.root, session.grant.relative, cleanPath, content);
          session.files += 1;
          session.bytes += result.bytes;
          await audit("channel_file_uploaded_in_browser", {
            channel: session.grant.channelId,
            author: session.grant.ownerId,
            slug: session.grant.slug,
            file: result.relative,
            source: result.sourceRelative,
            bytes: result.bytes,
          });
          return result;
        });
        return res.set("Cache-Control", "no-store").json({ ok: true, file: saved.relative, bytes: saved.bytes, renamed: saved.renamed });
      } catch (error) {
        return res.status(403).set("Cache-Control", "no-store").json({ error: error.message || "Upload failed." });
      }
    },
  );

  router.use((error, _req, res, next) => {
    if (error?.type === "entity.too.large") {
      return res.status(413).set("Cache-Control", "no-store").json({ error: `File exceeds the ${formatBytes(MAX_BROWSER_UPLOAD_BYTES)} limit.` });
    }
    return next(error);
  });

  return router;
}
