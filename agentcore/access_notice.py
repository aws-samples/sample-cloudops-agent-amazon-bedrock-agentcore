"""Typed access notice from the discovered catalogue, not a synthetic policy decision."""
from types import ModuleType

CAPABILITIES = ('billing', 'pricing', 'cloudwatch', 'cloudtrail', 'inventory')


def create_access_notice_tool(tool_names):
    available = {
        capability for capability in CAPABILITIES
        if any(name.lower().startswith(capability + 'mcp___') for name in tool_names)
    }
    module = ModuleType('report_access_restricted')
    module.__file__ = __file__  # Strands recognizes module-based tools by this marker.
    module.TOOL_SPEC = {
        'name': 'report_access_restricted',
        'description': 'Report that a requested capability is absent from the current user-scoped catalogue. This reports availability only; it does not invoke or authorize an AWS tool.',
        'inputSchema': {'json': {
            'type': 'object',
            'properties': {'capability': {'type': 'string', 'enum': list(CAPABILITIES)}},
            'required': ['capability'],
            'additionalProperties': False,
        }},
    }

    def report_access_restricted(tool_use, **invocation_state):
        capability = tool_use.get('input', {}).get('capability')
        identifier = tool_use.get('toolUseId', '')
        if capability not in CAPABILITIES:
            return {'toolUseId': identifier, 'status': 'error', 'content': [{'text': 'Unknown capability'}]}
        # Never trust the model to decide permissions; check the actual catalogue.
        value = {'capability': capability, 'available': capability in available}
        if capability not in available:
            value['accessNotice'] = 'capability-unavailable'
        return {'toolUseId': identifier, 'status': 'success', 'content': [{'json': value}]}

    module.report_access_restricted = report_access_restricted
    return module
