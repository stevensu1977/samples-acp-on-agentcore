#!/usr/bin/env bash
# Create or update an AgentCore Runtime for one agent, using the pushed image.
# Auth is IAM/SigV4: we deliberately omit --authorizer-configuration, which
# makes AgentCore enforce SigV4-signed (IAM) requests by default.
#
# Usage: ./deploy-runtime.sh <kiro|codex|claude>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${HERE}/common.sh"

AGENT="${1:?usage: deploy-runtime.sh <kiro|codex|claude>}"
require_agent "${AGENT}"

IMAGE="$(image_uri "${AGENT}")"
RT_NAME="$(runtime_name "${AGENT}")"
ROLE_ARN="${ROLE_ARN:-$(aws iam get-role --role-name "${EXEC_ROLE_NAME}" --query Role.Arn --output text)}"

ARTIFACT="{\"containerConfiguration\":{\"containerUri\":\"${IMAGE}\"}}"

# Does a runtime with this name already exist?
EXISTING_ID="$(aws bedrock-agentcore-control list-agent-runtimes \
  --query "agentRuntimes[?agentRuntimeName=='${RT_NAME}'].agentRuntimeId | [0]" \
  --output text 2>/dev/null || echo "None")"

if [ "${EXISTING_ID}" != "None" ] && [ -n "${EXISTING_ID}" ]; then
  log "Updating existing runtime ${RT_NAME} (${EXISTING_ID})"
  aws bedrock-agentcore-control update-agent-runtime \
    --agent-runtime-id "${EXISTING_ID}" \
    --agent-runtime-artifact "${ARTIFACT}" \
    --role-arn "${ROLE_ARN}" \
    --network-configuration 'networkMode=PUBLIC' \
    --protocol-configuration 'serverProtocol=HTTP'
else
  log "Creating runtime ${RT_NAME}"
  aws bedrock-agentcore-control create-agent-runtime \
    --agent-runtime-name "${RT_NAME}" \
    --agent-runtime-artifact "${ARTIFACT}" \
    --role-arn "${ROLE_ARN}" \
    --network-configuration 'networkMode=PUBLIC' \
    --protocol-configuration 'serverProtocol=HTTP'
fi

log "Runtime ARN:"
aws bedrock-agentcore-control list-agent-runtimes \
  --query "agentRuntimes[?agentRuntimeName=='${RT_NAME}'].agentRuntimeArn | [0]" \
  --output text
