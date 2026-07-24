.PHONY: run run-emulator build deploy clean test test-race test-coverage test-integration test-all benchmark

# Environment variables (provided by GitHub Action)
# SERVICE_NAME - Cloud Run service name
# REGION - Google Cloud region  
# GOOGLE_CLOUD_PROJECT - Google Cloud project ID

# Default target
all: build

# Run the application locally
run:
	@echo "Running backend application..."
	@bazel run //:server

# Run with Firestore emulator
run-emulator:
	@echo "Starting Firestore emulator..."
	@firebase emulators:start --only firestore --project demo-project

# Build the application
build:
	@echo "Building backend application..."
	@bazel build //:server
	@mkdir -p bin
	@cp -f bazel-bin/server bin/main

# Deploy to Google Cloud Run
# Optional: BIGQUERY_EXPORT_DATASET, BIGQUERY_EXPORT_TABLE, BIGQUERY_EXPORT_PROCESSES_TABLE — BigQuery export
# Optional: PREDICTIVE_PROVIDER_ENABLED, PREDICTIVE_PROVIDER_URL, PREDICTIVE_PROVIDER_AUTH_AUDIENCE, PREDICTIVE_PROVIDER_TIMEOUT_MS, PREDICTIVE_RELIABILITY_CHECKPOINTS — private predictive provider integration
deploy:
	@echo "Deploying to Google Cloud Run..."
	@ENV_VARS="GOOGLE_CLOUD_PROJECT=$(GOOGLE_CLOUD_PROJECT)|JWT_SECRET_KEY=$(JWT_SECRET_KEY)|ADMIN_SECRET=$(ADMIN_SECRET)"; \
	if [ -n "$(BIGQUERY_EXPORT_DATASET)" ]; then ENV_VARS="$$ENV_VARS|BIGQUERY_EXPORT_DATASET=$(BIGQUERY_EXPORT_DATASET)"; fi; \
	if [ -n "$(BIGQUERY_EXPORT_TABLE)" ]; then ENV_VARS="$$ENV_VARS|BIGQUERY_EXPORT_TABLE=$(BIGQUERY_EXPORT_TABLE)"; fi; \
	if [ -n "$(BIGQUERY_EXPORT_PROCESSES_TABLE)" ]; then ENV_VARS="$$ENV_VARS|BIGQUERY_EXPORT_PROCESSES_TABLE=$(BIGQUERY_EXPORT_PROCESSES_TABLE)"; fi; \
	if [ -n "$(PREDICTIVE_PROVIDER_ENABLED)" ]; then ENV_VARS="$$ENV_VARS|PREDICTIVE_PROVIDER_ENABLED=$(PREDICTIVE_PROVIDER_ENABLED)"; fi; \
	if [ -n "$(PREDICTIVE_PROVIDER_URL)" ]; then ENV_VARS="$$ENV_VARS|PREDICTIVE_PROVIDER_URL=$(PREDICTIVE_PROVIDER_URL)"; fi; \
	if [ -n "$(PREDICTIVE_PROVIDER_AUTH_AUDIENCE)" ]; then ENV_VARS="$$ENV_VARS|PREDICTIVE_PROVIDER_AUTH_AUDIENCE=$(PREDICTIVE_PROVIDER_AUTH_AUDIENCE)"; fi; \
	if [ -n "$(PREDICTIVE_PROVIDER_TIMEOUT_MS)" ]; then ENV_VARS="$$ENV_VARS|PREDICTIVE_PROVIDER_TIMEOUT_MS=$(PREDICTIVE_PROVIDER_TIMEOUT_MS)"; fi; \
	if [ -n "$(PREDICTIVE_RELIABILITY_CHECKPOINTS)" ]; then ENV_VARS="$$ENV_VARS|PREDICTIVE_RELIABILITY_CHECKPOINTS=$(PREDICTIVE_RELIABILITY_CHECKPOINTS)"; fi; \
	gcloud run deploy $(SERVICE_NAME) \
		--source . \
		--platform managed \
		--region $(REGION) \
		--allow-unauthenticated \
		--set-env-vars "^|^$$ENV_VARS"

# Run tests
test:
	@echo "Running unit tests..."
	@bazel test //...

# Run tests with the race detector. Race mode requires cgo, so it overrides the
# pure-Go default used by release builds.
test-race:
	@echo "Running tests with the race detector..."
	@bazel test //... --@rules_go//go/config:pure=false --@rules_go//go/config:race

# Run tests with coverage
test-coverage:
	@echo "Running tests with coverage..."
	@bazel coverage //... --combined_report=lcov
	@cp -f bazel-out/_coverage/_coverage_report.dat coverage.dat
	@echo "Coverage report generated: coverage.dat"

# Run integration tests
test-integration:
	@echo "Running integration tests..."
	@bazel test //:backend_test --test_filter=TestFullAPIIntegration

# Run all tests (unit + integration)
test-all: test test-race test-integration

# Run benchmarks
benchmark:
	@echo "Running benchmarks..."
	@bazel test //... --test_arg=-test.run=^$$ --test_arg=-test.bench=. --test_arg=-test.benchmem

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@bazel clean
	@rm -rf bin/
	@rm -f coverage.dat
