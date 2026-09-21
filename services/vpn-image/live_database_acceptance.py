#!/usr/bin/env python3
"""Synthetic MariaDB acceptance for the restricted database query protocol.

Host mode creates an isolated temporary Podman network and MariaDB container,
runs the assertions inside the ChannelGate VPN image's Python environment, and
removes its own resources.  It uses generated fixture credentials and data only.

Run as the rootless service user from the repository root:
  python3 services/vpn-image/live_database_acceptance.py
"""

import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time


MARIADB_IMAGE = os.environ.get("CG_ACCEPT_MARIADB_IMAGE", "docker.io/library/mariadb:11.4")
VPN_IMAGE = os.environ.get("CG_ACCEPT_VPN_IMAGE", "localhost/channelgate/vpn:2")


def run(argv, *, input_text=None, check=True, timeout=120):
    result = subprocess.run(
        argv,
        input=input_text,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"acceptance command failed: {Path(argv[0]).name} {argv[1] if len(argv) > 1 else ''}")
    return result


def wait_for_database(podman, container, password):
    for _ in range(60):
        result = run(
            [podman, "exec", container, "mariadb", "-uroot", f"-p{password}", "--skip-column-names", "-e", "SELECT 1"],
            check=False,
            timeout=10,
        )
        if result.returncode == 0:
            return
        state = run([podman, "inspect", "--format", "{{.State.Status}}", container], check=False, timeout=10)
        if state.returncode == 0 and state.stdout.strip() in {"exited", "dead"}:
            raise RuntimeError("synthetic MariaDB exited before becoming ready")
        time.sleep(1)
    raise RuntimeError("synthetic MariaDB did not become ready")


def host_main(podman):
    source = Path(__file__).resolve().parent
    suffix = secrets.token_hex(6)
    network = f"cg-db-accept-{suffix}"
    database_container = f"cg-db-accept-db-{suffix}"
    query_container = f"cg-db-accept-query-{suffix}"
    root_password = f"root-{secrets.token_hex(12)}"
    reader_password = f"reader-{secrets.token_hex(12)}"
    writer_password = f"writer-{secrets.token_hex(12)}"
    created_network = False
    created_database = False
    try:
        if run([podman, "image", "exists", MARIADB_IMAGE], check=False).returncode != 0:
            run([podman, "pull", MARIADB_IMAGE], timeout=600)
        if run([podman, "image", "exists", VPN_IMAGE], check=False).returncode != 0:
            raise RuntimeError(f"build {VPN_IMAGE} before running database acceptance")
        run([podman, "network", "create", network])
        created_network = True
        run([
            podman, "run", "-d", "--name", database_container, "--network", network,
            "--security-opt=no-new-privileges", "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=DAC_OVERRIDE",
            "--cap-add=SETGID", "--cap-add=SETUID", "--memory=512m", "--pids-limit=256",
            "-e", f"MARIADB_ROOT_PASSWORD={root_password}", "-e", "MARIADB_DATABASE=acceptance",
            MARIADB_IMAGE,
        ])
        created_database = True
        wait_for_database(podman, database_container, root_password)
        injection = "Robert'); DROP TABLE records;--"
        seed = """
CREATE USER 'reader'@'%' IDENTIFIED BY '{reader_password}';
GRANT SELECT ON acceptance.* TO 'reader'@'%';
CREATE USER 'writer'@'%' IDENTIFIED BY '{writer_password}';
GRANT ALL PRIVILEGES ON acceptance.* TO 'writer'@'%';
CREATE TABLE acceptance.records (
  id INT PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  created_on DATE NOT NULL,
  note LONGTEXT,
  payload LONGBLOB
);
INSERT INTO acceptance.records VALUES
  (1, TRUE, 12.50, '2026-09-21', '{injection}', X'000102'),
  (2, FALSE, 99.25, '2026-09-22', REPEAT('x', 5000), REPEAT(X'AB', 5000));
""".format(reader_password=reader_password.replace("'", "''"), writer_password=writer_password.replace("'", "''"), injection=injection.replace("'", "''"))
        seeded = run(
            [podman, "exec", "-i", database_container, "mariadb", "-uroot", f"-p{root_password}"],
            input_text=seed,
            check=False,
            timeout=60,
        )
        if seeded.returncode != 0:
            detail = (seeded.stdout + "\n" + seeded.stderr)[-2000:]
            for secret in (root_password, reader_password, writer_password):
                detail = detail.replace(secret, "[synthetic-secret]")
            raise RuntimeError(f"synthetic database seed failed:\n{detail.strip()}")
        result = run([
            podman, "run", "--rm", "--name", query_container, "--network", network,
            "--security-opt=no-new-privileges", "--cap-drop=ALL", "--read-only", "--memory=256m", "--pids-limit=128",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=16m", "--entrypoint=python3",
            "-e", f"CG_ACCEPT_DB_HOST={database_container}", "-e", "CG_ACCEPT_DB_PORT=3306",
            "-e", f"CG_ACCEPT_WRITER_PASSWORD={writer_password}", "-e", f"CG_ACCEPT_READER_PASSWORD={reader_password}",
            "-v", f"{source}:/accept:ro", VPN_IMAGE, "/accept/live_database_acceptance.py", "--inside",
        ], check=False, timeout=120)
        if result.returncode != 0:
            detail = (result.stdout + "\n" + result.stderr)[-2000:]
            for secret in (root_password, reader_password, writer_password):
                detail = detail.replace(secret, "[synthetic-secret]")
            raise RuntimeError(f"synthetic database assertions failed:\n{detail.strip()}")
        evidence = json.loads(result.stdout)
        if evidence.get("ok") is not True:
            raise RuntimeError("synthetic database assertions did not pass")
        print(json.dumps(evidence, separators=(",", ":")))
    finally:
        run([podman, "rm", "--force", query_container], check=False, timeout=30)
        if created_database:
            run([podman, "rm", "--force", database_container], check=False, timeout=30)
        if created_network:
            run([podman, "network", "rm", network], check=False, timeout=30)


def connect(pymysql, *, user, password):
    return pymysql.connect(
        host=os.environ["CG_ACCEPT_DB_HOST"],
        port=int(os.environ.get("CG_ACCEPT_DB_PORT", "3306")),
        user=user,
        password=password,
        database="acceptance",
        connect_timeout=8,
        read_timeout=20,
        write_timeout=8,
        charset="utf8mb4",
        autocommit=False,
        ssl=None,
        cursorclass=pymysql.cursors.SSCursor,
    )


def inside_main():
    sys.path.insert(0, "/accept")
    import pymysql
    import query as database_query

    writer_password = os.environ["CG_ACCEPT_WRITER_PASSWORD"]
    reader_password = os.environ["CG_ACCEPT_READER_PASSWORD"]

    # Prove the transaction posture itself blocks a writer that otherwise has full privileges.
    writer = connect(pymysql, user="writer", password=writer_password)
    try:
        database_query.STATEMENT_TIMEOUT_MS = 200
        database_query.begin_read_only(writer)
        with writer.cursor() as cursor:
            try:
                cursor.execute("INSERT INTO records(id,enabled,amount,created_on) VALUES (99,1,1.00,'2026-09-21')")
                raise AssertionError("read-only transaction accepted INSERT")
            except pymysql.MySQLError as error:
                if error.args[0] not in (1792,):
                    raise
            started = time.monotonic()
            try:
                cursor.execute("SELECT SLEEP(2)")
                cursor.fetchone()
                raise AssertionError("statement timeout did not interrupt SLEEP")
            except pymysql.MySQLError as error:
                if error.args[0] not in (1969, 3024):
                    raise
            if time.monotonic() - started > 1.5:
                raise AssertionError("statement timeout exceeded acceptance bound")
    finally:
        writer.rollback()
        writer.close()

    reader = connect(pymysql, user="reader", password=reader_password)
    try:
        database_query.STATEMENT_TIMEOUT_MS = 15_000
        database_query.begin_read_only(reader)
        databases = database_query.execute_request(reader, database_query.normalize_request({"operation": "list_databases"}))
        if "acceptance" not in databases["databases"]:
            raise AssertionError("fixture database was not listed")
        tables = database_query.execute_request(reader, database_query.normalize_request({"operation": "list_tables", "database": "acceptance"}))
        if tables["tables"] != ["records"]:
            raise AssertionError("fixture table listing mismatch")
        described = database_query.execute_request(reader, database_query.normalize_request({
            "operation": "describe_table", "database": "acceptance", "table": "records",
        }))
        if [column["name"] for column in described["columns"]] != ["id", "enabled", "amount", "created_on", "note", "payload"]:
            raise AssertionError("fixture table description mismatch")

        injection = "Robert'); DROP TABLE records;--"
        selected = database_query.execute_request(reader, database_query.normalize_request({
            "operation": "select_rows", "database": "acceptance", "table": "records",
            "columns": ["id", "enabled", "amount", "created_on", "note", "payload"],
            "filters": [{"column": "note", "value": injection}], "limit": 10,
        }))
        if selected["rows"] != [[1, 1, "12.50", "2026-09-21", injection, {"encoding": "base64", "data": "AAEC"}]]:
            raise AssertionError("typed or injection-as-data selection mismatch")

        large = database_query.execute_request(reader, database_query.normalize_request({
            "operation": "select_rows", "database": "acceptance", "table": "records",
            "columns": ["note", "payload"], "filters": [{"column": "id", "value": 2}], "limit": 1,
        }))
        if len(large["rows"][0][0]) != database_query.MAX_VALUE_TEXT:
            raise AssertionError("large text was not truncated to the cell bound")
        blob = large["rows"][0][1]
        if blob.get("encoding") != "base64" or len(blob.get("data", "")) != 5464 or large["truncatedCells"] != 2:
            raise AssertionError("large binary cell truncation mismatch")
    finally:
        reader.rollback()
        reader.close()

    print(json.dumps({
        "ok": True,
        "database": "synthetic-mariadb",
        "checks": ["readonly-transaction", "statement-timeout", "list", "describe", "typed-select", "injection-as-data", "large-cell-bounds"],
        "rowsRead": 2,
    }, separators=(",", ":")))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inside", action="store_true")
    parser.add_argument("--podman", default=os.environ.get("CG_ACCEPT_PODMAN", "/usr/bin/podman"))
    args = parser.parse_args()
    if args.inside:
        inside_main()
    else:
        host_main(args.podman)


if __name__ == "__main__":
    main()
