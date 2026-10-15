"""Versioned, allowlisted events for the CloudOps chat. Never stream raw SDK events."""
import uuid

from authorization_model import is_authorization_denial
from tool_presentation import present_tool_result
from tool_output import inspectable_output, MAX_TOOL_OUTPUT, MAX_RUN_OUTPUT


async def stream_response(client, create_agent, prompt):
    run_id = str(uuid.uuid4())
    message_id = str(uuid.uuid4())
    sequence = 0

    def event(kind, **fields):
        nonlocal sequence
        value = {
            "version": 1, "runId": run_id, "messageId": message_id,
            "sequence": sequence, "type": kind, **fields,
        }
        sequence += 1
        return value

    yield event("run-start")
    yield event("run-stage", stage="discovering-tools")
    try:
        with client:
            agent = create_agent()
            yield event("run-stage", stage="waiting-model")
            last_stage = "waiting-model"
            completed = False
            tools = {}
            settled = set()
            text_length = 0
            output_remaining = MAX_RUN_OUTPUT
            async for item in agent.stream_async(prompt):
                stage = "model-retry" if "event_loop_throttled_delay" in item else "waiting-model" if item.get("start_event_loop") else None
                if stage and stage != last_stage:
                    yield event("run-stage", stage=stage)
                    last_stage = stage
                if isinstance(item.get("data"), str) and not item.get("reasoning"):
                    last_stage = "receiving-response"
                    text_length += len(item["data"])
                    if text_length > 100_000:
                        yield event("run-error", code="incomplete")
                        return
                    yield event("text-delta", text=item["data"])
                # These are finalized tool-use/result messages, not partial model arguments.
                # Strands 1.20 filters ToolResultEvent out of stream_async; message events
                # are its public result surface (including concurrently completed tools).
                message = item.get("message", {})
                for part in message.get("content", []):
                    if "toolUse" in part:
                        tool = part["toolUse"]
                        tool_id, name = tool["toolUseId"], tool["name"]
                        if tool_id not in tools:
                            if len(tools) >= 30 or len(tool_id) > 128 or len(name) > 200:
                                yield event("run-error", code="incomplete")
                                return
                            tools[tool_id] = name
                            yield event("tool-start", toolCallId=tool_id, toolName=name)
                    elif "toolResult" in part:
                        result = part["toolResult"]
                        tool_id = result["toolUseId"]
                        if tool_id in tools and tool_id not in settled:
                            settled.add(tool_id)
                            name = tools[tool_id]
                            failed = result.get("status") != "success"
                            code = None
                            if failed:
                                if is_authorization_denial(result):
                                    code = "access-denied"
                                elif any(marker in str(result).lower() for marker in ("tool not found", "invalid tool name", "not found in registry")):
                                    code = "tool-unavailable"
                            if name == "report_access_restricted" and not failed:
                                notices = [part.get("json") for part in result.get("content", []) if isinstance(part, dict)]
                                if any(isinstance(notice, dict) and notice.get("accessNotice") == "capability-unavailable" for notice in notices):
                                    code = "capability-unavailable"
                            preview = None if failed else present_tool_result(name, tool_id, result)
                            output = inspectable_output(result, min(MAX_TOOL_OUTPUT, max(200, output_remaining)))
                            output_remaining = max(0, output_remaining - len(output['json']))
                            yield event(
                                "tool-error" if failed else "tool-complete",
                                toolCallId=tool_id, toolName=name, output=output,
                                **({"code": code} if code else {}),
                                **({"presentation": preview} if preview else {}),
                            )
                if "result" in item:
                    completed = getattr(item["result"], "stop_reason", "end_turn") in ("end_turn", "stop_sequence")
            if not completed or set(tools) != settled:
                yield event("run-error", code="incomplete")
                return
        yield event("run-complete")
    except Exception as error:
        # Exceptions can contain tool payloads or credentials. Do not echo or log them.
        code = "access-denied" if is_authorization_denial(error) else "agent-error"
        yield event("run-error", code=code)
