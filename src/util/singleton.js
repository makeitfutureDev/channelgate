import { mkdirSync, openSync, readFileSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function readLock(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const pid = Number(data.pid);
    return { pid: Number.isInteger(pid) ? pid : 0, token: String(data.token || "") };
  } catch {
    return { pid: 0, token: "" };
  }
}

export function acquireSingletonLock(root) {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, "gateway.lock");
  const token = randomUUID();

  for (;;) {
    let fd;
    try {
      fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }) + "\n");
      closeSync(fd);
      break;
    } catch (e) {
      if (fd) {
        try {
          closeSync(fd);
        } catch {
          /* best effort */
        }
      }
      if (e?.code !== "EEXIST") throw e;
      const current = readLock(file);
      if (pidAlive(current.pid)) {
        const err = new Error(`another gateway daemon is already running (pid ${current.pid})`);
        err.code = "EALREADYRUNNING";
        throw err;
      }
      try {
        unlinkSync(file);
      } catch (unlinkErr) {
        if (unlinkErr?.code !== "ENOENT") throw unlinkErr;
      }
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const current = readLock(file);
    if (current.pid !== process.pid || current.token !== token) return;
    try {
      unlinkSync(file);
    } catch {
      /* best effort */
    }
  };
  process.once("exit", release);
  return { file, release };
}
