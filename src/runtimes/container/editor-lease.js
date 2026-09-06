// Durable editor leases live only in daemon-owned state. Never scan or delete files through
// a directory mounted into a channel: signed record contents cannot authenticate a pathname.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gatewayRoot } from "../../config/paths.js";

const KEY_FILE = "editor-lease.key";
const LEASE_DIR = "editor-leases";

function leaseKey() {
  const file = path.join(gatewayRoot(), "config", KEY_FILE);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    try { writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  return readFileSync(file, "utf8").trim();
}

function procStart(pid) {
  try {
    // Linux /proc stat: field 22. The command name may contain spaces and parentheses, hence the
    // last ')' boundary rather than a whitespace split over the complete line.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] || "";
  } catch {
    return "";
  }
}

function payload(record) {
  return [record.id, record.pid, record.procStart, record.container, record.slug, record.createdAt].join("\n");
}

function signature(record) {
  return createHmac("sha256", leaseKey()).update(payload(record)).digest("hex");
}

function valid(record, target) {
  if (!record || record.container !== target?.container?.name || record.slug !== target?.slug) return false;
  if (!Number.isSafeInteger(record.pid) || record.pid <= 1 || !record.procStart || procStart(record.pid) !== record.procStart) return false;
  const expected = Buffer.from(signature(record));
  const actual = Buffer.from(String(record.signature || ""));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function editorLeaseDir(target) {
  if (!target?.container?.name) return "";
  const key = createHash("sha256").update(target.container.name).digest("hex");
  return path.join(gatewayRoot(), "runtime", LEASE_DIR, key);
}

export function createEditorLease(target, { pid = process.pid, now = Date.now } = {}) {
  const dir = editorLeaseDir(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = {
    id: randomUUID(), pid, procStart: procStart(pid), container: target.container.name,
    slug: target.slug, createdAt: new Date(now()).toISOString(),
  };
  if (!record.procStart) throw new Error(`cannot identify editor helper process ${pid}`);
  record.signature = signature(record);
  const file = path.join(dir, `${record.id}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
  let released = false;
  return {
    record,
    release() {
      if (released) return;
      released = true;
      rmSync(file, { force: true });
    },
  };
}

export function activeEditorLeases(target) {
  const dir = editorLeaseDir(target);
  if (!dir) return [];
  let names = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith(".json")); } catch { return []; }
  const active = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const record = JSON.parse(readFileSync(file, "utf8"));
      if (valid(record, target)) active.push(record);
      else rmSync(file, { force: true });
    } catch {
      rmSync(file, { force: true });
    }
  }
  return active;
}
