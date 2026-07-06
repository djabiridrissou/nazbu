#!/usr/bin/env bash
# Start the Nazbu sidecar next to a running Womola shop server (Mac/Linux).
# Requires Docker. Womola must already be up (its Mongo running).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WOMOLA_COMPOSE="${WOMOLA_COMPOSE:-$HERE/../../womola_prod/docker-compose.prod.yml}"

echo "Starting Nazbu sidecar..."
docker compose -f "$WOMOLA_COMPOSE" -f "$HERE/docker-compose.nazbu.yml" --env-file "$HERE/nazbu.env" up -d --build nazbu-sidecar

echo
echo "Nazbu sidecar is running. Logs:"
docker logs -f womola_nazbu
