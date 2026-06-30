# Discovery-Filter Interceptor Lambda

Gateway **RESPONSE interceptor** for the `gateway-security-hardening` feature.
It filters the `tools/list` Discovery*Response down to the tool descriptors the
caller's role is permitted to discover, closing the gap that discovery is **not**
Cedar-governed (the Gateway authorizes tool \_invocation* by role, but without
this interceptor every role receives the full catalog).

## Files

- `handler.py` — the Lambda entry point (`handler.handler`). A RESPONSE
  interceptor that transforms `tools/list` responses and passes everything else
  through unchanged.
- `authorization_model.py` — a vendored byte-for-byte copy of the authoritative
  model (`agentcore/authorization_model.py`). The handler composes its
  `derive_role` and `retain_tool_for_role` surface so discovery filtering uses
  exactly the same role→category rules as invocation.

## What was verified (AgentCore API research)

The implementation is grounded in the AgentCore docs:

1. **A RESPONSE interceptor runs after the target responds but before the
   Gateway replies to the caller** — exactly the hook needed to transform the
   Discovery_Response. Gateways support at most one REQUEST and one RESPONSE
   Lambda interceptor, registered as entries in `InterceptorConfigurations`.

2. **RESPONSE interceptor payload (MCP target).** The tool descriptors live at
   `event.mcp.gatewayResponse.body.result.tools` — a JSON-RPC `tools/list`
   result whose `tools` is an array of `{ name, description, inputSchema }`
   descriptors. `event.mcp.gatewayRequest.headers` (including `Authorization`)
   is delivered **only** when `InputConfiguration.PassRequestHeaders` is `true`,
   so this interceptor sets `PassRequestHeaders: true` (mirroring deny-audit).

3. **`tools/list` is a single, non-streamed JSON-RPC response** for this Gateway
   (`ProtocolConfiguration.Mcp.SupportedVersions = ['2025-03-26']`, streaming
   not enabled for discovery). The handler still guards `isStreamingResponse`:
   it applies the same body filter to the single event it receives.

## Interceptor contract

```
Input  : event["mcp"]["gatewayRequest"]  = { headers?, body: { method, id, ... } }
         event["mcp"]["gatewayResponse"] = { statusCode, headers?,
                                             body: { jsonrpc, id, result: { tools: [...] } },
                                             isStreamingResponse? }
Output : { "interceptorOutputVersion": "1.0",
           "mcp": { "transformedGatewayResponse": { "statusCode": <int>, "body": <jsonrpc body> } } }
```

When the output carries `transformedGatewayResponse`, the Gateway returns that
content to the caller immediately.

## Algorithm

1. Defensively extract `gatewayRequest` and `gatewayResponse` (non-dict → `{}`).
2. **Discovery discriminator:** transform **only** when
   `gatewayRequest.body.method == "tools/list"`. Every other method
   (`tools/call`, `initialize`, `ping`, …) returns the original response
   unchanged — only discovery is filtered, invocation results are never touched.
3. Locate `gatewayResponse.body.result.tools`. If absent or not a list, return
   the response unchanged (nothing to filter).
4. **Resolve role:** read the `Authorization` header (case-insensitive),
   decode-only (no signature verification) the JWT payload, and
   `role = derive_role(claims.get("role"))`. A missing header / undecodable
   token / absent claim → `Role.NonAdmin`.
5. **Filter** `result.tools` in input order, keeping each tool `t` iff
   `retain_tool_for_role(role, t["name"])`. The builtin search tool
   (`x_amz_bedrock_agentcore_search`) is retained for every role; category names
   are classified by exact leading prefix; unknown / unclassifiable names are
   default-denied. Retained descriptors are left byte-for-byte unchanged and the
   filter is idempotent.
6. Rebuild the body (same `jsonrpc`/`id`, `result.tools` = filtered list) and
   return it as `transformedGatewayResponse` with the original `statusCode`.

## Fail closed

Steps 3–6 are wrapped in `try/except`. On **any** error (unparseable body,
role-resolution failure, classification failure) the handler returns a
`transformedGatewayResponse` whose `result.tools` is `[]`, echoing the request's
JSON-RPC `id`. The unfiltered catalog is **never** returned and the handler
**never** raises — a bug or malformed payload degrades to "discover nothing",
never "discover everything".

## Security

- `passRequestHeaders` is `true` so the handler can read `Authorization` to
  recover the JWT `role`/`sub`. The handler decodes the payload locally and
  logs **only** non-sensitive counts and the `sub` identity reference — never
  the token, the `Authorization` header, or any decode-error text.
- The gateway service role is granted `lambda:InvokeFunction` scoped to this
  function ARN only, not a wildcard.

## Wiring

Registered on the Gateway via a second `InterceptorConfigurations` entry
(`InterceptionPoints: ['RESPONSE']`) in `cdk/lib/gateway-stack.ts`, alongside
the existing REQUEST (deny-audit) entry. The Lambda writes to a dedicated,
retained CloudWatch Log Group provisioned in the same stack.

## Keep in sync

`authorization_model.py` here is a vendored copy of
[`agentcore/authorization_model.py`](../../../agentcore/authorization_model.py)
(the property-tested surface). If the authoritative model changes, update this
copy to match.
