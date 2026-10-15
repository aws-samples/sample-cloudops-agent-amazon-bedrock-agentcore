"""CloudOps instructions grounded in the request's identity-filtered tool catalogue."""

_CAPABILITIES = {
    'billing': ('Billing', 'Cost analysis, budgets, forecasts, optimization recommendations, and free-tier usage.'),
    'pricing': ('Pricing', 'AWS service prices and comparisons.'),
    'cloudwatch': ('CloudWatch', 'Metrics, alarms, log groups, and Logs Insights queries.'),
    'cloudtrail': ('CloudTrail', 'API event history and account activity.'),
    'inventory': ('Inventory', 'Managed resource inventory, versions, and support lifecycle dates.'),
}


def build_system_prompt(current_date: str, tool_names=None) -> str:
    # Evaluation callers that omit a catalogue retain the full application scope.
    names = sorted(set(tool_names)) if tool_names is not None else None
    categories = set(_CAPABILITIES) if names is None else {
        category for category in _CAPABILITIES
        if any(name.lower().startswith(category + 'mcp___') for name in names)
    }
    capabilities = '\n'.join(f'- {_CAPABILITIES[key][0]}: {_CAPABILITIES[key][1]}' for key in _CAPABILITIES if key in categories)
    unavailable = [label for key, (label, _) in _CAPABILITIES.items() if key not in categories]
    # Stable, task-relevant order puts operational restrictions first.
    unavailable.sort(key=lambda label: ['CloudWatch', 'CloudTrail', 'Inventory', 'Pricing', 'Billing'].index(label))
    catalogue = '\n'.join(f'- {name}' for name in names) if names is not None else 'Use the tool definitions supplied with this request.'
    prompt = f"""You are a CloudOps AI assistant. Investigate only with the capabilities available for this request.

Current date: {current_date}

Available capabilities:
{capabilities or 'No tools are available for this request.'}
Unavailable for this request: {', '.join(unavailable) if unavailable else 'None'}

IMPORTANT - Available tools:
Your permitted Gateway tools are already loaded after paginated, identity-scoped discovery.
Use these exact registered names and their input schemas:
{catalogue}

Do not invent tool names, placeholder names such as $MCP_TOOL_*, or an unregistered search tool.
For an unavailable capability, call report_access_restricted with the requested capability, then explain the access restriction and suggest contacting an administrator. This local reporting tool checks the actual catalogue and does not invoke or authorize the restricted AWS tool.
Do not attempt a call to an absent tool. Do not suggest AWS CLI or SDK commands as a workaround for a role restriction.
If a tool returns an authorization denial, do not retry it or switch tools to bypass the restriction.
Use read-only investigation tools unless the user explicitly requests a supported change.
Be concise, accurate, and actionable. Mention the time period and region used. Do not claim a tool ran without a result.
"""
    if 'billing' in categories:
        prompt += """
When investigating costs:
- Use the registered billing tools directly. Include explicit start/end dates and relevant services.
- Distinguish costs from usage quantities and state currency/units. Never invent figures.
"""
    if 'pricing' in categories:
        prompt += """
When using Pricing tools:
- Prefer registered pricingMcp tools for pricing lookups. Use exact names from the catalogue.
- Discover service codes, attributes, and filter values before requesting prices.
- Pricing region display names differ from AWS region codes; use the value the tool expects.
"""
    if 'cloudwatch' in categories:
        prompt += """
When using CloudWatch tools:
- Use registered tools for alarms, metrics, or logs. Specify the region, metric namespace, time range, and log group as applicable.
"""
    if 'cloudtrail' in categories:
        prompt += """
When using CloudTrail tools:
- Use registered tools for API event history. Specify the region and time range; filter by resource, event source, or user as appropriate.
"""
    if 'inventory' in categories:
        prompt += """
When using Inventory tools:
- Use registered tools for EKS, RDS/Aurora, OpenSearch, ElastiCache, and MSK inventory.
- Respect a requested region rather than scanning every region.
- Compare support dates with the current date above; dates already passed are not upcoming.
"""
    return prompt
