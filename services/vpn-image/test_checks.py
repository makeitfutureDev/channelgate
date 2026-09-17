"""Run with python3 -m unittest discover -s services/vpn-image -p 'test_*.py'."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("vpn_checks", Path(__file__).with_name("checks.py"))
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class ChecksTests(unittest.TestCase):
    def test_configuration_rejects_command_text_hostnames_and_invalid_ports(self):
        for host in ("db.internal", "::1", "10.0.0.2;id", "10.0.0.2/24", ""):
            with self.subTest(host=host), self.assertRaises(checks.CheckFailed):
                checks.configuration({"DB_HOST": host})
        for port in ("0", "65536", "-1", "3306\n", "3306;id", "１２３"):
            with self.subTest(port=port), self.assertRaises(checks.CheckFailed):
                checks.configuration({"DB_HOST": "10.0.0.2", "DB_PORT": port})
        self.assertEqual(checks.configuration({"DB_HOST": "10.0.0.2"}), ("10.0.0.2", 3306))

    def route_runner(self, *, db_dev="tun0", default_dev="eth0", diverted_public=False):
        def runner(argv, **kwargs):
            self.assertFalse(kwargs.get("shell", False))
            if argv[-2:] == ["show", "default"]:
                dev = default_dev
            elif argv[-1] == "10.0.0.2":
                dev = db_dev
            else:
                dev = "tun0" if diverted_public else default_dev
            return subprocess.CompletedProcess(argv, 0, stdout=json.dumps([{"dev": dev}]))
        return runner

    def test_routes_require_database_tunnel_and_public_default(self):
        checks.check_routes("10.0.0.2", self.route_runner())
        checks.check_routes("10.0.0.2", self.route_runner(default_dev="tap0"))
        for options in ({"db_dev": "eth0"}, {"default_dev": "tun0"}, {"diverted_public": True}):
            with self.subTest(options=options), self.assertRaises(checks.CheckFailed):
                checks.check_routes("10.0.0.2", self.route_runner(**options))

    def test_routes_fail_closed_for_missing_or_malformed_ip_output(self):
        for output in ("[]", "{}", "[1]", "broken"):
            with self.subTest(output=output), self.assertRaises(checks.CheckFailed):
                checks.route_data(["get", "10.0.0.2"], lambda *a, **k: subprocess.CompletedProcess([], 0, stdout=output))

    def test_tcp_error_is_sanitized(self):
        def unavailable(*args, **kwargs):
            raise OSError("secret test value")
        with self.assertRaises(checks.CheckFailed) as failure:
            checks.check_tcp("10.0.0.2", 3306, unavailable)
        self.assertEqual(failure.exception.error_class, "database_unreachable")

    def test_credentials_accept_private_regular_file_and_reject_symlink_or_public_file(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "credentials.json"
            source.write_text(json.dumps({"username": "fixture", "password": "fixture-password", "extra": "ignored"}))
            source.chmod(0o600)
            self.assertEqual(checks.read_credentials(source), {"username": "fixture", "password": "fixture-password"})
            alias = Path(directory) / "alias.json"
            alias.symlink_to(source)
            with self.assertRaises(checks.CheckFailed):
                checks.read_credentials(alias)
            source.chmod(0o644)
            with self.assertRaises(checks.CheckFailed):
                checks.read_credentials(source)

    def test_verification_only_runs_two_readonly_queries_and_returns_schema_metadata(self):
        queries = []
        closed = []

        class Cursor:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def execute(self, statement): queries.append(statement)
            def fetchone(self): return (1,)
            def fetchall(self): return [("z_schema",), ("a_schema",)]

        class Connection:
            def cursor(self): return Cursor()
            def close(self): closed.append(True)

        def connect(**kwargs):
            self.assertEqual(kwargs["user"], "fixture")
            self.assertEqual(kwargs["password"], "fixture-password")
            self.assertIsNone(kwargs["ssl"])
            return Connection()

        result = checks.check_database("10.0.0.2", 3306, {"username": "fixture", "password": "fixture-password"}, connect)
        self.assertEqual(queries, ["SELECT 1", "SHOW DATABASES"])
        self.assertEqual(result, {"schemaNames": ["a_schema", "z_schema"]})
        self.assertEqual(closed, [True])

    def test_database_errors_never_render_connection_messages(self):
        def denied(**kwargs):
            raise Exception(1045, "fixture-password is secret")
        with self.assertRaises(checks.CheckFailed) as failure:
            checks.check_database("10.0.0.2", 3306, {"username": "fixture", "password": "fixture-password"}, denied)
        self.assertEqual(failure.exception.error_class, "database_authentication_failed")
        self.assertNotIn("fixture-password", str(failure.exception))

    def test_route_only_mode_does_not_connect_or_load_credentials(self):
        output = io.StringIO()
        with patch.dict(os.environ, {"DB_HOST": "10.0.0.2", "DB_PORT": "3306"}), \
                patch.object(checks, "check_routes"), \
                patch.object(checks, "check_tcp", side_effect=AssertionError("must not connect")), \
                patch.object(checks, "read_credentials", side_effect=AssertionError("must not read")), \
                contextlib.redirect_stdout(output):
            self.assertEqual(checks.main(["health", "--no-connect"]), 0)
        self.assertEqual(json.loads(output.getvalue()), {"ok": True, "routes": "ready"})


if __name__ == "__main__":
    unittest.main()
