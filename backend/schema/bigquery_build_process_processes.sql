-- One row per monitored JVM process (VM flags from jinfo). Dataset: BIGQUERY_EXPORT_DATASET.

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.build_process_processes` (
  run_id STRING NOT NULL,
  pid STRING NOT NULL,
  name STRING NOT NULL,
  vm_flags ARRAY<STRING>,
  run_finished_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(run_finished_at)
CLUSTER BY run_id, name;
