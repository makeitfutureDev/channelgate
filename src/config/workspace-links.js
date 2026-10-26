import { getDmTemplate } from "./settings.js";
// Folder-owned configuration. Runtime identity and personal grants stay local. Shared authorization and connectors
// follow the owner so joining a folder does not create a second policy for its files. Never redirect a write to another
// conversation: its managers must authorize changes there.
export const WORKSPACE_FIELDS = Object.freeze([
  "skills", "skillsOff", "skillTemplate", "memory", "instructions", "syncDriveFolder", "vpnService",
  "access", "manageAccess", "managers", "allowedUsers", "excludedUsers", "approvedTools", "sshUsers",
  "allowedMcps", "allowedCodexMcps", "allowedOpenCodeMcps", "customMcps", "emailAccounts", "noDefaultTokens",
  "composioToken", "composioTokenLabel", "toolboxToken", "toolboxTokenLabel", "makeToolboxUrl", "makeToolboxKey", "env", "egressRawHosts",
  "profile", "adminMode", "allowBash", "autoMode", "cleanMode", "allowNetwork", "rawNetwork",
]);

export function workspaceSetup(meta) {
  if (!meta?.isDM || !["user", "admin"].includes(meta.template) || meta.workspaceLink) return meta;
  const template = getDmTemplate(meta.template);
  const next = { ...meta };
  for (const key of ["skills", "skillTemplate", "allowedMcps", "allowedCodexMcps", "adminMode", "allowBash", "allowNetwork", "autoMode", "cleanMode"]) next[key] = template[key];
  return next;
}

export function workspaceProjection(slug, meta, rows, effectiveWorkDir) {
  if (!meta) return meta;
  const cwd = effectiveWorkDir(slug, { ...meta, cleanMode: false });
  const peers = rows.filter((row) => effectiveWorkDir(row.slug, { ...row.meta, cleanMode: false }) === cwd);
  const preferred = meta.codeChannel?.originSlug || meta.workspaceOwnerSlug;
  const isRoot = (row) => !row.meta.workspaceOwnerSlug || !peers.some((parent) => parent.slug === row.meta.workspaceOwnerSlug);
  const owner = peers.find((row) => row.slug === preferred && isRoot(row))
    || peers.find((row) => isRoot(row) && !row.meta.codeChannel)
    || peers[0];
  const next = { ...meta };
  delete next.workspaceLink;
  if (!owner || owner.slug === slug) {
    if (next.isDM && next.workspaceOwnerSlug) next.template = "custom";
    delete next.workspaceOwnerSlug;
    return next;
  }
  const setup = workspaceSetup(owner.meta);
  for (const field of WORKSPACE_FIELDS) {
    if (Object.hasOwn(setup, field)) next[field] = setup[field];
    else delete next[field];
  }
  next.workspaceOwnerSlug = owner.slug;
  next.workspacePolicyIsDM = owner.meta.workspacePolicyIsDM ?? Boolean(owner.meta.isDM || owner.meta.type === "im");
  next.workspaceLink = { slug: owner.slug, channelId: owner.meta.channelId, name: owner.meta.name || owner.slug,
    platform: owner.meta.platform, isDM: owner.meta.workspacePolicyIsDM ?? Boolean(owner.meta.isDM || owner.meta.type === "im"), fields: WORKSPACE_FIELDS };
  return next;
}
