# Agentic chat QA evidence

Date: 2026-10-14–15. Feature based on `ed5ef55`; locally verified and accepted. Targeted AWS rollout of `ef72359` completed on 2026-10-15; authenticated deployed E2E remains pending. See [deployment evidence](deployment-issue36.md).

## Verified locally

- Full frontend suite: **77 passed**, including 39 rendered workflow cases. TypeScript check and production build pass after the latest restriction/raw-output/timeout fixes and the non-admin admin-only suggestion. The first verification attempt timed out under heavy machine load; the single-worker rerun passed.
- Agent runtime suite: **145 passed**, 7 skipped, 14 live integration cases deselected. The skipped/deselected tests are not claimed as passing.
- History HTTP suite against Moto DynamoDB: **18 passed**, including restricted-answer and blocked/unavailable-tool round-trips.
- Local JWT/HTTP boundary: **6 passed**, including signed-token verification, token-use separation, forged payload replacement, cross-origin denial, and rejection of expired tokens, wrong issuers/clients, and invalid signatures.
- CDK: **15 passed**. Evaluation runner: **10 passed**. Earlier unchanged-suite checks: Inventory **2 passed**, EOL scraper **70 passed**, pre-token Lambda **9 passed**, deny-audit Lambda **11 passed**.
- The real Strands 1.20 registry executes the catalogue-based reporting tool through the AgentCore SDK HTTP app. This regression reproduced and fixed the module tool's tool-use-envelope signature; registration alone did not establish execution correctness.
- Rendered regressions cover actual backend stages, the former 60-second cutoff, 130-second idle and 10-minute total limits, genuine-denial versus unavailable-tool copy, safe raw JSON/copy, role-aware suggestions, and no automatic retries. Backend stages are emitted from discovery/model/throttling boundaries, not synthetic progress.
- Login, populated workspace, and settings: axe WCAG 2 A/AA audits report zero violations and zero incomplete checks after fixing message article semantics.
- Desktop and 390px mobile layouts inspected. No document/thread horizontal overflow; wide tables scroll inside their region. Mobile drawer Escape restores focus to its toggle. Rename save/cancel and code-text fidelity have rendered regression coverage.
- The final restriction fixture exposed and fixed a long-JSON flex overflow: at 390px the thread is now 390px wide with a 390px scroll width; raw JSON is 262px wide and scrolls its 1,441px content internally. Desktop containment also passes. These are explicitly synthetic presentation checks, not live permission evidence.
- Final desktop/mobile restriction-workspace axe audits report **zero violations and zero incomplete checks** with raw output collapsed. Expanded long JSON produces zero violations and one incomplete automated contrast check for clipped scroll content. Manual measurement of the actual rendered CSS resolves that item at both 1365px and 390px: “Raw JSON” is **6.23:1** and code/copy text is **18.78:1**, exceeding the 4.5:1 small-text AA requirement. Colors were converted to sRGB through browser canvas, ancestor backgrounds alpha-composited, and WCAG relative luminance calculated; no opacity/image layers affect these elements. This is manual contrast evidence, not an automated axe pass. The earlier raw-output copy fixture and rendered copy regressions remain green. The empty sidebar now has a named navigation landmark and no empty ARIA list.
- The non-admin suggestion is visible at desktop and 390px widths without horizontal overflow. Synthetic empty-workspace axe audits report zero violations and zero incomplete checks at both widths; these do not verify an authenticated policy denial.
- Impeccable mechanical scan: no findings. The user-pinned starter is documented in `PRODUCT.md`, `DESIGN.md`, and the frontend upstream notice.

Tests are at the rendered application, runtime invocation/HTTP, and history HTTP boundaries. Older component tests were removed with the replaced components; their relevant user behaviors now live in the workflow suite.

## Live AWS services through local execution

The local UI and AgentCore SDK entrypoint run through `AWS_PROFILE=aiops_demo AWS_REGION=us-east-1 make dev`. Authentication, model, Gateway/MCP tools, and memory are real AWS services. Conversation history uses the actual Lambda handler against a disposable local DynamoDB emulator.

- Existing admin sign-in was exercised before the final shell replacement.
- A real RDS inventory request produced incremental text and a completed resource table **before** the final answer. Saving and reopening that conversation restored the structured result.
- That first request reproduced an unregistered `x_amz_bedrock_agentcore_search` call. The cause was the shared prompt requiring a tool absent from the fully paginated registered catalogue. The prompt now calls registered tools directly; a runtime-boundary regression protects this contract. Authorization was not changed.
- Two subsequent user-driven local alarm requests were confirmed in AgentCore Memory: `get_active_alarms` succeeded, with no semantic-search call. The actual stored alarm payload was replayed through the new normalizer and produced an `Active alarms` table with zero rows, not an unavailable-preview fallback.
- Parser/UI/history tests cover both nonempty alarm previews and the explicit `No active alarms found` state.
- Following the user's clarification, new tool traces include expandable, copyable raw JSON alongside optional structured previews. Tests cover save/reopen, known-credential redaction (including JSON embedded in MCP text), explicit size truncation, and withholding authorization-denial payloads. Output is inert text; it is not logged or executed.
- First-message save responses now update sidebar/header metadata immediately. A rendered regression uses the user's exact cost prompt while the agent stream remains open; an HTTP regression confirms the server-generated name and preservation of custom titles.
- A subsequent live local inventory invocation was confirmed in AgentCore Memory: `inventoryMcp___list_rds_instances` succeeded without any search call. Recent cost invocations also completed successfully without search.
- The raw-output browser fixture expands and displays formatted JSON, reports successful copy, and passes axe WCAG 2 A/AA with zero violations/incomplete checks. The fixture is explicitly labeled; it is not presented as live AWS output.

## Non-admin failure evidence and successful post-fix runs

The existing non-admin user was exercised by the user, not missing from QA. Local logs resolve the verified non-admin subject and show 42 permitted tools discovered:

- Cost session `be4d4fcf-41c7-40e9-9075-68d3a2fc9c8e`: discovery and user-message storage succeeded; no tool or assistant result was observed before the former 60-second client cutoff. The cause of the first-token delay is still unproven. A separate Bedrock connectivity check returned text in about two seconds; that does not verify this request path.
- Alarm session `481ceb55-0a36-4625-ac20-1aa43ed9a893`: the model attempted the unregistered `$MCP_TOOL_CLOUDWATCH_DESCRIBE_ALARMS`. This failed locally and was **not a Gateway policy denial**.

The latest fixes ground the prompt in that user's exact catalogue, report missing capabilities without invoking them, expose genuine backend stages, and distinguish timeout reasons. Non-admin suggestions prioritize billing/pricing and include the user-requested, explicitly admin-only CloudWatch example. Rendered tests verify that it fills the composer without sending or generating a restriction card locally.

Fresh user-driven requests now verify the post-fix runtime path with the existing non-admin identity and 42 discovered tools:

- **Allowed billing:** session `01331276-d0f5-470f-ae75-263b54738e41`, invocation at `2026-10-15T09:57:39Z`. AgentCore Memory records an assistant/tool-use message about 15 seconds later, a successful `billingMcp___cost-explorer` result, and the final answer about 36 seconds after invocation. No unregistered search call occurred. Local history contains the auto-named conversation, delivered answer, completed tool state, and safely bounded raw JSON with its truncation flag. This is a successful fresh run; it does not prove the original first-token delay's cause.
- **Restricted operational request:** session `421f961a-0ef7-4e91-ac7a-b11bcc3eb410`, invocation at `2026-10-15T10:05:35Z`. The model called only `report_access_restricted` for `cloudwatch`; its actual result says `available: false` and `accessNotice: capability-unavailable`. The model returned an explanation without inventing a tool or suggesting an AWS CLI/SDK workaround. Local history contains the delivered answer and blocked tool state with the safe raw envelope. **No CloudWatch tool was invoked; this is catalogue restriction, not a Cedar invocation-denial test.**
- **Bounded fallback:** the real billing result contains 159 service/day points, beyond the 30-point chart limit. Replaying the result through the actual normalizer correctly declines a chart rather than silently dropping costs. Markdown and labeled truncated raw JSON remain available. A successful tool call without a chart is not a tool failure.
- **Storage inspection:** both saved conversations are keyed to the verified non-admin subject; neither ID exists under the admin partition. This read-only local DynamoDB inspection confirms persistence/partitioning, not authenticated cross-user HTTP or a user-visible reopen. Rendered/history API isolation regressions remain separately verified.

### Final user acceptance

The user explicitly confirmed reopening both saved non-admin conversations, restoration of the cost answer and restriction card, raw-output inspection/copy, and no admin history visible. This is user-assisted browser evidence, not an automated cross-user HTTP test. Combined with the live runtime results and rendered/history isolation regressions, it satisfies the remaining local acceptance check.

Implementation commit `847dc4b` includes `auto-delete=no` and excludes unrelated image/runtime-stack work, `.pi/`, `CLAUDE.md`, and research artifacts. PR #38 is ready for review. The user approved the targeted `aiops_demo`/`us-east-1` plan; runtime version 7, history repair/Lambda, and Amplify job 3 are applied. [Deployment evidence and remaining checks](deployment-issue36.md) distinguish readiness from authenticated E2E.

### Completion-audit follow-up

The completion audit accepted the implementation, tests, visual acceptance, and commit, but requested additional live evidence before the goal can close:

- A supported live cost result must stream into a chart and survive save/reopen. The 159-point billing fallback above does not satisfy this particular check. A daily-total query with no service grouping should yield seven supported points.
- A direct read-only Gateway call with a valid existing non-admin token must establish an actual policy denial. Normal discovery hides CloudWatch, so the catalogue-reporting request above cannot establish invocation-policy enforcement. No tool will be added to the model catalogue or permissions changed to obtain this evidence.
- Expanded-JSON contrast is now manually verified as recorded above.

The automation browser remains signed out. These additional live checks need user-assisted access; no token may be pasted into the conversation or written to QA logs.

The user approved the replacement layout ("good to go. continue"). Visual acceptance is complete and is not being reopened.

The automation browser is signed out. The user's own authenticated browser exercised the two requests; no second login is required for log correlation. No passwords were reset, no users were created, and no authorization controls were bypassed.

## Deployment and residual risks

- **The approved targeted rollout is applied.** Runtime/DEFAULT version 7 is READY, Amplify job 3 succeeded, and the hosted sign-in/assets are verified. A tokenless IAM SSE smoke request failed Gateway JWT admission with 401, so successful deployed text/tool investigation is not claimed. [Full evidence](deployment-issue36.md).
- A live Gateway invocation-denial test was not run because the automation session has no valid non-admin token. Catalogue restriction does not prove Cedar denied a call. Invocation policy and discovery filtering were not modified.
- The deployed history table was missing before this feature. The approved repair recreated it empty with the original schema and PITR enabled; no backup was listed and old conversations were not recovered. A read-only Lambda/database list succeeds, but authenticated deployed history CRUD/reopen still needs verification.
- `auto-delete=no` is present at the CDK app level and verified on the eight touched/new rollout resources. The inspected synthesized templates also include it on every tag-bearing resource; this does not prove deployment tagging on untouched resources or tag support for every resource type. Direct-service image/code/tag changes introduce CFN drift requiring deliberate reconciliation.
- The build reports a large JavaScript chunk (approximately 1.49 MB / 437 KB gzip). npm audit previously reported 11 dependency advisories; no broad toolchain upgrade was included.
- The model's first inventory answer misinterpreted an end-of-support date. The fresh non-admin "last 7 days" request selected `2026-10-08` through the exclusive end `2026-10-16`, producing eight daily periods. The UI preserves source data; successful transport/permission checks do not establish model answer accuracy.
- Local history is lost when the backend restarts. Bedrock/Gateway/Memory calls are real and may incur normal AWS charges.
