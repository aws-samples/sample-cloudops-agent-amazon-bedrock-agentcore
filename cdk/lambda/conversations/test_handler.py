"""History request boundary tests for optional rich result snapshots."""

import decimal
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

CONVERSATION = "11111111-1111-4111-8111-111111111111"


@pytest.fixture
def history(monkeypatch):
    table = Mock()
    item = {"userId": "alice", "conversationId": CONVERSATION, "messages": []}
    table.get_item.return_value = {"Item": item}
    table.update_item.return_value = {"Attributes": item}
    monkeypatch.setitem(
        sys.modules,
        "boto3",
        SimpleNamespace(
            resource=lambda service: SimpleNamespace(Table=lambda name: table)
        ),
    )
    spec = importlib.util.spec_from_file_location(
        "history_contract_test", Path(__file__).with_name("handler.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, table, item


def request(messages, sub="alice"):
    return {
        "httpMethod": "PUT",
        "resource": "/conversations/{conversationId}",
        "requestContext": {"authorizer": {"claims": {"sub": sub}}},
        "pathParameters": {"conversationId": CONVERSATION},
        "body": json.dumps({"messages": messages}),
    }


def message(**kw):
    return {
        "id": "answer-1",
        "role": "agent",
        "content": "Answer",
        "timestamp": 1,
        "status": "delivered",
        **kw,
    }


def tool(**kw):
    return {"id": "tool-1", "name": "cost-explorer", "status": "completed", **kw}


def test_legacy_and_rich_snapshots_use_authenticated_partition_and_no_upsert(history):
    module, table, _ = history
    assert module.handler(request([message()]), None)["statusCode"] == 200
    call = table.update_item.call_args.kwargs
    assert call["Key"] == {"userId": "alice", "conversationId": CONVERSATION}
    assert (
        call["ConditionExpression"]
        == "attribute_exists(userId) AND attribute_exists(conversationId)"
    )


def test_cost_decimals_survive_request_parsing_for_dynamodb(history):
    module, table, _ = history
    rich = tool(
        presentation={
            "kind": "costs",
            "unit": "USD",
            "points": [{"label": "2026-01-01", "value": 12.5}],
        }
    )
    result = module.handler(request([message(partsVersion=1, tools=[rich])]), None)
    assert result["statusCode"] == 200
    stored = table.update_item.call_args.kwargs["ExpressionAttributeValues"][
        ":messages"
    ][0]
    assert stored["tools"][0]["presentation"]["points"][0]["value"] == decimal.Decimal(
        "12.5"
    )


@pytest.mark.parametrize(
    "rich",
    [
        tool(status="running"),
        tool(secret="never store"),
        tool(presentation={"kind": "html", "html": "<script>alert(1)</script>"}),
        tool(
            presentation={
                "kind": "resources",
                "rows": [{"name": "ok", "secret": "excluded"}],
            }
        ),
        tool(
            presentation={
                "kind": "costs",
                "unit": "USD",
                "points": [{"label": "bad", "value": float("nan")}],
            }
        ),
        tool(
            presentation={
                "kind": "costs",
                "unit": "USD",
                "points": [{"label": "bad", "value": True}],
            }
        ),
    ],
)
def test_invalid_presentation_is_not_persisted(history, rich):
    module, table, _ = history
    assert (
        module.handler(request([message(partsVersion=1, tools=[rich])]), None)[
            "statusCode"
        ]
        == 400
    )
    table.update_item.assert_not_called()


def test_oversized_snapshot_and_full_history_are_non_destructive(history):
    module, table, item = history
    assert (
        module.handler(request([message(content="x" * 170_000)]), None)["statusCode"]
        == 413
    )
    item["messages"] = [message(content="x" * 339_000)]
    assert (
        module.handler(request([message(content="x" * 2000)]), None)["statusCode"]
        == 413
    )
    table.update_item.assert_not_called()


def test_different_user_cannot_append_and_deleted_record_is_not_recreated(history):
    module, table, _ = history
    assert module.handler(request([message()], sub="bob"), None)["statusCode"] == 403
    table.update_item.assert_not_called()
    table.get_item.return_value = {}
    assert module.handler(request([message()]), None)["statusCode"] == 404
    table.update_item.assert_not_called()
