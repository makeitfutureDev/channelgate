#!/usr/bin/env node
// Launch a local stdio MCP with one credential sourced from a 0600 daemon-root bundle. The parent
// engine sees only the bundle path and logical key; the credential exists only in the MCP server's
// environment, never in Codex argv or env. This is intentionally restricted to Node MCP scripts.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { buildChildEnv } from "../engines/child-env.js";

const [bundlePath, secretName, envName, scriptPath, ...scriptArgs] = process.argv.slice(2);
if (!bundlePath || !/^[A-Za-z][A-Za-z0-9]{0,80}$/.test(secretName || "") || !/^[A-Z][A-Z0-9_]{1,80}$/.test(envName || "") || !scriptPath?.endsWith(".js")) {
  process.stderr.write("Invalid local MCP broker configuration\n");
  process.exit(2);
}

let bundle;
try {
  bundle = JSON.parse(await readFile(bundlePath, "utf8"));
} catch {
  process.stderr.write("Local MCP credential is unavailable\n");
  process.exit(2);
}
const secret = Object.prototype.hasOwnProperty.call(bundle, secretName) ? bundle[secretName] : "";
if (typeof secret !== "string" || !secret) {
  process.stderr.write("Local MCP credential is unavailable\n");
  process.exit(2);
}

const contextNames = ["CG_ENGINE", "CG_FS_ROOT", "CG_WORKSPACE_DIR", "CHANNELGATE_DIR", "CLAUDE_GATEWAY_DIR", "PATH", "CG_PROGRESS_REPORT"];
const context = Object.fromEntries(contextNames.filter((name) => typeof process.env[name] === "string").map((name) => [name, process.env[name]]));
const child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
  env: buildChildEnv({ ...context, [envName]: secret }),
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", () => process.exit(1));
child.on("close", (code, signal) => {
  if (signal) {
    // Re-raise with the default disposition. The forwarding handlers above stay installed for
    // the child's lifetime — left in place they would CATCH this very re-raise (a no-op kill of
    // a dead child) and the still-registered listeners would keep the event loop alive, leaving
    // a secret-holding broker process stranded until daemon restart.
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeAllListeners(s);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
