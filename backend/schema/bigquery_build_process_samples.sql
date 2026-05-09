-- One row per monitoring sample. Create in your analytics project (or same as Firestore).
-- Dataset: set BIGQUERY_EXPORT_DATASET to this dataset id.

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.build_process_samples` (
  run_id STRING NOT NULL,
  sample_timestamp TIMESTAMP NOT NULL,
  elapsed_time INT64 NOT NULL,
  pid STRING NOT NULL,
  name STRING NOT NULL,
  heap_used INT64 NOT NULL,
  heap_cap INT64 NOT NULL,
  rss INT64 NOT NULL,
  gc_time INT64 NOT NULL,
  run_finished_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(sample_timestamp)
CLUSTER BY run_id, name;
