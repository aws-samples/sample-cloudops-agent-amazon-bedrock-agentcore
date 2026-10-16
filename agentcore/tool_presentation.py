"""Project only known, bounded CloudOps result fields into presentation payloads."""
import json
import math
import re


RESOURCE_TOOLS = {
    'list_rds_instances', 'list_rds_clusters', 'list_eks_clusters',
    'list_msk_clusters', 'list_opensearch_domains', 'list_elasticache_clusters',
    'list_elasticache_replication_groups',
}
RESOURCE_FIELDS = {
    'identifier': 'Resource', 'name': 'Name', 'engine': 'Engine',
    'engine_version': 'Version', 'status': 'Status', 'region': 'Region',
    'end_of_standard_support': 'Standard support ends',
}


def present_tool_result(name, tool_id, result):
    """Unknown/error/oversized shapes have no preview; raw output stays server-side."""
    if result.get('status') != 'success':
        return None
    short_name = name.split('___')[-1].replace('-', '_')
    if short_name not in RESOURCE_TOOLS | {'cost_explorer', 'get_cost_and_usage', 'get_active_alarms'}:
        return None
    raw = result.get('structuredContent')
    if raw is None:
        content = result.get('content', [])
        if not isinstance(content, list) or len(content) > 1000:
            return None
        decoded = []
        size = 0
        for part in content:
            if not isinstance(part, dict):
                return None
            value = part.get('json')
            if value is None:
                text = part.get('text', '')
                if not isinstance(text, str):
                    return None
                size += len(text)
                if size > 200_000:
                    return None
                try:
                    value = json.loads(text)
                except (ValueError, TypeError):
                    return None
            decoded.append(value)
        raw = decoded[0] if len(decoded) == 1 else decoded
    if isinstance(raw, dict) and raw.get('status') == 'success':
        raw = raw.get('data')
    if short_name in {'cost_explorer', 'get_cost_and_usage'}:
        return cost_chart(tool_id, raw)
    if short_name == 'get_active_alarms':
        return alarm_table(tool_id, raw)
    # FastMCP may wrap non-object structured output in a result field.
    if isinstance(raw, dict) and isinstance(raw.get('result'), list):
        raw = raw['result']
    if isinstance(raw, dict) and any(key in raw for key in ('identifier', 'name', 'arn')):
        raw = [raw]
    if not isinstance(raw, list) or not all(isinstance(row, dict) for row in raw):
        return None
    keys = [key for key in RESOURCE_FIELDS if any(key in row for row in raw[:50])]
    if not keys:
        keys = ['identifier']
    rows = []
    for row in raw[:50]:
        rows.append({key: str(row.get(key, ''))[:500] for key in keys
                     if isinstance(row.get(key), (str, int, float, bool)) or row.get(key) is None})
    return {
        'kind': 'table', 'id': tool_id, 'title': 'Resources (first 50)' if len(raw) > 50 else 'Resources',
        'columns': [{'key': key, 'label': RESOURCE_FIELDS[key]} for key in keys], 'data': rows,
    }


def alarm_table(tool_id, raw):
    """CloudWatch MCP's ActiveAlarmsResponse, without raw reasons or dimensions."""
    if not isinstance(raw, dict) or not all(isinstance(raw.get(key), list) for key in ('metric_alarms', 'composite_alarms')):
        return None
    alarms = raw['metric_alarms'] + raw['composite_alarms']
    if not all(isinstance(alarm, dict) for alarm in alarms):
        return None
    fields = {'alarm_name': 'Alarm', 'state_value': 'State', 'namespace': 'Namespace',
              'metric_name': 'Metric', 'state_updated_timestamp': 'Updated'}
    rows = []
    for alarm in alarms[:50]:
        if not isinstance(alarm.get('alarm_name'), str) or not isinstance(alarm.get('state_value'), str):
            return None
        rows.append({key: value[:500] for key in fields if isinstance(value := alarm.get(key), str)})
    partial = len(alarms) > 50 or raw.get('has_more_results') is True
    return {
        'kind': 'table', 'id': tool_id, 'title': 'Active alarms (partial results)' if partial else 'Active alarms',
        'emptyMessage': 'No active alarms found.',
        'columns': [{'key': key, 'label': label} for key, label in fields.items()], 'data': rows,
    }


def cost_chart(tool_id, raw):
    """Only known Cost Explorer amount/unit fields; never guess units or parse prose."""
    if not isinstance(raw, dict) or not isinstance(raw.get('ResultsByTime'), list):
        return None
    rows = []
    unit = None
    try:
        for period in raw['ResultsByTime']:
            date = period['TimePeriod']['Start']
            groups = period.get('Groups') or [{'Keys': [], 'Metrics': period.get('Total', {})}]
            for group in groups:
                metrics = group['Metrics']
                metric = next((metrics[key] for key in ('UnblendedCost', 'AmortizedCost', 'BlendedCost') if key in metrics), None)
                if metric is None:
                    return None
                currency = metric['Unit']
                if not isinstance(currency, str) or not re.fullmatch(r'[A-Z]{3}', currency) or (unit and unit != currency):
                    return None
                unit = currency
                amount = float(metric['Amount'])
                if not math.isfinite(amount):
                    return None
                label = ' / '.join([date, *group.get('Keys', [])])[:200]
                rows.append({'label': label, 'amount': amount})
                # Decline larger charts rather than silently misrepresenting their totals.
                if len(rows) > 30:
                    return None
    except (KeyError, TypeError, ValueError, AttributeError, StopIteration):
        return None
    if not rows:
        return None
    return {
        'kind': 'chart', 'id': tool_id, 'title': 'Cost by period / service', 'unit': unit,
        'xKey': 'label', 'series': [{'key': 'amount', 'label': f'Cost ({unit})'}], 'data': rows,
    }
