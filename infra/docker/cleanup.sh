#!/usr/bin/env bash
# FarmX Docker Cleanup — runs as a weekly cron job on the server.
#
# SAFE: removes only dangling images, build cache, and stopped containers.
# NEVER removes: running containers, named volumes (Postgres / RabbitMQ data),
#                or images that are currently in use.
#
# Cron install (run once on server via SSH):
#   chmod +x /opt/farmx/infra/docker/cleanup.sh
#   (crontab -l 2>/dev/null; echo "0 3 * * 0 /opt/farmx/infra/docker/cleanup.sh >> /var/log/farmx-docker-cleanup.log 2>&1") | crontab -

set -euo pipefail

LOG_PREFIX="[farmx-cleanup $(date '+%Y-%m-%d %H:%M:%S')]"

echo ""
echo "============================================"
echo "$LOG_PREFIX START"
echo "============================================"

# ── 1. Disk usage BEFORE ─────────────────────────────────────────────────────
echo "$LOG_PREFIX BEFORE cleanup:"
docker system df

# ── 2. Dangling images (<none>:<none>) ───────────────────────────────────────
# Only removes images NOT referenced by any tag and NOT used by any container.
# Running containers' images are NEVER touched.
echo ""
echo "$LOG_PREFIX Removing dangling images..."
docker image prune -f
echo "$LOG_PREFIX Dangling images done."

# ── 3. Stopped / exited containers ───────────────────────────────────────────
# Removes containers that have already EXITED (e.g. the one-shot db-migrate runner).
# Running containers are completely untouched.
echo ""
echo "$LOG_PREFIX Removing stopped containers..."
docker container prune -f
echo "$LOG_PREFIX Stopped containers done."

# ── 4. Unused networks ───────────────────────────────────────────────────────
echo ""
echo "$LOG_PREFIX Removing unused networks..."
docker network prune -f
echo "$LOG_PREFIX Networks done."

# ── 5. Build cache older than 72 h ───────────────────────────────────────────
# Keeps recent cache so the next deploy is still fast.
# Does NOT remove cache layers used by running images.
echo ""
echo "$LOG_PREFIX Pruning build cache older than 72h..."
docker builder prune -f --keep-storage 2gb
echo "$LOG_PREFIX Build cache done."

# ── 6. Disk usage AFTER ──────────────────────────────────────────────────────
echo ""
echo "$LOG_PREFIX AFTER cleanup:"
docker system df

echo ""
echo "$LOG_PREFIX DONE."
echo "============================================"
