"""History HTTP contract against a DynamoDB test double, not handler internals."""
import importlib.util
import json
from pathlib import Path

import boto3
import pytest
from moto import mock_aws


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    monkeypatch.setenv('TABLE_NAME', 'history-test')
    with mock_aws():
        boto3.resource('dynamodb').create_table(
            TableName='history-test',
            KeySchema=[{'AttributeName': 'userId', 'KeyType': 'HASH'}, {'AttributeName': 'conversationId', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'userId', 'AttributeType': 'S'}, {'AttributeName': 'conversationId', 'AttributeType': 'S'}],
            BillingMode='PAY_PER_REQUEST',
        )
        spec = importlib.util.spec_from_file_location('rich_history_handler', Path(__file__).with_name('handler.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        def request(method, body=None, conversation_id=None, user='operator'):
            response = module.handler({
                'httpMethod': method,
                'resource': '/conversations/{conversationId}' if conversation_id else '/conversations',
                'pathParameters': {'conversationId': conversation_id} if conversation_id else {},
                'requestContext': {'authorizer': {'claims': {'sub': user}}},
                'body': json.dumps(body) if body is not None else None,
            }, None)
            return response['statusCode'], json.loads(response['body']) if response['body'] else None

        yield request


def test_chart_amount_roundtrips_through_history_http_api(api):
    _, conversation = api('POST', {})
    conversation_id = conversation['conversationId']
    message = {
        'id': 'answer-1', 'role': 'agent', 'content': 'Cost: 12.34 USD', 'timestamp': 1,
        'status': 'delivered', 'partsVersion': 1,
        'parts': [{'type': 'tool', 'toolCallId': 'cost-1', 'toolName': 'cost-explorer', 'status': 'completed',
                   'presentation': {'kind': 'chart', 'id': 'cost-1', 'title': 'Cost', 'unit': 'USD', 'xKey': 'label',
                                    'series': [{'key': 'amount', 'label': 'Cost (USD)'}], 'data': [{'label': '2026-10-01', 'amount': 12.34}]}}],
    }
    status, _ = api('PUT', {'messages': [message]}, conversation_id)
    assert status == 200
    status, reopened = api('GET', conversation_id=conversation_id)
    assert status == 200
    assert reopened['messages'] == [message]
    assert api('GET', conversation_id=conversation_id, user='different-user')[0] == 404


@pytest.mark.parametrize('preview', [
    {'kind': 'chart', 'id': 'x', 'title': 'Missing chart fields'},
    {'kind': 'table', 'id': 'x', 'title': 'Invalid', 'columns': [], 'data': []},
    {'kind': 'table', 'id': 'x', 'title': 'Extra', 'columns': [{'key': 'id', 'label': 'ID'}], 'data': [], 'raw': 'SECRET'},
    {'kind': 'chart', 'id': 'x', 'title': 'Cost', 'unit': 'USD', 'xKey': 'label',
     'series': [{'key': 'amount', 'label': 'Cost'}], 'data': [{'label': 'Day', 'amount': 'not a number'}]},
    {'kind': 'table', 'id': 'x', 'title': 'Hidden field', 'columns': [{'key': 'id', 'label': 'ID'}], 'data': [{'id': 'db', 'raw': 'SECRET'}]},
])
def test_rejects_invalid_or_extra_presentation_data(api, preview):
    _, conversation = api('POST', {})
    message = {'id': 'answer', 'role': 'agent', 'content': 'Fallback', 'timestamp': 1, 'status': 'delivered',
               'partsVersion': 1, 'parts': [{'type': 'tool', 'toolCallId': 'call', 'toolName': 'inventory', 'status': 'completed', 'presentation': preview}]}
    assert api('PUT', {'messages': [message]}, conversation['conversationId'])[0] == 400
    assert api('GET', conversation_id=conversation['conversationId'])[1]['messages'] == []


@pytest.mark.parametrize('fields', [
    {'timestamp': 'yesterday'}, {'timestamp': True}, {'timestamp': None},
    {'status': 'unknown'}, {'errorMessage': {'raw': 'PRIVATE'}},
    {'errorMessage': 'x' * 2001},
])
def test_rejects_messages_that_cannot_be_reopened(api, fields):
    _, conversation = api('POST', {})
    message = {'id': 'answer', 'role': 'agent', 'content': 'Answer', 'timestamp': 1, 'status': 'delivered', **fields}
    assert api('PUT', {'messages': [message]}, conversation['conversationId'])[0] == 400
    assert api('GET', conversation_id=conversation['conversationId'])[1]['messages'] == []


def test_empty_alarm_preview_roundtrips_with_its_explanation(api):
    _, conversation = api('POST', {})
    message = {'id': 'answer', 'role': 'agent', 'content': 'No active alarms.', 'timestamp': 1, 'status': 'delivered',
               'partsVersion': 1, 'parts': [{'type': 'tool', 'toolCallId': 'alarms', 'toolName': 'get_active_alarms', 'status': 'completed',
                   'presentation': {'kind': 'table', 'id': 'alarms', 'title': 'Active alarms', 'emptyMessage': 'No active alarms found.',
                                    'columns': [{'key': 'alarm_name', 'label': 'Alarm'}], 'data': []}}]}
    assert api('PUT', {'messages': [message]}, conversation['conversationId'])[0] == 200
    assert api('GET', conversation_id=conversation['conversationId'])[1]['messages'] == [message]


def test_raw_tool_output_roundtrips_and_remains_user_scoped(api):
    _, conversation = api('POST', {})
    output = {'json': json.dumps({'status': 'success', 'values': [12, 18], 'apiKey': '[REDACTED]'}),
              'redacted': True, 'truncated': False}
    message = {'id': 'answer', 'role': 'agent', 'content': 'Metrics returned', 'timestamp': 1, 'status': 'delivered',
               'partsVersion': 1, 'parts': [{'type': 'tool', 'toolCallId': 'metric', 'toolName': 'get_metric_data', 'status': 'completed', 'output': output}]}
    assert api('PUT', {'messages': [message]}, conversation['conversationId'])[0] == 200
    assert api('GET', conversation_id=conversation['conversationId'])[1]['messages'] == [message]
    assert api('GET', conversation_id=conversation['conversationId'], user='other-user')[0] == 404
    for invalid in [{**output, 'json': '{broken'}, {**output, 'json': '"' + 'x' * 24_001 + '"'},
                    {**output, 'redacted': 'yes'}, {**output, 'raw': 'unexpected'},
                    {**output, 'json': '{"value": NaN}'}, {**output, 'json': '{"value": Infinity}'}]:
        message['parts'][0]['output'] = invalid
        assert api('PUT', {'messages': [message]}, conversation['conversationId'])[0] == 400


def test_first_saved_prompt_names_the_conversation_and_preserves_a_custom_title(api):
    _, conversation = api('POST', {})
    identifier = conversation['conversationId']
    message = {'id': 'question', 'role': 'user', 'content': 'Help me investigate my AWS costs for the last 7 days.', 'timestamp': 1, 'status': 'sent'}
    status, saved = api('PUT', {'messages': [message]}, identifier)
    assert status == 200
    assert saved['conversationName'] == 'Help me investigate my AWS costs for the last 7 da…'
    assert api('GET', conversation_id=identifier)[1]['conversationName'] == saved['conversationName']
    api('PUT', {'conversationName': 'Weekly cost review'}, identifier)
    _, saved = api('PUT', {'messages': [{**message, 'id': 'followup', 'content': 'Compare last week'}]}, identifier)
    assert saved['conversationName'] == 'Weekly cost review'


@pytest.mark.parametrize('status', ['blocked', 'unavailable'])
def test_access_states_roundtrip_without_disclosing_other_users_history(api, status):
    _, conversation = api('POST', {})
    message = {'id': 'answer', 'role': 'agent', 'content': 'Access information', 'timestamp': 1,
               'status': 'restricted' if status == 'blocked' else 'delivered', 'partsVersion': 1,
               'parts': [{'type': 'tool', 'toolCallId': 'call', 'toolName': 'cloudwatchMcp___get_active_alarms', 'status': status}]}
    assert api('PUT', {'messages': [message]}, conversation['conversationId'])[0] == 200
    assert api('GET', conversation_id=conversation['conversationId'])[1]['messages'] == [message]
    assert api('GET', conversation_id=conversation['conversationId'], user='different-user')[0] == 404


def test_rejects_unbounded_or_executable_rich_history(api):
    _, conversation = api('POST', {})
    conversation_id = conversation['conversationId']
    message = {'id': 'answer', 'role': 'agent', 'content': 'Fallback', 'timestamp': 1, 'status': 'delivered',
               'partsVersion': 1, 'parts': [{'type': 'executable', 'script': 'alert(1)'}]}
    assert api('PUT', {'messages': [message]}, conversation_id)[0] == 400
    assert api('PUT', {'messages': [{**message, 'parts': [], 'content': 'x' * 150_000}]}, conversation_id)[0] == 400
    assert api('GET', conversation_id=conversation_id)[1]['messages'] == []
