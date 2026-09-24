// Temporary public download links for ONE file inside a channel's working folder.
//
// This is the only capability in the gateway that hands channel bytes to an unauthenticated
// caller, so the shape is deliberately narrow.
//
// WHY IT EXISTS. Two different callers need a URL that something outside Slack can fetch:
//   • an upload step — a third-party API that ingests files by URL rather than by body
//     (GOOGLEDRIVE_UPLOAD_FROM_URL and its equivalents). Machine-fetched, seconds to minutes.
//   • a person — "send me that PDF as a link". Human-fetched, hours to days.
// They get different rules because their risk is different, and `purpose` is what selects them:
// an `upload` link lives minutes and is spent a handful of times; a `share` link lives as long as
// the requester asked for, up to a hard 48h ceiling, and is fetched as often as they like.
//
// WHAT MAKES IT SAFE.
//  1. The token IS the credential — 32 random bytes, so it cannot be guessed or enumerated — and
//     only its SHA-256 is stored. A dump of this table yields no working link.
//  2. A link names a channel + a RELATIVE path, never an absolute one. The file is re-resolved
//     inside that channel's working folder at every fetch (openConfinedFile), so a link cannot
//     reach the operator home even in a channel whose container mounts it, and a link minted for
//     a file that later moves outside the folder simply stops working.
//  3. Expiry, a download cap and revocation are all checked in ONE atomic UPDATE, so two
//     simultaneous fetches cannot both spend the last allowed download.
//  4. The gateway-wide switch is re-read at fetch time, not at mint time: turning the feature off
//     kills every outstanding link immediately.
//
// Retention: terminal rows are kept for a week so "who published what" stays answerable, then
// swept. Nothing in a row is secret.
import crypto from "node:crypto";

import { getDb } from "../db/index.js";

export const PUBLIC_FILE_LINK_PURPOSES = Object.freeze(["upload", "share"]);

// An upload link exists to be fetched by one machine, once, right now. The ceiling is what a slow
// third-party ingest can plausibly need, not what is convenient.
export const UPLOAD_LINK_DEFAULT_MINUTES = 5;
export const UPLOAD_LINK_MAX_MINUTES = 15;
export const UPLOAD_LINK_MAX_DOWNLOADS = 5;

// A share link is handed to a person, so the duration is theirs to choose — but 48h is the hard
// ceiling the operator asked for, and an unbounded link is a credential nobody can remember to
// revoke.
export const SHARE_LINK_MAX_MINUTES = 48 * 60;

// How long a dead row is kept for the audit trail.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;

export function hashPublicFileToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    channelId: row.channel_id,
    slug: row.slug,
    relative: row.relative,
    filename: row.filename,
    purpose: row.purpose,
    createdBy: row.created_by,
    createdAt: row.created_ms,
    expiresAt: row.expires_ms,
    maxDownloads: row.max_downloads,
    downloads: row.downloads,
    revokedAt: row.revoked_ms,
    lastDownloadAt: row.last_download_ms,
  };
}

/**
 * Turn a caller-supplied duration into the minutes this purpose actually allows.
 *
 * `share` requires an explicit duration on purpose: the operator's rule is that a human-facing
 * link is only ever minted after someone said how long it should live, so there is no default to
 * fall back on. Over-long is an error rather than a silent clamp — a caller who asked for a week
 * should be told it got 48 hours, not discover it later.
 */
export function resolveLinkMinutes(purpose, minutes) {
  if (!PUBLIC_FILE_LINK_PURPOSES.includes(purpose)) throw new Error(`unknown public link purpose "${purpose}"`);
  const max = purpose === "share" ? SHARE_LINK_MAX_MINUTES : UPLOAD_LINK_MAX_MINUTES;
  if (minutes === undefined || minutes === null || minutes === "") {
    if (purpose === "share") throw new Error("a share link needs an explicit duration in minutes — ask how long it should stay live");
    return UPLOAD_LINK_DEFAULT_MINUTES;
  }
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) throw new Error("the link duration must be a positive number of minutes");
  const rounded = Math.ceil(value);
  if (rounded > max) {
    throw new Error(purpose === "share"
      ? `a share link may live at most ${max} minutes (48 hours); ${rounded} was requested`
      : `an upload link may live at most ${max} minutes; ${rounded} was requested`);
  }
  return rounded;
}

export function publicFileLinkUrl(baseUrl, token) {
  let base;
  try {
    base = new URL(String(baseUrl || ""));
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return "";
  base.search = "";
  base.hash = "";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/f/${token}`;
  return base.toString();
}

export function sweepPublicFileLinks(now = Date.now()) {
  return getDb().prepare(
    "DELETE FROM public_file_links WHERE (expires_ms < ? ) OR (revoked_ms > 0 AND revoked_ms < ?)",
  ).run(now - RETENTION_MS, now - RETENTION_MS).changes;
}

/**
 * Mint a link. The plaintext token is returned ONCE and never stored; everything else is a row.
 * The caller is responsible for having proved that `relative` resolves inside the channel and
 * that the requester may publish it.
 */
export function createPublicFileLink({
  channelId,
  slug,
  relative,
  filename = "",
  purpose = "upload",
  minutes,
  createdBy = "",
  now = Date.now(),
} = {}) {
  if (!channelId || !slug || !relative) throw new Error("a public file link needs a channel, a slug and a relative path");
  const ttlMinutes = resolveLinkMinutes(purpose, minutes);
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const id = crypto.randomUUID();
  const maxDownloads = purpose === "upload" ? UPLOAD_LINK_MAX_DOWNLOADS : 0;
  sweepPublicFileLinks(now);
  getDb().prepare(
    `INSERT INTO public_file_links(id, token_hash, channel_id, slug, relative, filename, purpose,
       created_by, created_ms, expires_ms, max_downloads, downloads, revoked_ms, last_download_ms)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
  ).run(
    id,
    hashPublicFileToken(token),
    String(channelId),
    String(slug),
    String(relative),
    String(filename || relative).split("/").pop(),
    purpose,
    String(createdBy || ""),
    now,
    now + ttlMinutes * 60_000,
    maxDownloads,
  );
  return { ...getPublicFileLink(id), token, minutes: ttlMinutes };
}

export function getPublicFileLink(id) {
  return rowToRecord(getDb().prepare("SELECT * FROM public_file_links WHERE id = ?").get(String(id ?? "")));
}

export function listPublicFileLinks(channelId, { now = Date.now(), includeDead = false } = {}) {
  const rows = getDb().prepare(
    "SELECT * FROM public_file_links WHERE channel_id = ? ORDER BY created_ms DESC LIMIT 50",
  ).all(String(channelId ?? ""));
  return rows.map(rowToRecord).filter((row) => includeDead || (!row.revokedAt && row.expiresAt > now));
}

// Revoking is idempotent and never deletes: the row stays for the audit trail with a revoked
// timestamp, and the atomic claim below refuses it from the next fetch onwards.
export function revokePublicFileLink(id, { now = Date.now(), channelId = "" } = {}) {
  const changed = getDb().prepare(
    `UPDATE public_file_links SET revoked_ms = ?
       WHERE id = ? AND revoked_ms = 0${channelId ? " AND channel_id = ?" : ""}`,
  ).run(...(channelId ? [now, String(id), String(channelId)] : [now, String(id)])).changes;
  return { ok: changed === 1, link: getPublicFileLink(id) };
}

export function revokePublicFileLinksForChannel(channelId, { now = Date.now() } = {}) {
  return getDb().prepare(
    "UPDATE public_file_links SET revoked_ms = ? WHERE channel_id = ? AND revoked_ms = 0 AND expires_ms > ?",
  ).run(now, String(channelId ?? ""), now).changes;
}

/**
 * Spend one download against a bearer token.
 *
 * Lookup and claim are one atomic UPDATE guarded by every terminal condition, because two
 * simultaneous fetches of the last allowed download must not both succeed. `reason` distinguishes
 * "never existed" from "no longer works" for the caller's message, but the HTTP surface
 * deliberately collapses them: telling a stranger that a token was real-but-expired is a
 * confirmation oracle.
 */
export function claimPublicFileDownload(token, now = Date.now()) {
  const hash = hashPublicFileToken(token);
  const row = rowToRecord(getDb().prepare("SELECT * FROM public_file_links WHERE token_hash = ?").get(hash));
  if (!row) return { ok: false, reason: "unknown" };
  const claimed = getDb().prepare(
    `UPDATE public_file_links SET downloads = downloads + 1, last_download_ms = ?
       WHERE token_hash = ? AND revoked_ms = 0 AND expires_ms > ?
         AND (max_downloads = 0 OR downloads < max_downloads)`,
  ).run(now, hash, now).changes;
  if (!claimed) {
    return {
      ok: false,
      reason: row.revokedAt ? "revoked" : row.expiresAt <= now ? "expired" : "exhausted",
      link: row,
    };
  }
  return { ok: true, link: { ...row, downloads: row.downloads + 1, lastDownloadAt: now } };
}
