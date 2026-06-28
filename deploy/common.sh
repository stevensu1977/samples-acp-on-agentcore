#!/usr/bin/env bash
# Shared config + helpers for the deploy scripts.
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"

# AgentCore + ECR naming. Each agent gets its own repo + runtime.
PROJECT="acp-on-agentcore"
EXEC_ROLE_NAME="${EXEC_ROLE_NAME:-AcpOnAgentCoreExecutionRole}"
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# Valid agents (must match src/agents.ts AGENTS keys).
AGENTS=(kiro codex claude)

repo_name()    { echo "${PROJECT}-$1"; }
runtime_name() { echo "acp_$1"; }   # AgentCore runtime names: letters/digits/underscore
image_uri()    { echo "${ECR_REGISTRY}/$(repo_name "$1"):latest"; }

require_agent() {
  local a="$1"
  for known in "${AGENTS[@]}"; do [ "$a" = "$known" ] && return 0; done
  echo "Unknown agent '$a'. Valid: ${AGENTS[*]}" >&2
  exit 1
}

log() { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
