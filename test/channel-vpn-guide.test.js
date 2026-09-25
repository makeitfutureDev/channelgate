import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const skillUrl = new URL("../src/gateway/gateway-usage/SKILL.md", import.meta.url);
const administrationUrl = new URL(
  "../src/gateway/gateway-usage/references/administration.md",
  import.meta.url,
);
const vpnUrl = new URL("../src/gateway/gateway-usage/references/channel-vpn.md", import.meta.url);

test("gateway guide routes channel VPN provisioning to its own reference", async () => {
  const [skill, administration, vpn] = await Promise.all([
    readFile(skillUrl, "utf8"),
    readFile(administrationUrl, "utf8"),
    readFile(vpnUrl, "utf8"),
  ]);

  assert.match(skill, /VPN on\/off.*references\/channel-vpn\.md/is);
  assert.match(administration, /Provisioning a VPN for THIS or any OTHER channel.*channel-vpn\.md/is);
  assert.match(vpn, /cannot provision from inside a channel container/is);
  assert.match(vpn, /npm run vpn -- configure --channel/);
  assert.match(vpn, /build[\s\S]*install-unit[\s\S]*enable[\s\S]*status[\s\S]*verify/);
  assert.match(vpn, /Cannot be renamed later/i);
  assert.match(vpn, /inside that channel's working folder/i);
  assert.match(vpn, /VPN_USERNAME.*VPN_PASSWORD.*MYSQL_USERNAME.*MYSQL_PASSWORD/s);
  assert.match(vpn, /"Starting" is not "connected\."/i);
});

test("the VPN guide never teaches bypassing verification or collecting secrets in chat", async () => {
  const vpn = await readFile(vpnUrl, "utf8");

  assert.match(vpn, /\*\*Never\*\* drop `remote-cert-tls server`/);
  assert.match(vpn, /Never ask anyone to\s+paste the `\.ovpn`/);
  // Examples stay on placeholder identifiers: the guide ships into every channel folder.
  assert.match(vpn, /--channel C_EXAMPLE/);
  assert.doesNotMatch(vpn, /--channel (?!C_EXAMPLE)[A-Z0-9]{6,}/);
});
