# Feature: agentcore-security-review-fixes, BUG 5, Property 3: Bug Condition
# SigV4 fallback uses refreshable credentials
# **Validates: Requirements 1.5, 2.5**
"""
BUG 5 — Bug-condition EXPLORATION property test (frozen SigV4 credentials).

This test is written BEFORE the fix and is EXPECTED TO FAIL on the current
(unfixed) code. Its failure confirms the bug described in ``bugfix.md``
(1.5 / 2.5) and ``design.md`` (BUG 5 ``isBugCondition`` / ``expectedBehavior``):

    At import ``agent_runtime.py`` builds
    ``frozen_credentials = Credentials(access_key, secret_key, token)`` from
    ``session.get_credentials()`` read ONCE. The token-less SigV4 fallback
    (``build_mcp_client_for_token(None)``) passes that static snapshot into
    ``streamablehttp_client_with_sigv4``, whose ``SigV4HTTPXAuth`` signs every
    request with the frozen values. When the container is long-lived and those
    credentials rotate/expire, the fallback keeps signing with the stale
    snapshot instead of the live rotated credentials.

The test models credential rotation:

    * A single live/refreshable credential object is returned by the fake
      ``boto3`` session. At import time its values are the "expired snapshot".
    * AFTER import (simulating time passing in a long-lived container) the live
      credential ROTATES — ``get_frozen_credentials()`` and the ``access_key`` /
      ``secret_key`` / ``token`` accessors now return fresh (live) values.

It then drives the exact seam the design calls out — how ``agent_runtime``
SUPPLIES credentials to the SigV4 branch, fed through the REAL signer
(``streamable_http_sigv4.SigV4HTTPXAuth`` used by
``streamablehttp_client_with_sigv4``) — and asserts the EXPECTED (post-fix)
behavior:

    * the signed ``Authorization`` header's ``Credential=<access_key>`` scope
      equals the ROTATED live access key, and
    * the signed ``X-Amz-Security-Token`` header equals the ROTATED live token,

i.e. signing reflects the rotated LIVE values, NOT the expired import-time
snapshot.

Scoped property: random rotated (access_key, secret_key, token) triples that
DIFFER from the fixed import-time snapshot.

EXPECTED OUTCOME ON UNFIXED CODE: FAIL — the SigV4 branch signs with the frozen
import-time snapshot (``Credential=AKIASNAPSHOTEXPIRED...`` and the snapshot
security token) rather than the rotated live credentials.

Import approach mirrors ``test_agent_runtime.py`` /
``test_agent_runtime_property1_memory_actor_isolation.py``: lightweight fakes
are installed in ``sys.modules`` BEFORE importing ``agent_runtime`` (whose
module load has AWS-dependent side effects). The fake ``boto3`` session yields a
single, rotatable credential object so we can simulate rotation after import.
Crucially the SigV4 signer under test is the REAL
``streamable_http_sigv4.SigV4HTTPXAuth`` (captured before stubbing), so the
assertion exercises genuine botocore signing WITHOUT any AWS calls or network.
"""

from __future__ import annotations

import importlib
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

# Import the REAL SigV4 signer BEFORE any sys.modules stubbing so we hold a
# genuine reference to the class under test. ``agent_runtime`` will later import
# a FAKE ``streamable_http_sigv4`` module (installed in sys.modules) purely to
# capture the credentials object it supplies; the real signing is done here with
# this real class, so the whole signer path is exercised authentically.
import streamable_http_sigv4 as _real_sigv4_module  # noqa: E402

RealSigV4HTTPXAuth = _real_sigv4_module.SigV4HTTPXAuth


# ===========================================================================
# Fixed import-time snapshot ("expired") credential material
# ===========================================================================

_SNAPSHOT_ACCESS_KEY = "EXAMPLEKEYSNAPSHOT01"  # nosec B105 - fake, non-AWS-format test value
_SNAPSHOT_SECRET_KEY = "exampleSecretSnapshotExpiredValue"  # nosec B105 - fake
_SNAPSHOT_TOKEN = "snapshotSessionTokenEXPIRED"  # nosec B105 - fake test credential

_TEST_GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gw-test-1234"


class _FakeRefreshableCredentials:
    """Rotatable stand-in for botocore ``RefreshableCredentials``.

    Models the live credential object returned by ``session.get_credentials()``.
    ``access_key`` / ``secret_key`` / ``token`` and ``get_frozen_credentials()``
    all return the CURRENT (possibly rotated) values, mirroring how botocore
    re-derives credentials near expiry. ``rotate`` simulates a refresh that
    swaps in new live values after the container has been running for a while.
    """

    method = "custom-refresh"

    def __init__(self, access_key, secret_key, token):
        self._ak = access_key
        self._sk = secret_key
        self._tok = token

    def rotate(self, access_key, secret_key, token):
        self._ak = access_key
        self._sk = secret_key
        self._tok = token

    @property
    def access_key(self):
        return self._ak

    @property
    def secret_key(self):
        return self._sk

    @property
    def token(self):
        return self._tok

    def get_frozen_credentials(self):
        return ReadOnlyCredentials(self._ak, self._sk, self._tok)


# Shared live credential singleton — the SAME object the fake session hands out
# at import and at request time, so a post-import ``rotate`` is visible to both
# the (buggy) frozen-snapshot path and the (fixed) refreshable path.
_LIVE_CREDS = _FakeRefreshableCredentials(
    _SNAPSHOT_ACCESS_KEY, _SNAPSHOT_SECRET_KEY, _SNAPSHOT_TOKEN
)

# Records the ``credentials`` object ``agent_runtime`` supplies to the SigV4
# transport (populated by the capturing fake below).
_CAPTURED_SIGV4_KWARGS: list = []


# ===========================================================================
# sys.modules fakes so ``agent_runtime`` imports without AWS / heavy deps
# ===========================================================================

def _make_module(name: str) -> types.ModuleType:
    return types.ModuleType(name)


def _capturing_sigv4_transport(*, url=None, credentials=None, service=None, region=None, **kwargs):
    """Fake ``streamablehttp_client_with_sigv4`` — records supplied credentials."""
    _CAPTURED_SIGV4_KWARGS.append(
        {"url": url, "credentials": credentials, "service": service, "region": region}
    )
    return object()  # never used — the client factory return is discarded here


def _fake_bearer_transport(*, url=None, token=None, **kwargs):
    return ("bearer-transport", url, token)


class _FakeMCPClient:
    """Stand-in for ``strands.tools.mcp.MCPClient`` — keeps the transport factory
    so the test can invoke it and capture the credentials the client would use
    WITHOUT opening a connection."""

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


class _FakeSession:
    region_name = "us-east-1"

    def get_credentials(self):
        # Always the SAME live singleton so post-import rotation is observed.
        return _LIVE_CREDS


@contextmanager
def _stubbed_sys_modules():
    """Install fake modules and restore originals on exit."""
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

    # FAKE ``streamable_http_sigv4`` so ``agent_runtime``'s
    # ``from streamable_http_sigv4 import streamablehttp_client_with_sigv4``
    # binds our capturing transport. The REAL signer is held separately in
    # ``RealSigV4HTTPXAuth`` (imported before stubbing).
    sigv4_mod = _make_module("streamable_http_sigv4")
    sigv4_mod.streamablehttp_client_with_sigv4 = _capturing_sigv4_transport
    bearer_mod = _make_module("streamable_http_bearer")
    bearer_mod.streamablehttp_client_with_bearer = _fake_bearer_transport

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
        os.environ.pop("MEMORY_ID", None)  # memory irrelevant to the SigV4 path
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
    """Import ``agent_runtime`` under the stubs and return it. Module-load reads
    the live credentials ONCE (snapshot); the unfixed code freezes them here."""
    with _stubbed_sys_modules():
        sys.modules.pop("agent_runtime", None)
        return importlib.import_module("agent_runtime")


# Import once with the live creds at their SNAPSHOT values — this is the moment
# the unfixed runtime captures ``frozen_credentials``.
_LIVE_CREDS.rotate(_SNAPSHOT_ACCESS_KEY, _SNAPSHOT_SECRET_KEY, _SNAPSHOT_TOKEN)
agent_runtime = _import_agent_runtime()


# ===========================================================================
# Helpers — supply-then-sign through the REAL signer
# ===========================================================================

_CREDENTIAL_SCOPE_RE = re.compile(r"Credential=([^/,\s]+)/")


def _credentials_supplied_by_runtime():
    """Return the credentials object ``agent_runtime`` supplies to the SigV4
    fallback branch (token-less request)."""
    _CAPTURED_SIGV4_KWARGS.clear()
    client = agent_runtime.build_mcp_client_for_token(None)
    # ``build_mcp_client_for_token`` wires ``MCPClient(lambda: sigv4_transport(...))``.
    # Invoke the factory to trigger the (captured) transport call.
    client.transport_factory()
    assert _CAPTURED_SIGV4_KWARGS, (
        "expected build_mcp_client_for_token(None) to build a SigV4 transport; "
        "no credentials were captured"
    )
    return _CAPTURED_SIGV4_KWARGS[-1]["credentials"]


def _sign_and_extract(credentials):
    """Sign a request through the REAL SigV4 signer with the given credentials
    and return ``(access_key_in_scope, security_token_header)``."""
    auth = RealSigV4HTTPXAuth(credentials, "bedrock-agentcore", "us-east-1")
    request = httpx.Request(
        "POST",
        "https://gw.example/mcp",
        content=b"{}",
        headers={"content-type": "application/json"},
    )
    signed = next(auth.auth_flow(request))
    authorization = signed.headers["Authorization"]
    match = _CREDENTIAL_SCOPE_RE.search(authorization)
    assert match, f"could not parse Credential scope from {authorization!r}"
    signed_access_key = match.group(1)
    security_token = signed.headers.get("x-amz-security-token")
    return signed_access_key, security_token


# ===========================================================================
# Credential-material strategy (scope/header-safe, non-empty)
# ===========================================================================

_CRED_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
_ak_strategy = st.text(alphabet=_CRED_ALPHABET, min_size=8, max_size=24)
_sk_strategy = st.text(alphabet=_CRED_ALPHABET, min_size=16, max_size=40)
_tok_strategy = st.text(alphabet=_CRED_ALPHABET, min_size=16, max_size=48)


# ===========================================================================
# Property 3 (Bug Condition): SigV4 fallback signs with ROTATED live creds
# ===========================================================================

@settings(max_examples=75, deadline=None)
@given(
    rotated_ak=_ak_strategy,
    rotated_sk=_sk_strategy,
    rotated_tok=_tok_strategy,
)
def test_sigv4_fallback_signs_with_rotated_live_credentials(rotated_ak, rotated_sk, rotated_tok):
    """After the live credentials rotate (simulating a long-lived container's
    token refresh), the SigV4 fallback MUST sign with the ROTATED live values,
    not the expired import-time snapshot.

    EXPECTED on UNFIXED code: FAILS — the runtime supplies the frozen import-time
    snapshot, so the signed ``Credential=`` access key and ``X-Amz-Security-Token``
    reflect ``AKIASNAPSHOTEXPIRED...`` / the snapshot token rather than the
    rotated live credentials.

    **Validates: Requirements 1.5, 2.5**
    """
    # The rotated credentials must differ from the snapshot, otherwise there is
    # nothing to observe.
    assume(rotated_ak != _SNAPSHOT_ACCESS_KEY)
    assume(rotated_tok != _SNAPSHOT_TOKEN)

    # Simulate the live credential rotating AFTER import (container long-lived).
    _LIVE_CREDS.rotate(rotated_ak, rotated_sk, rotated_tok)
    try:
        supplied = _credentials_supplied_by_runtime()
        signed_access_key, security_token = _sign_and_extract(supplied)
    finally:
        # Restore snapshot state for the next example / isolation.
        _LIVE_CREDS.rotate(_SNAPSHOT_ACCESS_KEY, _SNAPSHOT_SECRET_KEY, _SNAPSHOT_TOKEN)

    assert signed_access_key == rotated_ak, (
        "SigV4 fallback signed with access key "
        f"{signed_access_key!r}; expected the ROTATED live access key "
        f"{rotated_ak!r} (import-time snapshot was {_SNAPSHOT_ACCESS_KEY!r}). "
        "The runtime is signing with the frozen import-time snapshot."
    )
    assert signed_access_key != _SNAPSHOT_ACCESS_KEY, (
        "SigV4 fallback signed with the expired import-time snapshot access key "
        f"{_SNAPSHOT_ACCESS_KEY!r} instead of the rotated live key {rotated_ak!r}."
    )
    assert security_token == rotated_tok, (
        "SigV4 fallback signed with X-Amz-Security-Token "
        f"{security_token!r}; expected the ROTATED live token {rotated_tok!r} "
        f"(import-time snapshot token was {_SNAPSHOT_TOKEN!r})."
    )


# ===========================================================================
# Deterministic companion (single concrete rotation) for a clear counterexample
# ===========================================================================

def test_sigv4_fallback_uses_rotated_credentials_concrete_example():
    """Concrete rotation: snapshot -> ``AKIAROTATEDLIVE1`` / rotated token.

    EXPECTED on UNFIXED code: FAILS — signs with the frozen snapshot access key
    ``EXAMPLEKEYSNAPSHOT01`` and snapshot security token rather than the rotated
    live credentials.

    **Validates: Requirements 1.5, 2.5**
    """
    rotated_ak = "AKIAROTATEDLIVE1"
    rotated_sk = "rotatedLiveSecret0000000000000000"  # nosec B105 - fake test credential
    rotated_tok = "rotatedLiveSessionToken1"  # nosec B105 - fake test credential

    _LIVE_CREDS.rotate(rotated_ak, rotated_sk, rotated_tok)
    try:
        supplied = _credentials_supplied_by_runtime()
        signed_access_key, security_token = _sign_and_extract(supplied)
    finally:
        _LIVE_CREDS.rotate(_SNAPSHOT_ACCESS_KEY, _SNAPSHOT_SECRET_KEY, _SNAPSHOT_TOKEN)

    assert signed_access_key == rotated_ak, (
        f"signed with {signed_access_key!r}; expected rotated live key {rotated_ak!r} "
        f"(frozen snapshot was {_SNAPSHOT_ACCESS_KEY!r})"
    )
    assert security_token == rotated_tok, (
        f"signed with security token {security_token!r}; expected rotated live token "
        f"{rotated_tok!r} (frozen snapshot token was {_SNAPSHOT_TOKEN!r})"
    )
