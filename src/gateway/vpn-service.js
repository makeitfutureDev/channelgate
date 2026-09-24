// Operator-managed services. Deliberately independent of the engine container lifecycle:
// cg.service.* labels keep these containers out of the ordinary idle reaper and cg-sweep.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink, readdir } from "node:fs/promises";
import path from "node:path";

export const VPN_IMAGE = "localhost/channelgate/vpn:2";
export const VPN_SERVICE_VERSION = "2";
export const VPN_QUERY_OUTPUT_LIMIT = 256 * 1024 + 1024;

// The operator image is a separate contract from ordinary agent images. Refuse a stale build.
export async function vpnImageDigest(dir) {
  const hash = createHash("sha256");
  for (const entry of (await readdir(dir, {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || /^(test|live_)/.test(entry.name)) continue;
    hash.update(entry.name + "\0");
    hash.update(await readPrivate(path.join(dir,entry.name),{maxBytes:1024*1024}));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function requireVpnImage(imageDir, run = runCommand) {
  const result = await run("/usr/bin/podman",["image","inspect",VPN_IMAGE],{timeoutMs:15_000});
  let image;
  try { image = JSON.parse(result.stdout)[0]; } catch { /* fixed remedy below */ }
  if (result.code !== 0 || !image || !/^(sha256:)?[a-f0-9]{64}$/.test(image.Id || "") ||
      image.Config?.Labels?.["cg.vpn.version"] !== VPN_SERVICE_VERSION ||
      image.Config?.Labels?.["cg.vpn.digest"] !== await vpnImageDigest(imageDir)) {
    throw Object.assign(new Error("Build the current OpenVPN 3 service image with npm run vpn -- build --channel ID before enabling it."),{vpnErrorClass:"upgrade_required"});
  }
  return image.Id;
}

export const SERVICE_LABEL = "cg.service.owner";
export const SECRET_REFS = Object.freeze({ vpnUsername: "VPN_USERNAME", vpnPassword: "VPN_PASSWORD", mysqlUsername: "MYSQL_USERNAME", mysqlPassword: "MYSQL_PASSWORD" });

// Only these fixed diagnostics may leave the host. Provider logs never ride status responses.
const VPN_FAILURES = Object.freeze({
  server_certificate_usage: "The VPN server certificate is missing the required Key Usage extension. Ask the VPN administrator to correct its certificate.",
  server_certificate_invalid: "The VPN server certificate could not be verified. Check the server certificate and supplied profile.",
  authentication_failed: "VPN authentication failed. Check this channel's VPN credentials.",
  tls_failed: "VPN TLS negotiation failed. Check the server certificate and profile compatibility.",
  network_disabled: "VPN stopped because Network is disabled for this channel.",
  upgrade_required: "VPN needs its current OpenVPN 3 image and supervisor. Ask an administrator to build the image, then turn VPN off and on.",
  startup_failed: "VPN did not become ready. Check credentials, server compatibility and the database route.",
  connection_lost: "VPN lost its route or service container and was stopped. Check the connection before restarting.",
});
export function isVpnFailureClass(code) {
  return typeof code === "string" && Object.hasOwn(VPN_FAILURES,code);
}
export function vpnFailureMessage(code) {
  return Object.hasOwn(VPN_FAILURES,code) ? VPN_FAILURES[code] : VPN_FAILURES.startup_failed;
}
export function classifyVpnFailure(logs = "") {
  if (/"errorClass"\s*:\s*"authentication_failed"/.test(logs)) return "authentication_failed";
  if (/"errorClass"\s*:\s*"server_certificate_invalid"/.test(logs)) return "server_certificate_invalid";
  if (/"errorClass"\s*:\s*"server_certificate_usage"/.test(logs)) return "server_certificate_usage";
  if (/"errorClass"\s*:\s*"tls_failed"/.test(logs)) return "tls_failed";
  if (/VERIFY KU ERROR|Certificate does not have key usage extension/.test(logs)) return "server_certificate_usage";
  if (/VERIFY ERROR|certificate verify failed/.test(logs)) return "server_certificate_invalid";
  if (/AUTH_FAILED/.test(logs)) return "authentication_failed";
  if (/TLS Error|TLS handshake failed/.test(logs)) return "tls_failed";
  return "startup_failed";
}
export function vpnUnitStatus(stdout = "", runtime = {}, last = {}, available = true) {
  const fields = Object.fromEntries(stdout.split(/\r?\n/).filter(line => line.includes("=")).map(line => {
    const i = line.indexOf("="); return [line.slice(0,i),line.slice(i+1)];
  }));
  const installed = fields.LoadState === "loaded";
  const enabled = ["enabled", "enabled-runtime"].includes(fields.UnitFileState);
  const legacy = [runtime.vpn,runtime.extractor].some(item => item?.state === "running" && item.version !== undefined && item.version !== VPN_SERVICE_VERSION);
  let state = "off";
  if (fields.ActiveState === "failed") state = "failed";
  else if (fields.ActiveState === "deactivating") state = "stopping";
  else if (["active","activating","reloading"].includes(fields.ActiveState)) {
    state = runtime.vpn?.state === "running" && runtime.extractor?.state === "running" && runtime.ready === true ? "on" : last.state === "on" ? "failed" : "starting";
  } else if (runtime.vpn?.state === "running" || runtime.extractor?.state === "running") state = "failed";
  if (legacy) state = "failed";
  return { available, installed, enabled, running: [runtime.vpn, runtime.extractor].some(item => item?.state && item.state !== "absent"), state,
    errorClass: legacy ? "upgrade_required" : state === "failed" && Object.hasOwn(VPN_FAILURES,last.errorClass) ? last.errorClass : state === "failed" ? last.state === "on" ? "connection_lost" : "startup_failed" : null };
}

// Stop the supervisor first, then acquire the ordinary operation lock through the helper.
// This also removes a pair created by the supported manual `start` command.
export async function disableVpnUnit({ unit, stopArgs, run = runCommand }) {
  const disabled = await run("/usr/bin/systemctl", ["--user", "disable", "--now", unit], { timeoutMs: 210_000 });
  if (disabled.code !== 0) throw new Error("Service disable failed; check its status.");
  const stopped = await run(process.execPath, stopArgs, { timeoutMs: 120_000 });
  if (stopped.code !== 0) throw new Error("VPN containers could not be stopped; refresh status before retrying.");
}

export function serviceIdentity(root, channelId, project) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(project)) throw new Error("Project must be a lowercase name of at most 48 characters.");
  const owner = createHash("sha256").update(`${root}\0${channelId}`).digest("hex").slice(0,24);
  return { owner, vpn: `${project}-vpn`, extractor: `${project}-extractor`, unit: `channelgate-vpn-${owner}.service` };
}

// Paths are selected by the operator. Refuse symlinks, including parent components, rather than
// letting an agent's uploaded profile redirect a privileged file read.
export async function plainPath(file) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Service paths must not contain symbolic links.");
  }
  return absolute;
}

export async function readPrivate(file, { maxBytes = 256 * 1024, tighten = false } = {}) {
  // Pin directories while walking. O_NOFOLLOW on just the leaf does not stop a writable upload
  // parent being swapped for a symlink between lstat and open.
  const parts = path.resolve(file).split(path.sep).filter(Boolean);
  const parents = [await open(path.parse(path.resolve(file)).root,constants.O_RDONLY | constants.O_DIRECTORY)];
  let handle;
  try {
    for (const segment of parts.slice(0,-1)) {
      parents.push(await open(`/proc/self/fd/${parents.at(-1).fd}/${segment}`,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    }
    handle = await open(`/proc/self/fd/${parents.at(-1).fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("Expected a bounded regular service file.");
    if (tighten && (info.uid !== process.getuid() || info.nlink !== 1)) throw new Error("Imported profile must have one link and belong to the operator.");
    if (tighten) await handle.chmod(0o600);
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const {bytesRead} = await handle.read(buffer,total,buffer.length-total,null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error("Service file exceeds the size limit.");
    return buffer.subarray(0,total).toString("utf8");
  } catch (error) {
    if (["ELOOP","ENOTDIR"].includes(error.code)) throw new Error("Service paths must not contain symbolic links.");
    throw error;
  } finally { await handle?.close(); for (const parent of parents.reverse()) await parent.close(); }
}

export async function privateDirectory(dir) {
  // The gateway root already belongs to the operator. Every newly created descendant is private.
  const absolute = path.resolve(dir);
  const parent = path.dirname(absolute);
  if (parent !== absolute) {
    try { await plainPath(parent); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await privateDirectory(parent);
    }
  }
  await mkdir(absolute, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  await plainPath(absolute);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.uid !== process.getuid()) throw new Error("Service directory must belong to the current operator.");
  await chmod(absolute, 0o700);
  return realpath(absolute);
}

export async function writePrivate(file, content, mode = 0o600) {
  await plainPath(path.dirname(file));
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(content); } finally { await handle.close(); }
  try { await rename(temp, file); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

export function selectedCredentials(env, refs = SECRET_REFS) {
  const selected = {};
  const missing = [];
  for (const [role, name] of Object.entries(SECRET_REFS)) {
    const ref = refs[role] || name;
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(ref)) throw new Error("Invalid service secret reference.");
    const value = env[ref];
    if (typeof value !== "string" || !value) missing.push(ref);
    else if (/[\r\n\0]/.test(value)) throw new Error(`Secret ${ref} contains an unsupported line break.`);
    else selected[role] = value;
  }
  return { selected, missing };
}

export function serviceFingerprint(config, credentials, imageId, salt) {
  // HMAC prevents the public container label becoming an offline password-guessing oracle.
  return createHmac("sha256", salt).update(JSON.stringify({ config, credentials, imageId })).digest("hex");
}

export function vpnEnableRestartRequired(runtime, { fingerprint, imageId, unitChanged = false, unitWasActive = false } = {}) {
  // An inactive unit will be started by `enable --now` and its supervisor performs the same
  // fingerprint comparison. An already active unit needs an explicit restart because Restart=no
  // otherwise leaves changed credentials/profile/image (or a missing pair) untouched.
  if (!unitWasActive) return false;
  if (unitChanged) return true;
  return [runtime?.vpn, runtime?.extractor].some(item =>
    item?.state !== "running" || item.version !== VPN_SERVICE_VERSION ||
    item.imageId !== imageId || item.fingerprint !== fingerprint);
}

export function createArgs({ identity, config, serviceDir, imageId, fingerprint, vpnId = "" }, role) {
  if (!["vpn", "extractor"].includes(role)) throw new Error("Unknown service role.");
  const args = ["run", "-d", "--name", identity[role], "--label", `${SERVICE_LABEL}=${identity.owner}`,
    "--label", `cg.service.role=${role}`, "--label", `cg.service.version=${VPN_SERVICE_VERSION}`, "--label", `cg.service.fingerprint=${fingerprint}`,
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", "--pids-limit=128", "--memory=256m",
    "--tmpfs=/run:rw,noexec,nosuid,size=16m", "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
    "--log-driver=k8s-file", "--log-opt=max-size=2mb", "--restart=no",
    "-e", `DB_HOST=${config.dbHost}`, "-e", `DB_PORT=${config.dbPort}`];
  if (role === "vpn") args.push("--network=slirp4netns:allow_host_loopback=false",
    ...["NET_ADMIN","SETUID","SETGID","SETPCAP","DAC_OVERRIDE","CHOWN"].map(cap => `--cap-add=${cap}`),
    "--tmpfs=/var/lib/openvpn3:rw,noexec,nosuid,size=16m", "--device=/dev/net/tun",
    "--volume", `${path.join(serviceDir,"client.ovpn")}:/vpn/client.ovpn:ro`,
    "--volume", `${path.join(serviceDir,"auth")}:/vpn/auth:ro`,
    "--health-cmd=/usr/local/bin/cg-vpn-health", "--health-interval=30s", "--health-timeout=8s", "--health-retries=3", "--health-start-period=60s");
  else {
    if (!/^[a-f0-9]{12,64}$/.test(vpnId)) throw new Error("Extractor requires the verified VPN container id.");
    args.push(`--network=container:${vpnId}`, "--health-cmd=none", "--volume", `${path.join(serviceDir,"credentials.json")}:/db/credentials.json:ro`, "--entrypoint=/usr/bin/tini");
  }
  args.push(imageId);
  if (role === "extractor") args.push("--", "sleep", "infinity");
  return args;
}

export function runCommand(bin, args, { timeoutMs = 120_000, input, cwd, env = process.env, maxOutputBytes = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0, overflow = false;
    const collect = (key, chunk) => {
      bytes += chunk.length;
      if (maxOutputBytes !== null && bytes > maxOutputBytes) {
        overflow = true; child.kill("SIGKILL"); return;
      }
      if (key === "stdout") stdout = (stdout + chunk).slice(-1024 * 1024);
      else stderr = (stderr + chunk).slice(-1024 * 1024);
    };
    child.stdout.on("data", chunk => collect("stdout",chunk));
    child.stderr.on("data", chunk => collect("stderr",chunk));
    let forceTimer;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forceTimer = setTimeout(()=>child.kill("SIGKILL"),2000);
    }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); clearTimeout(forceTimer); reject(new Error(`Unable to execute ${path.basename(bin)}.`)); });
    child.on("close", code => { clearTimeout(timer); clearTimeout(forceTimer); if (overflow) reject(new Error("Service response exceeded its output limit.")); else resolve({ code, stdout, stderr }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function createVpnService({ run = runCommand, bin = "/usr/bin/podman", identity, serviceDir, config, imageId }) {
  const podman = (args, opts) => run(bin, args, {timeoutMs:15_000,...opts});
  async function inspect(role) {
    const exists = await podman(["container", "exists", identity[role]]);
    if (exists.code === 1) return null;
    if (exists.code !== 0) throw new Error("Could not inspect Podman service containers.");
    const result = await podman(["inspect", identity[role]]);
    if (result.code !== 0) throw new Error("Service container inspection failed.");
    const data = JSON.parse(result.stdout)[0];
    if (data?.Config?.Labels?.[SERVICE_LABEL] !== identity.owner || data?.Config?.Labels?.["cg.service.role"] !== role) {
      throw new Error("Container name belongs to another workload; refusing to change it.");
    }
    return data;
  }
  async function stop() {
    // Prove ownership of BOTH names before touching either one.
    const vpn = await inspect("vpn"), extractor = await inspect("extractor");
    for (const data of [extractor, vpn]) if (data) {
      const result = await podman(["rm", "--force", data.Id]);
      if (result.code !== 0) throw new Error("Could not stop this service's container.");
    }
  }
  async function ready() {
    const result = await podman(["exec", identity.vpn, "/usr/local/bin/cg-vpn-health"]);
    return result.code === 0;
  }
  async function routesReady() {
    const result = await podman(["exec",identity.extractor,"/usr/local/bin/cg-vpn-routes"]);
    return result.code === 0;
  }
  async function start({ fingerprint, auth, database, profile, attempts = 65, signal, wait = ms => new Promise(resolve => setTimeout(resolve,ms)) }) {
    const vpn = await inspect("vpn"), extractor = await inspect("extractor");
    if (vpn?.State?.Running && extractor?.State?.Running &&
        [vpn, extractor].every(item => item.Config.Labels["cg.service.fingerprint"] === fingerprint) && await ready() && await routesReady()) return { reused: true };
    await stop();
    await writePrivate(path.join(serviceDir,"client.ovpn"), profile);
    await writePrivate(path.join(serviceDir,"auth"), auth);
    await writePrivate(path.join(serviceDir,"credentials.json"), JSON.stringify(database));
    try {
      const result = await podman(createArgs({ identity, config, serviceDir, imageId, fingerprint }, "vpn"));
      if (result.code !== 0) throw new Error("VPN container could not start; check rootless TUN support.");
      let healthy = false;
      for (let n=0; n<attempts; n++) {
        if (signal?.aborted) throw new Error("VPN startup cancelled.");
        if (await ready()) { healthy = true; break; }
        const state = await inspect("vpn");
        if (!state?.State?.Running) break;
        await wait(2000);
      }
      if (!healthy) {
        const logs = await podman(["logs","--tail","80",identity.vpn]).catch(() => ({ stdout:"", stderr:"" }));
        const errorClass = classifyVpnFailure(`${logs.stdout || ""}\n${logs.stderr || ""}`);
        throw Object.assign(new Error(vpnFailureMessage(errorClass)), { vpnErrorClass:errorClass });
      }
      const state = await inspect("vpn");
      const extracted = await podman(createArgs({ identity, config, serviceDir, imageId, fingerprint, vpnId: state.Id }, "extractor"));
      if (extracted.code !== 0) throw new Error("Isolated extractor could not start.");
      return { reused: false };
    } catch (error) { await stop(); throw error; }
  }
  async function status() {
    const out = {};
    for (const role of ["vpn", "extractor"]) {
      const data = await inspect(role);
      out[role] = { name: identity[role], state: data?.State?.Status || "absent", health: data?.State?.Health?.Status || "unknown", version: data?.Config?.Labels?.["cg.service.version"] || "1", imageId: data?.Image || "", fingerprint: data?.Config?.Labels?.["cg.service.fingerprint"] || "" };
    }
    return out;
  }
  async function verify() {
    const vpn = await inspect("vpn"), extractor = await inspect("extractor");
    if (!vpn?.State?.Running || !extractor?.State?.Running || !await ready()) throw new Error("VPN and extractor must both be running and ready.");
    if (extractor.HostConfig.NetworkMode !== `container:${vpn.Id}`) throw new Error("Extractor network namespace mismatch.");
    const result = await podman(["exec", identity.extractor, "/usr/local/bin/cg-vpn-verify"]);
    if (result.code !== 0) throw new Error("Read-only database verification failed; inspect the service status and credentials.");
    return JSON.parse(result.stdout);
  }
  async function query(request, { beforeExecute = async () => true } = {}) {
    // These are the only failure classes emitted by the reviewed extractor protocol. Returning a
    // validated two-field failure lets the fixed outer helper preserve a useful classification;
    // unknown classes or detail-bearing objects stay behind the generic service error boundary.
    const safeErrorClasses = new Set([
      "invalid_request", "request_too_large", "invalid_operation", "invalid_database", "invalid_table",
      "invalid_columns", "invalid_column", "invalid_filters", "invalid_filter_column", "invalid_filter_value",
      "invalid_order", "invalid_order_column", "invalid_limit", "invalid_database_host", "invalid_database_port",
      "route_not_ready", "database_route_not_tunnel", "public_default_route_changed",
      "database_credentials_unavailable", "invalid_database_credentials", "invalid_database_credentials_file",
      "database_authentication_failed", "database_access_denied", "database_not_found", "table_not_found",
      "column_not_found", "table_metadata_too_large", "query_timed_out", "statement_timeout_unavailable",
      "database_connection_or_query_failed", "database_query_failed", "result_too_large",
    ]);
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 16 * 1024) throw new Error("Database request is too large.");
    const vpn = await inspect("vpn"), extractor = await inspect("extractor");
    if (!vpn?.State?.Running || !extractor?.State?.Running ||
        [vpn,extractor].some(item => item.Config.Labels["cg.service.version"] !== VPN_SERVICE_VERSION) ||
        vpn.Config.Labels["cg.service.fingerprint"] !== extractor.Config.Labels["cg.service.fingerprint"] ||
        extractor.HostConfig.NetworkMode !== `container:${vpn.Id}` || !await ready() || !await routesReady()) {
      throw new Error("The current VPN and database service must both be ready.");
    }
    if (!await beforeExecute()) throw new Error("Database access is no longer allowed.");
    // Pin the inspected ID: a concurrent OFF/recreate cannot redirect this exec to a new name.
    const result = await podman(["exec","-i",extractor.Id,"/usr/bin/timeout","--signal=TERM","--kill-after=2s","20s","/usr/local/bin/cg-vpn-query"],
      { input, timeoutMs:25_000, maxOutputBytes:VPN_QUERY_OUTPUT_LIMIT });
    let data;
    try { data = JSON.parse(result.stdout); } catch { throw new Error("Database query failed."); }
    if (result.code !== 0) {
      if (data?.ok === false && typeof data.errorClass === "string" && safeErrorClasses.has(data.errorClass) &&
          Object.keys(data).length === 2 && Object.hasOwn(data,"ok") && Object.hasOwn(data,"errorClass")) {
        return {ok:false,errorClass:data.errorClass};
      }
      throw new Error("Database query failed. Check its read-only account and requested schema.");
    }
    if (data?.ok !== true) throw new Error("Database query failed. Check its read-only account and requested schema.");
    return data;
  }
  return { start, stop, status, verify, query, inspect, ready, routesReady };
}
