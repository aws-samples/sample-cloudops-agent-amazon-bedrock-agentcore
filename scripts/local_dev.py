"""Loopback-only local AgentCore + history, using live Cognito/Bedrock/Gateway."""
import asyncio
import importlib.util
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import jwt
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route

ROOT = Path(__file__).resolve().parents[1]
LOCAL_ORIGINS = {'http://127.0.0.1:5173', 'http://localhost:5173'}


class CognitoVerifier:
    """Local serving has no AgentCore/API Gateway authorizer: verify JWTs here."""

    def __init__(self, region, pool, client_id):
        self.issuer = f'https://cognito-idp.{region}.amazonaws.com/{pool}'
        self.client_id = client_id
        self.keys = jwt.PyJWKClient(f'{self.issuer}/.well-known/jwks.json')

    def verify(self, token, use):
        key = self.keys.get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=['RS256'], issuer=self.issuer,
                            options={'verify_aud': use == 'id', 'require': ['exp', 'sub', 'iss']},
                            audience=self.client_id if use == 'id' else None)
        if claims.get('token_use') != use or (use == 'access' and claims.get('client_id') != self.client_id):
            raise jwt.InvalidTokenError('Wrong token type or client')
        return claims


def local_app(agent_app, history_handler, verifier, lifespan=None):
    async def history(request):
        event = {
            'httpMethod': request.method,
            'resource': '/conversations/{conversationId}' if request.path_params else '/conversations',
            'pathParameters': request.path_params,
            'requestContext': {'authorizer': {'claims': request.scope['local_claims']}},
            'body': (await request.body()).decode() or None,
        }
        result = await run_in_threadpool(history_handler, event, None)
        return Response(result['body'], status_code=result['statusCode'], media_type='application/json')

    routes = [
        Route('/conversations', history, methods=['GET', 'POST']),
        Route('/conversations/{conversationId}', history, methods=['GET', 'PUT', 'DELETE']),
        Mount('/', app=agent_app),
    ]
    app = Starlette(routes=routes, lifespan=lifespan)

    # Pure ASGI middleware preserves incremental streaming and disconnect delivery.
    class Authenticate:
        async def __call__(self, scope, receive, send):
            if scope['type'] != 'http':
                await app(scope, receive, send)
                return
            headers = dict(scope['headers'])
            origin = headers.get(b'origin', b'').decode()
            if origin and origin not in LOCAL_ORIGINS:
                await JSONResponse({'message': 'Origin not allowed'}, status_code=403)(scope, receive, send)
                return
            if scope['path'] == '/ping':
                await app(scope, receive, send)
                return
            token = headers.get(b'authorization', b'').decode().removeprefix('Bearer ')
            use = 'access' if scope['path'] == '/invocations' else 'id'
            try:
                claims = await asyncio.to_thread(verifier.verify, token, use)
            except Exception:
                await JSONResponse({'message': 'Sign in again to use the local app'}, status_code=401)(scope, receive, send)
                return
            scope['local_claims'] = claims
            body = bytearray()
            while True:
                chunk = await receive()
                if chunk['type'] == 'http.disconnect':
                    return
                body.extend(chunk.get('body', b''))
                if len(body) > 150_000:
                    await JSONResponse({'message': 'Request too large'}, status_code=413)(scope, receive, send)
                    return
                if not chunk.get('more_body'):
                    break
            if scope['path'] == '/invocations':
                try:
                    payload = json.loads(body)
                    payload['accessToken'] = token  # Never accept an unverified identity in the body.
                    body = json.dumps(payload).encode()
                except (ValueError, TypeError):
                    await JSONResponse({'message': 'Invalid request'}, status_code=400)(scope, receive, send)
                    return
            delivered = False

            async def replay_body():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {'type': 'http.request', 'body': bytes(body), 'more_body': False}
                return await receive()

            await app(scope, replay_body, send)

    return Authenticate()


def create_app():
    """Resolve existing cloud configuration; create only a disposable local table."""
    import sys
    import boto3
    from moto.server import ThreadedMotoServer

    session = boto3.Session()
    region = os.environ.get('AWS_REGION') or session.region_name
    if not region:
        raise RuntimeError('Set AWS_REGION and AWS_PROFILE before starting local development')
    outputs = session.client('cloudformation', region_name=region).describe_stacks(StackName='CloudOpsConversationHistoryStack')['Stacks'][0]['Outputs']
    config = json.loads(next(item['OutputValue'] for item in outputs if item['OutputKey'] == 'FrontEndConfig'))
    runtime_id = config['agentcore']['agentArn'].rsplit('/', 1)[-1]
    runtime = session.client('bedrock-agentcore-control', region_name=region).get_agent_runtime(agentRuntimeId=runtime_id)
    for name in ('GATEWAY_ARN', 'MEMORY_ID', 'MODEL_ID'):
        os.environ[name] = runtime['environmentVariables'].get(name, '')
    os.environ['AWS_REGION'] = region
    os.environ['DISABLE_ADOT_OBSERVABILITY'] = 'true'
    os.environ['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'] = 'false'
    (ROOT / 'frontend/public').mkdir(exist_ok=True)
    (ROOT / 'frontend/public/app-config.json').write_text(json.dumps(config, indent=2) + '\n')

    sys.path.insert(0, str(ROOT / 'agentcore'))
    from agent_runtime import app as agent_app

    emulator = ThreadedMotoServer(ip_address='127.0.0.1', port=0, verbose=False)
    emulator.start()
    host, port = emulator.get_host_and_port()
    local_dynamo = boto3.resource('dynamodb', region_name=region, endpoint_url=f'http://{host}:{port}',
                                 aws_access_key_id='local', aws_secret_access_key='local')
    table_name = 'CloudOpsLocalConversations'
    local_dynamo.create_table(TableName=table_name, BillingMode='PAY_PER_REQUEST',
                             KeySchema=[{'AttributeName': 'userId', 'KeyType': 'HASH'}, {'AttributeName': 'conversationId', 'KeyType': 'RANGE'}],
                             AttributeDefinitions=[{'AttributeName': 'userId', 'AttributeType': 'S'}, {'AttributeName': 'conversationId', 'AttributeType': 'S'}])
    spec = importlib.util.spec_from_file_location('local_history', ROOT / 'cdk/lambda/conversations/handler.py')
    history = importlib.util.module_from_spec(spec)
    # Substitute only the storage boundary while loading the real Lambda handler.
    with patch.dict(os.environ, {'TABLE_NAME': table_name}), patch('boto3.resource', return_value=local_dynamo):
        spec.loader.exec_module(history)
    logging.getLogger('werkzeug').setLevel(logging.ERROR)

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            emulator.stop()

    print('Local mode: real Cognito + Bedrock + Gateway + Memory; disposable local history. No AWS deployment.')
    return local_app(agent_app, history.handler, CognitoVerifier(region, config['cognito']['userPoolId'], config['cognito']['userPoolClientId']), lifespan)
