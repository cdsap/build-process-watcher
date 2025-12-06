#!/bin/bash
set -e

# Deploy Cloud Function for cleanup
# This function runs on a schedule to delete old data

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-}"
REGION="${REGION:-us-central1}"
FUNCTION_NAME="${FUNCTION_NAME:-cleanup-old-runs}"

if [ -z "$PROJECT_ID" ]; then
    echo "❌ Error: GOOGLE_CLOUD_PROJECT environment variable is required"
    exit 1
fi

echo "🚀 Deploying cleanup Cloud Function..."
echo "   Project: $PROJECT_ID"
echo "   Region: $REGION"
echo "   Function: $FUNCTION_NAME"

# Deploy the function with Pub/Sub trigger
gcloud functions deploy "$FUNCTION_NAME" \
    --gen2 \
    --runtime=go123 \
    --region="$REGION" \
    --source=. \
    --entry-point=CleanupOldData \
    --trigger-topic=cleanup-schedule \
    --set-env-vars=GOOGLE_CLOUD_PROJECT="$PROJECT_ID" \
    --memory=256MB \
    --timeout=540s \
    --max-instances=1 \
    --min-instances=0 \
    --service-account="${SERVICE_ACCOUNT_EMAIL:-}"

echo "✅ Cloud Function deployed successfully!"

# Create Cloud Scheduler job to trigger the function every 15 minutes
echo "📅 Creating Cloud Scheduler job..."

SCHEDULER_JOB_NAME="${SCHEDULER_JOB_NAME:-cleanup-old-runs-schedule}"

# Delete existing job if it exists
gcloud scheduler jobs delete "$SCHEDULER_JOB_NAME" \
    --location="$REGION" \
    --quiet 2>/dev/null || true

# Create new scheduler job
gcloud scheduler jobs create pubsub "$SCHEDULER_JOB_NAME" \
    --location="$REGION" \
    --schedule="*/15 * * * *" \
    --topic="cleanup-schedule" \
    --message-body='{"trigger":"scheduled"}' \
    --time-zone="UTC"

echo "✅ Cloud Scheduler job created!"
echo ""
echo "📋 Summary:"
echo "   - Function: $FUNCTION_NAME"
echo "   - Schedule: Every 15 minutes"
echo "   - Retention: 3 hours"
echo ""
echo "💡 To test manually:"
echo "   gcloud functions call $FUNCTION_NAME --region=$REGION"

