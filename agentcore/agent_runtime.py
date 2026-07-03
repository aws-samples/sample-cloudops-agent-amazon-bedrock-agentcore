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
from streamable_http_sigv4 import streamablehttp_client_with_sigv4
from streamable_http_bearer import streamablehttp_client_with_bearer
from authorization_model import is_authorization_denial, build_denial_response
import base64
import binascii
import json
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

# Get AWS credentials for SigV4 signing. Hold the live, refreshable credentials
# object (botocore RefreshableCredentials under an assumed/container role) rather
# than freezing a snapshot at import time (BUG 5 fix, Req 2.5). The live object is
# passed into the SigV4 fallback transport so credential values are re-derived at
# sign time (SigV4Auth.get_frozen_credentials()), triggering a refresh near expiry
# instead of signing a long-lived container's requests with a stale snapshot.
session = boto3.Session()

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

# Sentinel that replaces any token-bearing value when a payload/body/header
# collection is routed through redaction. The Raw_Token must never reach any log
# output, in whole or in any substring (Req 7.1), so we substitute this marker
# rather than truncating (a prefix/suffix would still leak a substring).
REDACTED_PLACEHOLDER = "***REDACTED***"  # nosec B105 - mask marker, not a credential

# Names whose VALUES carry the Raw_Token and must be masked before any
# payload/body/header collection is logged (Req 7.6, 8.4):
#   - ``accessToken``  : the request-body field carrying the user's Cognito token
#                        on the FrontEnd -> Agent_Runtime hop (Req 8.1).
#   - ``Authorization``: the Bearer header carrying the token on the
#                        Agent_Runtime -> Gateway hop (Req 8.2). Matched
#                        case-insensitively because HTTP header casing is not
#                        stable across layers.
_SENSITIVE_EXACT_KEYS = frozenset({USER_TOKEN_PAYLOAD_FIELD})
_SENSITIVE_LOWER_KEYS = frozenset({"authorization"})

# Fail-closed AgentCore Memory actor used when NO verified Cognito ``sub`` can be
# resolved for a request (BUG 1 fix, Req 2.1, 3.2). When memory is enabled we
# still build an AgentCoreMemoryConfig for shape parity, but a token-less request
# MUST NOT be keyed to a trusted per-user actor derived from untrusted payload
# content (never the payload ``userId``). Instead every token-less request shares
# this single non-cross-user-identifying placeholder actor, consistent with the
# runtime's fail-closed NonAdmin posture: an anonymous request is the least-
# privileged identity, never a per-user one derived from client-supplied data.
TOKENLESS_MEMORY_ACTOR_ID = "unauthenticated"


def redact_sensitive(obj):
    """Return a copy of ``obj`` with token-bearing values masked (safe-log path).

    PRIMARY POSTURE: the runtime does not currently log raw payloads, request
    bodies, or headers at all — nothing token-bearing is written to a log on any
    hop (Req 7.1). Because there is no live log path that emits such data, this
    helper is NOT an active masking control routed on a real logging code path;
    no call site currently sends payloads/bodies/headers through it.

    This helper exists as the one correct, token-safe path to route through
    SHOULD any FUTURE diagnostic ever need to log such a collection. If that
    happens, its argument must be passed through ``redact_sensitive`` first
    rather than logged raw. When used, it masks:

      - the ``accessToken`` field value (the user's Cognito token forwarded in
        the request body on the FrontEnd -> Agent_Runtime hop, Req 8.1/8.4), and
      - the ``Authorization`` header value (the Bearer credential on the
        Agent_Runtime -> Gateway hop, Req 8.2),

    replacing each with ``REDACTED_PLACEHOLDER`` while leaving every
    non-sensitive field intact (Req 7.6). Nested dicts and lists/tuples are
    walked recursively so a token nested anywhere in the structure is still
    masked.

    The helper is defensive by contract and NEVER raises on unexpected shapes:
    any value that is not a dict/list/tuple is returned unchanged, a key whose
    name matches a sensitive field has its value masked regardless of the
    value's type, and any unexpected error during the walk collapses to the
    redaction marker.
    """
    try:
        if isinstance(obj, dict):
            redacted = {}
            for key, value in obj.items():
                is_sensitive = (
                    key in _SENSITIVE_EXACT_KEYS
                    or (isinstance(key, str) and key.lower() in _SENSITIVE_LOWER_KEYS)
                )
                redacted[key] = (
                    REDACTED_PLACEHOLDER if is_sensitive else redact_sensitive(value)
                )
            return redacted
        if isinstance(obj, list):
            return [redact_sensitive(item) for item in obj]
        if isinstance(obj, tuple):
            return tuple(redact_sensitive(item) for item in obj)
    except Exception:  # pragma: no cover - defensive: redaction must never raise
        return REDACTED_PLACEHOLDER
    return obj


def resolve_user_token(payload: dict, context=None) -> Optional[str]:
    """Resolve the user's Cognito JWT from the inbound request.

    The token is read ONLY from the authenticated inbound request — never any
    role value from the payload. Resolution order:

    1. A dedicated payload field (``accessToken``) carrying the user's Cognito
       token forwarded by the FrontEnd (the FrontEnd -> Agent_Runtime hop-1
       transport, Req 8.1).
    2. The runtime's own inbound JWT context (the ``WorkloadAccessToken`` the
       Gateway/runtime extracts from the inbound request headers), exposed via
       ``BedrockAgentCoreContext.get_workload_access_token()``.

    Returns the token string if one resolves, otherwise ``None``.

    Fail-closed posture (Req 5.1, 5.2, 5.5): when ``None`` is returned the
    caller STILL invokes the Gateway — it does not block the request. With no
    user token, ``build_mcp_client_for_token(None)`` selects the SigV4 fallback
    transport (the runtime's own IAM principal), the request reaches the Gateway
    with NO Verified_JWT, and the Gateway applies the NonAdmin role by default
    for both discovery and invocation. This is the intentional, explicit
    fail-closed default — a token-less request is treated as the least-
    privileged role, never escalated.

    This function deliberately does not read any ``role``/``Role`` field from
    the payload, and the runtime NEVER escalates a token-less request to Admin
    based on payload content (Req 5.5). Role must come only from the verified
    token claims at the Gateway. Any identity diagnostic references only the
    verified JWT ``sub`` claim, never the Raw_Token (Req 7.1, 7.4).
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


def resolve_verified_sub(user_token: Optional[str], context=None) -> Optional[str]:
    """Resolve the verified Cognito ``sub`` from the resolved user token.

    This is the server-side per-user identity used to key AgentCore Memory
    (BUG 1 fix, Req 2.1). It decodes the ALREADY-VERIFIED JWT payload from the
    resolved ``user_token`` — base64url-decoding the payload segment and reading
    the ``sub`` claim — mirroring the proven ``_decode_jwt_claims``/
    ``_resolve_role`` approach in
    ``cdk/lambda/discovery-filter-interceptor/handler.py``. It reuses the same
    server-derived identity that the DynamoDB conversation-history path already
    keys on (Req 3.1).

    It performs NO signature verification: the Gateway/runtime has already
    verified the token (issuer, client_id, signature) before it reaches the
    runtime, so here we only need to read the ``sub`` claim. It NEVER logs the
    token or any decode-error text (which could echo token material) — only the
    resolved ``sub`` may be logged (Req 7.1, 7.4).

    Returns the ``sub`` string when one can be decoded, otherwise ``None`` (no
    token, a malformed token, or an absent/empty/non-string ``sub`` claim). A
    ``None`` result drives the fail-closed memory-keying path in ``invoke``
    (Req 2.1, 3.2): the request is NEVER keyed to a trusted per-user actor
    derived from untrusted payload content.
    """
    if not isinstance(user_token, str) or not user_token:
        return None

    token = user_token.strip()
    if token.lower().startswith("bearer "):
        token = token[len("bearer "):].strip()

    parts = token.split(".")
    if len(parts) < 2:
        return None

    payload_segment = parts[1]
    # Restore base64url padding that JWT encoding strips.
    padding = "=" * (-len(payload_segment) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload_segment + padding)
        claims = json.loads(decoded)
    except (binascii.Error, ValueError, TypeError):
        # Malformed token payload. Do NOT log — the offending text could
        # contain token material (Req 7.1).
        return None

    if not isinstance(claims, dict):
        return None

    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        return None

    logger.info(f"🔑 Resolved verified sub for memory keying: {sub}")
    return sub


def build_mcp_client_for_token(token: Optional[str]) -> MCPClient:
    """Create a per-request MCP client for the resolved user identity.

    Hop-2 transport selection (Agent_Runtime -> AgentCore_Gateway):

    - When a user token is present, the client uses the Bearer transport
      (``streamable_http_bearer.py``) that forwards the user's Cognito JWT
      unmodified as an ``Authorization: Bearer <token>`` header, so the Gateway
      derives the user's role from verified JWT claims (Req 8.2). The token is
      conveyed in the ``Authorization`` header on this hop — never in a log
      (Req 7.1); any header collection that must be logged is routed through
      ``redact_sensitive`` first (Req 7.6).

    - When NO token resolves, the client falls back to the SigV4 transport
      (``streamable_http_sigv4.py``) signed with the runtime's own IAM
      principal. This is the explicit fail-closed path (Req 5.1): the Gateway is
      STILL called rather than the request being blocked, but the request
      reaches the Gateway with NO Verified_JWT (Req 5.2). The Gateway therefore
      applies the NonAdmin role by default for both discovery and invocation
      (Req 5.3), and the RESPONSE discovery-filter interceptor likewise resolves
      NonAdmin and filters the catalog to billing + pricing (Req 5.4). The
      runtime never escalates this token-less path to Admin (Req 5.5). The SigV4
      path is retained only as an incremental-migration fallback — the primary
      path for user requests forwards the user JWT.

    The returned client is NOT yet connected; the caller manages its lifecycle
    (per-request tool discovery and invocation are wired in the invoke handler).
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
        credentials=session.get_credentials(),
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

    NOTE: discovery IS role-filtered at the Gateway. A discovery-filter RESPONSE
    interceptor (``cdk/lambda/discovery-filter-interceptor/handler.py``) is
    deployed and wired into the Gateway — registered as the RESPONSE entry in
    ``InterceptorConfigurations`` (the ``DiscoveryFilterInterceptorFunction`` in
    ``cdk/lib/gateway-stack.ts``, with ``PassRequestHeaders: true``). It resolves
    the caller's role from the verified JWT ``role`` claim and removes the
    descriptors of categories that role may not discover before the Gateway
    replies, so the catalog this function receives is ALREADY role-filtered at
    the Gateway (Req 2.2, 3.2, 4.2); it fails closed to an empty catalog on any
    error, never the unfiltered list. Tool INVOCATION is independently authorized
    by AgentCore Policy (Cedar), which denies categories the role may not use
    (Req 4.3), so discovery filtering and invocation authorization are two
    distinct, layered controls.
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
    # the token unmodified to the Gateway via the hop-2 Authorization: Bearer
    # transport. If no token resolves, the helper falls back to the SigV4
    # transport (the runtime's own IAM principal): the Gateway is still called
    # but reaches it with no Verified_JWT, so it applies the NonAdmin role by
    # default. The runtime never escalates a token-less request to Admin based
    # on payload content — this is the explicit fail-closed posture
    # (Req 5.1, 5.2, 5.3, 5.5). The Raw_Token is never logged; any payload/body/
    # header collection that must be logged is routed through redact_sensitive
    # first (Req 7.1, 7.6).
    user_token = resolve_user_token(payload, context)
    request_mcp_client = build_mcp_client_for_token(user_token)

    # Derive the per-user memory identity server-side from the verified Cognito
    # ``sub`` claim of the resolved token — NEVER from the payload ``userId``
    # (BUG 1 fix, Req 2.1). This reuses the same server-derived identity the
    # DynamoDB conversation-history path already keys on (Req 3.1). When no
    # ``sub`` resolves (token-less request), this is ``None`` and memory keying
    # falls back to the fail-closed, non-cross-user-identifying actor below —
    # the untrusted payload ``userId`` is never used as identity (Req 3.2).
    verified_sub = resolve_verified_sub(user_token, context)

    # Per-request path: open the user's MCP client connection, discover tools
    # through that connection, build a per-request agent with exactly those
    # tools, and invoke it. The catalog returned by discovery is already
    # role-filtered at the Gateway by the deployed discovery-filter RESPONSE
    # interceptor (``cdk/lambda/discovery-filter-interceptor/handler.py``, wired
    # in as the RESPONSE entry of ``InterceptorConfigurations`` in
    # ``cdk/lib/gateway-stack.ts``), so the Gateway returns only the tools the
    # user's role may discover (Req 2.2, 3.2, 4.2). Tool INVOCATION is
    # independently authorized by AgentCore Cedar Policy. The connection stays
    # open for the full duration of tool discovery AND the agent run, and is
    # closed when the `with` block exits.
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
                    # Key AgentCore Memory to the verified Cognito ``sub``
                    # (BUG 1 fix, Req 2.1) so distinct users always get distinct
                    # memory actors and never share one. The payload ``userId``
                    # is NOT used as identity. When no ``sub`` resolves (token-
                    # less request) we fail closed to a single non-cross-user-
                    # identifying placeholder actor rather than the untrusted
                    # payload ``userId`` (Req 3.2). ``session_id`` keying is
                    # preserved for single-user session continuity (Req 3.3).
                    memory_actor_id = verified_sub if verified_sub else TOKENLESS_MEMORY_ACTOR_ID
                    logger.info(f"💾 Configuring memory - Memory ID: {MEMORY_ID}, Session: {session_id}")

                    memory_config = AgentCoreMemoryConfig(
                        memory_id=MEMORY_ID,
                        session_id=session_id,
                        actor_id=memory_actor_id
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
