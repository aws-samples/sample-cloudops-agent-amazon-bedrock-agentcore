"""
Discovery-filter RESPONSE interceptor for the AgentCore Gateway.

PURPOSE (Req 1.1, 1.2, 1.3, 1.4, 1.5)
-------------------------------------
Filter the ``tools/list`` Discovery_Response so each caller only sees the tool
descriptors their role is permitted to discover. The Gateway already authorizes
tool **invocation** (``tools/call``) by role through its AgentCore (Cedar) Policy
engine, but discovery is NOT Cedar-governed; without this interceptor every role
receives the full catalog. This RESPONSE interceptor closes that gap by removing
the descriptors of categories disallowed for the caller before the Gateway
replies, reusing the single authoritative ``authorization_model`` surface so the
discovery decision matches the invocation decision.

ROLE IN THE ARCHITECTURE -- DISCOVERY ONLY
------------------------------------------
This interceptor is distinct from, and independent of, the deny-audit REQUEST
interceptor. It transforms ``tools/list`` RESPONSE bodies and never audits or
enforces invocation. For every non-``tools/list`` method (``tools/call``,
``initialize``, ``ping``, ...) and for any response that carries no filterable
``result.tools`` list, it returns the original ``gatewayResponse`` unchanged, so
invocation results are never touched (Req 1.7).

FAIL CLOSED (Req 1.8, 4.5)
--------------------------
Classification and filtering are wrapped so that ANY error -- an unparseable
body, a role-resolution failure, a classification failure -- yields a response
whose ``result.tools`` is ``[]`` (echoing the request's JSON-RPC ``id``). The
unfiltered catalog is NEVER returned and the handler NEVER raises. A bug or a
malformed payload therefore degrades to "discover nothing", never to "discover
everything".

IDEMPOTENCE (Req 1.9)
---------------------
The filter keeps each retained descriptor unchanged and removes only disallowed
ones, so feeding a filtered catalog back through the handler removes nothing
further -- ``filter(filter(tools)) == filter(tools)``.

IDENTITY / TOKEN HANDLING (security -- Req 2.1, 2.3, 2.4, 2.5, 7.2, 7.5)
------------------------------------------------------------------------
The caller's role is derived solely from the verified JWT ``role`` claim, which
reaches the interceptor only via the inbound ``Authorization`` header (delivered
only when the interceptor is configured with ``passRequestHeaders: true``). The
Gateway has ALREADY verified the JWT (issuer, client_id, signature) before this
interceptor runs, so the handler only base64-decodes the JWT payload to read the
``role`` (and ``sub``) claim -- it performs no signature verification. A missing
header, an undecodable token, or an absent ``role`` claim resolves to
``Role.NonAdmin`` (default-deny / token-less SigV4 fallback posture, Req 2.5,
5.4). The handler NEVER logs the raw token, the ``Authorization`` header, or any
decode-error text; it may log only the ``sub`` identity reference and
non-sensitive counts.

INTERCEPTOR CONTRACT (MCP target RESPONSE interceptor)
------------------------------------------------------
Input  : event["mcp"]["gatewayRequest"]  = { headers?, body: { method, id, ... } }
         event["mcp"]["gatewayResponse"] = { statusCode, headers?,
                                              body: { jsonrpc, id, result: { tools: [...] } },
                                              isStreamingResponse? }
Output : { "interceptorOutputVersion": "1.0",
           "mcp": { "transformedGatewayResponse": { "statusCode": <int>, "body": <jsonrpc body> } } }

When the output carries ``transformedGatewayResponse`` the Gateway returns that
content to the caller immediately.

See: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-types.html

Feature: gateway-security-hardening
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
from typing import Any, Dict, List, Optional

from authorization_model import (
    Role,
    derive_role,
    retain_tool_for_role,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# The MCP discovery method whose response carries the tool catalog. Only this
# method's response is transformed; every other method passes through unchanged
# (Req 1.7).
TOOLS_LIST_METHOD: str = "tools/list"

# The verified scalar role claim injected by the Cognito Pre Token Generation
# Lambda (see auth-stack.ts / cdk/lambda/pre-token-generation).
ROLE_CLAIM_NAME: str = "role"


def _as_dict(value: Any) -> Dict[str, Any]:
    """Return ``value`` if it is a dict, otherwise an empty dict.

    Used to defensively descend the event structure so a missing or
    wrong-typed node never raises (Req 4.5).
    """
    return value if isinstance(value, dict) else {}


def _passthrough(gateway_response: Dict[str, Any]) -> Dict[str, Any]:
    """Return the RESPONSE-interceptor output that forwards the response unchanged.

    Used for non-``tools/list`` methods and for ``tools/list`` responses that
    carry nothing filterable. The original ``statusCode`` and ``body`` are
    echoed back verbatim via ``transformedGatewayResponse`` so the caller
    receives the unmodified response (Req 1.7).
    """
    return {
        "interceptorOutputVersion": "1.0",
        "mcp": {
            "transformedGatewayResponse": {
                "statusCode": gateway_response.get("statusCode"),
                "body": gateway_response.get("body"),
            }
        },
    }


def _transformed(status_code: Any, body: Dict[str, Any]) -> Dict[str, Any]:
    """Return the RESPONSE-interceptor output carrying a rebuilt JSON-RPC body."""
    return {
        "interceptorOutputVersion": "1.0",
        "mcp": {
            "transformedGatewayResponse": {
                "statusCode": status_code,
                "body": body,
            }
        },
    }


def _fail_closed(gateway_request: Dict[str, Any], status_code: Any) -> Dict[str, Any]:
    """Build the fail-closed response: an empty tool catalog, valid JSON-RPC.

    On ANY error the interceptor returns ``result.tools = []`` rather than the
    unfiltered catalog (Req 1.8, 4.5). The request's JSON-RPC ``id`` is echoed
    so the reply stays a well-formed JSON-RPC response.
    """
    request_body = _as_dict(gateway_request.get("body"))
    response_body: Dict[str, Any] = {
        "jsonrpc": "2.0",
        "id": request_body.get("id"),
        "result": {"tools": []},
    }
    return _transformed(status_code, response_body)


def _decode_jwt_claims(authorization_value: str) -> Dict[str, Any]:
    """Decode (without verifying) the JWT payload from an ``Authorization`` value.

    The Gateway has already verified the token before invoking this interceptor;
    here we only need the ``role`` and ``sub`` claims. Returns an empty dict on
    any malformed input. NEVER logs the token or any decode-error text (which
    could echo token material) (Req 7.2, 7.5).

    Args:
        authorization_value: The raw ``Authorization`` header value, optionally
            prefixed with ``"Bearer "``.

    Returns:
        The decoded JWT claims as a dict, or ``{}`` if the value cannot be
        decoded.
    """
    if not isinstance(authorization_value, str) or not authorization_value:
        return {}

    token = authorization_value.strip()
    if token.lower().startswith("bearer "):
        token = token[len("bearer "):].strip()

    parts = token.split(".")
    if len(parts) < 2:
        return {}

    payload_segment = parts[1]
    # Restore base64url padding that JWT encoding strips.
    padding = "=" * (-len(payload_segment) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload_segment + padding)
        claims = json.loads(decoded)
    except (binascii.Error, ValueError, TypeError):
        # Malformed token payload. Do not log -- the offending text could
        # contain token material.
        return {}

    return claims if isinstance(claims, dict) else {}


def _extract_authorization(gateway_request: Dict[str, Any]) -> Optional[str]:
    """Read the ``Authorization`` header value, tolerant of header casing.

    Returns ``None`` when headers are absent (e.g. ``passRequestHeaders`` is
    false) or no authorization header is present (Req 2.5).
    """
    headers = gateway_request.get("headers")
    if not isinstance(headers, dict):
        return None
    for key, value in headers.items():
        if isinstance(key, str) and key.lower() == "authorization":
            return value if isinstance(value, str) else None
    return None


def _resolve_role(gateway_request: Dict[str, Any]) -> tuple[Role, Optional[str]]:
    """Resolve the caller's Role and identity reference from the request.

    Decodes the verified JWT (best-effort) to read the ``role`` and ``sub``
    claims. A missing header, undecodable token, or absent ``role`` claim
    resolves to ``Role.NonAdmin`` (Req 2.5, 5.4). The raw token is never logged
    or returned -- only the ``sub`` identity reference is surfaced.

    Returns:
        A ``(role, sub)`` tuple, where ``sub`` may be ``None`` when no
        identity claim is present.
    """
    authorization = _extract_authorization(gateway_request)
    claims = _decode_jwt_claims(authorization) if authorization else {}
    role = derive_role(claims.get(ROLE_CLAIM_NAME))
    sub = claims.get("sub")
    return role, sub if isinstance(sub, str) and sub else None


def _filter_tools(role: Role, tools: List[Any]) -> List[Any]:
    """Filter the tool descriptors to those the role may discover, in order.

    Keeps each descriptor ``t`` iff ``retain_tool_for_role(role, t["name"])``:
    the builtin search tool is retained for every role, category-bearing names
    are classified by exact leading prefix, and unknown / unclassifiable names
    are default-denied. Input order is preserved (Req 4.3) and every retained
    descriptor is left byte-for-byte unchanged (Req 4.4). The filter is
    naturally idempotent (Req 1.9).
    """
    return [
        tool
        for tool in tools
        if retain_tool_for_role(
            role, tool.get("name") if isinstance(tool, dict) else None
        )
    ]


def _filter_tools_list_response(
    gateway_request: Dict[str, Any], gateway_response: Dict[str, Any]
) -> Dict[str, Any]:
    """Apply the discovery filter to a single ``tools/list`` response body.

    A structurally-malformed response body (not a dict) is treated as an error
    and surfaced to the caller's fail-closed handler (Req 1.8, 4.5). For a
    well-formed response dict whose ``result.tools`` is simply absent or not a
    list there is nothing to filter and the response is returned unchanged
    (Req 1.7). Otherwise the caller's role is resolved and the tool list is
    filtered, rebuilding the JSON-RPC body with the same ``jsonrpc``/``id`` and
    the filtered ``tools`` (Req 1.2, 1.3, 1.4, 1.5). Returns the full
    interceptor output dict.
    """
    raw_body = gateway_response.get("body")
    if not isinstance(raw_body, dict):
        # A tools/list response with a non-dict body is malformed -> let the
        # caller fail closed rather than echo the malformed body back.
        raise ValueError("malformed tools/list response body")

    response_body = raw_body
    result = response_body.get("result")
    tools = result.get("tools") if isinstance(result, dict) else None
    if not isinstance(tools, list):
        # Well-formed response with no tool array -> nothing to filter; pass
        # through unchanged (Req 1.7).
        return _passthrough(gateway_response)

    role, sub = _resolve_role(gateway_request)
    filtered = _filter_tools(role, tools)

    # Log only non-sensitive counts and the identity reference (never the token
    # or the Authorization header) (Req 7.2, 7.5).
    logger.info(
        "discovery-filter: %d->%d tools for role %s (sub=%s)",
        len(tools),
        len(filtered),
        role.value,
        sub if sub is not None else "unknown",
    )

    new_result = dict(result)
    new_result["tools"] = filtered
    new_body = dict(response_body)
    new_body["result"] = new_result
    return _transformed(gateway_response.get("statusCode"), new_body)


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Gateway RESPONSE interceptor entry point.

    Transforms ``tools/list`` discovery responses to the caller's allowed tool
    categories and passes every other response through unchanged. Fails closed
    on any error: returns ``result.tools = []`` rather than the unfiltered
    catalog, and never raises (Req 1.8, 4.5).

    The streaming guard (Req per design): if ``gatewayResponse.isStreamingResponse``
    is truthy, the same ``tools/list`` body filter is applied to the single
    event received; non-``tools/list`` streamed events pass through. Because the
    method discriminator and the filter operate on the event body either way,
    no special-casing beyond the shared path is required.
    """
    mcp_data = _as_dict(event.get("mcp") if isinstance(event, dict) else None)
    gateway_request = _as_dict(mcp_data.get("gatewayRequest"))
    gateway_response = _as_dict(mcp_data.get("gatewayResponse"))

    request_body = _as_dict(gateway_request.get("body"))
    if request_body.get("method") != TOOLS_LIST_METHOD:
        # Only discovery is filtered; every other method passes through (Req 1.7).
        return _passthrough(gateway_response)

    try:
        return _filter_tools_list_response(gateway_request, gateway_response)
    except Exception:  # noqa: BLE001 - fail closed on ANY error
        # Never surface the unfiltered catalog and never raise. Do not include
        # exception text (it could echo token material) (Req 1.8, 4.5, 7.5).
        logger.warning(
            "discovery-filter interceptor: filtering failed; failing closed "
            "(returning empty tool catalog)"
        )
        return _fail_closed(gateway_request, gateway_response.get("statusCode"))
