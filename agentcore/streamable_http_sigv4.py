"""
SigV4 authentication for MCP streamable HTTP connections.
Based on AWS Labs sample: run-model-context-protocol-servers-with-aws-lambda
"""

import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials
from mcp.client.streamable_http import streamablehttp_client
from typing import AsyncIterator
from contextlib import asynccontextmanager


class SigV4HTTPXAuth(httpx.Auth):
    """HTTPX Auth class that signs requests with AWS SigV4"""
    
    def __init__(self, credentials: Credentials, service: str, region: str):
        self.credentials = credentials
        self.service = service
        self.region = region
        # Pass the live (refreshable) credentials object to SigV4Auth. botocore
        # calls credentials.get_frozen_credentials() inside add_auth at signing
        # time, which triggers a refresh when the credentials are near expiry.
        self.signer = SigV4Auth(credentials, service, region)

    def auth_flow(self, request: httpx.Request) -> AsyncIterator[httpx.Request]:
        """Sign the request with SigV4"""
        headers = dict(request.headers)
        headers.pop("connection", None)  # Remove connection header for signature
        
        aws_request = AWSRequest(
            method=request.method,
            url=str(request.url),
            data=request.content,
            headers=headers,
        )
        
        self.signer.add_auth(aws_request)
        request.headers.update(dict(aws_request.headers))
        yield request


@asynccontextmanager
async def streamablehttp_client_with_sigv4(
    url: str,
    credentials: Credentials,
    service: str = "bedrock-agentcore",
    region: str | None = None,
    timeout: float = 30.0
):
    """
    Create a streamable HTTP MCP client with SigV4 authentication.
    
    Args:
        url: Gateway endpoint URL
        credentials: AWS credentials (refreshable; signed at request time)
        service: AWS service name (default: bedrock-agentcore)
        region: AWS region
        timeout: Request timeout in seconds
    
    Yields:
        MCP client session with SigV4 authentication
    """
    auth = SigV4HTTPXAuth(credentials, service, region)
    
    async with streamablehttp_client(url, auth=auth, timeout=timeout) as client:
        yield client
