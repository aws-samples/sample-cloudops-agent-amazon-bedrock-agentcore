"""Regression unit tests for issue #18: Gateway policy-denial classification.

Feature: gateway-tool-access-control

Issue #18 reported that a live Non-Admin tool invocation, correctly denied by
the AgentCore Gateway's Cedar Policy, was misclassified by
``is_authorization_denial`` as a generic error. Two defects combined:

  1. The denial message emitted at tool-invocation time --
     "Tool Execution Denied: Tool call not allowed due to policy enforcement
     [No policy applies to the request (denied by default).]" -- matched none of
     the recognized authorization-denial markers.
  2. That ``McpError`` arrives wrapped in one or more ``ExceptionGroup``\\s (the
     strands/anyio ``TaskGroup`` machinery). ``str(ExceptionGroup)`` omits its
     members' messages, and ``_error_text`` did not walk ``.exceptions``, so the
     inner denial text was never inspected.

These deterministic tests pin the exact reported shape so the classifier keeps
recognizing it, and confirm the denial response stays data-free.

Validates: Requirements 8.5
"""

from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from authorization_model import (  # noqa: E402
    build_denial_response,
    is_authorization_denial,
)

# The exact (redacted) service message from the issue report.
_GATEWAY_POLICY_DENIAL_MESSAGE = (
    "Tool Execution Denied: Tool call not allowed due to policy enforcement "
    "[No policy applies to the request (denied by default).]"
)


class _FakeErrorData:
    """Stand-in for ``mcp.shared.exceptions.ErrorData`` (``.message`` / ``.code``)."""

    def __init__(self, message: str, code: int = -32000) -> None:
        self.message = message
        self.code = code


class _FakeMcpError(Exception):
    """Stand-in for ``mcp.shared.exceptions.McpError`` exposing nested error data."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.error = _FakeErrorData(message=message)


def _nested_taskgroup_denial() -> BaseException:
    """Reproduce the reported nested-ExceptionGroup wrapping of the denial.

    ``ExceptionGroup('unhandled errors in a TaskGroup', [
        ExceptionGroup('unhandled errors in a TaskGroup', [
            McpError('Tool Execution Denied: ... denied by default.')
        ])
    ])``
    """
    inner = _FakeMcpError(_GATEWAY_POLICY_DENIAL_MESSAGE)
    return ExceptionGroup(
        "unhandled errors in a TaskGroup",
        [ExceptionGroup("unhandled errors in a TaskGroup", [inner])],
    )


# ---------------------------------------------------------------------------
# is_authorization_denial recognizes the current Gateway policy-denial shape
# ---------------------------------------------------------------------------

def test_bare_policy_denial_message_is_recognized():
    """The raw policy-enforcement message string is classified as a denial."""
    assert is_authorization_denial(_GATEWAY_POLICY_DENIAL_MESSAGE) is True


def test_mcp_error_policy_denial_is_recognized():
    """An McpError-shaped exception carrying the denial message is a denial."""
    assert is_authorization_denial(_FakeMcpError(_GATEWAY_POLICY_DENIAL_MESSAGE)) is True


def test_nested_exception_group_denial_is_recognized():
    """The reported nested-ExceptionGroup wrapping is classified as a denial.

    This is the core regression: ``str(group)`` hides the inner McpError text,
    so the classifier must walk ``.exceptions`` to reach the denial signal.
    """
    assert is_authorization_denial(_nested_taskgroup_denial()) is True


def test_single_exception_group_denial_is_recognized():
    """A single-level ExceptionGroup wrapping the denial is also recognized."""
    group = ExceptionGroup(
        "unhandled errors in a TaskGroup",
        [_FakeMcpError(_GATEWAY_POLICY_DENIAL_MESSAGE)],
    )
    assert is_authorization_denial(group) is True


def test_chained_denial_via_cause_is_recognized():
    """A denial reached through the ``__cause__`` chain is recognized."""
    try:
        try:
            raise _FakeMcpError(_GATEWAY_POLICY_DENIAL_MESSAGE)
        except Exception as inner:
            raise RuntimeError("tool call failed") from inner
    except RuntimeError as wrapped:
        assert is_authorization_denial(wrapped) is True


# ---------------------------------------------------------------------------
# Non-denial errors still fall through (no false positives)
# ---------------------------------------------------------------------------

def test_unrelated_taskgroup_error_is_not_a_denial():
    """An ExceptionGroup wrapping a non-authorization failure is NOT a denial."""
    group = ExceptionGroup(
        "unhandled errors in a TaskGroup",
        [TimeoutError("connection to MCP target timed out")],
    )
    assert is_authorization_denial(group) is False


def test_plain_timeout_is_not_a_denial():
    """A plain transport/timeout failure is not classified as a denial."""
    assert is_authorization_denial(TimeoutError("read timed out")) is False


# ---------------------------------------------------------------------------
# The denial response stays role-appropriate and data-free for this shape
# ---------------------------------------------------------------------------

def test_denial_response_for_nested_group_states_unavailability_and_no_tool_data():
    """Building a response from the nested denial states role unavailability.

    The service message names no category, so the response falls back to the
    generic role-unavailable message. It must carry the ``denied`` flag and must
    NOT echo the raw policy-enforcement error text.
    """
    error = _nested_taskgroup_denial()

    response = build_denial_response(error, session_id="sess-1", user_id="user-1")

    assert response.get("denied") is True
    message = response["result"]
    assert re.search(r"not available for your role", message, re.IGNORECASE)
    # The raw denial internals must never be surfaced to the user.
    assert "policy enforcement" not in message.lower()
    assert "denied by default" not in message.lower()
    assert "tool execution denied" not in message.lower()
