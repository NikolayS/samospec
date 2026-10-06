#!/usr/bin/env bash
# Build and run the samospec.dev container with the standard volume layout.
# Usage:
#   ./scripts/run.sh build           # docker build
#   ./scripts/run.sh up              # run in foreground
#   ./scripts/run.sh up -d           # run detached
#   ./scripts/run.sh logs            # follow container logs
#   ./scripts/run.sh psql            # exec into psql inside the container
#   ./scripts/run.sh issue-key LABEL # mint a publish API token

set -Eeuo pipefail
IFS=$'\n\t'

IMAGE="${IMAGE:-samospec-web:latest}"
NAME="${NAME:-samospec-web}"
HOST_HTTP_PORT="${HOST_HTTP_PORT:-3000}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${ROOT}/data"
CONFIG_DIR="${ROOT}/config"

mkdir -p "${DATA_DIR}/postgres" "${DATA_DIR}/files" "${CONFIG_DIR}"

cmd="${1:-up}"
shift || true

build() {
  docker build -t "${IMAGE}" "${ROOT}"
}

up() {
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
  docker run "${@}" \
    --name "${NAME}" \
    -p "${HOST_HTTP_PORT}:3000" \
    -v "${DATA_DIR}/postgres:/var/lib/postgresql/data" \
    -v "${DATA_DIR}/files:/var/lib/samospec/files" \
    -v "${CONFIG_DIR}:/etc/samospec" \
    "${IMAGE}"
}

case "${cmd}" in
  build)      build ;;
  up)         up "${@}" ;;
  logs)       docker logs -f "${NAME}" ;;
  psql)       docker exec -it "${NAME}" su - postgres -c "psql" ;;
  issue-key)
    docker exec "${NAME}" bun run /app/scripts/issue-key.ts "${1:-cli}"
    ;;
  *)
    echo "unknown command: ${cmd}" >&2
    exit 2
    ;;
esac
