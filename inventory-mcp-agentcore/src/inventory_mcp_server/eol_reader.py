"""Read EOL data from DynamoDB. Falls back to empty dict if table doesn't exist."""
import boto3
import os
import time
import logging
from typing import Dict

logger = logging.getLogger(__name__)

# Simple TTL cache for EOL data (avoids hitting DynamoDB on every tool call)
_cache: Dict[str, tuple] = {}  # {service: (data, timestamp)}
_CACHE_TTL_SECONDS = int(os.environ.get("EOL_CACHE_TTL", "300"))  # 5 minutes default


def _get_table():
    region = (
        os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or boto3.Session().region_name
    )
    dynamodb = boto3.resource("dynamodb", region_name=region)
    return dynamodb.Table(os.environ.get("EOL_TABLE_NAME", "aws-eol-schedules"))


def get_eol_schedule(service: str) -> dict[str, dict]:
    """Get EOL data for a service. Returns {version: {end_of_standard_support, end_of_extended_support, ...}}.
    
    Uses a TTL-based cache to avoid excessive DynamoDB reads.
    Falls back to empty dict if table doesn't exist or query fails.
    """
    # Check cache
    if service in _cache:
        data, cached_at = _cache[service]
        if time.time() - cached_at < _CACHE_TTL_SECONDS:
            return data

    try:
        table = _get_table()
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("service").eq(service)
        )
        result = {}
        for item in resp.get("Items", []):
            result[item["version"]] = {
                "end_of_standard_support": item.get("end_of_standard_support", "Unknown"),
                "end_of_extended_support": item.get("end_of_extended_support", "Unknown"),
                "status": item.get("status", ""),
                "release_date": item.get("release_date", ""),
            }
        # Update cache
        _cache[service] = (result, time.time())
        return result
    except Exception as e:
        logger.warning(f"Failed to read EOL data for {service}: {e}. Returning empty schedule.")
        return {}
