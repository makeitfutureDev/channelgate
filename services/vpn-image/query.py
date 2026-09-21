"""Execute a small, read-only database query protocol inside the VPN extractor.

The caller supplies structured JSON, never SQL.  Every identifier is validated and
quoted here, and every value remains a DB-API parameter.  Error details are reduced
to stable classes because driver messages can contain endpoints, SQL, or secrets.
"""

import base64
import datetime
import decimal
import json
import math
import re
import sys

from checks import CheckFailed, check_routes, configuration, read_credentials


MAX_REQUEST_BYTES = 16 * 1024
MAX_OUTPUT_BYTES = 256 * 1024
MAX_ROWS = 100
MAX_COLUMNS = 50
MAX_FILTERS = 20
MAX_METADATA_ROWS = 1000
MAX_VALUE_TEXT = 4096
STATEMENT_TIMEOUT_MS = 15_000
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_$-]{0,63}\Z")

TEXT_TYPES = {
    "char", "varchar", "tinytext", "text", "mediumtext", "longtext",
    "enum", "set", "json",
}
BINARY_TYPES = {
    "binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob",
    "geometry", "point", "linestring", "polygon", "multipoint",
    "multilinestring", "multipolygon", "geometrycollection",
}


def fail(error_class):
    raise CheckFailed(error_class)


def identifier(value, error_class):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        fail(error_class)
    return value


def quote_identifier(value):
    # Validation deliberately excludes backticks.  Keep quoting here as a second,
    # local invariant so later edits cannot accidentally turn a name into syntax.
    return "`" + value.replace("`", "``") + "`"


def scalar(value):
    if value is None or isinstance(value, (str, bool, int)):
        if isinstance(value, str) and len(value) > MAX_VALUE_TEXT:
            fail("invalid_filter_value")
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    fail("invalid_filter_value")


def normalize_request(value):
    if not isinstance(value, dict):
        fail("invalid_request")
    allowed = {"operation", "database", "table", "columns", "filters", "orderBy", "limit"}
    if set(value) - allowed:
        fail("invalid_request")
    operation = value.get("operation")
    if operation not in {"list_databases", "list_tables", "describe_table", "select_rows"}:
        fail("invalid_operation")
    fields = {
        "list_databases": {"operation"},
        "list_tables": {"operation", "database"},
        "describe_table": {"operation", "database", "table"},
        "select_rows": allowed,
    }[operation]
    if set(value) - fields:
        fail("invalid_request")
    request = {"operation": operation}
    if operation != "list_databases":
        request["database"] = identifier(value.get("database"), "invalid_database")
    if operation in {"describe_table", "select_rows"}:
        request["table"] = identifier(value.get("table"), "invalid_table")
    if operation == "select_rows":
        columns = value.get("columns")
        if not isinstance(columns, list) or not 1 <= len(columns) <= MAX_COLUMNS:
            fail("invalid_columns")
        request["columns"] = [identifier(item, "invalid_column") for item in columns]
        if len(set(request["columns"])) != len(request["columns"]):
            fail("invalid_columns")

        filters = value.get("filters", [])
        if not isinstance(filters, list) or len(filters) > MAX_FILTERS:
            fail("invalid_filters")
        normalized_filters = []
        for item in filters:
            if not isinstance(item, dict) or set(item) != {"column", "value"}:
                fail("invalid_filters")
            normalized_filters.append({
                "column": identifier(item["column"], "invalid_filter_column"),
                "value": scalar(item["value"]),
            })
        request["filters"] = normalized_filters

        order = value.get("orderBy")
        if order is not None:
            if not isinstance(order, dict) or set(order) != {"column", "direction"}:
                fail("invalid_order")
            direction = order["direction"]
            if direction not in {"asc", "desc"}:
                fail("invalid_order")
            request["orderBy"] = {
                "column": identifier(order["column"], "invalid_order_column"),
                "direction": direction,
            }
        limit = value.get("limit", MAX_ROWS)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_ROWS:
            fail("invalid_limit")
        request["limit"] = limit
    return request


def connection_options(host, port, credentials):
    import pymysql

    return {
        "host": host,
        "port": port,
        "user": credentials["username"],
        "password": credentials["password"],
        "connect_timeout": 8,
        "read_timeout": 20,
        "write_timeout": 8,
        "charset": "utf8mb4",
        "autocommit": False,
        "ssl": None,
        "cursorclass": pymysql.cursors.SSCursor,
    }


def begin_read_only(connection):
    with connection.cursor() as cursor:
        try:
            cursor.execute("SET SESSION MAX_EXECUTION_TIME = %s", (STATEMENT_TIMEOUT_MS,))
        except Exception as error:
            # MariaDB does not implement MySQL's MAX_EXECUTION_TIME variable and
            # reports ER_UNKNOWN_SYSTEM_VARIABLE (1193). Fall back only for that
            # exact incompatibility; permission, transport, and all other errors
            # must still abort before the read-only transaction starts.
            code = error.args[0] if getattr(error, "args", None) and isinstance(error.args[0], int) else None
            if code != 1193:
                raise
            try:
                cursor.execute("SET SESSION max_statement_time = %s", (STATEMENT_TIMEOUT_MS / 1000,))
            except Exception:
                raise CheckFailed("statement_timeout_unavailable") from None
        cursor.execute("SET SESSION TRANSACTION READ ONLY")
        cursor.execute("START TRANSACTION READ ONLY")


def fetch_rows(connection, statement, parameters=(), maximum=MAX_METADATA_ROWS):
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters)
        rows = []
        for _ in range(maximum + 1):
            row = cursor.fetchone()
            if row is None:
                break
            rows.append(row)
        return rows[:maximum], len(rows) > maximum


def table_columns(connection, database, table):
    rows, truncated = fetch_rows(
        connection,
        "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, "
        "COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s ORDER BY ORDINAL_POSITION LIMIT 1001",
        (database, table),
    )
    if truncated:
        fail("table_metadata_too_large")
    if not rows:
        fail("table_not_found")
    return rows


def normalize_value(value):
    if value is None or isinstance(value, (str, bool, int)):
        if isinstance(value, str) and len(value) > MAX_VALUE_TEXT:
            return value[:MAX_VALUE_TEXT], True
        return value, False
    if isinstance(value, float):
        return (value if math.isfinite(value) else str(value)), False
    if isinstance(value, decimal.Decimal):
        return str(value), False
    if isinstance(value, (datetime.date, datetime.time, datetime.datetime)):
        return value.isoformat(), False
    if isinstance(value, datetime.timedelta):
        return str(value), False
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        clipped = raw[:MAX_VALUE_TEXT]
        return {"encoding": "base64", "data": base64.b64encode(clipped).decode("ascii")}, len(raw) > len(clipped)
    text = str(value)
    return text[:MAX_VALUE_TEXT], len(text) > MAX_VALUE_TEXT


def select_rows(connection, request, metadata=None):
    metadata = metadata if metadata is not None else table_columns(connection, request["database"], request["table"])
    types = {str(row[0]): str(row[1]).lower() for row in metadata}
    referenced = set(request["columns"])
    referenced.update(item["column"] for item in request["filters"])
    if request.get("orderBy"):
        referenced.add(request["orderBy"]["column"])
    if not referenced.issubset(types):
        fail("column_not_found")

    parameters = []
    selections = []
    for name in request["columns"]:
        quoted = quote_identifier(name)
        if types[name] in TEXT_TYPES:
            selections.append(f"LEFT(CAST({quoted} AS CHAR), %s) AS {quoted}")
            parameters.append(MAX_VALUE_TEXT + 1)
        elif types[name] in BINARY_TYPES:
            selections.append(f"LEFT({quoted}, %s) AS {quoted}")
            parameters.append(MAX_VALUE_TEXT + 1)
        else:
            selections.append(quoted)

    where = []
    for item in request["filters"]:
        where.append(f"{quote_identifier(item['column'])} <=> %s")
        parameters.append(item["value"])
    order = ""
    if request.get("orderBy"):
        order = " ORDER BY " + quote_identifier(request["orderBy"]["column"]) + " " + request["orderBy"]["direction"].upper()
    statement = (
        "SELECT /*+ MAX_EXECUTION_TIME(15000) */ " + ", ".join(selections) +
        " FROM " + quote_identifier(request["database"]) + "." + quote_identifier(request["table"]) +
        ((" WHERE " + " AND ".join(where)) if where else "") + order + " LIMIT %s"
    )
    parameters.append(request["limit"] + 1)
    raw_rows, _ = fetch_rows(connection, statement, tuple(parameters), request["limit"] + 1)
    overflow = len(raw_rows) > request["limit"]
    raw_rows = raw_rows[:request["limit"]]
    rows = []
    truncated_cells = 0
    base = {
        "ok": True,
        "operation": "select_rows",
        "database": request["database"],
        "table": request["table"],
        "columns": request["columns"],
    }
    for raw in raw_rows:
        normalized = []
        row_truncated_cells = 0
        for value in raw:
            item, clipped = normalize_value(value)
            normalized.append(item)
            row_truncated_cells += int(clipped)
        candidate = {**base, "rows": rows + [normalized], "truncated": overflow,
                     "truncatedCells": truncated_cells + row_truncated_cells}
        if len(json.dumps(candidate, ensure_ascii=True, separators=(",", ":")).encode("utf-8")) > MAX_OUTPUT_BYTES:
            overflow = True
            break
        rows.append(normalized)
        truncated_cells += row_truncated_cells
    return {**base, "rows": rows, "truncated": overflow or len(rows) < len(raw_rows), "truncatedCells": truncated_cells}


def execute_request(connection, request):
    operation = request["operation"]
    if operation == "list_databases":
        rows, truncated = fetch_rows(
            connection,
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME LIMIT 1001",
        )
        return {"ok": True, "operation": operation, "databases": [str(row[0]) for row in rows], "truncated": truncated}
    if operation == "list_tables":
        rows, truncated = fetch_rows(
            connection,
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s "
            "AND TABLE_TYPE IN ('BASE TABLE', 'VIEW') ORDER BY TABLE_NAME LIMIT 1001",
            (request["database"],),
        )
        return {"ok": True, "operation": operation, "database": request["database"], "tables": [str(row[0]) for row in rows], "truncated": truncated}
    metadata = table_columns(connection, request["database"], request["table"])
    if operation == "describe_table":
        columns = []
        for row in metadata:
            default, _ = normalize_value(row[5])
            columns.append({
                "name": str(row[0]), "dataType": str(row[1]), "columnType": str(row[2]),
                "nullable": str(row[3]) == "YES", "key": str(row[4] or ""),
                "default": default, "extra": str(row[6] or ""),
            })
        return {"ok": True, "operation": operation, "database": request["database"], "table": request["table"], "columns": columns}
    return select_rows(connection, request, metadata)


def classify_database_error(error):
    code = error.args[0] if getattr(error, "args", None) and isinstance(error.args[0], int) else None
    if code == 1045:
        return "database_authentication_failed"
    if code in (1044, 1142, 1227):
        return "database_access_denied"
    if code == 1049:
        return "database_not_found"
    if code in (1969, 3024):
        return "query_timed_out"
    return "database_connection_or_query_failed"


def query(request, connect=None, environ=None):
    request = normalize_request(request)
    host, port = configuration(environ if environ is not None else __import__("os").environ)
    check_routes(host)
    credentials = read_credentials()
    if connect is None:
        import pymysql
        connect = pymysql.connect
    connection = None
    try:
        connection = connect(**connection_options(host, port, credentials))
        begin_read_only(connection)
        return execute_request(connection, request)
    except CheckFailed:
        raise
    except Exception as error:
        raise CheckFailed(classify_database_error(error)) from None
    finally:
        if connection is not None:
            try:
                connection.rollback()
            except Exception:
                pass
            try:
                connection.close()
            except Exception:
                pass


def emit(value):
    payload = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    if len(payload.encode("utf-8")) > MAX_OUTPUT_BYTES:
        payload = json.dumps({"ok": False, "errorClass": "result_too_large"}, separators=(",", ":"))
    print(payload)


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            fail("request_too_large")
        request = json.loads(raw.decode("utf-8"))
        emit(query(request))
        return 0
    except CheckFailed as error:
        emit({"ok": False, "errorClass": error.error_class})
        return 1
    except (ValueError, UnicodeError):
        emit({"ok": False, "errorClass": "invalid_request"})
        return 1
    except Exception:
        emit({"ok": False, "errorClass": "database_query_failed"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
