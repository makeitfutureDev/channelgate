// SSH access to this channel's container, from chat (docs/SSH-ACCESS.md): a person registers
// their ONE public key (bound to the identity that pasted it), a channel manager grants them SSH
// on this channel, and `show_channel_ssh` hands out the ssh config block. The daemon-side broker
// (src/gateway/ssh-broker.js) does the actual attach; nothing here can open a session.
import { z } from "zod";
import { getUser, isAdmin, isApproved, patchChannelMeta } from "../../config/store.js";
import { logChannelPolicyChange } from "../../config/channel-audit.js";
import { getContainerRuntime } from "../../config/settings.js";
import { effectiveWorkDir } from "../../gateway/folders.js";
import {
  addSshKey, connectSnippet, exportHostAuthorizedKeys, grantSshUser, keysForUsers, listSshKeys, listSshSessions, parseUserRef,
  removeSshKey, revokeSshUser, sshAccessState, sshBlockedByHomeGrant, sshUsersOf, SSH_PUBLIC_KEY_HELP,
} from "../../gateway/ssh-access.js";

const KEY_DOC = "Keys are per PERSON (one laptop key registered once), never per channel; the channel is chosen when connecting.";

function when(ms) {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never";
}

export function register(server, ctx) {
  const { channelId, slug, createdBy, text, principalTrusted, requireManage, requireChannelAccess, loadMeta } = ctx;
  const approvedAuthor = async () => principalTrusted && Boolean(createdBy) && ((await isAdmin(createdBy)) || (await isApproved(createdBy)));
  const displayName = async (userId) => {
    const user = await getUser(userId);
    return user?.name ? `@${user.name}` : userId;
  };
  const exportKeys = () => {
    try {
      return exportHostAuthorizedKeys();
    } catch (error) {
      return { written: false, reason: String(error?.message || error) };
    }
  };
  async function patchAuditedMeta(patch) {
    let replaced = null;
    const next = await patchChannelMeta(slug, (meta) => {
      if (!meta) return null;
      const partial = typeof patch === "function" ? patch(meta) : patch;
      if (partial == null) return null;
      replaced = meta;
      return partial;
    });
    if (next) await logChannelPolicyChange({ channelId, slug, actor: createdBy, before: replaced, after: next, source: "mcp" });
    return next;
  }

  server.registerTool(
    "add_my_ssh_key",
    {
      description:
        `Register YOUR OWN SSH public key with the gateway so a channel manager can grant you SSH access into channel containers. ${KEY_DOC} `
        + `Pass the single line of the .pub file exactly as pasted. Never accept a private key. ${SSH_PUBLIC_KEY_HELP}`,
      inputSchema: { public_key: z.string(), label: z.string().optional() },
    },
    async ({ public_key, label }) => {
      if (!(await approvedAuthor())) return text("Only an approved user can register an SSH key, and only for their own account.");
      let result;
      try {
        result = await addSshKey(createdBy, public_key, { label });
      } catch (error) {
        return text(`❌ ${error?.message || error}`);
      }
      const exported = exportKeys();
      const host = exported.written
        ? "The gateway host now accepts it."
        : `The gateway host is not set up for SSH access yet (${exported.reason}); the key is stored and will be exported once it is.`;
      return text(`${result.created ? "✅ Registered" : "ℹ️ Already registered"} your ${result.parsed.family} key **${result.key.fingerprint}**${result.key.label ? ` (${result.key.label})` : ""}. ${host}\n`
        + "Next: a manager of the channel you need grants you access there (“grant SSH access to @you”), then `show_channel_ssh` in that channel gives you the ssh config block.");
    },
  );

  server.registerTool(
    "list_my_ssh_keys",
    { description: "List the SSH public keys registered for YOUR account (fingerprints, labels, last use). Never shows anyone else's.", inputSchema: {} },
    async () => {
      if (!createdBy) return text("No user context.");
      const keys = await listSshKeys(createdBy);
      if (!keys.length) return text(`You have no registered SSH key. ${SSH_PUBLIC_KEY_HELP} Then use add_my_ssh_key.`);
      return text(keys.map((key) => `• ${key.fingerprint} — ${key.type}${key.label ? ` (${key.label})` : ""}, added ${when(key.createdAt)}, last used ${when(key.lastUsedAt)}, id \`${key.id}\``).join("\n"));
    },
  );

  server.registerTool(
    "remove_my_ssh_key",
    { description: "Remove one of YOUR registered SSH keys by fingerprint (SHA256:…) or id. Every channel grant stops working for that key immediately; open sessions end when they disconnect.", inputSchema: { key: z.string() } },
    async ({ key }) => {
      if (!createdBy) return text("No user context.");
      const removed = await removeSshKey(createdBy, key);
      if (!removed) return text("No key of yours matches that fingerprint or id (list_my_ssh_keys shows them).");
      exportKeys();
      return text(`✅ Removed your key ${removed.fingerprint}.`);
    },
  );

  server.registerTool(
    "grant_channel_ssh",
    {
      description:
        "CHANNEL MANAGERS / ADMINS. Grant a person SSH access into THIS channel's container: a full shell as the channel (its files, its CLI logins, Claude and Codex), "
        + "the same box the assistant works in. The person must be an approved user allowed in this channel and must have registered their own key (add_my_ssh_key). "
        + "Pass their user id or @mention.",
      inputSchema: { user: z.string() },
    },
    async ({ user }) => {
      if (!(await requireManage())) return text("Only this channel's managers (or an admin) can grant SSH access.");
      const userId = parseUserRef(user);
      if (!userId) return text("Name the person as a user id or @mention.");
      const record = await getUser(userId);
      if (!record || !(record.approved || record.isAdmin)) return text(`${userId} is not an approved user of this gateway — an admin approves them first.`);
      const meta = await loadMeta();
      if (!meta) return text("Channel isn't set up yet — send a normal message first.");
      const grant = grantSshUser(meta, userId);
      if (!grant.changed) return text(`${await displayName(userId)} already has SSH access here.`);
      if (!(await patchAuditedMeta({ sshUsers: grant.sshUsers }))) return text("Channel isn't set up yet — send a normal message first.");
      const keys = await keysForUsers([userId]);
      const setup = sshAccessState();
      const notes = [];
      if (!keys.length) notes.push("they have not registered a key yet (add_my_ssh_key)");
      if (!setup.configured) notes.push(`the gateway host is not set up for SSH access (${setup.reason})`);
      if (sshBlockedByHomeGrant(meta, getContainerRuntime())) notes.push("connections will be REFUSED while this channel is in Admin mode and the gateway's containerFullAccessHome switch is on");
      return text(`✅ ${await displayName(userId)} may now SSH into this channel's container.${notes.length ? ` Note: ${notes.join("; ")}.` : ""} They run show_channel_ssh here for the connection block.`);
    },
  );

  server.registerTool(
    "revoke_channel_ssh",
    { description: "CHANNEL MANAGERS / ADMINS. Revoke a person's SSH access into THIS channel's container. New connections are refused at once; a session already open ends when it disconnects.", inputSchema: { user: z.string() } },
    async ({ user }) => {
      if (!(await requireManage())) return text("Only this channel's managers (or an admin) can revoke SSH access.");
      const userId = parseUserRef(user);
      if (!userId) return text("Name the person as a user id or @mention.");
      const meta = await loadMeta();
      if (!meta) return text("Channel isn't set up yet — send a normal message first.");
      const change = revokeSshUser(meta, userId);
      if (!change.changed) return text(`${await displayName(userId)} has no SSH access here.`);
      if (!(await patchAuditedMeta({ sshUsers: change.sshUsers }))) return text("Channel isn't set up yet — send a normal message first.");
      const live = listSshSessions({ slug, live: true }).filter((session) => session.userId === userId);
      return text(`✅ SSH access for ${await displayName(userId)} revoked here.${live.length ? ` ${live.length} open session(s) of theirs will end when they disconnect.` : ""}`);
    },
  );

  server.registerTool(
    "show_channel_ssh",
    {
      description:
        "Show SSH access for THIS channel's container: whether the gateway host is set up, who is granted, whether the requester can connect, live sessions, and the ssh config block to paste "
        + "(one key per person; the channel rides in the ProxyCommand, so one person can connect to several channels at once). Use for “how do I SSH into this”, “who has SSH here”, “give me the connection info”.",
      inputSchema: {},
    },
    async () => {
      if (!(await requireChannelAccess())) return text("You are not allowed in this channel.");
      const meta = await loadMeta();
      if (!meta) return text("Channel isn't set up yet — send a normal message first.");
      const setup = sshAccessState();
      const granted = sshUsersOf(meta);
      const lines = [`**SSH access for this channel** (\`${slug}\`)`];
      lines.push(setup.configured
        ? `• Gateway endpoint: \`${setup.endpoint.user}@${setup.endpoint.host}${setup.endpoint.port !== 22 ? `:${setup.endpoint.port}` : ""}\``
        : `• Gateway endpoint: **not set up** — an operator runs \`sudo bash scripts/install-ssh-access.sh\` on the gateway host (${setup.reason}).`);
      if (sshBlockedByHomeGrant(meta, getContainerRuntime())) {
        lines.push("• ⚠️ Connections are REFUSED right now: this channel is in Admin mode while the gateway's `containerFullAccessHome` switch is on (its container would expose the operator's whole home). Turn one of them off.");
      }
      if (!granted.length) lines.push("• Granted: nobody yet — a manager says “grant SSH access to @person”.");
      else {
        const parts = [];
        for (const userId of granted) {
          const keys = await keysForUsers([userId]);
          parts.push(`${await displayName(userId)}${keys.length ? "" : " (no key registered yet)"}`);
        }
        lines.push(`• Granted: ${parts.join(", ")}`);
      }
      const live = listSshSessions({ slug, live: true });
      if (live.length) {
        const parts = [];
        for (const session of live) parts.push(`${await displayName(session.userId)} since ${when(session.startedAt)}`);
        lines.push(`• Live sessions: ${parts.join(", ")} — the container stays up while any session is open.`);
      } else lines.push("• Live sessions: none.");
      const myKeys = createdBy ? await listSshKeys(createdBy) : [];
      const mine = createdBy && granted.includes(createdBy);
      if (mine && !myKeys.length) lines.push(`• You are granted but have no key registered: ${SSH_PUBLIC_KEY_HELP} Then add_my_ssh_key.`);
      else if (!mine && createdBy) lines.push(`• You are not granted here${myKeys.length ? "" : " and have no key registered"}.`);
      if (setup.configured) {
        lines.push("", "Once granted, add this to `~/.ssh/config` on your laptop (your usual key; nothing per channel), then `ssh " + slug + "` or open it with VS Code Remote-SSH:", "```", connectSnippet({ endpoint: setup.endpoint, channel: slug }), "```",
          `To open VS Code straight on the channel folder: \`code --remote ssh-remote+${slug} ${effectiveWorkDir(slug, meta)}\` (the Open Folder dialog otherwise starts in /home/agent).`,
          "Inside you are user `agent` in the channel's work folder with its `/home/agent`, CLI logins and Codex. `claude` there is this channel's Claude exactly as a message here gets it: the channel's tool policy, the gateway tools (no background jobs or approval cards — no thread to post into), your own Composio accounts as `composio-user`, the channel's as `composio-agent`, the channel's MCP servers and its secrets by name — signed in as the gateway's own account, whose usage it counts against. Everyone in the box shares that one user; set your git identity per session. A daemon restart drops sessions — just reconnect.");
      }
      return text(lines.join("\n"));
    },
  );
}
