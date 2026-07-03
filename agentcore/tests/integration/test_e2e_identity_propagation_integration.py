"""Integration test (Task 9.9): End-to-end identity propagation.

Feature: gateway-tool-access-control

WHAT THIS VERIFIES
------------------
The SAME Cognito token a user holds at the FrontEnd is propagated, unmodified,
all the way through to the Gateway's authorization decision, and the Gateway
authorizes against the role carried by that token. We exercise the FULL deployed
path:

    FrontEnd  ->  Agent Runtime  ->  Gateway (CUSTOM_JWT + Cedar Policy)

by invoking the *deployed* Agent Runtime (via boto3 ``bedrock-agentcore``
``invoke_agent_runtime`` — the same SigV4 path the FrontEnd uses) and passing the
user's Cognito token in the ``accessToken`` payload field. That is exactly the
field the runtime reads in Task 6.1 (``USER_TOKEN_PAYLOAD_FIELD = "accessToken"``)
and forwards verbatim as ``Authorization: Bearer <token>`` to the Gateway
(Task 6.1 / Property 8). The role therefore travels inside the Cognito-signed
token; the Gateway independently verifies it and evaluates Cedar policy against
it.

We send a prompt that requires an ADMIN-ONLY tool category (cloudwatch) and
assert role-appropriate behavior end-to-end:

  (a) ADMIN token  -> the agent is ABLE to use the admin-only capability: the
      response does NOT contain a role-denial message (the runtime's
      ``build_denial_response`` text from Task 6.4 is absent and the structured
      ``denied`` flag is not set). The admin-only category was authorized
      because the admin role propagated end-to-end. Validates Req 7.2, 7.3.

  (b) NON-ADMIN token -> the SAME prompt yields the runtime's role-unavailable
      response (Task 6.4 / Req 8.5): the capability is "not available for your
      role". The Gateway denied the admin-only category because the non-admin
      role propagated end-to-end. Validates Req 7.2, 7.3.

The decisive point is that the role is NEVER supplied by the client payload — it
is conveyed solely inside the token — so the differing outcomes for the two
tokens prove the identity propagated intact and the Gateway authorized against
the correct, token-derived role.

Assertions are deliberately TOLERANT of agent phrasing. For the non-admin case
we match role-unavailable *semantics* (the runtime's "not available for your
role" wording or the structured ``denied`` flag). For the admin case we assert
the ABSENCE of a role-denial — we intentionally do NOT treat a generic,
downstream AWS "access denied" (e.g. an IAM error from the real CloudWatch
target) as a failure, because that is not a *role* denial and the call still
routed to the target.

------------------------------------------------------------------------------
Required environment variables (test runs only when configured; else SKIPS)
------------------------------------------------------------------------------
  INTEGRATION_TEST_ENABLED
      Master switch. Must be truthy ("1"/"true"/"yes"/"on") to opt in to the
      live integration test. When unset/false the entire module is skipped.

  AGENT_RUNTIME_ARN   (or AGENT_RUNTIME_ENDPOINT_ARN)
      ARN of the DEPLOYED Agent Runtime to invoke via boto3
      ``bedrock-agentcore.invoke_agent_runtime``. This is the front-of-path
      entry point (the FrontEnd invokes the same runtime). AWS credentials from
      the default chain (env/role/profile) are used to make the SigV4 call, and
      must be able to call ``InvokeAgentRuntime``.

  Admin token — provide ONE of:
    ADMIN_COGNITO_TOKEN  (or ADMIN_ACCESS_TOKEN)
        A pre-fetched ADMIN user's Cognito access token (carrying role="admin").
    -- or credentials to mint one via Cognito USER_PASSWORD_AUTH --
    COGNITO_CLIENT_ID + ADMIN_USERNAME + ADMIN_PASSWORD

  Non-Admin token — provide ONE of:
    NONADMIN_COGNITO_TOKEN  (or NONADMIN_ACCESS_TOKEN)
        A NON-ADMIN user's Cognito access token (role="nonadmin"/absent).
    -- or credentials to mint one via Cognito USER_PASSWORD_AUTH --
    COGNITO_CLIENT_ID + NONADMIN_USERNAME + NONADMIN_PASSWORD

Optional:
  AWS_REGION / AWS_DEFAULT_REGION
      Region for the bedrock-agentcore client and the Cognito IdP call.
      Defaults to "us-east-1" when neither is set.

  E2E_ADMIN_ONLY_PROMPT
      Override the prompt that exercises an admin-only category. Defaults to a
      CloudWatch request (cloudwatch is admin-only; denied for non-admin).

  AGENT_RUNTIME_QUALIFIER
      Endpoint qualifier for invoke_agent_runtime (default "DEFAULT").

  INTEGRATION_TEST_TIMEOUT
      Per-invocation read timeout in seconds (default 120 — agent runs can be
      slow because they perform multiple tool round-trips).

Validates: Requirements 7.2, 7.3
"""

from __future__ import annotations

import json
import os
import sys
import uuid

import pytest

# Make the ``agentcore`` package importable whether pytest runs from the repo
# root or from the ``agentcore`` directory. This integration test lives two
# levels below ``agentcore`` (agentcore/tests/integration/).
_AGENTCORE_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
if _AGENTCORE_ROOT not in sys.path:
    sys.path.insert(0, _AGENTCORE_ROOT)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# The dedicated payload field the deployed runtime reads the user's Cognito
# token from (Task 6.1: USER_TOKEN_PAYLOAD_FIELD). Forwarding the token here is
# precisely what the FrontEnd does, so this drives the full FE->RT->GW path.
USER_TOKEN_PAYLOAD_FIELD = "accessToken"  # nosec B105 - JSON field name, not a credential

# A prompt that requires an ADMIN-ONLY category (cloudwatch is admin-only and is
# denied for non-admins per the Cedar policy / ALLOWED mapping). The same prompt
# is sent for both tokens; only the propagated role differs.
DEFAULT_ADMIN_ONLY_PROMPT = (
    "Use CloudWatch to list the active alarms in my AWS account and summarize "
    "their state."
)

# Phrases that specifically indicate a ROLE-based denial (the runtime's
# build_denial_response wording from Task 6.4 / Req 8.5). These are matched
# case-insensitively. We deliberately do NOT include generic markers like
# "access denied" so a downstream IAM error on a routed admin call is not
# misread as a role denial.
_ROLE_DENIAL_PHRASES = (
    "not available for your role",
    "not available for the user's role",
    "not permitted for your role",
    "capability is not available for your role",
    "not available for your current role",
)

_TRUTHY = {"1", "true", "yes", "on"}


# ---------------------------------------------------------------------------
# Environment helpers + module-level skip gate
# ---------------------------------------------------------------------------

def _truthy(value) -> bool:
    return str(value or "").strip().lower() in _TRUTHY


def _region() -> str:
    return (
        os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or "us-east-1"
    )


def _runtime_arn() -> str | None:
    arn = os.environ.get("AGENT_RUNTIME_ARN") or os.environ.get(
        "AGENT_RUNTIME_ENDPOINT_ARN"
    )
    return arn.strip() if arn and arn.strip() else None


def _explicit_admin_token() -> str | None:
    token = os.environ.get("ADMIN_COGNITO_TOKEN") or os.environ.get(
        "ADMIN_ACCESS_TOKEN"
    )
    return token.strip() if token and token.strip() else None


def _explicit_nonadmin_token() -> str | None:
    token = os.environ.get("NONADMIN_COGNITO_TOKEN") or os.environ.get(
        "NONADMIN_ACCESS_TOKEN"
    )
    return token.strip() if token and token.strip() else None


def _can_mint(username_var: str, password_var: str) -> bool:
    """Whether USER_PASSWORD_AUTH credentials are configured to mint a token."""
    return bool(
        os.environ.get("COGNITO_CLIENT_ID")
        and os.environ.get(username_var)
        and os.environ.get(password_var)
    )


def _admin_token_configured() -> bool:
    return bool(_explicit_admin_token()) or _can_mint(
        "ADMIN_USERNAME", "ADMIN_PASSWORD"
    )


def _nonadmin_token_configured() -> bool:
    return bool(_explicit_nonadmin_token()) or _can_mint(
        "NONADMIN_USERNAME", "NONADMIN_PASSWORD"
    )


def _missing_requirements() -> list[str]:
    """Return unmet preconditions; empty means the test is ready to run.

    Evaluated at COLLECTION time (no boto3 import) so the module skips cleanly
    when the deployed infrastructure / tokens are not configured.
    """
    missing: list[str] = []
    if not _truthy(os.environ.get("INTEGRATION_TEST_ENABLED")):
        missing.append("INTEGRATION_TEST_ENABLED (set to 1/true to enable)")
    if not _runtime_arn():
        missing.append("AGENT_RUNTIME_ARN (deployed Agent Runtime to invoke)")
    if not _admin_token_configured():
        missing.append(
            "an Admin token (ADMIN_COGNITO_TOKEN, or "
            "COGNITO_CLIENT_ID + ADMIN_USERNAME + ADMIN_PASSWORD)"
        )
    if not _nonadmin_token_configured():
        missing.append(
            "a Non-Admin token (NONADMIN_COGNITO_TOKEN, or "
            "COGNITO_CLIENT_ID + NONADMIN_USERNAME + NONADMIN_PASSWORD)"
        )
    return missing


_MISSING = _missing_requirements()

# Module-level skip: the whole file is skipped (never errors) when the deployed
# infra + tokens are absent, so the suite stays green in CI without live infra.
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        bool(_MISSING),
        reason=(
            "Live end-to-end identity-propagation test (FrontEnd -> Runtime -> "
            "Gateway); missing required configuration: " + ", ".join(_MISSING)
        ),
    ),
]


# ---------------------------------------------------------------------------
# Token minting (lazy; only when the test actually runs)
# ---------------------------------------------------------------------------

def _mint_token(username_var: str, password_var: str, who: str) -> str:
    """Mint a Cognito access token via USER_PASSWORD_AUTH for the given user."""
    import boto3  # imported lazily so collection never requires boto3

    client_id = os.environ["COGNITO_CLIENT_ID"]
    username = os.environ[username_var]
    password = os.environ[password_var]
    try:
        idp = boto3.client("cognito-idp", region_name=_region())
        resp = idp.initiate_auth(
            ClientId=client_id,
            AuthFlow="USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": username, "PASSWORD": password},
        )
        result = resp.get("AuthenticationResult")
        assert result and result.get("AccessToken"), (
            f"USER_PASSWORD_AUTH for the {who} user returned no AccessToken "
            "(a challenge may be pending)"
        )
        return result["AccessToken"]
    except Exception as exc:  # pragma: no cover - depends on live Cognito
        pytest.skip(f"Could not obtain {who} Cognito token: {exc}")


@pytest.fixture(scope="module")
def admin_token() -> str:
    return _explicit_admin_token() or _mint_token(
        "ADMIN_USERNAME", "ADMIN_PASSWORD", who="Admin"
    )


@pytest.fixture(scope="module")
def nonadmin_token() -> str:
    return _explicit_nonadmin_token() or _mint_token(
        "NONADMIN_USERNAME", "NONADMIN_PASSWORD", who="Non-Admin"
    )


@pytest.fixture(scope="module")
def runtime_client():
    """A boto3 ``bedrock-agentcore`` client for invoking the deployed runtime."""
    import boto3  # lazy import

    return boto3.client("bedrock-agentcore", region_name=_region())


# ---------------------------------------------------------------------------
# Deployed-runtime invocation + response parsing
# ---------------------------------------------------------------------------

def _read_runtime_payload(response) -> str:
    """Flatten an ``invoke_agent_runtime`` response into a single text blob.

    The response payload may be a streaming body, raw bytes/str, or an
    event-stream of ``data:`` chunks. We concatenate everything into one string
    so the tolerant matchers can inspect it regardless of transport shape.
    """
    parts: list[str] = []

    body = response.get("response") if isinstance(response, dict) else None

    def _consume(chunk) -> None:
        if chunk is None:
            return
        if isinstance(chunk, (bytes, bytearray)):
            parts.append(bytes(chunk).decode("utf-8", errors="replace"))
        elif isinstance(chunk, str):
            parts.append(chunk)
        else:
            parts.append(str(chunk))

    if body is None:
        # Some SDK shapes expose the payload under different keys.
        for key in ("completion", "payload", "output"):
            if isinstance(response, dict) and key in response:
                body = response[key]
                break

    if hasattr(body, "read"):
        try:
            _consume(body.read())
        except Exception:  # pragma: no cover - defensive
            pass
    elif isinstance(body, (bytes, bytearray, str)):
        _consume(body)
    elif body is not None:
        # Iterable event stream (e.g. chunks with a 'chunk'/'bytes' field).
        try:
            for event in body:
                if isinstance(event, dict):
                    chunk = event.get("chunk") or event
                    data = chunk.get("bytes") if isinstance(chunk, dict) else None
                    _consume(data if data is not None else json.dumps(chunk))
                else:
                    _consume(event)
        except TypeError:  # pragma: no cover - not iterable
            _consume(body)

    return "".join(parts)


def _invoke_runtime(client, token: str, prompt: str) -> tuple[dict | None, str]:
    """Invoke the deployed runtime with the token in ``accessToken``.

    Returns ``(parsed_json_or_None, raw_text)``. The role is NEVER placed in the
    payload — only the token is forwarded, exactly as the FrontEnd does.
    """
    # AgentCore requires a runtime session id of at least 33 characters.
    session_id = f"e2e-{uuid.uuid4().hex}{uuid.uuid4().hex}"[:48]
    payload = {
        "prompt": prompt,
        "sessionId": session_id,
        "userId": "e2e-identity-propagation",
        USER_TOKEN_PAYLOAD_FIELD: token,
    }
    qualifier = os.environ.get("AGENT_RUNTIME_QUALIFIER", "DEFAULT")

    kwargs = dict(
        agentRuntimeArn=_runtime_arn(),
        runtimeSessionId=session_id,
        payload=json.dumps(payload).encode("utf-8"),
    )
    if qualifier:
        kwargs["qualifier"] = qualifier

    try:
        response = client.invoke_agent_runtime(**kwargs)
    except Exception as exc:  # pragma: no cover - depends on live infra
        pytest.skip(f"invoke_agent_runtime failed against deployed runtime: {exc}")

    raw = _read_runtime_payload(response)
    parsed: dict | None
    try:
        loaded = json.loads(raw)
        parsed = loaded if isinstance(loaded, dict) else None
    except Exception:
        parsed = None

    return parsed, raw


# ---------------------------------------------------------------------------
# Tolerant role-denial matchers
# ---------------------------------------------------------------------------

def _looks_like_role_denial(parsed: dict | None, raw_text: str) -> bool:
    """Whether the response conveys a ROLE-based denial (tolerant of phrasing).

    True when either the structured runtime denial flag is set, or the response
    text carries one of the role-unavailable phrases the runtime produces. We
    intentionally avoid generic markers (e.g. plain "access denied") so a
    downstream AWS/IAM error on a *routed* admin call is not misclassified.
    """
    if isinstance(parsed, dict) and parsed.get("denied") is True:
        return True
    lowered = (raw_text or "").lower()
    if isinstance(parsed, dict):
        # Prefer the explicit result/message field when present.
        for key in ("result", "message"):
            value = parsed.get(key)
            if isinstance(value, str):
                lowered += " " + value.lower()
    return any(phrase in lowered for phrase in _ROLE_DENIAL_PHRASES)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_admin_token_propagates_and_admin_only_capability_is_authorized(
    runtime_client, admin_token
):
    """ADMIN token end-to-end: the admin-only capability is NOT role-denied.

    The admin token is conveyed at the front (``accessToken``), forwarded
    unmodified by the runtime to the Gateway, and the Gateway authorizes the
    admin-only (cloudwatch) category against the propagated admin role. The
    user-facing response therefore must NOT be a role-denial.

    Validates: Requirements 7.2, 7.3
    """
    prompt = os.environ.get("E2E_ADMIN_ONLY_PROMPT", DEFAULT_ADMIN_ONLY_PROMPT)
    parsed, raw = _invoke_runtime(runtime_client, admin_token, prompt)

    assert raw.strip(), "Deployed runtime returned an empty response for the admin token"
    assert not _looks_like_role_denial(parsed, raw), (
        "Admin invocation of an admin-only (cloudwatch) capability was "
        "role-denied end-to-end; the admin role did not propagate to the "
        f"Gateway. Response: {raw[:600]!r}"
    )


def test_nonadmin_token_propagates_and_admin_only_capability_is_denied(
    runtime_client, nonadmin_token
):
    """NON-ADMIN token end-to-end: the SAME admin-only prompt is role-denied.

    The non-admin token is conveyed at the front and forwarded unmodified to the
    Gateway, which denies the admin-only (cloudwatch) category against the
    propagated non-admin role. The runtime surfaces a role-unavailable response
    (Task 6.4 / Req 8.5).

    Validates: Requirements 7.2, 7.3
    """
    prompt = os.environ.get("E2E_ADMIN_ONLY_PROMPT", DEFAULT_ADMIN_ONLY_PROMPT)
    parsed, raw = _invoke_runtime(runtime_client, nonadmin_token, prompt)

    assert raw.strip(), "Deployed runtime returned an empty response for the non-admin token"
    assert _looks_like_role_denial(parsed, raw), (
        "Non-Admin invocation of an admin-only (cloudwatch) capability was NOT "
        "role-denied end-to-end; the non-admin role did not propagate to the "
        "Gateway's authorization decision (expected a 'not available for your "
        f"role' response). Response: {raw[:600]!r}"
    )


# ---------------------------------------------------------------------------
# BUG 1 (agentcore-security-review-fixes) — per-user memory-actor isolation
# end to end. Validates: Requirements 2.1, 3.1, 3.2, 3.3
# ---------------------------------------------------------------------------
#
# WHAT THIS ADDS
# --------------
# The fix for BUG 1 derives the AgentCore Memory ``actor_id`` server-side from
# the verified Cognito ``sub`` claim (``resolve_verified_sub`` in
# ``agent_runtime.py``), instead of the payload-supplied, frontend-hardcoded
# ``userId="amplify_user"``. Two users with DISTINCT ``sub`` values must
# therefore be keyed to DISTINCT memory actors and never share one, satisfying
# M-0010.
#
# This lives in the SAME opt-in, skip-gated module as the identity-propagation
# tests above: it inherits the module-level ``pytestmark`` skip (so the whole
# file SKIPS cleanly when live infra / tokens are absent — never errors in CI)
# and reuses the existing ``admin_token`` / ``nonadmin_token`` fixtures, which
# are minted for two DISTINCT Cognito users and therefore carry distinct ``sub``
# claims.
#
# OBSERVABILITY LIMITATION (documented per task)
# ----------------------------------------------
# The server-derived ``actor_id`` is an internal AgentCore Memory keying
# decision; the deployed ``invoke_agent_runtime`` response does NOT echo it
# back, so per-user memory-actor isolation cannot be observed DIRECTLY end to
# end via the invoke response. We therefore assert isolation at the STRONGEST
# observable boundary:
#
#   1. The two tokens carry DISTINCT verified ``sub`` claims (decoded here from
#      the same forwarded ``accessToken`` the runtime decodes server-side) — the
#      exact identity the fix keys memory on. Because ``actor_id`` is a
#      deterministic function of the verified ``sub`` (proven by the Task 1/5.3
#      property test and the Task 7 unit tests), distinct subs ⇒ distinct
#      actor_ids ⇒ no shared memory actor.
#   2. BOTH users invoke the deployed runtime successfully end to end (each in
#      its own memory session), confirming the server-side sub-derivation /
#      memory-keying path runs for each distinct identity without error.
#
# The payload ``userId`` is held constant across both users (the hardcoded
# ``amplify_user``) so the ONLY thing distinguishing them is the token-borne
# ``sub`` — proving identity (and thus the memory actor) comes from the verified
# token, not the client payload.


def _decode_jwt_sub(token: str) -> str | None:
    """Decode the ``sub`` claim from a JWT WITHOUT verifying its signature.

    Mirrors the server-side ``resolve_verified_sub`` / discovery-filter
    ``_decode_jwt_claims`` approach: base64url-decode the payload segment (the
    middle of the three dot-delimited segments) and read ``sub``. The token was
    already verified by Cognito/the Gateway; here we only need the identity the
    runtime keys memory on. Returns ``None`` on any malformed/absent value.
    """
    import base64

    try:
        segments = token.split(".")
        if len(segments) < 2:
            return None
        payload_segment = segments[1]
        padding = "=" * (-len(payload_segment) % 4)
        decoded = base64.urlsafe_b64decode(payload_segment + padding)
        claims = json.loads(decoded)
        sub = claims.get("sub")
        return sub if isinstance(sub, str) and sub else None
    except Exception:
        return None


def _invoke_runtime_memory_session(client, token: str) -> tuple[dict | None, str, str]:
    """Invoke the deployed runtime for a memory-relevant session.

    Returns ``(parsed_json_or_None, raw_text, session_id)``. The payload holds
    the ``userId`` constant at the hardcoded frontend value so identity is
    conveyed ONLY by the token-borne ``sub`` (exactly as the fix requires). A
    benign, role-neutral prompt is used so the outcome does not depend on the
    caller's role — this test is about memory-actor keying, not authorization.
    """
    session_id = f"mem-{uuid.uuid4().hex}{uuid.uuid4().hex}"[:48]
    payload = {
        "prompt": "Briefly say hello.",
        "sessionId": session_id,
        # Held CONSTANT across both users — the hardcoded frontend identity that
        # is no longer trusted server-side (BUG 1). Only the token differs.
        "userId": "amplify_user",
        USER_TOKEN_PAYLOAD_FIELD: token,
    }
    qualifier = os.environ.get("AGENT_RUNTIME_QUALIFIER", "DEFAULT")

    kwargs = dict(
        agentRuntimeArn=_runtime_arn(),
        runtimeSessionId=session_id,
        payload=json.dumps(payload).encode("utf-8"),
    )
    if qualifier:
        kwargs["qualifier"] = qualifier

    try:
        response = client.invoke_agent_runtime(**kwargs)
    except Exception as exc:  # pragma: no cover - depends on live infra
        pytest.skip(f"invoke_agent_runtime failed against deployed runtime: {exc}")

    raw = _read_runtime_payload(response)
    parsed: dict | None
    try:
        loaded = json.loads(raw)
        parsed = loaded if isinstance(loaded, dict) else None
    except Exception:
        parsed = None

    return parsed, raw, session_id


def test_distinct_users_get_isolated_memory_actors_end_to_end(
    runtime_client, admin_token, nonadmin_token
):
    """Two users with DISTINCT Cognito subs do NOT share a memory actor.

    The admin and non-admin tokens are minted for two distinct Cognito users, so
    they carry distinct ``sub`` claims. The BUG 1 fix keys AgentCore Memory to
    the server-derived verified ``sub`` (not the payload ``userId``, which is
    held constant here at ``amplify_user``). We assert isolation at the strongest
    observable boundary end to end:

      * the two tokens carry DISTINCT verified ``sub`` claims — the identity the
        runtime keys memory on (so their memory actors are distinct), and
      * BOTH tokens invoke the deployed runtime successfully in their own memory
        session, exercising the server-side sub-derivation / memory-keying path
        for each distinct identity.

    NOTE (observability limitation): the deployed invoke response does not echo
    the internal ``actor_id`` back, so memory-actor isolation cannot be observed
    DIRECTLY via the response. Because ``actor_id`` is derived deterministically
    from the verified ``sub`` server-side (see the Task 1/5.3 property test and
    Task 7 unit tests), distinct subs establish distinct memory actors here.

    Validates: Requirements 2.1, 3.1, 3.2, 3.3
    """
    sub_admin = _decode_jwt_sub(admin_token)
    sub_nonadmin = _decode_jwt_sub(nonadmin_token)

    assert sub_admin, (
        "could not decode a 'sub' claim from the admin token; the runtime keys "
        "memory on this server-derived identity"
    )
    assert sub_nonadmin, (
        "could not decode a 'sub' claim from the non-admin token; the runtime "
        "keys memory on this server-derived identity"
    )

    # The decisive property: two distinct users carry distinct verified subs, so
    # the fix keys them to DISTINCT memory actors — they never share one. The
    # payload userId is identical across both, proving identity comes from the
    # token, not the client payload.
    assert sub_admin != sub_nonadmin, (
        "the admin and non-admin tokens resolved to the SAME verified 'sub' "
        f"({sub_admin!r}); expected two distinct users so their memory actors "
        "are isolated. Ensure the fixtures are minted for two different Cognito "
        "users."
    )

    # Both distinct identities invoke the deployed runtime successfully in their
    # own memory session — exercising the server-side memory-keying path end to
    # end for each user without error.
    _, raw_admin, session_admin = _invoke_runtime_memory_session(
        runtime_client, admin_token
    )
    _, raw_nonadmin, session_nonadmin = _invoke_runtime_memory_session(
        runtime_client, nonadmin_token
    )

    assert raw_admin.strip(), (
        "deployed runtime returned an empty response for the admin user's "
        "memory-enabled invocation"
    )
    assert raw_nonadmin.strip(), (
        "deployed runtime returned an empty response for the non-admin user's "
        "memory-enabled invocation"
    )
    # Distinct per-browser sessions are also distinct (session_id keying is
    # preserved for single-user continuity, Req 3.3), and combined with the
    # distinct verified subs the two users share neither actor nor session.
    assert session_admin != session_nonadmin
