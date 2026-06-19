"""Main entry point for the EOL scraper Lambda."""
import boto3
import os
from datetime import datetime
from .scrapers import eks, rds, elasticache, opensearch, msk


def get_region():
    return (
        os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or boto3.Session().region_name
    )


def get_table_name():
    return os.environ.get("EOL_TABLE_NAME", "aws-eol-schedules")


def create_table_if_not_exists():
    dynamodb = boto3.client("dynamodb", region_name=get_region())
    table_name = get_table_name()
    try:
        dynamodb.describe_table(TableName=table_name)
        print(f"Table {table_name} already exists.")
    except dynamodb.exceptions.ResourceNotFoundException:
        print(f"Creating table {table_name}...")
        dynamodb.create_table(
            TableName=table_name,
            KeySchema=[
                {"AttributeName": "service", "KeyType": "HASH"},
                {"AttributeName": "version", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "service", "AttributeType": "S"},
                {"AttributeName": "version", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        waiter = dynamodb.get_waiter("table_exists")
        waiter.wait(TableName=table_name)
        print(f"Table {table_name} created.")


def write_to_dynamodb(items: list[dict]):
    dynamodb = boto3.resource("dynamodb", region_name=get_region())
    table = dynamodb.Table(get_table_name())
    updated_at = datetime.utcnow().isoformat() + "Z"
    seen = set()
    with table.batch_writer() as batch:
        for item in items:
            key = (item["service"], item["version"])
            if key in seen:
                continue
            seen.add(key)
            batch.put_item(Item={
                "service": item["service"],
                "version": item["version"],
                "end_of_standard_support": item.get("end_of_standard_support", "Unknown"),
                "end_of_extended_support": item.get("end_of_extended_support", "Unknown"),
                "status": item.get("status", ""),
                "release_date": item.get("release_date", ""),
                "source": item.get("source", ""),
                "updated_at": updated_at,
            })
    print(f"  Written {len(seen)} records.")


def run():
    print("=== AWS EOL Schedule Scraper ===")
    print(f"Region: {get_region()}")
    print(f"Table: {get_table_name()}")
    print()

    create_table_if_not_exists()
    region = get_region()

    print("[EKS] Fetching from DescribeClusterVersions API...")
    eks_data = eks.fetch(region)
    print(f"  Found {len(eks_data)} versions.")
    if eks_data:
        write_to_dynamodb(eks_data)

    print("[RDS/Aurora] Scraping AWS docs...")
    rds_data = rds.fetch(region)
    print(f"  Found {len(rds_data)} versions.")
    if rds_data:
        write_to_dynamodb(rds_data)

    print("[ElastiCache] Scraping AWS docs...")
    ec_data = elasticache.fetch(region)
    print(f"  Found {len(ec_data)} versions.")
    if ec_data:
        write_to_dynamodb(ec_data)

    print("[OpenSearch] Scraping AWS docs...")
    os_data = opensearch.fetch(region)
    print(f"  Found {len(os_data)} versions.")
    if os_data:
        write_to_dynamodb(os_data)

    print("[MSK] Scraping AWS docs...")
    msk_data = msk.fetch(region)
    print(f"  Found {len(msk_data)} versions.")
    if msk_data:
        write_to_dynamodb(msk_data)

    total = len(eks_data) + len(rds_data) + len(ec_data) + len(os_data) + len(msk_data)
    print(f"\n✓ Done. Total {total} records written to DynamoDB.")
    return total


def handler(event, context):
    """AWS Lambda handler for the EOL scraper.

    Invoked on a daily schedule via EventBridge to refresh
    end-of-support data in DynamoDB.
    """
    print("=== AWS EOL Schedule Scraper (Lambda) ===")
    print(f"Region: {get_region()}")
    print(f"Table: {get_table_name()}")

    create_table_if_not_exists()
    region = get_region()

    # Collect all scraped data
    all_data = []

    print("[EKS] Fetching from DescribeClusterVersions API...")
    eks_data = eks.fetch(region)
    print(f"  Found {len(eks_data)} versions.")
    all_data.extend(eks_data)

    print("[RDS/Aurora] Scraping AWS docs...")
    rds_data = rds.fetch(region)
    print(f"  Found {len(rds_data)} versions.")
    all_data.extend(rds_data)

    print("[ElastiCache] Scraping AWS docs...")
    ec_data = elasticache.fetch(region)
    print(f"  Found {len(ec_data)} versions.")
    all_data.extend(ec_data)

    print("[OpenSearch] Scraping AWS docs...")
    os_data = opensearch.fetch(region)
    print(f"  Found {len(os_data)} versions.")
    all_data.extend(os_data)

    print("[MSK] Scraping AWS docs...")
    msk_data = msk.fetch(region)
    print(f"  Found {len(msk_data)} versions.")
    all_data.extend(msk_data)

    # Deduplicate by (service, version)
    seen = set()
    unique_data = []
    for item in all_data:
        key = (item["service"], item["version"])
        if key not in seen:
            seen.add(key)
            unique_data.append(item)

    # Write deduplicated records to DynamoDB
    if unique_data:
        write_to_dynamodb(unique_data)

    summary = {
        "total_scraped": len(all_data),
        "unique_records": len(unique_data),
        "by_service": {
            "eks": len(eks_data),
            "rds": len(rds_data),
            "elasticache": len(ec_data),
            "opensearch": len(os_data),
            "msk": len(msk_data),
        },
    }

    print(f"\n✓ Done. {len(unique_data)} unique records written to DynamoDB.")
    return summary


if __name__ == "__main__":
    run()
