import { z } from "zod";
import { queryChannelDatabase } from "../../gateway/channel-database.js";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export function register(server, ctx) {
  const query = ctx.channelDatabase?.query || queryChannelDatabase;
  server.registerTool("query_channel_database", {
    description:
      "Read this channel's operator-configured database through its isolated VPN service. " +
      "Accepts only list_databases, list_tables, describe_table, and bounded select_rows operations; " +
      "it never accepts SQL, connection details, credentials, paths, or another channel id. " +
      "select_rows requires explicit columns and supports equality filters, optional ordering, and at most 100 rows.",
    inputSchema: {
      operation: z.enum(["list_databases", "list_tables", "describe_table", "select_rows"]),
      database: z.string().optional(),
      table: z.string().optional(),
      columns: z.array(z.string()).max(50).optional(),
      filters: z.array(z.object({ column: z.string(), value: scalar }).strict()).max(20).optional(),
      orderBy: z.object({ column: z.string(), direction: z.enum(["asc", "desc"]) }).strict().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async (args) => {
    const authorize = async () => {
      const capability = ctx.verifyCapability();
      // Channel access, not personal identity: an API run reads its channel's databases like a member.
      return capability?.ok === true && await ctx.requireChannelAccess();
    };
    try {
      const result = await query(ctx.channelId, args, { authorize });
      return ctx.text(JSON.stringify(result));
    } catch (error) {
      const message = error?.statusCode ? error.message : "The database service could not complete the read-only request.";
      return { ...ctx.text(message), isError: true };
    }
  });
}
