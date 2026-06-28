#!/usr/bin/env bash
# Invoke the deployed Claude runtime with a Glue semantic-search prompt and
# pretty-print which skill was used, the AWS commands the skill ran, and the
# final answer — by parsing the SSE stream of ACP session updates.
#
# Usage:
#   ./run_test.sh pii        # find tables containing customer PII (finding-data-lake-assets)
#   ./run_test.sh audit      # inventory/audit the whole catalog (exploring-data-catalog)
#   ./run_test.sh "<prompt>" # any custom prompt
#
# Requires: the acp_claude runtime deployed (deploy/02_deploy_agentcore.sh claude)
# and demo data created (./setup_demo_data.sh). Uses deploy/invoke.sh for SigV4.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
REGION="${AWS_REGION:-us-east-1}"

case "${1:-pii}" in
  pii)
    PROMPT="I'm looking for data in our AWS Glue catalog (region ${REGION}). Which tables contain customer PII like email or phone? Use your data analytics skills to search the catalog. Tell me which skill you used, the exact commands you ran, and what you found."
    ;;
  audit)
    PROMPT="Give me an inventory/audit of our entire Glue Data Catalog in ${REGION}: what databases and tables exist, their business domains and data owners, and a column-level overview of each table. Use your data analytics skills and tell me which skill(s) you used."
    ;;
  *)
    PROMPT="$1"
    ;;
esac

echo "Prompt: ${PROMPT}"
echo "Invoking acp_claude ..."
"${ROOT}/deploy/invoke.sh" claude "${PROMPT}" >/dev/null 2>&1

LAST="$(ls -t /tmp/acp-resp-*.sse 2>/dev/null | head -1)"
if [ -z "${LAST}" ]; then echo "No SSE response captured." >&2; exit 1; fi

echo
echo "=== Skill(s) invoked ==="
grep -o '"rawInput":{"skill":"[^"]*"' "${LAST}" | sed 's/.*"skill":"/  - /' | sort -u || echo "  (none detected)"

echo
echo "=== AWS commands the skill ran ==="
grep -o '"command":"aws [^"\\]*"' "${LAST}" | sed 's/"command":"/  $ /;s/"$//' | sort -u || echo "  (none)"

echo
echo "=== Final answer ==="
python3 - "${LAST}" <<'PY'
import json, sys
out = []
for line in open(sys.argv[1]):
    if not line.startswith("data: "):
        continue
    try:
        ev = json.loads(line[6:])
    except Exception:
        continue
    u = ev.get("update", {})
    if u.get("sessionUpdate") == "agent_message_chunk":
        c = u.get("content", {})
        if c.get("type") == "text":
            out.append(c["text"])
    elif ev.get("type") == "stop":
        pass
print("".join(out).strip() or "(no text returned)")
PY
echo
echo "(raw SSE saved at: ${LAST})"
