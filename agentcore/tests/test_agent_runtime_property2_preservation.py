# Feature: agentcore-security-review-fixes, BUG 1, Property 2: Preservation
# DynamoDB history, fail-closed posture, session continuity
# **Validates: Requirements 3.1, 3.2, 3.3**
"""
BUG 1 — Preservation property tests (baseline behavior to preserve).

Observation-first methodology: these tests were written by first OBSERVING the
behavior of the UNFIXED code and then encoding that observed baseline as
property-based tests. They are EXPECTED TO PASS on the current (unfixed) code —
passing confirms the baseline behavior the BUG 1 fix must NOT regress.

They cover the three non-bug-condition ("¬C(X)") preserved paths from
``bugfix.md`` (3.1/3.2/3.3) and ``design.md`` (Property 2: Preservation):

  * 3.1 — DynamoDB conversation history is keyed by the REAL Cognito ``sub``
          taken from the verified Cognito authorizer claims, never from any
          client-supplied ``userId`` in the request body. This path lives in
          ``cdk/lambda/conversations/handler.py`` and is NOT modified by BUG 1.

  * 3.2 — A token-less request selects the SigV4 fallback transport (the
          runtime's own IAM principal / NonAdmin posture) and is never escalated
          to Admin based on payload content (e.g. an injected ``role``).

  * 3.3 — With memory enabled, a single user continuing their own session keeps
          AgentCore Memory keyed by the forwarded ``session_id`` (session
          continuity), regardless of how the actor is derived.

OBSERVED BASELINE (recorded before encoding):

  3.1  ``conversations/handler.py`` does
       ``user_id = event['requestContext']['authorizer']['claims']['sub']`` and
       uses that value as the DynamoDB ``userId`` partition key in ``put_item``
       / ``get_item``. A client-supplied ``userId`` in the JSON body is ignored.

  3.2  ``resolve_user_token`` returns ``None`` when no ``accessToken`` payload
       field and no inbound JWT context token are present; it never reads a
       ``role`` field. ``build_mcp_client_for_token(None)`` builds an MCP client
       whose transport factory returns the SigV4 transport tuple.

  3.3  ``invoke`` reads ``session_id = payload.get("sessionId", ...)`` and builds
       ``AgentCoreMemoryConfig(..., session_id=session_id, ...)`` — the forwarded
       session id is passed straight through to memory keying.

EXPECTED OUTCOME ON UNFIXED CODE: all tests PASS.

Import approach mirrors ``test_agent_runtime.py`` and
``test_agent_runtime_property1_memory_actor_isolation.py``: lightweight fakes
are installed in ``sys.modules`` BEFORE importing the module under test so the
AWS-dependent module-load side effects run without any AWS calls or network.
``agent_runtime`` is imported with memory ENABLED (``MEMORY_ID`` set) so the
``invoke`` memory-config construction path is runnable and the constructed
``AgentCoreMemoryConfig`` can be captured. The ``conversations`` handler is
imported under a fake ``boto3`` whose fake DynamoDB table records the keys used.
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

_TEST_GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gw-test-1234"
_TEST_MEMORY_ID = "mem-test-abcdef"
_SIGV4_TAG = "sigv4-transport"
_BEARER_TAG = "bearer-transport"


# ===========================================================================
# Section A — agent_runtime stubs (memory ENABLED), used for 3.2 and 3.3
# ===========================================================================

# Every ``AgentCoreMemoryConfig(...)`` the runtime builds is recorded here so a
# test can inspect the ``session_id`` (and ``actor_id``) chosen for memory.
_CAPTURED_CONFIGS: list = []


class _FakeWorkloadContext:
    """Fake ``BedrockAgentCoreContext`` with a steerable inbound-token getter."""

    workload_token = None

    @classmethod
    def get_workload_access_token(cls):
        return cls.workload_token


class _FakeMemoryConfig:
    """Fake ``AgentCoreMemoryConfig`` recording the keying decision."""

    def __init__(self, **kwargs):
        self.memory_id = kwargs.get("memory_id")
        self.session_id = kwargs.get("session_id")
        self.actor_id = kwargs.get("actor_id")
        _CAPTURED_CONFIGS.append(self)


class _FakeSessionManager:
    def __init__(self, **kwargs):
        self.config = kwargs.get("agentcore_memory_config")


class _FakeAgentResult:
    message = "ok"


class _FakeAgent:
    def __init__(self, *args, **kwargs):
        self.kwargs = kwargs

    def __call__(self, *args, **kwargs):
        return _FakeAgentResult()


class _FakeMCPClient:
    """Context-managed stand-in for ``strands.tools.mcp.MCPClient``.

    Keeps the transport factory so a test can invoke it and identify which
    transport (Bearer vs. SigV4) a built client would use, and supports the
    ``with client:`` lifecycle plus an empty ``list_tools_sync`` catalog.
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
    return (_BEARER_TAG, url, token)


def _fake_sigv4_transport(*, url=None, credentials=None, service=None, region=None, **kwargs):
    return (_SIGV4_TAG, url, service, region)


def _make_module(name: str) -> types.ModuleType:
    return types.ModuleType(name)


@contextmanager
def _stubbed_agent_runtime_modules():
    """Install fakes (memory ENABLED) and restore originals + env on exit."""
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
        os.environ["MEMORY_ID"] = _TEST_MEMORY_ID  # memory ENABLED
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
    with _stubbed_agent_runtime_modules():
        sys.modules.pop("agent_runtime", None)
        return importlib.import_module("agent_runtime")


# Import once — module-load side effects run under the stubs (memory enabled).
agent_runtime = _import_agent_runtime()


# ===========================================================================
# Section B — conversations handler stubs (fake DynamoDB), used for 3.1
# ===========================================================================

_CONV_HANDLER_DIR = os.path.abspath(
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "cdk",
        "lambda",
        "conversations",
    )
)


class _FakeDynamoTable:
    """Fake ``boto3`` DynamoDB Table recording the keys used per operation."""

    def __init__(self, name):
        self.name = name
        self.put_items: list = []
        self.get_keys: list = []

    def put_item(self, Item=None, **kwargs):
        self.put_items.append(Item)
        return {}

    def get_item(self, Key=None, **kwargs):
        self.get_keys.append(Key)
        # Return an item owned by whatever userId was queried so the handler's
        # ownership check passes and the read path completes.
        if Key is not None:
            return {
                "Item": {
                    "userId": Key.get("userId"),
                    "conversationId": Key.get("conversationId"),
                    "conversationName": "n",
                    "messages": [],
                    "createdAt": "t",
                    "updatedAt": "t",
                }
            }
        return {}

    def query(self, **kwargs):  # pragma: no cover - not exercised here
        return {"Items": []}


class _FakeDynamoResource:
    def __init__(self):
        self.tables: dict = {}

    def Table(self, name):
        self.tables.setdefault(name, _FakeDynamoTable(name))
        return self.tables[name]


@contextmanager
def _stubbed_conversations_module():
    """Install a fake ``boto3`` and import the conversations handler."""
    boto3_mod = _make_module("boto3")
    resource = _FakeDynamoResource()
    boto3_mod.resource = lambda *a, **k: resource

    saved_boto3 = sys.modules.get("boto3")
    saved_handler = sys.modules.pop("handler", None)
    added_path = _CONV_HANDLER_DIR not in sys.path
    if added_path:
        sys.path.insert(0, _CONV_HANDLER_DIR)
    try:
        sys.modules["boto3"] = boto3_mod
        sys.modules.pop("handler", None)
        handler_mod = importlib.import_module("handler")
        yield handler_mod
    finally:
        if saved_boto3 is None:
            sys.modules.pop("boto3", None)
        else:
            sys.modules["boto3"] = saved_boto3
        if saved_handler is not None:
            sys.modules["handler"] = saved_handler
        else:
            sys.modules.pop("handler", None)
        if added_path and _CONV_HANDLER_DIR in sys.path:
            sys.path.remove(_CONV_HANDLER_DIR)


# ===========================================================================
# Strategies
# ===========================================================================

_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-:"
_sub_strategy = st.text(alphabet=_ID_ALPHABET, min_size=1, max_size=36)
_session_strategy = st.text(alphabet=_ID_ALPHABET + "._", min_size=1, max_size=40)
# Arbitrary "role"-like values an attacker might inject into the payload.
_role_strategy = st.sampled_from(
    ["admin", "Admin", "ADMIN", "Administrator", "superuser", "root", "nonadmin", ""]
)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _make_jwt(sub: str) -> str:
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode("utf-8"))
    payload = _b64url(json.dumps({"sub": sub, "token_use": "access"}).encode("utf-8"))
    signature = _b64url(b"not-verified-here")
    return f"{header}.{payload}.{signature}"


# ===========================================================================
# 3.1 — DynamoDB conversation history keyed by the real Cognito ``sub``
# ===========================================================================

@settings(max_examples=100, deadline=None)
@given(sub=_sub_strategy, body_user_id=st.one_of(st.none(), _sub_strategy))
def test_dynamodb_history_keyed_by_verified_sub_not_payload(sub, body_user_id):
    """For any request, the DynamoDB partition key equals the verified Cognito
    ``sub`` from the authorizer claims — never a client-supplied ``userId`` in
    the request body.

    EXPECTED on UNFIXED code: PASSES (baseline to preserve, 3.1).

    **Validates: Requirements 3.1**
    """
    assume(body_user_id != sub)  # exercise the adversarial-mismatch case

    with _stubbed_conversations_module() as handler_mod:
        table = handler_mod.table

        body = {"conversationName": "hello"}
        if body_user_id is not None:
            # Attacker-supplied identity in the body — must be ignored.
            body["userId"] = body_user_id

        create_event = {
            "httpMethod": "POST",
            "resource": "/conversations",
            "requestContext": {"authorizer": {"claims": {"sub": sub}}},
            "body": json.dumps(body),
        }
        resp = handler_mod.handler(create_event, None)
        assert resp["statusCode"] == 201

        # The write is keyed by the verified sub, not the body-supplied userId.
        assert table.put_items, "expected a put_item on the create path"
        written = table.put_items[-1]
        assert written["userId"] == sub, (
            f"DynamoDB partition key {written['userId']!r} != verified sub {sub!r}"
        )
        if body_user_id is not None:
            assert written["userId"] != body_user_id, (
                "DynamoDB keyed by the client-supplied body userId "
                f"{body_user_id!r} instead of the verified sub"
            )

        # The read path is likewise keyed by the verified sub.
        conv_id = json.loads(resp["body"])["conversationId"]
        get_event = {
            "httpMethod": "GET",
            "resource": "/conversations/{conversationId}",
            "requestContext": {"authorizer": {"claims": {"sub": sub}}},
            "pathParameters": {"conversationId": conv_id},
        }
        get_resp = handler_mod.handler(get_event, None)
        assert get_resp["statusCode"] == 200
        assert table.get_keys, "expected a get_item on the read path"
        assert table.get_keys[-1]["userId"] == sub


def test_dynamodb_history_missing_sub_is_unauthorized():
    """With no verified ``sub`` claim, the DynamoDB path refuses the request
    (401) rather than falling back to any client-supplied identity — the
    fail-closed baseline for the history path.

    EXPECTED on UNFIXED code: PASSES (baseline to preserve, 3.1).

    **Validates: Requirements 3.1**
    """
    with _stubbed_conversations_module() as handler_mod:
        event = {
            "httpMethod": "POST",
            "resource": "/conversations",
            "requestContext": {"authorizer": {"claims": {}}},
            "body": json.dumps({"userId": "attacker-supplied"}),
        }
        resp = handler_mod.handler(event, None)
        assert resp["statusCode"] == 401
        assert not handler_mod.table.put_items, (
            "no write should occur when no verified sub is present"
        )


# ===========================================================================
# 3.2 — Token-less requests: SigV4 fallback, NonAdmin, no payload escalation
# ===========================================================================

@settings(max_examples=100, deadline=None)
@given(
    role=_role_strategy,
    session_id=_session_strategy,
    user_id=st.text(alphabet=_ID_ALPHABET, min_size=0, max_size=20),
)
def test_tokenless_request_selects_sigv4_fallback_no_escalation(role, session_id, user_id):
    """For any token-less payload — even one carrying an injected ``role`` —
    ``resolve_user_token`` returns ``None`` and the built MCP client selects the
    SigV4 fallback transport (NonAdmin posture). Payload content never escalates
    identity.

    EXPECTED on UNFIXED code: PASSES (baseline to preserve, 3.2).

    **Validates: Requirements 3.2**
    """
    _FakeWorkloadContext.workload_token = None  # no inbound context token either

    payload = {"prompt": "hi", "sessionId": session_id, "userId": user_id, "role": role}

    # No token resolves from a token-less payload, regardless of injected role.
    resolved = agent_runtime.resolve_user_token(payload)
    assert resolved is None, f"token-less payload resolved a token: {resolved!r}"

    # The token-less client uses the SigV4 fallback (Gateway still called, but
    # with the runtime's IAM principal → Gateway applies NonAdmin by default).
    client = agent_runtime.build_mcp_client_for_token(resolved)
    transport = client.transport_factory()
    assert transport[0] == _SIGV4_TAG, (
        f"token-less request selected {transport[0]!r}, expected the SigV4 fallback"
    )
    assert transport[0] != _BEARER_TAG


@settings(max_examples=100, deadline=None)
@given(role=_role_strategy, token_sub=_sub_strategy)
def test_injected_role_never_substitutes_for_a_token(role, token_sub):
    """An injected ``role`` is never read as identity: with a real token present
    the resolved value is exactly the token (never the role), and with only a
    role present resolution is ``None`` (no escalation from payload content).

    EXPECTED on UNFIXED code: PASSES (baseline to preserve, 3.2).

    **Validates: Requirements 3.2**
    """
    _FakeWorkloadContext.workload_token = None

    # Role alone, no token → None (no escalation).
    assert agent_runtime.resolve_user_token({"role": role}) is None

    # Role alongside a real token → the token wins; the role is never returned.
    token = _make_jwt(token_sub)
    resolved = agent_runtime.resolve_user_token({"role": role, "accessToken": token})
    assert resolved == token
    assert resolved != role


# ===========================================================================
# 3.3 — Single user's own session: AgentCore Memory keyed by ``session_id``
# ===========================================================================

def _invoke_and_capture_config(token, *, session_id, user_id="amplify_user"):
    """Drive ``invoke`` once and return the captured ``AgentCoreMemoryConfig``."""
    _CAPTURED_CONFIGS.clear()
    payload = {"prompt": "hello", "sessionId": session_id, "userId": user_id}
    if token is not None:
        payload["accessToken"] = token
    agent_runtime.invoke(payload)
    assert _CAPTURED_CONFIGS, (
        "expected invoke to construct an AgentCoreMemoryConfig (MEMORY_ID enabled)"
    )
    return _CAPTURED_CONFIGS[-1]


@settings(max_examples=100, deadline=None)
@given(session_id=_session_strategy, sub=_sub_strategy)
def test_own_session_memory_keyed_by_session_id(session_id, sub):
    """With memory enabled, a single user's own request keys AgentCore Memory by
    the forwarded ``session_id`` (session continuity), and the configured
    ``memory_id`` is the enabled memory.

    EXPECTED on UNFIXED code: PASSES (baseline to preserve, 3.3).

    **Validates: Requirements 3.3**
    """
    _FakeWorkloadContext.workload_token = None
    config = _invoke_and_capture_config(_make_jwt(sub), session_id=session_id)

    assert config.session_id == session_id, (
        f"memory keyed by session_id {config.session_id!r}, expected {session_id!r}"
    )
    assert config.memory_id == _TEST_MEMORY_ID


@settings(max_examples=50, deadline=None)
@given(session_id=_session_strategy, sub=_sub_strategy)
def test_same_user_same_session_is_stable_across_calls(session_id, sub):
    """The same user continuing the same session yields the same ``session_id``
    memory key across repeated invocations (continuity without regression).

    EXPECTED on UNFIXED code: PASSES (baseline to preserve, 3.3).

    **Validates: Requirements 3.3**
    """
    _FakeWorkloadContext.workload_token = None
    token = _make_jwt(sub)
    first = _invoke_and_capture_config(token, session_id=session_id)
    second = _invoke_and_capture_config(token, session_id=session_id)
    assert first.session_id == second.session_id == session_id
