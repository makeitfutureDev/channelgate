// Public, one-use download links for files selected in the Slack channel file explorer.
//
// The opaque URL is minted only into the requester's private modal. Opening it consumes the grant,
// repeats the channel authorization/membership check, re-resolves the file inside the channel root,
// and streams from an already-open, re-confined descriptor. No filesystem path or reusable session
// credential reaches Slack or the browser.
import crypto from "node:crypto";
import express from "express";
import { normalizeRelativePath } from "../slack/file-explorer.js";
import { openConfinedFile } from "../gateway/confined-file.js";
import { logEvent } from "../util/logger.js";

export const FILE_DOWNLOAD_GRANT_TTL_MS = 10 * 60_000;

const grants = new Map(); // sha256(one-time token) -> scoped grant
const MAX_GRANTS = 2_000;

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function prune(now = Date.now()) {
  for (const [key, value] of grants) if (value.expiresAt <= now) grants.delete(key);
}

function capGrants() {
  while (grants.size >= MAX_GRANTS) grants.delete(grants.keys().next().value);
}

export function resetFileDownloadStateForTests() {
  grants.clear();
}

export function createFileDownloadGrantUrl({ baseUrl, channelId, slug, ownerId, relative, threadTs = "", now = Date.now() } = {}) {
  let base;
  let clean;
  try {
    base = new URL(String(baseUrl || ""));
    clean = normalizeRelativePath(relative);
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return "";
  if (!channelId || !slug || !ownerId || !clean) return "";
  prune(now);
  capGrants();
  const token = randomToken();
  grants.set(digest(token), {
    channelId: String(channelId),
    slug: String(slug),
    ownerId: String(ownerId),
    relative: clean,
    threadTs: String(threadTs || ""),
    expiresAt: now + FILE_DOWNLOAD_GRANT_TTL_MS,
  });
  base.search = "";
  base.hash = "";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/file-download/open/${token}`;
  return base.toString();
}

function consumeGrant(token, now = Date.now()) {
  prune(now);
  const key = digest(token);
  const grant = grants.get(key);
  grants.delete(key);
  return grant?.expiresAt > now ? grant : null;
}

function errorResponse(res, status, message) {
  return res.status(status).set({
    "Cache-Control": "no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  }).type("text").send(message);
}

export function createFileDownloadRouter({ authorize, audit = logEvent } = {}) {
  if (typeof authorize !== "function") throw new Error("file download authorize callback is required");
  const router = express.Router();

  router.get("/open/:token", async (req, res) => {
    const grant = consumeGrant(req.params.token);
    if (!grant) return errorResponse(res, 410, "This download link expired or was already used. Reopen the file preview in Slack.");

    let handle;
    let stream;
    try {
      const context = await authorize(grant);
      // Lookup-then-open is a symlink race (the folder is writable by the channel's own container
      // between the two), so the confined open is shared with every other exporter — see
      // gateway/confined-file.js.
      const opened = await openConfinedFile(context.root, grant.relative);
      handle = opened.handle;
      const info = opened.stat;

      res.set({
        "Cache-Control": "no-store, max-age=0",
        "Content-Length": String(info.size),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      res.attachment(opened.name);
      await audit("channel_file_downloaded", {
        channel: grant.channelId,
        author: grant.ownerId,
        slug: grant.slug,
        file: opened.relative,
        bytes: info.size,
      });

      stream = handle.createReadStream({ autoClose: true });
      handle = null; // the stream owns and closes the descriptor from here
      stream.on("error", (error) => {
        if (res.headersSent) res.destroy(error);
        else errorResponse(res, 500, "The file could not be downloaded.");
      });
      res.on("close", () => stream?.destroy());
      stream.pipe(res);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (!res.headersSent) return errorResponse(res, 403, error.message || "You are no longer allowed to download this file.");
      res.destroy(error);
    }
  });

  return router;
}
