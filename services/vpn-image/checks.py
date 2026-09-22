"""Bounded VPN/database readiness checks. Never render exception text or secrets."""

import argparse
import ipaddress
import json
import os
import re
import stat
import subprocess
import sys
import time


class CheckFailed(Exception):
    def __init__(self, error_class):
        self.error_class = error_class


def configuration(environ):
    try:
        host = str(ipaddress.IPv4Address(environ.get("DB_HOST", "")))
    except ipaddress.AddressValueError:
        raise CheckFailed("invalid_database_host") from None
    port_text = environ.get("DB_PORT", "3306")
    if not re.fullmatch(r"[0-9]{1,5}", port_text):
        raise CheckFailed("invalid_database_port")
    port = int(port_text)
    if not 1 <= port <= 65535:
        raise CheckFailed("invalid_database_port")
    return host, port


def route_data(args, runner=subprocess.run):
    try:
        result = runner(
            ["ip", "-j", "-4", "route", *args],
            capture_output=True,
            check=True,
            timeout=5,
            text=True,
        )
        value = json.loads(result.stdout)
        if not isinstance(value, list) or not value or not all(isinstance(row, dict) for row in value):
            raise ValueError()
        return value
    except (OSError, subprocess.SubprocessError, ValueError):
        raise CheckFailed("route_not_ready") from None


def check_routes(host, runner=subprocess.run):
    defaults = route_data(["show", "default"], runner)
    public_devices = {route.get("dev") for route in defaults}
    # Podman's rootless slirp4netns names its interface tap0; bridge networking
    # uses eth0. Preserve exactly one public default, never a tunnel default.
    if len(public_devices) != 1 or not public_devices.issubset({"eth0", "tap0"}):
        raise CheckFailed("public_default_route_changed")
    public_device = next(iter(public_devices))
    target = route_data(["get", host], runner)
    if any(route.get("dev") != "tun0" for route in target):
        raise CheckFailed("database_route_not_tunnel")
    # A default route can remain listed while more-specific routes divert public
    # traffic. Check the actual lookup too, including OpenVPN's /1 default trick.
    for public_ip in ("1.1.1.1", "208.67.222.222"):
        if public_ip == host:
            continue
        if any(route.get("dev") != public_device for route in route_data(["get", public_ip], runner)):
            raise CheckFailed("public_default_route_changed")


def check_vpn3_status(
    marker="/run/channelgate-vpn/openvpn3-required",
    filename="/run/channelgate-vpn/status.json",
    monotonic=time.monotonic,
    process_signal=os.kill,
):
    """Require a fresh controller status only in the VPN container filesystem."""
    if not os.path.exists(marker):
        return
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "r", encoding="ascii") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 4096:
                raise CheckFailed("vpn_not_connected")
            value = json.loads(handle.read(4097))
        if not isinstance(value, dict) or value.get("connected") is not True:
            raise CheckFailed("vpn_not_connected")
        pid = value.get("controllerPid")
        checked = value.get("checkedAtMonotonic")
        age = monotonic() - checked if isinstance(checked, (int, float)) else -1
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1 or not 0 <= age <= 10:
            raise CheckFailed("vpn_not_connected")
        process_signal(pid, 0)
    except CheckFailed:
        raise
    except (OSError, ValueError, TypeError, UnicodeError):
        raise CheckFailed("vpn_not_connected") from None


def read_credentials(filename="/db/credentials.json"):
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 16384:
                raise CheckFailed("invalid_database_credentials_file")
            value = json.loads(handle.read(16385))
    except CheckFailed:
        raise
    except (OSError, ValueError, UnicodeError):
        raise CheckFailed("database_credentials_unavailable") from None
    if not isinstance(value, dict):
        raise CheckFailed("invalid_database_credentials")
    if not isinstance(value.get("username"), str) or not value["username"]:
        raise CheckFailed("invalid_database_credentials")
    if not isinstance(value.get("password"), str) or not value["password"]:
        raise CheckFailed("invalid_database_credentials")
    if "database" in value and (not isinstance(value["database"], str) or not value["database"]):
        raise CheckFailed("invalid_database_credentials")
    return {name: value[name] for name in ("username", "password", "database") if name in value}


def check_database(host, port, credentials, connect=None):
    if connect is None:
        import pymysql
        connect = pymysql.connect
    try:
        connection = connect(
            host=host,
            port=port,
            user=credentials["username"],
            password=credentials["password"],
            database=credentials.get("database"),
            connect_timeout=8,
            read_timeout=8,
            write_timeout=8,
            charset="utf8mb4",
            autocommit=True,
            # This operator-enabled connection uses the encrypted VPN transport;
            # it does not negotiate database TLS without a separate TLS contract.
            ssl=None,
        )
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                if cursor.fetchone() != (1,):
                    raise CheckFailed("database_query_failed")
                cursor.execute("SHOW DATABASES")
                schemas = sorted(str(row[0]) for row in cursor.fetchall())
        finally:
            connection.close()
        return {"schemaNames": schemas}
    except CheckFailed:
        raise
    except Exception as error:
        # Error text can contain credentials, SQL and endpoint details. Only
        # classify known server codes; never return repr(error) or its message.
        code = error.args[0] if error.args and isinstance(error.args[0], int) else None
        if code == 1045:
            error_class = "database_authentication_failed"
        elif code in (1044, 1142):
            error_class = "database_access_denied"
        elif code == 1049:
            error_class = "database_not_found"
        else:
            error_class = "database_connection_or_query_failed"
        raise CheckFailed(error_class) from None


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("validate-env", "health", "verify"))
    parser.add_argument("--no-connect", action="store_true")
    args = parser.parse_args(argv)
    try:
        host, port = configuration(os.environ)
        result = {"ok": True}
        if args.action != "validate-env":
            check_vpn3_status()
            check_routes(host)
            result["routes"] = "ready"
            # Health never opens a database socket. MySQL counts every connection that closes
            # before its handshake as a connect error and, past max_connect_errors, blocks the
            # tunnel address (error 1129) — a 30-second probe did exactly that in under an hour.
            # --no-connect stays accepted so older callers keep working.
            if args.action == "verify":
                if args.no_connect:
                    raise CheckFailed("invalid_check_options")
                result.update(check_database(host, port, read_credentials()))
                result["database"] = "ready"
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except CheckFailed as error:
        print(json.dumps({"ok": False, "errorClass": error.error_class}))
        return 1
    except Exception:
        print(json.dumps({"ok": False, "errorClass": "readiness_check_failed"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
