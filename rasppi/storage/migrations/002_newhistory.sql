CREATE TABLE IF NOT EXISTS evse_history_buckets (
  source VARBINARY(240) NOT NULL,
  resolution_seconds INT UNSIGNED NOT NULL,
  bucket_start DATETIME(6) NOT NULL,
  data_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (JSON_VALID(data_json)),
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (source,resolution_seconds,bucket_start)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS evse_history_work (
  source VARBINARY(240) NOT NULL,
  resolution_seconds INT UNSIGNED NOT NULL,
  bucket_start DATETIME(6) NOT NULL,
  generation BIGINT UNSIGNED NOT NULL,
  done_generation BIGINT UNSIGNED NOT NULL,
  pending TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (source,resolution_seconds,bucket_start),
  KEY pending_work (source,pending,resolution_seconds,bucket_start)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS evse_history_state (
  source VARBINARY(240) NOT NULL PRIMARY KEY,
  algorithm_version INT UNSIGNED NOT NULL,
  sample_cursor BIGINT UNSIGNED NOT NULL,
  sample_highwater BIGINT UNSIGNED NOT NULL,
  samples_done TINYINT UNSIGNED NOT NULL,
  events_done TINYINT UNSIGNED NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  initialized TINYINT UNSIGNED NOT NULL,
  event_cursor_at DATETIME(6) NOT NULL,
  event_cursor_id BINARY(16) NOT NULL,
  event_highwater_at DATETIME(6) NOT NULL,
  event_highwater_id BINARY(16) NOT NULL,
  invalidate_from DATETIME(6) NULL,
  invalidate_cursor DATETIME(6) NULL
) ENGINE=InnoDB;
