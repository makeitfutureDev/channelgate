import { z } from "zod";
import { addApprovedEgressHost } from "../../gateway/egress-hosts.js";

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
}
