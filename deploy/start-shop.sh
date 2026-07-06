#!/usr/bin/env bash
# Start the Nazbu sidecar next to a running Womola shop server (Mac/Linux).
# Requires Docker. Womola must already be up (its Mongo running).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
WOMOLA_COMPOSE="${WOMOLA_COMPOSE:-$HERE/../../womola_prod/docker-compose.prod.yml}"

echo "Building Nazbu sidecar image..."
docker build -f "$REPO/deploy/Dockerfile.sidecar" -t nazbu-sidecar:local "$REPO"

echo "Starting Nazbu sidecar beside Womola..."
docker compose -f "$WOMOLA_COMPOSE" -f "$HERE/docker-compose.nazbu.yml" --env-file "$HERE/nazbu.env" up -d nazbu-sidecar

echo
echo "Nazbu sidecar is running. Logs:"
docker logs -f womola_nazbu
