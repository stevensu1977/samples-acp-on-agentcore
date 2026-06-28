#!/usr/bin/env bash
# Step 2: create or update an AgentCore Runtime for one agent, using the pushed
# image. Auth is IAM/SigV4: we deliberately omit --authorizer-configuration,
# which makes AgentCore enforce SigV4-signed (IAM) requests by default.
#
# Usage: ./02_deploy_agentcore.sh [kiro|codex|claude]
#   Agent defaults to $AGENT from config.env.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${HERE}/common.sh"

AGENT="$(resolve_arg_agent "${1:-}")"
IMAGE="$(image_uri "${AGENT}")"
RT_NAME="$(runtime_name "${AGENT}")"
ROLE_ARN="${ROLE_ARN:-$(aws iam get-role --role-name "${EXEC_ROLE_NAME}" --query Role.Arn --output text)}"

ARTIFACT="{\"containerConfiguration\":{\"containerUri\":\"${IMAGE}\"}}"

# Container env vars. AGENT_ID is baked into the image; here we set runtime
# knobs (Bedrock region + model for the Claude adapter).
ENV_VARS="AWS_REGION=${AWS_REGION}"
if [ "${AGENT}" = "claude" ]; then
  ENV_VARS="${ENV_VARS},CLAUDE_CODE_USE_BEDROCK=1,ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-us.anthropic.claude-haiku-4-5-20251001-v1:0}"
fi

EXISTING_ID="$(aws bedrock-agentcore-control list-agent-runtimes --region "${AWS_REGION}" \
  --query "agentRuntimes[?agentRuntimeName=='${RT_NAME}'].agentRuntimeId | [0]" \
  --output text 2>/dev/null || echo "None")"

if [ "${EXISTING_ID}" != "None" ] && [ -n "${EXISTING_ID}" ]; then
  log "Updating existing runtime ${RT_NAME} (${EXISTING_ID})"
  aws bedrock-agentcore-control update-agent-runtime --region "${AWS_REGION}" \
    --agent-runtime-id "${EXISTING_ID}" \
    --agent-runtime-artifact "${ARTIFACT}" \
    --role-arn "${ROLE_ARN}" \
    --network-configuration 'networkMode=PUBLIC' \
    --protocol-configuration 'serverProtocol=HTTP' \
    --environment-variables "${ENV_VARS}"
else
  log "Creating runtime ${RT_NAME}"
  aws bedrock-agentcore-control create-agent-runtime --region "${AWS_REGION}" \
    --agent-runtime-name "${RT_NAME}" \
    --agent-runtime-artifact "${ARTIFACT}" \
    --role-arn "${ROLE_ARN}" \
    --network-configuration 'networkMode=PUBLIC' \
    --protocol-configuration 'serverProtocol=HTTP' \
    --environment-variables "${ENV_VARS}"
fi

log "Waiting for runtime to become READY..."
for _ in $(seq 1 30); do
  STATUS="$(aws bedrock-agentcore-control list-agent-runtimes --region "${AWS_REGION}" \
    --query "agentRuntimes[?agentRuntimeName=='${RT_NAME}'].status | [0]" --output text 2>/dev/null || echo "")"
  log "  status=${STATUS}"
  case "${STATUS}" in
    READY) break ;;
    CREATE_FAILED|UPDATE_FAILED) log "Runtime entered ${STATUS}"; exit 1 ;;
  esac
  sleep 10
done

ARN="$(aws bedrock-agentcore-control list-agent-runtimes --region "${AWS_REGION}" \
  --query "agentRuntimes[?agentRuntimeName=='${RT_NAME}'].agentRuntimeArn | [0]" \
  --output text)"
log "Runtime ARN: ${ARN}"
echo "${ARN}"
