-- Disposable, isolated test database ONLY. No production accounts or credentials.
USE evse_history_test;
CREATE TABLE evse_schema_versions (
  version INT NOT NULL PRIMARY KEY,
  applied_at DATETIME(6) NOT NULL
) ENGINE=InnoDB;
INSERT INTO evse_schema_versions (version, applied_at) VALUES (1, UTC_TIMESTAMP(6));
CREATE USER 'history_reader'@'%' IDENTIFIED BY 'dummy-only-reader';
GRANT SELECT ON evse_history_test.evse_schema_versions TO 'history_reader'@'%';
GRANT SELECT ON evse_history_test.evse_wallbox_samples TO 'history_reader'@'%';
GRANT SELECT ON evse_history_test.evse_ingest_events TO 'history_reader'@'%';
-- Explicit opt-in compatibility only: production may temporarily choose its writer.
CREATE USER 'history_writer'@'%' IDENTIFIED BY 'dummy-only-writer';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP
  ON evse_history_test.* TO 'history_writer'@'%';
