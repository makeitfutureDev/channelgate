// Read-only workspace ownership view shared by the admin conversation list and folder picker.
// Use effectiveWorkDir rather than comparing stored strings: it applies the same containment,
// realpath and missing-folder fallback rules as an actual engine run.
import { effectiveWorkDir } from "./folders.js";

function conversationSummary(channel) {
  return {
    channelId: String(channel.channelId || channel.meta?.channelId || ""),
    slug: String(channel.slug || ""),
    name: String(channel.name || channel.meta?.name || channel.slug || ""),
    type: String(channel.type || channel.meta?.type || ""),
    isDM: Boolean(channel.isDM || channel.meta?.isDM),
  };
}

export function workspaceAssignmentGroups(channels = []) {
  const groups = new Map();
  for (const channel of channels) {
    if (!channel?.meta || !channel.slug) continue;
    const workDir = effectiveWorkDir(channel.slug, { ...channel.meta, cleanMode: false });
    if (!groups.has(workDir)) groups.set(workDir, []);
    groups.get(workDir).push(conversationSummary(channel));
  }
  return groups;
}

export function workspaceConflictsBySlug(channels = []) {
  const conflicts = new Map();
  for (const [workDir, conversations] of workspaceAssignmentGroups(channels)) {
    if (conversations.length < 2) continue;
    for (const conversation of conversations) {
      conflicts.set(conversation.slug, {
        path: workDir,
        conversations: conversations.filter((other) => other.slug !== conversation.slug),
      });
    }
  }
  return conflicts;
}

export function workspaceAssignmentsAtPath(channels = [], workDir = "") {
  return workspaceAssignmentGroups(channels).get(workDir) || [];
}
