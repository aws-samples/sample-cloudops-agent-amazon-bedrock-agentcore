# Feature: agentcore-security-review-fixes, BUG 1, Property 1: Bug Condition
# Memory keyed to verified per-user identity
# **Validates: Requirements 1.1, 2.1**
"""
BUG 1 — Bug-condition EXPLORATION property test (memory actor isolation).

This test is written BEFORE the fix and is EXPECTED TO FAIL on the current
(unfixed) code. Its failure confirms the bug described in
``bugfix.md`` (1.1 / 2.1) and ``design.md`` (BUG 1 ``isBugCondition`` /
``expectedBehavior``):

    The runtime builds ``AgentCoreMemoryConfig(actor_id=user_id)`` where
    ``user_id = payload.get("userId", "default_user")`` and the frontend
    hardcodes ``userId: 'amplify_user'``. Every user therefore shares
    ``actor_id="amplify_user"`` regardless of their verified Cognito ``sub``.

The test exercises the runtime's memory-config construction path (the ``invoke``
handler's ``MEMORY_ID`` branch) and asserts the EXPECTED (post-fix) behavior:

    * two distinct verified ``sub`` values must produce DISTINCT ``actor_id``s,
    * each ``actor_id`` must equal the request's verified Cognito ``sub``
      (decoded server-side from the forwarded ``accessToken``), NOT the payload
      ``userId``.

Scoped property: random pairs of DISTINCT verified ``sub`` values are embedded
in the forwarded ``accessToken`` while the payload ``userId`` is held constant
at ``"amplify_user"`` and memory is enabled (``MEMORY_ID`` set).

An additional edge case covers the token-less / memory-enabled path and asserts
memory is NOT keyed to a trusted per-user actor derived from the untrusted
payload ``userId`` (documents the fail-closed expectation from design 3.2).

EXPECTED OUTCOME ON UNFIXED CODE: FAIL — both distinct users resolve to
``actor_id="amplify_user"``.

Import approach mirrors ``test_agent_runtime.py``: lightweight fakes are
installed in ``sys.modules`` BEFORE importing ``agent_runtime`` (whose module
load has AWS-dependent side effects and imports submodules that are not
importable in this environment). Here memory is ENABLED (``MEMORY_ID`` set) and
the fakes make the ``invoke`` memory-config construction path runnable so the
constructed ``AgentCoreMemoryConfig.actor_id`` can be captured and inspected
WITHOUT any AWS calls or network.
"""

from __future__ import annotations

import base64
import importlib
import json
import os
import sys
import types
from contextlib import contextmanager

from hypothesis import assume, given, settings
from hypothesis import strategies as st

# Make the parent ``agentcore`` package importable regardless of CWD.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ===========================================================================
# Capture sink + steerable inbound-token context
# ===========================================================================

# Every ``AgentCoreMemoryConfig(...)`` the runtime builds is recorded here so a
# test can inspect the ``actor_id`` the runtime chose to key memory with.
_CAPTURED_CONFIGS: list = []

_TEST_GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gw-test-1234"
_TEST_MEMORY_ID = "mem-test-abcdef"
_PAYLOAD_USER_ID = "amplify_user"  # the hardcoded frontend identity (untrusted)


class _FakeWorkloadContext:
    """Fake ``BedrockAgentCoreContext`` with a steerable inbound-token getter."""

    workload_token = None

    @classmethod
    def get_workload_access_token(cls):
        return cls.workload_token


class _FakeMemoryConfig:
    """Fake ``AgentCoreMemoryConfig`` that records the ``actor_id`` chosen.

    The runtime constructs it as
    ``AgentCoreMemoryConfig(memory_id=..., session_id=..., actor_id=...)``.
    We record every instance so the test can read back the keying decision.
    """

    def __init__(self, **kwargs):
        self.memory_id = kwargs.get("memory_id")
        self.session_id = kwargs.get("session_id")
        self.actor_id = kwargs.get("actor_id")
        _CAPTURED_CONFIGS.append(self)


class _FakeSessionManager:
    """Fake ``AgentCoreMemorySessionManager`` — accepts the config, no-op."""

    def __init__(self, **kwargs):
        self.config = kwargs.get("agentcore_memory_config")


class _FakeAgentResult:
    message = "ok"


class _FakeAgent:
    """Callable stand-in for ``strands.Agent`` (accepts any kwargs)."""

    def __init__(self, *args, **kwargs):
        self.kwargs = kwargs

    def __call__(self, *args, **kwargs):
        return _FakeAgentResult()


class _FakeMCPClient:
    """Context-managed stand-in for ``strands.tools.mcp.MCPClient``.

    Supports the ``with client:`` lifecycle the ``invoke`` handler uses and a
    ``list_tools_sync`` that returns an empty catalog (a plain ``list`` has no
    ``pagination_token`` attribute, so ``list_tools_with_pagination`` stops
    after one page).
    """

    def __init__(self, transport_factory):
        self.transport_factory = transport_factory

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def list_tools_sync(self, pagination_token=None):
        return []


def _fake_bearer_transport(*, url=None, token=None, **kwargs):
    return ("bearer-transport", url, token)


def _fake_sigv4_transport(*, url=None, credentials=None, service=None, region=None, **kwargs):
    return ("sigv4-transport", url, service, region)


def _make_module(name: str) -> types.ModuleType:
    return types.ModuleType(name)


@contextmanager
def _stubbed_sys_modules():
    """Install fake modules (memory ENABLED) and restore originals on exit."""
    bac = _make_module("bedrock_agentcore")
    bac.__path__ = []
    bac_runtime = _make_module("bedrock_agentcore.runtime")

    class _FakeApp:
        def entrypoint(self, fn):
            return fn

        def run(self):  # pragma: no cover - never called
            pass

    bac_runtime.BedrockAgentCoreApp = lambda *a, **k: _FakeApp()
    bac_runtime.BedrockAgentCoreContext = _FakeWorkloadContext

    bac_memory = _make_module("bedrock_agentcore.memory")
    bac_memory.__path__ = []
    bac_mem_int = _make_module("bedrock_agentcore.memory.integrations")
    bac_mem_int.__path__ = []
    bac_mem_strands = _make_module("bedrock_agentcore.memory.integrations.strands")
    bac_mem_strands.__path__ = []
    bac_mem_cfg = _make_module("bedrock_agentcore.memory.integrations.strands.config")
    bac_mem_cfg.AgentCoreMemoryConfig = _FakeMemoryConfig
    bac_mem_sm = _make_module("bedrock_agentcore.memory.integrations.strands.session_manager")
    bac_mem_sm.AgentCoreMemorySessionManager = _FakeSessionManager

    strands = _make_module("strands")
    strands.__path__ = []
    strands.Agent = _FakeAgent
    strands_models = _make_module("strands.models")
    strands_models.BedrockModel = lambda *a, **k: object()
    strands_tools = _make_module("strands.tools")
    strands_tools.__path__ = []
    strands_tools_mcp = _make_module("strands.tools.mcp")
    strands_tools_mcp.MCPClient = _FakeMCPClient

    sigv4_mod = _make_module("streamable_http_sigv4")
    sigv4_mod.streamablehttp_client_with_sigv4 = _fake_sigv4_transport
    bearer_mod = _make_module("streamable_http_bearer")
    bearer_mod.streamablehttp_client_with_bearer = _fake_bearer_transport

    boto3_mod = _make_module("boto3")

    class _FakeCreds:
        access_key = "AKIAFAKE"
        secret_key = "fakesecret"  # nosec B105 - fake test credential
        token = "fakesessiontoken"  # nosec B105 - fake test credential

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
    saved_env = {
        "GATEWAY_ARN": os.environ.get("GATEWAY_ARN"),
        "AWS_REGION": os.environ.get("AWS_REGION"),
        "MEMORY_ID": os.environ.get("MEMORY_ID"),
    }
    try:
        sys.modules.update(fakes)
        os.environ["GATEWAY_ARN"] = _TEST_GATEWAY_ARN
        os.environ["AWS_REGION"] = "us-east-1"
        os.environ["MEMORY_ID"] = _TEST_MEMORY_ID  # memory ENABLED for this test
        yield
    finally:
        for name, original in saved.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original
        if saved_agent_runtime is not None:
            sys.modules["agent_runtime"] = saved_agent_runtime
        else:
            sys.modules.pop("agent_runtime", None)
        for key, original in saved_env.items():
            if original is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = original


def _import_agent_runtime():
    """Import ``agent_runtime`` under the stubs (memory enabled) and return it."""
    with _stubbed_sys_modules():
        sys.modules.pop("agent_runtime", None)
        return importlib.import_module("agent_runtime")


# Import once — module-load side effects run under the stubs. ``MEMORY_ID`` was
# set before import, so ``agent_runtime.MEMORY_ID`` is truthy for every invoke.
agent_runtime = _import_agent_runtime()


# ===========================================================================
# JWT helper — build an unsigned, base64url JWT carrying a ``sub`` claim
# (the shape the discovery-filter interceptor's ``_decode_jwt_claims`` reads)
# ===========================================================================

def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _make_jwt(sub: str) -> str:
    """Return a 3-segment JWT whose payload carries the given ``sub`` claim."""
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode("utf-8"))
    payload = _b64url(json.dumps({"sub": sub, "token_use": "access"}).encode("utf-8"))
    signature = _b64url(b"not-verified-here")
    return f"{header}.{payload}.{signature}"


def _invoke_and_capture_actor_id(token, *, user_id=_PAYLOAD_USER_ID, session_id="sess-fixed"):
    """Drive ``invoke`` once and return the ``actor_id`` used to key memory."""
    _CAPTURED_CONFIGS.clear()
    payload = {"prompt": "hello", "sessionId": session_id, "userId": user_id}
    if token is not None:
        payload["accessToken"] = token
    agent_runtime.invoke(payload)
    assert _CAPTURED_CONFIGS, (
        "expected the invoke handler to construct an AgentCoreMemoryConfig "
        "(MEMORY_ID is enabled) — none was captured"
    )
    return _CAPTURED_CONFIGS[-1].actor_id


# ===========================================================================
# Sub strategy — non-empty identifiers resembling Cognito ``sub`` values
# ===========================================================================

_SUB_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-:"
_sub_strategy = st.text(alphabet=_SUB_ALPHABET, min_size=1, max_size=36)


# ===========================================================================
# Property 1 (Bug Condition): memory keyed to verified per-user ``sub``
# ===========================================================================

@settings(max_examples=100, deadline=None)
@given(subs=st.lists(_sub_strategy, min_size=2, max_size=2, unique=True))
def test_distinct_subs_yield_distinct_actor_ids_equal_to_verified_sub(subs):
    """Two distinct verified subs must key memory to two distinct actor_ids,
    each equal to the request's verified Cognito ``sub`` — not the payload
    ``userId`` (held constant at ``amplify_user``).

    EXPECTED on UNFIXED code: FAILS — both users resolve to
    ``actor_id="amplify_user"`` because the runtime keys memory on the payload
    ``userId`` rather than the verified ``sub``.

    **Validates: Requirements 1.1, 2.1**
    """
    sub_a, sub_b = subs
    assume(sub_a != _PAYLOAD_USER_ID and sub_b != _PAYLOAD_USER_ID)

    # Reset the steerable inbound context so the token is resolved from payload.
    _FakeWorkloadContext.workload_token = None

    actor_a = _invoke_and_capture_actor_id(_make_jwt(sub_a))
    actor_b = _invoke_and_capture_actor_id(_make_jwt(sub_b))

    # Each user's memory is keyed to their own verified sub...
    assert actor_a == sub_a, (
        f"actor_id keyed to {actor_a!r}, expected verified sub {sub_a!r} "
        f"(payload userId was {_PAYLOAD_USER_ID!r})"
    )
    assert actor_b == sub_b, (
        f"actor_id keyed to {actor_b!r}, expected verified sub {sub_b!r} "
        f"(payload userId was {_PAYLOAD_USER_ID!r})"
    )
    # ...so two distinct users never share a memory actor...
    assert actor_a != actor_b, (
        f"distinct users {sub_a!r} and {sub_b!r} shared actor_id {actor_a!r}"
    )
    # ...and the untrusted payload userId is never used as the identity.
    assert actor_a != _PAYLOAD_USER_ID
    assert actor_b != _PAYLOAD_USER_ID


# ===========================================================================
# Edge case: token-less request with memory enabled (fail-closed expectation)
# ===========================================================================

def test_tokenless_memory_not_keyed_to_payload_userid():
    """With no resolvable token and memory enabled, memory must NOT be keyed to
    a trusted per-user actor derived from the untrusted payload ``userId``.

    EXPECTED on UNFIXED code: FAILS — the runtime keys ``actor_id`` to the
    payload ``userId`` (``amplify_user``) even though no verified identity was
    resolved.

    **Validates: Requirements 1.1, 2.1**
    """
    _FakeWorkloadContext.workload_token = None
    actor = _invoke_and_capture_actor_id(None, user_id=_PAYLOAD_USER_ID)
    assert actor != _PAYLOAD_USER_ID, (
        "token-less request keyed memory to the untrusted payload userId "
        f"{_PAYLOAD_USER_ID!r}; expected a fail-closed non-per-user actor"
    )
