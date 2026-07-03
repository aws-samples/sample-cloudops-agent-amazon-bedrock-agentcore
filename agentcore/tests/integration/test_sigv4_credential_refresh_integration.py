# Feature: agentcore-security-review-fixes, BUG 5 — integration coverage for the
# SigV4 fallback path signing a Gateway request with REFRESHED credentials after
# a simulated token expiry within a long-lived process.
# Validates: Requirements 2.5, 3.5, 3.6
"""Integration test (Task 8, BUG 5): SigV4 fallback refresh in a long-lived process.

WHAT THIS VERIFIES
------------------
The token-less SigV4 fallback hop (``streamable_http_sigv4.py``, wired by
``agent_runtime.build_mcp_client_for_token(None)``) signs Gateway requests with
botocore's live, self-refreshing credentials — so that in a LONG-LIVED runtime
container, when the session token snapshotted earlier EXPIRES, the next signed
request uses the REFRESHED credential values rather than a stale snapshot. This
is the BUG 5 fix: the frozen import-time ``Credentials`` snapshot was replaced by
``session.get_credentials()`` (a botocore ``RefreshableCredentials`` under an
assumed/container role), which re-derives values at sign time.

Unlike the unit tests (which check the signer surface in isolation), this test
models the END-TO-END temporal scenario of a long-lived process spanning
MULTIPLE credential-refresh cycles, and drives it through the REAL transport
factory ``streamablehttp_client_with_sigv4`` (the exact seam the runtime uses),
asserting the produced SigV4 signature reflects the latest refreshed credentials
at each cycle.

DETERMINISTIC BY DESIGN (no live AWS required)
----------------------------------------------
The credential-refresh-at-sign-time behavior is exercised deterministically
using a real botocore ``RefreshableCredentials`` whose refresh hook returns
controllable rotating values (the same mechanism as the Task 7 unit tests). No
AWS calls or network I/O occur: the one place that would open a connection
(``streamablehttp_client`` inside ``streamablehttp_client_with_sigv4``) is
replaced with a fake async context manager, so only the signer wiring is
exercised. These tests therefore PASS without any live infrastructure.

A separate, OPT-IN test (``test_live_sigv4_signs_with_real_refreshable_credentials``)
covers the genuinely live part — obtaining REAL refreshable credentials from the
default AWS credential chain and signing a request to the configured live
Gateway endpoint — and is SKIP-GATED behind ``INTEGRATION_TEST_ENABLED`` plus
resolvable AWS credentials, mirroring the other integration modules so the suite
stays green in CI without live infra.

------------------------------------------------------------------------------
Environment variables (only the live opt-in test consults these; the
deterministic tests always run)
------------------------------------------------------------------------------
  INTEGRATION_TEST_ENABLED
      Master switch for the live opt-in test. Must be truthy ("1"/"true"/
      "yes"/"on"). When unset/false the live test is skipped (the deterministic
      tests still run and pass).

  GATEWAY_ENDPOINT_URL  (or GATEWAY_URL)
      The live Gateway MCP endpoint URL to sign a request against. When absent,
      the live test is skipped.

  AWS_REGION / AWS_DEFAULT_REGION
      Region for signing (default "us-east-1").

Validates: Requirements 2.5, 3.5, 3.6
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from botocore.credentials import RefreshableCredentials

# Make the ``agentcore`` package importable whether pytest runs from the repo
# root or from the ``agentcore`` directory (this file lives two levels below
# ``agentcore`` at agentcore/tests/integration/).
_AGENTCORE_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
if _AGENTCORE_ROOT not in sys.path:
    sys.path.insert(0, _AGENTCORE_ROOT)

# ``streamable_http_sigv4`` imports only httpx / botocore / mcp — no AWS side
# effects — so it is safe to import REAL here (unlike ``agent_runtime`` whose
# module load has AWS-dependent side effects).
import streamable_http_sigv4  # noqa: E402
from streamable_http_sigv4 import (  # noqa: E402
    SigV4HTTPXAuth,
    streamablehttp_client_with_sigv4,
)


# ---------------------------------------------------------------------------
# Constants / helpers
# ---------------------------------------------------------------------------

_REGION = "us-east-1"
_SERVICE = "bedrock-agentcore"
_TEST_GATEWAY_URL = "https://gw.example/mcp"
_CREDENTIAL_SCOPE_RE = re.compile(r"Credential=([^/,\s]+)/")
_TRUTHY = {"1", "true", "yes", "on"}


def _truthy(value) -> bool:
    return str(value or "").strip().lower() in _TRUTHY


def _region() -> str:
    return (
        os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or _REGION
    )


def _access_key_in_scope(authorization_header: str) -> str:
    match = _CREDENTIAL_SCOPE_RE.search(authorization_header)
    assert match, f"could not parse Credential scope from {authorization_header!r}"
    return match.group(1)


def _sign_once(auth: SigV4HTTPXAuth, *, url=_TEST_GATEWAY_URL, body=b"{}"):
    """Sign one request through the REAL ``auth.auth_flow`` generator."""
    request = httpx.Request(
        "POST",
        url,
        content=body,
        headers={"content-type": "application/json"},
    )
    return next(auth.auth_flow(request))


# The module is marked ``integration`` so it participates in the same suite
# grouping as the other integration modules (deselectable with
# ``-m "not integration"``). The deterministic tests below need no live infra
# and PASS unconditionally; only the explicitly skip-gated live test consults
# the environment.
pytestmark = [pytest.mark.integration]


# ===========================================================================
# Long-lived-process refresh — driven through the REAL SigV4 transport factory
# ===========================================================================

class _LongLivedRefreshSource:
    """Controllable refresh source modeling a long-lived container's credentials.

    Each call to :meth:`metadata` returns the CURRENT live credential values
    with a FUTURE expiry (so botocore accepts the refreshed set). :meth:`rotate`
    simulates the STS/container role handing out a freshly-rotated credential
    set later in the process's life; a subsequent :func:`_force_expire` marks the
    held credentials as aged-out so the next sign performs a mandatory refresh
    and re-reads these rotated values via the ``refresh_using`` hook.
    """

    def __init__(self, access_key, secret_key, token):
        self._ak = access_key
        self._sk = secret_key
        self._tok = token
        self.refresh_calls = 0

    def rotate(self, access_key, secret_key, token):
        self._ak = access_key
        self._sk = secret_key
        self._tok = token

    def metadata(self):
        self.refresh_calls += 1
        return {
            "access_key": self._ak,
            "secret_key": self._sk,
            "token": self._tok,
            "expiry_time": (
                datetime.now(timezone.utc) + timedelta(hours=1)
            ).isoformat(),
        }


def _build_refreshable(source: _LongLivedRefreshSource) -> RefreshableCredentials:
    """Create a real botocore ``RefreshableCredentials`` bound to ``source``.

    Starts valid (future expiry); a long-lived process later ages the token out,
    modeled by :func:`_force_expire`, at which point the next sign triggers a
    mandatory refresh that re-reads the source's current (rotated) values.
    """
    return RefreshableCredentials.create_from_metadata(
        metadata=source.metadata(),
        refresh_using=source.metadata,
        method="sts-assume-role",
    )


def _force_expire(creds: RefreshableCredentials) -> None:
    """Age the held credentials out, simulating the session token expiring later
    in a long-lived process. Sets botocore's documented ``_expiry_time`` field to
    the past so ``refresh_needed()`` returns True and the next signing pass
    performs a mandatory refresh via the ``refresh_using`` hook."""
    creds._expiry_time = datetime.now(timezone.utc) - timedelta(minutes=5)


def _capture_auth_from_transport(credentials) -> SigV4HTTPXAuth:
    """Drive the REAL ``streamablehttp_client_with_sigv4`` factory (the exact
    seam ``agent_runtime`` uses for the SigV4 fallback) with the network hop
    faked out, and return the ``SigV4HTTPXAuth`` it wired in."""
    captured: dict = {}

    @asynccontextmanager
    async def _fake_streamablehttp_client(url, auth=None, timeout=None):
        captured["url"] = url
        captured["auth"] = auth
        yield ("read_stream", "write_stream", "get_session_id")

    original = streamable_http_sigv4.streamablehttp_client
    streamable_http_sigv4.streamablehttp_client = _fake_streamablehttp_client
    try:
        async def _run():
            async with streamablehttp_client_with_sigv4(
                url=_TEST_GATEWAY_URL,
                credentials=credentials,
                service=_SERVICE,
                region=_region(),
            ) as client:
                return client

        client = asyncio.run(_run())
    finally:
        streamable_http_sigv4.streamablehttp_client = original

    assert client == ("read_stream", "write_stream", "get_session_id")
    auth = captured["auth"]
    assert isinstance(auth, SigV4HTTPXAuth)
    assert auth.credentials is credentials
    assert captured["url"] == _TEST_GATEWAY_URL
    return auth


def test_sigv4_fallback_refreshes_across_long_lived_process_cycles():
    """Model a long-lived process across MULTIPLE token-expiry/refresh cycles.

    The same refreshable credentials object (as returned by
    ``session.get_credentials()``) is wired into the REAL SigV4 transport factory
    once — as it would be per request in the runtime — and signs across three
    lifecycle phases. Between phases the underlying STS/container credentials
    ROTATE (simulating the prior token expiring and a new one being issued). At
    each phase the produced SigV4 signature MUST reflect the CURRENT refreshed
    values, never a stale earlier snapshot.

    Validates: Requirements 2.5, 3.6
    """
    source = _LongLivedRefreshSource(
        "AKIAPHASE1AAAA", "phase1secret000000000000", "phase1token"  # nosec B105 - fake
    )
    creds = _build_refreshable(source)
    auth = _capture_auth_from_transport(creds)
    refreshes_after_build = source.refresh_calls

    # Phase 1 — the process's current (valid) credentials sign with phase-1 values.
    signed_1 = _sign_once(auth, body=b'{"phase":1}')
    assert _access_key_in_scope(signed_1.headers["Authorization"]) == "AKIAPHASE1AAAA"
    assert signed_1.headers.get("x-amz-security-token") == "phase1token"

    # Phase 2 — later in the process the token expires and STS issues new creds.
    source.rotate("AKIAPHASE2BBBB", "phase2secret000000000000", "phase2token")  # nosec B105 - fake
    _force_expire(creds)
    signed_2 = _sign_once(auth, body=b'{"phase":2}')
    assert _access_key_in_scope(signed_2.headers["Authorization"]) == "AKIAPHASE2BBBB"
    assert signed_2.headers.get("x-amz-security-token") == "phase2token"

    # Phase 3 — another expiry/refresh cycle; signing still tracks the live values.
    source.rotate("AKIAPHASE3CCCC", "phase3secret000000000000", "phase3token")  # nosec B105 - fake
    _force_expire(creds)
    signed_3 = _sign_once(auth, body=b'{"phase":3}')
    assert _access_key_in_scope(signed_3.headers["Authorization"]) == "AKIAPHASE3CCCC"
    assert signed_3.headers.get("x-amz-security-token") == "phase3token"

    # The signer never reused the earlier (now-expired) snapshot for a later sign.
    assert _access_key_in_scope(signed_1.headers["Authorization"]) != "AKIAPHASE3CCCC"
    assert _access_key_in_scope(signed_3.headers["Authorization"]) != "AKIAPHASE1AAAA"
    # And botocore actually performed refreshes on the expiry cycles (proving
    # live re-derivation at sign time, not a one-time frozen snapshot).
    assert source.refresh_calls >= refreshes_after_build + 2, (
        "expected the refreshable credentials to refresh on each expired sign "
        f"cycle; observed {source.refresh_calls - refreshes_after_build} refreshes "
        "after build"
    )


def test_sigv4_fallback_signs_with_refreshed_values_after_expiry():
    """A simulated token expiry within the long-lived process is transparently
    refreshed before signing, so the request reaches the Gateway with
    NON-EXPIRED credentials (the BUG 5 expected behavior).

    A ``RefreshableCredentials`` initialized with an EXPIRED snapshot and a
    refresh hook that yields fresh, valid values is wired through the real
    transport factory; the produced signature reflects the FRESH values, never
    the expired snapshot.

    Validates: Requirements 2.5
    """
    expired_time = datetime.now(timezone.utc) - timedelta(minutes=5)
    fresh = {
        "access_key": "AKIAREFRESHEDOK",
        "secret_key": "refreshedsecret000000000",  # nosec B105 - fake test credential
        "token": "refreshedtoken",  # nosec B105 - fake test credential
        "expiry_time": (
            datetime.now(timezone.utc) + timedelta(hours=1)
        ).isoformat(),
    }

    def _refresh():
        return fresh

    creds = RefreshableCredentials(
        access_key="AKIAEXPIREDSNAP",
        secret_key="expiredsecret000000000",  # nosec B105 - fake test credential
        token="expiredtoken",  # nosec B105 - fake test credential
        expiry_time=expired_time,
        refresh_using=_refresh,
        method="sts-assume-role",
    )

    auth = _capture_auth_from_transport(creds)
    signed = _sign_once(auth)

    assert _access_key_in_scope(signed.headers["Authorization"]) == "AKIAREFRESHEDOK", (
        "SigV4 fallback signed with the expired snapshot access key instead of "
        "the refreshed value in a long-lived process"
    )
    assert signed.headers.get("x-amz-security-token") == "refreshedtoken"


def test_sigv4_fallback_valid_credentials_sign_without_refresh():
    """Preservation (3.6): with valid, non-expired credentials the SigV4 fallback
    signs and produces well-formed headers WITHOUT triggering a refresh — the
    valid-credentials happy path is unchanged by the BUG 5 fix.

    Validates: Requirements 3.6
    """
    valid_time = datetime.now(timezone.utc) + timedelta(hours=1)

    def _refresh():  # pragma: no cover - must NOT run for non-expired creds
        raise AssertionError("refresh should not run for non-expired credentials")

    creds = RefreshableCredentials(
        access_key="AKIAVALIDNOWXX",
        secret_key="validsecret0000000000000",  # nosec B105 - fake test credential
        token="validtoken",  # nosec B105 - fake test credential
        expiry_time=valid_time,
        refresh_using=_refresh,
        method="sts-assume-role",
    )

    auth = _capture_auth_from_transport(creds)
    signed = _sign_once(auth)

    authorization = signed.headers["Authorization"]
    assert authorization.startswith("AWS4-HMAC-SHA256"), (
        "expected a well-formed SigV4 Authorization header"
    )
    assert _access_key_in_scope(authorization) == "AKIAVALIDNOWXX"
    assert signed.headers.get("x-amz-security-token") == "validtoken"


# ===========================================================================
# Genuinely-live opt-in test (skip-gated) — real refreshable credentials
# ===========================================================================

def _live_missing_requirements() -> list[str]:
    """Unmet preconditions for the live opt-in test; empty means ready to run."""
    missing: list[str] = []
    if not _truthy(os.environ.get("INTEGRATION_TEST_ENABLED")):
        missing.append("INTEGRATION_TEST_ENABLED (set to 1/true to enable)")
    if not (os.environ.get("GATEWAY_ENDPOINT_URL") or os.environ.get("GATEWAY_URL")):
        missing.append("GATEWAY_ENDPOINT_URL (live Gateway MCP endpoint to sign against)")
    return missing


_LIVE_MISSING = _live_missing_requirements()


@pytest.mark.skipif(
    bool(_LIVE_MISSING),
    reason=(
        "Live SigV4 refreshable-credential signing test; missing required "
        "configuration: " + ", ".join(_LIVE_MISSING)
    ),
)
def test_live_sigv4_signs_with_real_refreshable_credentials():
    """Live: sign a request to the configured Gateway endpoint using the REAL
    refreshable credentials from the default AWS credential chain (as the
    runtime does via ``session.get_credentials()``), and assert a well-formed
    SigV4 signature keyed to the live credentials' current values is produced.

    This exercises the genuinely-live seam (real credential resolution + the real
    signer against the real endpoint URL) WITHOUT sending traffic, and is
    skip-gated so CI without live infra stays green.

    Validates: Requirements 2.5, 3.5, 3.6
    """
    import boto3  # imported lazily so collection never requires a live session

    endpoint = os.environ.get("GATEWAY_ENDPOINT_URL") or os.environ.get("GATEWAY_URL")
    try:
        session = boto3.Session()
        credentials = session.get_credentials()
    except Exception as exc:  # pragma: no cover - depends on live environment
        pytest.skip(f"could not resolve AWS credentials from the default chain: {exc}")

    if credentials is None:
        pytest.skip("no AWS credentials resolvable from the default chain")

    # The runtime passes this live (refreshable under an assumed/container role)
    # object straight into the signer — no frozen snapshot.
    auth = _capture_auth_from_transport(credentials)
    signed = _sign_once(auth, url=endpoint)

    authorization = signed.headers.get("Authorization", "")
    assert authorization.startswith("AWS4-HMAC-SHA256"), (
        "expected a well-formed SigV4 Authorization header from live credentials"
    )
    # The signed scope must match the credentials' CURRENT (possibly just
    # refreshed) access key — i.e. signing re-derived live values at sign time.
    frozen = credentials.get_frozen_credentials()
    assert _access_key_in_scope(authorization) == frozen.access_key
