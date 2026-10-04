import hashlib
from pathlib import Path
import re
import pymysql
from .protocol import MEASUREMENT_COLUMNS

SAMPLE_TYPES = {
    "id": "bigint unsigned", "source": "varbinary(240)", "payload_sha256": "binary(32)",
    "measured_at": "datetime(6)", "received_at": "datetime(6)", "last_success_at": "datetime(6)",
    "retained": "tinyint(1)", "status": "enum('ok','error')", "communication_error": "varchar(1024)",
    "payload_json": "longtext",
    **{k: "int unsigned" for k in ("error_code", "socket_lock_state", "charging_state_raw", "charging_state", "active_power_w", "session_energy_wh")},
    **{k: "tinyint(1)" for k in ("below_commanded_current", "plugged_in", "charging")},
    **{k: "decimal(14,3)" for k in ("current_limit_a", "current_l1_a", "current_l2_a", "current_l3_a")},
    **{k: "decimal(14,1)" for k in ("voltage_l1_v", "voltage_l2_v", "voltage_l3_v")},
}
TABLES = {
    "evse_schema_versions": ({"version": "int", "applied_at": "datetime(6)"}, set(), {("version",)}),
    "evse_wallbox_samples": (SAMPLE_TYPES, set(MEASUREMENT_COLUMNS) | {"last_success_at", "communication_error"}, {("id",), ("source", "payload_sha256")}),
    "evse_ingest_events": ({"event_id": "binary(16)", "source": "varbinary(240)", "received_at": "datetime(6)",
                           "kind": "enum('availability','collector_started','broker_connected','broker_disconnected','ingestion_gap','collector_stopping')",
                           "availability": "enum('online','offline')", "retained": "tinyint(1)", "details_json": "longtext"},
                          {"availability"}, {("event_id",)}),
}


class Database:
    def __init__(self, config):
        self.config = config
        self.connection = None

    def connect(self):
        c = self.config
        self.connection = pymysql.connect(host=c.db_host, port=c.db_port, user=c.db_user, password=c.db_password,
                                          database=c.db_name, charset="utf8mb4", autocommit=False,
                                          connect_timeout=c.timeout, read_timeout=c.timeout, write_timeout=c.timeout)
        with self.connection.cursor() as cursor:
            cursor.execute("SET time_zone = '+00:00'")
            cursor.execute("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE'")

    def close(self):
        if self.connection:
            self.connection.close()
            self.connection = None

    def verify(self):
        self.verify_shape()
        with self.connection.cursor() as cursor:
            cursor.execute("SELECT version FROM evse_schema_versions ORDER BY version")
            if cursor.fetchall() != ((1,),):
                raise ValueError("Unsupported database schema; run migration explicitly")
            cursor.execute("SELECT " + ",".join(MEASUREMENT_COLUMNS) + " FROM evse_wallbox_samples LIMIT 0")
            cursor.execute("SELECT event_id,details_json FROM evse_ingest_events LIMIT 0")
        self.connection.commit()

    def verify_shape(self, names=None):
        # IF NOT EXISTS alone must not bless a foreign/incomplete table. In
        # particular, losing binary source identity or UNIQUE keys breaks retries.
        with self.connection.cursor(pymysql.cursors.DictCursor) as cursor:
            for name in names or TABLES:
                types, nullable, unique = TABLES[name]
                cursor.execute("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s", (self.config.db_name, name))
                row = cursor.fetchone()
                if not row or row["ENGINE"] != "InnoDB":
                    raise ValueError("Incompatible table engine")
                cursor.execute("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA,CHARACTER_SET_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s", (self.config.db_name, name))
                columns = {r["COLUMN_NAME"]: r for r in cursor.fetchall()}
                if set(columns) != set(types):
                    raise ValueError("Incompatible table columns")
                for key, expected in types.items():
                    col = columns[key]
                    actual = col["COLUMN_TYPE"]
                    if expected in ("int", "int unsigned", "bigint unsigned"):
                        actual = re.sub(r"\(\d+\)", "", actual)
                    if actual != expected or (col["IS_NULLABLE"] == "YES") != (key in nullable):
                        raise ValueError("Incompatible column type/nullability")
                    if col["EXTRA"] != ("auto_increment" if key == "id" else ""):
                        raise ValueError("Incompatible generated column")
                    if col["CHARACTER_SET_NAME"] not in (None, "utf8mb4"):
                        raise ValueError("Incompatible text encoding")
                cursor.execute("SELECT INDEX_NAME,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND NON_UNIQUE=0 ORDER BY INDEX_NAME,SEQ_IN_INDEX", (self.config.db_name, name))
                indexes = {}
                for row in cursor.fetchall():
                    if row["SUB_PART"] is not None:
                        raise ValueError("Incompatible prefix identity")
                    indexes.setdefault(row["INDEX_NAME"], []).append(row["COLUMN_NAME"])
                if {tuple(cols) for cols in indexes.values()} != unique:
                    raise ValueError("Incompatible UNIQUE identities")

    def migrate(self):
        lock = "evse-schema-" + hashlib.sha256(self.config.db_name.encode()).hexdigest()[:40]
        try:
            with self.connection.cursor() as cursor:
                cursor.execute("SELECT GET_LOCK(%s, 10)", (lock,))
                if cursor.fetchone()[0] != 1:
                    raise ValueError("Migration is already running")
                cursor.execute("CREATE TABLE IF NOT EXISTS evse_schema_versions (version INT NOT NULL PRIMARY KEY, applied_at DATETIME(6) NOT NULL) ENGINE=InnoDB")
                self.verify_shape(["evse_schema_versions"])
                cursor.execute("SELECT version FROM evse_schema_versions ORDER BY version")
                versions = cursor.fetchall()
                if versions == ((1,),):
                    self.verify_shape()
                    self.connection.commit()
                    return
                if versions:
                    raise ValueError("Unsupported database version")
                sql = (Path(__file__).resolve().parent.parent / "migrations/001_initial.sql").read_text()
                for statement in sql.split(";"):
                    if statement.strip():
                        cursor.execute(statement)
                self.verify_shape()
                cursor.execute("INSERT INTO evse_schema_versions (version, applied_at) VALUES (1, UTC_TIMESTAMP(6))")
                self.connection.commit()
        finally:
            with self.connection.cursor() as cursor:
                cursor.execute("SELECT RELEASE_LOCK(%s)", (lock,))

    def write(self, item):
        try:
            with self.connection.cursor() as cursor:
                if item["kind"] == "sample":
                    sample = item["sample"]
                    columns = "source,payload_sha256,measured_at,received_at,last_success_at,retained,status,communication_error," + ",".join(MEASUREMENT_COLUMNS) + ",payload_json"
                    values = [item["source"], sample["hash"], sample["measured_at"], item["received_at"], sample["last_success_at"],
                              item["retained"], sample["status"], sample["error"], *sample["columns"], sample["payload"]]
                    cursor.execute(f"INSERT INTO evse_wallbox_samples ({columns}) VALUES ({','.join(['%s'] * len(values))})", values)
                else:
                    cursor.execute("INSERT INTO evse_ingest_events (event_id,source,received_at,kind,availability,retained,details_json) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                                   (item["id"], item["source"], item["received_at"], item["kind"], item.get("availability"), item["retained"], item["details"]))
            self.connection.commit()
            return True
        except pymysql.IntegrityError as error:
            self.connection.rollback()
            if error.args[0] != 1062:
                raise
            # Only two UNIQUE identities exist (sample hash/event UUID). Confirm
            # the intended row rather than masking unrelated constraint failures.
            with self.connection.cursor() as cursor:
                if item["kind"] == "sample":
                    cursor.execute("SELECT 1 FROM evse_wallbox_samples WHERE source=%s AND payload_sha256=%s", (item["source"], item["sample"]["hash"]))
                else:
                    cursor.execute("SELECT 1 FROM evse_ingest_events WHERE event_id=%s", (item["id"],))
                if cursor.fetchone() is None:
                    raise
            self.connection.commit()
            return False
