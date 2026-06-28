#!/usr/bin/env bash
# Remove the demo Glue database and tables created by setup_demo_data.sh.
# Usage: AWS_REGION=us-east-1 ./cleanup.sh
set -euo pipefail
AWS_REGION="${AWS_REGION:-us-east-1}"
DB_NAME="${DB_NAME:-demo_ecommerce}"

for t in orders customers products; do
  echo "Deleting table ${t}..."
  aws glue delete-table --region "${AWS_REGION}" --database-name "${DB_NAME}" --name "${t}" \
    2>/dev/null || echo "  (not found)"
done
echo "Deleting database ${DB_NAME}..."
aws glue delete-database --region "${AWS_REGION}" --name "${DB_NAME}" \
  2>/dev/null || echo "  (not found)"
echo "Done."
