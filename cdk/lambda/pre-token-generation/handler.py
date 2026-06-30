"""
Cognito Pre Token Generation Lambda handler.

Injects a scalar ``role`` claim (``"admin"`` or ``"nonadmin"``) into the user's
tokens based on Cognito group membership, so that the AgentCore Gateway's Cedar
policy can authorize tool access by role.

The role is derived solely from the user's verified group membership
(``cognito:groups``), never from any client-supplied value (Req 1.1). The
mapping itself is delegated to ``map_groups_to_role_claim`` so the Lambda's
behavior matches the property-tested authorization model (the authoritative
source is ``agentcore/authorization_model.py``; see ``authorization_model.py``
in this directory for why a minimal copy is vendored alongside the handler).

This handler targets the V2_0 (and V3_0) trigger event, which supports access
token customization in addition to ID token customization. The ``role`` claim is
written to BOTH the ID token and the access token so the token forwarded to the
Gateway carries it regardless of which token is used for authorization. For the
legacy V1_0 event (ID token only), it falls back to ``claimsOverrideDetails``.

Feature: gateway-tool-access-control

Reference:
  https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from authorization_model import map_groups_to_role_claim

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# The scalar claim name injected into both tokens.
ROLE_CLAIM_NAME: str = "role"


def _extract_groups(event: Dict[str, Any]) -> Optional[List[str]]:
    """Read the user's groups from the trigger event.

    Cognito delivers the user's group memberships at
    ``event['request']['groupConfiguration']['groupsToOverride']``. Returns the
    list of group names, or ``None`` when the structure is absent (which the
    mapping treats as no groups -> ``nonadmin``).
    """
    request = event.get("request") or {}
    group_config = request.get("groupConfiguration") or {}
    return group_config.get("groupsToOverride")


def _build_v2_response(role_claim: str) -> Dict[str, Any]:
    """Build a V2_0/V3_0 response injecting ``role`` into ID and access tokens."""
    claims = {ROLE_CLAIM_NAME: role_claim}
    return {
        "claimsAndScopeOverrideDetails": {
            "idTokenGeneration": {
                "claimsToAddOrOverride": dict(claims),
            },
            "accessTokenGeneration": {
                "claimsToAddOrOverride": dict(claims),
            },
        }
    }


def _build_v1_response(role_claim: str) -> Dict[str, Any]:
    """Build a V1_0 response injecting ``role`` into the ID token only."""
    return {
        "claimsOverrideDetails": {
            "claimsToAddOrOverride": {ROLE_CLAIM_NAME: role_claim},
        }
    }


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Entry point for the Cognito Pre Token Generation trigger.

    Derives the scalar ``role`` claim from the user's verified group membership
    and injects it into the response so Cognito writes it to the issued
    token(s). Returns the (mutated) event object as required by the trigger
    contract.
    """
    groups = _extract_groups(event)
    role_claim = map_groups_to_role_claim(groups)

    # Trigger event version: "1" => ID token only; "2"/"3" => ID + access token.
    version = str(event.get("version", "2"))

    response = event.get("response")
    if not isinstance(response, dict):
        response = {}

    if version == "1":
        response.update(_build_v1_response(role_claim))
    else:
        response.update(_build_v2_response(role_claim))

    event["response"] = response

    # Confirmation log only. The role is intentionally NOT interpolated into the
    # message: it is recoverable from the issued token, and logging it trips a
    # logger-credential-disclosure scanner heuristic. Keep this call free of any
    # dynamic argument so it cannot be flagged as disclosing data.
    logger.info("Pre token generation trigger processed; role claim injected.")

    return event
