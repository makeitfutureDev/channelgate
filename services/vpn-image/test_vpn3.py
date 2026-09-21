"""Unit tests for the OpenVPN 3 controller and its connected-state gate."""

import contextlib
from enum import Enum
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vpn3 = load("vpn3_controller", "vpn3.py")
checks = load("vpn3_checks", "checks.py")


def normalized_profile(db_host="10.42.0.7"):
    return f"""client
dev tun0
proto tcp-client
remote vpn.example.test 8443
nobind
persist-key
persist-tun
auth-user-pass /vpn/auth
auth-nocache
route-nopull
script-security 1
remote-cert-tls server
verb 3
route remote_host 255.255.255.255 net_gateway
route {db_host} 255.255.255.255 vpn_gateway
auth "SHA512"
cipher AES-256-CBC
data-ciphers AES-256-GCM:AES-128-GCM:AES-256-CBC
data-ciphers-fallback AES-256-CBC
<ca>
-----BEGIN CERTIFICATE-----
VEVTVA==
-----END CERTIFICATE-----
</ca>
<cert>
-----BEGIN CERTIFICATE-----
VEVTVA==
-----END CERTIFICATE-----
</cert>
<key>
-----BEGIN PRIVATE KEY-----
VEVTVA==
-----END PRIVATE KEY-----
</key>
"""


class StatusMajor(Enum):
    CONNECTION = 1


class StatusMinor(Enum):
    CONN_CONNECTING = 1
    CONN_CONNECTED = 2
    CONN_DISCONNECTED = 3
    CONN_FAILED = 4
    CONN_AUTH_FAILED = 5


class DbusError(Exception):
    pass


class Api:
    DBusException = DbusError
    StatusMajor = StatusMajor
    StatusMinor = StatusMinor
    credential_type_group = ("credentials-enum", "user-password-enum")


class Vpn3Tests(unittest.TestCase):
    def setUp(self):
        vpn3._stop_requested = False

    def test_adapts_only_normalized_profile_without_weakening_tls_or_routes(self):
        adapted = vpn3.adapt_profile(normalized_profile(), "10.42.0.7")
        lines = adapted.splitlines()
        self.assertIn("dev tun", lines)
        self.assertIn("auth-user-pass", lines)
        self.assertIn("remote-cert-tls server", lines)
        self.assertIn("route-nopull", lines)
        self.assertIn("route 10.42.0.7 255.255.255.255 vpn_gateway", lines)
        for removed in (
            "dev tun0", "auth-user-pass /vpn/auth", "auth-nocache",
            "script-security 1", "data-ciphers AES-256-GCM:AES-128-GCM:AES-256-CBC",
            "data-ciphers-fallback AES-256-CBC",
        ):
            self.assertNotIn(removed, lines)

    def test_rejects_unsafe_or_non_normalized_profiles_without_echoing_input(self):
        unsafe = (
            "up /secret/hook",
            "auth-user-pass /secret/credentials",
            "redirect-gateway def1",
            "route 0.0.0.0 0.0.0.0",
            "remote-cert-tls client",
            "dev tap0",
            "remote attacker.example 99999",
        )
        for line in unsafe:
            with self.subTest(line=line):
                profile = normalized_profile().replace("dev tun0", line, 1)
                with self.assertRaises(vpn3.VpnError) as failure:
                    vpn3.adapt_profile(profile, "10.42.0.7")
                self.assertEqual(failure.exception.error_class, "invalid_vpn_profile")
                self.assertNotIn("secret", str(failure.exception))
        for required in ("remote-cert-tls server\n", "route-nopull\n", "data-ciphers AES-256-GCM:AES-128-GCM:AES-256-CBC\n"):
            with self.assertRaises(vpn3.VpnError):
                vpn3.adapt_profile(normalized_profile().replace(required, ""), "10.42.0.7")

    def test_auth_file_is_private_two_line_regular_file(self):
        with tempfile.TemporaryDirectory() as directory:
            auth = Path(directory) / "auth"
            auth.write_text("fixture-user\nfixture-password\n", encoding="utf-8")
            auth.chmod(0o600)
            self.assertEqual(
                vpn3.read_credentials(auth),
                {"username": "fixture-user", "password": "fixture-password"},
            )
            alias = Path(directory) / "alias"
            alias.symlink_to(auth)
            with self.assertRaises(vpn3.VpnError):
                vpn3.read_credentials(alias)
            auth.chmod(0o644)
            with self.assertRaises(vpn3.VpnError):
                vpn3.read_credentials(auth)
            auth.chmod(0o600)
            auth.write_text("fixture-user\nfixture-password\nthird\n", encoding="utf-8")
            with self.assertRaises(vpn3.VpnError):
                vpn3.read_credentials(auth)

    def test_credentials_accept_only_expected_enum_group_and_variable_names(self):
        supplied = {}

        class Slot:
            def __init__(self, name, group=Api.credential_type_group):
                self.name, self.group = name, group
            def GetTypeGroup(self): return self.group
            def GetVariableName(self): return self.name
            def ProvideInput(self, value): supplied[self.name] = value

        class Session:
            calls = 0
            slots = [Slot("username"), Slot("password")]
            def Ready(self):
                self.calls += 1
                if self.calls == 1:
                    raise DbusError("must never be rendered")
            def FetchUserInputSlots(self): return self.slots

        session = Session()
        vpn3.provide_credentials(
            session, {"username": "fixture-user", "password": "fixture-password"},
            Api.credential_type_group, DbusError, 10, monotonic=lambda: 0, sleep=lambda _n: None,
        )
        self.assertEqual(supplied, {"username": "fixture-user", "password": "fixture-password"})

        session = Session()
        session.slots = [Slot("username", (1, 1))]
        with self.assertRaises(vpn3.VpnError) as failure:
            vpn3.provide_credentials(
                session, {"username": "fixture-user", "password": "fixture-password"},
                Api.credential_type_group, DbusError, 10, monotonic=lambda: 0,
                sleep=lambda _n: None,
            )
        self.assertEqual(failure.exception.error_class, "unsupported_vpn_authentication")
        self.assertNotIn("fixture", str(failure.exception))

    def test_connection_loss_removes_status_disconnects_and_never_logs_secrets(self):
        class Slot:
            def __init__(self, name): self.name = name
            def GetTypeGroup(self): return Api.credential_type_group
            def GetVariableName(self): return self.name
            def ProvideInput(self, _value): pass

        class Session:
            def __init__(self):
                self.ready_calls = 0
                self.statuses = [
                    {"major": StatusMajor.CONNECTION, "minor": StatusMinor.CONN_CONNECTED},
                    {"major": StatusMajor.CONNECTION, "minor": StatusMinor.CONN_DISCONNECTED},
                ]
                self.disconnected = False
                self.connected = False
            def Ready(self):
                self.ready_calls += 1
                if self.ready_calls == 1: raise DbusError("fixture-password")
            def FetchUserInputSlots(self): return [Slot("username"), Slot("password")]
            def SetDCO(self, value): self.dco = value
            def Connect(self): self.connected = True
            def GetStatus(self): return self.statuses.pop(0)
            def Disconnect(self): self.disconnected = True

        session = Session()
        Api.system_bus = staticmethod(lambda: object())
        Api.configuration_manager = staticmethod(
            lambda _bus: type("Manager", (), {"Import": lambda _self, *_args: object()})()
        )
        Api.session_manager = staticmethod(
            lambda _bus: type("Manager", (), {"NewTunnel": lambda _self, _config: session})()
        )
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "client.ovpn"
            auth = Path(directory) / "auth"
            status = Path(directory) / "status.json"
            profile.write_text(normalized_profile(), encoding="utf-8")
            auth.write_text("fixture-user\nfixture-password\n", encoding="utf-8")
            profile.chmod(0o600)
            auth.chmod(0o600)
            output = io.StringIO()
            with patch.object(vpn3, "PROFILE_PATH", str(profile)), \
                    patch.object(vpn3, "AUTH_PATH", str(auth)), \
                    patch.object(vpn3, "STATUS_PATH", str(status)), \
                    patch.dict(os.environ, {"DB_HOST": "10.42.0.7"}), \
                    contextlib.redirect_stdout(output):
                with self.assertRaises(vpn3.VpnError) as failure:
                    vpn3.run(Api, sleep=lambda _n: None)
            self.assertEqual(failure.exception.error_class, "connection_lost")
            self.assertFalse(status.exists())
            self.assertTrue(session.connected)
            self.assertTrue(session.disconnected)
            self.assertFalse(session.dco)
            self.assertNotIn("fixture-user", output.getvalue())
            self.assertNotIn("fixture-password", output.getvalue())

    def test_health_gate_requires_fresh_live_controller_only_when_marked(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "required"
            status = Path(directory) / "status.json"
            checks.check_vpn3_status(marker, status)
            marker.write_text("", encoding="ascii")
            marker.chmod(0o600)
            value = {
                "connected": True,
                "controllerPid": os.getpid(),
                "checkedAtMonotonic": 100.0,
            }
            status.write_text(json.dumps(value), encoding="ascii")
            status.chmod(0o600)
            checks.check_vpn3_status(marker, status, monotonic=lambda: 105.0)
            with self.assertRaises(checks.CheckFailed):
                checks.check_vpn3_status(marker, status, monotonic=lambda: 111.0)
            value["controllerPid"] = 99999999
            status.write_text(json.dumps(value), encoding="ascii")
            with self.assertRaises(checks.CheckFailed):
                checks.check_vpn3_status(marker, status, monotonic=lambda: 105.0)

    def test_unexpected_exception_is_reduced_to_fixed_error_class(self):
        output = io.StringIO()
        with patch.object(vpn3, "run", side_effect=RuntimeError("fixture-password")), \
                contextlib.redirect_stdout(output):
            self.assertEqual(vpn3.main(), 1)
        self.assertEqual(
            json.loads(output.getvalue()),
            {"event": "vpn_error", "errorClass": "vpn_controller_failed"},
        )

    def test_provider_status_text_is_only_used_for_fixed_tls_classes(self):
        cases = (
            ("VERIFY KU ERROR: fixture-secret", "server_certificate_usage"),
            ("certificate verification failed: fixture-secret", "server_certificate_invalid"),
            ("TLS Error: fixture-secret", "tls_failed"),
            ("provider fixture-secret", "startup_failed"),
        )
        for message, expected in cases:
            with self.subTest(expected=expected):
                error_class = vpn3._terminal_error(
                    {"minor": StatusMinor.CONN_FAILED, "message": message}, Api, False,
                )
                self.assertEqual(error_class, expected)
                self.assertNotIn("fixture-secret", error_class)

    def test_private_client_log_is_reduced_without_disclosing_provider_text(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "client.log"
            log.write_text("VERIFY ERROR: fixture-provider-secret", encoding="utf-8")
            log.chmod(0o600)
            self.assertEqual(vpn3.classify_client_logs(directory), "server_certificate_invalid")
            alias = Path(directory) / "client.log.alias"
            alias.symlink_to(log)
            self.assertEqual(vpn3.classify_client_logs(directory), "server_certificate_invalid")

            output = io.StringIO()
            with patch.object(vpn3, "run", side_effect=RuntimeError("fixture-provider-secret")), \
                    patch.object(vpn3, "classify_client_logs", return_value="tls_failed"), \
                    contextlib.redirect_stdout(output):
                self.assertEqual(vpn3.main(), 1)
            self.assertEqual(json.loads(output.getvalue()), {"event": "vpn_error", "errorClass": "tls_failed"})
            self.assertNotIn("fixture-provider-secret", output.getvalue())


if __name__ == "__main__":
    unittest.main()
