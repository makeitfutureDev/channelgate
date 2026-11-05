#!/usr/bin/env node
// Run as the final service identity, never as root writing through service-owned paths.
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const MARKER = "# Managed by ChannelGate system-service installer";
export function configureServicePodman(home) {
  if (!path.isAbsolute(home || "")) throw new Error("service HOME must be absolute");
  const base = path.resolve(home);
  const dir = (relative) => {
    let current = base;
    for (const name of ["", ...relative.split("/")]) {
      if (name) current = path.join(current, name);
      try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`refusing a non-directory or symlink: ${current}`);
    }
    return current;
  };
  const configDir = dir(".config/containers/containers.conf.d");
  const configFile = path.join(configDir, "99-channelgate-system-service.conf");
  try {
    const stat = lstatSync(configFile);
    if (!stat.isFile() || stat.isSymbolicLink() || !readFileSync(configFile, "utf8").startsWith(MARKER)) {
      throw new Error("refusing to replace an unmanaged service Podman configuration");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = path.join(configDir, `.channelgate-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${MARKER}\n# Keep rootless container exec inside the system unit's delegated cgroup.\n[engine]\ncgroup_manager = "cgroupfs"\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, configFile);
  } finally { rmSync(temporary, { force: true }); }
  // These back /tmp and /var/tmp inside the unit; unlike PrivateTmp they survive restarts
  // while Podman's rootless pause process retains its mount namespace.
  const tempDir = dir("service-tmp");
  const varTmpDir = dir("service-var-tmp");
  chmodSync(tempDir, 0o700);
  chmodSync(varTmpDir, 0o700);
  return { configFile, tempDir, varTmpDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { configureServicePodman(process.argv[2]); }
  catch (error) { console.error(`[service-podman] ${error.message}`); process.exitCode = 1; }
}
