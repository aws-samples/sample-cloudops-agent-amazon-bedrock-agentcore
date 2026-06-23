"""Example-based unit tests for the Agent Runtime (Task 6.6).

Feature: gateway-tool-access-control

These are deterministic, example-based unit tests (pytest) for the Agent
Runtime's per-user identity-forwarding surface:

  - Token resolution path:        ``agent_runtime.resolve_user_token``
  - Missing-token path still calls Gateway:
                                  ``agent_runtime.build_mcp_client_for_token``
  - Authorization-error mapping:  ``authorization_model.is_authorization_denial``
                                  and ``authorization_model.build_denial_response``
                                  (the pure surface the runtime's ``invoke``
                                  handler delegates to)

Validates: Requirements 7.4, 8.5

Why two surfaces / the stubbing approach
----------------------------------------
Importing ``agent_runtime`` at module load triggers AWS-dependent side effects:
it constructs a ``BedrockModel``, opens a ``boto3`` session to freeze IAM
credentials, and runs ``initialize_agent_with_gateway()`` — and it imports
``bedrock_agentcore.memory.integrations.*`` / ``strands`` / ``strands.tools.mcp``,
submodules that are NOT importable in this environment (confirmed: ``import
agent_runtime`` raises ``ModuleNotFoundError`` for
``bedrock_agentcore.memory.integrations``). The module is therefore not directly
importable here.

This file uses **approach (a)** from the task: it injects lightweight fake
modules into ``sys.modules`` BEFORE importing ``agent_runtime`` and fakes
``boto3`` so module-load runs without AWS calls or network. The fakes are:

  - ``bedrock_agentcore.runtime`` → ``BedrockAgentCoreApp`` (no-op entrypoint
    decorator + ``run``) and ``BedrockAgentCoreContext`` (a
    ``get_workload_access_token`` we can steer per test);
  - ``bedrock_agentcore.memory.integrations.strands.{config,session_manager}``
    → placeholders (only referenced inside ``invoke`` when memory is enabled);
  - ``strands`` (``Agent``), ``strands.models`` (``BedrockModel``),
    ``strands.tools.mcp`` (``MCPClient`` that captures the transport factory);
  - ``streamable_http_bearer`` / ``streamable_http_sigv4`` → fakes whose
    transport functions return a tagged tuple so we can tell which transport a
    built MCP client would use WITHOUT opening a connection;
  - ``boto3`` → a fake ``Session`` yielding a deterministic region + credentials.

After ``agent_runtime`` is imported its functions have already bound the module
globals they need, so ``sys.modules`` is restored to its original state to avoid
leaking fakes into other test modules in the same pytest process.

``authorization_model`` is imported REAL (it has no AWS deps), so the
authorization-error mapping tests exercise the exact code the runtime calls.

Coverage map (what is covered directly vs. via the pure-helper surface):
  - Req 7.4 (token resolution + missing-token-still-calls-Gateway): covered
    DIRECTLY against ``agent_runtime.resolve_user_token`` /
    ``build_mcp_client_for_token`` imported under sys.modules stubs.
  - Req 8.5 (authorization-error mapping): covered DIRECTLY against the real
    ``authorization_model.is_authorization_denial`` / ``build_denial_response`` —
    the pure denial-mapping surface the runtime's ``invoke`` delegates to.
"""

from __future__ import annotations

import os
import sys
import types
from contextlib import contextmanager

import pytest

# Make the parent ``agentcore`` package importable when the test is run from an
# arbitrary working directory (the modules under test sit one level up).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Authorization-error mapping surface (real module — no AWS deps).
from authorization_model import (  # noqa: E402
    build_denial_response,
    is_authorization_denial,
)


# ===========================================================================
# sys.modules stubbing so ``agent_runtime`` can be imported without AWS / heavy
# deps. The transports return tagged tuples so a built MCP client's transport
# can be identified without connecting.
# ===========================================================================

# Tag values returned by the fake transports.
_BEARER_TAG = "bearer-transport"
_SIGV4_TAG = "sigv4-transport"

# Deterministic Gateway ARN -> endpoint used during import.
_TEST_GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gw-test-1234"


class _FakeMCPClient:
    """Stand-in for ``strands.tools.mcp.MCPClient``.

    The real client is constructed as ``MCPClient(transport_factory)`` where the
    factory is a zero-arg callable returning the transport context manager. We
    keep the factory so a test can invoke it and inspect which transport (and
    which token) the client would use — without opening any connection.
    """

    def __init__(self, transport_factory):
        self.transport_factory = transport_factory


def _fake_bearer_transport(*, url=None, token=None, **kwargs):
    """Fake ``streamablehttp_client_with_bearer`` — records url + forwarded token."""
    return (_BEARER_TAG, url, token)


def _fake_sigv4_transport(*, url=None, credentials=None, service=None, region=None, **kwargs):
    """Fake ``streamablehttp_client_with_sigv4`` — records url + service + region."""
    return (_SIGV4_TAG, url, service, region)


class _FakeWorkloadContext:
    """Fake ``BedrockAgentCoreContext`` with a steerable inbound-token getter.

    Tests set :attr:`workload_token` to control what the runtime's inbound JWT
    context returns. ``None`` models "no inbound token resolvable".
    """

    workload_token = None

    @classmethod
    def get_workload_access_token(cls):
        return cls.workload_token


def _make_module(name: str) -> types.ModuleType:
    return types.ModuleType(name)


@contextmanager
def _stubbed_sys_modules():
    """Temporarily install the fake modules, restoring originals on exit."""
    fakes: dict = {}

    # --- bedrock_agentcore.runtime ---
    bac = _make_module("bedrock_agentcore")
    bac.__path__ = []  # mark as package so submodule imports resolve
    bac_runtime = _make_module("bedrock_agentcore.runtime")

    class _FakeApp:
        def entrypoint(self, fn):  # used as @app.entrypoint
            return fn

        def run(self):  # pragma: no cover - never called in tests
            pass

    bac_runtime.BedrockAgentCoreApp = lambda *a, **k: _FakeApp()
    bac_runtime.BedrockAgentCoreContext = _FakeWorkloadContext

    # --- bedrock_agentcore.memory.integrations.strands.{config,session_manager} ---
    bac_memory = _make_module("bedrock_agentcore.memory")
    bac_memory.__path__ = []
    bac_mem_int = _make_module("bedrock_agentcore.memory.integrations")
    bac_mem_int.__path__ = []
    bac_mem_strands = _make_module("bedrock_agentcore.memory.integrations.strands")
    bac_mem_strands.__path__ = []
    bac_mem_cfg = _make_module("bedrock_agentcore.memory.integrations.strands.config")
    bac_mem_cfg.AgentCoreMemoryConfig = type("AgentCoreMemoryConfig", (), {})
    bac_mem_sm = _make_module("bedrock_agentcore.memory.integrations.strands.session_manager")
    bac_mem_sm.AgentCoreMemorySessionManager = type("AgentCoreMemorySessionManager", (), {})

    # --- strands / strands.models / strands.tools.mcp ---
    strands = _make_module("strands")
    strands.__path__ = []
    strands.Agent = lambda *a, **k: object()
    strands_models = _make_module("strands.models")
    strands_models.BedrockModel = lambda *a, **k: object()
    strands_tools = _make_module("strands.tools")
    strands_tools.__path__ = []
    strands_tools_mcp = _make_module("strands.tools.mcp")
    strands_tools_mcp.MCPClient = _FakeMCPClient

    # --- local transport modules ---
    sigv4_mod = _make_module("streamable_http_sigv4")
    sigv4_mod.streamablehttp_client_with_sigv4 = _fake_sigv4_transport
    bearer_mod = _make_module("streamable_http_bearer")
    bearer_mod.streamablehttp_client_with_bearer = _fake_bearer_transport

    # --- boto3 (avoid real AWS session/credentials) ---
    boto3_mod = _make_module("boto3")

    class _FakeCreds:
        access_key = "AKIAFAKE"
        secret_key = "fakesecret"  # nosec B105 - fake test credential, not a real secret
        token = "fakesessiontoken"  # nosec B105 - fake test credential, not a real secret

    class _FakeSession:
        region_name = "us-east-1"

        def get_credentials(self):
            return _FakeCreds()

    boto3_mod.Session = _FakeSession

    fakes = {
        "bedrock_agentcore": bac,
        "bedrock_agentcore.runtime": bac_runtime,
        "bedrock_agentcore.memory": bac_memory,
        "bedrock_agentcore.memory.integrations": bac_mem_int,
        "bedrock_agentcore.memory.integrations.strands": bac_mem_strands,
        "bedrock_agentcore.memory.integrations.strands.config": bac_mem_cfg,
        "bedrock_agentcore.memory.integrations.strands.session_manager": bac_mem_sm,
        "strands": strands,
        "strands.models": strands_models,
        "strands.tools": strands_tools,
        "strands.tools.mcp": strands_tools_mcp,
        "streamable_http_sigv4": sigv4_mod,
        "streamable_http_bearer": bearer_mod,
        "boto3": boto3_mod,
    }

    saved = {name: sys.modules.get(name) for name in fakes}
    saved_agent_runtime = sys.modules.pop("agent_runtime", None)
    saved_gateway_arn = os.environ.get("GATEWAY_ARN")
    saved_region = os.environ.get("AWS_REGION")
    try:
        sys.modules.update(fakes)
        os.environ["GATEWAY_ARN"] = _TEST_GATEWAY_ARN
        os.environ["AWS_REGION"] = "us-east-1"
        # Ensure memory stays disabled during the import-time setup.
        os.environ.pop("MEMORY_ID", None)
        yield
    finally:
        # Restore sys.modules so other test modules see the real packages.
        for name, original in saved.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original
        if saved_agent_runtime is not None:
            sys.modules["agent_runtime"] = saved_agent_runtime
        else:
            sys.modules.pop("agent_runtime", None)
        if saved_gateway_arn is None:
            os.environ.pop("GATEWAY_ARN", None)
        else:
            os.environ["GATEWAY_ARN"] = saved_gateway_arn
        if saved_region is None:
            os.environ.pop("AWS_REGION", None)
        else:
            os.environ["AWS_REGION"] = saved_region


def _import_agent_runtime():
    """Import ``agent_runtime`` under the sys.modules stubs and return it."""
    with _stubbed_sys_modules():
        import importlib

        # Force a fresh import so module-load side effects run under the stubs.
        sys.modules.pop("agent_runtime", None)
        agent_runtime = importlib.import_module("agent_runtime")
        return agent_runtime


# Import once for the whole module — module-load side effects are exercised here.
agent_runtime = _import_agent_runtime()


# ===========================================================================
# Token resolution path (Req 7.4)
# ===========================================================================

class TestResolveUserToken:
    def setup_method(self):
        # Default: no inbound JWT context token resolvable.
        _FakeWorkloadContext.workload_token = None

    def test_payload_access_token_is_returned(self):
        """A payload carrying ``accessToken`` resolves to that exact token."""
        token = "eyJhbGciOiJIUzI1NiJ9.payload.sig"  # nosec B105 - fake test fixture token
        assert agent_runtime.resolve_user_token({"accessToken": token}) == token

    def test_missing_token_returns_none(self):
        """No payload token and no inbound context token resolves to ``None``.

        ``None`` is the signal that lets the caller still invoke the Gateway,
        which then applies the NonAdmin role by default (Req 7.4).
        """
        _FakeWorkloadContext.workload_token = None
        assert agent_runtime.resolve_user_token({}) is None

    def test_falls_back_to_inbound_jwt_context(self):
        """With no payload field, the runtime's inbound JWT context is used."""
        _FakeWorkloadContext.workload_token = "context-jwt-token"  # nosec B105 - fake test fixture token
        assert agent_runtime.resolve_user_token({}) == "context-jwt-token"

    def test_payload_field_takes_precedence_over_context(self):
        """The dedicated payload field wins over the inbound context token."""
        _FakeWorkloadContext.workload_token = "context-jwt-token"  # nosec B105 - fake test fixture token
        assert (
            agent_runtime.resolve_user_token({"accessToken": "payload-token"})
            == "payload-token"
        )

    def test_role_field_in_payload_is_never_read(self):
        """A ``role`` injected into the payload must not influence resolution.

        The role must come only from verified JWT claims at the Gateway
        (Req 1.5 / 7.4). With an injected ``role`` but no token present,
        resolution still yields ``None`` (it never substitutes the role for a
        token), and the resolved token is exactly the supplied ``accessToken``
        when present — never the role value.
        """
        # Adversarial role, no token of any kind -> still None.
        _FakeWorkloadContext.workload_token = None
        assert agent_runtime.resolve_user_token({"role": "admin"}) is None

        # Adversarial role alongside a real token -> the token is returned,
        # and the role value is not what comes back.
        resolved = agent_runtime.resolve_user_token(
            {"role": "admin", "accessToken": "real-user-token"}
        )
        assert resolved == "real-user-token"
        assert resolved != "admin"

    def test_non_dict_payload_resolves_via_context_or_none(self):
        """A non-dict payload does not raise; it falls through to the context."""
        _FakeWorkloadContext.workload_token = None
        assert agent_runtime.resolve_user_token(None) is None
        _FakeWorkloadContext.workload_token = "ctx"  # nosec B105 - fake test fixture token
        assert agent_runtime.resolve_user_token(None) == "ctx"


# ===========================================================================
# build_mcp_client_for_token: bearer path vs. missing-token SigV4 fallback
# (Req 7.4 — missing token still calls Gateway)
# ===========================================================================

class TestBuildMcpClientForToken:
    def test_returns_an_mcp_client(self):
        """The helper returns an ``MCPClient`` for both token and no-token."""
        with_token = agent_runtime.build_mcp_client_for_token("tok")
        without_token = agent_runtime.build_mcp_client_for_token(None)
        assert isinstance(with_token, agent_runtime.MCPClient)
        assert isinstance(without_token, agent_runtime.MCPClient)

    def test_token_present_uses_bearer_transport_and_forwards_token(self):
        """With a token, the client uses the Bearer transport with that token."""
        client = agent_runtime.build_mcp_client_for_token("user-jwt-123")  # nosec B105 - fake test fixture token
        transport = client.transport_factory()
        tag, url, forwarded_token = transport
        assert tag == _BEARER_TAG
        assert forwarded_token == "user-jwt-123"
        assert url == agent_runtime.gateway_endpoint

    def test_missing_token_falls_back_to_sigv4_so_gateway_is_still_called(self):
        """With no token, the client uses the SigV4 fallback transport.

        The SigV4 fallback means the Gateway is STILL called (the runtime's own
        IAM principal), rather than the request being blocked; the Gateway then
        applies the NonAdmin role by default (Req 7.4).
        """
        client = agent_runtime.build_mcp_client_for_token(None)
        transport = client.transport_factory()
        tag, url, service, region = transport
        assert tag == _SIGV4_TAG
        assert service == "bedrock-agentcore"
        assert url == agent_runtime.gateway_endpoint

    def test_bearer_and_sigv4_paths_are_distinct(self):
        """The token path and the missing-token path select different transports."""
        bearer = agent_runtime.build_mcp_client_for_token("t").transport_factory()
        sigv4 = agent_runtime.build_mcp_client_for_token(None).transport_factory()
        assert bearer[0] == _BEARER_TAG
        assert sigv4[0] == _SIGV4_TAG
        assert bearer[0] != sigv4[0]


# ===========================================================================
# Authorization-error mapping (Req 8.5)
#
# Tested directly against the real ``authorization_model`` — the pure
# denial-mapping surface the runtime's ``invoke`` handler delegates to when an
# exception propagates out of the per-request invocation.
# ===========================================================================

class _AuthorizeActionException(Exception):
    """Stands in for the Gateway/Policy ``AuthorizeActionException`` type.

    Classification is by name/content, so the class name carries the signal.
    """


class TestAuthorizationErrorMapping:
    def test_authorize_action_exception_is_classified_as_denial(self):
        """An ``AuthorizeActionException``-like error maps to a denial."""
        err = _AuthorizeActionException(
            "AuthorizeActionException: principal not permitted for cloudwatchMcp___get_metric_data"
        )
        assert is_authorization_denial(err) is True

    def test_access_denied_string_is_classified_as_denial(self):
        """An access-denied message is recognized as an authorization denial."""
        assert is_authorization_denial("AccessDeniedException: not authorized") is True

    def test_timeout_error_is_not_a_denial(self):
        """A target-unavailable/timeout error is NOT classified as a denial."""
        assert is_authorization_denial(TimeoutError("Read timed out after 30s")) is False

    def test_value_error_is_not_a_denial(self):
        """An unrelated ``ValueError`` is NOT classified as a denial."""
        assert is_authorization_denial(ValueError("invalid input shape")) is False

    def test_denial_response_states_unavailability_with_no_tool_data(self):
        """The denial response names the category, flags denied, and leaks no data.

        The raw error carries tool input args and output/result data; none of it
        may appear in the user-facing response (Req 8.5).
        """
        err = _AuthorizeActionException(
            "AuthorizeActionException denied cloudwatchMcp___get_metric_data "
            "input={'secret_arg': 'SENSITIVE_VALUE_XYZ'} "
            "output={'datapoints': [1234, 5678]}"
        )
        # Precondition: the runtime would route this through the denial mapper.
        assert is_authorization_denial(err) is True

        response = build_denial_response(err, session_id="s-1", user_id="u-1")

        # States unavailability for the user's role and identifies the category.
        assert response["denied"] is True
        assert response["deniedCategory"] == "cloudwatch"
        assert "not available for your role" in response["result"]
        assert "cloudwatch" in response["result"]
        assert response["sessionId"] == "s-1"
        assert response["userId"] == "u-1"

        # Excludes ALL denied-tool data: args, values, output payload.
        flat = " ".join(str(v) for v in response.values())
        assert "SENSITIVE_VALUE_XYZ" not in flat
        assert "secret_arg" not in flat
        assert "1234" not in flat
        assert "5678" not in flat
        assert "datapoints" not in flat
        # The raw exception text must never be echoed back.
        assert "AuthorizeActionException" not in flat

    def test_denial_response_without_recoverable_category_is_generic(self):
        """When no category can be recovered, the message is generic and data-free."""
        err = _AuthorizeActionException("not authorized: opaque policy decision")
        assert is_authorization_denial(err) is True

        response = build_denial_response(err)
        assert response["denied"] is True
        assert "deniedCategory" not in response
        assert "not available for your role" in response["result"]
        assert "opaque policy decision" not in response["result"]
