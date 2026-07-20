#!/usr/bin/env bash
#
# Build the Archon container-isolation runner image. Tags BOTH
# `archon-runner:<version>` (from the root package.json) and `archon-runner:latest`.
# The container backend defaults to `archon-runner:latest`, so this is the
# canonical build step; pin `container.image` to a version tag for reproducibility.
#
# Usage:
#   bun run build:runner-image           # tags archon-runner:<version> + :latest
#   ARCHON_RUNNER_TAG=archon-runner:dev bun run build:runner-image   # custom tag
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_DIR="${ROOT_DIR}/packages/isolation/docker"
DOCKERFILE="${DOCKER_DIR}/runner.Dockerfile"

VERSION="$(node -p "require('${ROOT_DIR}/package.json').version" 2>/dev/null || \
  bun -e "console.log(require('${ROOT_DIR}/package.json').version)")"

PRIMARY_TAG="${ARCHON_RUNNER_TAG:-archon-runner:${VERSION}}"

echo "Building ${PRIMARY_TAG} from ${DOCKERFILE}"
docker build -t "${PRIMARY_TAG}" -f "${DOCKERFILE}" "${DOCKER_DIR}"

# Also tag :latest for convenience (config can pin an explicit version tag).
if [ -z "${ARCHON_RUNNER_TAG:-}" ]; then
  docker tag "${PRIMARY_TAG}" "archon-runner:latest"
  echo "Tagged archon-runner:latest"
fi

echo "Done. Runner image ready: ${PRIMARY_TAG}"
