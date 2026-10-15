// Connector membership changes require a human decision outside the engine's tool policy.
// This transport sits in front of BOTH token-mode and SDK-mode Composio, on the daemon.
import { createHash } from "node:crypto";

const normalize = (name) => String(name || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
const opaque = (name) => /(?:WORKBENCH|REMOTE_BASH|PROXY|EXECUTE_CODE|EXECUTE_SHELL|CUSTOM_API|HTTP_REQUEST|API_REQUEST)/.test(name);
const membership = (name) => (/(?:^|_)SLACK_/.test(name) &&
  (/(?:^|_)(?:JOIN|INVITE|ACCEPT)(?:_|$)/.test(name) ||
    /(?:CREATE.*(?:CHANNEL|CONVERSATION)|(?:CHANNEL|CONVERSATION).*CREATE|ADD.*(?:USER|MEMBER)|OPEN.*CONVERSATION)/.test(name))) ||
  /^(?:ADMIN_)?CONVERSATIONS_(?:JOIN|INVITE|CREATE|ACCEPT)/.test(name);

/** Inspect structured calls, never guess what arbitrary connector-side code will do. */
export function composioApprovalDetails(params, identity) {
  const changes = [];
  const walk = (name, args, account, depth = 0) => {
    if (depth > 8) throw new Error("connector call nesting is too deep");
    if (typeof name !== "string" || !name) throw new Error("connector action name is missing");
    const key = normalize(name);
    if (membership(key)) {
      // IDs and account aliases are a bounded preview; arbitrary message/code/secret arguments
      // never enter the approval card. The digest below binds it to the entire exact request.
      const pick = (value) => {
        if (Array.isArray(value)) return `[${value.map(pick).join(", ")}]`;
        if (typeof value !== "string") throw new Error("membership preview requires text or text arrays");
        if (value.length > 160) throw new Error("split membership changes into smaller requests");
        return value.replace(/[\x00-\x1f`<>]/g, "");
      };
      const fields = ["channel", "channel_id", "channel_ids", "name", "users", "user", "user_ids", "account", "connected_account_id"]
        .filter((field) => Object.hasOwn(args || {}, field)).map((field) => `${field}=${pick(args[field])}`);
      if (account !== undefined) fields.push(`execution account=${pick(account)}`);
      changes.push(`${key}: ${fields.join("; ") || "connected account; destination unspecified"}`);
    } else if (opaque(key)) {
      // The workbench is persistent and can construct action names dynamically. A regex on its
      // Python/shell source would be bypassable. Refuse it, rather than presenting a broad code
      // approval as if it were consent to one concrete channel/invitee change.
      throw new Error("opaque connector execution is disabled");
    } else if (/COMPOSIO_(?:MULTI_EXECUTE_TOOL|EXECUTE_TOOL|EXECUTE_ACTION|RUN_TOOL)$/.test(key)) {
      if (Array.isArray(args?.tools)) {
        for (const tool of args.tools) walk(tool.tool_slug || tool.slug || tool.name, tool.arguments, tool.account || account, depth + 1);
      } else if (args?.tool_slug || args?.slug || args?.tool_name) {
        walk(args.tool_slug || args.slug || args.tool_name, args.arguments, args.account || account, depth + 1);
      } else {
        throw new Error("connector execution requires structured actions");
      }
    } else if (/COMPOSIO_.*(?:EXECUTE|RUN_CODE|BASH)/.test(key)) {
      throw new Error("unrecognized connector executor");
    }
  };
  walk(params?.name, params?.arguments, params?.arguments?.account);
  if (!changes.length) return null;
  if (changes.length > 8) throw new Error("split membership changes into batches of at most eight");
  const digest = createHash("sha256").update(JSON.stringify(params)).digest("hex");
  const details = `Connection: ${identity}\n${changes.join("\n")}\nExact request: sha256:${digest}\nSharing/posting does not authorize joining a channel. This approval applies once to this request only.`;
  if (details.length > 2400) throw new Error("split membership changes so the entire preview fits on the card");
  return details;
}

/** Wrap an MCP Transport without changing its lifecycle or the upstream SDK implementation. */
export function withComposioApproval(transport, { identity, authorize, requestApproval }) {
  let closed = false;
  const waiting = new Map();
  const wrapped = {
    async start() {
      transport.onmessage = (message, extra) => {
        if (message.method === "notifications/cancelled") {
          const pending = waiting.get(message.params?.requestId);
          if (pending) pending.cancelled = true;
        }
        if (message.method !== "tools/call" || message.id === undefined) {
          wrapped.onmessage?.(message, extra);
          return;
        }
        const request = structuredClone(message);
        const pending = { cancelled: false };
        waiting.set(request.id, pending);
        void (async () => {
          try {
            const claims = authorize();
            const details = composioApprovalDetails(request.params, identity);
            if (details) {
              const decision = await requestApproval({
                approvalType: "agent",
                channelId: claims.channelId,
                slug: claims.slug,
                authorId: claims.authorId,
                threadKey: claims.threadKey,
                toolName: "Approve connector access change",
                toolInput: { details },
                approveText: "Approve once",
                denyText: "Deny",
              });
              if (decision?.allow !== true) throw new Error("approval was not granted");
            }
            // A click is not reusable authority: revocation/expiry/cancellation wins while waiting.
            authorize();
            if (!closed && !pending.cancelled) wrapped.onmessage?.(request, extra);
          } catch {
            if (!closed && !pending.cancelled) {
              await transport.send({ jsonrpc: "2.0", id: request.id, result: {
                isError: true,
                content: [{ type: "text", text: "Connector action was not executed. Structured channel membership changes require a one-use human approval; denial, timeout, unavailable approval or revoked authority stops the action. Opaque connector workbench/bash/API executors are disabled because they can hide membership changes. Use explicit structured actions in small batches; never bypass this check with code, another identity, or a direct API call." }],
              } });
            }
          } finally {
            if (waiting.get(request.id) === pending) waiting.delete(request.id);
          }
        })().catch(() => {});
      };
      transport.onclose = () => { closed = true; wrapped.onclose?.(); };
      transport.onerror = (error) => wrapped.onerror?.(error);
      await transport.start();
    },
    send: (message, options) => transport.send(message, options),
    close: async () => { closed = true; await transport.close(); },
    get sessionId() { return transport.sessionId; },
  };
  return wrapped;
}
