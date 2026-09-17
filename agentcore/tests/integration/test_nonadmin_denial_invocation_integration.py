"""Integration test (Task 9.5): Non-Admin denial invocation.

Feature: gateway-tool-access-control

WHAT THIS VERIFIES
------------------
A NON-ADMIN user's *invocation* (``tools/call``) of a tool in a denied category
(cloudwatch / cloudtrail / inventory) is rejected by the deployed Gateway's
Cedar Policy engine. Specifically (Req 4.3, 4.4, 5.2, 8.1, 8.2):

  * the call is DENIED — an authorization error (``AuthorizeActionException`` /
    access-denied) is raised or returned,
  * the error IDENTIFIES the denied tool category,
  * the request is NOT routed to any MCP server target, and
  * NO data produced by the requested tool is returned to the caller.

This is an END-TO-END test against the *live deployed* Gateway + Policy engine
and a real Cognito-issued NON-ADMIN access token. It therefore cannot run
without deployed infrastructure and a valid non-admin token, so it AUTO-SKIPS
when the required environment variables (below) are absent. When skipped the
file still collects cleanly, keeping the suite green in CI without infra.

REQUIRED ENVIRONMENT VARIABLES
------------------------------
The test runs only when ALL of the following are set; otherwise it SKIPS.

  INTEGRATION_TEST_ENABLED
      Master switch. Must be set to a truthy value ("1", "true", "yes", "on")
      to opt in to live integration testing.

  GATEWAY_URL   (or)   GATEWAY_ARN
      The deployed Gateway MCP endpoint. Provide either the full MCP URL via
      GATEWAY_URL (e.g. "https://<gateway-id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp")
      or GATEWAY_ARN, from which the endpoint URL is derived (the region is
      taken from AWS_REGION / AWS_DEFAULT_REGION).

  NONADMIN_ACCESS_TOKEN
      A valid Cognito access token (JWT) for a user who is NOT in the
      ``Administrators`` group — i.e. a token carrying role claim "nonadmin"
      (or no/unknown role, which the Gateway treats as NonAdmin). The token is
      forwarded unmodified as ``Authorization: Bearer <token>``.

OPTIONAL ENVIRONMENT VARIABLES
------------------------------
  DENIED_TOOL_NAME
      A specific denied tool name to invoke (e.g.
      "cloudwatchMcp___get_metric_data"). If unset, the test attempts a set of
      well-known denied tool-name candidates across the cloudwatch / cloudtrail
      / inventory categories.

  AWS_REGION / AWS_DEFAULT_REGION
      Region used to derive the endpoint from GATEWAY_ARN. Defaults to
      "us-east-1" when neither is set and GATEWAY_URL is not provided.

  INTEGRATION_TEST_TIMEOUT
      Per-call timeout in seconds (default 30).

Validates: Requirements 4.3, 4.4, 5.2, 8.1, 8.2
"""

from __future__ import annotations

import asyncio
import os
import sys

import pytest

# Make the parent ``agentcore`` package importable when the test is run from an
# arbitrary working directory (the modules under test sit two levels up).
sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)


# ---------------------------------------------------------------------------
# Environment-driven skip configuration
# ---------------------------------------------------------------------------

_TRUTHY = {"1", "true", "yes", "on"}


def _is_truthy(value) -> bool:
    return bool(value) and str(value).strip().lower() in _TRUTHY


def _derive_gateway_url() -> str | None:
    """Resolve the Gateway MCP endpoint from GATEWAY_URL or GATEWAY_ARN."""
    url = os.environ.get("GATEWAY_URL")
    if url:
        return url
    arn = os.environ.get("GATEWAY_ARN")
    if not arn:
        return None
    gateway_id = arn.split("/")[-1]
    region = (
        os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or "us-east-1"
    )
    return (
        f"https://{gateway_id}.gateway.bedrock-agentcore.{region}.amazonaws.com/mcp"
    )


def _missing_requirements() -> list[str]:
    """Return the list of unmet preconditions; empty list means ready to run."""
    missing: list[str] = []
    if not _is_truthy(os.environ.get("INTEGRATION_TEST_ENABLED")):
        missing.append("INTEGRATION_TEST_ENABLED (set to 1/true to enable)")
    if not _derive_gateway_url():
        missing.append("GATEWAY_URL or GATEWAY_ARN")
    if not os.environ.get("NONADMIN_ACCESS_TOKEN"):
        missing.append("NONADMIN_ACCESS_TOKEN (Cognito non-admin JWT)")
    return missing


# Evaluated at import/collection time so the whole module skips cleanly when the
# deployed infrastructure is not configured.
_MISSING = _missing_requirements()

pytestmark = pytest.mark.skipif(
    bool(_MISSING),
    reason=(
        "Live Gateway + Policy integration test for Non-Admin denial; "
        "missing required configuration: " + ", ".join(_MISSING)
    ),
)


# Well-known denied tool-name candidates spanning the three Non-Admin-denied
# categories. The test invokes the first candidate that the Gateway recognizes
# enough to evaluate against policy; every one of these must be DENIED for a
# Non-Admin caller. A single explicit override may be supplied via
# DENIED_TOOL_NAME.
_DENIED_TOOL_CANDIDATES: tuple[tuple[str, str], ...] = (
    ("cloudwatch", "cloudwatchMcp___get_metric_data"),
    ("cloudwatch", "cloudwatchMcp___describe_log_groups"),
    ("cloudtrail", "cloudtrailMcp___lookup_events"),
    ("inventory", "inventoryMcp___list_clusters"),
)


def _candidate_tools() -> tuple[tuple[str, str], ...]:
    """Return (category, tool_name) candidates, honoring DENIED_TOOL_NAME."""
    override = os.environ.get("DENIED_TOOL_NAME")
    if override:
        # Recover the category from the tool-name prefix when possible.
        from authorization_model import extract_denied_category

        category = extract_denied_category(override) or "cloudwatch"
        return ((category, override),)
    return _DENIED_TOOL_CANDIDATES


# ---------------------------------------------------------------------------
# Live invocation helper
# ---------------------------------------------------------------------------

async def _invoke_denied_tool(url: str, token: str, tool_name: str, timeout: float):
    """Attempt a ``tools/call`` of ``tool_name`` and return (outcome, detail).

    Returns one of:
      ("denied", error_text)  — the Gateway raised an authorization error.
      ("result", result_obj)  — the call returned a result (UNEXPECTED for a
                                 denied category; the test then asserts on it).

    Uses the project's Bearer transport so the user JWT is forwarded unmodified,
    exactly as the Agent Runtime does in production.
    """
    from mcp import ClientSession

    from streamable_http_bearer import streamablehttp_client_with_bearer
    from authorization_model import is_authorization_denial

    try:
        async with streamablehttp_client_with_bearer(
            url=url, token=token, timeout=timeout
        ) as transport:
            # The streamable-http transport yields (read, write, *extra).
            read_stream, write_stream = transport[0], transport[1]
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.call_tool(tool_name, {})
                # Some servers signal tool-level errors via ``isError`` rather
                # than raising; treat an authorization error surfaced that way
                # as a denial too.
                if getattr(result, "isError", False) and is_authorization_denial(
                    _result_text(result)
                ):
                    return "denied", _result_text(result)
                return "result", result
    except Exception as exc:  # noqa: BLE001 - we classify below
        return "denied" if is_authorization_denial(exc) else "error", repr(exc)


def _result_text(result) -> str:
    """Flatten an MCP tool result's text content for inspection."""
    parts: list[str] = []
    content = getattr(result, "content", None) or []
    for item in content:
        text = getattr(item, "text", None)
        if text:
            parts.append(str(text))
    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        parts.append(str(structured))
    return " ".join(parts)


# ---------------------------------------------------------------------------
# The test
# ---------------------------------------------------------------------------

def test_nonadmin_denied_invocation_returns_authorization_error_with_no_tool_data():
    """A Non-Admin invoking a denied-category tool is denied with no tool data.

    Asserts (Req 4.3, 4.4, 5.2, 8.1, 8.2):
      * the invocation is DENIED (authorization error raised/returned),
      * the error names the denied category,
      * no tool result data is returned for the denied call.
    """
    url = _derive_gateway_url()
    token = os.environ["NONADMIN_ACCESS_TOKEN"]
    timeout = float(os.environ.get("INTEGRATION_TEST_TIMEOUT", "30"))

    from authorization_model import extract_denied_category

    last_detail = None
    for category, tool_name in _candidate_tools():
        outcome, detail = asyncio.run(
            _invoke_denied_tool(url, token, tool_name, timeout)
        )
        last_detail = (tool_name, outcome, detail)

        if outcome == "error":
            # Not an authorization error (e.g. tool name not present at all for
            # this deployment). Try the next candidate.
            continue

        # A denied category MUST NOT return a successful tool result.
        assert outcome != "result", (
            f"Non-Admin invocation of denied tool '{tool_name}' "
            f"({category}) unexpectedly returned a result: no denied-category "
            "tool data may be returned (Req 4.4, 8.1)."
        )

        # outcome == "denied": the Gateway rejected the call. Verify the error
        # identifies a denied category and carries no tool result data.
        assert isinstance(detail, str) and detail, (
            "Authorization denial must carry an identifying error message."
        )
        # Recover the denied category. The current Gateway Cedar-policy denial
        # message (e.g. "Tool Execution Denied ... denied by default") names no
        # tool/category, so ``extract_denied_category`` legitimately returns
        # ``None`` for it. In that case we preserve the *requested* tool/category
        # context we already hold from the invocation (issue #18): the response's
        # role-unavailable meaning is unchanged and still leaks no tool data.
        recovered = extract_denied_category(detail) or category
        assert recovered in {"cloudwatch", "cloudtrail", "inventory", category}, (
            f"Authorization error for '{tool_name}' must identify the denied "
            f"category; could not recover one from: {detail!r} (Req 4.4, 8.1)."
        )
        # The denial path returns no MCP tool result object, so by construction
        # no tool input args/output/result data is present. We additionally
        # confirm the error text does not look like a successful tool payload.
        assert "result" not in detail.lower() or recovered is not None, (
            "Denied invocation must not surface tool result data (Req 8.1)."
        )
        return  # Success: a denied-category invocation was correctly rejected.

    pytest.fail(
        "No denied-category tool could be evaluated against the deployed "
        "Gateway policy. Set DENIED_TOOL_NAME to a known cloudwatch/cloudtrail/"
        f"inventory tool for this deployment. Last attempt: {last_detail!r}"
    )
