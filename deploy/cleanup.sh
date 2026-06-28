#!/usr/bin/env bash
# Tear down resources for one agent: delete the AgentCore runtime, and
# optionally the ECR repo. Pass --all to also delete the shared IAM role.
#
# Usage: ./cleanup.sh [kiro|codex|claude] [--ecr] [--all]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${HERE}/common.sh"

AGENT="$(resolve_arg_agent "${1:-}")"; shift || true
DELETE_ECR=false; DELETE_IAM=false
for arg in "$@"; do
  case "$arg" in
    --ecr) DELETE_ECR=true ;;
    --all) DELETE_ECR=true; DELETE_IAM=true ;;
  esac
done

RT_NAME="$(runtime_name "${AGENT}")"
RT_ID="$(aws bedrock-agentcore-control list-agent-runtimes --region "${AWS_REGION}" \
  --query "agentRuntimes[?agentRuntimeName=='${RT_NAME}'].agentRuntimeId | [0]" \
  --output text 2>/dev/null || echo "None")"

if [ "${RT_ID}" != "None" ] && [ -n "${RT_ID}" ]; then
  log "Deleting runtime ${RT_NAME} (${RT_ID})"
  aws bedrock-agentcore-control delete-agent-runtime --region "${AWS_REGION}" \
    --agent-runtime-id "${RT_ID}"
else
  log "No runtime ${RT_NAME} to delete"
fi

if [ "${DELETE_ECR}" = true ]; then
  REPO="$(repo_name "${AGENT}")"
  log "Deleting ECR repo ${REPO}"
  aws ecr delete-repository --repository-name "${REPO}" --region "${AWS_REGION}" --force >/dev/null 2>&1 || \
    log "  (repo not found)"
fi

if [ "${DELETE_IAM}" = true ]; then
  log "Deleting IAM role ${EXEC_ROLE_NAME}"
  aws iam delete-role-policy --role-name "${EXEC_ROLE_NAME}" --policy-name "${PROJECT}-exec" 2>/dev/null || true
  aws iam delete-role --role-name "${EXEC_ROLE_NAME}" 2>/dev/null || log "  (role not found)"
fi

log "Cleanup done for ${AGENT}"
