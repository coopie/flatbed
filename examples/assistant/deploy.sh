#!/usr/bin/env bash
# Builds the assistant example's image and deploys it as one Cloud Run service. Nobody has run this
# yet: read it, set the variables, and make the secrets first, as README.md says.
#
#   PROJECT=my-project ALLOWED_EMAILS=a@example.org,b@example.org examples/assistant/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

PROJECT="${PROJECT:?Set PROJECT to the Google Cloud project id}"
REGION="${REGION:-europe-west2}"
SERVICE="${SERVICE:-assistant}"
REPOSITORY="${REPOSITORY:-flatbed}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPOSITORY/$SERVICE:$(git rev-parse --short HEAD)"

# Cloud Run runs amd64, whatever this machine is.
docker build --platform linux/amd64 -f examples/assistant/Dockerfile -t "$IMAGE" .
docker push "$IMAGE"

# One instance, because the page's live updates come from the process the agent runs in. CPU stays
# on after a response, because an agent keeps running after the request that woke it has answered.
gcloud run deploy "$SERVICE" \
  --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --max-instances 1 --no-cpu-throttling --timeout 3600 \
  --allow-unauthenticated \
  --set-env-vars "FLATBED_MODEL=${FLATBED_MODEL:-anthropic/claude-opus-5-5},ALLOWED_EMAILS=${ALLOWED_EMAILS:?Set ALLOWED_EMAILS}" \
  --set-secrets "DATABASE_URL=assistant-database-url:latest,ANTHROPIC_API_KEY=assistant-anthropic-key:latest,GOOGLE_CLIENT_ID=assistant-google-client-id:latest,GOOGLE_CLIENT_SECRET=assistant-google-client-secret:latest,TICK_SECRET=assistant-tick-secret:latest"
