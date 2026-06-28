#!/usr/bin/env bash
# Step 1: build the shared base image + an agent image (linux/arm64) and push
# it to ECR. AgentCore Runtime requires ARM64.
#
# Usage: ./01_build_and_push.sh [kiro|codex|claude]
#   Agent defaults to $AGENT from config.env.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${HERE}/common.sh"

AGENT="$(resolve_arg_agent "${1:-}")"
ROOT="${HERE}/.."
REPO="$(repo_name "${AGENT}")"
IMAGE="$(image_uri "${AGENT}")"

log "Ensuring ECR repo ${REPO} exists"
aws ecr describe-repositories --repository-names "${REPO}" --region "${AWS_REGION}" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "${REPO}" --region "${AWS_REGION}" >/dev/null

log "Logging in to ECR ${ECR_REGISTRY}"
aws ecr get-login-password --region "${AWS_REGION}" | \
  docker login --username AWS --password-stdin "${ECR_REGISTRY}"

log "Building + pushing ${AGENT} image (linux/arm64) -> ${IMAGE}"
build_arm64 "${ROOT}/docker/Dockerfile.${AGENT}" "${IMAGE}" --push \
  ${KIRO_DOWNLOAD_URL:+--build-arg "KIRO_DOWNLOAD_URL=${KIRO_DOWNLOAD_URL}"}

log "Pushed ${IMAGE}"
