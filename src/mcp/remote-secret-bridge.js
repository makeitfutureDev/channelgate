#!/usr/bin/env node
// Secret-bearing stdio→remote MCP launcher (the "mcp-remote" runtime helper). The engine sees only
// this file's path, the path of the run's 0600 bundle (in the run's artifact dir, which a channel
// container bind-mounts — so readable by any process in that container), and a logical secret
// name. The credential is read only inside this broker and handed to mcp-remote through its
// dedicated environment; it is absent from the engine's argv/env and from the mcp-remote argv
// (`${CG_MCP_REMOTE_HEADER}` is literal).
//
// No engine path launches it today: in a container the header-bearing remotes are relayed by the
// daemon over the control socket (`remote-mcp`, src/mcp/socket-server.js), so the credential never
// enters the container at all, and a sudo-host Codex turn dials them itself with a per-run
// `http_headers_helper` (src/engines/codex.js). It stays in the image's helper table for the image
// contract and for any backend that still bridges a remote this way.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { buildChildEnv } from "../engines/child-env.js";

const [bundlePath, secretName, url, headerName, prefix = ""] = process.argv.slice(2);
if (!bundlePath || !/^[A-Za-z][A-Za-z0-9]{0,80}$/.test(secretName || "") || !/^https:\/\//i.test(url || "") || !/^[A-Za-z0-9-]{1,80}$/.test(headerName || "")) {
  process.stderr.write("Invalid remote MCP broker configuration\n");
  process.exit(2);
}

let bundle;
try {
  bundle = JSON.parse(await readFile(bundlePath, "utf8"));
} catch {
  process.stderr.write("Remote MCP credential is unavailable\n");
  process.exit(2);
}
const secret = Object.prototype.hasOwnProperty.call(bundle, secretName) ? bundle[secretName] : "";
if (typeof secret !== "string" || !secret) {
  process.stderr.write("Remote MCP credential is unavailable\n");
  process.exit(2);
}

// Prefer the PINNED local mcp-remote (a real dependency): `npx -y` resolved it from the npm
// registry on cold spawns — a network fetch, and racy when several bridges start at once — which
// intermittently blew Codex's MCP startup window and silently dropped the server (seen as
// composio-user tools "absent" in background runs). npx remains only as a fallback for a checkout
// whose deps haven't been installed yet.
let proxyBin = "";
try {
  proxyBin = createRequire(import.meta.url).resolve("mcp-remote/dist/proxy.js");
} catch {
  /* dependency missing — fall back to npx below */
}
const proxyArgs = [url, "--header", `${headerName}:\${CG_MCP_REMOTE_HEADER}`];
const child = spawn(proxyBin ? process.execPath : "npx", proxyBin ? [proxyBin, ...proxyArgs] : ["-y", "mcp-remote", ...proxyArgs], {
  env: buildChildEnv({ CG_MCP_REMOTE_HEADER: `${prefix}${secret}` }),
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
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
