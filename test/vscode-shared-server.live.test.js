// The live proof of the shared VS Code servers (image spec 1.5.0), against a REAL built image.
//
// VS Code's remote extensions install a ~620 MB server (+ a 34 MB CLI) per client version into
// ~/.vscode-server, and /home/agent is the per-channel volume: every channel someone opened an
// editor in carried its own copy (measured 687 MB of one channel's 689 MB). The image now carries
// each pinned version ONCE under /opt/channelgate/vscode-server and cg-init links it into the volume.
// This proves, in a fresh volume and as the unprivileged `agent` user, that the links land in both
// layouts VS Code looks for, that the read-only shared server actually starts and serves, that the
// volume stays tiny, and that cg-init never deletes an install it did not make.
//
// Opt-in: `npm run test:live-container` (CG_LIVE_CONTAINER=1). CG_LIVE_IMAGE picks the image
// (default channelgate/runtime:latest). Skipped — never failed — without podman or a built image.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const live = process.env.CG_LIVE_CONTAINER === "1";
const image = process.env.CG_LIVE_IMAGE || "localhost/channelgate/runtime:latest";
const versions = JSON.parse(readFileSync(new URL("../containers/versions.json", import.meta.url), "utf8"));
const commits = (versions.vscodeServers || []).map((s) => s.commit);

const HARNESS = String.raw`
set -u
H=/home/agent/.vscode-server; I=/opt/channelgate/bin/cg-init
echo "WHOAMI=$(whoami)"
$I true
for c in $CG_COMMITS; do
  for l in "$H/bin/$c" "$H/cli/servers/Stable-$c/server" "$H/code-$c"; do
    if [ -L "$l" ] && [ -e "$l" ]; then echo "LINK_OK $c"; else echo "LINK_BAD $l"; fi
  done
  echo "CLI $c $($H/code-$c --version 2>&1 | head -1)"
done
echo "VOLUME_KB=$(du -sk $H | cut -f1)"
first=$(echo $CG_COMMITS | cut -d' ' -f1)
$H/bin/$first/bin/code-server --host 127.0.0.1 --port 8765 --without-connection-token --accept-server-license-terms >/tmp/srv.log 2>&1 &
pid=$!
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8765/ 2>/dev/null && break; sleep 0.5; done
echo "VERSION_ENDPOINT=$(curl -s http://127.0.0.1:8765/version)"
kill $pid 2>/dev/null; wait $pid 2>/dev/null
echo "WRITE_ERRORS=$(grep -ciE 'EACCES|EROFS|permission denied|read-only file system' /tmp/srv.log)"
echo "DATA_IN_VOLUME=$( [ -d $H/data ] && echo yes || echo no )"
echo "OPT_WRITABLE=$( touch /opt/channelgate/vscode-server/probe 2>/dev/null && echo yes || echo no )"
$I true; echo "RERUN_LINKS=$(find $H -maxdepth 4 -type l | wc -l)"
second=$(echo $CG_COMMITS | awk '{print $NF}')
ln -s /opt/channelgate/vscode-server/deadbeef/server "$H/bin/deadbeef"
rm "$H/bin/$second"; mkdir -p "$H/bin/$second"; echo keep > "$H/bin/$second/marker"
$I true
echo "DANGLING=$( [ -L $H/bin/deadbeef ] && echo kept || echo removed )"
echo "REAL_INSTALL=$( [ -f $H/bin/$second/marker ] && [ ! -L $H/bin/$second ] && echo preserved || echo clobbered )"
rm -rf "$H/bin" "$H/cli" "$H"/code-*; touch "$H/.cg-no-shared-server"; $I true
echo "OPT_OUT_LINKS=$(find $H -maxdepth 4 -type l | wc -l)"
`;

test("live: a fresh channel volume gets the shared servers as links, and the read-only server runs as agent", { skip: live ? false : "opt-in — run `npm run test:live-container`", timeout: 240_000 }, () => {
  assert.ok(commits.length >= 2, "the harness exercises at least two pinned versions");
  const volume = `cg-vscode-live-${process.pid}`;
  spawnSync("podman", ["volume", "rm", "-f", volume]);
  try {
    const result = spawnSync("podman", ["run", "--rm", "-e", `CG_COMMITS=${commits.join(" ")}`, "-v", `${volume}:/home/agent`, "--entrypoint", "sh", image, "-c", HARNESS], { encoding: "utf8", timeout: 230_000 });
    const out = `${result.stdout}${result.stderr}`;
    const field = (name) => (new RegExp(`^${name}=(.*)$`, "m").exec(out)?.[1] || "").trim();
    assert.equal(field("WHOAMI"), "agent", out);
    assert.equal((out.match(/^LINK_OK /gm) || []).length, commits.length * 3, `every version is linked in all three layouts\n${out}`);
    assert.doesNotMatch(out, /^LINK_BAD /m, out);
    for (const server of versions.vscodeServers) {
      assert.match(out, new RegExp(`^CLI ${server.commit} code ${server.version.replace(/\./g, "\\.")} \\(commit ${server.commit}\\)`, "m"), `the ${server.version} CLI runs`);
    }
    assert.ok(Number(field("VOLUME_KB")) < 1024, `the channel volume holds links, not copies (${field("VOLUME_KB")} KB)`);
    assert.equal(field("VERSION_ENDPOINT"), commits[0], "the shared read-only server started and serves its own commit");
    assert.equal(field("WRITE_ERRORS"), "0", "the server never tried to write into the shared tree");
    assert.equal(field("DATA_IN_VOLUME"), "yes", "its state goes to the channel's own volume");
    assert.equal(field("OPT_WRITABLE"), "no", "a channel can run the shared server but never replace it");
    assert.equal(Number(field("RERUN_LINKS")), commits.length * 3, "a second start changes nothing");
    assert.equal(field("DANGLING"), "removed", "a link this script made that no longer resolves is cleaned up");
    assert.equal(field("REAL_INSTALL"), "preserved", "a real install someone downloaded is never replaced");
    assert.equal(field("OPT_OUT_LINKS"), "0", ".cg-no-shared-server opts a channel out");
  } finally {
    spawnSync("podman", ["volume", "rm", "-f", volume]);
  }
});
