// Getting ONE file out of a channel's working folder and into something that is not Slack.
//
// Two mechanisms, because the outside world asks for files in two incompatible ways:
//
//   stage_file_for_composio  — for anything reachable through Composio. Composio's file-taking
//     tools want `{name, mimetype, s3key}` pointing at bytes already inside THEIR storage, which
//     a container-side run cannot produce. The daemon stages the file over the Composio REST API
//     with the run's own key and hands back the object. Nothing becomes publicly reachable.
//
//   create_public_file_link  — for everything else: an API that ingests by URL rather than by
//     body, or a person who wants a link. This DOES publish the bytes to anyone holding the
//     token, so it is off unless an operator turned it on, and a human-facing `share` link needs
//     an explicit duration and a human Approve click.
//
// Prefer the first. It is the narrower capability and it covers Drive, Gmail attachments, Slack
// uploads, HubSpot and the rest of the Composio surface in one step.
import { z } from "zod";

import { effectiveWorkDir } from "../../gateway/folders.js";
import { openConfinedFile } from "../../gateway/confined-file.js";
import { stageFileForComposio, COMPOSIO_STAGE_MAX_BYTES, COMPOSIO_WORKBENCH_STAGE_MAX_BYTES } from "../../gateway/composio-files.js";
import { composioUrl } from "../../gateway/mcp-catalog.js";
import {
  createPublicFileLink,
  listPublicFileLinks,
  publicFileLinkUrl,
  revokePublicFileLink,
  resolveLinkMinutes,
  SHARE_LINK_MAX_MINUTES,
  UPLOAD_LINK_DEFAULT_MINUTES,
  UPLOAD_LINK_MAX_MINUTES,
  UPLOAD_LINK_MAX_DOWNLOADS,
} from "../../gateway/public-file-links.js";
import { getComposioToken } from "../../config/store.js";
import { getDefaultComposioToken, getPublicFileLinksEnabled, getPublicUrl } from "../../config/settings.js";
import { formatBytes } from "../../util/bounded-bytes.js";
import { logEvent } from "../../util/logger.js";

function workspaceFor(slug, meta) {
  return effectiveWorkDir(slug, { ...(meta || {}), _slug: slug });
}

function clean(error) {
  return String(error?.message || "failed").replace(/\s+/g, " ").trim();
}

// Human wording for how long a link lives, so a reply can state it without recomputing.
export function describeDuration(minutes) {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  const whole = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${whole} hour${whole === "1" ? "" : "s"}`;
}

/**
 * Which Composio API key this run may spend, for the identity the caller named.
 *
 * Reuses the ONE definition of the identity precedence — `resolveComposioConnections` in run.js,
 * imported lazily so the MCP server does not pull the run orchestrator into every stdio child
 * that never stages a file. The rules it enforces matter here exactly as much as they do when the
 * MCP config is built: a DM has no shared identity, and `composio-agent` falls back to the org
 * default only when the channel has no key of its own.
 */
export async function resolveComposioKey({ identity, authorId, meta }) {
  const { resolveComposioConnections } = await import("../../gateway/run.js");
  const resolved = resolveComposioConnections({
    userToken: await getComposioToken(authorId),
    channelToken: meta?.composioToken || "",
    defaultToken: getDefaultComposioToken(),
    noOrg: Boolean(meta?.noOrg),
    isDM: Boolean(meta?.isDM || meta?.type === "im"),
  });
  const side = identity === "user" ? resolved.user : resolved.shared;
  return { key: side.token || "", source: side.source };
}

export function register(server, ctx) {
  const { slug, channelId, createdBy, text, loadMeta } = ctx;
  // Injectable only so the tests can prove what the tool hands to staging (a proven descriptor,
  // never a path to reopen); production always uses the real function.
  const stageFile = ctx.stageFile || stageFileForComposio;

  server.registerTool(
    "stage_file_for_composio",
    {
      description:
        "Upload a file from this channel's working folder into Composio's own file storage and return the " +
        "`{name, mimetype, s3key}` object that Composio's file-taking tools require (GOOGLEDRIVE_UPLOAD_FILE, " +
        "GMAIL_SEND_EMAIL attachments, SLACK_UPLOAD_FILE, …). Those tools accept NO path and NO base64 — this is " +
        "how a file you generated here reaches them. Pass the returned object straight through as the tool's file " +
        "argument. Nothing is made publicly reachable and the Composio key never leaves the gateway. " +
        `Path is workspace-relative; the limit is ${formatBytes(COMPOSIO_WORKBENCH_STAGE_MAX_BYTES)} on a Composio ` +
        `consumer (MCP) key and ${formatBytes(COMPOSIO_STAGE_MAX_BYTES)} on a project API key.`,
      inputSchema: {
        path: z.string().describe("File path relative to this channel's working folder."),
        tool: z.string().describe("The Composio tool slug the staged file is for, e.g. GOOGLEDRIVE_UPLOAD_FILE."),
        identity: z.enum(["user", "agent"]).describe(
          "Which Composio identity will run that tool: \"user\" = composio-user (the requester's own account), " +
          "\"agent\" = composio-agent. Must match the identity you then execute the tool with — a file staged " +
          "on one account's key is not visible to the other.",
        ),
        filename: z.string().optional().describe("Override the name Composio records; defaults to the file's own."),
        mimetype: z.string().optional().describe("Override the detected MIME type."),
      },
    },
    async ({ path: relative, tool, identity, filename = "", mimetype = "" }) => {
      let handle;
      try {
        const meta = await loadMeta();
        const { key, source } = await resolveComposioKey({ identity, authorId: createdBy, meta });
        if (!key) {
          return text(
            `No Composio API key is available for \`composio-${identity}\` in this conversation (${source}). ` +
            (identity === "user"
              ? "Set yours with set_my_composio_token, then try again."
              : "An admin sets the channel or organization Composio token in Settings.") +
            "\n\nNote: Composio SDK sessions (Enterprise) do not expose a plain key, so staging is unavailable on those.",
          );
        }

        // Confine and open BEFORE anything is sent anywhere. openConfinedFile proves the file is
        // still inside this channel's folder at open time, which is what stops a model-supplied
        // path (or a symlink swapped in behind it) reaching the operator home on a channel that
        // mounts one. Only THIS step is a refusal; everything after it is a delivery that either
        // worked or failed, and saying "refused" for an upstream error misleads the model into
        // blaming the user's key.
        let opened;
        try {
          opened = await openConfinedFile(workspaceFor(slug, meta), relative);
        } catch (error) {
          return text(`Staging refused: ${clean(error)}`);
        }
        // Stage from the descriptor that was just PROVEN to be inside the folder — never reopen the
        // file by path. The container can write this folder, so a path reopened after the proof
        // could by then be a symlink into the operator's home, read by the unsandboxed daemon.
        handle = opened.handle;
        const staged = await stageFile({
          apiKey: key,
          handle,
          toolSlug: tool,
          filename: filename || opened.name,
          mimetype,
          mcpUrl: composioUrl(),
        });
        await logEvent("composio_file_staged", {
          channel: channelId,
          author: createdBy,
          slug,
          file: opened.relative,
          bytes: staged.bytes,
          identity,
          tool: staged.tool,
          deduplicated: staged.deduplicated,
          route: staged.route,
        });
        return text(
          `Staged \`${opened.relative}\` (${formatBytes(staged.bytes)})${staged.deduplicated ? " — Composio already held these exact bytes" : ""} ` +
          `for ${staged.tool} on \`composio-${identity}\`.\n\n` +
          `Pass this as that tool's file argument, unchanged:\n\`\`\`json\n${JSON.stringify(staged.file, null, 2)}\n\`\`\`\n` +
          `Run the tool on \`composio-${identity}\` — the key that staged it is the only one that can see it.`,
        );
      } catch (error) {
        return text(`Staging failed: ${clean(error)}`);
      } finally {
        await handle?.close().catch(() => {});
      }
    },
  );

  server.registerTool(
    "create_public_file_link",
    {
      description:
        "Mint a TEMPORARY public download URL for one file in this channel's working folder — anyone holding the " +
        "link can fetch it, with no login. Use it only when the destination cannot take the file any other way: " +
        "for Composio destinations use stage_file_for_composio instead, which publishes nothing.\n" +
        `purpose \"upload\": for an API that ingests by URL (e.g. GOOGLEDRIVE_UPLOAD_FROM_URL). Lives ` +
        `${UPLOAD_LINK_DEFAULT_MINUTES} minutes by default, ${UPLOAD_LINK_MAX_MINUTES} at most, and may be fetched ` +
        `${UPLOAD_LINK_MAX_DOWNLOADS} times. Hand it to the API and do NOT post it in the conversation.\n` +
        `purpose \"share\": for a person who asked for a link. ASK THEM how long it should stay live before calling ` +
        `this — \"minutes\" is required and the ceiling is ${SHARE_LINK_MAX_MINUTES} minutes (48 hours). A share ` +
        "link also needs a human Approve click.\n" +
        "Requires an admin to have enabled public file links and set the gateway's Public URL.",
      inputSchema: {
        path: z.string().describe("File path relative to this channel's working folder."),
        purpose: z.enum(["upload", "share"]).describe("\"upload\" for a machine fetch, \"share\" for a person."),
        minutes: z.number().int().positive().optional().describe(
          `How long the link stays live. Required for \"share\" (max ${SHARE_LINK_MAX_MINUTES} = 48h); ` +
          `defaults to ${UPLOAD_LINK_DEFAULT_MINUTES} for \"upload\" (max ${UPLOAD_LINK_MAX_MINUTES}).`,
        ),
      },
    },
    async ({ path: relative, purpose, minutes }) => {
      let handle;
      try {
        if (!getPublicFileLinksEnabled()) {
          return text(
            "Public file links are turned off on this gateway. An admin enables them in Settings → Public file links. " +
            "For a Composio destination, stage_file_for_composio needs no link and is not affected by this switch.",
          );
        }
        const base = getPublicUrl();
        if (!base) return text("Public file links need the gateway's Public URL set in Settings — without it there is no address to hand out.");

        // Validate the duration before touching the filesystem so an over-long request fails with
        // the ceiling named rather than after the work.
        const ttlMinutes = resolveLinkMinutes(purpose, minutes);

        const meta = await loadMeta();
        const opened = await openConfinedFile(workspaceFor(slug, meta), relative);
        handle = opened.handle;
        const size = opened.stat.size;
        await handle.close();
        handle = null;

        const link = createPublicFileLink({
          channelId,
          slug,
          relative: opened.relative,
          filename: opened.name,
          purpose,
          minutes: ttlMinutes,
          createdBy,
        });
        const url = publicFileLinkUrl(base, link.token);
        if (!url) return text("The gateway's Public URL is not a usable http(s) address; a link cannot be built from it.");

        await logEvent("public_file_link_created", {
          channel: channelId,
          author: createdBy,
          slug,
          link: link.id,
          purpose,
          file: opened.relative,
          bytes: size,
          minutes: ttlMinutes,
        });

        const expiry = new Date(link.expiresAt).toISOString();
        return text(
          `Public link for \`${opened.relative}\` (${formatBytes(size)}), live ${describeDuration(ttlMinutes)} — until ${expiry}.\n` +
          `${url}\n\n` +
          (purpose === "upload"
            ? `Hand this to the API that needs it and do not post it in the conversation. It stops working after ` +
              `${UPLOAD_LINK_MAX_DOWNLOADS} fetches or at the expiry above, whichever comes first.`
            : "Anyone with this URL can download the file until it expires, with no login. Revoke it early with " +
              `revoke_public_file_link (id \`${link.id}\`).`),
        );
      } catch (error) {
        return text(`Public link refused: ${clean(error)}`);
      } finally {
        await handle?.close().catch(() => {});
      }
    },
  );

  server.registerTool(
    "list_public_file_links",
    {
      description: "READ ONLY. List this channel's public file links that are still live, with their file, purpose, expiry and fetch count.",
      inputSchema: {},
    },
    async () => {
      try {
        const links = listPublicFileLinks(channelId);
        if (!links.length) return text("No live public file links in this channel.");
        const lines = links.map((l) => {
          const cap = l.maxDownloads ? `${l.downloads}/${l.maxDownloads}` : `${l.downloads}`;
          return `${l.id}\t${l.purpose}\t${l.relative}\tfetched ${cap}\texpires ${new Date(l.expiresAt).toISOString()}`;
        });
        return text(`${links.length} live link(s) — the URLs themselves are not recoverable, only revocable:\n${lines.join("\n")}`);
      } catch (error) {
        return text(`Couldn't list public file links: ${clean(error)}`);
      }
    },
  );

  server.registerTool(
    "revoke_public_file_link",
    {
      description: "Kill one of this channel's public file links immediately. Takes the id from list_public_file_links. Already-finished downloads cannot be recalled.",
      inputSchema: { id: z.string().describe("The link id from list_public_file_links.") },
    },
    async ({ id }) => {
      try {
        // Scoped to this channel, so a link id learned elsewhere cannot be revoked from here.
        const result = revokePublicFileLink(id, { channelId });
        if (!result.link || result.link.channelId !== channelId) return text("No such link in this channel.");
        await logEvent("public_file_link_revoked", { channel: channelId, author: createdBy, slug, link: id });
        return text(result.ok
          ? `Revoked \`${result.link.relative}\` (${result.link.downloads} fetch(es) had already happened).`
          : `That link was already revoked or expired (${result.link.downloads} fetch(es)).`);
      } catch (error) {
        return text(`Couldn't revoke that link: ${clean(error)}`);
      }
    },
  );
}
