import { z } from "zod";
import { addApprovedEgressHost } from "../../gateway/egress-hosts.js";

export function register(server, ctx) {
  server.registerTool("allow_channel_ssh_host", {
    description: "Request human approval to add one exact public SSH server to THIS channel's egressRawHosts. Any authorized channel member with write access may approve; no admin or /sudo is needed. The durable card survives restarts and is never auto-approved. The existing host list permits raw TCP on ports 22, 5432 and 6543, while Network must remain on and private addresses remain blocked. After approval retry SSH with -o ProxyCommand='/opt/channelgate/bin/cg-egress-connect %h %p' and the existing key. Does not grant keys, enable Network, or enable rawNetwork.",
    inputSchema: { host: z.string().min(1).max(253) },
  }, async ({ host }) => {
    try {
      const saved = await addApprovedEgressHost(ctx, host);
      return ctx.text(`✅ ${saved} is allowed in this channel's egress list (TCP 22, 5432, 6543). Retry SSH using -o ProxyCommand='/opt/channelgate/bin/cg-egress-connect %h %p' and your existing key. Network must remain on; private addresses remain blocked.`);
    } catch (error) {
      return { ...ctx.text(`❌ ${error.message}`), isError: true };
    }
  });
}
