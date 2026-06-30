#!/bin/bash
set -euo pipefail

echo "=== Patch Script: Clone and Patch CloudTrail MCP Server ==="

# Clone upstream repository
# Upstream MCP source repo URL is centralized in mcp-source.conf (single source
# of truth for all patch scripts; see README "Upstream MCP source").
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=mcp-source.conf
. "${SCRIPT_DIR}/mcp-source.conf"

echo "Cloning upstream MCP repository (${MCP_REPO_URL})..."
git clone --depth 1 "${MCP_REPO_URL}"
cd mcp/src/cloudtrail-mcp-server

# Patch server.py
# Strategy: Keep the mcp SDK's FastMCP (not the standalone fastmcp package).
# The mcp SDK's FastMCP already supports streamable-http transport and accepts
# host/port/stateless_http in the constructor. We just need to:
# 1. Add host/port/stateless_http to the FastMCP constructor
# 2. Change mcp.run() to mcp.run(transport='streamable-http')
echo "Patching server.py..."

python3 << 'PYEOF'
import re

with open("awslabs/cloudtrail_mcp_server/server.py", "r") as f:
    content = f.read()

# 1. Add host, port, stateless_http settings after the FastMCP constructor
# Find the closing ) of the constructor by looking for a line that is just ")"
# after "mcp = FastMCP("
lines = content.split('\n')
in_constructor = False
constructor_end_line = -1
for i, line in enumerate(lines):
    if 'mcp = FastMCP(' in line:
        in_constructor = True
    if in_constructor and line.strip() == ')':
        constructor_end_line = i
        break

if constructor_end_line == -1:
    print("ERROR: Could not find FastMCP constructor closing )")
    exit(1)

# Insert settings right after the closing )
settings_code = """
# Configure for streamable-http transport
mcp.settings.host = '0.0.0.0'
mcp.settings.port = 8000
mcp.settings.stateless_http = True
mcp.settings.transport_security = None"""

lines.insert(constructor_end_line + 1, settings_code)
content = '\n'.join(lines)
print("FastMCP settings patched with host/port/stateless_http")

# 2. Replace main() function to use streamable-http transport
old_main = 'def main():\n    """Run the MCP server."""\n    mcp.run()'
new_main = 'def main():\n    """Run the MCP server with streamable-http transport."""\n    mcp.run(transport="streamable-http")'

if old_main in content:
    content = content.replace(old_main, new_main)
    print("main() function patched")
else:
    # Try regex fallback
    pattern = r'def main\(\):\s*\n\s*""".*?"""\s*\n\s*mcp\.run\(\)'
    match = re.search(pattern, content, re.DOTALL)
    if match:
        content = content[:match.start()] + new_main + content[match.end():]
        print("main() function patched via regex")
    else:
        print("ERROR: Could not find main() function")
        exit(1)

with open("awslabs/cloudtrail_mcp_server/server.py", "w") as f:
    f.write(content)

print("server.py patch complete")
PYEOF

# Validate patch
grep -q 'streamable-http' "awslabs/cloudtrail_mcp_server/server.py" || { echo "ERROR: streamable-http not found in server.py"; exit 1; }
grep -q "mcp.settings.host" "awslabs/cloudtrail_mcp_server/server.py" || { echo "ERROR: host setting not found in server.py"; exit 1; }
grep -q "mcp.settings.port = 8000" "awslabs/cloudtrail_mcp_server/server.py" || { echo "ERROR: port=8000 not found in server.py"; exit 1; }
echo "server.py patch verified."

# No need to add fastmcp dependency - we use the mcp SDK's built-in FastMCP
# which already supports streamable-http transport with host/port params.
# Just need to ensure uvicorn and starlette are available for the transport.
echo "Adding uvicorn/starlette dependencies for streamable-http transport..."
python3 -c "
with open('pyproject.toml', 'r') as f:
    content = f.read()

import re
# Add uvicorn and starlette which are needed for streamable-http transport
content = re.sub(
    r'(dependencies\s*=\s*\[)',
    r'\1\n    \"uvicorn>=0.27.0\",\n    \"starlette>=0.36.0\",',
    content,
    count=1
)

with open('pyproject.toml', 'w') as f:
    f.write(content)
print('uvicorn/starlette dependencies added to pyproject.toml')
"
grep -q 'uvicorn' pyproject.toml || { echo "ERROR: uvicorn not in pyproject.toml"; exit 1; }
# Install uv and regenerate lockfile with the new dependencies
echo "Regenerating uv.lock..."
pip3 install uv --quiet 2>/dev/null || python3 -m pip install uv --quiet
uv lock --python 3.13
echo "pyproject.toml patch verified, lockfile regenerated."

# Disable UV_FROZEN in Dockerfile and remove --frozen from uv sync
echo "Disabling UV_FROZEN and --frozen in Dockerfile..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' 's/UV_FROZEN=1/UV_FROZEN=0/g' Dockerfile
    sed -i '' '/ENV UV_FROZEN/d' Dockerfile
    sed -i '' 's/ --frozen//g' Dockerfile
else
    sed -i 's/UV_FROZEN=1/UV_FROZEN=0/g' Dockerfile
    sed -i '/ENV UV_FROZEN/d' Dockerfile
    sed -i 's/ --frozen//g' Dockerfile
fi
echo "UV_FROZEN and --frozen handling complete."

# Patch Dockerfile: add EXPOSE and update entrypoint
echo "Patching Dockerfile..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    grep -q 'EXPOSE 8000' Dockerfile || sed -i '' '/^HEALTHCHECK/i\
EXPOSE 8000
' Dockerfile
    sed -i '' 's|ENTRYPOINT.*|ENTRYPOINT ["python", "-m", "awslabs.cloudtrail_mcp_server.server"]|' Dockerfile
else
    grep -q 'EXPOSE 8000' Dockerfile || sed -i '/^HEALTHCHECK/i EXPOSE 8000' Dockerfile
    sed -i 's|ENTRYPOINT.*|ENTRYPOINT ["python", "-m", "awslabs.cloudtrail_mcp_server.server"]|' Dockerfile
fi
grep -q 'EXPOSE 8000' Dockerfile || { echo "ERROR: EXPOSE 8000 not in Dockerfile"; exit 1; }
echo "Dockerfile patch verified."

# Patch healthcheck
echo "Patching docker-healthcheck.sh..."
cat > docker-healthcheck.sh << 'HEALTHCHECK_EOF'
#!/bin/bash
curl -sf http://localhost:8000/mcp || exit 1
HEALTHCHECK_EOF
chmod +x docker-healthcheck.sh
echo "Healthcheck patch verified."

echo "=== All CloudTrail MCP server patches complete ==="
