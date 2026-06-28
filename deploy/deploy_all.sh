#!/usr/bin/env bash
# Run the full deploy for one agent: IAM role -> build/push -> create runtime.
#
# Usage: ./deploy_all.sh [kiro|codex|claude]
#   Agent defaults to $AGENT from config.env.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${HERE}/common.sh"

AGENT="$(resolve_arg_agent "${1:-}")"
log "Deploying agent: ${AGENT} (region ${AWS_REGION}, account ${AWS_ACCOUNT_ID})"

"${HERE}/00_setup_iam.sh"
"${HERE}/01_build_and_push.sh" "${AGENT}"
"${HERE}/02_deploy_agentcore.sh" "${AGENT}"

log "Done. Invoke with: ./deploy/invoke.sh ${AGENT} \"your prompt\""
