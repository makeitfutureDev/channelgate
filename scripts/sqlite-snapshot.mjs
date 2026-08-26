import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

const [command, source, destination] = process.argv.slice(2);
if (!source || !destination || !["snapshot", "verify"].includes(command)) {
  console.error("usage: sqlite-snapshot.mjs <snapshot|verify> <source.db> <destination.db>");
  process.exit(2);
}

if (command === "snapshot") {
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  chmodSync(destination, 0o600);
}

const candidate = command === "verify" ? source : destination;
const check = new DatabaseSync(candidate, { readOnly: true });
try {
  const row = check.prepare("PRAGMA quick_check").get();
  if (!row || Object.values(row)[0] !== "ok") throw new Error("SQLite quick_check failed");
} finally {
  check.close();
}
