"""The invocation boundary: stream real-shaped agent events, preserve legacy callers."""
import asyncio
import json

import pytest

from tests.test_agent_runtime_bugfix_unit import _import_agent_runtime, _make_jwt


@pytest.mark.parametrize('actor,allowed', [('admin-sub', ['billing', 'inventory']), ('nonadmin-sub', ['billing'])])
def test_streaming_preserves_identity_scoped_memory_and_gateway_catalogue(monkeypatch, actor, allowed):
    runtime = _import_agent_runtime()
    token = _make_jwt(actor)
    gateway_requests = []
    configured_agents = []

    class Gateway:
        def __init__(self, transport):
            self.transport = transport

        def __enter__(self):
            gateway_requests.append(self.transport())
            return self

        def __exit__(self, *args):
            return False

        def list_tools_sync(self, **kwargs):
            # Fake the external, identity-filtered Gateway response, not discovery logic.
            return allowed

    class Agent:
        def __init__(self, **kwargs):
            configured_agents.append(kwargs)

        async def stream_async(self, prompt):
            yield {'data': 'Allowed investigation'}
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'MCPClient', Gateway)
    monkeypatch.setattr(runtime, 'Agent', Agent)

    async def collect():
        return [item async for item in runtime.invoke({
            'prompt': 'Investigate', 'sessionId': 'session-1', 'accessToken': token,
            'userId': 'forged-other-user', 'role': 'Admin', 'responseMode': 'stream-v1',
        })]

    events = asyncio.run(collect())
    assert gateway_requests == [('bearer-transport', runtime.gateway_endpoint, token)]
    assert configured_agents[0]['tools'][:-1] == allowed
    assert configured_agents[0]['tools'][-1].__name__ == 'report_access_restricted'
    assert configured_agents[0]['session_manager'].config.actor_id == actor
    assert configured_agents[0]['session_manager'].config.session_id == 'session-1'
    assert configured_agents[0]['callback_handler'] is None
    assert events[-1]['type'] == 'run-complete'
    assert token not in json.dumps(events)
    assert 'forged-other-user' not in json.dumps(events)


def test_inventory_request_does_not_require_an_unregistered_search_tool(monkeypatch):
    runtime = _import_agent_runtime()
    configured = []

    class Gateway:
        def __init__(self, transport):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def list_tools_sync(self, **kwargs):
            return ['inventoryMcp___list_rds_instances']

    class Agent:
        def __init__(self, **kwargs):
            configured.append(kwargs)
        async def stream_async(self, prompt):
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'MCPClient', Gateway)
    monkeypatch.setattr(runtime, 'Agent', Agent)

    async def collect():
        return [item async for item in runtime.invoke({'prompt': 'List RDS instances in us-east-1', 'responseMode': 'stream-v1'})]

    asyncio.run(collect())
    assert configured[0]['tools'][:-1] == ['inventoryMcp___list_rds_instances']
    assert 'x_amz_bedrock_agentcore_search' not in configured[0]['system_prompt']
    assert 'already loaded' in configured[0]['system_prompt']


def test_nonadmin_prompt_describes_only_the_discovered_capabilities(monkeypatch):
    runtime = _import_agent_runtime()
    captured = []

    class Gateway:
        def __init__(self, transport):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def list_tools_sync(self, **kwargs):
            from types import SimpleNamespace
            return [SimpleNamespace(tool_name='billingMcp___cost-explorer')]

    class Agent:
        def __init__(self, **kwargs):
            captured.append(kwargs)
        async def stream_async(self, prompt):
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'MCPClient', Gateway)
    monkeypatch.setattr(runtime, 'Agent', Agent)
    async def collect():
        return [event async for event in runtime.invoke({'prompt': 'Check CloudWatch alarms', 'responseMode': 'stream-v1'})]
    asyncio.run(collect())
    prompt = captured[0]['system_prompt']
    assert 'CloudWatch Monitoring: Query metrics' not in prompt
    assert 'When using CloudWatch tools:' not in prompt
    assert 'When using Inventory tools:' not in prompt
    assert 'Unavailable for this request: CloudWatch, CloudTrail, Inventory, Pricing' in prompt
    assert 'billingMcp___cost-explorer' in prompt
    assert 'Do not suggest AWS CLI or SDK commands as a workaround' in prompt


@pytest.mark.parametrize('error,expected', [
    ('Tool Execution Denied: Tool call not allowed due to policy enforcement [denied by default]', 'access-denied'),
    ('Tool not found in registry: $MCP_TOOL_CLOUDWATCH_DESCRIBE_ALARMS', 'tool-unavailable'),
    ('Service temporarily unavailable', None),
])
def test_tool_failure_codes_distinguish_policy_denial_from_unavailable_and_service_error(monkeypatch, error, expected):
    runtime = _import_agent_runtime()
    class Agent:
        def __init__(self, **kwargs):
            pass
        async def stream_async(self, prompt):
            yield {'message': {'role': 'assistant', 'content': [{'toolUse': {'toolUseId': 'call-1', 'name': 'cloudwatchMcp___get_active_alarms', 'input': {}}}]}}
            yield {'message': {'role': 'user', 'content': [{'toolResult': {'toolUseId': 'call-1', 'status': 'error', 'content': [{'text': error}]}}]}}
            yield {'result': object()}
    monkeypatch.setattr(runtime, 'Agent', Agent)
    async def collect():
        return [event async for event in runtime.invoke({'prompt': 'Check alarms', 'responseMode': 'stream-v1'})]
    events = asyncio.run(collect())
    failed = next(event for event in events if event['type'] == 'tool-error')
    assert failed.get('code') == expected


def test_backend_stage_events_match_discovery_and_model_retry_boundaries(monkeypatch):
    runtime = _import_agent_runtime()
    connected = []

    class Gateway:
        def __init__(self, transport):
            pass
        def __enter__(self):
            connected.append(True)
            return self
        def __exit__(self, *args):
            return False
        def list_tools_sync(self, **kwargs):
            return []

    class Agent:
        def __init__(self, **kwargs):
            pass
        async def stream_async(self, prompt):
            yield {'start_event_loop': True}
            yield {'event_loop_throttled_delay': 8}
            yield {'data': 'Analysis received'}
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'MCPClient', Gateway)
    monkeypatch.setattr(runtime, 'Agent', Agent)

    async def collect():
        stream = runtime.invoke({'prompt': 'Investigate costs', 'responseMode': 'stream-v1'})
        start = await anext(stream)
        stage = await anext(stream)
        assert start['type'] == 'run-start'
        assert stage['type'] == 'run-stage' and stage['stage'] == 'discovering-tools'
        assert not connected
        remaining = [item async for item in stream]
        stages = [item['stage'] for item in remaining if item['type'] == 'run-stage']
        assert stages == ['waiting-model', 'model-retry']
        assert remaining[-1]['type'] == 'run-complete'

    asyncio.run(collect())


def test_absent_capability_notice_is_grounded_in_the_discovered_catalogue(monkeypatch):
    runtime = _import_agent_runtime()

    class Gateway:
        def __init__(self, transport):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def list_tools_sync(self, **kwargs):
            return ['billingMcp___cost-explorer']

    class Agent:
        def __init__(self, **kwargs):
            self.notice = next(tool for tool in kwargs['tools'] if getattr(tool, '__name__', '') == 'report_access_restricted')
        async def stream_async(self, prompt):
            yield {'message': {'role': 'assistant', 'content': [{'toolUse': {'toolUseId': 'notice', 'name': 'report_access_restricted', 'input': {'capability': 'cloudwatch'}}}]}}
            denied = self.notice.report_access_restricted({'toolUseId': 'notice', 'input': {'capability': 'cloudwatch'}})
            assert self.notice.report_access_restricted({'toolUseId': 'available', 'input': {'capability': 'billing'}})['content'][0]['json']['available'] is True
            yield {'message': {'role': 'user', 'content': [{'toolResult': {'toolUseId': 'notice', **denied}}]}}
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'MCPClient', Gateway)
    monkeypatch.setattr(runtime, 'Agent', Agent)
    async def collect():
        return [event async for event in runtime.invoke({'prompt': 'Check alarms', 'responseMode': 'stream-v1'})]
    events = asyncio.run(collect())
    notice = next(event for event in events if event['type'] == 'tool-complete')
    assert notice['code'] == 'capability-unavailable'
    assert notice['code'] != 'access-denied'
    assert json.loads(notice['output']['json'])['content'][0]['json']['capability'] == 'cloudwatch'


def test_streaming_error_is_sanitized_and_closes_the_client(monkeypatch):
    runtime = _import_agent_runtime()

    class Agent:
        def __init__(self, **kwargs):
            pass

        async def stream_async(self, prompt):
            yield {'data': 'Partial answer'}
            raise RuntimeError('AuthorizeActionException: bearer PRIVATE_TOKEN denied resource SECRET_RESOURCE')

    monkeypatch.setattr(runtime, 'Agent', Agent)

    async def collect():
        return [item async for item in runtime.invoke({'prompt': 'Inventory', 'responseMode': 'stream-v1'})]

    events = asyncio.run(collect())
    assert events[-1]['type'] == 'run-error'
    assert events[-1]['code'] == 'access-denied'
    assert 'PRIVATE_TOKEN' not in json.dumps(events)
    assert 'SECRET_RESOURCE' not in json.dumps(events)


@pytest.mark.parametrize('result', [
    {'status': 'error', 'content': [{'text': 'AuthorizeActionException PRIVATE_TOKEN'}]},
    {'status': 'success', 'content': [{'text': '{malformed PRIVATE_TOKEN'}]},
    {'status': 'success', 'content': [{'json': {'unsupported': 'PRIVATE_TOKEN'}}]},
])
def test_unavailable_tool_result_has_no_preview_and_denial_output_is_withheld(monkeypatch, result):
    runtime = _import_agent_runtime()

    class Agent:
        def __init__(self, **kwargs):
            pass

        async def stream_async(self, prompt):
            yield {'message': {'role': 'assistant', 'content': [
                {'toolUse': {'toolUseId': 'call-1', 'name': 'inventory___list_rds_instances', 'input': {}}},
            ]}}
            yield {'message': {'role': 'user', 'content': [{'toolResult': {'toolUseId': 'call-1', **result}}]}}
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'Agent', Agent)

    async def collect():
        return [item async for item in runtime.invoke({'prompt': 'Inventory', 'responseMode': 'stream-v1'})]

    events = asyncio.run(collect())
    assert events[-1]['type'] == 'run-complete'
    terminal = next(event for event in events if event['type'] in ('tool-complete', 'tool-error'))
    assert 'presentation' not in terminal
    if result['status'] == 'error':
        assert 'PRIVATE_TOKEN' not in json.dumps(events)
        assert terminal['output']['redacted'] is True
    else:
        assert json.loads(terminal['output']['json'])['content'] == result['content']


def test_legacy_request_still_returns_final_json():
    runtime = _import_agent_runtime()
    assert runtime.invoke({'prompt': 'Hello', 'sessionId': 'session-1'}) == {
        'result': 'ok', 'sessionId': 'session-1', 'userId': 'default_user',
    }


def test_incomplete_agent_result_does_not_claim_success(monkeypatch):
    runtime = _import_agent_runtime()

    class Agent:
        def __init__(self, **kwargs):
            pass

        async def stream_async(self, prompt):
            yield {'message': {'role': 'assistant', 'content': [{'toolUse': {'toolUseId': 'open', 'name': 'inventory', 'input': {}}}]}}
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'Agent', Agent)

    async def collect():
        return [item async for item in runtime.invoke({'prompt': 'Inventory', 'responseMode': 'stream-v1'})]

    events = asyncio.run(collect())
    assert events[-1]['type'] == 'run-error'
    assert events[-1]['code'] == 'incomplete'


@pytest.mark.parametrize('shape', ['structured', 'text-blocks', 'single-text-block'])
def test_fastmcp_inventory_shapes_are_rendered(monkeypatch, shape):
    runtime = _import_agent_runtime()
    row = {'identifier': 'orders-db', 'engine': 'postgres', 'private': 'SECRET'}
    result = {'status': 'success', 'content': [{'text': json.dumps(row)}]}
    if shape == 'structured':
        result['structuredContent'] = {'result': [row]}
    elif shape == 'text-blocks':
        result['content'].append({'text': json.dumps({**row, 'identifier': 'analytics-db'})})

    class Agent:
        def __init__(self, **kwargs):
            pass

        async def stream_async(self, prompt):
            yield {'message': {'role': 'assistant', 'content': [{'toolUse': {'toolUseId': 'call-1', 'name': 'inventory___list_rds_instances', 'input': {}}}]}}
            yield {'message': {'role': 'user', 'content': [{'toolResult': {'toolUseId': 'call-1', **result}}]}}
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'Agent', Agent)

    async def collect():
        return [item async for item in runtime.invoke({'prompt': 'Inventory', 'responseMode': 'stream-v1'})]

    events = asyncio.run(collect())
    terminal = next(event for event in events if event['type'] == 'tool-complete')
    assert terminal['presentation']['data'][0]['identifier'] == 'orders-db'
    assert 'SECRET' not in json.dumps(terminal['presentation'])
    assert 'SECRET' in terminal['output']['json']  # Non-credential tool fields remain inspectable.


def test_streams_text_before_completion_and_keeps_mcp_open(monkeypatch):
    runtime = _import_agent_runtime()
    lifecycle = []

    class Client:
        def __init__(self, factory):
            self.factory = factory

        def __enter__(self):
            lifecycle.append('open')
            return self

        def __exit__(self, *args):
            lifecycle.append('closed')

        def list_tools_sync(self, **kwargs):
            return []

    class Agent:
        def __init__(self, **kwargs):
            pass

        async def stream_async(self, prompt):
            assert lifecycle == ['open']
            yield {'data': 'Checking resources.'}
            assert lifecycle == ['open']
            yield {'reasoning': True, 'reasoningText': 'private reasoning'}
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'MCPClient', Client)
    monkeypatch.setattr(runtime, 'Agent', Agent)

    async def collect():
        stream = runtime.invoke({'prompt': 'Inventory', 'sessionId': 'session-1', 'responseMode': 'stream-v1'})
        start = await anext(stream)
        assert start['type'] == 'run-start'
        discovery = await anext(stream)
        waiting = await anext(stream)
        assert discovery['stage'] == 'discovering-tools'
        assert waiting['stage'] == 'waiting-model'
        text = await anext(stream)
        assert text['type'] == 'text-delta'
        assert text['text'] == 'Checking resources.'
        assert lifecycle == ['open']
        rest = [event async for event in stream]
        assert [event['type'] for event in rest] == ['run-complete']
        assert lifecycle == ['open', 'closed']
        assert [start['sequence'], discovery['sequence'], waiting['sequence'], text['sequence'], rest[0]['sequence']] == [0, 1, 2, 3, 4]
        assert start['runId'] == text['runId'] == rest[0]['runId']

    asyncio.run(collect())


def test_tool_lifecycle_uses_messages_and_only_allowlisted_resource_fields(monkeypatch):
    runtime = _import_agent_runtime()

    class Agent:
        def __init__(self, **kwargs):
            pass

        async def stream_async(self, prompt):
            yield {'message': {'role': 'assistant', 'content': [
                {'toolUse': {'toolUseId': 'call-1', 'name': 'inventory___list_rds_instances', 'input': {'private': 'do not emit'}}},
            ]}}
            yield {'message': {'role': 'user', 'content': [
                {'toolResult': {'toolUseId': 'call-1', 'status': 'success', 'content': [{'text': json.dumps([
                    {'identifier': 'orders-db', 'engine': 'postgres', 'status': 'available', 'region': 'us-east-1', 'secret': 'never display'},
                ])}]}},
            ]}}
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'Agent', Agent)

    async def collect():
        return [item async for item in runtime.invoke({'prompt': 'List databases', 'responseMode': 'stream-v1'})]

    events = asyncio.run(collect())
    lifecycle = [event for event in events if event['type'] != 'run-stage']
    assert [item['type'] for item in lifecycle] == ['run-start', 'tool-start', 'tool-complete', 'run-complete']
    assert lifecycle[1]['toolCallId'] == lifecycle[2]['toolCallId'] == 'call-1'
    assert lifecycle[2]['presentation']['kind'] == 'table'
    assert lifecycle[2]['presentation']['data'][0]['identifier'] == 'orders-db'
    assert 'never display' not in json.dumps(events)
    assert 'do not emit' not in json.dumps(events)


@pytest.mark.parametrize('alarms', [[], [
    {'alarm_name': 'cpu-high', 'state_value': 'ALARM', 'namespace': 'AWS/EC2', 'metric_name': 'CPUUtilization',
     'state_updated_timestamp': '2026-10-14T10:00:00Z', 'state_reason': 'PRIVATE_RAW_REASON'},
]])
def test_active_alarms_have_a_safe_structured_preview(monkeypatch, alarms):
    runtime = _import_agent_runtime()

    class Agent:
        def __init__(self, **kwargs):
            pass
        async def stream_async(self, prompt):
            yield {'message': {'role': 'assistant', 'content': [
                {'toolUse': {'toolUseId': 'alarms-1', 'name': 'cloudwatchMcp___get_active_alarms', 'input': {}}},
            ]}}
            yield {'message': {'role': 'user', 'content': [
                {'toolResult': {'toolUseId': 'alarms-1', 'status': 'success', 'structuredContent': {
                    'metric_alarms': alarms, 'composite_alarms': [], 'has_more_results': False,
                }, 'content': []}},
            ]}}
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'Agent', Agent)
    async def collect():
        return [event async for event in runtime.invoke({'prompt': 'Check alarms', 'responseMode': 'stream-v1'})]
    events = asyncio.run(collect())
    terminal = next(event for event in events if event['type'] == 'tool-complete')
    preview = terminal['presentation']
    assert preview['kind'] == 'table'
    assert preview['title'] == 'Active alarms'
    assert preview['emptyMessage'] == 'No active alarms found.'
    assert len(preview['data']) == len(alarms)
    if alarms:
        assert preview['data'][0]['alarm_name'] == 'cpu-high'
        assert preview['data'][0]['state_value'] == 'ALARM'
    assert 'PRIVATE_RAW_REASON' not in json.dumps(preview)
    if alarms:
        assert 'PRIVATE_RAW_REASON' in terminal['output']['json']


def test_tool_output_is_inspectable_json_with_credentials_redacted(monkeypatch):
    runtime = _import_agent_runtime()
    payload = {'metric': 'CPUUtilization', 'values': [12, 18],
               'credentials': {'accessKeyId': 'AKIA_TEST_SECRET', 'secretAccessKey': 'SECRET_VALUE'},
               'access_token': 'TOKEN_VALUE'}

    class Agent:
        def __init__(self, **kwargs):
            pass
        async def stream_async(self, prompt):
            yield {'message': {'role': 'assistant', 'content': [
                {'toolUse': {'toolUseId': 'metric-1', 'name': 'cloudwatchMcp___get_metric_data', 'input': {}}},
            ]}}
            yield {'message': {'role': 'user', 'content': [
                {'toolResult': {'toolUseId': 'metric-1', 'status': 'success', 'content': [{'text': json.dumps(payload)}]}},
            ]}}
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'Agent', Agent)
    async def collect():
        return [event async for event in runtime.invoke({'prompt': 'Check CPU', 'responseMode': 'stream-v1'})]
    events = asyncio.run(collect())
    output = next(event['output'] for event in events if event['type'] == 'tool-complete')
    decoded = json.loads(output['json'])
    assert json.loads(decoded['content'][0]['text'])['values'] == [12, 18]
    assert output['redacted'] is True
    assert output['truncated'] is False
    assert 'SECRET_VALUE' not in json.dumps(events)
    assert 'TOKEN_VALUE' not in json.dumps(events)
    assert 'AKIA_TEST_SECRET' not in json.dumps(events)


@pytest.mark.parametrize('payload', [
    {'large': 'x' * 100_000, 'password': 'DO_NOT_DISCLOSE'},
    {'values': [{'value': index, 'sessionToken': 'DO_NOT_DISCLOSE'} for index in range(500)]},
    {'message': 'Authorization: Bearer eyJabc.def.signature', 'url': 'https://example.test/?X-Amz-Signature=DO_NOT_DISCLOSE'},
    {'text': json.dumps({'payload': 'x' * 210_000, 'access_token': 'DO_NOT_DISCLOSE'})},
])
def test_raw_output_limits_are_explicit_and_do_not_leak_credentials(monkeypatch, payload):
    runtime = _import_agent_runtime()
    class Agent:
        def __init__(self, **kwargs):
            pass
        async def stream_async(self, prompt):
            yield {'message': {'role': 'assistant', 'content': [{'toolUse': {'toolUseId': 'large', 'name': 'get_metric_data', 'input': {}}}]}}
            yield {'message': {'role': 'user', 'content': [{'toolResult': {'toolUseId': 'large', 'status': 'success', 'structuredContent': payload}}]}}
            yield {'result': object()}
    monkeypatch.setattr(runtime, 'Agent', Agent)
    async def collect():
        return [event async for event in runtime.invoke({'prompt': 'Inspect', 'responseMode': 'stream-v1'})]
    events = asyncio.run(collect())
    output = next(event['output'] for event in events if event['type'] == 'tool-complete')
    json.loads(output['json'])
    assert len(output['json']) <= 24_000
    assert output['redacted'] is True
    assert 'DO_NOT_DISCLOSE' not in json.dumps(events)
    assert 'eyJabc.def.signature' not in json.dumps(events)
    if 'message' not in payload:
        assert output['truncated'] is True
    assert events[-1]['type'] == 'run-complete'


def test_cost_explorer_result_becomes_a_labeled_chart(monkeypatch):
    runtime = _import_agent_runtime()

    class Agent:
        def __init__(self, **kwargs):
            pass

        async def stream_async(self, prompt):
            yield {'message': {'role': 'assistant', 'content': [
                {'toolUse': {'toolUseId': 'cost-1', 'name': 'billing___cost_explorer', 'input': {}}},
            ]}}
            yield {'message': {'role': 'user', 'content': [
                {'toolResult': {'toolUseId': 'cost-1', 'status': 'success', 'content': [{'json': {
                    'status': 'success', 'data': {'ResultsByTime': [
                        {'TimePeriod': {'Start': '2026-10-01', 'End': '2026-10-02'}, 'Total': {'UnblendedCost': {'Amount': '12.34', 'Unit': 'USD'}}},
                    ]},
                }}]}},
            ]}}
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'Agent', Agent)

    async def collect():
        return [item async for item in runtime.invoke({'prompt': 'Daily cost', 'responseMode': 'stream-v1'})]

    events = asyncio.run(collect())
    assert next(event['presentation'] for event in events if event['type'] == 'tool-complete') == {
        'kind': 'chart', 'id': 'cost-1', 'title': 'Cost by period / service', 'unit': 'USD',
        'xKey': 'label', 'series': [{'key': 'amount', 'label': 'Cost (USD)'}],
        'data': [{'label': '2026-10-01', 'amount': 12.34}],
    }
