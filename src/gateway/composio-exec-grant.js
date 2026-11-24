// The per-turn grant a container SCRIPT uses to reach the Composio script relay
// (src/mcp/composio-exec.js). SDK mode only. It is a `composio-exec` scoped capability — it opens
// the relay and nothing else — written 0600 into the channel's artifact dir (the one directory
// both the daemon and that channel's container see at the same path), named in the turn's prompt,
// and deleted when the turn settles. Liveness makes a copied grant worthless once the
// conversation has no live work; the relay re-checks the author's admin rights and the channel's
// Admin mode itself on every admin-wide request.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { mintGatewayCapability } from "./mcp-capability.js";
import { sdkGrant } from "./mcp.js";
import { runtimeSocketFile } from "../config/paths.js";
import { CONTAINER_SOCKET_FILE } from "../runtimes/container/image-paths.js";
import { runtimeSupports } from "../runtimes/contract.js";

export const COMPOSIO_CLIENT_REL = ".claude/skills/gateway-usage/scripts/composio.mjs";

/** The SDK-mode session grants (with their user ids) a script may act as, or [] when none. */
export function composioExecGrants({ principalTrusted = true, composioUserEndpoint = null, composioEndpoint = null } = {}) {
  const grants = [];
  if (principalTrusted && composioUserEndpoint?.mode === "sdk" && composioUserEndpoint.identityId) grants.push(sdkGrant("user", composioUserEndpoint));
  if (composioEndpoint?.mode === "sdk" && composioEndpoint.identityId) grants.push(sdkGrant("channel", composioEndpoint));
  return grants;
}

/**
 * Write this turn's grant file. Returns `{ file, prefix }`, or null when the run has no SDK-mode
 * Composio identity (Personal mode, clean mode, no sessions) — then nothing is written or said.
 */
export async function writeComposioExecGrant({
  target, artifactRoot, cwd, secret = process.env.CG_APPROVAL_SECRET || "",
  channelId, slug, authorId, threadKey, origin, engine, principalTrusted = true,
  composioUserEndpoint = null, composioEndpoint = null,
} = {}) {
  const composioSessions = composioExecGrants({ principalTrusted, composioUserEndpoint, composioEndpoint });
  if (!composioSessions.length || !secret || !artifactRoot) return null;
  const capability = mintGatewayCapability({
    secret, channelId, slug, authorId, threadKey, origin, engine, principalTrusted,
    composioSessions, scope: "composio-exec",
  });
  const socket = target && runtimeSupports(target, "isolated") ? CONTAINER_SOCKET_FILE : runtimeSocketFile();
  const file = path.join(artifactRoot, `cg-composio-${randomUUID()}.json`);
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify({ v: 1, socket, capability })}\n`, { mode: 0o600 });
  const kinds = composioSessions.map((grant) => (grant.kind === "user" ? '"user"' : '"agent"')).join(" and ");
  const client = cwd ? path.join(cwd, COMPOSIO_CLIENT_REL) : COMPOSIO_CLIENT_REL;
  const prefix = `[Composio script relay for THIS turn: code in this container can call this run's Composio connections (identity ${kinds}) with no API key — \`node ${client} --grant ${file} …\`, or import it from a script and pass the grant path (CG_COMPOSIO_GRANT). The daemon runs each call; the grant stops working when this turn ends. See gateway-usage references/composio-scripts.md.]\n\n`;
  return { file, prefix };
}
