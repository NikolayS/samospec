#!/usr/bin/env bash
# Wait for Postgres to accept connections, then apply migrations.
set -Eeuo pipefail
IFS=$'\n\t'

for _ in $(seq 1 60); do
  if pg_isready -h 127.0.0.1 -p 5432 -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

cd /app
exec bun run scripts/migrate.ts
