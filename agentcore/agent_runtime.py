"""
Amazon Bedrock Agent Core Runtime - CloudOps Agent
Uses BedrockAgentCoreApp for proper authentication and Gateway integration
"""
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from bedrock_agentcore.runtime import BedrockAgentCoreContext
from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager
from strands import Agent
from strands.models import BedrockModel
from strands.tools.mcp import MCPClient
from botocore.credentials import Credentials
from streamable_http_sigv4 import streamablehttp_client_with_sigv4
from streamable_http_bearer import streamablehttp_client_with_bearer
from authorization_model import is_authorization_denial, build_denial_response
import os
import boto3
import logging
from datetime import datetime, timezone
from typing import Optional

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


# Dedicated payload field carrying the user's Cognito token. The role is NEVER
# read from the payload — only the verified JWT claims at the Gateway determine
# the role. We forward the token unmodified and let the Gateway derive the role.
USER_TOKEN_PAYLOAD_FIELD = "accessToken"  # nosec B105 - JSON field name, not a credential


def resolve_user_token(payload: dict, context=None) -> Optional[str]:
    """Resolve the user's Cognito JWT from the inbound request.

    The token is read ONLY from the authenticated inbound request — never any
    role value from the payload. Resolution order:

    1. A dedicated payload field (``accessToken``) carrying the user's Cognito
       token forwarded by the FrontEnd.
    2. The runtime's own inbound JWT context (the ``WorkloadAccessToken`` the
       Gateway/runtime extracts from the inbound request headers), exposed via
       ``BedrockAgentCoreContext.get_workload_access_token()``.

    Returns the token string if one resolves, otherwise ``None``. When ``None``
    is returned the caller still invokes the Gateway; the Gateway applies the
    NonAdmin role by default (Req 7.4).

    NOTE: This function deliberately does not read any ``role``/``Role`` field
    from the payload. Role must come only from the verified token claims at the
    Gateway (Req 1.5).
    """
    # 1. Dedicated payload field forwarded by the FrontEnd.
    token = payload.get(USER_TOKEN_PAYLOAD_FIELD) if isinstance(payload, dict) else None
    if token:
        logger.info("🔐 Resolved user token from inbound payload field")
        return token

    # 2. Runtime's inbound JWT context (best effort).
    try:
        token = BedrockAgentCoreContext.get_workload_access_token()
    except Exception as e:  # pragma: no cover - defensive
        logger.warning(f"Failed to read inbound JWT context: {e}")
        token = None

    if token:
        logger.info("🔐 Resolved user token from runtime inbound JWT context")
        return token

    logger.info("ℹ️ No user token resolved — Gateway will apply NonAdmin by default")
    return None


def build_mcp_client_for_token(token: Optional[str]) -> MCPClient:
    """Create a per-request MCP client for the resolved user identity.

    When a user token is present, the client uses the Bearer transport that
    forwards the user's Cognito JWT unmodified to the Gateway, so the Gateway
    can derive the user's role from verified JWT claims (Req 7.2, 7.3).

    When no token resolves, the client falls back to the SigV4 transport (the
    runtime's own IAM principal) so the Gateway is still called rather than the
    request being blocked; the Gateway applies the NonAdmin role by default
    (Req 7.4). The SigV4 path is retained only as an incremental-migration
    fallback — the primary path for user requests forwards the user JWT.

    The returned client is NOT yet connected; the caller manages its lifecycle
    (per-request tool discovery and invocation are wired in later tasks).
    """
    if token:
        logger.info("🔧 Building per-request MCP client with Bearer (user JWT) transport")
        return MCPClient(lambda: streamablehttp_client_with_bearer(
            url=gateway_endpoint,
            token=token,
        ))

    logger.info("🔧 Building MCP client with SigV4 fallback transport (no user token)")
    return MCPClient(lambda: streamablehttp_client_with_sigv4(
        url=gateway_endpoint,
        credentials=frozen_credentials,
        service="bedrock-agentcore",
        region=AWS_REGION
    ))


# The user-facing tool set is discovered PER REQUEST keyed on the user's token
# (see invoke). We deliberately do NOT keep a shared global MCP client or a
# global tool list: a global list would ignore the requesting user's identity
# and could hand the agent tools the user is not allowed to discover.
agent = None  # Fallback agent (no tools), used only when per-request setup can't run
system_prompt_template = ""  # Static system prompt text, safe to build once


def list_tools_with_pagination(client: MCPClient) -> list:
    """List every tool from the Gateway through the given CONNECTED MCP client,
    following pagination.

    The client MUST already be connected (inside its context manager).

    NOTE (corrected during deployment): discovery is NOT Policy-governed, so the
    Gateway returns the full tool catalog regardless of the user's role. The
    forwarded user JWT determines authorization only at tool INVOCATION, where
    AgentCore Policy (Cedar) denies categories the role may not use (Req 4.3).
    A non-admin may therefore see a denied tool in this list but will be denied
    when calling it. Filtering the catalog by role at discovery (Req 2.2, 3.2,
    4.2) would require a future RESPONSE interceptor.
    """
    all_tools = []
    pagination_token = None
    while True:
        tools_page = client.list_tools_sync(pagination_token=pagination_token)
        all_tools.extend(tools_page)
        logger.info(f"  Retrieved {len(tools_page)} tools (total so far: {len(all_tools)})")
        # Check if there are more pages
        if hasattr(tools_page, 'pagination_token') and tools_page.pagination_token:
            pagination_token = tools_page.pagination_token
            logger.info("  More tools available, fetching next page...")
        else:
            break
    return all_tools


def initialize_agent_with_gateway():
    """Set up the static system prompt template and a fallback (no-tools) agent.

    Tool discovery now runs PER REQUEST keyed on the user's token (see
    ``invoke``), so this module-load setup deliberately does NOT connect to the
    Gateway or list tools globally — doing so would build a shared global tool
    list that ignores the requesting user. This function only:

    - builds the static, role-independent system prompt template, and
    - creates a fallback agent (without tools) used when the Gateway endpoint is
      not configured or per-request setup cannot run.
    """
    global agent, system_prompt_template

    try:
        if not gateway_endpoint:
            logger.error("Cannot initialize: Gateway endpoint not configured")
            agent = Agent(
                model=model,
                system_prompt="I'm sorry, but I'm not properly configured. Please contact support."
            )
            return
        
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
        
        # Fallback agent WITHOUT Gateway tools. The real, user-facing agent is
        # built PER REQUEST in invoke() with exactly the tools the user's
        # identity is permitted to discover. This base agent is only used when
        # per-request setup cannot run.
        agent = Agent(
            model=model,
            system_prompt=system_prompt_template
        )
        
        logger.info("✅ Base agent initialized — per-request tool discovery enabled")
            
    except Exception as e:
        logger.error(f"❌ Error initializing base agent: {e}", exc_info=True)
        # Create a fallback agent without tools
        agent = Agent(
            model=model,
            system_prompt="I'm sorry, but I'm having trouble accessing my tools right now. Please try again later."
        )


# Initialize agent with Gateway
logger.info("🚀 Initializing agent with Gateway-backed MCP tools using IAM SigV4 authentication")
initialize_agent_with_gateway()


@app.entrypoint
def invoke(payload, context=None):
    """
    Process user input and return CloudOps analysis

    The optional ``context`` parameter is the runtime-provided RequestContext.
    When the handler declares it, the AgentCore runtime injects per-request
    metadata. The user's Cognito token is resolved from the inbound request
    (a dedicated ``accessToken`` payload field or the runtime's inbound JWT
    context) and forwarded to the Gateway via a per-request Bearer MCP client.
    """
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

    # Resolve the user's Cognito token from the inbound request (never a role
    # field from the payload) and build a per-request MCP client that forwards
    # the token unmodified to the Gateway. If no token resolves, the helper
    # falls back to the SigV4 transport so the Gateway is still called and
    # applies the NonAdmin role by default (Req 7.2, 7.3, 7.4).
    user_token = resolve_user_token(payload, context)
    request_mcp_client = build_mcp_client_for_token(user_token)

    # Per-request path: open the user's MCP client connection, discover tools
    # through that connection (so the Gateway returns only the tools the user's
    # role may discover), build a per-request agent with exactly those tools,
    # and invoke it. The connection stays open for the full duration of tool
    # discovery AND the agent run, and is closed when the `with` block exits.
    #
    # When the Gateway's Cedar Policy denies a tool invocation it returns an
    # AuthorizeActionException. By the time it surfaces here it may arrive as an
    # mcp McpError, a strands tool/agent error wrapping it, or a plain
    # Exception, so we classify it by content (is_authorization_denial) rather
    # than by a single brittle exception type, and map it to a role-appropriate,
    # data-free response (build_denial_response) ahead of the generic handler
    # (Req 8.5).
    #
    # LIMITATION: the strands Agent loop orchestrates tool calls internally. If a
    # denial is swallowed mid-loop and never re-raised out of request_agent(...),
    # it cannot be caught here; this handler covers the case where the
    # authorization error propagates out of the per-request invocation. The
    # Gateway still denies the invocation and returns no tool data regardless, so
    # no denied-tool data can leak even in the swallowed case.
    try:
        with request_mcp_client:
            # Per-request tool discovery keyed on the user's token. We never
            # reuse a shared global tool list that ignores the user
            # (Req 2.2, 3.2, 4.2).
            logger.info("📋 Listing tools per request through the user's identity...")
            request_tools = list_tools_with_pagination(request_mcp_client)
            logger.info(f"✅ Retrieved {len(request_tools)} tools for this request (all pages)")

            # Configure the memory session manager when memory is enabled,
            # feeding it the per-request tools.
            session_manager = None
            if MEMORY_ID:
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

                    logger.info("✅ Memory session manager configured")

                except Exception as e:
                    logger.warning(f"⚠️ Could not configure memory, proceeding without memory: {e}")
                    session_manager = None
            else:
                logger.info("ℹ️ Memory not configured, using agent without memory")

            # Build the per-request agent with the per-request tools and the
            # static system prompt (plus the memory session manager when
            # configured). Memory, when present, is handled automatically by
            # the session manager.
            agent_kwargs = {
                "model": model,
                "tools": request_tools,
                "system_prompt": system_prompt_template,
            }
            if session_manager is not None:
                agent_kwargs["session_manager"] = session_manager
            request_agent = Agent(**agent_kwargs)

            logger.info("🤖 Invoking agent...")
            result = request_agent(user_message)

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

            return {
                "result": final_message,
                "sessionId": session_id,
                "userId": user_id
            }

    except Exception as e:
        # Specific authorization-denial handler (Req 8.5): a Policy deny surfaces
        # as an authorization error. Return a role-appropriate "capability not
        # available for your role" response that excludes ALL denied-tool data.
        # The raw exception text is only classified/inspected for the category;
        # it is never echoed into the user-facing response.
        if is_authorization_denial(e):
            logger.warning(
                "🚫 Tool invocation denied by Gateway authorization policy; "
                "returning role-appropriate unavailable response"
            )
            return build_denial_response(
                e,
                session_id=session_id,
                user_id=user_id,
            )

        # Generic fallback handler for all other failures.
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
