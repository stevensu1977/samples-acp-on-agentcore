#!/usr/bin/env bash
# Real concurrency / isolation test for the deployed Claude runtime.
#
# Fires N invocations IN PARALLEL, each with a DISTINCT runtime-session-id and
# user-id, and each carrying a unique MARKER. Each prompt asks Claude to:
#   1. write its marker to a file in the session workspace, then
#   2. list every marker file it can see and echo them back.
#
# Isolation is proven if, for every session, the response:
#   - contains ONLY that session's own marker, and
#   - never contains any OTHER session's marker (no cross-talk / no shared fs).
#
# Because each distinct session-id is routed to its own microVM (AgentCore
# session affinity), correct isolation means N independent workspaces.
#
# Usage: [N=4] [AWS_REGION=us-east-1] ./run_concurrency_test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
source "${ROOT}/deploy/common.sh" >/dev/null 2>&1 || true

REGION="${AWS_REGION:-us-east-1}"
N="${N:-4}"
RT_NAME="acp_claude"
ARN="$(aws bedrock-agentcore-control list-agent-runtimes --region "${REGION}" \
  --query "agentRuntimes[?agentRuntimeName=='${RT_NAME}'].agentRuntimeArn | [0]" --output text)"
if [ "${ARN}" = "None" ] || [ -z "${ARN}" ]; then
  echo "No ${RT_NAME} runtime found. Deploy it first." >&2; exit 1
fi

WORKDIR="$(mktemp -d /tmp/acp-conc-XXXX)"
echo "Runtime: ${ARN}"
echo "Firing ${N} parallel invocations (distinct session-ids)..."
echo "Scratch: ${WORKDIR}"
echo

# A fixed run tag so markers are unique to THIS test run (avoid stale files from
# prior runs persisting in session storage). Passed in, since scripts can't use Date.now.
RUN_TAG="$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"

invoke_one() {
  local i="$1"
  local marker="MARKER_${RUN_TAG}_user${i}"
  # session-id must be >= 33 chars; make it unique + padded.
  local sid="conc-${RUN_TAG}-s${i}-padding000000000000000000"
  sid="${sid:0:64}"
  local uid="user${i}"
  local prompt
  prompt=$(printf 'You are in an isolated workspace. Do EXACTLY this and nothing else:\n1) Run: echo %s > ./my_marker.txt\n2) Run: ls -1 *.txt 2>/dev/null; then cat each .txt file.\n3) Report the exact contents of every .txt file you found. Your unique marker is %s.' "${marker}" "${marker}")

  local out="${WORKDIR}/resp_${i}.sse"
  aws bedrock-agentcore invoke-agent-runtime \
    --region "${REGION}" \
    --cli-binary-format raw-in-base64-out \
    --agent-runtime-arn "${ARN}" \
    --runtime-session-id "${sid}" \
    --runtime-user-id "${uid}" \
    --content-type "application/json" \
    --accept "text/event-stream" \
    --payload "$(printf '{"prompt": %s}' "$(printf '%s' "${prompt}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")" \
    "${out}" >/dev/null 2>"${WORKDIR}/err_${i}.txt" \
    && echo "  [user${i}] done" \
    || echo "  [user${i}] FAILED ($(head -1 "${WORKDIR}/err_${i}.txt"))"
}

# Launch all in parallel.
pids=()
for i in $(seq 1 "${N}"); do invoke_one "$i" & pids+=($!); done
for p in "${pids[@]}"; do wait "$p"; done

echo
echo "=== Isolation check ==="
# Extract assistant text per response and check marker visibility.
fail=0
for i in $(seq 1 "${N}"); do
  out="${WORKDIR}/resp_${i}.sse"
  [ -f "$out" ] || { echo "  [user${i}] no response"; fail=1; continue; }
  text="$(python3 - "$out" <<'PY'
import json,sys
t=[]
for line in open(sys.argv[1]):
    if not line.startswith("data: "): continue
    try: ev=json.loads(line[6:])
    except: continue
    u=ev.get("update",{})
    if u.get("sessionUpdate")=="agent_message_chunk" and u.get("content",{}).get("type")=="text":
        t.append(u["content"]["text"])
print("".join(t))
PY
)"
  own="MARKER_${RUN_TAG}_user${i}"
  saw_own=0; leaked=""
  echo "$text" | grep -q "$own" && saw_own=1
  for j in $(seq 1 "${N}"); do
    [ "$j" = "$i" ] && continue
    other="MARKER_${RUN_TAG}_user${j}"
    echo "$text" | grep -q "$other" && leaked="${leaked} user${j}"
  done
  if [ "$saw_own" = 1 ] && [ -z "$leaked" ]; then
    echo "  [user${i}] PASS — saw own marker, no other markers"
  else
    echo "  [user${i}] FAIL — saw_own=${saw_own} leaked_markers_from:${leaked:-none}"
    fail=1
  fi
done

echo
if [ "$fail" = 0 ]; then
  echo "RESULT: PASS — all ${N} sessions isolated, no cross-talk."
else
  echo "RESULT: FAIL — see above. Raw responses in ${WORKDIR}"
  exit 1
fi
echo "Raw SSE responses: ${WORKDIR}/resp_*.sse"
