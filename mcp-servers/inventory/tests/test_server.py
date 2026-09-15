import asyncio


def test_server_imports_and_registers_tools():
    from inventory_mcp_server.server import mcp

    tools = asyncio.run(mcp.list_tools())
    assert len(tools) == 15
