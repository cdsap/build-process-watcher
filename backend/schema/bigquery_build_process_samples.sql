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
  jit_compiled_methods INT64,
  jit_failed_compilations INT64,
  jit_invalidated_compilations INT64,
  jit_compilation_time_ms INT64,
  classes_loaded INT64,
  classes_unloaded INT64,
  class_load_time_ms INT64,
  run_finished_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(sample_timestamp)
CLUSTER BY run_id, name;

-- Existing datasets: these additive statements are safe to run repeatedly.
ALTER TABLE `YOUR_PROJECT.YOUR_DATASET.build_process_samples` ADD COLUMN IF NOT EXISTS jit_compiled_methods INT64;
ALTER TABLE `YOUR_PROJECT.YOUR_DATASET.build_process_samples` ADD COLUMN IF NOT EXISTS jit_failed_compilations INT64;
ALTER TABLE `YOUR_PROJECT.YOUR_DATASET.build_process_samples` ADD COLUMN IF NOT EXISTS jit_invalidated_compilations INT64;
ALTER TABLE `YOUR_PROJECT.YOUR_DATASET.build_process_samples` ADD COLUMN IF NOT EXISTS jit_compilation_time_ms INT64;
ALTER TABLE `YOUR_PROJECT.YOUR_DATASET.build_process_samples` ADD COLUMN IF NOT EXISTS classes_loaded INT64;
ALTER TABLE `YOUR_PROJECT.YOUR_DATASET.build_process_samples` ADD COLUMN IF NOT EXISTS classes_unloaded INT64;
ALTER TABLE `YOUR_PROJECT.YOUR_DATASET.build_process_samples` ADD COLUMN IF NOT EXISTS class_load_time_ms INT64;
