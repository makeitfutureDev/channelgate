"""Run with python3 -m unittest discover -s services/vpn-image -p 'test_*.py'."""

import importlib.util
import contextlib
import io
import json
from pathlib import Path
import sys
import unittest


HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("vpn_query", HERE / "query.py")
query = importlib.util.module_from_spec(spec)
spec.loader.exec_module(query)


class Cursor:
    def __init__(self, connection):
        self.connection = connection
        self.rows = []
        self.offset = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, statement, parameters=()):
        self.connection.executed.append((statement, parameters))
        if self.connection.execute_hook:
            self.connection.execute_hook(statement, parameters)
        if "information_schema.COLUMNS" in statement:
            self.rows = [
                ("id", "int", "int unsigned", "NO", "PRI", None, ""),
                ("name", "varchar", "varchar(255)", "YES", "", None, ""),
                ("payload", "longblob", "longblob", "YES", "", None, ""),
            ]
        elif statement.startswith("SELECT /*+"):
            self.rows = [(7, "Ada", b"abc"), (8, "Grace", b"def"), (9, "Lin", b"ghi")]
        elif "information_schema.SCHEMATA" in statement:
            self.rows = [("alpha",), ("beta",)]
        else:
            self.rows = []
        self.offset = 0

    def fetchone(self):
        if self.offset >= len(self.rows):
            return None
        row = self.rows[self.offset]
        self.offset += 1
        return row


class Connection:
    def __init__(self, execute_hook=None):
        self.executed = []
        self.execute_hook = execute_hook

    def cursor(self):
        return Cursor(self)


class QueryTests(unittest.TestCase):
    def test_protocol_rejects_sql_and_malicious_identifiers(self):
        invalid = [
            {"operation": "SELECT * FROM users"},
            {"operation": "select_rows", "database": "db; DROP DATABASE x", "table": "users", "columns": ["id"]},
            {"operation": "select_rows", "database": "db", "table": "users` WHERE 1=1 --", "columns": ["id"]},
            {"operation": "select_rows", "database": "db", "table": "users", "columns": ["id", "password FROM users"]},
            {"operation": "select_rows", "database": "db", "table": "users", "columns": ["id"], "filters": [{"column": "id", "value": {"$gt": 0}}]},
            {"operation": "select_rows", "database": "db", "table": "users", "columns": ["id"], "sql": "DELETE FROM users"},
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(query.CheckFailed):
                query.normalize_request(payload)

    def test_select_uses_quoted_names_parameters_read_hint_and_hard_limit(self):
        connection = Connection()
        request = query.normalize_request({
            "operation": "select_rows", "database": "customer-db", "table": "orders",
            "columns": ["id", "name", "payload"],
            "filters": [{"column": "name", "value": "Robert'); DROP TABLE orders;--"}],
            "orderBy": {"column": "id", "direction": "desc"}, "limit": 2,
        })
        result = query.execute_request(connection, request)
        statement, parameters = next(item for item in connection.executed if item[0].startswith("SELECT /*+"))
        self.assertIn("FROM `customer-db`.`orders`", statement)
        self.assertIn("`name` <=> %s", statement)
        self.assertIn("ORDER BY `id` DESC LIMIT %s", statement)
        self.assertNotIn("Robert", statement)
        self.assertEqual(parameters[-2:], ("Robert'); DROP TABLE orders;--", 3))
        self.assertNotRegex(statement, r"\b(INSERT|UPDATE|DELETE|REPLACE|CALL|OUTFILE|LOAD_FILE)\b")
        self.assertEqual(result["rows"], [[7, "Ada", {"encoding": "base64", "data": "YWJj"}], [8, "Grace", {"encoding": "base64", "data": "ZGVm"}]])
        self.assertTrue(result["truncated"])

    def test_readonly_transaction_and_session_timeout_are_always_started(self):
        connection = Connection()
        query.begin_read_only(connection)
        self.assertEqual(connection.executed, [
            ("SET SESSION MAX_EXECUTION_TIME = %s", (query.STATEMENT_TIMEOUT_MS,)),
            ("SET SESSION TRANSACTION READ ONLY", ()),
            ("START TRANSACTION READ ONLY", ()),
        ])

    def test_mariadb_uses_its_timeout_only_for_unknown_mysql_variable(self):
        def mariadb(statement, _parameters):
            if statement.startswith("SET SESSION MAX_EXECUTION_TIME"):
                raise Exception(1193, "Unknown system variable; private server detail")

        connection = Connection(mariadb)
        query.begin_read_only(connection)
        self.assertEqual(connection.executed, [
            ("SET SESSION MAX_EXECUTION_TIME = %s", (query.STATEMENT_TIMEOUT_MS,)),
            ("SET SESSION max_statement_time = %s", (query.STATEMENT_TIMEOUT_MS / 1000,)),
            ("SET SESSION TRANSACTION READ ONLY", ()),
            ("START TRANSACTION READ ONLY", ()),
        ])

    def test_timeout_setup_fails_closed_without_broad_fallback(self):
        def denied(statement, _parameters):
            if statement.startswith("SET SESSION MAX_EXECUTION_TIME"):
                raise Exception(1227, "access denied; private server detail")

        connection = Connection(denied)
        with self.assertRaises(Exception) as failure:
            query.begin_read_only(connection)
        self.assertEqual(failure.exception.args[0], 1227)
        self.assertEqual(len(connection.executed), 1)

        def no_timeout(statement, _parameters):
            if statement.startswith("SET SESSION MAX_EXECUTION_TIME"):
                raise Exception(1193, "unknown")
            if statement.startswith("SET SESSION max_statement_time"):
                raise Exception(1193, "also unavailable; private server detail")

        connection = Connection(no_timeout)
        with self.assertRaises(query.CheckFailed) as failure:
            query.begin_read_only(connection)
        self.assertEqual(failure.exception.error_class, "statement_timeout_unavailable")
        self.assertEqual(len(connection.executed), 2)

    def test_metadata_operations_use_information_schema_and_parameters(self):
        connection = Connection()
        listed = query.execute_request(connection, query.normalize_request({"operation": "list_databases"}))
        self.assertEqual(listed["databases"], ["alpha", "beta"])
        described = query.execute_request(connection, query.normalize_request({"operation": "describe_table", "database": "db", "table": "orders"}))
        statement, parameters = next(item for item in connection.executed if "information_schema.COLUMNS" in item[0])
        self.assertNotIn("orders", statement)
        self.assertEqual(parameters, ("db", "orders"))
        self.assertEqual([item["name"] for item in described["columns"]], ["id", "name", "payload"])

    def test_output_and_error_protocol_are_bounded_and_sanitized(self):
        encoded = io.StringIO()
        with contextlib.redirect_stdout(encoded):
            query.emit({"ok": True, "operation": "select_rows", "rows": [["x" * query.MAX_OUTPUT_BYTES]]})
        self.assertEqual(json.loads(encoded.getvalue()), {"ok": False, "errorClass": "result_too_large"})
        error = Exception(1045, "password=must-not-leak")
        self.assertEqual(query.classify_database_error(error), "database_authentication_failed")
        self.assertNotIn("must-not-leak", query.classify_database_error(error))


if __name__ == "__main__":
    unittest.main()
