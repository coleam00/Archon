#!/usr/bin/env bash
set -euo pipefail

HOST=${1:-localhost}
PORT=${2:-54325}
USER=${3:-postgres}
PASSWORD=${4:-postgres}
DATABASE=${5:-postgres}

export DB_HOST="$HOST"
export DB_PORT="$PORT"
export DB_USER="$USER"
export DB_PASSWORD="$PASSWORD"
export DB_NAME="$DATABASE"

python "$(dirname "$0")/../run_migrations.py" --host "$HOST" --port "$PORT" --user "$USER" --password "$PASSWORD" --database "$DATABASE"
