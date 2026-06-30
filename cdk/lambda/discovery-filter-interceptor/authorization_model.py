"""
Pure authorization model for gateway tool access control.

This module is the single, dependency-free Python surface that mirrors the
AgentCore (Cedar) policy set used by the Gateway. It is intentionally pure and
importable from both the AgentCore runtime and CDK Lambda handlers (for example
the Cognito Pre Token Generation Lambda), so that the role-claim mapping and the
role -> tool-category authorization rules have one authoritative implementation.

Feature: gateway-tool-access-control

Data model reference (see design.md "Data Models"):

    Role          = "Admin" | "NonAdmin"
    ToolCategory  = "billing" | "pricing" | "cloudwatch" | "cloudtrail" | "inventory"

    ALLOWED(Admin)    = { billing, pricing, cloudwatch, cloudtrail, inventory }
    ALLOWED(NonAdmin) = { billing, pricing }

NOTE: Task 1.2 adds `authorize`, `discovery_filter`, `format_authorization_error`,
and `build_deny_audit_entry` to this same module. The structure below (shared
constants, the `ALLOWED` mapping, and string-valued enums) is arranged so those
additions slot in without changing this task's surface.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Iterable, List, Mapping, Optional, Union


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Cognito group whose membership designates the Admin role.
ADMIN_GROUP: str = "Administrators"

# The scalar `role` claim values injected into the user's token. These are the
# only two values `map_groups_to_role_claim` may ever return.
ADMIN_CLAIM: str = "admin"
NONADMIN_CLAIM: str = "nonadmin"


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

class Role(str, Enum):
    """The two roles the system recognizes.

    `NonAdmin` is the default role assigned to any identity that is not
    explicitly designated Admin (absent / empty / unknown role claim).
    """

    Admin = "Admin"
    NonAdmin = "NonAdmin"


class ToolCategory(str, Enum):
    """The five defined tool categories, each backed by one Gateway target."""

    billing = "billing"
    pricing = "pricing"
    cloudwatch = "cloudwatch"
    cloudtrail = "cloudtrail"
    inventory = "inventory"


# ---------------------------------------------------------------------------
# Authoritative role -> allowed-categories mapping
# ---------------------------------------------------------------------------

# This mapping is the single authoritative source of role-to-category rules
# (Req 6.1). The Cedar policy set deployed to the Gateway implements exactly
# these semantics:
#   - Admin    -> all five categories  (Req 2.1, 6.2)
#   - NonAdmin -> billing and pricing only  (Req 3.1, 6.3)
ALLOWED: Mapping[Role, frozenset[ToolCategory]] = {
    Role.Admin: frozenset(
        {
            ToolCategory.billing,
            ToolCategory.pricing,
            ToolCategory.cloudwatch,
            ToolCategory.cloudtrail,
            ToolCategory.inventory,
        }
    ),
    Role.NonAdmin: frozenset(
        {
            ToolCategory.billing,
            ToolCategory.pricing,
        }
    ),
}


# ---------------------------------------------------------------------------
# Claim mapping and role derivation
# ---------------------------------------------------------------------------

def map_groups_to_role_claim(groups: Optional[Iterable[str]]) -> str:
    """Map a user's Cognito group memberships to a single scalar role claim.

    Returns exactly one value in ``{"admin", "nonadmin"}``. The result is
    ``"admin"`` if and only if the ``Administrators`` group is present in
    ``groups``; otherwise it is ``"nonadmin"``.

    The mapping is intentionally tolerant of how ``cognito:groups`` may arrive:
    a missing claim (``None``), an empty collection, or any collection of
    group-name strings. Non-string members are ignored. (Req 1.1)

    Args:
        groups: The user's group memberships (e.g. the ``cognito:groups``
            claim), or ``None`` if absent.

    Returns:
        ``"admin"`` if the user belongs to ``Administrators``, else
        ``"nonadmin"``.
    """
    if groups is None:
        return NONADMIN_CLAIM

    for group in groups:
        if group == ADMIN_GROUP:
            return ADMIN_CLAIM

    return NONADMIN_CLAIM


def derive_role(role_claim: Optional[str]) -> Role:
    """Derive the user's Role from the verified ``role`` claim.

    Returns ``Role.Admin`` if and only if ``role_claim`` is exactly the string
    ``"admin"``. Every other input -- a different string, a different case
    (e.g. ``"Admin"``), the empty string, whitespace, a non-string value, or an
    absent claim (``None``) -- resolves to ``Role.NonAdmin`` (default-deny
    posture). (Req 1.2, 1.3, 1.4, 6.5, 7.4)

    The role is determined solely from this verified-identity claim; callers
    MUST NOT pass any role value sourced from a request payload, query string,
    or header. (Req 1.5)

    Args:
        role_claim: The scalar ``role`` claim value from the authenticated
            identity, or ``None`` if absent.

    Returns:
        ``Role.Admin`` iff the claim is exactly ``"admin"``, otherwise
        ``Role.NonAdmin``.
    """
    if role_claim == ADMIN_CLAIM:
        return Role.Admin
    return Role.NonAdmin


# ---------------------------------------------------------------------------
# Authorization decision
# ---------------------------------------------------------------------------

# A category identifier as it may arrive at the authorization boundary: either a
# known `ToolCategory`, or a bare string (which may name a known category or an
# unknown / newly-registered one). Unknown identifiers are always denied.
CategoryLike = Union[ToolCategory, str]


class Decision(str, Enum):
    """The allow-or-deny outcome of an authorization evaluation.

    Mirrors the Cedar engine's per-request result. `Deny` is the default
    outcome for any category not explicitly allowed for the role -- including
    unknown / newly-registered categories (Req 5.1, 5.3).
    """

    Allow = "Allow"
    Deny = "Deny"


def _coerce_category(category: Any) -> Optional[ToolCategory]:
    """Resolve an arbitrary category identifier to a known ``ToolCategory``.

    Returns the matching ``ToolCategory`` for a ``ToolCategory`` instance or for
    a string equal to one of the defined category values. Returns ``None`` for
    any unknown / newly-added category identifier (or non-string value), which
    the caller treats as denied under the default-deny posture.
    """
    if isinstance(category, ToolCategory):
        return category
    if isinstance(category, str):
        try:
            return ToolCategory(category)
        except ValueError:
            return None
    return None


def _is_allowed(role: Role, category: CategoryLike) -> bool:
    """Return whether ``category`` is in the role's allowed set (default-deny).

    Any category absent from ``ALLOWED(role)`` -- including unknown categories
    and any role with no mapping entry -- yields ``False``.
    """
    allowed = ALLOWED.get(role)
    if not allowed:
        return False
    known = _coerce_category(category)
    if known is None:
        return False
    return known in allowed


def authorize(role: Role, category: CategoryLike) -> Decision:
    """Authorize a ``(role, category)`` pair against the authoritative mapping.

    Returns ``Decision.Allow`` if and only if ``category`` is a member of
    ``ALLOWED(role)``; otherwise ``Decision.Deny``. This is the single decision
    function used identically for both discovery filtering and invocation.

    For any category not present in ``ALLOWED(role)`` -- including the empty
    string, an unknown string, or a newly-registered category that has no
    explicit allow rule -- the result is ``Decision.Deny`` (default-deny
    posture). (Req 2.3, 3.3, 4.1, 4.3, 5.1, 5.2, 5.3)

    Args:
        role: The resolved user role.
        category: The requested tool category, as a ``ToolCategory`` or a bare
            string (possibly naming an unknown / new category).

    Returns:
        ``Decision.Allow`` iff ``category`` is in ``ALLOWED(role)``, else
        ``Decision.Deny``.
    """
    return Decision.Allow if _is_allowed(role, category) else Decision.Deny


# ---------------------------------------------------------------------------
# Discovery filtering
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Tool:
    """A discoverable tool tagged with the category it belongs to.

    ``category`` may be a known ``ToolCategory`` or a bare string naming an
    unknown / newly-registered category; unknown categories are excluded from a
    role's discovery results under the default-deny posture.
    """

    name: str
    category: CategoryLike


def _tool_category(tool: Any) -> CategoryLike:
    """Extract the category from a tool entry.

    Accepts a ``Tool`` (or any object exposing a ``category`` attribute) and
    mappings carrying a ``"category"`` key, so the filter can operate over
    catalogs in a variety of shapes without coupling to one representation.
    """
    if isinstance(tool, Mapping):
        return tool.get("category")  # type: ignore[return-value]
    return getattr(tool, "category", None)


def discovery_filter(role: Role, catalog: Iterable[Any]) -> List[Any]:
    """Filter a tool catalog down to the tools the role may discover.

    Returns, in input order, exactly the tools whose category is in
    ``ALLOWED(role)``. Every tool whose category is absent from
    ``ALLOWED(role)`` -- including unknown / newly-registered categories -- is
    omitted. In particular, for ``NonAdmin`` no tool from the cloudwatch,
    cloudtrail, inventory, or any unknown category appears in the result
    (Req 2.2, 3.2, 4.2, 5.4).

    Args:
        role: The resolved user role.
        catalog: An iterable of tools, each tagged with a category (a ``Tool``,
            an object with a ``category`` attribute, or a mapping with a
            ``"category"`` key).

    Returns:
        The list of tools whose category is permitted for ``role``.
    """
    return [tool for tool in catalog if _is_allowed(role, _tool_category(tool))]


# ---------------------------------------------------------------------------
# Tool-name classification (RESPONSE discovery-filter interceptor surface)
# ---------------------------------------------------------------------------
#
# The discovery-filter RESPONSE interceptor receives tool descriptors carrying a
# fully-qualified gateway tool ``name`` (not a ``.category``). The pure helpers
# below classify such a name to its category and decide retention, keeping that
# classification in this single source of truth so it is property-testable and
# reused verbatim by the vendored Lambda copy.

# The Gateway-provided semantic search tool; it carries no category prefix and
# is retained for every role (Req 3.4).
BUILTIN_SEARCH_TOOL_NAME: str = "x_amz_bedrock_agentcore_search"

# Exact, case-sensitive LEADING prefixes that map a fully-qualified gateway tool
# name to its category (Req 3.1). NOTE the asymmetry, taken verbatim from the
# requirements glossary: ``inventoryMcp__`` uses two trailing underscores while
# the other four use three. Ordered so classification is a deterministic
# first-match scan.
TOOL_NAME_CATEGORY_PREFIXES: tuple[tuple[str, ToolCategory], ...] = (
    ("billingMcp___", ToolCategory.billing),
    ("pricingMcp___", ToolCategory.pricing),
    ("cloudwatchMcp___", ToolCategory.cloudwatch),
    ("cloudtrailMcp___", ToolCategory.cloudtrail),
    ("inventoryMcp__", ToolCategory.inventory),
)


def category_for_tool_name(tool_name: Any) -> Optional[ToolCategory]:
    """Classify a fully-qualified gateway tool name to its ``ToolCategory``.

    Matching is an exact, case-sensitive LEADING prefix match against
    ``TOOL_NAME_CATEGORY_PREFIXES`` (Req 3.1). Returns ``None`` -- treated as an
    unknown category under the default-deny posture -- for the builtin search
    tool (it carries no prefix), for a name where a known prefix appears only as
    a non-leading substring (Req 3.3), for an empty / whitespace / odd name, for
    a non-string value, and for any otherwise unrecognized name (Req 3.2).

    Args:
        tool_name: The fully-qualified gateway tool name (any value; non-strings
            are rejected).

    Returns:
        The bound ``ToolCategory`` for an exact leading prefix match, else
        ``None``.
    """
    if not isinstance(tool_name, str):
        return None
    for prefix, category in TOOL_NAME_CATEGORY_PREFIXES:
        if tool_name.startswith(prefix):
            return category
    return None


def retain_tool_for_role(role: Role, tool_name: Any) -> bool:
    """Per-descriptor retention predicate for the RESPONSE discovery filter.

    The builtin search tool is retained for every role (Req 3.4). Every other
    name is classified by its leading prefix and retained if and only if its
    category is allowed for ``role`` -- i.e. ``authorize(role, category) ==
    Decision.Allow``. Unknown / unclassifiable names (``category_for_tool_name``
    returns ``None``) are denied under the default-deny posture, so a new tool
    category with no ``ALLOWED`` entry for the role is excluded without any
    change to this logic (Req 1.2, 1.3, 1.4, 3.2, 3.6).

    This composes the authoritative ``authorize`` / ``ALLOWED`` surface and does
    NOT restate the role -> category rules (Req 1.6).

    Args:
        role: The resolved caller role.
        tool_name: The fully-qualified gateway tool name from the descriptor.

    Returns:
        ``True`` iff the tool should be retained in the role's discovery
        response.
    """
    if tool_name == BUILTIN_SEARCH_TOOL_NAME:
        return True
    category = category_for_tool_name(tool_name)
    if category is None:
        return False
    return authorize(role, category) == Decision.Allow


# ---------------------------------------------------------------------------
# Denial error formatting
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AuthorizationError:
    """An authorization error for a denied tool interaction.

    Identifies the denied category and carries a role-appropriate message. By
    construction it holds no tool input arguments, output payload, or result
    data (Req 4.4, 8.1).
    """

    denied_category: str
    message: str

    def to_dict(self) -> Dict[str, str]:
        """Serialize to a plain dict containing only the category and message."""
        return {"deniedCategory": self.denied_category, "message": self.message}


def format_authorization_error(denied_category: CategoryLike) -> AuthorizationError:
    """Build an authorization error naming the denied category.

    The returned error identifies the denied category and contains nothing
    derived from the requested tool -- no input arguments, no output payload,
    and no result data. The category is reported by its identifier whether it is
    a known ``ToolCategory`` or an unknown / newly-registered string.
    (Req 4.4, 8.1)

    Args:
        denied_category: The tool category whose access was denied.

    Returns:
        An :class:`AuthorizationError` carrying the category and a message.
    """
    known = _coerce_category(denied_category)
    category_name = known.value if known is not None else str(denied_category)
    message = (
        f"Access to the '{category_name}' tool category is not permitted "
        "for your role."
    )
    return AuthorizationError(denied_category=category_name, message=message)


# ---------------------------------------------------------------------------
# Deny-audit entry
# ---------------------------------------------------------------------------

# Fixed outcome recorded for every deny-audit entry.
DENY_OUTCOME: str = "deny"


@dataclass(frozen=True)
class DenyAuditEntry:
    """A structured audit record for a single deny authorization decision.

    Carries exactly the four fields the audit requirement mandates: a reference
    to the user identity, the requested category, the ``"deny"`` outcome, and
    the decision timestamp. It never contains the raw token (the identity is
    referenced only by ``identity_ref``, e.g. the JWT ``sub``) and never any
    tool data (Req 8.3).
    """

    identity_ref: str
    category: str
    outcome: str
    timestamp: str

    def to_dict(self) -> Dict[str, str]:
        """Serialize to a dict using the design's field names."""
        return {
            "identityRef": self.identity_ref,
            "category": self.category,
            "outcome": self.outcome,
            "timestamp": self.timestamp,
        }


def build_deny_audit_entry(
    identity_ref: str,
    category: CategoryLike,
    timestamp: str,
) -> DenyAuditEntry:
    """Build the four-field audit record for a deny decision.

    Produces a record containing the user identity reference, the requested
    tool category, the fixed ``"deny"`` outcome, and the timestamp of the
    authorization decision. The ``identity_ref`` MUST be an identity reference
    such as the JWT ``sub`` -- never the raw token -- and the record contains no
    tool input arguments, output payload, or result data. (Req 8.3)

    Args:
        identity_ref: A reference to the user identity (e.g. the JWT ``sub``),
            never the raw token.
        category: The requested tool category (known ``ToolCategory`` or an
            unknown / newly-registered string).
        timestamp: The ISO-8601 timestamp of the authorization decision.

    Returns:
        A :class:`DenyAuditEntry` with the four required fields.
    """
    known = _coerce_category(category)
    category_name = known.value if known is not None else str(category)
    return DenyAuditEntry(
        identity_ref=identity_ref,
        category=category_name,
        outcome=DENY_OUTCOME,
        timestamp=timestamp,
    )


# ---------------------------------------------------------------------------
# Runtime denial-response handling (Req 8.5)
# ---------------------------------------------------------------------------
#
# These helpers are the pure, dependency-free surface the Agent Runtime uses to
# recognize a Gateway/Policy authorization denial and turn it into a
# role-appropriate, data-free user response. They live here (rather than in the
# runtime module) so they remain importable and unit-testable WITHOUT the AWS /
# strands / mcp dependencies the runtime pulls in.
#
# WHY CONTENT-BASED CLASSIFICATION: when the Gateway's Cedar Policy denies a
# tool invocation it returns an ``AuthorizeActionException``. By the time that
# surfaces in the runtime it may arrive as any of several concrete types -- an
# ``mcp.shared.exceptions.McpError`` carrying an ``ErrorData`` whose message
# names the exception, a strands tool/agent error that wraps it, or a plain
# ``Exception`` -- and the exact class is not guaranteed across library
# versions. Catching by a single exception class is therefore brittle. Instead
# the runtime catches broadly and asks :func:`is_authorization_denial` to
# classify the error from its text/type signals.

# Substrings (matched case-insensitively) that signal a Gateway/Policy
# authorization denial as opposed to an unrelated failure.
_AUTHORIZATION_DENIAL_MARKERS: tuple[str, ...] = (
    "authorizeactionexception",
    "authorizeaction",
    "accessdeniedexception",
    "access denied",
    "not authorized",
    "unauthorizedexception",
    "not permitted for your role",
    "forbidden",
    "403",
)

# Gateway target name prefixes -> tool category. Used to recover which category
# was denied from an error message that names the tool/target.
_CATEGORY_TARGET_PREFIXES: Mapping[str, ToolCategory] = {
    "billingmcp": ToolCategory.billing,
    "pricingmcp": ToolCategory.pricing,
    "cloudwatchmcp": ToolCategory.cloudwatch,
    "cloudtrailmcp": ToolCategory.cloudtrail,
    "inventorymcp": ToolCategory.inventory,
}


def _error_text(error: Any) -> str:
    """Collect the human-readable text carried by an error-like value.

    Gathers the string form, the exception class name, and the message of a
    nested ``ErrorData`` (as exposed by ``mcp.shared.exceptions.McpError`` via
    its ``.error`` attribute) when present. Returns a single string. This is
    used only to CLASSIFY the error and to recover the denied category; the raw
    text is never surfaced to the user (see :func:`build_denial_response`).
    """
    parts: List[str] = []
    if error is None:
        return ""
    if isinstance(error, str):
        return error
    try:
        parts.append(str(error))
    except Exception:  # pragma: no cover - defensive
        pass
    parts.append(type(error).__name__)
    # McpError-style nested ErrorData (``error.error.message`` / ``.code``).
    nested = getattr(error, "error", None)
    if nested is not None and nested is not error:
        for attr in ("message", "code"):
            value = getattr(nested, attr, None)
            if value is not None:
                parts.append(str(value))
    # Some exceptions expose a ``.message`` attribute directly.
    direct_message = getattr(error, "message", None)
    if direct_message is not None:
        parts.append(str(direct_message))
    return " ".join(parts)


def is_authorization_denial(error: Any) -> bool:
    """Return whether ``error`` represents a Gateway/Policy authorization denial.

    Classifies an exception (or error string) raised while invoking a tool
    through the Gateway. Returns ``True`` when the error's type name or message
    matches a known authorization-denial signal (e.g. ``AuthorizeActionException``,
    "access denied", "not authorized", HTTP 403), so the runtime can map it to a
    role-appropriate response (Req 8.5). Returns ``False`` for unrelated
    failures (e.g. a target-unavailable/timeout error), which fall through to
    the runtime's generic error handler.
    """
    text = _error_text(error).lower()
    if not text:
        return False
    return any(marker in text for marker in _AUTHORIZATION_DENIAL_MARKERS)


def extract_denied_category(error: Any) -> Optional[str]:
    """Best-effort recovery of the denied tool category from an error.

    Inspects an error-like value (a ``ToolCategory``, a category/target string,
    or an exception) and returns the canonical category identifier (e.g.
    ``"cloudwatch"``) when it can be determined, else ``None``. Matching prefers
    an explicit category name, then a Gateway target prefix
    (``cloudwatchMcp___`` -> ``cloudwatch``). Only the category identifier is
    recovered -- never any tool arguments, output, or result data.
    """
    known = _coerce_category(error)
    if known is not None:
        return known.value

    text = _error_text(error)
    if not text:
        return None
    lowered = text.lower()

    # Prefer an explicit, defined category name appearing in the text.
    for category in ToolCategory:
        if category.value in lowered:
            return category.value

    # Otherwise recover the category from a Gateway target prefix.
    for prefix, category in _CATEGORY_TARGET_PREFIXES.items():
        if prefix in lowered:
            return category.value

    return None


def build_denial_response(
    category_or_error: Any,
    *,
    session_id: Optional[str] = None,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Build the Agent Runtime's user-facing response for an authorization denial.

    Accepts either a category (``ToolCategory`` / category string) or the
    authorization error/exception itself, recovers the denied category when
    possible, and returns a response dict that:

    - states the requested capability is not available for the user's role, and
    - contains NONE of the denied tool's input arguments, output payload, or
      result data (Req 8.5).

    The user-facing message is constructed solely from the (clean) category
    identifier -- the raw error text is used only to classify/recover the
    category and is deliberately NOT echoed into the response, so no tool data
    can leak through an error string.

    Args:
        category_or_error: The denied category, or the authorization error from
            which to recover it.
        session_id: Optional session identifier echoed back to the caller, for
            response shape parity with the success path.
        user_id: Optional user identifier echoed back to the caller.

    Returns:
        A response dict with a role-appropriate ``result`` message, a ``denied``
        flag, and (when recoverable) the ``deniedCategory``.
    """
    denied_category = extract_denied_category(category_or_error)

    if denied_category is not None:
        message = (
            f"The requested '{denied_category}' capability is not available "
            "for your role."
        )
    else:
        message = "The requested capability is not available for your role."

    response: Dict[str, Any] = {
        "result": message,
        "denied": True,
    }
    if denied_category is not None:
        response["deniedCategory"] = denied_category
    if session_id is not None:
        response["sessionId"] = session_id
    if user_id is not None:
        response["userId"] = user_id
    return response
