#!/bin/bash
# Run the real CodeBuild patches in Linux without AWS credentials or Docker builds.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker run --rm -i -v "$ROOT/codebuild-scripts:/scripts:ro" \
    ghcr.io/astral-sh/uv:python3.13-bookworm-slim bash -s <<'CHECK'
set -euo pipefail
apt-get update -qq && apt-get install -y -qq git curl >/dev/null
for spec in billing:billing-cost-management:billing_cost_management pricing:aws-pricing:aws_pricing cloudwatch:cloudwatch:cloudwatch cloudtrail:cloudtrail:cloudtrail; do
    IFS=: read -r name directory module <<< "$spec"
    mkdir -p "/work/$name"
    cd "/work/$name"
    bash "/scripts/patch-$name.sh"
    source /scripts/mcp-source.conf
    test "$(git -C mcp rev-parse HEAD)" = "$MCP_REPO_REF"
    cd "mcp/src/$directory-mcp-server"
    uv sync --python 3.13 --frozen --no-dev --no-editable
    AWS_EC2_METADATA_DISABLED=true AWS_DEFAULT_REGION=us-east-1 \
      uv run --python 3.13 --no-sync python - "$module" <<'PY'
import asyncio
import subprocess
import sys
import tempfile
from importlib.metadata import version
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async def check():
    for attempt in range(30):
        try:
            async with streamablehttp_client('http://127.0.0.1:8000/mcp/') as (read, write, _):
                async with ClientSession(read, write) as client:
                    await client.initialize()
                    tools = (await client.list_tools()).tools
                    assert tools, 'No tools registered'
                    print(f'PASS {sys.argv[1]}: MCP {version("mcp")}, {len(tools)} tools over HTTP')
                    return
        except Exception:
            if attempt == 29 or server.poll() is not None:
                raise
            await asyncio.sleep(1)

assert version('mcp').split('.')[0] == '1'
with tempfile.TemporaryFile(mode='w+') as log:
    server = subprocess.Popen([sys.executable, '-m', f'awslabs.{sys.argv[1]}_mcp_server.server'], stdout=log, stderr=log)
    try:
        asyncio.run(check())
    except Exception:
        log.seek(0)
        print(log.read())
        raise
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
PY
done
CHECK
