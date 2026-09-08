// A closed, exact action: no model continuation or arbitrary tool replay is needed after a
// restart. The protected approval row holds the rule; listing surfaces expose only its preview.
import { getChannelEntry, getChannelMeta, isAdmin, isApproved } from "../config/store.js";
import { isAuthorized } from "./modes.js";
import { channelInstructionsSnapshot, effectiveWorkDir, updateChannelInstructions } from "./folders.js";

export const INSTRUCTION_ACTION = "channel_instructions";
// Leave room for the operation label within the 2800-character approval preview. Every byte of
// the proposed rule must be reviewable; larger edits should be split into separately approved rules.
export const MAX_APPROVED_INSTRUCTION_LENGTH = 2400;

async function authorizedTarget({ channelId, slug, authorId, mode }) {
  const entry = await getChannelEntry(channelId);
  const meta = await getChannelMeta(slug);
  if (!entry || entry.slug !== slug || !meta || (meta.channelId && meta.channelId !== channelId)) {
    throw new Error("The approval's channel no longer matches its original destination.");
  }
  const admin = await isAdmin(authorId);
  if (!isAuthorized(meta, authorId, Boolean(entry.isDM), { isAdminUser: admin, isApprovedUser: await isApproved(authorId) })) {
    throw new Error("The requester is no longer authorized in this channel.");
  }
  if (mode === "replace" && !admin) throw new Error("Only admins can replace the whole channel instructions.");
  return meta;
}

export async function prepareInstructionApproval(ctx, args = {}) {
  const text = String(args.text || "").trim();
  const mode = args.mode || "append";
  if (!["append", "replace"].includes(mode)) throw new Error("Unknown instruction update mode.");
  if (!text) throw new Error("Nothing to add — pass the rule text.");
  if (text.length > MAX_APPROVED_INSTRUCTION_LENGTH || text.includes("```")) {
    throw new Error("The exact rule must fit in the approval card: use at most 2400 characters without triple-backtick fences, or split it into smaller rules.");
  }
  const identity = { channelId: ctx.channelId, slug: ctx.slug, authorId: ctx.createdBy, threadKey: ctx.threadKey, mode };
  const meta = await authorizedTarget(identity);
  const snapshot = await channelInstructionsSnapshot(identity.slug, meta);
  return { kind: INSTRUCTION_ACTION, ...identity, text, workDir: snapshot.cwd, fingerprint: snapshot.fingerprint };
}

export async function executeInstructionApproval(record) {
  const action = record?.action;
  try {
    if (record?.status !== "executing" || action?.kind !== INSTRUCTION_ACTION ||
        action.channelId !== record.channelId || action.slug !== record.slug || action.authorId !== record.authorId ||
        !["append", "replace"].includes(action.mode) || !action.text || !action.fingerprint || !action.workDir) {
      throw new Error("Invalid saved instruction approval.");
    }
    const meta = await authorizedTarget(action);
    if (effectiveWorkDir(action.slug, meta) !== action.workDir) {
      throw new Error("The channel working folder changed while approval was pending. Submit a fresh request.");
    }
    // Recheck the human factor too. The original author being eligible to click an old card is
    // not evidence that they still have access or still hold replacement authority today.
    // The authenticated admin router owns the reserved "admin UI" principal. A bearer-link
    // decision is bound to the requester and its route revalidates that requester on every POST.
    if (record.decidedBy !== "admin UI") {
      await authorizedTarget({ ...action, authorId: record.decidedBy === "link" ? action.authorId : record.decidedBy });
    }
    await updateChannelInstructions(action.slug, meta, {
      text: action.text, replace: action.mode === "replace", expectedFingerprint: action.fingerprint,
    });
    return { ok: true, completed: true, label: "channel instructions", message: `${action.mode === "replace" ? "Replaced" : "Added to"} this channel's standing instructions. Every new session starts with them.` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
