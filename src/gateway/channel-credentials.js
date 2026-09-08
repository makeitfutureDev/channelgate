import { safeSpawnEnv } from "../config/channel-env.js";

// Describe the SAME resolved environment the runners receive, never the stored metadata or the
// daemon's process.env. Rebuild per turn so a resumed conversation cannot retain a revoked name.
export function channelCredentialsPreamble(resolved = {}, { clean = false } = {}) {
  if (clean) return "";
  const names = Object.keys(safeSpawnEnv(resolved)).sort();
  return "[Channel credentials for THIS attempt]\n"
    + `Available channel environment variable names: ${JSON.stringify(names)}.\n`
    + "This inventory replaces earlier turns' channel credential inventories. It lists only variables injected into this run; an empty list means none were injected, not that all CLI logins or MCP connections are absent.\n"
    + "Before declaring missing access or requesting a new connection, check relevant names here alongside task skills, existing CLI authentication and MCP tools. These channel-scoped variables are usable from the process environment for authorized API/CLI calls; they are not a project .env file. Some clients require explicitly passing the variable.\n"
    + "A variable name does not prove its account, permissions or validity. Preserve the requested account; ask when identity is ambiguous and never silently substitute a channel credential for a personal connection. Respect this run's tool and network permissions.\n"
    + "Check presence without printing values. Never dump the environment, print credentials, or copy them into files, replies or memory.\n"
    + "[End channel credentials]\n\n";
}
