"""Secret-safe OpenVPN 3 session controller for the dedicated VPN container."""

import json
import os
import re
import signal
import stat
import sys
import time
from types import SimpleNamespace


PROFILE_PATH = "/vpn/client.ovpn"
AUTH_PATH = "/vpn/auth"
STATUS_PATH = "/run/channelgate-vpn/status.json"
CONNECT_TIMEOUT_SECONDS = 120
PROFILE_MAX_BYTES = 256 * 1024
AUTH_MAX_BYTES = 16 * 1024
CLIENT_LOG_MAX_BYTES = 1024 * 1024
POLL_SECONDS = 0.5
SESSION_SETTLE_SECONDS = 2

_stop_requested = False


class VpnError(Exception):
    """A fixed diagnostic class whose text never contains provider data."""

    def __init__(self, error_class):
        self.error_class = error_class
        super().__init__(error_class)


class VpnCancelled(Exception):
    pass


def request_stop(_signum=None, _frame=None):
    global _stop_requested
    _stop_requested = True


def cancelled():
    return _stop_requested


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}, ensure_ascii=True), flush=True)


def read_private_text(filename, maximum):
    """Read one private regular file without following a symlink."""
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > maximum:
                raise VpnError("invalid_private_file")
            value = handle.read(maximum + 1)
    except VpnError:
        raise
    except (OSError, UnicodeError):
        raise VpnError("private_file_unavailable") from None
    if len(value.encode("utf-8")) > maximum:
        raise VpnError("invalid_private_file")
    return value


def read_credentials(filename=None):
    filename = filename or AUTH_PATH
    lines = read_private_text(filename, AUTH_MAX_BYTES).splitlines()
    if len(lines) != 2 or not all(lines) or any("\x00" in line for line in lines):
        raise VpnError("invalid_vpn_credentials")
    return {"username": lines[0], "password": lines[1]}


def _validate_optional(line):
    ciphers = r"(?:AES-256-GCM|AES-128-GCM|AES-256-CBC|AES-128-CBC|CHACHA20-POLY1305)"
    patterns = (
        rf"cipher {ciphers}",
        rf"data-ciphers {ciphers}(?::{ciphers})*",
        rf"data-ciphers-fallback {ciphers}",
        r'verify-x509-name "(?:[^"\\]|\\["\\])+"(?: "(?:subject|name|name-prefix)")?',
        r'auth "SHA(?:256|384|512)"',
        r'resolv-retry "(?:infinite|[1-9][0-9]{0,3})"',
        r'route-delay "(?:[0-9]|[1-5][0-9]|60)"',
        r'reneg-sec "(?:0|[1-9][0-9]{0,6})"',
        r'key-direction "[01]"',
    )
    return any(re.fullmatch(pattern, line) for pattern in patterns)


def adapt_profile(text, db_host):
    """Adapt only the gateway's normalized OpenVPN 2 profile to OpenVPN 3."""
    if not isinstance(text, str) or len(text.encode("utf-8")) > PROFILE_MAX_BYTES:
        raise VpnError("invalid_vpn_profile")
    if re.search(r"[\x00-\x08\x0b-\x1f\x7f-\uffff]", text):
        raise VpnError("invalid_vpn_profile")
    try:
        import ipaddress
        db_host = str(ipaddress.IPv4Address(db_host))
    except (ipaddress.AddressValueError, TypeError):
        raise VpnError("invalid_vpn_profile") from None

    exact = {
        "client", "dev tun0", "proto tcp-client", "nobind", "persist-key",
        "persist-tun", "auth-user-pass /vpn/auth", "auth-nocache",
        "route-nopull", "script-security 1", "remote-cert-tls server", "verb 3",
        "route remote_host 255.255.255.255 net_gateway",
        f"route {db_host} 255.255.255.255 vpn_gateway",
    }
    required = set(exact)
    seen = set()
    blocks = set()
    block = None
    output = []
    for raw in text.splitlines():
        line = raw.strip()
        if block:
            output.append(raw)
            if line == f"</{block}>":
                block = None
            elif re.fullmatch(r"</?[a-z-]+>", line):
                raise VpnError("invalid_vpn_profile")
            continue
        opening = re.fullmatch(r"<(ca|cert|key|tls-auth|tls-crypt)>", line)
        if opening:
            block = opening.group(1)
            if block in blocks:
                raise VpnError("invalid_vpn_profile")
            blocks.add(block)
            output.append(line)
            continue
        if not line:
            continue
        if line.startswith("remote "):
            if "remote" in seen or not re.fullmatch(
                r"remote (?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|(?:[0-9]{1,3}\.){3}[0-9]{1,3}) [1-9][0-9]{0,4}",
                line,
            ):
                raise VpnError("invalid_vpn_profile")
            if int(line.rsplit(" ", 1)[1]) > 65535:
                raise VpnError("invalid_vpn_profile")
            seen.add("remote")
            output.append(line)
            continue
        if line in exact:
            if line in seen:
                raise VpnError("invalid_vpn_profile")
            seen.add(line)
            if line == "dev tun0":
                output.append("dev tun")
            elif line == "auth-user-pass /vpn/auth":
                output.append("auth-user-pass")
            elif line not in {"auth-nocache", "script-security 1"}:
                output.append(line)
            continue
        if _validate_optional(line):
            name = line.split(" ", 1)[0]
            if name in seen:
                raise VpnError("invalid_vpn_profile")
            seen.add(name)
            if name not in {"data-ciphers", "data-ciphers-fallback"}:
                output.append(line)
            continue
        raise VpnError("invalid_vpn_profile")

    if block or not {"ca", "cert", "key"}.issubset(blocks):
        raise VpnError("invalid_vpn_profile")
    if not required.issubset(seen) or not {"remote", "data-ciphers"}.issubset(seen):
        raise VpnError("invalid_vpn_profile")
    if "tls-auth" in blocks and "tls-crypt" in blocks:
        raise VpnError("invalid_vpn_profile")
    if "key-direction" in seen and "tls-auth" not in blocks:
        raise VpnError("invalid_vpn_profile")
    return "\n".join(output) + "\n"


def provide_credentials(session, credentials, credential_type_group, dbus_exception,
                        deadline, monotonic=time.monotonic, sleep=time.sleep):
    """Satisfy only the enum-typed username/password slots OpenVPN requested."""
    while monotonic() < deadline:
        if cancelled():
            raise VpnCancelled()
        try:
            session.Ready()
            return
        except dbus_exception:
            try:
                slots = session.FetchUserInputSlots()
            except dbus_exception:
                sleep(POLL_SECONDS)
                continue
            names = set()
            for slot in slots:
                if slot.GetTypeGroup() != credential_type_group:
                    raise VpnError("unsupported_vpn_authentication")
                name = slot.GetVariableName()
                if name not in credentials or name in names:
                    raise VpnError("unsupported_vpn_authentication")
                names.add(name)
                slot.ProvideInput(credentials[name])
            sleep(POLL_SECONDS)
    raise VpnError("vpn_startup_timeout")


def enum_text(value):
    name = getattr(value, "name", None)
    typename = type(value).__name__
    if not isinstance(name, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
        raise VpnError("invalid_vpn_status")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", typename):
        typename = "Status"
    return f"{typename}.{name}"


def write_status(status, filename=None, monotonic=time.monotonic):
    filename = filename or STATUS_PATH
    value = {
        "connected": True,
        "controllerPid": os.getpid(),
        "checkedAtMonotonic": monotonic(),
        "major": enum_text(status["major"]),
        "minor": enum_text(status["minor"]),
    }
    os.makedirs(os.path.dirname(filename), mode=0o700, exist_ok=True)
    temporary = f"{filename}.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_CLOEXEC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="ascii") as handle:
            json.dump(value, handle, ensure_ascii=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, filename)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def remove_status(filename=None):
    filename = filename or STATUS_PATH
    try:
        os.unlink(filename)
    except FileNotFoundError:
        pass


def _terminal_error(status, api, connected):
    minor = status.get("minor")
    if minor == api.StatusMinor.CONN_AUTH_FAILED:
        return "authentication_failed"
    # OpenVPN Core status text is provider-influenced, so never render it. Match
    # only reviewed failure tokens and reduce them to fixed public classes.
    message = status.get("message")
    if isinstance(message, str):
        lowered = message.lower()
        if "verify ku error" in lowered or "certificate does not have key usage extension" in lowered:
            return "server_certificate_usage"
        if ("verify error" in lowered or "certificate verify failed" in lowered
                or "certificate verification failed" in lowered):
            return "server_certificate_invalid"
        if "tls error" in lowered or "tls handshake failed" in lowered:
            return "tls_failed"
    failed = {getattr(api.StatusMinor, name, None) for name in ("CONN_FAILED", "CONN_DISCONNECTED")}
    if minor in failed:
        return "connection_lost" if connected else "startup_failed"
    return None


def classify_client_logs(directory="/run/openvpn3"):
    """Reduce private OpenVPN client logs to a reviewed fixed failure class."""
    matched = None
    try:
        names = sorted(name for name in os.listdir(directory) if name.startswith("client.log"))[:20]
    except OSError:
        return None
    for name in names:
        try:
            fd = os.open(
                os.path.join(directory, name),
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            )
            with os.fdopen(fd, "rb") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > CLIENT_LOG_MAX_BYTES:
                    continue
                content = handle.read(CLIENT_LOG_MAX_BYTES + 1).lower()
        except OSError:
            continue
        if len(content) > CLIENT_LOG_MAX_BYTES:
            continue
        if b"verify ku error" in content or b"certificate does not have key usage extension" in content:
            return "server_certificate_usage"
        if (b"verify error" in content or b"certificate verify failed" in content
                or b"certificate verification failed" in content):
            matched = "server_certificate_invalid"
        elif matched is None and (b"tls error" in content or b"tls handshake failed" in content):
            matched = "tls_failed"
    return matched


def monitor_session(session, api, deadline, status_path=None,
                    monotonic=time.monotonic, sleep=time.sleep):
    status_path = status_path or STATUS_PATH
    connected = False
    last = None
    while True:
        if cancelled():
            raise VpnCancelled()
        status = session.GetStatus()
        current = (enum_text(status["major"]), enum_text(status["minor"]))
        if current != last:
            emit("vpn_status", major=current[0], minor=current[1])
            last = current
        is_connected = (
            status["major"] == api.StatusMajor.CONNECTION
            and status["minor"] == api.StatusMinor.CONN_CONNECTED
        )
        if is_connected:
            if not connected:
                emit("vpn_connected")
            connected = True
            write_status(status, status_path, monotonic)
        elif connected:
            raise VpnError("connection_lost")
        else:
            error_class = _terminal_error(status, api, connected)
            if error_class:
                raise VpnError(error_class)
            if monotonic() >= deadline:
                raise VpnError("vpn_startup_timeout")
        sleep(POLL_SECONDS)


def load_api():
    import dbus
    import openvpn3
    from openvpn3 import (
        ClientAttentionGroup, ClientAttentionType, StatusMajor, StatusMinor,
    )

    return SimpleNamespace(
        DBusException=dbus.exceptions.DBusException,
        StatusMajor=StatusMajor,
        StatusMinor=StatusMinor,
        credential_type_group=(
            ClientAttentionType.CREDENTIALS,
            ClientAttentionGroup.USER_PASSWORD,
        ),
        system_bus=dbus.SystemBus,
        configuration_manager=openvpn3.ConfigurationManager,
        session_manager=openvpn3.SessionManager,
    )


def run(api=None, *, monotonic=time.monotonic, sleep=time.sleep):
    api = api or load_api()
    remove_status()
    profile = adapt_profile(read_private_text(PROFILE_PATH, PROFILE_MAX_BYTES), os.environ.get("DB_HOST"))
    credentials = read_credentials()
    deadline = monotonic() + CONNECT_TIMEOUT_SECONDS
    emit("vpn_controller_started")
    bus = None
    config = None
    session = None
    try:
        # Service registration can lag process startup. Retry each asynchronous
        # D-Bus stage, but never echo exception text because it may contain
        # provider material.
        while monotonic() < deadline:
            if cancelled():
                raise VpnCancelled()
            try:
                bus = api.system_bus()
                manager = api.configuration_manager(bus)
                config = manager.Import("channelgate-vpn", profile, False, False)
                break
            except api.DBusException:
                sleep(POLL_SECONDS)
        if config is None:
            raise VpnError("vpn_service_startup_timeout")
        emit("vpn_profile_imported")
        while monotonic() < deadline:
            if cancelled():
                raise VpnCancelled()
            try:
                session = api.session_manager(bus).NewTunnel(config)
                break
            except api.DBusException:
                sleep(POLL_SECONDS)
        if session is None:
            raise VpnError("vpn_session_startup_timeout")
        emit("vpn_session_created")
        # NewTunnel returns before the backend client has necessarily exposed
        # its attention slots. The packaged Python example follows the same
        # asynchronous contract; allow the service stack to settle first.
        sleep(SESSION_SETTLE_SECONDS)
        provide_credentials(
            session, credentials, api.credential_type_group, api.DBusException,
            deadline, monotonic, sleep,
        )
        session.SetDCO(False)
        session.Connect()
        emit("vpn_connection_started")
        monitor_session(session, api, deadline, monotonic=monotonic, sleep=sleep)
    finally:
        remove_status()
        if session is not None:
            try:
                session.Disconnect()
                emit("vpn_disconnected")
            except Exception:
                pass


def main():
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, request_stop)
    try:
        run()
        return 0
    except VpnCancelled:
        return 0
    except VpnError as error:
        error_class = error.error_class
        if error_class in {"startup_failed", "connection_lost"}:
            error_class = classify_client_logs() or error_class
        emit("vpn_error", errorClass=error_class)
        return 1
    except Exception:
        emit("vpn_error", errorClass=classify_client_logs() or "vpn_controller_failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
