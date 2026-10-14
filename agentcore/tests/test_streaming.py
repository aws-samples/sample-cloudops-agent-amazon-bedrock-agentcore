"""Entrypoint/SDK contract tests; no AWS resources or model invocations."""

import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from streaming import presentation

from .test_agent_runtime import _stubbed_sys_modules


@pytest.fixture
def runtime(monkeypatch):
    path = Path(__file__).parents[1] / "agent_runtime.py"
    spec = importlib.util.spec_from_file_location("test_stream_runtime", path)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    with _stubbed_sys_modules():
        spec.loader.exec_module(module)
    clients, agents, memories = [], [], []

    class Client:
        def __init__(self, token):
            self.token, self.open = token, False
            clients.append(self)

        def __enter__(self):
            self.open = True
            return self

        def __exit__(self, *args):
            self.open = False

    class Agent:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            agents.append(self)

        def __call__(self, prompt):
            assert clients[-1].open
            return "Legacy answer"

        async def stream_async(self, prompt):
            for event in module.source:
                assert clients[-1].open
                if isinstance(event, Exception):
                    raise event
                if "before_tool_call" in event:
                    await self.kwargs["hooks"][0].before(
                        SimpleNamespace(tool_use=event["before_tool_call"])
                    )
                elif "after_tool_call" in event:
                    await self.kwargs["hooks"][0].after(
                        SimpleNamespace(result=event["after_tool_call"], retry=False)
                    )
                else:
                    yield event
                await asyncio.sleep(0)

    module.source = [{"data": "Hello 🌍"}, {"result": object()}]
    monkeypatch.setattr(module, "build_mcp_client_for_token", Client)
    monkeypatch.setattr(
        module, "list_tools_with_pagination", lambda client: ["role-filtered-tool"]
    )
    monkeypatch.setattr(module, "Agent", Agent)
    monkeypatch.setattr(module, "MEMORY_ID", "test-memory")
    monkeypatch.setattr(
        module, "AgentCoreMemoryConfig", lambda **kw: memories.append(kw) or kw
    )
    monkeypatch.setattr(module, "AgentCoreMemorySessionManager", lambda **kw: kw)
    return SimpleNamespace(
        module=module, clients=clients, agents=agents, memories=memories
    )


def payload(**kw):
    return {
        "prompt": "Inspect resources",
        "sessionId": "test-session",
        "responseMode": "stream-v1",
        **kw,
    }


async def collect(runtime, **kw):
    return [event async for event in runtime.module.invoke(payload(**kw))]


@pytest.mark.asyncio
async def test_stream_order_identity_memory_and_connection_lifetime(runtime):
    events = await collect(runtime)
    assert [e["type"] for e in events] == ["run-start", "text-delta", "run-complete"]
    assert [e["sequence"] for e in events] == [1, 2, 3]
    assert len({e["runId"] for e in events}) == 1
    assert len({e["messageId"] for e in events}) == 1
    assert not runtime.clients[0].open
    assert runtime.agents[0].kwargs["tools"] == ["role-filtered-tool"]
    assert runtime.agents[0].kwargs["callback_handler"] is None
    assert runtime.memories[0]["actor_id"] == runtime.module.TOKENLESS_MEMORY_ACTOR_ID


@pytest.mark.asyncio
async def test_users_forward_distinct_tokens_and_memory_actors(runtime):
    import base64

    for sub in ("alice", "bob"):
        token = (
            "x."
            + base64.urlsafe_b64encode(json.dumps({"sub": sub}).encode())
            .decode()
            .rstrip("=")
            + ".x"
        )
        await collect(runtime, accessToken=token, userId="spoofed")
        assert runtime.clients[-1].token == token
        assert runtime.memories[-1]["actor_id"] == sub
    assert len(runtime.clients) == 2


@pytest.mark.asyncio
async def test_real_tool_transitions_and_safe_selected_results(runtime):
    result = {
        "toolUseId": "t1",
        "status": "success",
        "content": [
            {
                "text": '[{"name":"cluster-a","region":"us-east-1","secret":"not displayed"}]'
            }
        ],
    }
    runtime.module.source = [
        {
            "current_tool_use": {
                "toolUseId": "t1",
                "name": "inventory___list_eks_clusters",
                "input": "private argument",
            }
        },
        {
            "before_tool_call": {
                "toolUseId": "t1",
                "name": "inventory___list_eks_clusters",
                "input": "private argument",
            }
        },
        {"after_tool_call": result},
        {"message": {"content": [{"toolResult": result}]}},
        {"reasoningText": "private reasoning", "reasoning": True},
        {"data": "Done"},
        {"result": object()},
    ]
    events = await collect(runtime)
    assert [e["type"] for e in events] == [
        "run-start",
        "tool-start",
        "tool-complete",
        "text-delta",
        "run-complete",
    ]
    assert events[2]["presentation"] == {
        "kind": "resources",
        "rows": [{"name": "cluster-a", "region": "us-east-1"}],
    }
    assert "private" not in json.dumps(events)
    assert "secret" not in json.dumps(events)


@pytest.mark.asyncio
async def test_zero_argument_tool_and_failed_output_are_safe(runtime):
    runtime.module.source = [
        {
            "message": {
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": "t1",
                            "name": "inventory___list_eks_clusters",
                            "input": {},
                        }
                    }
                ]
            }
        },
        {
            "before_tool_call": {
                "toolUseId": "t1",
                "name": "inventory___list_eks_clusters",
                "input": {},
            }
        },
        {
            "after_tool_call": {
                "toolUseId": "t1",
                "status": "error",
                "content": [{"text": "secret denied payload"}],
            }
        },
        {"result": object()},
    ]
    events = await collect(runtime)
    assert events[2]["type"] == "tool-failure"
    assert "secret" not in json.dumps(events)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source",
    [
        [],
        [{"data": "Partial"}],
        [RuntimeError("secret exception")],
        [RuntimeError("AuthorizeActionException secret")],
    ],
)
async def test_failure_or_eof_never_claims_success_or_echoes_exception(runtime, source):
    runtime.module.source = source
    events = await collect(runtime)
    assert events[-1]["type"] == "run-failure"
    assert "run-complete" not in [e["type"] for e in events]
    assert "secret" not in json.dumps(events)
    assert not runtime.clients[-1].open


@pytest.mark.asyncio
async def test_close_generator_closes_request_mcp_connection(runtime):
    stream = runtime.module.invoke(payload())
    await anext(stream)
    await anext(stream)
    assert runtime.clients[-1].open
    await stream.aclose()
    assert not runtime.clients[-1].open


def test_legacy_result_shape_is_unchanged(runtime):
    result = runtime.module.invoke(
        {"prompt": "Hello", "sessionId": "session", "userId": "unused"}
    )
    assert result == {
        "result": "Legacy answer",
        "sessionId": "session",
        "userId": "unused",
    }


def test_installed_agentcore_sdk_frames_stream_and_preserves_legacy_json(runtime):
    from bedrock_agentcore.runtime import BedrockAgentCoreApp
    from starlette.testclient import TestClient

    app = BedrockAgentCoreApp()
    app.entrypoint(runtime.module.invoke)
    with TestClient(app) as client:
        response = client.post("/invocations", json=payload())
        assert response.headers["content-type"].startswith("text/event-stream")
        events = [
            json.loads(frame.removeprefix("data: "))
            for frame in response.text.strip().split("\n\n")
        ]
        assert events[-1]["type"] == "run-complete"
        response = client.post("/invocations", json={"prompt": "Hello"})
        assert response.headers["content-type"].startswith("application/json")
        assert response.json()["result"] == "Legacy answer"


@pytest.mark.parametrize(
    "value", [None, "not json", "{}", '[{"name": {"html":"<script>"}}]']
)
def test_unknown_or_invalid_presentation_is_not_echoed(value):
    assert presentation("list_eks_clusters", [{"text": value}]) is None


def test_cost_contract_and_mixed_currency_fallback():
    value = {
        "ResultsByTime": [
            {
                "TimePeriod": {"Start": "2026-01-01"},
                "Total": {"UnblendedCost": {"Amount": "12.5", "Unit": "USD"}},
            }
        ]
    }
    view = presentation("cost___get_cost_and_usage", [{"text": json.dumps(value)}])
    assert view == {
        "kind": "costs",
        "unit": "USD",
        "points": [{"label": "2026-01-01", "value": 12.5}],
    }
    value["ResultsByTime"][0]["Total"]["UnblendedCost"]["Amount"] = "NaN"
    assert presentation("get_cost_and_usage", [{"text": json.dumps(value)}]) is None


@pytest.mark.parametrize("structured", [False, True])
def test_installed_fastmcp_strands_inventory_conversion(structured):
    from mcp.server.fastmcp.utilities.func_metadata import _convert_to_content
    from mcp.types import CallToolResult
    from strands.tools.mcp import MCPClient

    rows = [
        {"name": "cluster-a", "region": "us-east-1"},
        {"name": "cluster-b", "region": "us-west-2"},
    ]
    result = CallToolResult(
        content=_convert_to_content(rows),
        structuredContent={"result": rows} if structured else None,
    )
    mapped = MCPClient(lambda: None)._handle_tool_result("t1", result)
    assert presentation(
        "inventory___list_eks_clusters",
        mapped["content"],
        mapped.get("structuredContent"),
    ) == {"kind": "resources", "rows": rows}


def test_pinned_billing_mcp_success_envelope_and_offloaded_fallback():
    value = {
        "status": "success",
        "data": {
            "ResultsByTime": [
                {
                    "TimePeriod": {"Start": "2026-01-01"},
                    "Total": {"UnblendedCost": {"Amount": "12.5", "Unit": "USD"}},
                }
            ]
        },
    }
    assert (
        presentation("billing___cost-explorer", [{"text": json.dumps(value)}])[
            "points"
        ][0]["value"]
        == 12.5
    )
    value["data"] = {"data_stored": True, "table_name": "private"}
    assert (
        presentation("billing___cost-explorer", [{"text": json.dumps(value)}]) is None
    )


@pytest.mark.parametrize(
    "name,field",
    [
        ("list_rds_instances", "identifier"),
        ("list_msk_clusters", "cluster_name"),
        ("list_elasticache_clusters", "cluster_id"),
        ("list_opensearch_domains", "domain_name"),
    ],
)
def test_inventory_identifier_fields(name, field):
    assert presentation(
        name, [{"text": json.dumps({field: "resource-a", "secret": "excluded"})}]
    ) == {"kind": "resources", "rows": [{"name": "resource-a"}]}


@pytest.mark.asyncio
async def test_installed_strands_agent_emits_actual_tool_hook_boundaries(
    runtime, monkeypatch
):
    from strands import Agent, tool
    from strands.models.model import Model

    class OfflineModel(Model):
        def update_config(self, **kwargs):
            pass

        def get_config(self):
            return {"model_id": "offline-contract-model"}

        async def structured_output(self, *args, **kwargs):
            raise AssertionError("Not used")
            yield  # pragma: no cover

        async def stream(self, messages, *args, **kwargs):
            has_result = any(
                "toolResult" in block
                for message in messages
                for block in message["content"]
            )
            yield {"messageStart": {"role": "assistant"}}
            if not has_result:
                yield {
                    "contentBlockStart": {
                        "contentBlockIndex": 0,
                        "start": {
                            "toolUse": {
                                "toolUseId": "offline-tool",
                                "name": "list_eks_clusters",
                            }
                        },
                    }
                }
                yield {
                    "contentBlockDelta": {
                        "contentBlockIndex": 0,
                        "delta": {"toolUse": {"input": "{}"}},
                    }
                }
            else:
                yield {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}}
                yield {
                    "contentBlockDelta": {
                        "contentBlockIndex": 0,
                        "delta": {"text": "Done"},
                    }
                }
            yield {"contentBlockStop": {"contentBlockIndex": 0}}
            yield {
                "messageStop": {"stopReason": "end_turn" if has_result else "tool_use"}
            }
            yield {
                "metadata": {
                    "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
                    "metrics": {"latencyMs": 0},
                }
            }

    @tool
    def list_eks_clusters() -> str:
        """Return offline inventory fixture data."""
        assert runtime.clients[-1].open
        return json.dumps([{"name": "offline-cluster"}])

    monkeypatch.setattr(runtime.module, "Agent", Agent)
    monkeypatch.setattr(runtime.module, "model", OfflineModel())
    monkeypatch.setattr(runtime.module, "MEMORY_ID", None)
    monkeypatch.setattr(
        runtime.module, "list_tools_with_pagination", lambda client: [list_eks_clusters]
    )
    events = await collect(runtime)
    assert [event["type"] for event in events] == [
        "run-start",
        "tool-start",
        "tool-complete",
        "text-delta",
        "run-complete",
    ]
    assert events[2]["presentation"] == {
        "kind": "resources",
        "rows": [{"name": "offline-cluster"}],
    }
    assert events[3]["text"] == "Done"
    assert not runtime.clients[-1].open
