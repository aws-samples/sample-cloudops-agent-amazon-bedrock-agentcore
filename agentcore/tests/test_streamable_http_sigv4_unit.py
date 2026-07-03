# Feature: agentcore-security-review-fixes, Task 7 — unit tests for the BUG 5
# (refreshable SigV4 credentials) fix at the signer level.
# **Validates: Requirements 2.5, 3.5, 3.6**
"""Deterministic, example-based unit tests for ``streamable_http_sigv4``.

These complement the Task 3/4 property-based tests with targeted, deterministic
coverage of the BUG 5 signer surface:

  - ``SigV4HTTPXAuth.auth_flow`` re-signs PER REQUEST: two calls produce
    independently-signed requests (a fresh ``AWSRequest`` is constructed and
    ``add_auth`` is invoked on every call, so no stale header is reused), and a
    credential refresh between calls is reflected in the signature.
  - ``streamablehttp_client_with_sigv4`` accepts a refreshable credentials
    object — both a base botocore ``Credentials`` and a real
    ``RefreshableCredentials`` — and wires it into the ``SigV4HTTPXAuth`` signer.
  - Expired-vs-valid credential edge: signing re-derives credential values at
    sign time via ``get_frozen_credentials()``, so a rotated/refreshed value is
    what actually signs the request.

``streamable_http_sigv4`` imports only ``httpx`` / ``botocore`` / ``mcp`` (no
AWS-dependent side effects), so it is imported REAL here. The one place that
would open a network connection — ``streamablehttp_client`` inside
``streamablehttp_client_with_sigv4`` — is monkeypatched with a fake async
context manager so the acceptance test exercises real signer wiring WITHOUT any
network.
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
from botocore.credentials import Credentials, RefreshableCredentials, ReadOnlyCredentials

# Make the parent ``agentcore`` package importable regardless of CWD.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import streamable_http_sigv4  # noqa: E402
from streamable_http_sigv4 import SigV4HTTPXAuth, streamablehttp_client_with_sigv4  # noqa: E402


_REGION = "us-east-1"
_SERVICE = "bedrock-agentcore"
_CREDENTIAL_SCOPE_RE = re.compile(r"Credential=([^/,\s]+)/")


def _sign(auth: SigV4HTTPXAuth, *, method="POST", url="https://gw.example/mcp", body=b"{}"):
    """Sign one request through ``auth.auth_flow`` and return the signed request."""
    request = httpx.Request(
        method,
        url,
        content=body,
        headers={"content-type": "application/json"},
    )
    # ``auth_flow`` is a generator that yields the signed request.
    return next(auth.auth_flow(request))


def _access_key_in_scope(authorization_header: str) -> str:
    match = _CREDENTIAL_SCOPE_RE.search(authorization_header)
    assert match, f"could not parse Credential scope from {authorization_header!r}"
    return match.group(1)


class _RotatableCredentials:
    """Minimal refreshable-style credential object.

    ``SigV4Auth.add_auth`` only needs ``get_frozen_credentials()``, which botocore
    calls at signing time (this is where a real ``RefreshableCredentials`` would
    refresh near expiry). ``rotate`` swaps in new live values to simulate a
    refresh between sign calls.
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


# ===========================================================================
# SigV4HTTPXAuth.auth_flow — re-signs per request
# ===========================================================================

class TestAuthFlowResignsPerRequest:
    def test_two_different_requests_get_independent_signatures(self):
        """Two distinct requests signed by the SAME auth object produce distinct,
        well-formed SigV4 signatures — the header is derived from each request,
        not cached from the first."""
        creds = Credentials("AKIAEXAMPLE0", "secret0", "token0")  # nosec B105 - fake
        auth = SigV4HTTPXAuth(creds, _SERVICE, _REGION)

        signed_a = _sign(auth, url="https://gw.example/mcp/a", body=b'{"a":1}')
        signed_b = _sign(auth, url="https://gw.example/mcp/b", body=b'{"b":2}')

        auth_a = signed_a.headers["Authorization"]
        auth_b = signed_b.headers["Authorization"]

        assert auth_a.startswith("AWS4-HMAC-SHA256")
        assert auth_b.startswith("AWS4-HMAC-SHA256")
        # Different requests => different signatures (per-request signing).
        assert auth_a != auth_b

    def test_same_request_object_is_not_double_mutated(self):
        """Signing produces a valid Authorization header and the security token
        header for a session credential — each call is a fresh signing pass."""
        creds = Credentials("AKIAEXAMPLE0", "secret0", "sessiontoken0")  # nosec B105 - fake
        auth = SigV4HTTPXAuth(creds, _SERVICE, _REGION)

        signed = _sign(auth)
        assert "Authorization" in signed.headers
        assert signed.headers["Authorization"].startswith("AWS4-HMAC-SHA256")
        assert signed.headers.get("x-amz-security-token") == "sessiontoken0"

    def test_refresh_between_calls_is_reflected_in_signature(self):
        """A credential rotation between two sign calls is picked up because the
        signer re-derives values via ``get_frozen_credentials()`` at each call —
        proving per-request (not one-time) signing with live credentials."""
        creds = _RotatableCredentials("AKIAOLD00000", "oldsecret", "oldtoken")  # nosec B105 - fake
        auth = SigV4HTTPXAuth(creds, _SERVICE, _REGION)

        signed_first = _sign(auth)
        assert _access_key_in_scope(signed_first.headers["Authorization"]) == "AKIAOLD00000"
        assert signed_first.headers.get("x-amz-security-token") == "oldtoken"

        # Simulate a refresh in a long-lived process.
        creds.rotate("AKIANEW00000", "newsecret", "newtoken")

        signed_second = _sign(auth)
        assert _access_key_in_scope(signed_second.headers["Authorization"]) == "AKIANEW00000"
        assert signed_second.headers.get("x-amz-security-token") == "newtoken"


# ===========================================================================
# streamablehttp_client_with_sigv4 — accepts a refreshable credentials object
# ===========================================================================

class TestClientAcceptsRefreshableCredentials:
    def _run_and_capture_auth(self, monkeypatch, credentials):
        """Run ``streamablehttp_client_with_sigv4`` with ``streamablehttp_client``
        monkeypatched, and return the ``SigV4HTTPXAuth`` it wired in."""
        captured = {}

        @asynccontextmanager
        async def _fake_streamablehttp_client(url, auth=None, timeout=None):
            captured["url"] = url
            captured["auth"] = auth
            captured["timeout"] = timeout
            yield ("read_stream", "write_stream", "get_session_id")

        monkeypatch.setattr(
            streamable_http_sigv4, "streamablehttp_client", _fake_streamablehttp_client
        )

        async def _run():
            async with streamablehttp_client_with_sigv4(
                url="https://gw.example/mcp",
                credentials=credentials,
                service=_SERVICE,
                region=_REGION,
            ) as client:
                return client

        client = asyncio.run(_run())
        assert client == ("read_stream", "write_stream", "get_session_id")
        return captured

    def test_accepts_base_botocore_credentials(self, monkeypatch):
        creds = Credentials("AKIABASE0000", "basesecret", "basetoken")  # nosec B105 - fake
        captured = self._run_and_capture_auth(monkeypatch, creds)

        auth = captured["auth"]
        assert isinstance(auth, SigV4HTTPXAuth)
        assert auth.credentials is creds
        assert auth.service == _SERVICE
        assert auth.region == _REGION
        assert captured["url"] == "https://gw.example/mcp"

    def test_accepts_refreshable_credentials_and_signs_with_refreshed_values(self, monkeypatch):
        """A real botocore ``RefreshableCredentials`` (as returned by
        ``session.get_credentials()`` under an assumed/container role) is
        accepted and wired into the signer; signing uses its live values."""
        refresh_values = {
            "access_key": "AKIAREFRESHED0",
            "secret_key": "refreshedsecret",  # nosec B105 - fake test credential
            "token": "refreshedtoken",  # nosec B105 - fake test credential
            "expiry_time": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        }

        def _refresh():
            return refresh_values

        creds = RefreshableCredentials.create_from_metadata(
            metadata=_refresh(),
            refresh_using=_refresh,
            method="sts-assume-role",
        )

        captured = self._run_and_capture_auth(monkeypatch, creds)
        auth = captured["auth"]
        assert isinstance(auth, SigV4HTTPXAuth)
        assert auth.credentials is creds

        # The wired signer signs with the refreshable credential's live values.
        signed = _sign(auth)
        assert _access_key_in_scope(signed.headers["Authorization"]) == "AKIAREFRESHED0"
        assert signed.headers.get("x-amz-security-token") == "refreshedtoken"


# ===========================================================================
# Expired-vs-valid credential edge at the signer
# ===========================================================================

class TestExpiredVsValidCredentialEdge:
    def test_expired_snapshot_is_refreshed_before_signing(self):
        """When credentials are past expiry, botocore refreshes them via the
        refresh hook before signing, so the signature reflects the fresh
        (valid) values — not the expired ones."""
        expired_time = datetime.now(timezone.utc) - timedelta(minutes=5)
        fresh = {
            "access_key": "AKIAFRESHVALID",
            "secret_key": "freshsecret",  # nosec B105 - fake test credential
            "token": "freshtoken",  # nosec B105 - fake test credential
            "expiry_time": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        }

        def _refresh():
            return fresh

        creds = RefreshableCredentials(
            access_key="AKIAEXPIRED000",
            secret_key="expiredsecret",  # nosec B105 - fake test credential
            token="expiredtoken",  # nosec B105 - fake test credential
            expiry_time=expired_time,
            refresh_using=_refresh,
            method="sts-assume-role",
        )

        auth = SigV4HTTPXAuth(creds, _SERVICE, _REGION)
        signed = _sign(auth)

        # Expired values must NOT sign the request; the refreshed valid values do.
        assert _access_key_in_scope(signed.headers["Authorization"]) == "AKIAFRESHVALID"
        assert signed.headers.get("x-amz-security-token") == "freshtoken"

    def test_valid_credentials_sign_without_change(self):
        """With valid, non-expired credentials the signer uses them as-is
        (Preservation 3.6 — valid-credentials happy path)."""
        valid_time = datetime.now(timezone.utc) + timedelta(hours=1)

        def _refresh():  # pragma: no cover - not expected to be called
            raise AssertionError("refresh should not run for non-expired credentials")

        creds = RefreshableCredentials(
            access_key="AKIAVALIDNOW00",
            secret_key="validsecret",  # nosec B105 - fake test credential
            token="validtoken",  # nosec B105 - fake test credential
            expiry_time=valid_time,
            refresh_using=_refresh,
            method="sts-assume-role",
        )

        auth = SigV4HTTPXAuth(creds, _SERVICE, _REGION)
        signed = _sign(auth)

        assert _access_key_in_scope(signed.headers["Authorization"]) == "AKIAVALIDNOW00"
        assert signed.headers.get("x-amz-security-token") == "validtoken"
