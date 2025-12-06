# Cleanup Cloud Function

This Cloud Function runs on a schedule to delete old build run data that's older than 3 hours.

## Architecture

- **Cloud Function**: Runs the cleanup logic
- **Cloud Scheduler**: Triggers the function every 15 minutes
- **Pub/Sub Topic**: `cleanup-schedule` - used by scheduler to trigger the function

## Deployment

### Prerequisites

1. Enable required APIs:
```bash
gcloud services enable cloudfunctions.googleapis.com
gcloud services enable cloudscheduler.googleapis.com
gcloud services enable pubsub.googleapis.com
```

2. Create Pub/Sub topic:
```bash
gcloud pubsub topics create cleanup-schedule
```

### Deploy

```bash
export GOOGLE_CLOUD_PROJECT=your-project-id
export REGION=us-central1
chmod +x deploy.sh
./deploy.sh
```

Or manually:

```bash
# Deploy function
gcloud functions deploy cleanup-old-runs \
    --gen2 \
    --runtime=go123 \
    --region=us-central1 \
    --source=. \
    --entry-point=CleanupOldData \
    --trigger-topic=cleanup-schedule \
    --set-env-vars=GOOGLE_CLOUD_PROJECT=your-project-id \
    --memory=256MB \
    --timeout=540s

# Create scheduler job
gcloud scheduler jobs create pubsub cleanup-old-runs-schedule \
    --location=us-central1 \
    --schedule="*/15 * * * *" \
    --topic=cleanup-schedule \
    --message-body='{"trigger":"scheduled"}'
```

## Testing

Test the function manually:
```bash
gcloud functions call cleanup-old-runs --region=us-central1
```

Or trigger via Pub/Sub:
```bash
gcloud pubsub topics publish cleanup-schedule --message='{"test":true}'
```

## Schedule

The function runs every 15 minutes and deletes runs older than 3 hours.

## Permissions

The Cloud Function's service account needs:
- `roles/datastore.user` - to read/write Firestore
- `roles/pubsub.subscriber` - to receive Pub/Sub messages

