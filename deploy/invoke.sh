#!/usr/bin/env bash
# Invoke a deployed ACP agent runtime with IAM/SigV4 auth.
# The AWS CLI signs the request with your current credentials (SigV4); the
# caller's IAM identity must allow bedrock-agentcore:InvokeAgentRuntime
# (see iam/caller-invoke-policy.json).
#
# Usage: ./invoke.sh <kiro|codex|claude> "your prompt here"
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${HERE}/common.sh"

AGENT="$(resolve_arg_agent "${1:-}")"
PROMPT="${2:?usage: invoke.sh [agent] <prompt>}"
RT_NAME="$(runtime_name "${AGENT}")"

ARN="$(aws bedrock-agentcore-control list-agent-runtimes --region "${AWS_REGION}" \
  --query "agentRuntimes[?agentRuntimeName=='${RT_NAME}'].agentRuntimeArn | [0]" \
  --output text)"
if [ "${ARN}" = "None" ] || [ -z "${ARN}" ]; then
  echo "No runtime found for ${AGENT} (${RT_NAME}). Deploy it first." >&2
  exit 1
fi

# runtime-session-id must be >= 33 chars. Build a stable, padded id.
SESSION_ID="acp-${AGENT}-$(date +%s)-$(printf '%08x' $$)-padding00000000"
SESSION_ID="${SESSION_ID:0:64}"

OUT="$(mktemp /tmp/acp-resp-XXXXXX.sse)"
log "Invoking ${ARN}"
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "${ARN}" \
  --runtime-session-id "${SESSION_ID}" \
  --content-type "application/json" \
  --accept "text/event-stream" \
  --payload "$(printf '{"prompt": %s}' "$(printf '%s' "${PROMPT}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
  "${OUT}"

echo "--- response (${OUT}) ---"
cat "${OUT}"
