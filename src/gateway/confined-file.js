// Open ONE file inside a channel's working folder, proven to still be inside it at open time.
//
// `resolveVisiblePath` confines a relative path lexically and by realpath, but it proves the
// candidate at LOOKUP time. Between that lookup and the open, the folder is writable by the
// channel's own container — a turn (or injected content steering one) can swap the resolved name
// for a symlink pointing at the operator's home, and the daemon, which runs unsandboxed, would
// read through it. This closes that race the way the Slack file-download router always has:
// O_NOFOLLOW on the open, then re-resolve the descriptor through /proc/self/fd and require the
// real path to still be under the channel root.
//
// Every caller here hands bytes to something OUTSIDE the gateway — a browser download, a public
// link fetch, a Composio upload — so the posture is deliberately the strict one: a symlink at the
// final component is refused outright rather than followed and re-checked. Internal symlinks stay
// browsable and readable through the ordinary workspace tools; they are simply not exportable.
//
// The caller owns the returned handle and must close it (or hand it to a stream with autoClose).
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

import { resolveVisiblePath } from "../slack/file-explorer.js";

export function isWithin(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export async function openConfinedFile(root, relative) {
  const target = await resolveVisiblePath(root, relative, { kind: "file" });
  const handle = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [openedReal, stat] = await Promise.all([
      realpath(`/proc/self/fd/${handle.fd}`),
      handle.stat(),
    ]);
    if (!stat.isFile() || !isWithin(target.rootReal, openedReal)) {
      throw new Error("That file moved outside this channel's working folder.");
    }
    return { handle, stat, relative: target.relative, name: path.basename(target.relative), realPath: openedReal };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
