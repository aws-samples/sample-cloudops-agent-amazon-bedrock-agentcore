"""Versioned, data-minimizing presentation events (never raw Strands events)."""

import asyncio
import json
import math
import uuid
from contextlib import suppress

RESOURCE_FIELDS = ("name", "region", "status", "version", "engine", "instance_class")
RESOURCE_TOOLS = (
    "list_eks_clusters",
    "list_rds_instances",
    "list_msk_clusters",
    "list_elasticache_clusters",
    "list_opensearch_domains",
)
MAX_TEXT = 100_000


def presentation(tool_name, content, structured=None):
    """Select supported structured data; unknown/error output is never echoed."""
    if not isinstance(content, list):
        return None
    try:
        if structured is not None:
            value = structured
            if len(json.dumps(value)) > 64_000:
                return None
        else:
            texts = [x.get("text", "") for x in content if isinstance(x, dict)]
            if sum(len(x) for x in texts if isinstance(x, str)) > 64_000:
                return None
            parsed = [json.loads(x) for x in texts if isinstance(x, str) and x]
            value = parsed[0] if len(parsed) == 1 else parsed
    except (ValueError, TypeError):
        return None
    name = tool_name.split("___")[-1]
    if isinstance(value, dict) and set(value) == {"result"}:
        value = value["result"]  # FastMCP's typed list output envelope
    if name in RESOURCE_TOOLS and isinstance(value, dict):
        value = [value]  # One-row FastMCP unstructured output
    if name in RESOURCE_TOOLS and isinstance(value, list):
        rows = []
        for item in value[:50]:
            if not isinstance(item, dict):
                return None
            row = {
                k: str(item[k])[:200]
                for k in RESOURCE_FIELDS
                if k in item and isinstance(item[k], (str, int, float))
            }
            for alias in ("identifier", "cluster_name", "domain_name", "cluster_id"):
                if not row.get("name") and isinstance(item.get(alias), str):
                    row["name"] = item[alias][:200]
            rows.append(row)
        if rows and all(row.get("name") for row in rows):
            return {"kind": "resources", "rows": rows}
    if name == "cost-explorer" and isinstance(value, dict):
        if value.get("status") != "success":
            return None
        value = value.get("data")
    if name in ("cost-explorer", "get_cost_and_usage") and isinstance(value, dict):
        points = []
        unit = None
        periods = value.get("ResultsByTime")
        if not isinstance(periods, list):
            return None
        for item in periods[:50]:
            try:
                metric = item["Total"]["UnblendedCost"]
                amount = float(metric["Amount"])
                currency = metric["Unit"]
                label = item["TimePeriod"]["Start"]
                if not math.isfinite(amount) or currency not in (
                    "USD",
                    "EUR",
                    "GBP",
                    "JPY",
                ):
                    return None
                if unit is not None and unit != currency:
                    return None
                if not isinstance(label, str):
                    return None
                unit = currency
                points.append({"label": label[:40], "value": amount})
            except (KeyError, TypeError, ValueError):
                return None
        if points:
            return {"kind": "costs", "unit": unit, "points": points}
    return None


async def stream_response(payload, context, *, runtime):
    """Keep the identity-scoped MCP connection alive until the stream closes."""
    run_id = (
        str(uuid.UUID(payload.get("runId")))
        if _uuid(payload.get("runId"))
        else str(uuid.uuid4())
    )
    message_id = (
        str(uuid.UUID(payload.get("messageId")))
        if _uuid(payload.get("messageId"))
        else str(uuid.uuid4())
    )
    sequence = 0

    def event(kind, **data):
        nonlocal sequence
        sequence += 1
        return {
            "version": 1,
            "runId": run_id,
            "messageId": message_id,
            "sequence": sequence,
            "type": kind,
            **data,
        }

    yield event("run-start")
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        yield event("run-failure", message="Please provide a non-empty prompt.")
        return
    session_id = payload.get("sessionId", "default_session")
    tools = {}
    finished_tools = set()
    total_text = 0
    presentation_bytes = 0
    completed = False
    try:
        from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent, HookProvider

        queue = asyncio.Queue(maxsize=128)

        class ToolLifecycle(HookProvider):
            """Report real invocation boundaries, not model tool-input deltas."""

            def register_hooks(self, registry, **kwargs):
                registry.add_callback(BeforeToolCallEvent, self.before)
                registry.add_callback(AfterToolCallEvent, self.after)

            async def before(self, hook):
                await queue.put({"_tool_start": hook.tool_use})

            async def after(self, hook):
                if not hook.retry:
                    await queue.put({"_tool_result": hook.result})

        token = runtime.resolve_user_token(payload, context)
        verified_sub = runtime.resolve_verified_sub(token, context)
        with runtime.build_mcp_client_for_token(token) as client:
            request_tools = runtime.list_tools_with_pagination(client)
            kwargs = {
                "model": runtime.model,
                "tools": request_tools,
                "system_prompt": runtime.system_prompt_template,
                "callback_handler": None,
                "trace_attributes": {"session.id": session_id},
                "hooks": [ToolLifecycle()],
            }
            if runtime.MEMORY_ID:
                try:
                    config = runtime.AgentCoreMemoryConfig(
                        memory_id=runtime.MEMORY_ID,
                        session_id=session_id,
                        actor_id=verified_sub or runtime.TOKENLESS_MEMORY_ACTOR_ID,
                    )
                    kwargs["session_manager"] = runtime.AgentCoreMemorySessionManager(
                        agentcore_memory_config=config,
                        region_name=runtime.AWS_REGION,
                    )
                except Exception:  # noqa: BLE001 - optional memory, matching legacy fallback
                    runtime.logger.warning("Could not configure streaming memory")
            agent = runtime.Agent(**kwargs)

            async def produce():
                try:
                    async for item in agent.stream_async(prompt):
                        await queue.put(item)
                except Exception as error:  # noqa: BLE001 - transport arbitrary agent failures to the safe boundary
                    await queue.put(error)
                finally:
                    # Cancellation must not block forever on a full queue.
                    if not asyncio.current_task().cancelling():
                        await queue.put(None)

            producer = asyncio.create_task(produce())
            try:
                async for source in _queued_events(queue):
                    if isinstance(source, Exception):
                        raise source
                    for output in _presentation_events(source, tools, finished_tools):
                        if output["type"] == "text-delta":
                            total_text += len(output["text"])
                            if total_text > MAX_TEXT:
                                raise ValueError("Response limit exceeded")
                        rich = output.get("presentation")
                        size = len(json.dumps(rich).encode("utf-8")) if rich else 0
                        if presentation_bytes + size > 40_000:
                            output.pop("presentation", None)
                        else:
                            presentation_bytes += size
                        kind = output.pop("type")
                        yield event(kind, **output)
                    if "result" in source:
                        completed = True
            finally:
                producer.cancel()
                with suppress(asyncio.CancelledError):
                    await producer
            if not completed:
                raise ValueError("Agent ended without a result")
        yield event("run-complete")
    except Exception as exc:  # noqa: BLE001 - never let SDK echo raw agent exceptions
        # Classify only; raw exceptions/tool arguments/results never enter events or logs.
        denied = runtime.is_authorization_denial(exc)
        runtime.logger.warning(
            "Streaming request failed (authorization_denied=%s)", denied
        )
        yield event(
            "run-failure",
            message=(
                "This capability is not available for your role."
                if denied
                else "The response could not be completed. Please retry."
            ),
        )


async def _queued_events(queue):
    while (item := await queue.get()) is not None:
        yield item


def _presentation_events(source, tools, finished_tools):
    # `data` is Strands' text-only delta, not reasoningText or tool input.
    text = source.get("data")
    if isinstance(text, str) and not source.get("reasoning"):
        yield {"type": "text-delta", "text": text}
    tool = source.get("_tool_start")
    if isinstance(tool, dict):
        tool_id, name = tool.get("toolUseId"), tool.get("name")
        if isinstance(tool_id, str) and isinstance(name, str) and tool_id not in tools:
            if len(tools) >= 50 or len(tool_id) > 200 or len(name) > 200:
                raise ValueError("Tool limit exceeded")
            tools[tool_id] = name
            yield {"type": "tool-start", "toolCallId": tool_id, "name": name}
    result = source.get("_tool_result")
    if isinstance(result, dict):
        tool_id = result.get("toolUseId")
        if tool_id not in tools or tool_id in finished_tools:
            return
        finished_tools.add(tool_id)
        name = tools[tool_id]
        failed = result.get("status") == "error"
        rich = (
            None
            if failed
            else presentation(
                name, result.get("content"), result.get("structuredContent")
            )
        )
        yield {
            "type": "tool-failure" if failed else "tool-complete",
            "toolCallId": tool_id,
            **({"presentation": rich} if rich else {}),
        }


def _uuid(value):
    try:
        uuid.UUID(value)
        return True
    except (ValueError, TypeError, AttributeError):
        return False
