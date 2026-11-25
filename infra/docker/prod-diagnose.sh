#!/usr/bin/env sh
# READ-ONLY production diagnostics for the FarmX compose deployment.
# Run on the server from the backend folder (where docker-compose.prod.yml and .env live):
#   sh infra/docker/prod-diagnose.sh [requestId ...] > farmx-diagnose.txt 2>&1
# It changes nothing: no restarts, no migrations, no writes. Secrets are not printed.
set -u
COMPOSE="docker compose -f docker-compose.prod.yml"

echo "== deployed commit"
git log -1 --format='%h %ci %s' 2>/dev/null || echo "(not a git checkout)"

echo
echo "== containers (status, restarts)"
$COMPOSE ps -a --format 'table {{.Name}}\t{{.State}}\t{{.Status}}'

echo
echo "== db-migrate (exit code + last 80 lines): a non-zero exit means later migrations never ran"
docker inspect farmx-db-migrate --format 'exit={{.State.ExitCode}} finished={{.State.FinishedAt}}' 2>/dev/null
docker logs --tail 80 farmx-db-migrate 2>&1

echo
echo "== applied / failed migrations (read-only SELECT)"
docker exec farmx-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -A -F " | " -c "
  SELECT migration_name,
         CASE WHEN rolled_back_at IS NOT NULL THEN '"'"'ROLLED_BACK'"'"'
              WHEN finished_at IS NULL THEN '"'"'FAILED/INCOMPLETE'"'"'
              ELSE '"'"'ok'"'"' END AS state,
         left(regexp_replace(coalesce(logs, '"'"''"'"'), '"'"'\s+'"'"', '"'"' '"'"', '"'"'g'"'"'), 300) AS error
  FROM _prisma_migrations ORDER BY started_at;"'

echo
echo "== do the failing endpoints' tables exist?"
docker exec farmx-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -A -c "
  SELECT t, to_regclass(t) IS NOT NULL AS exists FROM unnest(ARRAY[
    '"'"'categories'"'"','"'"'brands'"'"','"'"'products'"'"','"'"'product_lookups'"'"',
    '"'"'banners'"'"','"'"'banner_placements'"'"','"'"'farms'"'"'
  ]) AS t;"'

echo
echo "== last errors per service"
for c in farmx-api-gateway farmx-product-service farmx-catalog-service farmx-farm-service farmx-auth-service; do
  echo "--- $c"
  docker logs --tail 400 "$c" 2>&1 | grep -iE '"level":(50|60)|error|exception|P20[0-9][0-9]|ECONNREFUSED|does not exist' | tail -15
done

if [ "$#" -gt 0 ]; then
  echo
  echo "== request ids"
  for id in "$@"; do
    echo "--- $id"
    for c in $(docker ps -a --format '{{.Names}}' | grep '^farmx-'); do
      docker logs "$c" 2>&1 | grep -F "$id" | sed "s/^/[$c] /" | head -20
    done
  done
fi
