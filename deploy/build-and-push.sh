#!/usr/bin/env bash
# Build the shared base image, then an agent image, and push it to ECR.
# Usage: ./build-and-push.sh <kiro|codex|claude>
#
# Builds for linux/arm64 (required by AgentCore Runtime) using docker buildx.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${HERE}/common.sh"

AGENT="${1:?usage: build-and-push.sh <kiro|codex|claude>}"
require_agent "${AGENT}"
ROOT="${HERE}/.."
REPO="$(repo_name "${AGENT}")"
IMAGE="$(image_uri "${AGENT}")"
BASE_TAG="${PROJECT}-base:latest"

log "Ensuring ECR repo ${REPO} exists"
aws ecr describe-repositories --repository-names "${REPO}" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "${REPO}" >/dev/null

log "Logging in to ECR ${ECR_REGISTRY}"
aws ecr get-login-password --region "${AWS_REGION}" | \
  docker login --username AWS --password-stdin "${ECR_REGISTRY}"

# Ensure a buildx builder exists for arm64 cross-builds.
docker buildx inspect acpbuilder >/dev/null 2>&1 || \
  docker buildx create --name acpbuilder --use >/dev/null
docker buildx use acpbuilder

log "Building base image (linux/arm64)"
docker buildx build --platform linux/arm64 \
  -f "${ROOT}/docker/Dockerfile.base" \
  -t "${BASE_TAG}" --load "${ROOT}"

log "Building + pushing ${AGENT} image -> ${IMAGE}"
docker buildx build --platform linux/arm64 \
  -f "${ROOT}/docker/Dockerfile.${AGENT}" \
  --build-arg "BASE_IMAGE=${BASE_TAG}" \
  ${KIRO_DOWNLOAD_URL:+--build-arg KIRO_DOWNLOAD_URL=${KIRO_DOWNLOAD_URL}} \
  -t "${IMAGE}" --push "${ROOT}"

log "Pushed ${IMAGE}"
