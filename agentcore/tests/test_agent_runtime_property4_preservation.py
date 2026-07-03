# Feature: agentcore-security-review-fixes, BUG 5, Property 4: Preservation
# Bearer path and valid-credentials happy path
# **Validates: Requirements 3.5, 3.6**
"""
BUG 5 — Preservation property tests (baseline behavior to preserve).

Observation-first methodology: these tests were written by first OBSERVING the
behavior of the UNFIXED code and then encoding that observed baseline as
property-based tests. They are EXPECTED TO PASS on the current (unfixed) code —
passing confirms the baseline behavior the BUG 5 credential-refresh fix must NOT
regress.

They cover the two non-bug-condition ("¬C(X)") preserved paths from
``bugfix.md`` (3.5 / 3.6) and ``design.md`` (Property 4: Preservation):

  * 3.5 — When a user token is present the Bearer transport
          (``streamable_http_bearer.py``) is selected on the hop-2
          Agent_Runtime -> Gateway leg, and the Cognito JWT is forwarded
          UNMODIFIED as the ``Authorization: Bearer <token>`` header. The
          BUG 5 credential-refresh change affects only the token-less SigV4
          fallback path, so this Bearer path must be untouched.

  * 3.6 — With valid, non-expired credentials the SigV4 fallback signs and
          produces WELL-FORMED signed headers (SigV4 ``Authorization`` with
          ``AWS4-HMAC-SHA256`` + ``Credential``/``SignedHeaders``/``Signature``,
          an ``X-Amz-Date``, and an ``X-Amz-Security-Token`` when a session
          token is present) that would reach the Gateway. Valid credentials
          already work today and must keep working after the fix.

OBSERVED BASELINE (recorded before encoding, on the UNFIXED code):

  3.5  ``build_mcp_client_for_token(token)`` with a truthy ``token`` returns an
       ``MCPClient`` whose transport factory calls
       ``streamablehttp_client_with_bearer(url=gateway_endpoint, token=token)``
       — i.e. it selects the Bearer transport and passes the token through
       unchanged. ``resolve_user_token({"accessToken": <jwt>})`` returns that
       exact jwt. The real ``streamable_http_bearer.streamablehttp_client_with_bearer``
       builds ``headers = {"Authorization": f"Bearer {token}"}`` — the token is
       forwarded byte-for-byte with no trimming/substitution.

  3.6  ``build_mcp_client_for_token(None)`` returns an ``MCPClient`` whose
       transport factory calls ``streamablehttp_client_with_sigv4(...,
       credentials=<runtime creds>, service="bedrock-agentcore",
       region=AWS_REGION)``. The real ``SigV4HTTPXAuth.auth_flow`` signs each
       request via ``botocore``'s ``SigV4Auth.add_auth``, producing a
       well-formed ``AWS4-HMAC-SHA256`` ``Authorization`` header whose
       ``Credential=`` scope carries the supplied access key, plus ``X-Amz-Date``
       and (when the credentials carry a session token) ``X-Amz-Security-Token``.

EXPECTED OUTCOME ON UNFIXED CODE: all tests PASS.

Import approach mirrors the sibling property tests
(``test_agent_runtime_property2_preservation.py`` and
``test_streamable_http_sigv4_property3_frozen_credentials.py``): the REAL SigV4
signer is imported BEFORE any ``sys.modules`` stubbing so 3.6 exercises genuine
``botocore`` signing (no AWS calls, no network), and lightweight fakes are
installed in ``sys.modules`` BEFORE importing ``agent_runtime`` (whose module
load has AWS-dependent side effects). The real ``streamable_http_bearer`` module
is imported under a fake ``mcp`` transport so 3.5 can assert the header the
Bearer transport actually builds — again with no network.
"""

from __future__ import annotations

import asyncio
import base64
import importlib
import json
import os
import re
import sys
import types
from contextlib import contextmanager

import httpx
from botocore.credentials import ReadOnlyCredentials
from hypothesis import assume, given, settings
from hypothesis import strategies as st

# Make the parent ``agentcore`` package importable regardless of CWD.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import the REAL SigV4 signer BEFORE any sys.modules stubbing so 3.6 holds a
# genuine reference to the class under test. ``agent_runtime`` will later import
# a FAKE ``streamable_http_sigv4`` module purely to capture the credentials it
# supplies; the real signing is done here with this real class.
import streamable_http_sigv4 as _real_sigv4_module  # noqa: E402

RealSigV4HTTPXAuth = _real_sigv4_module.SigV4HTTPXAuth

_TEST_GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gw-test-1234"
_SIGV4_TAG = "sigv4-transport"
_BEARER_TAG = "bearer-transport"

# Valid, non-expired credential material the fake runtime session hands out.
_VALID_ACCESS_KEY = "EXAMPLEKEYVALIDLIVE1"  # nosec B105 - fake, non-AWS-format test value
_VALID_SECRET_KEY = "validLiveSecret000000000000000000000000"  # nosec B105 - fake
_VALID_TOKEN = "validLiveSessionToken0001"  # nosec B105 - fake test credential


def _make_module(name: str) -> types.ModuleType:
    return types.ModuleType(name)


# Records the credentials object ``agent_runtime`` supplies to the SigV4 branch.
_CAPTURED_SIGV4_KWARGS: list = []
# Records the (url, token) the Bearer transport factory is called with.
_CAPTURED_BEARER_KWARGS: list = []


def _capturing_sigv4_transport(*, url=None, credentials=None, service=None, region=None, **kwargs):
    _CAPTURED_SIGV4_KWARGS.append(
        {"url": url, "credentials": credentials, "service": service, "region": region}
    )
    return (_SIGV4_TAG, url, service, region)


def _capturing_bearer_transport(*, url=None, token=None, **kwargs):
    _CAPTURED_BEARER_KWARGS.append({"url": url, "token": token})
    return (_BEARER_TAG, url, token)


class _FakeMCPClient:
    """Stand-in for ``strands.tools.mcp.MCPClient`` — keeps the transport factory
    so a test can invoke it and identify which transport (Bearer vs. SigV4) a
    built client would use, WITHOUT opening a connection."""

    def __init__(self, transport_factory):
        self.transport_factory = transport_factory


class _FakeWorkloadContext:
    workload_token = None

    @classmethod
    def get_workload_access_token(cls):
        return cls.workload_token


class _FakeAgent:
    def __init__(self, *args, **kwargs):
        self.kwargs = kwargs

    def __call__(self, *args, **kwargs):
        class _R:
            message = "ok"

        return _R()


class _FakeValidCredentials:
    """Live credential object returned by the fake session — valid/non-expired.

    Mirrors the ``botocore`` credential surface the runtime reads at import:
    ``.access_key`` / ``.secret_key`` / ``.token`` and ``get_frozen_credentials``.
    """

    method = "custom-valid"
    access_key = _VALID_ACCESS_KEY
    secret_key = _VALID_SECRET_KEY
    token = _VALID_TOKEN

    def get_frozen_credentials(self):
        return ReadOnlyCredentials(self.access_key, self.secret_key, self.token)


class _FakeSession:
    region_name = "us-east-1"

    def get_credentials(self):
        return _FakeValidCredentials()


@contextmanager
def _stubbed_sys_modules():
    """Install fake modules and restore originals + env on exit (memory off)."""
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
    bac_mem_cfg.AgentCoreMemoryConfig = lambda **k: types.SimpleNamespace(**k)
    bac_mem_sm = _make_module("bedrock_agentcore.memory.integrations.strands.session_manager")
    bac_mem_sm.AgentCoreMemorySessionManager = lambda **k: object()

    strands = _make_module("strands")
    strands.__path__ = []
    strands.Agent = _FakeAgent
    strands_models = _make_module("strands.models")
    strands_models.BedrockModel = lambda *a, **k: object()
    strands_tools = _make_module("strands.tools")
    strands_tools.__path__ = []
    strands_tools_mcp = _make_module("strands.tools.mcp")
    strands_tools_mcp.MCPClient = _FakeMCPClient

    # FAKE transport modules so ``agent_runtime``'s imports bind our capturing
    # transports. The REAL SigV4 signer is held separately in
    # ``RealSigV4HTTPXAuth``; the real Bearer transport is exercised elsewhere
    # via ``_import_real_bearer_module``.
    sigv4_mod = _make_module("streamable_http_sigv4")
    sigv4_mod.streamablehttp_client_with_sigv4 = _capturing_sigv4_transport
    bearer_mod = _make_module("streamable_http_bearer")
    bearer_mod.streamablehttp_client_with_bearer = _capturing_bearer_transport

    boto3_mod = _make_module("boto3")
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
        os.environ.pop("MEMORY_ID", None)  # memory irrelevant to these paths
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


# Import once — module-load side effects run under the stubs (memory disabled,
# valid credentials).
agent_runtime = _import_agent_runtime()


# ===========================================================================
# Real Bearer transport under a fake ``mcp`` client (captures the built header)
# ===========================================================================

_CAPTURED_BEARER_HEADERS: list = []


@contextmanager
def _stubbed_mcp_for_bearer():
    """Install a fake ``mcp.client.streamable_http.streamablehttp_client`` that
    records the headers passed, then import the REAL ``streamable_http_bearer``
    module against it. Restores originals on exit."""
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _fake_streamablehttp_client(url, headers=None, timeout=None):
        _CAPTURED_BEARER_HEADERS.append({"url": url, "headers": headers, "timeout": timeout})
        yield ("fake-mcp-session", url, headers)

    mcp_mod = _make_module("mcp")
    mcp_mod.__path__ = []
    mcp_client = _make_module("mcp.client")
    mcp_client.__path__ = []
    mcp_streamable = _make_module("mcp.client.streamable_http")
    mcp_streamable.streamablehttp_client = _fake_streamablehttp_client

    fakes = {
        "mcp": mcp_mod,
        "mcp.client": mcp_client,
        "mcp.client.streamable_http": mcp_streamable,
    }
    saved = {name: sys.modules.get(name) for name in fakes}
    saved_bearer = sys.modules.pop("streamable_http_bearer", None)
    try:
        sys.modules.update(fakes)
        sys.modules.pop("streamable_http_bearer", None)
        real_bearer = importlib.import_module("streamable_http_bearer")
        yield real_bearer
    finally:
        for name, original in saved.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original
        if saved_bearer is not None:
            sys.modules["streamable_http_bearer"] = saved_bearer
        else:
            sys.modules.pop("streamable_http_bearer", None)


def _run_real_bearer_transport(url: str, token: str) -> dict:
    """Drive the REAL ``streamablehttp_client_with_bearer`` async context once
    and return the captured ``{url, headers, timeout}`` the underlying client
    was called with."""
    _CAPTURED_BEARER_HEADERS.clear()

    async def _drive(bearer_mod):
        async with bearer_mod.streamablehttp_client_with_bearer(url=url, token=token):
            pass

    with _stubbed_mcp_for_bearer() as bearer_mod:
        asyncio.run(_drive(bearer_mod))

    assert _CAPTURED_BEARER_HEADERS, "the real Bearer transport built no headers"
    return _CAPTURED_BEARER_HEADERS[-1]


# ===========================================================================
# Strategies
# ===========================================================================

_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-:"
_sub_strategy = st.text(alphabet=_ID_ALPHABET, min_size=1, max_size=36)
# JWT-shaped tokens are opaque to the transports; allow the broad set of chars a
# base64url JWT + separators uses so we exercise "forward unmodified".
_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."
_raw_token_strategy = st.text(alphabet=_TOKEN_ALPHABET, min_size=1, max_size=120)

_CRED_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
_ak_strategy = st.text(alphabet=_CRED_ALPHABET, min_size=8, max_size=24)
_sk_strategy = st.text(alphabet=_CRED_ALPHABET, min_size=16, max_size=40)
_tok_strategy = st.text(alphabet=_CRED_ALPHABET, min_size=16, max_size=48)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _make_jwt(sub: str) -> str:
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode("utf-8"))
    payload = _b64url(json.dumps({"sub": sub, "token_use": "access"}).encode("utf-8"))
    signature = _b64url(b"not-verified-here")
    return f"{header}.{payload}.{signature}"


# ===========================================================================
# 3.5 — Token present: Bearer transport selected, JWT forwarded unmodified
# ===========================================================================

@settings(max_examples=100, deadline=None)
@given(token=_raw_token_strategy)
def test_token_present_selects_bearer_transport_unmodified(token):
    """For any present user token, ``build_mcp_client_for_token`` selects the
    Bearer transport and passes the token through UNMODIFIED (never the SigV4
    fallback).

    EXPECTED on UNFIXED code: PASSES (baseline to preserve, 3.5).

    **Validates: Requirements 3.5**
    """
    _CAPTURED_BEARER_KWARGS.clear()
    _CAPTURED_SIGV4_KWARGS.clear()

    client = agent_runtime.build_mcp_client_for_token(token)
    transport = client.transport_factory()

    assert transport[0] == _BEARER_TAG, (
        f"token-present request selected {transport[0]!r}, expected the Bearer transport"
    )
    assert not _CAPTURED_SIGV4_KWARGS, "SigV4 fallback must not be used when a token is present"
    assert _CAPTURED_BEARER_KWARGS, "Bearer transport was not invoked"
    # The token handed to the Bearer transport is byte-for-byte the input token.
    assert _CAPTURED_BEARER_KWARGS[-1]["token"] == token
    assert transport[2] == token


@settings(max_examples=100, deadline=None)
@given(sub=_sub_strategy)
def test_payload_access_token_resolves_then_uses_bearer_unmodified(sub):
    """An ``accessToken`` payload field resolves to that exact JWT, and the
    client built for it uses the Bearer transport carrying the JWT unmodified.

    EXPECTED on UNFIXED code: PASSES (baseline to preserve, 3.5).

    **Validates: Requirements 3.5**
    """
    _FakeWorkloadContext.workload_token = None
    token = _make_jwt(sub)

    resolved = agent_runtime.resolve_user_token({"prompt": "hi", "accessToken": token})
    assert resolved == token, "accessToken payload field must resolve to the exact JWT"

    _CAPTURED_BEARER_KWARGS.clear()
    _CAPTURED_SIGV4_KWARGS.clear()
    client = agent_runtime.build_mcp_client_for_token(resolved)
    transport = client.transport_factory()

    assert transport[0] == _BEARER_TAG
    assert not _CAPTURED_SIGV4_KWARGS
    assert _CAPTURED_BEARER_KWARGS[-1]["token"] == token


@settings(max_examples=100, deadline=None)
@given(token=_raw_token_strategy)
def test_real_bearer_transport_forwards_jwt_unmodified(token):
    """The REAL ``streamable_http_bearer`` transport attaches the JWT as
    ``Authorization: Bearer <token>`` with no trimming/substitution/mutation.

    EXPECTED on UNFIXED code: PASSES (baseline to preserve, 3.5).

    **Validates: Requirements 3.5**
    """
    captured = _run_real_bearer_transport("https://gw.example/mcp", token)
    headers = captured["headers"]
    assert headers is not None and "Authorization" in headers, (
        "Bearer transport did not set an Authorization header"
    )
    assert headers["Authorization"] == f"Bearer {token}", (
        f"Bearer header {headers['Authorization']!r} did not forward the token unmodified"
    )
    # The token substring is present verbatim (byte-for-byte forwarding).
    assert token in headers["Authorization"]


# ===========================================================================
# 3.6 — Valid, non-expired credentials: SigV4 fallback signs well-formed headers
# ===========================================================================

_CREDENTIAL_SCOPE_RE = re.compile(
    r"AWS4-HMAC-SHA256\s+Credential=([^/,\s]+)/([^,\s]+),\s*SignedHeaders=([^,\s]+),\s*Signature=([0-9a-f]+)"
)


def _sign_through_real_signer(credentials):
    """Sign a representative Gateway request through the REAL SigV4 signer with
    the given (valid) credentials and return the signed ``httpx.Request``."""
    auth = RealSigV4HTTPXAuth(credentials, "bedrock-agentcore", "us-east-1")
    request = httpx.Request(
        "POST",
        "https://gw.example/mcp",
        content=b"{}",
        headers={"content-type": "application/json"},
    )
    return next(auth.auth_flow(request))


def _assert_wellformed_sigv4(signed, expected_access_key, expected_token):
    """Assert the signed request carries well-formed SigV4 headers that would
    reach the Gateway."""
    authorization = signed.headers.get("Authorization")
    assert authorization, "no Authorization header was produced"
    match = _CREDENTIAL_SCOPE_RE.search(authorization)
    assert match, f"Authorization header is not well-formed SigV4: {authorization!r}"

    access_key_in_scope, credential_scope, signed_headers, signature = match.groups()
    assert access_key_in_scope == expected_access_key, (
        f"Credential scope access key {access_key_in_scope!r} != supplied key {expected_access_key!r}"
    )
    # Credential scope ends with the canonical SigV4 suffix.
    assert credential_scope.endswith("bedrock-agentcore/aws4_request"), (
        f"unexpected credential scope {credential_scope!r}"
    )
    assert "host" in signed_headers, f"SignedHeaders missing host: {signed_headers!r}"
    assert len(signature) == 64, f"SigV4 signature is not a 64-hex digest: {signature!r}"

    # A timestamp header is present (X-Amz-Date), required for a valid signature.
    assert signed.headers.get("x-amz-date"), "missing X-Amz-Date header"

    # A session token yields the X-Amz-Security-Token header, forwarded verbatim.
    assert signed.headers.get("x-amz-security-token") == expected_token, (
        "X-Amz-Security-Token did not carry the supplied session token"
    )


@settings(max_examples=100, deadline=None)
@given(access_key=_ak_strategy, secret_key=_sk_strategy, token=_tok_strategy)
def test_sigv4_signs_wellformed_headers_with_valid_credentials(access_key, secret_key, token):
    """For any valid, non-expired credentials, the real SigV4 signer produces
    well-formed signed headers (SigV4 Authorization + X-Amz-Date +
    X-Amz-Security-Token) that would reach the Gateway.

    EXPECTED on UNFIXED code: PASSES (baseline to preserve, 3.6).

    **Validates: Requirements 3.6**
    """
    creds = ReadOnlyCredentials(access_key, secret_key, token)
    signed = _sign_through_real_signer(creds)
    _assert_wellformed_sigv4(signed, expected_access_key=access_key, expected_token=token)


def test_tokenless_request_selects_sigv4_and_signs_wellformed():
    """A token-less request selects the SigV4 fallback, and the credentials the
    runtime supplies (valid, non-expired) sign well-formed headers that would
    reach the Gateway.

    EXPECTED on UNFIXED code: PASSES (baseline to preserve, 3.6).

    **Validates: Requirements 3.6**
    """
    _FakeWorkloadContext.workload_token = None
    _CAPTURED_SIGV4_KWARGS.clear()
    _CAPTURED_BEARER_KWARGS.clear()

    client = agent_runtime.build_mcp_client_for_token(None)
    transport = client.transport_factory()

    assert transport[0] == _SIGV4_TAG, (
        f"token-less request selected {transport[0]!r}, expected the SigV4 fallback"
    )
    assert not _CAPTURED_BEARER_KWARGS, "Bearer transport must not be used for a token-less request"
    assert _CAPTURED_SIGV4_KWARGS, "SigV4 transport was not invoked"

    supplied = _CAPTURED_SIGV4_KWARGS[-1]
    assert supplied["service"] == "bedrock-agentcore"
    assert supplied["region"] == "us-east-1"

    # Sign with the credentials the runtime supplied (valid/non-expired here),
    # through the REAL signer, and confirm the headers are well-formed.
    frozen = supplied["credentials"].get_frozen_credentials()
    signed = _sign_through_real_signer(supplied["credentials"])
    _assert_wellformed_sigv4(
        signed, expected_access_key=frozen.access_key, expected_token=frozen.token
    )
