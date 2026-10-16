# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

AWS operators investigating cloud costs, resources, monitoring, and account activity. Existing Cognito admin and non-admin users have different tool permissions.

## Product Purpose

CloudOps Agent provides a conversational investigation workflow backed by Strands and Amazon Bedrock AgentCore. Users ask questions, observe actual tool activity, read findings, and revisit saved conversations.

## Operating Context

A React/Vite app, with either deployed AWS runtime/history or `make dev`: local AgentCore/history execution, live Cognito/Bedrock/Gateway/Memory, and disposable local conversation storage. Local history resets on backend restart. Local operation is not offline or evidence of deployed parity.

## Capabilities and Constraints

Preserve verified identity, per-user isolation, role-filtered discovery, Gateway authorization, incremental text/tool events, structured tables/charts, saved history, explicit retries, and truthful interrupted states. No autonomous cloud mutations, password resets, new authentication provider, or required hosted UI service. SpringClean protection uses `auto-delete=no` on cloud resources.

## Brand Commitments

CloudOps Agent remains the product name. The user explicitly requests a complete visual transformation and pins the official assistant-ui starter as the initial baseline: copy it first, then adapt it for the existing product. Design decisions are delegated to the implementing agent. The old shell and styling are not visual authority.

## Evidence on Hand

Real local admin inventory request, streamed tool card, final answer, and history reload were exercised. Fresh user-driven non-admin runs completed allowed billing and reported unavailable CloudWatch access without invoking restricted tools; both answers and tool states persisted in local history. The user confirmed non-admin reopen, raw-output inspection/copy, and no admin history visible. The approved targeted AWS rollout is applied; hosted sign-in/assets and control-plane readiness are verified, while authenticated deployed investigation/history checks remain pending. Do not present illustrative data as live findings.

## Product Principles

- Show actual execution state, never fabricated progress.
- Keep chat central and results understandable without inspecting raw JSON.
- Keep authorization on the backend; UI visibility is not permission.
- Make local versus deployed operation and persistence limitations explicit.

## Accessibility & Inclusion

Keyboard-operable controls, meaningful labels, visible focus, reduced-motion support, readable contrast, and structurally responsive desktop/mobile layouts are required.
