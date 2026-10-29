CREATE TABLE IF NOT EXISTS evse_minute_schema_versions (
 version INT NOT NULL PRIMARY KEY,
 checksum BINARY(32) NOT NULL,
 applied_at DATETIME(6) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS evse_minute_sources (
 kind ENUM('wallbox','house') NOT NULL,
 source VARBINARY(240) NOT NULL,
 started_at DATETIME(6) NOT NULL,
 PRIMARY KEY(kind,source)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS evse_minute_records (
 kind ENUM('wallbox','house') NOT NULL,
 source VARBINARY(240) NOT NULL,
 bucket_start DATETIME(6) NOT NULL,
 data_json LONGTEXT CHARACTER SET utf8mb4 NOT NULL,
 digest BINARY(32) NOT NULL,
 PRIMARY KEY(kind,source,bucket_start)
) ENGINE=InnoDB;
