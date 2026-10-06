#!/usr/bin/env node
// Runs in an independent systemd user service. Environment values arrive on a private stdin
// pipe instead of becoming visible in ExecStart, systemd unit properties, or temporary files.
// Apply them before importing the updater and its runtime-path modules.
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export async function launchUpdate({ input = process.stdin, env = process.env, run } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 4 * 1024 * 1024) throw new Error("update launch environment is too large");
    chunks.push(Buffer.from(chunk));
  }
  const inherited = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!inherited || typeof inherited !== "object" || Array.isArray(inherited)
      || !inherited.CG_UPDATE_OWNER_TOKEN || !inherited.CHANNELGATE_DIR
      || Object.values(inherited).some((value) => typeof value !== "string")) {
    throw new Error("update launch environment is invalid");
  }
  // Replace rather than merge: user-manager defaults must not change this install's identity.
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, inherited);
  if (run) return run();
  // The managed button runs the same host Bash entry point as npm run update.
  // Keep the daemon's Node directory available even when systemd has a minimal PATH.
  env.PATH = `${path.dirname(process.execPath)}:${env.PATH || "/usr/local/bin:/usr/bin:/bin"}`;
  const script = fileURLToPath(new URL("./update.sh", import.meta.url));
  return runUpdateShell({ script, args: process.argv.slice(2), env });
}

export function runUpdateShell({ script, args = [], env = process.env, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("bash", [script, ...args], { cwd: path.dirname(path.dirname(script)), env, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) return reject(new Error("Update shell was interrupted"));
      process.exitCode = code ?? 1;
      resolve(code ?? 1);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  launchUpdate().catch(() => {
    // A malformed JSON payload may contain credentials. Never print the parsing error/payload.
    console.error("Update service could not load its launch environment or start the runner; check the transaction status.");
    process.exitCode = 1;
  });
}
