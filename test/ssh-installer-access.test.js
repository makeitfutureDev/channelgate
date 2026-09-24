// The SSH access installer must make sure the host's sshd will actually admit the login account.
//
// sshd applies AllowUsers / AllowGroups / DenyUsers / DenyGroups before it looks at any key, and a
// login it refuses there reaches the developer as "Permission denied (publickey)" — the same words
// as a wrong key, with nothing in the daemon log because the forced command never runs. The first
// live install hit exactly this: a hardening file carried `AllowUsers tby management
// channelgate-testing`, the login account was not on it, and every developer was refused.
//
// The static half always runs. The live half runs the REAL installer as root inside a throwaway
// copy of the runtime image (which ships sshd) against six operator configurations, and asks sshd
// itself (`sshd -T -C`) what it would enforce afterwards. Opt in with CG_LIVE_CONTAINER=1.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const installer = readFileSync(new URL("../scripts/install-ssh-access.sh", import.meta.url), "utf8");

test("the installer asks sshd for its EFFECTIVE access lists instead of grepping files", () => {
  // Include order and Match blocks decide what applies; only sshd knows the result.
  assert.match(installer, /sshd_effective\(\)/);
  assert.match(installer, /-T -C "user=\$SSH_USER,host=localhost,addr=127\.0\.0\.1"/);
  for (const keyword of ["denyusers", "denygroups", "allowusers", "allowgroups"]) {
    assert.match(installer, new RegExp(`sshd_effective ${keyword}\\)`), `checks ${keyword}`);
  }
});

test("it appends to an existing allow-list only, and never edits the operator's own file", () => {
  // The guard that stops a host with NO allow-list from having every login restricted to this one
  // account: the append happens only when the effective list is non-empty and excludes it.
  assert.match(installer, /if \[ -n "\$list" \] && ! list_matches "\$list" "\$SSH_USER"; then echo AllowUsers/);
  assert.match(installer, /if \[ -n "\$list" \] && ! list_matches "\$list" "\$\{SSH_USER_GROUPS\[@\]\}"; then echo AllowGroups/);
  // The line goes into the file this script manages, above the Match block so it applies globally.
  assert.match(installer, /write_conf "\$ACCESS_PRELUDE"/);
  assert.match(installer, /\$\{1\}Match User \$SSH_USER/);
  assert.doesNotMatch(installer, /sed -i[^\n]*99-hardening|>>\s*"?\/etc\/ssh\/sshd_config"?/, "never rewrites the operator's own sshd files");
});

test("a deny list stops the install, and a line that did not take effect is not retried forever", () => {
  assert.match(installer, /DenyUsers\|DenyGroups\)\s+echo "❌ sshd's \$blocker excludes \$SSH_USER, and a deny list wins over every allow list/);
  assert.match(installer, /case " \$fixed " in \*" \$blocker "\*\)/);
  assert.match(installer, /did not take effect/);
  // An sshd that cannot be queried is reported, not silently treated as "fine".
  assert.match(installer, /AllowUsers\/AllowGroups were NOT checked/);
});

const live = process.env.CG_LIVE_CONTAINER === "1";
const image = process.env.CG_LIVE_IMAGE || "localhost/channelgate/runtime:latest";

// Runs INSIDE the container as root. Builds a minimal sshd host, writes the operator's
// configuration, runs the real installer twice (the second run proves idempotency), then asks sshd
// what it would enforce for the login account and for an ordinary user.
const HARNESS = String.raw`
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sshd /etc/ssh/sshd_config.d; ssh-keygen -A >/dev/null 2>&1
grep -q '^Include /etc/ssh/sshd_config.d/\*\.conf' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
useradd -m svc; for u in tby management channelgate-testing; do useradd "$u"; done
printf '%b' "$CG_OPERATOR_CONF" > /etc/ssh/sshd_config.d/99-hardening.conf
inst() { CG_SERVICE_USER=svc CG_NODE_BIN="$(command -v node)" CG_SSH_HOST=localhost CG_SSH_PORT=22 bash /app/scripts/install-ssh-access.sh >/tmp/out 2>&1; echo $?; }
eff() { /usr/sbin/sshd -T -C "user=$1,host=localhost,addr=127.0.0.1" 2>/dev/null | awk '/^(allowusers|allowgroups|denyusers|denygroups) /{print $1"="$2}' | sort | tr '\n' ' '; }
first=$(inst)
second=$( [ "$first" = 0 ] && inst || echo skipped )
echo "FIRST=$first"; echo "SECOND=$second"
echo "LOGIN=$(eff channelgate-ssh)"; echo "PERSON=$(eff tby)"
echo "LINES=$(grep -cE '^(AllowUsers|AllowGroups) ' /etc/ssh/sshd_config.d/channelgate.conf 2>/dev/null || echo 0)"
echo "OUTPUT<<"; cat /tmp/out
`;

function runScenario(operatorConf) {
  const result = spawnSync("podman", [
    "run", "--rm", "--user", "root", "-e", `CG_OPERATOR_CONF=${operatorConf}`,
    "-v", `${repo}:/app:ro`, "--entrypoint", "bash", image, "-c", HARNESS,
  ], { encoding: "utf8", timeout: 120_000 });
  const out = `${result.stdout}${result.stderr}`;
  const field = (name) => (new RegExp(`^${name}=(.*)$`, "m").exec(out)?.[1] || "").trim();
  return { out, first: field("FIRST"), second: field("SECOND"), login: field("LOGIN"), person: field("PERSON"), lines: Number(field("LINES")) };
}

test("live: this host's AllowUsers — the account is appended and nobody already allowed loses access", { skip: !live, timeout: 150_000 }, () => {
  const r = runScenario("AllowUsers tby management channelgate-testing\\nPasswordAuthentication no\\n");
  assert.equal(r.first, "0", r.out);
  assert.equal(r.second, "0", `rerun is idempotent\n${r.out}`);
  for (const name of ["tby", "management", "channelgate-testing", "channelgate-ssh"]) {
    assert.match(r.login, new RegExp(`allowusers=${name}(\\s|$)`), `${name} is admitted\n${r.out}`);
  }
  assert.equal(r.lines, 1, "exactly one access line, even after a rerun");
});

test("live: a host with NO allow-list gets no line — adding one would lock every other login out", { skip: !live, timeout: 150_000 }, () => {
  const r = runScenario("PasswordAuthentication no\\n");
  assert.equal(r.first, "0", r.out);
  assert.equal(r.login, "", `no access list is created where none existed\n${r.out}`);
  assert.equal(r.person, "", "an ordinary user stays unrestricted");
  assert.equal(r.lines, 0);
});

test("live: AllowGroups, and AllowUsers plus AllowGroups together, are both satisfied", { skip: !live, timeout: 150_000 }, () => {
  const groups = runScenario("AllowGroups sudo\\n");
  assert.equal(groups.first, "0", groups.out);
  assert.match(groups.login, /allowgroups=channelgate-ssh/);
  assert.match(groups.login, /allowgroups=sudo/, "the operator's group is kept");

  const both = runScenario("AllowUsers tby management\\nAllowGroups sudo\\n");
  assert.equal(both.first, "0", both.out);
  assert.match(both.login, /allowusers=channelgate-ssh/);
  assert.match(both.login, /allowgroups=channelgate-ssh/);
  assert.equal(both.lines, 2);
});

test("live: an existing glob that already admits the account adds nothing", { skip: !live, timeout: 150_000 }, () => {
  const r = runScenario("AllowUsers tby channelgate-*\\n");
  assert.equal(r.first, "0", r.out);
  assert.equal(r.lines, 0, r.out);
});

test("live: DenyUsers cannot be overridden, so the install stops and names the fix", { skip: !live, timeout: 150_000 }, () => {
  const r = runScenario("DenyUsers channelgate-ssh\\n");
  assert.equal(r.first, "1", r.out);
  assert.match(r.out, /a deny list wins over every allow list/);
  assert.match(r.out, /grep -rn 'DenyUsers'/);
});

// A rerun must not undo a corrected endpoint. With only hostname/22 as defaults, a bare rerun —
// which the troubleshooting guide itself recommends — re-advertised the gateway's web hostname
// (behind Cloudflare, no SSH), and every developer connection hung again.
test("a rerun keeps the configured endpoint unless CG_SSH_HOST/CG_SSH_PORT say otherwise", () => {
  assert.match(installer, /SSH_HOST="\$\{CG_SSH_HOST:-\}"/, "no hostname default at the top any more");
  assert.match(installer, /-r "\$SSH_DIR\/endpoint\.json"/);
  assert.match(installer, /keeping the configured endpoint host/);
  assert.match(installer, /SSH_HOST="\$\{SSH_HOST:-\$\(hostname -f/, "hostname applies only when nothing was configured");
});

const ENDPOINT_HARNESS = String.raw`
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sshd /etc/ssh/sshd_config.d; ssh-keygen -A >/dev/null 2>&1
grep -q '^Include /etc/ssh/sshd_config.d/\*\.conf' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
useradd -m svc
base() { env CG_SERVICE_USER=svc CG_NODE_BIN="$(command -v node)" "$@" bash /app/scripts/install-ssh-access.sh >/tmp/out 2>&1; echo "code=$?"; }
ep() { node -e 'const e=require("/var/lib/channelgate-ssh/endpoint.json"); console.log(e.host+":"+e.port)'; }
echo "FIRST $(base CG_SSH_HOST=org.example.dev CG_SSH_PORT=2222) $(ep)"
echo "BARE  $(base) $(ep)"
grep -c 'keeping the configured endpoint' /tmp/out | sed 's/^/KEPT_LINES /'
echo "PORT  $(base CG_SSH_PORT=2200) $(ep)"
rm -f /var/lib/channelgate-ssh/endpoint.json
echo "FRESH $(base) $(ep)"
echo "HOSTNAME $(hostname -f 2>/dev/null || hostname)"
`;

test("live: first install, bare rerun, and an explicit override resolve the endpoint correctly", { skip: !live, timeout: 240_000 }, () => {
  const result = spawnSync("podman", ["run", "--rm", "--user", "root", "-v", `${repo}:/app:ro`, "--entrypoint", "bash", image, "-c", ENDPOINT_HARNESS], { encoding: "utf8", timeout: 230_000 });
  const out = `${result.stdout}${result.stderr}`;
  const line = (tag) => (new RegExp(`^${tag}\\s+(.*)$`, "m").exec(out)?.[1] || "").trim();
  assert.equal(line("FIRST"), "code=0 org.example.dev:2222", out);
  assert.equal(line("BARE"), "code=0 org.example.dev:2222", `a bare rerun keeps the corrected endpoint\n${out}`);
  assert.equal(line("KEPT_LINES"), "2", "it says so, for both host and port");
  assert.equal(line("PORT"), "code=0 org.example.dev:2200", "an explicit port wins and the host is kept");
  assert.equal(line("FRESH"), `code=0 ${line("HOSTNAME")}:22`, "only a first install falls back to hostname:22");
});
