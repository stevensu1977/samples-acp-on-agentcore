#!/usr/bin/env bash
# Shared config + helpers for the deploy scripts.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load config.env if present (copied from config.env.template).
if [ -f "${HERE}/config.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "${HERE}/config.env"; set +a
fi

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"

# AgentCore + ECR naming. Each agent gets its own repo + runtime.
PROJECT="acp-on-agentcore"
EXEC_ROLE_NAME="${EXEC_ROLE_NAME:-AcpOnAgentCoreExecutionRole}"
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# Valid agents (must match src/agents.ts AGENTS keys).
AGENTS=(kiro codex claude)

# Agent to operate on. Scripts accept it as $1, else fall back to AGENT env.
AGENT="${AGENT:-claude}"

repo_name()    { echo "${PROJECT}-$1"; }
runtime_name() { echo "acp_$1"; }   # AgentCore runtime names: letters/digits/underscore
image_uri()    { echo "${ECR_REGISTRY}/$(repo_name "$1"):latest"; }

require_agent() {
  local a="$1"
  for known in "${AGENTS[@]}"; do [ "$a" = "$known" ] && return 0; done
  echo "Unknown agent '$a'. Valid: ${AGENTS[*]}" >&2
  exit 1
}

# Resolve the agent for a script: explicit $1 wins, else AGENT from config/env.
resolve_arg_agent() {
  local a="${1:-$AGENT}"
  require_agent "$a"
  echo "$a"
}

# Build a self-contained image for linux/arm64 (required by AgentCore) and
# either --load it locally or --push it to the registry. Requires docker buildx
# (and qemu/binfmt for arm64 emulation when building on a non-arm64 host).
#   build_arm64 <dockerfile> <tag> <--load|--push> [extra build args...]
build_arm64() {
  local dockerfile="$1" tag="$2" mode="$3"; shift 3
  local ctx="${HERE}/.."
  if ! docker buildx version >/dev/null 2>&1; then
    echo "docker buildx is required (Docker 23+ / install the buildx plugin)." >&2
    exit 1
  fi
  # Ensure a builder that can target linux/arm64 exists.
  docker buildx inspect acpbuilder >/dev/null 2>&1 || \
    docker buildx create --name acpbuilder --driver docker-container >/dev/null
  docker buildx use acpbuilder
  docker buildx build --platform linux/arm64 -f "$dockerfile" -t "$tag" "$mode" "$@" "$ctx"
}

log() { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
