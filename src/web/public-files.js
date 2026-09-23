// The public half of temporary file links: GET /f/<token> streams one channel file to whoever
// holds the token.
//
// Mounted OUTSIDE the admin login, like /approve, because that is the entire point — the fetcher
// is a third-party ingest service or someone's browser, and there is no gateway session to check.
// The token is the credential; src/gateway/public-file-links.js is where its rules live.
//
// Four things this router does that a plain static handler would not:
//
//  1. Re-reads the gateway-wide switch on every request, so turning the feature off in Settings
//     kills outstanding links at once rather than at their next expiry.
//  2. Re-resolves the file inside the channel's CURRENT working folder through openConfinedFile,
//     so the link carries no absolute path and cannot survive the file moving out of the folder.
//  3. Collapses every failure — unknown token, expired, revoked, download cap spent, channel gone,
//     file deleted — into one 404 with one message. Distinguishing them for a stranger would
//     confirm which tokens were ever real.
//  4. Serves HEAD without spending a download, because ingest services routinely probe first, and
//     a probe that consumed the single allowed fetch would break the upload it was checking.
//
// Responses are `Content-Disposition: attachment` with `nosniff` and `X-Robots-Tag: noindex`: a
// link handed to a machine should never render as an active document in a browser tab, and a
// shared deliverable has no business in a search index.
import express from "express";

import { effectiveWorkDir } from "../gateway/folders.js";
import { openConfinedFile } from "../gateway/confined-file.js";
import { claimPublicFileDownload, hashPublicFileToken } from "../gateway/public-file-links.js";
import { getChannelMeta } from "../config/store.js";
import { getPublicFileLinksEnabled } from "../config/settings.js";
import { guessMimeType } from "../util/mime.js";
import { logEvent } from "../util/logger.js";
import { getDb } from "../db/index.js";

// One answer for every failure. See note 3 above.
const GONE = "This link is not available. It may have expired, been revoked, or already been used.";

function deny(res, message = GONE) {
  return res.status(404).set({
    "Cache-Control": "no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
  }).type("text").send(message);
}

function baseHeaders(link, stat) {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Length": String(stat.size),
    "Content-Type": guessMimeType(link.filename),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

// A link stores a slug and a RELATIVE path, never an absolute one, so the working folder is
// resolved fresh on every fetch: a channel that was repointed or deleted takes its links with it.
async function defaultResolveRoot(link) {
  const meta = await getChannelMeta(link.slug);
  if (!meta) throw new Error("channel is gone");
  return effectiveWorkDir(link.slug, { ...meta, _slug: link.slug });
}

export function createPublicFileRouter({
  enabled = getPublicFileLinksEnabled,
  audit = logEvent,
  resolveRoot = defaultResolveRoot,
} = {}) {
  const router = express.Router();

  // A probe. Verifies the token and that the file is still readable, spends nothing. Deliberately
  // does its own lookup rather than going through claimPublicFileDownload().
  router.head("/:token", async (req, res) => {
    if (!enabled()) return res.status(404).end();
    let handle;
    try {
      const row = getDb().prepare(
        "SELECT * FROM public_file_links WHERE token_hash = ? AND revoked_ms = 0 AND expires_ms > ?",
      ).get(hashPublicFileToken(req.params.token), Date.now());
      if (!row) return res.status(404).end();
      const link = { slug: row.slug, filename: row.filename, relative: row.relative };
      const opened = await openConfinedFile(await resolveRoot(link), link.relative);
      handle = opened.handle;
      return res.set(baseHeaders(link, opened.stat)).status(200).end();
    } catch {
      return res.status(404).end();
    } finally {
      await handle?.close().catch(() => {});
    }
  });

  router.get("/:token", async (req, res) => {
    if (!enabled()) return deny(res, "Public file links are turned off on this gateway.");

    const claim = claimPublicFileDownload(req.params.token);
    if (!claim.ok) return deny(res);
    const { link } = claim;

    let handle;
    let stream;
    try {
      const opened = await openConfinedFile(await resolveRoot(link), link.relative);
      handle = opened.handle;

      // attachment() first, headers second: it writes a properly encoded Content-Disposition
      // (Express's content-disposition handles non-ASCII names) but ALSO guesses a Content-Type
      // from the extension, and for an unknown extension that guess is the extension string
      // itself. Our own header has to land last.
      res.attachment(opened.name);
      res.set(baseHeaders(link, opened.stat));
      await audit("public_file_link_fetched", {
        channel: link.channelId,
        author: link.createdBy,
        slug: link.slug,
        link: link.id,
        purpose: link.purpose,
        file: opened.relative,
        bytes: opened.stat.size,
        download: link.downloads,
        // Who pulled it, for the audit trail. Never the token.
        ip: String(req.ip || ""),
        agent: String(req.get("user-agent") || "").slice(0, 200),
      });

      stream = handle.createReadStream({ autoClose: true });
      handle = null; // the stream owns the descriptor from here
      stream.on("error", (error) => {
        if (res.headersSent) res.destroy(error);
        else deny(res);
      });
      res.on("close", () => stream?.destroy());
      stream.pipe(res);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (!res.headersSent) return deny(res);
      res.destroy(error);
    }
  });

  return router;
}
