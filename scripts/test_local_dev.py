"""Local HTTP boundary uses real JWT signatures and real history serialization."""
import json
import time
from pathlib import Path
import importlib.util

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

spec = importlib.util.spec_from_file_location('local_dev', Path(__file__).with_name('local_dev.py'))
local_dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_dev)


def test_local_routes_validate_cognito_identity_and_override_forged_payload(monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    issuer = 'https://cognito-idp.us-east-1.amazonaws.com/test-pool'
    verifier = local_dev.CognitoVerifier('us-east-1', 'test-pool', 'test-client')
    monkeypatch.setattr(verifier.keys, 'get_signing_key_from_jwt', lambda token: type('Key', (), {'key': key.public_key()})())
    access = jwt.encode({'sub': 'real-user', 'iss': issuer, 'client_id': 'test-client', 'token_use': 'access', 'exp': time.time() + 60}, key, algorithm='RS256')
    identity = jwt.encode({'sub': 'real-user', 'iss': issuer, 'aud': 'test-client', 'token_use': 'id', 'exp': time.time() + 60}, key, algorithm='RS256')

    async def invocation(request):
        body = await request.json()
        return JSONResponse({'forwardedToken': body['accessToken']})

    seen = []
    def history(event, context):
        seen.append(event)
        return {'statusCode': 200, 'body': json.dumps({'ok': True})}

    app = local_dev.local_app(Starlette(routes=[Route('/invocations', invocation, methods=['POST'])]), history, verifier)
    with TestClient(app) as client:
        assert client.post('/invocations', json={'prompt': 'hello'}).status_code == 401
        assert client.get('/conversations', headers={'Authorization': access}).status_code == 401
        assert client.get('/conversations', headers={'Authorization': identity}).status_code == 200
        assert seen[0]['requestContext']['authorizer']['claims']['sub'] == 'real-user'
        response = client.post('/invocations', headers={'Authorization': f'Bearer {access}'}, json={'prompt': 'hello', 'accessToken': 'forged'})
        assert response.status_code == 200
        assert response.json()['forwardedToken'] == access
        assert client.post('/invocations', headers={'Origin': 'https://untrusted.example', 'Authorization': f'Bearer {access}'}, json={'prompt': 'hello'}).status_code == 403


@pytest.mark.parametrize('case', ['expired', 'issuer', 'client', 'signature', 'token-use'])
def test_local_invocation_rejects_invalid_identity_before_agent_execution(monkeypatch, case):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    verifier = local_dev.CognitoVerifier('us-east-1', 'pool', 'client')
    monkeypatch.setattr(verifier.keys, 'get_signing_key_from_jwt', lambda token: type('Key', (), {'key': key.public_key()})())
    claims = {'sub': 'user', 'iss': verifier.issuer, 'client_id': 'client', 'token_use': 'access', 'exp': time.time() + 60}
    if case == 'expired': claims['exp'] = time.time() - 60
    if case == 'issuer': claims['iss'] = 'https://different-issuer.example'
    if case == 'client': claims['client_id'] = 'different-client'
    if case == 'token-use': claims['token_use'] = 'id'
    signing_key = rsa.generate_private_key(public_exponent=65537, key_size=2048) if case == 'signature' else key
    token = jwt.encode(claims, signing_key, algorithm='RS256')
    invoked = []

    async def invocation(request):
        invoked.append(True)
        return JSONResponse({'unexpected': True})

    app = local_dev.local_app(Starlette(routes=[Route('/invocations', invocation, methods=['POST'])]), lambda *_: None, verifier)
    with TestClient(app) as client:
        response = client.post('/invocations', headers={'Authorization': f'Bearer {token}'}, json={'prompt': 'hello'})
        assert response.status_code == 401
        assert token not in response.text
        assert not invoked
