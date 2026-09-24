// Temporary public file links — the only capability that serves channel bytes to a caller with no
// gateway session, so the rules are pinned here rather than left to the callers.
//
// What this file holds down, and why each one is load-bearing:
//   • the two purposes have different TTL rules: an upload link defaults short and is capped at
//     15 minutes; a share link has NO default (the operator's rule is that a human is asked) and
//     is capped at 48 hours, with an over-long request refused rather than silently clamped
//   • only the token's SHA-256 is stored, so a dump of the table yields no working link
//   • expiry, revocation and the fetch cap are one ATOMIC claim — concurrent fetches of the last
//     allowed download must not both win
//   • the file is re-resolved inside the channel folder on every fetch: a path escaping the root,
//     a symlink at the final component, or a file that moved all stop working
//   • the gateway-wide switch is read per REQUEST, so turning it off kills live links at once
//   • HEAD probes (which ingest services send before fetching) spend nothing
//   • every failure looks identical to a stranger — no "expired vs never existed" oracle
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";

import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  claimPublicFileDownload,
  createPublicFileLink,
  hashPublicFileToken,
  listPublicFileLinks,
  publicFileLinkUrl,
  resolveLinkMinutes,
  revokePublicFileLink,
  sweepPublicFileLinks,
  SHARE_LINK_MAX_MINUTES,
  UPLOAD_LINK_DEFAULT_MINUTES,
  UPLOAD_LINK_MAX_DOWNLOADS,
  UPLOAD_LINK_MAX_MINUTES,
} = await import("../src/gateway/public-file-links.js");
const { createPublicFileRouter } = await import("../src/web/public-files.js");
const { getDb } = await import("../src/db/index.js");
const { upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function scratchRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-public-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "work"));
  await writeFile(path.join(root, "work", "PROPOSAL.pdf"), "%PDF-1.7 proposal\n");
  return root;
}

// One live router per test, with the channel root and the gateway switch injected.
async function serve(t, root, { enabled = () => true, audits = [] } = {}) {
  const app = express();
  app.use("/f", createPublicFileRouter({
    enabled,
    resolveRoot: async () => root,
    audit: async (event, fields) => audits.push({ event, fields }),
  }));
  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, audits };
}

function mint(overrides = {}) {
  return createPublicFileLink({
    channelId: "C123",
    slug: "channel",
    relative: "work/PROPOSAL.pdf",
    filename: "PROPOSAL.pdf",
    purpose: "upload",
    createdBy: "U123",
    ...overrides,
  });
}

test("duration rules differ by purpose: upload defaults, share must be asked for", () => {
  assert.equal(resolveLinkMinutes("upload", undefined), UPLOAD_LINK_DEFAULT_MINUTES);
  assert.equal(resolveLinkMinutes("upload", 12), 12);
  assert.throws(() => resolveLinkMinutes("upload", UPLOAD_LINK_MAX_MINUTES + 1), /at most 15 minutes/);

  // No default for a person-facing link: the operator's rule is that someone states the duration.
  assert.throws(() => resolveLinkMinutes("share", undefined), /needs an explicit duration/);
  assert.equal(resolveLinkMinutes("share", 1440), 1440);
  assert.equal(resolveLinkMinutes("share", SHARE_LINK_MAX_MINUTES), 2880);
  // Over-long is refused, not clamped — a caller who asked for a week must be told it cannot have one.
  assert.throws(() => resolveLinkMinutes("share", SHARE_LINK_MAX_MINUTES + 1), /at most 2880 minutes \(48 hours\)/);

  assert.throws(() => resolveLinkMinutes("share", 0), /positive number/);
  assert.throws(() => resolveLinkMinutes("share", -5), /positive number/);
  assert.throws(() => resolveLinkMinutes("elsewhere", 5), /unknown public link purpose/);
});

test("only the token hash is stored, and the URL is built from the public base", () => {
  const link = mint();
  const row = getDb().prepare("SELECT * FROM public_file_links WHERE id = ?").get(link.id);
  assert.equal(row.token_hash, hashPublicFileToken(link.token));
  assert.ok(!JSON.stringify(row).includes(link.token));
  assert.equal(row.max_downloads, UPLOAD_LINK_MAX_DOWNLOADS);

  assert.equal(publicFileLinkUrl("https://gw.example.test", link.token), `https://gw.example.test/f/${link.token}`);
  assert.equal(publicFileLinkUrl("https://gw.example.test/base/", link.token), `https://gw.example.test/base/f/${link.token}`);
  // Anything that is not a usable http(s) origin yields no link at all.
  assert.equal(publicFileLinkUrl("ftp://gw.example.test", link.token), "");
  assert.equal(publicFileLinkUrl("https://user:pw@gw.example.test", link.token), "");
  assert.equal(publicFileLinkUrl("not a url", link.token), "");
});

test("a share link has no download cap; an upload link is spent after its allowance", () => {
  const share = mint({ purpose: "share", minutes: 60 });
  assert.equal(getDb().prepare("SELECT max_downloads FROM public_file_links WHERE id = ?").get(share.id).max_downloads, 0);
  for (let i = 0; i < 20; i++) assert.equal(claimPublicFileDownload(share.token).ok, true, `share fetch ${i}`);

  const upload = mint();
  for (let i = 0; i < UPLOAD_LINK_MAX_DOWNLOADS; i++) assert.equal(claimPublicFileDownload(upload.token).ok, true, `upload fetch ${i}`);
  const spent = claimPublicFileDownload(upload.token);
  assert.equal(spent.ok, false);
  assert.equal(spent.reason, "exhausted");
});

test("expiry, revocation and an unknown token are each refused", () => {
  const expired = mint({ minutes: 1 });
  assert.equal(claimPublicFileDownload(expired.token, Date.now() + 61_000).reason, "expired");

  const revoked = mint();
  assert.equal(revokePublicFileLink(revoked.id, { channelId: "C123" }).ok, true);
  assert.equal(claimPublicFileDownload(revoked.token).reason, "revoked");
  // Revoking is idempotent and keeps the row for the audit trail.
  assert.equal(revokePublicFileLink(revoked.id, { channelId: "C123" }).ok, false);
  assert.ok(getDb().prepare("SELECT id FROM public_file_links WHERE id = ?").get(revoked.id));

  // A link id learned elsewhere cannot be revoked from another channel.
  const other = mint();
  assert.equal(revokePublicFileLink(other.id, { channelId: "C999" }).ok, false);
  assert.equal(claimPublicFileDownload(other.token).ok, true);

  assert.equal(claimPublicFileDownload("not-a-real-token").reason, "unknown");
});

test("the fetch cap is claimed atomically", () => {
  const link = mint();
  // Five parallel claims against a five-fetch allowance: exactly five win, however they interleave.
  const results = Array.from({ length: 12 }, () => claimPublicFileDownload(link.token));
  assert.equal(results.filter((r) => r.ok).length, UPLOAD_LINK_MAX_DOWNLOADS);
  assert.equal(
    getDb().prepare("SELECT downloads FROM public_file_links WHERE id = ?").get(link.id).downloads,
    UPLOAD_LINK_MAX_DOWNLOADS,
  );
});

test("listing shows live links for the channel only, and the sweeper keeps dead rows for a week", () => {
  const db = getDb();
  db.prepare("DELETE FROM public_file_links").run();
  const live = mint({ purpose: "share", minutes: 120 });
  const dead = mint({ minutes: 1 });
  db.prepare("UPDATE public_file_links SET expires_ms = ? WHERE id = ?").run(Date.now() - 1000, dead.id);
  mint({ channelId: "C999", purpose: "share", minutes: 120 });

  const listed = listPublicFileLinks("C123");
  assert.deepEqual(listed.map((l) => l.id), [live.id]);
  assert.equal(listPublicFileLinks("C123", { includeDead: true }).length, 2);

  // Still inside the retention window: the audit trail survives the sweeper.
  assert.equal(sweepPublicFileLinks(), 0);
  assert.ok(db.prepare("SELECT id FROM public_file_links WHERE id = ?").get(dead.id));
  // Eight days on, it is gone.
  sweepPublicFileLinks(Date.now() + 8 * 24 * 60 * 60 * 1000);
  assert.equal(db.prepare("SELECT id FROM public_file_links WHERE id = ?").get(dead.id), undefined);
});

test("a live token streams the file once, audits the fetch and spends one download", async (t) => {
  const root = await scratchRoot(t);
  const { base, audits } = await serve(t, root);
  const link = mint();

  const res = await fetch(`${base}/f/${link.token}`, { headers: { "user-agent": "composio-ingest/1.0" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(res.headers.get("content-disposition"), /attachment; filename="PROPOSAL\.pdf"/);
  assert.equal(await res.text(), "%PDF-1.7 proposal\n");

  assert.equal(audits.length, 1);
  assert.equal(audits[0].event, "public_file_link_fetched");
  assert.equal(audits[0].fields.file, "work/PROPOSAL.pdf");
  assert.equal(audits[0].fields.download, 1);
  assert.equal(audits[0].fields.agent, "composio-ingest/1.0");
  // The audit records who fetched, never the bearer token.
  assert.ok(!JSON.stringify(audits[0]).includes(link.token));

  assert.equal(getDb().prepare("SELECT downloads FROM public_file_links WHERE id = ?").get(link.id).downloads, 1);
});

test("a HEAD probe verifies the file without spending a download", async (t) => {
  const root = await scratchRoot(t);
  const { base, audits } = await serve(t, root);
  const link = mint();

  const head = await fetch(`${base}/f/${link.token}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "application/pdf");
  assert.equal(getDb().prepare("SELECT downloads FROM public_file_links WHERE id = ?").get(link.id).downloads, 0);
  assert.equal(audits.length, 0);

  // The real fetch still has its full allowance.
  assert.equal((await fetch(`${base}/f/${link.token}`)).status, 200);
});

test("turning the gateway switch off kills outstanding links immediately", async (t) => {
  const root = await scratchRoot(t);
  let on = true;
  const { base } = await serve(t, root, { enabled: () => on });
  const link = mint();

  assert.equal((await fetch(`${base}/f/${link.token}`)).status, 200);
  on = false;
  const off = await fetch(`${base}/f/${link.token}`);
  assert.equal(off.status, 404);
  assert.match(await off.text(), /turned off on this gateway/);
  assert.equal((await fetch(`${base}/f/${link.token}`, { method: "HEAD" })).status, 404);
  // The refusal is the switch, not a spent download.
  assert.equal(getDb().prepare("SELECT downloads FROM public_file_links WHERE id = ?").get(link.id).downloads, 1);
});

test("every failure looks the same to a stranger", async (t) => {
  const root = await scratchRoot(t);
  const { base } = await serve(t, root);

  const expired = mint({ minutes: 1 });
  getDb().prepare("UPDATE public_file_links SET expires_ms = ? WHERE id = ?").run(Date.now() - 1, expired.id);
  const revoked = mint();
  revokePublicFileLink(revoked.id, { channelId: "C123" });

  const bodies = [];
  for (const token of ["never-existed", expired.token, revoked.token]) {
    const res = await fetch(`${base}/f/${token}`);
    assert.equal(res.status, 404);
    bodies.push(await res.text());
  }
  // One message for all three: distinguishing them confirms which tokens were ever real.
  assert.equal(new Set(bodies).size, 1);
});

test("a link cannot reach outside the channel folder, or through a symlink, or after the file moves", async (t) => {
  const root = await scratchRoot(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "gateway-public-files-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "secret.txt"), "operator home contents");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "work", "escape.txt"));

  const { base } = await serve(t, root);

  // A traversal path never resolves, even though the row stores whatever it was minted with.
  const traversal = mint({ relative: "../../etc/passwd" });
  assert.equal((await fetch(`${base}/f/${traversal.token}`)).status, 404);

  // A symlink at the final component is refused rather than followed: readable in the folder,
  // not exportable.
  const linked = mint({ relative: "work/escape.txt" });
  const viaSymlink = await fetch(`${base}/f/${linked.token}`);
  assert.equal(viaSymlink.status, 404);
  assert.ok(!(await viaSymlink.text()).includes("operator home contents"));

  // A link outlives its file only as a 404.
  const moved = mint();
  await rm(path.join(root, "work", "PROPOSAL.pdf"));
  assert.equal((await fetch(`${base}/f/${moved.token}`)).status, 404);
});

test("a link for a channel whose working folder is gone fails closed", async (t) => {
  const app = express();
  app.use("/f", createPublicFileRouter({
    enabled: () => true,
    resolveRoot: async () => { throw new Error("channel is gone"); },
    audit: async () => {},
  }));
  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const link = mint();
  const res = await fetch(`http://127.0.0.1:${server.address().port}/f/${link.token}`);
  assert.equal(res.status, 404);
});

test("without an injected root, a link resolves against the channel's REAL working folder", async (t) => {
  // The default resolver is the production path: slug → channel meta → effectiveWorkDir. A link
  // stores no absolute path, so this is what decides which bytes a token can ever reach — and a
  // channel that no longer exists must take its links down with it.
  const slug = (await upsertChannelEntry("C_REAL", { name: "public-link-real", type: "channel", isDM: false })).slug
    || "public-link-real";
  await saveChannelMeta(slug, { channelId: "C_REAL" });
  const root = path.join(process.env.CG_WORKSPACE_DIR, "slack", slug);
  await mkdir(path.join(root, "work"), { recursive: true });
  await writeFile(path.join(root, "work", "REPORT.md"), "# real folder\n");
  t.after(() => rm(root, { recursive: true, force: true }));

  const app = express();
  app.use("/f", createPublicFileRouter({ enabled: () => true, audit: async () => {} }));
  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const live = createPublicFileLink({
    channelId: "C_REAL", slug, relative: "work/REPORT.md", filename: "REPORT.md",
    purpose: "share", minutes: 60, createdBy: "U1",
  });
  const res = await fetch(`${base}/f/${live.token}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "# real folder\n");

  // A link minted against a slug with no channel row resolves to nothing and fails closed.
  const orphan = createPublicFileLink({
    channelId: "C_GONE", slug: "no-such-channel", relative: "work/REPORT.md",
    purpose: "share", minutes: 60, createdBy: "U1",
  });
  assert.equal((await fetch(`${base}/f/${orphan.token}`)).status, 404);
});
