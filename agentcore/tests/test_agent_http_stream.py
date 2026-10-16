"""Verify the real AgentCore SDK's HTTP framing, with no model or AWS calls."""
import json

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from starlette.testclient import TestClient

from tests.test_agent_runtime_bugfix_unit import _import_agent_runtime


def test_access_notice_executes_through_real_strands_and_agentcore_http(monkeypatch):
    from strands.tools.registry import ToolRegistry

    runtime = _import_agent_runtime()

    class Agent:
        def __init__(self, **kwargs):
            self.registry = ToolRegistry()
            self.registry.process_tools([kwargs['tools'][-1]])

        async def stream_async(self, prompt):
            use = {'toolUseId': 'notice-1', 'name': 'report_access_restricted', 'input': {'capability': 'cloudwatch'}}
            yield {'message': {'role': 'assistant', 'content': [{'toolUse': use}]}}
            registered = self.registry.registry['report_access_restricted']
            async for item in registered.stream(use, {}):
                yield {'message': {'role': 'user', 'content': [{'toolResult': item['tool_result']}]}}
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'Agent', Agent)
    app = BedrockAgentCoreApp()
    app.entrypoint(runtime.invoke)
    with TestClient(app) as client:
        response = client.post('/invocations', json={'prompt': 'Check alarms', 'responseMode': 'stream-v1'})
        events = [json.loads(frame.removeprefix('data: ')) for frame in response.text.strip().split('\n\n')]
        terminal = next(event for event in events if event['type'] == 'tool-complete')
        assert terminal['code'] == 'capability-unavailable'
        assert events[-1]['type'] == 'run-complete'


def test_agentcore_sdk_preserves_json_and_frames_opt_in_events(monkeypatch):
    runtime = _import_agent_runtime()

    class Agent:
        def __init__(self, **kwargs):
            pass

        def __call__(self, prompt):
            return 'Legacy answer'

        async def stream_async(self, prompt):
            yield {'data': 'Streamed answer'}
            yield {'result': object()}

    monkeypatch.setattr(runtime, 'Agent', Agent)
    app = BedrockAgentCoreApp()
    app.entrypoint(runtime.invoke)
    with TestClient(app) as client:
        legacy = client.post('/invocations', json={'prompt': 'hello'})
        assert legacy.headers['content-type'].startswith('application/json')
        assert legacy.json()['result'] == 'Legacy answer'
        response = client.post('/invocations', json={'prompt': 'hello', 'responseMode': 'stream-v1'})
        assert response.headers['content-type'].startswith('text/event-stream')
        events = [json.loads(frame.removeprefix('data: ')) for frame in response.text.strip().split('\n\n')]
        assert [event['type'] for event in events] == ['run-start', 'run-stage', 'run-stage', 'text-delta', 'run-complete']
        assert [event['stage'] for event in events if event['type'] == 'run-stage'] == ['discovering-tools', 'waiting-model']
        assert events[3]['text'] == 'Streamed answer'
