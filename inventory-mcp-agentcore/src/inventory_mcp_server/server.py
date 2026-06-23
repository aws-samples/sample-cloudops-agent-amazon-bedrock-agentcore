import os
from mcp.server.fastmcp import FastMCP
from .tools.eks import register_eks_tools
from .tools.rds import register_rds_tools
from .tools.opensearch import register_opensearch_tools
from .tools.elasticache import register_elasticache_tools
from .tools.msk import register_msk_tools

mcp = FastMCP(
    "inventory-mcp-server",
    instructions="""AWS Inventory Software Version Management MCP Server.
Provides tools to query EKS, RDS, OpenSearch, ElastiCache, and MSK clusters
with version info, status, end-of-support schedules, and more.""",
)

# Configure for AgentCore streamable-http transport.
# Intentional in-container bind (server runs inside an isolated AgentCore
# Runtime container, not exposed directly to the internet).
mcp.settings.host = '0.0.0.0'  # nosec B104 - intentional in-container bind, fronted by AgentCore Runtime
mcp.settings.port = 8000
mcp.settings.stateless_http = True
mcp.settings.transport_security = None

register_eks_tools(mcp)
register_rds_tools(mcp)
register_opensearch_tools(mcp)
register_elasticache_tools(mcp)
register_msk_tools(mcp)

def main():
    transport = os.environ.get("MCP_TRANSPORT", "stdio")
    if transport == "streamable-http":
        mcp.run(transport="streamable-http")
    else:
        mcp.run(transport="stdio")

if __name__ == "__main__":
    main()
