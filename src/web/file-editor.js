// Public browser editor for one explicitly selected channel file.
//
// A Slack modal never receives a raw filesystem URL. It receives a random, short-lived grant URL
// scoped to one user/channel/file/hash. The first browser request consumes that grant, rechecks
// authorization, and exchanges it for an HttpOnly per-editor cookie. Every page load and save then
// rechecks authorization + membership + writable mode through the injected `authorize` function.
// State is deliberately in-memory: a daemon restart invalidates every outstanding editor rather
// than leaving durable bearer links behind.
import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { readEditableFile, writeEditableFile } from "../slack/file-explorer.js";
import { logEvent } from "../util/logger.js";
import { timingSafeEqualStr } from "./security.js";

export const BROWSER_EDIT_MAX_CHARS = 250_000;
export const BROWSER_EDIT_MAX_BYTES = 1_000_000;
export const FILE_EDITOR_GRANT_TTL_MS = 10 * 60_000;
export const FILE_EDITOR_SESSION_TTL_MS = 60 * 60_000;

const grants = new Map(); // sha256(one-time token) -> scoped grant
const sessions = new Map(); // editor id -> { grant, cookieHash, csrf, expectedHash, expiresAt }
const LIMITS = { maxChars: BROWSER_EDIT_MAX_CHARS, maxBytes: BROWSER_EDIT_MAX_BYTES, label: "Browser editing" };
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

export function resetFileEditorStateForTests() {
  grants.clear();
  sessions.clear();
}

export function createFileEditorGrantUrl({ baseUrl, channelId, slug, ownerId, relative, expectedHash, threadTs = "", now = Date.now() } = {}) {
  let base;
  try {
    base = new URL(String(baseUrl || ""));
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return "";
  if (!channelId || !slug || !ownerId || !relative || !/^[a-f0-9]{64}$/i.test(String(expectedHash || ""))) return "";
  prune(now);
  capMap(grants, MAX_GRANTS);
  const token = randomToken();
  grants.set(digest(token), {
    channelId: String(channelId),
    slug: String(slug),
    ownerId: String(ownerId),
    relative: String(relative),
    expectedHash: String(expectedHash).toLowerCase(),
    threadTs: String(threadTs || ""),
    expiresAt: now + FILE_EDITOR_GRANT_TTL_MS,
  });
  base.search = "";
  base.hash = "";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/file-editor/open/${token}`;
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

function cookieName(editorId) {
  return `cg_file_edit_${editorId}`;
}

function cookieFor(req, editorId, secret, maxAgeSeconds) {
  const secure = secureRequest(req) ? "; Secure" : "";
  return `${cookieName(editorId)}=${secret}; HttpOnly; SameSite=Strict; Path=/file-editor/${editorId}; Max-Age=${maxAgeSeconds}${secure}`;
}

function getSession(req, editorId, now = Date.now()) {
  prune(now);
  const session = sessions.get(editorId);
  const secret = parseCookies(req.headers.cookie)[cookieName(editorId)] || "";
  if (!session || !secret || !timingSafeEqualStr(digest(secret), session.cookieHash)) return null;
  if (session.expiresAt <= now) {
    sessions.delete(editorId);
    return null;
  }
  return session;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function pageHeaders(res, nonce = "") {
  const script = nonce ? ` 'nonce-${nonce}'` : "";
  res.set({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; style-src${script}; script-src${script}; connect-src 'self'; img-src data:`,
  });
}

function errorPage(res, status, message) {
  const nonce = randomToken(16);
  pageHeaders(res, nonce);
  return res.status(status).type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>File editor</title><style nonce="${nonce}">body{margin:0;background:#f7f6f3;color:#252421;font:15px system-ui;display:grid;place-items:center;min-height:100vh}.card{max-width:560px;margin:24px;padding:28px;background:#fff;border:1px solid #ddd8cf;border-radius:16px;box-shadow:0 12px 40px #0001}h1{margin:0 0 10px;font-size:22px}p{line-height:1.55;color:#625f58}</style></head><body><main class="card"><h1>File editor unavailable</h1><p>${escapeHtml(message)}</p></main></body></html>`);
}

// The page is self-contained: one nonce'd inline script, no bundler. Two save invariants inside it
// are load-bearing rather than cosmetic. (1) The POST body is `submitted`, the string captured
// BEFORE the await — re-reading the live textarea afterwards marked text typed during a slow save as
// saved, and silenced the beforeunload guard, so the edit vanished on close. (2) "Saved" is shown
// only when the textarea still equals that acknowledged string; anything else is "Unsaved changes".
// Saves are serialized by a single in-flight flag (button disabled, textarea read-only), so Cmd+S
// held down can't stack overlapping PUTs against the same expected hash. Exported so those
// invariants can be exercised against the generated script itself — the router remains the only
// production caller.
export function editorPage({ editorId, session, file }) {
  const nonce = randomToken(16);
  const isMarkdown = path.extname(file.relative).toLowerCase() === ".md";
  const name = path.posix.basename(file.relative);
  const csrfJson = JSON.stringify(session.csrf).replaceAll("<", "\\u003c");
  return { nonce, html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Edit ${escapeHtml(name)}</title>
<style nonce="${nonce}">
:root{--ink:#201f1c;--muted:#747068;--line:#dedad2;--paper:#fbfaf7;--panel:#fff;--accent:#d86645;--ok:#087a5b;--bad:#b33030}*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--paper);color:var(--ink);font:14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;flex-direction:column}.top{min-height:64px;background:var(--panel);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;padding:10px 18px}.mark{width:36px;height:36px;border-radius:10px;background:var(--accent);color:#fff;display:grid;place-items:center;font-size:20px}.identity{min-width:0;flex:1}.identity strong,.identity span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.identity strong{font-size:15px}.identity span{color:var(--muted);font-size:12px;margin-top:2px}.tools{display:flex;align-items:center;gap:9px}button{appearance:none;border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:9px;padding:9px 14px;font-weight:650;cursor:pointer}button:hover{border-color:#bbb5ab}button.primary{border-color:var(--ok);background:var(--ok);color:#fff}button:disabled{opacity:.55;cursor:wait}.workspace{min-height:0;flex:1;display:grid;grid-template-columns:${isMarkdown ? "1fr 1fr" : "1fr"};gap:0}.pane{min-width:0;min-height:0;display:flex;flex-direction:column}.pane+ .pane{border-left:1px solid var(--line)}.pane-title{height:36px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;background:#f3f1ec;border-bottom:1px solid var(--line);font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}textarea{width:100%;height:100%;resize:none;border:0;outline:0;padding:18px 20px;background:#fff;color:#242320;font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:2}.preview{height:100%;overflow:auto;padding:22px 28px;background:#fff;line-height:1.65}.preview h1,.preview h2,.preview h3{line-height:1.25;margin:1.2em 0 .45em}.preview h1{font-size:28px;border-bottom:1px solid var(--line);padding-bottom:.25em}.preview h2{font-size:22px}.preview h3{font-size:18px}.preview pre{overflow:auto;background:#f3f1ec;border:1px solid var(--line);padding:12px;border-radius:8px}.preview code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f3f1ec;padding:.1em .3em;border-radius:4px}.preview pre code{background:none;padding:0}.preview blockquote{border-left:3px solid var(--accent);margin-left:0;padding-left:14px;color:var(--muted)}.foot{min-height:38px;border-top:1px solid var(--line);background:var(--panel);display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 18px;color:var(--muted);font-size:12px}.status.ok{color:var(--ok)}.status.bad{color:var(--bad)}@media(max-width:800px){.workspace{grid-template-columns:1fr}.preview-pane{display:none}.top{align-items:flex-start;flex-wrap:wrap}.tools{width:100%;justify-content:flex-end}}
</style></head><body>
<header class="top"><div class="mark">✎</div><div class="identity"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(file.relative)} · ${escapeHtml(session.grant.slug)}</span></div><div class="tools"><button id="revert" type="button">Revert</button><button id="save" class="primary" type="button">Save</button></div></header>
<main class="workspace"><section class="pane"><div class="pane-title"><span>Editor</span><span>${isMarkdown ? "Markdown" : "Plain text"}</span></div><textarea id="editor" maxlength="${BROWSER_EDIT_MAX_CHARS}" spellcheck="false">${escapeHtml(file.text)}</textarea></section>${isMarkdown ? '<section class="pane preview-pane"><div class="pane-title"><span>Preview</span><span>Live</span></div><article id="preview" class="preview"></article></section>' : ""}</main>
<footer class="foot"><span id="count"></span><span id="status" class="status">Ready · ⌘/Ctrl+S to save</span></footer>
<script nonce="${nonce}">
const CSRF=${csrfJson};const editor=document.getElementById("editor"),save=document.getElementById("save"),revert=document.getElementById("revert"),statusEl=document.getElementById("status"),count=document.getElementById("count"),preview=document.getElementById("preview");let baseline=editor.value,saving=false;
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}function inline(s){return esc(s).replace(/\x60([^\x60]+)\x60/g,"<code>$1</code>").replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>").replace(/__([^_]+)__/g,"<strong>$1</strong>").replace(/~~([^~]+)~~/g,"<del>$1</del>").replace(/\\*([^*]+)\\*/g,"<em>$1</em>")}
function markdown(s){const out=[];let code=false,buf=[];for(const line of String(s).split("\\n")){if(/^\x60\x60\x60/.test(line)){if(code){out.push("<pre><code>"+esc(buf.join("\\n"))+"</code></pre>");buf=[]}code=!code;continue}if(code){buf.push(line);continue}let m;if((m=/^(#{1,3})\\s+(.*)$/.exec(line)))out.push("<h"+m[1].length+">"+inline(m[2])+"</h"+m[1].length+">");else if((m=/^>\\s?(.*)$/.exec(line)))out.push("<blockquote>"+inline(m[1])+"</blockquote>");else if((m=/^[-*+]\\s+(.*)$/.exec(line)))out.push("<p>• "+inline(m[1])+"</p>");else if(!line.trim())out.push("<br>");else out.push("<p>"+inline(line)+"</p>")}if(code)out.push("<pre><code>"+esc(buf.join("\\n"))+"</code></pre>");return out.join("")}
function render(){const bytes=new TextEncoder().encode(editor.value).length;count.textContent=editor.value.length.toLocaleString()+" / ${BROWSER_EDIT_MAX_CHARS.toLocaleString()} chars · "+bytes.toLocaleString()+" / ${BROWSER_EDIT_MAX_BYTES.toLocaleString()} bytes";if(preview)preview.innerHTML=markdown(editor.value);if(saving)return;const clean=editor.value===baseline;statusEl.textContent=clean?"Saved":"Unsaved changes";statusEl.className=clean?"status ok":"status"}editor.addEventListener("input",render);revert.addEventListener("click",()=>{if(saving)return;if(editor.value===baseline||confirm("Discard your unsaved changes?")){editor.value=baseline;render();editor.focus()}});
async function persist(){if(saving)return;if(editor.value.length>${BROWSER_EDIT_MAX_CHARS}||new TextEncoder().encode(editor.value).length>${BROWSER_EDIT_MAX_BYTES}){statusEl.textContent="File exceeds the browser editor limit";statusEl.className="status bad";return}const submitted=editor.value;saving=true;save.disabled=true;editor.readOnly=true;statusEl.textContent="Saving…";statusEl.className="status";let failure=null;try{const response=await fetch(location.pathname+"/api/save",{method:"POST",headers:{"Content-Type":"application/json","X-CG-CSRF":CSRF},body:JSON.stringify({content:submitted})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||"Save failed");baseline=submitted}catch(error){failure=error}saving=false;save.disabled=false;editor.readOnly=false;if(failure){statusEl.textContent=failure.message;statusEl.className="status bad";return}render()}save.addEventListener("click",persist);document.addEventListener("keydown",event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="s"){event.preventDefault();persist()}});addEventListener("beforeunload",event=>{if(editor.value!==baseline){event.preventDefault();event.returnValue=""}});render();editor.focus();
</script></body></html>` };
}

export function createFileEditorRouter({ authorize, audit = logEvent } = {}) {
  if (typeof authorize !== "function") throw new Error("file editor authorize callback is required");
  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));

  router.get("/open/:token", async (req, res) => {
    const grant = consumeGrant(req.params.token);
    if (!grant) return errorPage(res, 410, "This editor link expired or was already used. Reopen the file preview in Slack.");
    try {
      const context = await authorize(grant);
      const file = await readEditableFile(context.root, grant.relative, LIMITS);
      if (file.hash !== grant.expectedHash) return errorPage(res, 409, "The file changed after the Slack preview opened. Reopen the preview to edit the latest version.");
      const editorId = randomToken(12);
      const cookieSecret = randomToken();
      capMap(sessions, MAX_SESSIONS);
      sessions.set(editorId, {
        grant,
        cookieHash: digest(cookieSecret),
        csrf: randomToken(),
        expectedHash: file.hash,
        expiresAt: Date.now() + FILE_EDITOR_SESSION_TTL_MS,
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Set-Cookie", cookieFor(req, editorId, cookieSecret, Math.floor(FILE_EDITOR_SESSION_TTL_MS / 1000)));
      return res.redirect(303, `/file-editor/${editorId}`);
    } catch (error) {
      return errorPage(res, 403, error.message || "You are no longer allowed to edit this file.");
    }
  });

  router.get("/:editorId", async (req, res) => {
    const session = getSession(req, req.params.editorId);
    if (!session) return errorPage(res, 401, "This editor session expired. Reopen the file preview in Slack.");
    try {
      const context = await authorize(session.grant);
      const file = await readEditableFile(context.root, session.grant.relative, LIMITS);
      if (file.hash !== session.expectedHash) return errorPage(res, 409, "The file changed outside this editor. Reopen it from Slack to avoid overwriting newer work.");
      const page = editorPage({ editorId: req.params.editorId, session, file });
      pageHeaders(res, page.nonce);
      return res.type("html").send(page.html);
    } catch (error) {
      return errorPage(res, 403, error.message || "You are no longer allowed to edit this file.");
    }
  });

  router.post("/:editorId/api/save", async (req, res) => {
    const session = getSession(req, req.params.editorId);
    if (!session) return res.status(401).set("Cache-Control", "no-store").json({ error: "Editor session expired. Reopen the file from Slack." });
    if (!timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) {
      return res.status(403).set("Cache-Control", "no-store").json({ error: "Invalid editor request." });
    }
    try {
      const context = await authorize(session.grant);
      const content = req.body?.content;
      if (typeof content !== "string") return res.status(400).set("Cache-Control", "no-store").json({ error: "Missing file contents." });
      const saved = await writeEditableFile(context.root, session.grant.relative, session.expectedHash, content, LIMITS);
      session.expectedHash = saved.hash;
      await audit("channel_file_edited_in_browser", {
        channel: session.grant.channelId,
        author: session.grant.ownerId,
        slug: session.grant.slug,
        file: saved.relative,
        bytes: saved.bytes.length,
      });
      return res.set("Cache-Control", "no-store").json({ ok: true, chars: saved.text.length, bytes: saved.bytes.length });
    } catch (error) {
      const status = error?.code === "FILE_EDIT_CONFLICT" ? 409 : 403;
      return res.status(status).set("Cache-Control", "no-store").json({ error: error.message || "Save failed." });
    }
  });

  return router;
}
