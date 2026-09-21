"""Isolated rootless acceptance, no customer profile, credentials or VPN traffic.

Run as the account owning rootless Podman, after building localhost/channelgate/vpn:2.
Creates and removes only two uniquely named QA containers. No host routes change.
"""

import json
import re
import subprocess
import uuid


IMAGE = "localhost/channelgate/vpn:2"
DB_HOST = "10.254.255.254"
OTHER_HOST = "10.254.255.253"


def podman(*args):
    result = subprocess.run(["podman", *args], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError(f"Podman QA command failed: {args[0]}: {result.stderr.strip()}")
    return result.stdout.strip()


def main():
    suffix = uuid.uuid4().hex[:12]
    vpn = f"cg-vpn-qa-{suffix}"
    extractor = f"cg-vpn-qa-extractor-{suffix}"
    created = []
    evidence = {}
    try:
        podman(
            "run", "-d", "--name", vpn,
            "--label", "cg.vpn.qa=1", "--cap-drop", "ALL", "--cap-add", "NET_ADMIN",
            "--device", "/dev/net/tun", "--network", "slirp4netns:allow_host_loopback=false",
            "--read-only", "--tmpfs", "/run:rw,noexec,nosuid,size=8m",
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=8m", "--security-opt", "no-new-privileges",
            "--health-cmd", "none", "-e", f"DB_HOST={DB_HOST}", "-e", "DB_PORT=3306",
            "--entrypoint", "/usr/bin/tini", IMAGE, "--", "sleep", "infinity",
        )
        created.append(vpn)
        podman("exec", vpn, "cg-vpn-firewall")
        podman("exec", vpn, "ip", "tuntap", "add", "dev", "tun0", "mode", "tun")
        podman("exec", vpn, "ip", "addr", "add", "10.253.0.2/30", "dev", "tun0")
        podman("exec", vpn, "ip", "link", "set", "tun0", "up")
        evidence["tunCreatedWithNetAdminOnly"] = True

        def lookup(host):
            return json.loads(podman("exec", vpn, "ip", "-j", "route", "get", host))[0]["dev"]

        def probe(container, host, port):
            code = (
                "import socket,json; s=socket.socket(); s.settimeout(2); "
                f"result=s.connect_ex(({host!r},{port})); "
                "s.close(); print(json.dumps({'errno':result}))"
            )
            return json.loads(podman("exec", container, "python3", "-c", code))["errno"]

        public_device = lookup(DB_HOST)
        assert public_device in ("eth0", "tap0")
        evidence["publicInterface"] = public_device
        assert probe(vpn, DB_HOST, 3306) == 111  # ECONNREFUSED from REJECT
        saved = podman("exec", vpn, "iptables-save", "-c")
        kill_rule = next(line for line in saved.splitlines() if f"-d {DB_HOST}/32 ! -o tun0" in line)
        assert re.match(r"\[[1-9][0-9]*:", kill_rule), kill_rule
        evidence["databaseOutsideTunnelRejected"] = True

        podman("exec", vpn, "ip", "route", "add", f"{OTHER_HOST}/32", "dev", "tun0")
        assert lookup(OTHER_HOST) == "tun0"
        assert probe(vpn, OTHER_HOST, 3306) == 111
        saved = podman("exec", vpn, "iptables-save", "-c")
        tunnel_rule = next(line for line in saved.splitlines() if "-A OUTPUT -o tun0 -j REJECT" in line)
        assert re.match(r"\[[1-9][0-9]*:", tunnel_rule), tunnel_rule
        evidence["otherTunnelDestinationRejected"] = True

        podman("exec", vpn, "ip", "route", "add", f"{DB_HOST}/32", "dev", "tun0")
        assert probe(vpn, DB_HOST, 3307) == 111
        probe(vpn, DB_HOST, 3306)  # No peer exists, but the firewall must ACCEPT this SYN.
        saved = podman("exec", vpn, "iptables-save", "-c")
        allow_rule = next(line for line in saved.splitlines() if "--dport 3306 -j ACCEPT" in line)
        assert re.match(r"\[[1-9][0-9]*:", allow_rule), allow_rule
        evidence["databasePortAcceptedOtherPortRejected"] = True
        assert lookup("1.1.1.1") == public_device
        assert probe(vpn, "1.1.1.1", 443) == 0
        evidence["publicDefaultAndTcpPreserved"] = True
        evidence["routeHealth"] = json.loads(podman("exec", vpn, "cg-vpn-routes"))

        ipv6_rules = podman("exec", vpn, "ip6tables-save")
        assert "-A OUTPUT -o tun0 -j REJECT" in ipv6_rules
        assert "-A INPUT -i tun0 -j DROP" in ipv6_rules
        evidence["ipv6TunnelBlocked"] = True

        # A harmless marker in VPN-only tmpfs demonstrates filesystem separation.
        podman("exec", vpn, "sh", "-c", "umask 077; printf fixture > /run/vpn-only-marker")
        podman(
            "run", "-d", "--name", extractor, "--label", "cg.vpn.qa=1",
            "--cap-drop", "ALL", "--network", f"container:{vpn}", "--read-only",
            "--security-opt", "no-new-privileges", "--health-cmd", "none",
            "--entrypoint", "/usr/bin/tini", IMAGE, "--", "sleep", "infinity",
        )
        created.append(extractor)
        confinement = json.loads(podman("exec", extractor, "python3", "-c", """
import json, pathlib, subprocess
status = pathlib.Path('/proc/self/status').read_text()
cap = next(line.split()[1] for line in status.splitlines() if line.startswith('CapEff:'))
add = subprocess.run(['ip', 'link', 'add', 'qa-forbidden', 'type', 'dummy'], capture_output=True)
print(json.dumps({'capabilitiesZero': int(cap,16)==0, 'networkMutationDenied': add.returncode!=0,
 'tunDeviceAbsent': not pathlib.Path('/dev/net/tun').exists(),
 'vpnFilesystemAbsent': not pathlib.Path('/run/vpn-only-marker').exists(),
 'vpnAuthAbsent': not pathlib.Path('/vpn/auth').exists()}))
"""))
        assert all(confinement.values()), confinement
        evidence["extractorConfinement"] = confinement
        assert probe(extractor, OTHER_HOST, 3306) == 111
        evidence["extractorSharesFirewall"] = True

        podman("exec", vpn, "ip", "link", "delete", "tun0")
        assert lookup(DB_HOST) == public_device
        assert probe(extractor, DB_HOST, 3306) == 111
        evidence["tunnelLossStillRejectsDatabase"] = True
        evidence["imageId"] = podman("image", "inspect", "--format", "{{.Id}}", IMAGE)
    finally:
        for name in reversed(created):
            podman("rm", "-f", name)
    print(json.dumps({"ok": True, "evidence": evidence, "fixtureContainersRemoved": created}, indent=2))


if __name__ == "__main__":
    main()
