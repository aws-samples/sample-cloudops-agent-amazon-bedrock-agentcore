"""MCP Server for EOL Schedule Scraping."""
import os
from mcp.server.fastmcp import FastMCP
from .scrapers import eks, rds, elasticache, opensearch, msk
from .main import write_to_dynamodb, create_table_if_not_exists, get_region

mcp = FastMCP(
    "eol-scraper-mcp-server",
    instructions="Scrapes AWS end-of-support schedules from APIs and docs, stores them in DynamoDB.",
)


@mcp.tool()
def scrape_all() -> dict:
    """Scrape EOL schedules for all services (EKS, RDS, ElastiCache, OpenSearch, MSK) and write to DynamoDB."""
    create_table_if_not_exists()
    region = get_region()
    results = {}

    eks_data = eks.fetch(region)
    if eks_data:
        write_to_dynamodb(eks_data)
    results["eks"] = len(eks_data)

    rds_data = rds.fetch(region)
    if rds_data:
        write_to_dynamodb(rds_data)
    results["rds"] = len(rds_data)

    ec_data = elasticache.fetch(region)
    if ec_data:
        write_to_dynamodb(ec_data)
    results["elasticache"] = len(ec_data)

    os_data = opensearch.fetch(region)
    if os_data:
        write_to_dynamodb(os_data)
    results["opensearch"] = len(os_data)

    msk_data = msk.fetch(region)
    if msk_data:
        write_to_dynamodb(msk_data)
    results["msk"] = len(msk_data)

    results["total"] = sum(results.values())
    return results


@mcp.tool()
def scrape_eks() -> list[dict]:
    """Scrape EKS version EOL schedule from DescribeClusterVersions API and write to DynamoDB."""
    create_table_if_not_exists()
    data = eks.fetch(get_region())
    if data:
        write_to_dynamodb(data)
    return data


@mcp.tool()
def scrape_rds() -> list[dict]:
    """Scrape RDS/Aurora major version EOL schedule from AWS docs and write to DynamoDB."""
    create_table_if_not_exists()
    data = rds.fetch(get_region())
    if data:
        write_to_dynamodb(data)
    return data


@mcp.tool()
def scrape_elasticache() -> list[dict]:
    """Scrape ElastiCache Redis/Valkey EOL schedule from AWS docs and write to DynamoDB."""
    create_table_if_not_exists()
    data = elasticache.fetch(get_region())
    if data:
        write_to_dynamodb(data)
    return data


@mcp.tool()
def scrape_opensearch() -> list[dict]:
    """Scrape OpenSearch EOL schedule from AWS docs and write to DynamoDB."""
    create_table_if_not_exists()
    data = opensearch.fetch(get_region())
    if data:
        write_to_dynamodb(data)
    return data


@mcp.tool()
def scrape_msk() -> list[dict]:
    """Scrape MSK Kafka EOL schedule from AWS docs and write to DynamoDB."""
    create_table_if_not_exists()
    data = msk.fetch(get_region())
    if data:
        write_to_dynamodb(data)
    return data


def main():
    transport = os.environ.get("MCP_TRANSPORT", "stdio")
    if transport == "streamable-http":
        # Intentional in-container bind, fronted by AgentCore Runtime (not exposed directly).
        mcp.run(transport="streamable-http", host="0.0.0.0", port=8001)  # nosec B104
    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
