CREATE TABLE IF NOT EXISTS evse_house_schema_versions (
 version INT NOT NULL PRIMARY KEY, checksum BINARY(32) NOT NULL, applied_at DATETIME(6) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS evse_house_samples (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 source VARBINARY(240) NOT NULL, publisher_id BINARY(16) NOT NULL, sequence INT UNSIGNED NOT NULL,
 fetched_at DATETIME(6) NOT NULL, received_at DATETIME(6) NOT NULL,
 status ENUM('ok','error') NOT NULL, last_success_at DATETIME(6) NULL,
 power_w DECIMAL(24,6) NULL, error_code ENUM('read_failed','startup','stale','clock_error') NULL,
 retained TINYINT(1) NOT NULL, digest BINARY(32) NOT NULL,
 UNIQUE KEY observation (source,publisher_id,sequence),
 KEY sample_time (source,fetched_at,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS evse_house_events (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 source VARBINARY(240) NOT NULL, event_id BINARY(16) NOT NULL,
 kind ENUM('availability','collector_started','broker_connected','broker_disconnected','ingestion_gap','collector_stopping') NOT NULL,
 received_at DATETIME(6) NOT NULL, retained TINYINT(1) NOT NULL,
 availability ENUM('online','offline') NULL, details VARCHAR(1024) NOT NULL,
 UNIQUE KEY event_identity (source,event_id), KEY event_time (source,received_at,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS evse_house_buckets (
 source VARBINARY(240) NOT NULL, level ENUM('minute','hour','day') NOT NULL,
 bucket_start DATETIME(6) NOT NULL, bucket_end DATETIME(6) NOT NULL,
 samples BIGINT UNSIGNED NOT NULL, valid_count BIGINT UNSIGNED NOT NULL, null_count BIGINT UNSIGNED NOT NULL,
 sum_w DECIMAL(38,6) NULL, min_w DECIMAL(24,6) NULL, max_w DECIMAL(24,6) NULL,
 first_w DECIMAL(24,6) NULL, last_w DECIMAL(24,6) NULL,
 first_at DATETIME(6) NULL, last_at DATETIME(6) NULL,
 coverage_ms BIGINT UNSIGNED NOT NULL, has_gap TINYINT(1) NOT NULL, complete TINYINT(1) NOT NULL,
 PRIMARY KEY (source,level,bucket_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS evse_house_work (
 source VARBINARY(240) NOT NULL, level ENUM('minute','hour','day') NOT NULL,
 bucket_start DATETIME(6) NOT NULL, generation BIGINT UNSIGNED NOT NULL,
 processed_generation BIGINT UNSIGNED NOT NULL, pending TINYINT(1) NOT NULL,
 PRIMARY KEY (source,level,bucket_start), KEY pending_work (source,pending,level,bucket_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
