import { spawn } from "node:child_process";
import { createEditorLease } from "./editor-lease.js";


export function vscodeAttachedContainerUri(container, workDir) {
  const authority = Buffer.from(String(container), "utf8").toString("hex");
  const pathname = String(workDir || "/home/agent").startsWith("/") ? String(workDir || "/home/agent") : `/${workDir}`;
  return `vscode-remote://attached-container+${authority}${encodeURI(pathname)}`;
}

function run(bin, args, { input = "", env = process.env, stdio = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: stdio || (input ? ["pipe", "inherit", "inherit"] : "inherit") });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${bin} ${args[0] || ""} ${signal ? `was killed by ${signal}` : `exited ${code}`}`)));
    if (input) child.stdin.end(input);
  });
}

// Editor terminals use their own native CLI authentication. The gateway never stages a host
// token into an agent-writable directory and never installs a token-reading CLI wrapper.
export async function launchVscodeContainer(target, {
  cliBin,
  codeBin = "code",
  runCommand = run,
} = {}) {
  if (!cliBin) throw new Error("container CLI is unavailable");
  const lease = createEditorLease(target);
  try {
    const uri = vscodeAttachedContainerUri(target.container.name, target.workDir);
    await runCommand(codeBin, ["--wait", "--folder-uri", uri]);
    return { uri, auth: { source: "container-login" } };
  } finally {
    lease.release();
  }
}
