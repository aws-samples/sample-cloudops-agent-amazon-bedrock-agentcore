#!/bin/bash
set -euo pipefail

echo "=== Patch Script: Clone and Patch Billing MCP Server ==="

# Clone upstream repository
# Upstream MCP source repo URL is centralized in mcp-source.conf (single source
# of truth for all patch scripts; see README "Upstream MCP source").
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=mcp-source.conf
. "${SCRIPT_DIR}/mcp-source.conf"

echo "Cloning upstream MCP repository (${MCP_REPO_URL})..."
git clone --depth 1 "${MCP_REPO_URL}"
cd mcp/src/billing-cost-management-mcp-server

SERVER_FILE="awslabs/billing_cost_management_mcp_server/server.py"

# Patch server.py
echo "Patching server.py..."

python3 -c "
import re

with open('$SERVER_FILE', 'r') as f:
    content = f.read()

# 1. Patch FastMCP constructor: no changes needed, we pass params to run() instead
print('FastMCP constructor: no patch needed (params passed to run())')

# 2. Replace main() function
old_main = '''def main():
    \"\"\"Main entry point for the server.\"\"\"
    # Run the setup function to initialize the server
    asyncio.run(setup())

    # Start the MCP server
    mcp.run()'''

new_main = '''def main():
    \"\"\"Run the MCP server with streamable-http transport.\"\"\"
    # Run setup before starting server
    asyncio.run(setup())
    # Run with streamable-http transport on port 8000
    mcp.run(transport='streamable-http', host='0.0.0.0', port=8000, stateless_http=True)'''

if old_main in content:
    content = content.replace(old_main, new_main)
    print('main() function patched')
else:
    print('ERROR: Could not find expected main() function pattern')
    # Print what we found for debugging
    match = re.search(r'def main\(\).*?(?=\ndef |\Z)', content, re.DOTALL)
    if match:
        print(f'Found main(): {match.group(0)[:200]}...')
    exit(1)

with open('$SERVER_FILE', 'w') as f:
    f.write(content)

print('server.py patch complete')
"

# Validate patch
grep -q 'streamable-http' "$SERVER_FILE" || { echo "ERROR: streamable-http not found in server.py"; exit 1; }
grep -q 'port=8000' "$SERVER_FILE" || { echo "ERROR: port=8000 not found in server.py"; exit 1; }
echo "server.py patch verified."

# No need to add uvicorn/starlette — fastmcp handles streamable-http transport internally
echo "Dependencies: fastmcp handles streamable-http transport natively."

# Disable UV_FROZEN in Dockerfile
echo "Disabling UV_FROZEN in Dockerfile..."
sed -i 's/UV_FROZEN=1/UV_FROZEN=0/g' Dockerfile
sed -i '/ENV UV_FROZEN/d' Dockerfile
echo "UV_FROZEN handling complete."

# Patch Dockerfile: add EXPOSE and update entrypoint
echo "Patching Dockerfile..."
grep -q 'EXPOSE 8000' Dockerfile || sed -i '/^HEALTHCHECK/i EXPOSE 8000' Dockerfile
sed -i 's|ENTRYPOINT.*|ENTRYPOINT ["python", "-m", "awslabs.billing_cost_management_mcp_server.server"]|' Dockerfile
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

echo "=== All billing MCP server patches complete ==="
