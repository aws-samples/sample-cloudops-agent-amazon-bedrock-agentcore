"""
Conversation history Lambda handler.
Handles CRUD operations for conversation records in DynamoDB.
"""

import json
import os
import re
import uuid
import decimal
from datetime import datetime, timezone

import boto3

# UUID v4 format validation pattern
UUID_V4_PATTERN = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    re.IGNORECASE
)

# DynamoDB resource
dynamodb = boto3.resource('dynamodb')
TABLE_NAME = os.environ.get('TABLE_NAME', 'CloudOpsConversationsTable')
table = dynamodb.Table(TABLE_NAME)

# CORS headers included on every response
CORS_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
}


class DecimalEncoder(json.JSONEncoder):
    """Custom JSON encoder that converts Decimal to int or float."""

    def default(self, o):
        if isinstance(o, decimal.Decimal):
            if o % 1 == 0:
                return int(o)
            return float(o)
        return super().default(o)


def json_response(status_code, body=None):
    """Build a standard API Gateway response dict."""
    response = {
        'statusCode': status_code,
        'headers': CORS_HEADERS,
    }
    if body is not None:
        response['body'] = json.dumps(body, cls=DecimalEncoder)
    else:
        response['body'] = ''
    return response


def handler(event, context):
    """Entry point — routes by HTTP method + resource path."""
    method = event.get('httpMethod', '')
    resource = event.get('resource', '')

    # Handle OPTIONS for CORS preflight
    if method == 'OPTIONS':
        return json_response(200, {'message': 'OK'})

    # Extract user_id from Cognito authorizer claims
    try:
        user_id = event['requestContext']['authorizer']['claims']['sub']
    except (KeyError, TypeError):
        return json_response(401, {'message': 'Unauthorized'})

    # Parse body if present
    body = None
    if event.get('body'):
        try:
            body = json.loads(event['body'], parse_float=decimal.Decimal)
        except (json.JSONDecodeError, TypeError):
            body = {}

    # Extract conversationId from path parameters
    conv_id = None
    if event.get('pathParameters') and event['pathParameters'].get('conversationId'):
        conv_id = event['pathParameters']['conversationId']

    # Validate conversationId format if present
    if conv_id and not UUID_V4_PATTERN.match(conv_id):
        return json_response(400, {'message': 'Invalid conversationId format'})

    # Route to appropriate handler
    try:
        if resource == '/conversations' and method == 'GET':
            return list_conversations(user_id)
        elif resource == '/conversations' and method == 'POST':
            return create_conversation(user_id, body)
        elif resource == '/conversations/{conversationId}' and method == 'GET':
            return get_conversation(user_id, conv_id)
        elif resource == '/conversations/{conversationId}' and method == 'PUT':
            return update_conversation(user_id, conv_id, body)
        elif resource == '/conversations/{conversationId}' and method == 'DELETE':
            return delete_conversation(user_id, conv_id)
        else:
            return json_response(404, {'message': 'Not found'})
    except Exception as e:
        print(f'Error handling request: {e}')
        return json_response(500, {'message': 'Internal server error'})


def list_conversations(user_id):
    """List all conversations for a user (metadata only, no messages)."""
    response = table.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key('userId').eq(user_id),
    )
    items = response.get('Items', [])

    # Return metadata only (exclude messages for performance)
    conversations = []
    for item in items:
        conversations.append({
            'conversationId': item['conversationId'],
            'conversationName': item.get('conversationName', ''),
            'createdAt': item.get('createdAt', ''),
            'updatedAt': item.get('updatedAt', ''),
        })

    # Sort by updatedAt descending
    conversations.sort(key=lambda x: x.get('updatedAt', ''), reverse=True)

    return json_response(200, conversations)


def create_conversation(user_id, body):
    """Create a new conversation record."""
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    conversation_id = str(uuid.uuid4())

    # Determine conversation name
    conversation_name = f'New Conversation {date_str}'
    if body and body.get('conversationName'):
        conversation_name = body['conversationName']

    item = {
        'userId': user_id,
        'conversationId': conversation_id,
        'conversationName': conversation_name,
        'messages': [],
        'createdAt': now,
        'updatedAt': now,
    }

    table.put_item(Item=item)

    return json_response(201, {
        'conversationId': conversation_id,
        'conversationName': conversation_name,
        'messages': [],
        'createdAt': now,
        'updatedAt': now,
    })


def get_conversation(user_id, conversation_id):
    """Get a single conversation with full messages."""
    response = table.get_item(
        Key={
            'userId': user_id,
            'conversationId': conversation_id,
        }
    )

    item = response.get('Item')
    if not item:
        return json_response(404, {'message': 'Conversation not found'})

    # Defensive check: verify userId matches
    if item.get('userId') != user_id:
        return json_response(403, {'message': 'Forbidden'})

    return json_response(200, {
        'conversationId': item['conversationId'],
        'conversationName': item.get('conversationName', ''),
        'messages': item.get('messages', []),
        'createdAt': item.get('createdAt', ''),
        'updatedAt': item.get('updatedAt', ''),
    })


def update_conversation(user_id, conversation_id, body):
    """Update a conversation (rename and/or append messages)."""
    # Fetch existing item to verify ownership
    response = table.get_item(
        Key={
            'userId': user_id,
            'conversationId': conversation_id,
        }
    )

    item = response.get('Item')
    if not item:
        return json_response(404, {'message': 'Conversation not found'})

    # Defensive check: verify userId matches
    if item.get('userId') != user_id:
        return json_response(403, {'message': 'Forbidden'})

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
    update_expressions = []
    expression_attr_values = {':updatedAt': now}
    expression_attr_names = {}

    # Handle conversationName update
    if body and 'conversationName' in body:
        if not body['conversationName'] or not body['conversationName'].strip():
            return json_response(400, {'message': 'conversationName cannot be empty'})
        update_expressions.append('#name = :name')
        expression_attr_values[':name'] = body['conversationName']
        expression_attr_names['#name'] = 'conversationName'

    # Handle messages append
    if body and 'messages' in body and isinstance(body['messages'], list):
        new_messages = body['messages']
        # Optional v1 presentation snapshots are data, never generated components.
        # Bound the full append, including all tools, before DynamoDB persistence.
        if len(new_messages) > 10 or len(json.dumps(new_messages, cls=DecimalEncoder).encode('utf-8')) > 160_000:
            return json_response(413, {'message': 'Message snapshot is too large'})
        if any(not valid_message(message) for message in new_messages):
            return json_response(400, {'message': 'Invalid message snapshot'})
        existing_messages = item.get('messages', [])

        # Auto-naming: if this is the first message being appended and current name
        # starts with "New Conversation", set name to first 50 chars of first user message
        if not existing_messages and new_messages:
            current_name = item.get('conversationName', '')
            if current_name.startswith('New Conversation'):
                # Find first user message
                first_user_msg = None
                for msg in new_messages:
                    if msg.get('role') == 'user':
                        first_user_msg = msg
                        break

                if first_user_msg and first_user_msg.get('content'):
                    content = first_user_msg['content']
                    if len(content) > 50:
                        auto_name = content[:50] + '\u2026'
                    else:
                        auto_name = content

                    update_expressions.append('#name = :name')
                    expression_attr_values[':name'] = auto_name
                    expression_attr_names['#name'] = 'conversationName'

        # Append new messages to existing
        combined_messages = existing_messages + new_messages
        if len(json.dumps(combined_messages, cls=DecimalEncoder).encode('utf-8')) > 340_000:
            return json_response(413, {'message': 'Conversation history is full; start a new conversation'})
        update_expressions.append('messages = :messages')
        expression_attr_values[':messages'] = combined_messages

    # Always update updatedAt
    update_expressions.append('updatedAt = :updatedAt')

    if not update_expressions:
        # Nothing to update, just return current state
        return json_response(200, {
            'conversationId': item['conversationId'],
            'conversationName': item.get('conversationName', ''),
            'messages': item.get('messages', []),
            'createdAt': item.get('createdAt', ''),
            'updatedAt': item.get('updatedAt', ''),
        })

    update_kwargs = {
        'Key': {
            'userId': user_id,
            'conversationId': conversation_id,
        },
        'UpdateExpression': 'SET ' + ', '.join(update_expressions),
        'ExpressionAttributeValues': expression_attr_values,
        'ReturnValues': 'ALL_NEW',
        # A late stream save must not recreate a concurrently deleted record.
        'ConditionExpression': 'attribute_exists(userId) AND attribute_exists(conversationId)',
    }
    if expression_attr_names:
        update_kwargs['ExpressionAttributeNames'] = expression_attr_names

    result = table.update_item(**update_kwargs)
    updated_item = result.get('Attributes', {})

    return json_response(200, {
        'conversationId': updated_item.get('conversationId', conversation_id),
        'conversationName': updated_item.get('conversationName', ''),
        'messages': updated_item.get('messages', []),
        'createdAt': updated_item.get('createdAt', ''),
        'updatedAt': updated_item.get('updatedAt', ''),
    })


def valid_message(message):
    """Validate optional presentation envelopes; legacy text-only history still works."""
    if not isinstance(message, dict) or message.get('role') not in ('user', 'agent'):
        return False
    if not isinstance(message.get('content'), str) or len(message['content']) > 100_000:
        return False
    if 'tools' not in message:
        return True
    if message.get('partsVersion') != 1 or not isinstance(message['tools'], list) or len(message['tools']) > 50:
        return False
    if len(json.dumps(message['tools'], cls=DecimalEncoder).encode('utf-8')) > 64_000:
        return False
    for tool in message['tools']:
        if not isinstance(tool, dict) or set(tool) - {'id', 'name', 'status', 'presentation'}:
            return False
        if not all(isinstance(tool.get(k), str) and len(tool[k]) <= 200 for k in ('id', 'name')):
            return False
        if tool.get('status') not in ('completed', 'failed', 'interrupted'):
            return False
        view = tool.get('presentation')
        if view is None:
            continue
        if not isinstance(view, dict):
            return False
        if view.get('kind') == 'resources' and set(view) == {'kind', 'rows'}:
            rows = view['rows']
            fields = {'name', 'region', 'status', 'version', 'engine', 'instance_class'}
            if not isinstance(rows, list) or not 1 <= len(rows) <= 50:
                return False
            if any(not isinstance(row, dict) or 'name' not in row or set(row) - fields
                   or any(not isinstance(v, str) or len(v) > 200 for v in row.values()) for row in rows):
                return False
        elif view.get('kind') == 'costs' and set(view) == {'kind', 'unit', 'points'}:
            points = view['points']
            if view['unit'] not in ('USD', 'EUR', 'GBP', 'JPY') or not isinstance(points, list) or not 1 <= len(points) <= 50:
                return False
            for point in points:
                if not isinstance(point, dict) or set(point) != {'label', 'value'}:
                    return False
                if not isinstance(point['label'], str) or len(point['label']) > 40:
                    return False
                value = point['value']
                if isinstance(value, bool) or not isinstance(value, (int, float, decimal.Decimal)) or not decimal.Decimal(str(value)).is_finite():
                    return False
        else:
            return False
    return True


def delete_conversation(user_id, conversation_id):
    """Delete a conversation after verifying ownership."""
    # Fetch existing item to verify it exists and belongs to user
    response = table.get_item(
        Key={
            'userId': user_id,
            'conversationId': conversation_id,
        }
    )

    item = response.get('Item')
    if not item:
        return json_response(404, {'message': 'Conversation not found'})

    # Defensive check: verify userId matches
    if item.get('userId') != user_id:
        return json_response(403, {'message': 'Forbidden'})

    # Delete the item
    table.delete_item(
        Key={
            'userId': user_id,
            'conversationId': conversation_id,
        }
    )

    return json_response(204)
