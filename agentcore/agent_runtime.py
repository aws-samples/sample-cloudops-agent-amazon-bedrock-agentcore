"""
Amazon Bedrock Agent Core Runtime - CloudOps Agent
Uses BedrockAgentCoreApp for proper authentication and Gateway integration
"""
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager
from strands import Agent
from strands.models import BedrockModel
from strands.tools.mcp import MCPClient
from botocore.credentials import Credentials
from streamable_http_sigv4 import streamablehttp_client_with_sigv4
import os
import boto3
import logging
from datetime import datetime, timezone

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize the Agent Core app
app = BedrockAgentCoreApp()

# Get configuration from environment
GATEWAY_ARN = os.environ.get('GATEWAY_ARN')
MEMORY_ID = os.environ.get('MEMORY_ID')
MODEL_ID = os.environ.get('MODEL_ID', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')
AWS_REGION = os.environ.get('AWS_REGION') or boto3.Session().region_name

logger.info(f"Gateway ARN: {GATEWAY_ARN}")
logger.info(f"Model ID: {MODEL_ID}")
logger.info(f"Memory ID: {MEMORY_ID}")
logger.info(f"AWS Region: {AWS_REGION}")

if not GATEWAY_ARN:
    logger.error("Gateway ARN not configured!")
else:
    logger.info("Gateway configured successfully")

if MEMORY_ID:
    logger.info(f"Memory enabled: {MEMORY_ID}")
else:
    logger.warning("Memory ID not configured - memory disabled")

# Initialize Bedrock model
model = BedrockModel(
    model_id=MODEL_ID,
    region_name=AWS_REGION
)

# Get AWS credentials for SigV4 signing
session = boto3.Session()
credentials = session.get_credentials()
frozen_credentials = Credentials(
    access_key=credentials.access_key,
    secret_key=credentials.secret_key,
    token=credentials.token
)

# Extract Gateway ID from ARN and construct endpoint URL
gateway_id = GATEWAY_ARN.split('/')[-1] if GATEWAY_ARN else None
gateway_endpoint = f"https://{gateway_id}.gateway.bedrock-agentcore.{AWS_REGION}.amazonaws.com/mcp" if gateway_id else None

logger.info(f"Gateway Endpoint: {gateway_endpoint}")


def get_current_date_utc() -> str:
    """Get current date and time in UTC for cost query context"""
    try:
        now = datetime.now(timezone.utc)
        return now.strftime("%Y-%m-%d (%A) %H:00 UTC")
    except Exception as e:
        logger.warning(f"Failed to get current date: {e}")
        return "2026-01-24 (Friday) 12:00 UTC"


# Global MCP client to keep connection alive
mcp_client = None
agent = None
mcp_tools = []  # Store tools globally
system_prompt_template = ""  # Store system prompt template


def initialize_agent_with_gateway():
    """Initialize agent with Gateway tools using MCP Client with SigV4 auth"""
    global mcp_client, agent, mcp_tools, system_prompt_template
    
    try:
        if not gateway_endpoint:
            logger.error("Cannot initialize: Gateway endpoint not configured")
            agent = Agent(
                model=model,
                system_prompt="I'm sorry, but I'm not properly configured. Please contact support."
            )
            return
        
        logger.info("🔧 Initializing MCP Client with SigV4 authentication...")
        
        # Create MCP client with SigV4 authentication
        mcp_client = MCPClient(lambda: streamablehttp_client_with_sigv4(
            url=gateway_endpoint,
            credentials=frozen_credentials,
            service="bedrock-agentcore",
            region=AWS_REGION
        ))
        
        # Start the MCP client connection
        mcp_client.__enter__()
        
        # Get tools from Gateway (handle pagination)
        logger.info("📋 Listing tools from Gateway...")
        all_tools = []
        pagination_token = None
        while True:
            tools_page = mcp_client.list_tools_sync(pagination_token=pagination_token)
            all_tools.extend(tools_page)
            logger.info(f"  Retrieved {len(tools_page)} tools (total so far: {len(all_tools)})")
            # Check if there are more pages
            if hasattr(tools_page, 'pagination_token') and tools_page.pagination_token:
                pagination_token = tools_page.pagination_token
                logger.info(f"  More tools available, fetching next page...")
            else:
                break
        mcp_tools = all_tools
        logger.info(f"✅ Retrieved {len(mcp_tools)} tools from Gateway (all pages)")
        
        # Get current date for system prompt
        current_date = get_current_date_utc()
        
        # Store system prompt template for reuse
        # IMPORTANT: Don't list specific tool names in system prompt
        # Gateway prefixes tool names, so let the agent discover them dynamically
        system_prompt_template = f"""You are a CloudOps AI assistant specialized in AWS cost optimization and analysis.

Current date: {current_date}

You have access to tools for:
- Cost Analysis: Retrieve AWS costs, analyze spending by service or usage type, forecast costs, detect anomalies
- Budget Management: View budgets and their status
- Optimization: Get recommendations for compute optimization, rightsizing, and savings plans
- Free Tier: Monitor AWS Free Tier usage
- Pricing: Look up AWS service pricing, compare instance costs, get pricing details
- CloudWatch Monitoring: Query metrics, check alarm status, list log groups, run CloudWatch Logs Insights queries
- CloudTrail Auditing: Look up API event history, check trail status, investigate resource changes and account activity
- Cluster Inventory: List clusters across AWS managed services, check version end-of-support dates, get cluster details, query supported versions. Covers EKS, RDS/Aurora, OpenSearch, ElastiCache, and MSK services

IMPORTANT - Tool Discovery with Gateway Search:
The Gateway uses semantic search. Not all tools are immediately visible. When you need to use CloudWatch or CloudTrail tools:
1. FIRST call the "x_amz_bedrock_agentcore_search" tool with a query describing what you need (e.g., "describe log groups", "lookup cloudtrail events", "get metric data", "get active alarms")
2. The search tool will return the actual tool names you can then call
3. Then call the discovered tool with appropriate parameters

For billing/cost tools (billingMcp___*), you can call them directly - they are already loaded.
For CloudWatch and CloudTrail tools, you MUST use x_amz_bedrock_agentcore_search first to discover the available tool, then call it.

When a user asks about costs or pricing:
1. Use the appropriate billing tools directly to gather the information
2. Provide clear, actionable recommendations
3. Always mention specific time periods, services, or resources in your responses

When using the AWS Pricing tools:
- IMPORTANT: Always use tools prefixed with "pricingMcp__" for pricing lookups (e.g., pricingMcp__get_products, pricingMcp__get_pricing_service_codes). Do NOT use billingMcp__ tools for pricing queries.
- First use x_amz_bedrock_agentcore_search to find pricing tools, then call them
- First call pricingMcp__get_pricing_service_codes to find the correct service code (e.g., "AmazonEC2", "AmazonS3", "AmazonCloudWatch")
- Then call pricingMcp__get_pricing_service_attributes to discover available filter names for that service
- Then call pricingMcp__get_pricing_attribute_values to get valid values for a specific attribute
- When calling pricingMcp__get_products, use the exact filter names and values from the above steps
- For EC2 pricing, common filters include: instanceType, operatingSystem (Linux), tenancy (Shared), preInstalledSw (NA), capacitystatus (Used)
- AWS region names in the Pricing API use display names like "US East (N. Virginia)" not region codes like "us-east-1"

When using CloudWatch tools:
- FIRST call x_amz_bedrock_agentcore_search with a relevant query like "describe log groups" or "get metric data" or "get active alarms"
- The search will return available CloudWatch tools (prefixed with "cloudwatchMcp___")
- Then call the discovered tool with appropriate parameters
- Use these when the user asks about operational health, monitoring, or log investigation
- For metrics queries, specify the namespace (e.g., "AWS/EC2", "AWS/RDS") and metric name
- For log insights, specify the log group and query string

When using CloudTrail tools:
- FIRST call x_amz_bedrock_agentcore_search with a relevant query like "lookup events" or "cloudtrail events"
- The search will return available CloudTrail tools (prefixed with "cloudtrailMcp___")
- Then call the discovered tool with appropriate parameters
- Use these when the user asks about who did what, resource changes, or account auditing
- For event lookups, you can filter by event source, resource type, or username
- CloudTrail provides the audit trail of API calls made in the AWS account

When using Inventory tools:
- FIRST call x_amz_bedrock_agentcore_search with a relevant query like "list clusters", "cluster versions", "end of support", or "inventory"
- The search will return available inventory tools (prefixed with "inventoryMcp__")
- Then call the discovered tool with appropriate parameters
- Use these when the user asks about cluster inventory, version management, end-of-life (EOL) schedules, or end-of-support dates
- Inventory tools cover the following AWS managed services: EKS, RDS/Aurora, OpenSearch, ElastiCache, and MSK
- You can list all clusters across regions for a service, check which versions are approaching end-of-support, get detailed cluster information, and query supported versions
- For version lifecycle questions, the tools provide end-of-standard-support and end-of-extended-support dates

Be concise, accurate, and actionable in your responses."""
        
        # Create agent with Gateway tools (memory will be added per-request)
        # Note: We don't add session_manager here because it's request-specific
        agent = Agent(
            model=model,
            tools=mcp_tools,
            system_prompt=system_prompt_template
        )
        
        logger.info("✅ Agent created successfully with Gateway tools - connection kept alive")
            
    except Exception as e:
        logger.error(f"❌ Error initializing agent with Gateway: {e}", exc_info=True)
        # Create a fallback agent without tools
        agent = Agent(
            model=model,
            system_prompt="I'm sorry, but I'm having trouble accessing my tools right now. Please try again later."
        )


# Initialize agent with Gateway
logger.info("🚀 Initializing agent with Gateway-backed MCP tools using IAM SigV4 authentication")
initialize_agent_with_gateway()


@app.entrypoint
def invoke(payload):
    """
    Process user input and return CloudOps analysis
    """
    global agent

    user_message = payload.get("prompt", "")
    session_id = payload.get("sessionId", "default_session")
    user_id = payload.get("userId", "default_user")

    if not user_message:
        logger.error("No prompt provided in payload")
        return {
            "error": "No prompt provided",
            "message": "Please provide a 'prompt' key in the input"
        }

    logger.info(f"📨 Processing request - Session: {session_id}")

    # Create agent with memory session manager if memory is configured
    agent_with_memory = agent  # Default to base agent

    if MEMORY_ID and mcp_tools:  # Only configure memory if we have tools
        try:
            logger.info(f"💾 Configuring memory - Memory ID: {MEMORY_ID}, Session: {session_id}")

            memory_config = AgentCoreMemoryConfig(
                memory_id=MEMORY_ID,
                session_id=session_id,
                actor_id=user_id
            )

            session_manager = AgentCoreMemorySessionManager(
                agentcore_memory_config=memory_config,
                region_name=AWS_REGION
            )

            # Create agent with session manager (memory handled automatically)
            agent_with_memory = Agent(
                model=model,
                tools=mcp_tools,  # Use globally stored tools
                system_prompt=system_prompt_template,  # Use stored system prompt
                session_manager=session_manager  # This handles memory automatically!
            )

            logger.info("✅ Agent configured with memory session manager")

        except Exception as e:
            logger.warning(f"⚠️ Could not configure memory, using agent without memory: {e}")
            agent_with_memory = agent
    else:
        if not MEMORY_ID:
            logger.info("ℹ️ Memory not configured, using agent without memory")
        else:
            logger.warning("⚠️ Tools not available, using agent without memory")

    # Invoke agent - memory is handled automatically by session_manager
    try:
        logger.info("🤖 Invoking agent...")
        result = agent_with_memory(user_message)

        # Extract the final message from the result
        if hasattr(result, 'message'):
            final_message = result.message
        elif hasattr(result, 'content'):
            final_message = result.content
        elif isinstance(result, str):
            final_message = result
        else:
            final_message = str(result)

        # If final_message is a dict with role/content structure, extract the text
        if isinstance(final_message, dict):
            if 'content' in final_message and isinstance(final_message['content'], list):
                final_message = ''.join([item.get('text', '') for item in final_message['content'] if 'text' in item])
            elif 'text' in final_message:
                final_message = final_message['text']

        logger.info("✅ Request processed successfully")

        response = {
            "result": final_message,
            "sessionId": session_id,
            "userId": user_id
        }

        return response

    except Exception as e:
        logger.error(f"❌ Agent invocation error: {e}", exc_info=True)
        return {
            "error": "Agent processing failed",
            "message": str(e),
            "sessionId": session_id
        }


if __name__ == "__main__":
    logger.info("🚀 Starting CloudOps Agent Runtime with BedrockAgentCoreApp")
    logger.info(f"📊 Model: {MODEL_ID}")
    logger.info(f"🌐 Gateway: {gateway_endpoint}")
    logger.info(f"💾 Memory: {MEMORY_ID if MEMORY_ID else 'Disabled'}")
    app.run()
