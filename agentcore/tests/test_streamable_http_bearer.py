"""Example-based unit tests for the Bearer-token transport (Task 5.2).

Feature: gateway-tool-access-control

These are deterministic, example-based unit tests (pytest) for
``streamablehttp_client_with_bearer`` in ``agentcore/streamable_http_bearer.py``.

The transport is an async context manager that wraps
``mcp.client.streamable_http.streamablehttp_client``, attaching the user's JWT
as an ``Authorization: Bearer <token>`` header and forwarding the token
unmodified. The tests patch the wrapped ``streamablehttp_client`` to capture the
keyword arguments it is called with, then assert the ``Authorization`` header
value equals exactly ``f"Bearer {token}"`` and that the token is forwarded
byte-for-byte.

``pytest-asyncio`` is intentionally not required; the async context manager is
driven with ``asyncio.run`` around an inner coroutine to avoid adding a new
dependency.

Validates: Requirements 7.3
"""

from __future__ import annotations

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from unittest.mock import patch

import pytest

# Make the parent ``agentcore`` package importable when the test is run from an
# arbitrary working directory (the module under test sits one level up).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import streamable_http_bearer  # noqa: E402
from streamable_http_bearer import streamablehttp_client_with_bearer  # noqa: E402


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------

# Sentinel object the fake transport yields; lets us confirm the wrapped
# client session is passed straight through.
_SENTINEL_CLIENT = object()


def _make_fake_transport(captured: dict):
    """Return a fake ``streamablehttp_client`` that records its call.

    The returned callable mimics the real ``streamablehttp_client``: it is
    called with ``(url, headers=..., timeout=...)`` and returns an async
    context manager. The positional/keyword arguments are stored in
    ``captured`` so the test can assert on them.
    """

    def _fake_streamablehttp_client(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs

        @asynccontextmanager
        async def _cm():
            yield _SENTINEL_CLIENT

        return _cm()

    return _fake_streamablehttp_client


def _run_client(url: str, token: str, timeout: float = 30.0):
    """Drive the async context manager once and return (captured, yielded).

    ``captured`` holds the args/kwargs the patched ``streamablehttp_client``
    was called with; ``yielded`` is whatever the context manager produced.
    """
    captured: dict = {}

    async def _inner():
        with patch.object(
            streamable_http_bearer,
            "streamablehttp_client",
            _make_fake_transport(captured),
        ):
            async with streamablehttp_client_with_bearer(
                url, token, timeout=timeout
            ) as client:
                return client

    yielded = asyncio.run(_inner())
    return captured, yielded


# ---------------------------------------------------------------------------
# Authorization header carries the exact Bearer token (Req 7.3)
# ---------------------------------------------------------------------------

def test_authorization_header_is_bearer_token():
    """The ``Authorization`` header equals exactly ``f"Bearer {token}"``."""
    token = "eyJhbGciOiJ.payload.signature"  # nosec B105 - fake test fixture token, not a real credential
    captured, _ = _run_client("https://gw.example/mcp", token)

    headers = captured["kwargs"]["headers"]
    assert headers["Authorization"] == f"Bearer {token}"


def test_token_forwarded_byte_for_byte_unmodified():
    """The token after the ``Bearer `` prefix is the exact token, unmodified."""
    # A token containing characters that a careless implementation might trim
    # or normalize (leading/trailing whitespace, dots, dashes, underscores).
    token = "  Ab1._-token-with.edges  "  # nosec B105 - fake test fixture token, not a real credential
    captured, _ = _run_client("https://gw.example/mcp", token)

    header_value = captured["kwargs"]["headers"]["Authorization"]
    assert header_value == "Bearer " + token
    # The substring following the single "Bearer " prefix is the token verbatim.
    assert header_value[len("Bearer "):] == token


@pytest.mark.parametrize(
    "token",
    [
        "simple-token",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiJ9.sig",  # nosemgrep: generic.secrets.security.detected-jwt-token - fake test fixture JWT
        "token.with.many.dots",
        "UPPER_lower-1234567890",
        "x",  # single character
    ],
)
def test_authorization_header_for_various_tokens(token):
    """For a range of token shapes, the header is exactly ``Bearer <token>``."""
    captured, _ = _run_client("https://gw.example/mcp", token)

    assert captured["kwargs"]["headers"]["Authorization"] == f"Bearer {token}"


def test_only_authorization_header_is_added():
    """The transport contributes exactly the single ``Authorization`` header."""
    token = "abc123"  # nosec B105 - fake test fixture token, not a real credential
    captured, _ = _run_client("https://gw.example/mcp", token)

    headers = captured["kwargs"]["headers"]
    assert headers == {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# URL and timeout are forwarded; wrapped client session passes through
# ---------------------------------------------------------------------------

def test_url_and_timeout_are_forwarded():
    """The endpoint URL and timeout are passed through to the wrapped client."""
    captured, _ = _run_client("https://gw.example/mcp", "tok", timeout=12.5)

    assert captured["args"][0] == "https://gw.example/mcp"
    assert captured["kwargs"]["timeout"] == 12.5


def test_yields_wrapped_client_session():
    """The context manager yields the session from the wrapped transport."""
    _, yielded = _run_client("https://gw.example/mcp", "tok")

    assert yielded is _SENTINEL_CLIENT
