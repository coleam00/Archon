#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: test-docker-slack-upgrade.sh <production-image>}
root=$(cd "$(dirname "$0")/.." && pwd)
prefix="archon-slack-upgrade-$$-$(date +%s)"
container="${prefix}-app"
volume="${prefix}-data"
tampered_image="${prefix}:tampered"
service="${prefix}-slack"
network="${prefix}-network"
scratch=$(mktemp -d)
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then docker logs "$container" 2>&1 || true; fi
  docker rm -f "$container" "$service" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker image rm "$tampered_image" >/dev/null 2>&1 || true
  rm -rf "$scratch"
  exit "$result"
}
trap cleanup EXIT

docker volume create "$volume" >/dev/null
# Model the pre-plugin deployment's persistent home and workspace, without a receipt.
docker run --rm --network none --entrypoint bash -v "$volume:/.archon" "$image" -c \
  'mkdir -p /.archon/workspaces; echo upgrade-sentinel > /.archon/workspaces/upgrade-sentinel; echo SLACK_BOT_TOKEN=dummy > /.archon/.env'

network_mode=none
start() {
  local selected_image=$1
  shift
  docker run -d --name "$container" --network "$network_mode" \
    -e ARCHON_DOCKER=true -e PORT=3000 -e CLAUDE_USE_GLOBAL_AUTH=true -e ARCHON_TELEMETRY_DISABLED=1 \
    -v "$volume:/.archon" -v "$root/scripts/fixtures:/app/scripts/fixtures:ro" \
    "$@" "$selected_image" >/dev/null
}
stop() { docker rm -f "$container" >/dev/null; }
wait_health() {
  local require_live=${1:-false}
  for ((attempt=0; attempt<60; attempt++)); do
    if docker exec "$container" bun -e '
      const response = await fetch("http://localhost:3000/api/health");
      if (!response.ok) process.exit(1);
      const body = await response.json();
      if (process.argv[1] === "true" && !body.activePlatforms?.includes("Chat: slack")) process.exit(1);
    ' "$require_live" >/dev/null 2>&1; then return; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]; then
      echo 'Container stopped before health was ready' >&2
      return 1
    fi
    sleep 1
  done
  echo 'Timed out waiting for container health' >&2
  return 1
}
check() { docker exec -u appuser "$container" bun scripts/fixtures/check-docker-slack.ts "$1"; }
remove_plugin() { docker exec -u appuser "$container" bun run cli plugin remove coleam00/Archon/plugins/chat-slack; }

start "$image"
wait_health
check real
docker logs "$container" 2>&1 | grep -F 'Provisioned Slack because Slack token configuration is present'
test "$(docker exec "$container" cat /.archon/workspaces/upgrade-sentinel)" = upgrade-sentinel
fingerprint=$(check fingerprint)
stop
start "$image"
wait_health
test "$(check fingerprint)" = "$fingerprint"
docker logs "$container" 2>&1 | grep -F 'retained coleam00/Archon/plugins/chat-slack'
remove_plugin
stop
# Token still in /.archon/.env: removal is undone by the next offline boot.
start "$image"
wait_health
check real
remove_plugin
docker exec -u appuser "$container" sh -c 'echo SLACK_BOT_TOKEN= > /.archon/.env'
stop
start "$image"
wait_health
check absent
stop

# Fresh home, container-env declaration, same real executable.
docker volume rm "$volume" >/dev/null
docker volume create "$volume" >/dev/null
start "$image" -e SLACK_BOT_TOKEN=dummy
wait_health
check real
stop

# Exercise the unmodified release against a controlled TLS Slack service.
# The internal network has no route to Slack or release downloads.
mkdir -p "$scratch/tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=slack.com \
  -addext subjectAltName=DNS:slack.com -keyout "$scratch/tls/key.pem" \
  -out "$scratch/tls/cert.pem" >/dev/null 2>&1
chmod 644 "$scratch/tls/key.pem"
docker network create --internal "$network" >/dev/null
docker run -d --name "$service" --network "$network" --network-alias slack.com \
  --entrypoint bun -v "$root/scripts/fixtures:/fixtures:ro" -v "$scratch/tls:/test-tls:ro" \
  "$image" /fixtures/docker-slack-service.ts >/dev/null
network_mode=$network
for source in container home /app/packages/server/.archon/.env /app/.env; do
  echo "Checking Slack configuration source: $source"
  docker volume rm "$volume" >/dev/null
  docker volume create "$volume" >/dev/null
  docker run --rm --network none --entrypoint bash -v "$volume:/.archon" "$image" -c \
    'mkdir -p /.archon/workspaces; echo upgrade-sentinel > /.archon/workspaces/upgrade-sentinel'
  if [ "$source" = container ]; then
    source_args=(-e SLACK_BOT_TOKEN=xoxb-upgrade-test -e SLACK_APP_TOKEN=xapp-upgrade-test)
  else
    target=$source
    if [ "$source" = home ]; then target=/.archon/.env; fi
    printf 'SLACK_BOT_TOKEN=xoxb-upgrade-test\nSLACK_APP_TOKEN=xapp-upgrade-test\n' > "$scratch/source.env"
    if [ "$source" = home ]; then
      docker run --rm --network none --entrypoint bash -v "$volume:/.archon" \
        -v "$scratch/source.env:/source.env:ro" "$image" -c 'cp /source.env /.archon/.env'
      source_args=(-e SLACK_BOT_TOKEN= -e SLACK_APP_TOKEN=)
    else
      source_args=(-v "$scratch/source.env:$target:ro")
    fi
  fi
  start "$image" -v "$scratch/tls:/test-tls:ro" \
    -e NODE_EXTRA_CA_CERTS=/test-tls/cert.pem "${source_args[@]}"
  wait_health true
  check live
  test "$(docker exec "$container" cat /.archon/workspaces/upgrade-sentinel)" = upgrade-sentinel
  stop
done

cat > "$scratch/Dockerfile" <<'DOCKERFILE'
ARG BASE
FROM ${BASE}
RUN echo tampered >> /opt/archon/image-plugins/archon-chat-slack
DOCKERFILE
docker build --network none --build-arg "BASE=$image" -f "$scratch/Dockerfile" -t "$tampered_image" "$root"
docker volume rm "$volume" >/dev/null
docker volume create "$volume" >/dev/null
network_mode=none
start "$tampered_image" -e SLACK_BOT_TOKEN=dummy
for ((attempt=0; attempt<30; attempt++)); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$container")" = false ]; then break; fi
  sleep 1
done
test "$(docker inspect -f '{{.State.Running}}' "$container")" = false
result=$(docker inspect -f '{{.State.ExitCode}}' "$container")
test "$result" != 0
docker logs "$container" 2>&1 | grep -F 'does not match the image bundle receipt'
if docker logs "$container" 2>&1 | grep -F 'server_ready'; then
  echo 'Server started despite failed provisioning' >&2
  exit 1
fi
stop
echo 'Docker Slack upgrade, offline provisioning, retention, removal, actual release delivery and checksum refusal passed.'
