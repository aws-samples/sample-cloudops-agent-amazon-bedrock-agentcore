# Feature: agentcore-security-review-fixes, Task 7 — unit tests for the
# behavior-changing fixes (BUG 1 memory actor isolation, BUG 5 refreshable
# SigV4 credentials) as they surface in ``agent_runtime.py``.
# **Validates: Requirements 2.1, 2.5, 3.1, 3.2, 3.3**
"""Deterministic, example-based unit tests for the ``agent_runtime`` side of the
two behavior-changing fixes.

These complement the property-based tests written in Tasks 1-4 with targeted,
deterministic coverage of:

BUG 1 (``agentcore/agent_runtime.py``)
  - ``resolve_verified_sub`` decodes the ``sub`` claim from a forwarded token
    (a valid 3-segment JWT), tolerating an optional ``"Bearer "`` prefix and
    missing base64url padding.
  - ``resolve_verified_sub`` returns ``None`` on every malformed input:
    ``None`` / empty / non-string token, a token with fewer than 2 segments, a
    malformed/undecodable payload segment, non-dict claims, and an
    absent/empty/non-string ``sub`` claim.
  - ``resolve_verified_sub`` never logs the raw token — only the resolved
    ``sub`` may be logged.
  - The ``invoke`` handler builds ``AgentCoreMemoryConfig`` with
    ``actor_id == verified_sub`` when a sub resolves, and with the fail-closed
    ``TOKENLESS_MEMORY_ACTOR_ID`` (never the payload ``userId``) when no sub
    resolves.

BUG 5 (``agentcore/agent_runtime.py`` side)
  - ``agent_runtime`` no longer builds a module-level frozen ``Credentials``
    snapshot; the SigV4 fallback branch passes the live
    ``session.get_credentials()`` object through unchanged, so a later refresh
    is observable (expired-vs-valid edge).

The signer-level BUG 5 assertions (per-request re-signing;
``streamablehttp_client_with_sigv4`` accepting a refreshable credentials object)
live in ``test_streamable_http_sigv4_unit.py``.

Import approach mirrors ``test_agent_runtime.py`` and the Task 1-4 property
tests: lightweight fakes are installed in ``sys.modules`` BEFORE importing
``agent_runtime`` (whose module load has AWS-dependent side effects and imports
submodules that are not importable in this environment). Memory is ENABLED
(``MEMORY_ID`` set) so the ``invoke`` memory-config construction path is
runnable and the constructed ``AgentCoreMemoryConfig.actor_id`` can be captured
and inspected WITHOUT any AWS calls or network.
"""

from __future__ import annotations

import base64
import importlib
import json
import logging
import os
import sys
import types
from contextlib import contextmanager

import pytest

# Make the parent ``agentcore`` package importable regardless of CWD.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ===========================================================================
# Capture sink + steerable inbound-token context (memory ENABLED)
# ===========================================================================

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
    """Fake ``AgentCoreMemoryConfig`` that records the ``actor_id`` chosen."""

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
    """Context-managed stand-in for ``strands.tools.mcp.MCPClient``."""

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


class _FakeCreds:
    """Stable, live-ish credential stand-in returned by the fake session.

    A single shared instance is handed out by ``get_credentials()`` so the test
    can assert the runtime supplies the LIVE object (identity) rather than a
    frozen copy, and can observe a post-supply mutation (refresh) through it.
    """

    def __init__(self, access_key="AKIALIVE0", secret_key="liveSecret0", token="liveToken0"):
        self.access_key = access_key
        self.secret_key = secret_key  # nosec B105 - fake test credential
        self.token = token  # nosec B105 - fake test credential

    def rotate(self, access_key, secret_key, token):
        self.access_key = access_key
        self.secret_key = secret_key
        self.token = token


_LIVE_CREDS = _FakeCreds()


def _fake_sigv4_transport(*, url=None, credentials=None, service=None, region=None, **kwargs):
    return ("sigv4-transport", url, credentials, service, region)


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

    class _FakeSession:
        region_name = "us-east-1"

        def get_credentials(self):
            # Always the SAME live singleton so identity + refresh are observable.
            return _LIVE_CREDS

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
        os.environ["MEMORY_ID"] = _TEST_MEMORY_ID  # memory ENABLED for this module
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
    with _stubbed_sys_modules():
        sys.modules.pop("agent_runtime", None)
        return importlib.import_module("agent_runtime")


# Import once — module-load side effects run under the stubs, memory enabled.
agent_runtime = _import_agent_runtime()


# ===========================================================================
# JWT helpers — build base64url JWTs with / without a ``sub`` claim
# ===========================================================================

def _b64url(raw: bytes) -> str:
    """base64url-encode WITHOUT padding (mirrors real JWT encoding)."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _jwt_from_payload(payload_obj) -> str:
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode("utf-8"))
    payload = _b64url(json.dumps(payload_obj).encode("utf-8"))
    signature = _b64url(b"signature-not-verified")
    return f"{header}.{payload}.{signature}"


def _make_jwt(sub) -> str:
    return _jwt_from_payload({"sub": sub, "token_use": "access"})


# ===========================================================================
# BUG 1 — resolve_verified_sub: happy-path decoding
# ===========================================================================

class TestResolveVerifiedSubDecoding:
    def test_decodes_sub_from_valid_jwt(self):
        token = _make_jwt("us-east-1:aaaa-bbbb")
        assert agent_runtime.resolve_verified_sub(token) == "us-east-1:aaaa-bbbb"

    def test_tolerates_bearer_prefix(self):
        token = "Bearer " + _make_jwt("sub-with-bearer")
        assert agent_runtime.resolve_verified_sub(token) == "sub-with-bearer"

    def test_tolerates_bearer_prefix_case_insensitive(self):
        token = "bEaReR " + _make_jwt("sub-mixed-case-bearer")
        assert agent_runtime.resolve_verified_sub(token) == "sub-mixed-case-bearer"

    def test_tolerates_missing_base64url_padding(self):
        """A payload whose base64url length is not a multiple of 4 (padding
        stripped, as real JWTs do) is still decoded — the resolver restores the
        padding before decoding."""
        token = _make_jwt("s")  # short payload => padding was stripped
        # Sanity: the payload segment length is NOT a multiple of 4.
        payload_segment = token.split(".")[1]
        assert len(payload_segment) % 4 != 0
        assert agent_runtime.resolve_verified_sub(token) == "s"

    def test_extra_whitespace_is_stripped(self):
        token = "   " + _make_jwt("sub-whitespace") + "   "
        assert agent_runtime.resolve_verified_sub(token) == "sub-whitespace"


# ===========================================================================
# BUG 1 — resolve_verified_sub: returns None on every malformed input
# ===========================================================================

class TestResolveVerifiedSubReturnsNone:
    def test_none_token(self):
        assert agent_runtime.resolve_verified_sub(None) is None

    def test_empty_string_token(self):
        assert agent_runtime.resolve_verified_sub("") is None

    @pytest.mark.parametrize("value", [123, 4.5, [], {}, b"bytes-token", object()])
    def test_non_string_token(self, value):
        assert agent_runtime.resolve_verified_sub(value) is None

    def test_fewer_than_two_segments(self):
        assert agent_runtime.resolve_verified_sub("onlyonesegment") is None

    def test_bearer_prefix_with_single_segment(self):
        assert agent_runtime.resolve_verified_sub("Bearer onlyonesegment") is None

    def test_malformed_undecodable_payload_invalid_json(self):
        """A payload segment that base64url-decodes to non-JSON bytes yields
        ``None`` (JSON parse failure is swallowed, never raised/logged)."""
        header = _b64url(b"header")
        bad_payload = _b64url(b"this is not json{{{")
        token = f"{header}.{bad_payload}.{_b64url(b'sig')}"
        assert agent_runtime.resolve_verified_sub(token) is None

    def test_malformed_undecodable_payload_garbage_segment(self):
        """A payload segment of non-base64 punctuation decodes to empty/garbage
        and fails JSON parsing => ``None``."""
        token = "header.@@@@.sig"
        assert agent_runtime.resolve_verified_sub(token) is None

    @pytest.mark.parametrize("claims", ["a plain string", 42, [1, 2, 3], True])
    def test_non_dict_claims(self, claims):
        """When the decoded payload is valid JSON but not an object, the claims
        are not a dict, so no ``sub`` can be read => ``None``."""
        token = _jwt_from_payload(claims)
        assert agent_runtime.resolve_verified_sub(token) is None

    def test_absent_sub_claim(self):
        token = _jwt_from_payload({"token_use": "access", "email": "x@example.com"})
        assert agent_runtime.resolve_verified_sub(token) is None

    def test_empty_sub_claim(self):
        token = _make_jwt("")
        assert agent_runtime.resolve_verified_sub(token) is None

    @pytest.mark.parametrize("sub", [123, 4.5, ["list"], {"nested": "dict"}, None, True])
    def test_non_string_sub_claim(self, sub):
        token = _jwt_from_payload({"sub": sub})
        assert agent_runtime.resolve_verified_sub(token) is None


# ===========================================================================
# BUG 1 — resolve_verified_sub never logs the raw token (only the sub)
# ===========================================================================

class TestResolveVerifiedSubDoesNotLogToken:
    def test_token_never_appears_in_logs_only_sub_does(self, caplog):
        sub = "us-east-1:logging-sub-9999"
        token = _make_jwt(sub)

        with caplog.at_level(logging.INFO, logger="agent_runtime"):
            result = agent_runtime.resolve_verified_sub(token)

        assert result == sub

        # The resolved sub MAY be logged...
        all_log_text = " ".join(record.getMessage() for record in caplog.records)
        assert sub in all_log_text, "expected the resolved sub to be logged for diagnostics"

        # ...but the raw token (and its unique payload segment) must NEVER appear.
        payload_segment = token.split(".")[1]
        for record in caplog.records:
            message = record.getMessage()
            assert token not in message, "raw token leaked into a log record"
            assert payload_segment not in message, "token payload segment leaked into a log record"

    def test_malformed_token_emits_no_token_bearing_log(self, caplog):
        """A malformed token must not be echoed into logs even on the error
        path (the offending text could contain token material)."""
        header = _b64url(b"header")
        bad_payload = _b64url(b"not-json-payload-SECRET123")
        token = f"{header}.{bad_payload}.{_b64url(b'sig')}"

        with caplog.at_level(logging.INFO, logger="agent_runtime"):
            result = agent_runtime.resolve_verified_sub(token)

        assert result is None
        for record in caplog.records:
            message = record.getMessage()
            assert token not in message
            assert bad_payload not in message
            assert "SECRET123" not in message


# ===========================================================================
# BUG 1 — invoke builds AgentCoreMemoryConfig keyed to the verified sub, and
# fails closed to TOKENLESS_MEMORY_ACTOR_ID when no sub resolves
# ===========================================================================

def _invoke_and_capture_config(token, *, user_id=_PAYLOAD_USER_ID, session_id="sess-fixed"):
    _CAPTURED_CONFIGS.clear()
    payload = {"prompt": "hello", "sessionId": session_id, "userId": user_id}
    if token is not None:
        payload["accessToken"] = token
    agent_runtime.invoke(payload)
    assert _CAPTURED_CONFIGS, (
        "expected invoke to construct an AgentCoreMemoryConfig (MEMORY_ID enabled)"
    )
    return _CAPTURED_CONFIGS[-1]


class TestMemoryActorKeying:
    def setup_method(self):
        _FakeWorkloadContext.workload_token = None

    def test_actor_id_equals_verified_sub_not_payload_userid(self):
        sub = "us-east-1:verified-1234"
        config = _invoke_and_capture_config(_make_jwt(sub))
        assert config.actor_id == sub
        assert config.actor_id != _PAYLOAD_USER_ID

    def test_session_id_is_preserved(self):
        """Preservation 3.3 — single-user session continuity is still keyed by
        the forwarded ``session_id``."""
        config = _invoke_and_capture_config(_make_jwt("sub-abc"), session_id="my-session-42")
        assert config.session_id == "my-session-42"
        assert config.memory_id == _TEST_MEMORY_ID

    def test_distinct_subs_yield_distinct_actor_ids(self):
        config_a = _invoke_and_capture_config(_make_jwt("sub-alice"))
        actor_a = config_a.actor_id
        config_b = _invoke_and_capture_config(_make_jwt("sub-bob"))
        actor_b = config_b.actor_id
        assert actor_a == "sub-alice"
        assert actor_b == "sub-bob"
        assert actor_a != actor_b

    def test_tokenless_request_fails_closed_to_placeholder_actor(self):
        """Fail-closed (3.2): with no resolvable token, memory is keyed to the
        non-cross-user ``TOKENLESS_MEMORY_ACTOR_ID`` — never the payload
        ``userId``."""
        _FakeWorkloadContext.workload_token = None
        config = _invoke_and_capture_config(None, user_id=_PAYLOAD_USER_ID)
        assert config.actor_id == agent_runtime.TOKENLESS_MEMORY_ACTOR_ID
        assert config.actor_id != _PAYLOAD_USER_ID

    def test_token_with_no_sub_claim_fails_closed(self):
        """A resolvable token that carries no ``sub`` still fails closed to the
        placeholder actor rather than the payload ``userId``."""
        _FakeWorkloadContext.workload_token = None
        token_without_sub = _jwt_from_payload({"token_use": "access"})
        config = _invoke_and_capture_config(token_without_sub, user_id=_PAYLOAD_USER_ID)
        assert config.actor_id == agent_runtime.TOKENLESS_MEMORY_ACTOR_ID
        assert config.actor_id != _PAYLOAD_USER_ID


# ===========================================================================
# BUG 5 — agent_runtime holds no frozen Credentials snapshot; the SigV4 branch
# passes the live session.get_credentials() object through unchanged
# ===========================================================================

class TestNoFrozenCredentialsSnapshot:
    def test_no_module_level_frozen_credentials(self):
        """The frozen import-time snapshot has been removed entirely."""
        assert not hasattr(agent_runtime, "frozen_credentials")

    def test_sigv4_branch_passes_live_session_credentials(self):
        """The token-less SigV4 branch supplies exactly the live object returned
        by ``session.get_credentials()`` (identity), not a copied snapshot."""
        client = agent_runtime.build_mcp_client_for_token(None)
        transport = client.transport_factory()
        tag, url, credentials, service, region = transport
        assert tag == "sigv4-transport"
        assert service == "bedrock-agentcore"
        # The supplied credentials object IS the live session credentials object.
        assert credentials is agent_runtime.session.get_credentials()
        assert credentials is _LIVE_CREDS

    def test_supplied_credentials_reflect_a_later_refresh(self):
        """Because the live object is passed through (not frozen), a credential
        rotation AFTER the client is built is visible on the supplied object —
        the expired-vs-valid edge that motivated BUG 5."""
        _LIVE_CREDS.rotate("AKIALIVE0", "liveSecret0", "liveToken0")
        client = agent_runtime.build_mcp_client_for_token(None)
        supplied = client.transport_factory()[2]
        assert supplied.access_key == "AKIALIVE0"

        # Simulate a refresh in a long-lived container.
        _LIVE_CREDS.rotate("AKIAROTATED9", "rotatedSecret9", "rotatedToken9")
        try:
            assert supplied.access_key == "AKIAROTATED9"
            assert supplied.token == "rotatedToken9"
        finally:
            _LIVE_CREDS.rotate("AKIALIVE0", "liveSecret0", "liveToken0")
