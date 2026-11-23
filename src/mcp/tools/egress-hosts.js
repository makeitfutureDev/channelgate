import { z } from "zod";
import { addApprovedEgressHost, addApprovedPrivateHost, removePrivateHost } from "../../gateway/egress-hosts.js";
import { LOOPBACK_ALIAS } from "../../gateway/egress/private-hosts.js";

export function register(server, ctx) {
  server.registerTool("allow_channel_ssh_host", {
    description: "Request human approval to add one exact public SSH hostname or IPv4/IPv6 address to THIS channel's egressRawHosts. Any authorized channel member with write access may approve; no admin or /sudo is needed. The durable card survives restarts and is never auto-approved. Pass port for the actual SSH TCP port (1–65535), including 22: the approval opens ONLY that exact host:port. Omitting port preserves legacy ports 22, 5432 and 6543, while Network must remain on and private addresses remain blocked. After approval retry SSH with -o ProxyCommand='/opt/channelgate/bin/cg-egress-connect %h %p' and the existing key. Does not grant keys, enable Network, or enable rawNetwork.",
    inputSchema: { host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535).optional() },
  }, async ({ host, port }) => {
    try {
      const saved = await addApprovedEgressHost(ctx, host, { port });
      return ctx.text(`✅ ${saved} is allowed in this channel's egress list (TCP ${port === undefined ? "22, 5432, 6543" : port}). Retry SSH using ${port === undefined ? "" : `-p ${port} `}-o ProxyCommand='/opt/channelgate/bin/cg-egress-connect %h %p' and your existing key. Network must remain on; private addresses remain blocked.`);
    } catch (error) {
      return { ...ctx.text(`❌ ${error.message}`), isError: true };
    }
  });

  server.registerTool("allow_channel_private_host", {
    description: `Request ORGANIZATION-ADMIN approval to let THIS channel reach one exact PRIVATE or LOOPBACK destination host:port through the egress proxy — e.g. a LAN SSH/SFTP server, an FTP server, a NAS, an internal API, or a local MCP server on the gateway host. The gateway resolves the host now and PINS that single address; the card shows it and only an admin can approve it. Traffic is a raw tunnel (SSH, FTP control, databases, http/https) to the pinned address and stops working if DNS later points elsewhere. Services on the gateway host's own loopback (localhost/127.0.0.1) are reached from the container as ${LOOPBACK_ALIAS}:<port>, never 127.0.0.1. Cloud metadata, link-local addresses and the gateway's own admin port can never be approved. Network must be on. Passive FTP needs each data port approved too; prefer SFTP. For PUBLIC SSH hosts use allow_channel_ssh_host instead.`,
    inputSchema: {
      host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      address: z.string().max(64).optional().describe("Filled in by the gateway: the pinned address shown on the approval card."),
    },
  }, async ({ host, port, address }) => {
    try {
      const saved = await addApprovedPrivateHost(ctx, host, { port, address });
      const target = `${saved.host.includes(":") ? `[${saved.host}]` : saved.host}:${saved.port}`;
      return ctx.text(`✅ ${target} → ${saved.address} is approved for this channel. Connect to ${target} through the proxy: SSH/SFTP/raw TCP with -o ProxyCommand='/opt/channelgate/bin/cg-egress-connect %h %p'; http/https clients use HTTP(S)_PROXY as usual.`);
    } catch (error) {
      return { ...ctx.text(`❌ ${error.message}`), isError: true };
    }
  });

  server.registerTool("revoke_channel_private_host", {
    description: "Remove an approved private destination from THIS channel (host, or host + port). Takes effect on the next connection.",
    inputSchema: { host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535).optional() },
  }, async ({ host, port }) => {
    try {
      const removed = await removePrivateHost(ctx, host, port);
      return ctx.text(removed.length ? `🗑️ Removed ${removed.join(", ")}.` : `Nothing matched ${host}${port ? `:${port}` : ""}; nothing was changed.`);
    } catch (error) {
      return { ...ctx.text(`❌ ${error.message}`), isError: true };
    }
  });
}
