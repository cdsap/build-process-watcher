.PHONY: run run-emulator build deploy clean

# Environment variables (provided by GitHub Action)
# SERVICE_NAME - Cloud Run service name
# REGION - Google Cloud region  
# GOOGLE_CLOUD_PROJECT - Google Cloud project ID

# Default target
all: build

# Run the application locally
run:
	@echo "Running backend application..."
	@go run .

# Run with Firestore emulator
run-emulator:
	@echo "Starting Firestore emulator..."
	@firebase emulators:start --only firestore --project demo-project

# Build the application
build:
	@echo "Building backend application..."
	@go build -o bin/main .

# Deploy to Google Cloud Run
# Optional: BIGQUERY_EXPORT_DATASET, BIGQUERY_EXPORT_TABLE, BIGQUERY_EXPORT_PROCESSES_TABLE — BigQuery export
deploy:
	@echo "Deploying to Google Cloud Run..."
	@ENV_VARS="GOOGLE_CLOUD_PROJECT=$(GOOGLE_CLOUD_PROJECT),JWT_SECRET_KEY=$(JWT_SECRET_KEY),ADMIN_SECRET=$(ADMIN_SECRET)"; \
	if [ -n "$(BIGQUERY_EXPORT_DATASET)" ]; then ENV_VARS="$$ENV_VARS,BIGQUERY_EXPORT_DATASET=$(BIGQUERY_EXPORT_DATASET)"; fi; \
	if [ -n "$(BIGQUERY_EXPORT_TABLE)" ]; then ENV_VARS="$$ENV_VARS,BIGQUERY_EXPORT_TABLE=$(BIGQUERY_EXPORT_TABLE)"; fi; \
	if [ -n "$(BIGQUERY_EXPORT_PROCESSES_TABLE)" ]; then ENV_VARS="$$ENV_VARS,BIGQUERY_EXPORT_PROCESSES_TABLE=$(BIGQUERY_EXPORT_PROCESSES_TABLE)"; fi; \
	gcloud run deploy $(SERVICE_NAME) \
		--source . \
		--platform managed \
		--region $(REGION) \
		--allow-unauthenticated \
		--set-env-vars "$$ENV_VARS"

# Run tests
test:
	@echo "Running unit tests..."
	@go test -v -race ./...

# Run tests with coverage
test-coverage:
	@echo "Running tests with coverage..."
	@go test -v -race -coverprofile=coverage.out ./...
	@go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

# Run integration tests
test-integration:
	@echo "Running integration tests..."
	@go test -v -run TestFullAPIIntegration ./...

# Run all tests (unit + integration)
test-all: test test-integration

# Run benchmarks
benchmark:
	@echo "Running benchmarks..."
	@go test -bench=. -benchmem ./...

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf bin/
	@rm -f coverage.out coverage.html

