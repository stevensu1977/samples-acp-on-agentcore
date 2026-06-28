#!/usr/bin/env bash
# Create (or update) the shared AgentCore execution role used by all three
# runtimes. The role lets AgentCore pull the image from ECR, write logs, and
# (for the Claude adapter) invoke Bedrock models.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${HERE}/common.sh"

# Render placeholders from config.env / env. Unset optionals default to a
# harmless non-matching value so the policy stays valid.
ATHENA_WORKGROUP="${ATHENA_WORKGROUP:-primary}"
GLUE_DB_PREFIX="${GLUE_DB_PREFIX:-}"
DATA_BUCKET="${DATA_BUCKET:-acp-data-none}"
ATHENA_RESULTS_BUCKET="${ATHENA_RESULTS_BUCKET:-${DATA_BUCKET}}"

render() {
  sed -e "s|\${AWS_ACCOUNT_ID}|${AWS_ACCOUNT_ID}|g" \
      -e "s|\${AWS_REGION}|${AWS_REGION}|g" \
      -e "s|\${ATHENA_WORKGROUP}|${ATHENA_WORKGROUP}|g" \
      -e "s|\${GLUE_DB_PREFIX}|${GLUE_DB_PREFIX}|g" \
      -e "s|\${DATA_BUCKET}|${DATA_BUCKET}|g" \
      -e "s|\${ATHENA_RESULTS_BUCKET}|${ATHENA_RESULTS_BUCKET}|g" \
      "$1"
}

TRUST="$(render "${HERE}/../iam/trust-policy.json")"
POLICY="$(render "${HERE}/../iam/execution-role-policy.json")"
SKILLS_POLICY="$(render "${HERE}/../iam/skills-data-analytics-policy.json")"

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

log "Attaching base execution inline policy"
aws iam put-role-policy --role-name "${EXEC_ROLE_NAME}" \
  --policy-name "${PROJECT}-exec" \
  --policy-document "${POLICY}"

log "Attaching aws-data-analytics skills inline policy"
aws iam put-role-policy --role-name "${EXEC_ROLE_NAME}" \
  --policy-name "${PROJECT}-skills" \
  --policy-document "${SKILLS_POLICY}"

ROLE_ARN="$(aws iam get-role --role-name "${EXEC_ROLE_NAME}" --query Role.Arn --output text)"

# B layer: allow the role to assume itself (with a scoped session policy) so the
# bridge can derive per-user credentials. Idempotent.
if [ "${PER_USER_CREDS:-false}" = "true" ]; then
  log "Enabling per-user creds: self-assume + sts policy"
  STS_POLICY="$(printf '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Resource":"%s"}]}' "${ROLE_ARN}")"
  aws iam put-role-policy --role-name "${EXEC_ROLE_NAME}" \
    --policy-name "${PROJECT}-self-assume" \
    --policy-document "${STS_POLICY}"
  # Add the role itself as a trusted principal (merge with existing trust).
  MERGED_TRUST="$(python3 - "${TRUST}" "${ROLE_ARN}" <<'PY'
import json, sys
trust = json.loads(sys.argv[1]); role = sys.argv[2]
trust.setdefault("Statement", []).append({
    "Sid": "SelfAssumeForPerUserCreds",
    "Effect": "Allow",
    "Principal": {"AWS": role},
    "Action": "sts:AssumeRole",
})
print(json.dumps(trust))
PY
)"
  aws iam update-assume-role-policy --role-name "${EXEC_ROLE_NAME}" \
    --policy-document "${MERGED_TRUST}"
fi

log "Execution role ready: ${ROLE_ARN}"
echo "${ROLE_ARN}"
