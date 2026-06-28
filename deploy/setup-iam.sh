#!/usr/bin/env bash
# Create (or update) the shared AgentCore execution role used by all three
# runtimes. The role lets AgentCore pull the image from ECR, write logs, and
# (for the Claude adapter) invoke Bedrock models.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${HERE}/common.sh"

render() { sed -e "s|\${AWS_ACCOUNT_ID}|${AWS_ACCOUNT_ID}|g" -e "s|\${AWS_REGION}|${AWS_REGION}|g" "$1"; }

TRUST="$(render "${HERE}/../iam/trust-policy.json")"
POLICY="$(render "${HERE}/../iam/execution-role-policy.json")"

if aws iam get-role --role-name "${EXEC_ROLE_NAME}" >/dev/null 2>&1; then
  log "Updating trust policy on existing role ${EXEC_ROLE_NAME}"
  aws iam update-assume-role-policy --role-name "${EXEC_ROLE_NAME}" \
    --policy-document "${TRUST}"
else
  log "Creating execution role ${EXEC_ROLE_NAME}"
  aws iam create-role --role-name "${EXEC_ROLE_NAME}" \
    --assume-role-policy-document "${TRUST}" \
    --description "Execution role for ACP-on-AgentCore runtimes"
fi

log "Attaching inline policy"
aws iam put-role-policy --role-name "${EXEC_ROLE_NAME}" \
  --policy-name "${PROJECT}-exec" \
  --policy-document "${POLICY}"

ROLE_ARN="$(aws iam get-role --role-name "${EXEC_ROLE_NAME}" --query Role.Arn --output text)"
log "Execution role ready: ${ROLE_ARN}"
echo "${ROLE_ARN}"
