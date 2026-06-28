#!/usr/bin/env bash
# Create a small demo Glue Data Catalog (database + 3 richly-described tables)
# so the aws-data-analytics skills have something to discover.
#
# Tables carry Chinese+English descriptions, column comments, and
# business_domain / data_owner / pii_columns parameters — exactly the kind of
# metadata the skills surface during semantic search.
#
# Usage: AWS_REGION=us-east-1 ./setup_demo_data.sh
# Idempotent: re-running is safe (create errors on existing resources are ignored).
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
DB_NAME="${DB_NAME:-demo_ecommerce}"

echo "Region:   ${AWS_REGION}"
echo "Database: ${DB_NAME}"
echo

aws sts get-caller-identity --query Arn --output text >/dev/null

echo "Creating database ${DB_NAME}..."
aws glue create-database --region "${AWS_REGION}" \
  --database-input "{\"Name\":\"${DB_NAME}\",\"Description\":\"电商业务数据库 - Glue语义搜索演示 (e-commerce demo)\"}" \
  2>/dev/null || echo "  (already exists, skipping)"

echo "Creating table orders..."
aws glue create-table --region "${AWS_REGION}" --database-name "${DB_NAME}" --table-input '{
  "Name":"orders","Description":"客户订单明细表，包含订单全生命周期数据。业务域：交易。数据所有者：交易团队。",
  "StorageDescriptor":{"Columns":[
    {"Name":"order_id","Type":"string","Comment":"订单唯一标识符"},
    {"Name":"customer_id","Type":"string","Comment":"客户ID，关联customers表"},
    {"Name":"order_date","Type":"timestamp","Comment":"下单时间"},
    {"Name":"total_amount","Type":"decimal(18,2)","Comment":"订单总金额（含税）"},
    {"Name":"status","Type":"string","Comment":"订单状态：pending/paid/shipped/completed/cancelled"},
    {"Name":"payment_method","Type":"string","Comment":"支付方式：credit_card/alipay/wechat"},
    {"Name":"shipping_address","Type":"string","Comment":"配送地址（JSON格式）"}],
    "Location":"s3://demo-data-lake/ecommerce/orders/"},
  "PartitionKeys":[{"Name":"dt","Type":"string","Comment":"分区键：日期 yyyy-MM-dd"}],
  "Parameters":{"classification":"parquet","business_domain":"transaction","data_owner":"trading-team","pii_columns":"shipping_address","update_frequency":"real-time"}}' \
  2>/dev/null || echo "  (already exists, skipping)"

echo "Creating table customers..."
aws glue create-table --region "${AWS_REGION}" --database-name "${DB_NAME}" --table-input '{
  "Name":"customers","Description":"客户主数据表，包含注册信息和会员等级。业务域：用户。数据所有者：用户增长团队。",
  "StorageDescriptor":{"Columns":[
    {"Name":"customer_id","Type":"string","Comment":"客户唯一标识符"},
    {"Name":"name","Type":"string","Comment":"客户姓名"},
    {"Name":"email","Type":"string","Comment":"注册邮箱（PII）"},
    {"Name":"phone","Type":"string","Comment":"手机号（PII）"},
    {"Name":"membership_level","Type":"string","Comment":"会员等级：bronze/silver/gold/platinum"},
    {"Name":"registered_at","Type":"timestamp","Comment":"注册时间"},
    {"Name":"lifetime_value","Type":"decimal(18,2)","Comment":"客户生命周期价值（LTV）"}],
    "Location":"s3://demo-data-lake/ecommerce/customers/"},
  "Parameters":{"classification":"parquet","business_domain":"user","data_owner":"growth-team","pii_columns":"email,phone,name"}}' \
  2>/dev/null || echo "  (already exists, skipping)"

echo "Creating table products..."
aws glue create-table --region "${AWS_REGION}" --database-name "${DB_NAME}" --table-input '{
  "Name":"products","Description":"商品主数据表，包含SKU信息和分类。业务域：商品。数据所有者：商品运营团队。",
  "StorageDescriptor":{"Columns":[
    {"Name":"product_id","Type":"string","Comment":"商品唯一标识符"},
    {"Name":"product_name","Type":"string","Comment":"商品名称"},
    {"Name":"category","Type":"string","Comment":"一级类目"},
    {"Name":"price","Type":"decimal(18,2)","Comment":"当前售价"},
    {"Name":"cost","Type":"decimal(18,2)","Comment":"成本价（内部）"},
    {"Name":"stock_quantity","Type":"int","Comment":"当前库存量"}],
    "Location":"s3://demo-data-lake/ecommerce/products/"},
  "Parameters":{"classification":"parquet","business_domain":"product","data_owner":"product-ops-team"}}' \
  2>/dev/null || echo "  (already exists, skipping)"

echo
echo "Tables in ${DB_NAME}:"
aws glue get-tables --region "${AWS_REGION}" --database-name "${DB_NAME}" \
  --query 'TableList[].Name' --output text
echo "Done."
