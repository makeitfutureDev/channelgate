// Connector membership changes require a human decision outside the engine's tool policy.
// This transport sits in front of BOTH token-mode and SDK-mode Composio, on the daemon.
import { createHash } from "node:crypto";

const normalize = (name) => String(name || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
const opaque = (name) => /(?:WORKBENCH|REMOTE_BASH|PROXY|EXECUTE_CODE|EXECUTE_SHELL|CUSTOM_API|HTTP_REQUEST|API_REQUEST)/.test(name);
const membership = (name) => (/(?:^|_)SLACK_/.test(name) &&
  (/(?:^|_)(?:JOIN|INVITE|ACCEPT)(?:_|$)/.test(name) ||
    /(?:CREATE.*(?:CHANNEL|CONVERSATION)|(?:CHANNEL|CONVERSATION).*CREATE|ADD.*(?:USER|MEMBER)|OPEN.*CONVERSATION)/.test(name))) ||
  /^(?:ADMIN_)?CONVERSATIONS_(?:JOIN|INVITE|CREATE|ACCEPT)/.test(name);

// A refusal whose reason is ours and safe to show the engine, so it can correct the call.
// Anything else (an approval transport failure, say) stays generic: its text is not ours.
const refusal = (reason) => Object.assign(new Error(reason), { publicReason: reason });
const META_EXECUTOR = /COMPOSIO_(?:MULTI_EXECUTE_TOOL|EXECUTE_TOOL|EXECUTE_ACTION|RUN_TOOL)$/;
const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
const plainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Models sometimes send a batch's `tools` (or one item's `arguments`) as a JSON-encoded string
 * instead of the array/object the schema asks for. Decode exactly those shapes into a copy, so the
 * request that is inspected is also the one that is forwarded — never inspect one form and send
 * another. Anything that does not decode to the expected shape is left as-is and refused below.
 */
export function normalizeComposioCall(params) {
  const copy = structuredClone(params);
  const fix = (name, args, depth = 0) => {
    if (depth > 8 || !plainObject(args) || !META_EXECUTOR.test(normalize(name))) return;
    if (typeof args.tools === "string") {
      const decoded = parseJson(args.tools);
      if (Array.isArray(decoded)) args.tools = decoded;
    }
    const items = Array.isArray(args.tools) ? args.tools : (args.tool_slug || args.slug || args.tool_name) ? [args] : [];
    for (const item of items) {
      if (!plainObject(item)) continue;
      if (typeof item.arguments === "string") {
        const decoded = parseJson(item.arguments);
        if (plainObject(decoded)) item.arguments = decoded;
      }
      if (item !== args) fix(item.tool_slug || item.slug || item.name, item.arguments, depth + 1);
    }
  };
  if (plainObject(copy)) fix(copy.name, copy.arguments);
  return copy;
}

/** Inspect structured calls, never guess what arbitrary connector-side code will do. */
export function composioApprovalDetails(params, identity) {
  const changes = [];
  const walk = (name, args, account, depth = 0) => {
    if (depth > 8) throw refusal("connector calls are nested too deeply");
    if (typeof name !== "string" || !name) throw refusal("an action in this call has no tool_slug");
    const key = normalize(name).slice(0, 120);
    if (membership(key)) {
      // IDs and account aliases are a bounded preview; arbitrary message/code/secret arguments
      // never enter the approval card. The digest below binds it to the entire exact request.
      const pick = (value) => {
        if (Array.isArray(value)) return `[${value.map(pick).join(", ")}]`;
        if (typeof value !== "string") throw refusal("a channel membership action's channel, user and account fields must be text or arrays of text");
        if (value.length > 160) throw refusal("a channel membership action's field is longer than 160 characters; split the change into smaller requests");
        return value.replace(/[\x00-\x1f`<>]/g, "");
      };
      const fields = ["channel", "channel_id", "channel_ids", "name", "users", "user", "user_ids", "account", "connected_account_id"]
        .filter((field) => Object.hasOwn(args || {}, field)).map((field) => `${field}=${pick(args[field])}`);
      if (account !== undefined) fields.push(`execution account=${pick(account)}`);
      changes.push(`${key}: ${fields.join("; ") || "connected account; destination unspecified"}`);
    } else if (key === "COMPOSIO_REMOTE_WORKBENCH" || key === "COMPOSIO_REMOTE_BASH_TOOL") {
      // Workbench and Remote Bash are admitted processing routes for remote result files.
      // Forward code/commands/session unchanged; arbitrary code cannot be inspected reliably here.
      // Membership actions inside them remain subject to the agent's human-approval instructions,
      // rather than this structured-call gate. Other opaque executors remain refused below.
      return;
    } else if (opaque(key)) {
      throw refusal(`${key} is disabled on this gateway because its effect cannot be inspected; use a structured app tool through COMPOSIO_MULTI_EXECUTE_TOOL, or COMPOSIO_REMOTE_WORKBENCH`);
    } else if (META_EXECUTOR.test(key)) {
      if (Array.isArray(args?.tools)) {
        for (const tool of args.tools) walk(tool.tool_slug || tool.slug || tool.name, tool.arguments, tool.account || account, depth + 1);
      } else if (args?.tool_slug || args?.slug || args?.tool_name) {
        walk(args.tool_slug || args.slug || args.tool_name, args.arguments, args.account || account, depth + 1);
      } else {
        throw refusal(`${key} needs \`tools\` as a JSON array of {"tool_slug": ..., "arguments": {...}} objects (got ${args?.tools === undefined ? "no tools" : typeof args.tools === "string" ? "a string that is not a JSON array" : typeof args.tools}); send the array itself, not an encoded string`);
      }
    } else if (/COMPOSIO_.*(?:EXECUTE|RUN_CODE|BASH)/.test(key)) {
      throw refusal(`${key} is not a connector executor this gateway can inspect; use COMPOSIO_MULTI_EXECUTE_TOOL with structured actions`);
    }
  };
  walk(params?.name, params?.arguments, params?.arguments?.account);
  if (!changes.length) return null;
  if (changes.length > 8) throw refusal("split channel membership changes into batches of at most eight");
  const digest = createHash("sha256").update(JSON.stringify(params)).digest("hex");
  const details = `Connection: ${identity}\n${changes.join("\n")}\nExact request: sha256:${digest}\nSharing/posting does not authorize joining a channel. This approval applies once to this request only.`;
  if (details.length > 2400) throw refusal("split channel membership changes so the entire preview fits on the approval card");
  return details;
}

const NO_BYPASS = "Never bypass a gateway refusal with code, another identity, or a direct API call.";

/** The refusal the engine sees: the actual reason, so it can fix a malformed call instead of guessing. */
export function composioRefusalText(stage, error) {
  if (stage === "shape") {
    const reason = error?.publicReason || "the call could not be inspected";
    return `Connector action was not executed (nothing was sent to the connector): ${reason}. Fix the call and retry. ${NO_BYPASS}`;
  }
  if (stage === "approval") {
    return `Connector action was not executed: it changes Slack channel membership, which needs a one-use human approval, and that approval was denied, timed out or is unavailable. Ask the user before trying again. ${NO_BYPASS}`;
  }
  return `Connector action was not executed: this run's gateway authority is no longer valid (the turn, job or session that started it has ended or was revoked), so connector calls are refused. Retrying in this run will not help. ${NO_BYPASS}`;
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
        // The normalized copy is both what is inspected and what is forwarded upstream.
        const request = { ...message, params: normalizeComposioCall(message.params) };
        const pending = { cancelled: false };
        waiting.set(request.id, pending);
        void (async () => {
          let stage = "authority";
          try {
            const claims = authorize();
            stage = "shape";
            const details = composioApprovalDetails(request.params, identity);
            if (details) {
              stage = "approval";
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
            stage = "authority";
            authorize();
            if (!closed && !pending.cancelled) wrapped.onmessage?.(request, extra);
          } catch (error) {
            if (!closed && !pending.cancelled) {
              await transport.send({ jsonrpc: "2.0", id: request.id, result: {
                isError: true,
                content: [{ type: "text", text: composioRefusalText(stage, error) }],
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
