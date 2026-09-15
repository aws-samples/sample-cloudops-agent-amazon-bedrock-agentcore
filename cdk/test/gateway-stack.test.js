"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = __importStar(require("aws-cdk-lib"));
const child_process_1 = require("child_process");
const assertions_1 = require("aws-cdk-lib/assertions");
const gateway_stack_1 = require("../lib/gateway-stack");
/**
 * CDK snapshot / regression test for AgentCoreGatewayStack.
 *
 * Feature: gateway-tool-access-control (Requirements 1.5, 6.2, 6.3).
 * See design.md, Testing Strategy -> "Regression / snapshot tests (IaC)":
 * the GatewayStack snapshot asserts the Gateway uses CUSTOM_JWT inbound
 * authorization (Cognito discovery URL + AllowedClients) and that the Cedar
 * policy set carries exactly the two `permit` statements (billing/pricing for
 * all authenticated users; cloudwatch/cloudtrail/inventory for admins only),
 * with every other category denied by omission (default-deny).
 *
 * The gateway ARN is a CloudFormation intrinsic (Fn::GetAtt) embedded inside
 * the Cedar statement strings, so the statements render as `Fn::Join`
 * structures. We assert on the stable literal substrings of each statement
 * (`tool_category == "billing"`, `getTag("role") == "admin"`, ...) rather than
 * the full ARN.
 */
describe('AgentCoreGatewayStack', () => {
    const FRONTEND_CLIENT_ID = 'dummy-frontend-client-id';
    let template;
    beforeAll(() => {
        const app = new cdk.App();
        const stack = new gateway_stack_1.AgentCoreGatewayStack(app, 'TestGatewayStack', {
            env: { account: '123456789012', region: 'us-east-1' },
            billingMcpRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/billing',
            billingMcpRuntimeEndpoint: 'https://billing.example.com/mcp',
            pricingMcpRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/pricing',
            pricingMcpRuntimeEndpoint: 'https://pricing.example.com/mcp',
            cloudwatchMcpRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/cloudwatch',
            cloudwatchMcpRuntimeEndpoint: 'https://cloudwatch.example.com/mcp',
            cloudtrailMcpRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/cloudtrail',
            cloudtrailMcpRuntimeEndpoint: 'https://cloudtrail.example.com/mcp',
            inventoryMcpRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/inventory',
            inventoryMcpRuntimeEndpoint: 'https://inventory.example.com/mcp',
            authUserPoolId: 'us-east-1_DUMMYPOOL',
            authUserPoolArn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_DUMMYPOOL',
            authM2mClientId: 'dummy-m2m-client-id',
            authUserPoolClientId: FRONTEND_CLIENT_ID,
        });
        template = assertions_1.Template.fromStack(stack);
    });
    /**
     * Recursively collect every string literal from a value. CloudFormation
     * intrinsics (Fn::Join / Fn::GetAtt) are plain objects/arrays, so this
     * flattens an Fn::Join'd Cedar statement back into its literal fragments.
     */
    function collectStrings(node) {
        if (typeof node === 'string') {
            return [node];
        }
        if (Array.isArray(node)) {
            return node.flatMap(collectStrings);
        }
        if (node && typeof node === 'object') {
            return Object.values(node).flatMap(collectStrings);
        }
        return [];
    }
    test('OAuth handler completes requests without logging secrets', () => {
        const functions = template.findResources('AWS::Lambda::Function');
        const provider = Object.entries(functions).find(([id]) => id.startsWith('OAuthProviderFunction'));
        expect(provider).toBeDefined();
        const code = provider[1].Properties.Code.ZipFile;
        (0, child_process_1.execFileSync)('uv', ['run', '--with', 'boto3', 'python', '-c', `
import io, json, logging, sys
from unittest.mock import patch, MagicMock
namespace = {}
exec(sys.stdin.read(), namespace)
event = {
    'RequestType': 'Create', 'RequestId': 'test', 'StackId': 'test',
    'LogicalResourceId': 'OAuthProvider',
    'ResponseURL': 'https://example.com/SECRET_RESPONSE_URL',
    'ResourceProperties': {'ProviderName': 'test', 'ClientSecret': 'SECRET_SENTINEL'},
}
client = MagicMock()
client.create_oauth2_credential_provider.return_value = {
    'credentialProviderArn': 'provider', 'clientSecretArn': {'secretArn': 'secret'},
}
for request_type in ('Create', 'Update', 'Delete'):
    output = io.StringIO()
    handler = logging.StreamHandler(output)
    logging.getLogger().addHandler(handler)
    event['RequestType'] = request_type
    try:
        with patch('boto3.client', return_value=client), patch('urllib.request.urlopen') as send:
            namespace['handler'](event, None)
            response = json.loads(send.call_args.args[0].data)
            assert response['Status'] == 'SUCCESS', response
        assert 'SECRET_SENTINEL' not in output.getvalue(), 'Client secret leaked'
        assert 'SECRET_RESPONSE_URL' not in output.getvalue(), 'Response URL leaked'
    finally:
        logging.getLogger().removeHandler(handler)
`], { input: code, stdio: ['pipe', 'pipe', 'pipe'] });
    }, 60000);
    test('Gateway uses CUSTOM_JWT inbound authorization (Req 1.5)', () => {
        template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
            AuthorizerType: 'CUSTOM_JWT',
        });
    });
    test('CUSTOM_JWT authorizer points at the Cognito discovery URL and allows the frontend client (Req 1.5)', () => {
        template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
            AuthorizerConfiguration: assertions_1.Match.objectLike({
                CustomJWTAuthorizer: assertions_1.Match.objectLike({
                    DiscoveryUrl: assertions_1.Match.stringLikeRegexp('.*\\.well-known/openid-configuration$'),
                    // Cognito access tokens match on client_id (AllowedClients), not aud.
                    AllowedClients: assertions_1.Match.arrayWith([FRONTEND_CLIENT_ID]),
                }),
            }),
        });
    });
    test('Gateway associates the Cedar Policy Engine in ENFORCE mode', () => {
        template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
            PolicyEngineConfiguration: assertions_1.Match.objectLike({
                Mode: 'ENFORCE',
            }),
        });
    });
    test('Gateway registers a REQUEST interceptor (deny-audit)', () => {
        template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
            InterceptorConfigurations: assertions_1.Match.arrayWith([
                assertions_1.Match.objectLike({
                    InterceptionPoints: assertions_1.Match.arrayWith(['REQUEST']),
                }),
            ]),
        });
    });
    describe('Cedar policy set (Req 6.2, 6.3 — default-deny by omission)', () => {
        // Locate the custom resource that carries the Cedar policy statements.
        function getPolicyStatements() {
            const customResources = template.findResources('AWS::CloudFormation::CustomResource');
            const policyResources = Object.values(customResources).filter((r) => r.Properties && r.Properties.Operation === 'POLICIES');
            expect(policyResources).toHaveLength(1);
            const statements = policyResources[0].Properties.Statements;
            expect(Array.isArray(statements)).toBe(true);
            return statements;
        }
        test('exactly two permit statements are present', () => {
            const statements = getPolicyStatements();
            expect(statements).toHaveLength(2);
            // Every Cedar statement in the set is a `permit` (no `forbid`/deny rules),
            // and there are exactly two of them across the whole policy set.
            const allText = collectStrings(statements).join('\n');
            const permitCount = (allText.match(/permit\(/g) || []).length;
            expect(permitCount).toBe(2);
            expect(allText).not.toContain('forbid(');
        });
        test('billing/pricing permit applies to all users and references no other target group', () => {
            const statements = getPolicyStatements();
            const allUsers = statements.find((s) => s.Name === 'allow_billing_pricing_all_users');
            expect(allUsers).toBeDefined();
            const text = collectStrings(allUsers.Statement).join('\n');
            // Scoped to the billing/pricing target action groups (no per-tool enum).
            expect(text).toContain('AgentCore::Action::"billingMcp"');
            expect(text).toContain('AgentCore::Action::"pricingMcp"');
            // Not gated on the admin role tag, and never grants an ops category.
            expect(text).not.toContain('getTag("role")');
            expect(text).not.toContain('cloudwatchMcp');
            expect(text).not.toContain('cloudtrailMcp');
            expect(text).not.toContain('inventoryMcp');
        });
        test('cloudwatch/cloudtrail/inventory permit is admin-only and references no all-user target group', () => {
            const statements = getPolicyStatements();
            const adminOnly = statements.find((s) => s.Name === 'allow_ops_categories_admin_only');
            expect(adminOnly).toBeDefined();
            const text = collectStrings(adminOnly.Statement).join('\n');
            // Guarded on the verified JWT role claim (stored as a principal tag).
            expect(text).toContain('getTag("role") == "admin"');
            expect(text).toContain('AgentCore::Action::"cloudwatchMcp"');
            expect(text).toContain('AgentCore::Action::"cloudtrailMcp"');
            expect(text).toContain('AgentCore::Action::"inventoryMcp"');
            // The admin permit must not silently widen billing/pricing access.
            expect(text).not.toContain('AgentCore::Action::"billingMcp"');
            expect(text).not.toContain('AgentCore::Action::"pricingMcp"');
        });
        test('no permit exists for any target group outside the documented five (default-deny)', () => {
            const statements = getPolicyStatements();
            const allText = collectStrings(statements).join('\n');
            // Collect every target action group referenced anywhere in the policy set.
            const referenced = new Set(Array.from(allText.matchAll(/AgentCore::Action::"([^"]+)"/g)).map((m) => m[1]));
            const allowed = new Set([
                'billingMcp',
                'pricingMcp',
                'cloudwatchMcp',
                'cloudtrailMcp',
                'inventoryMcp',
            ]);
            for (const target of referenced) {
                expect(allowed.has(target)).toBe(true);
            }
            // All five known target groups are accounted for; anything else (incl.
            // future targets) is denied by omission for non-admins.
            expect(referenced).toEqual(allowed);
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2F0ZXdheS1zdGFjay50ZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZ2F0ZXdheS1zdGFjay50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLGlEQUE2QztBQUM3Qyx1REFBeUQ7QUFDekQsd0RBQTZEO0FBRTdEOzs7Ozs7Ozs7Ozs7Ozs7O0dBZ0JHO0FBQ0gsUUFBUSxDQUFDLHVCQUF1QixFQUFFLEdBQUcsRUFBRTtJQUNyQyxNQUFNLGtCQUFrQixHQUFHLDBCQUEwQixDQUFDO0lBQ3RELElBQUksUUFBa0IsQ0FBQztJQUV2QixTQUFTLENBQUMsR0FBRyxFQUFFO1FBQ2IsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7UUFDMUIsTUFBTSxLQUFLLEdBQUcsSUFBSSxxQ0FBcUIsQ0FBQyxHQUFHLEVBQUUsa0JBQWtCLEVBQUU7WUFDL0QsR0FBRyxFQUFFLEVBQUUsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLEVBQUUsV0FBVyxFQUFFO1lBQ3JELG9CQUFvQixFQUFFLGtFQUFrRTtZQUN4Rix5QkFBeUIsRUFBRSxpQ0FBaUM7WUFDNUQsb0JBQW9CLEVBQUUsa0VBQWtFO1lBQ3hGLHlCQUF5QixFQUFFLGlDQUFpQztZQUM1RCx1QkFBdUIsRUFBRSxxRUFBcUU7WUFDOUYsNEJBQTRCLEVBQUUsb0NBQW9DO1lBQ2xFLHVCQUF1QixFQUFFLHFFQUFxRTtZQUM5Riw0QkFBNEIsRUFBRSxvQ0FBb0M7WUFDbEUsc0JBQXNCLEVBQUUsb0VBQW9FO1lBQzVGLDJCQUEyQixFQUFFLG1DQUFtQztZQUNoRSxjQUFjLEVBQUUscUJBQXFCO1lBQ3JDLGVBQWUsRUFBRSx5RUFBeUU7WUFDMUYsZUFBZSxFQUFFLHFCQUFxQjtZQUN0QyxvQkFBb0IsRUFBRSxrQkFBa0I7U0FDekMsQ0FBQyxDQUFDO1FBQ0gsUUFBUSxHQUFHLHFC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LENBQUMsVUFBVSxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBRXRELDJFQUEyRTtZQUMzRSxNQUFNLFVBQVUsR0FBRyxJQUFJLEdBQUcsQ0FDeEIsS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLCtCQUErQixDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUMvRSxDQUFDO1lBQ0YsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUM7Z0JBQ3RCLFlBQVk7Z0JBQ1osWUFBWTtnQkFDWixlQUFlO2dCQUNmLGVBQWU7Z0JBQ2YsY0FBYzthQUNmLENBQUMsQ0FBQztZQUNILEtBQUssTUFBTSxNQUFNLElBQUksVUFBVSxFQUFFLENBQUM7Z0JBQ2hDLE1BQU0sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3pDLENBQUM7WUFDRCx1RUFBdUU7WUFDdkUsd0RBQXdEO1lBQ3hELE1BQU0sQ0FBQyxVQUFVLENBQUMsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDdEMsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHsgTWF0Y2gsIFRlbXBsYXRlIH0gZnJvbSAnYXdzLWNkay1saWIvYXNzZXJ0aW9ucyc7XG5pbXBvcnQgeyBBZ2VudENvcmVHYXRld2F5U3RhY2sgfSBmcm9tICcuLi9saWIvZ2F0ZXdheS1zdGFjayc7XG5cbi8qKlxuICogQ0RLIHNuYXBzaG90IC8gcmVncmVzc2lvbiB0ZXN0IGZvciBBZ2VudENvcmVHYXRld2F5U3RhY2suXG4gKlxuICogRmVhdHVyZTogZ2F0ZXdheS10b29sLWFjY2Vzcy1jb250cm9sIChSZXF1aXJlbWVudHMgMS41LCA2LjIsIDYuMykuXG4gKiBTZWUgZGVzaWduLm1kLCBUZXN0aW5nIFN0cmF0ZWd5IC0+IFwiUmVncmVzc2lvbiAvIHNuYXBzaG90IHRlc3RzIChJYUMpXCI6XG4gKiB0aGUgR2F0ZXdheVN0YWNrIHNuYXBzaG90IGFzc2VydHMgdGhlIEdhdGV3YXkgdXNlcyBDVVNUT01fSldUIGluYm91bmRcbiAqIGF1dGhvcml6YXRpb24gKENvZ25pdG8gZGlzY292ZXJ5IFVSTCArIEFsbG93ZWRDbGllbnRzKSBhbmQgdGhhdCB0aGUgQ2VkYXJcbiAqIHBvbGljeSBzZXQgY2FycmllcyBleGFjdGx5IHRoZSB0d28gYHBlcm1pdGAgc3RhdGVtZW50cyAoYmlsbGluZy9wcmljaW5nIGZvclxuICogYWxsIGF1dGhlbnRpY2F0ZWQgdXNlcnM7IGNsb3Vkd2F0Y2gvY2xvdWR0cmFpbC9pbnZlbnRvcnkgZm9yIGFkbWlucyBvbmx5KSxcbiAqIHdpdGggZXZlcnkgb3RoZXIgY2F0ZWdvcnkgZGVuaWVkIGJ5IG9taXNzaW9uIChkZWZhdWx0LWRlbnkpLlxuICpcbiAqIFRoZSBnYXRld2F5IEFSTiBpcyBhIENsb3VkRm9ybWF0aW9uIGludHJpbnNpYyAoRm46OkdldEF0dCkgZW1iZWRkZWQgaW5zaWRlXG4gKiB0aGUgQ2VkYXIgc3RhdGVtZW50IHN0cmluZ3MsIHNvIHRoZSBzdGF0ZW1lbnRzIHJlbmRlciBhcyBgRm46OkpvaW5gXG4gKiBzdHJ1Y3R1cmVzLiBXZSBhc3NlcnQgb24gdGhlIHN0YWJsZSBsaXRlcmFsIHN1YnN0cmluZ3Mgb2YgZWFjaCBzdGF0ZW1lbnRcbiAqIChgdG9vbF9jYXRlZ29yeSA9PSBcImJpbGxpbmdcImAsIGBnZXRUYWcoXCJyb2xlXCIpID09IFwiYWRtaW5cImAsIC4uLikgcmF0aGVyIHRoYW5cbiAqIHRoZSBmdWxsIEFSTi5cbiAqL1xuZGVzY3JpYmUoJ0FnZW50Q29yZUdhdGV3YXlTdGFjaycsICgpID0+IHtcbiAgY29uc3QgRlJPTlRFTkRfQ0xJRU5UX0lEID0gJ2R1bW15LWZyb250ZW5kLWNsaWVudC1pZCc7XG4gIGxldCB0ZW1wbGF0ZTogVGVtcGxhdGU7XG5cbiAgYmVmb3JlQWxsKCgpID0+IHtcbiAgICBjb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICAgIGNvbnN0IHN0YWNrID0gbmV3IEFnZW50Q29yZUdhdGV3YXlTdGFjayhhcHAsICdUZXN0R2F0ZXdheVN0YWNrJywge1xuICAgICAgZW52OiB7IGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLCByZWdpb246ICd1cy1lYXN0LTEnIH0sXG4gICAgICBiaWxsaW5nTWNwUnVudGltZUFybjogJ2Fybjphd3M6YmVkcm9jay1hZ2VudGNvcmU6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpydW50aW1lL2JpbGxpbmcnLFxuICAgICAgYmlsbGluZ01jcFJ1bnRpbWVFbmRwb2ludDogJ2h0dHBzOi8vYmlsbGluZy5leGFtcGxlLmNvbS9tY3AnLFxuICAgICAgcHJpY2luZ01jcFJ1bnRpbWVBcm46ICdhcm46YXdzOmJlZHJvY2stYWdlbnRjb3JlOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6cnVudGltZS9wcmljaW5nJyxcbiAgICAgIHByaWNpbmdNY3BSdW50aW1lRW5kcG9pbnQ6ICdodHRwczovL3ByaWNpbmcuZXhhbXBsZS5jb20vbWNwJyxcbiAgICAgIGNsb3Vkd2F0Y2hNY3BSdW50aW1lQXJuOiAnYXJuOmF3czpiZWRyb2NrLWFnZW50Y29yZTp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOnJ1bnRpbWUvY2xvdWR3YXRjaCcsXG4gICAgICBjbG91ZHdhdGNoTWNwUnVudGltZUVuZHBvaW50OiAnaHR0cHM6Ly9jbG91ZHdhdGNoLmV4YW1wbGUuY29tL21jcCcsXG4gICAgICBjbG91ZHRyYWlsTWNwUnVudGltZUFybjogJ2Fybjphd3M6YmVkcm9jay1hZ2VudGNvcmU6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpydW50aW1lL2Nsb3VkdHJhaWwnLFxuICAgICAgY2xvdWR0cmFpbE1jcFJ1bnRpbWVFbmRwb2ludDogJ2h0dHBzOi8vY2xvdWR0cmFpbC5leGFtcGxlLmNvbS9tY3AnLFxuICAgICAgaW52ZW50b3J5TWNwUnVudGltZUFybjogJ2Fybjphd3M6YmVkcm9jay1hZ2VudGNvcmU6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpydW50aW1lL2ludmVudG9yeScsXG4gICAgICBpbnZlbnRvcnlNY3BSdW50aW1lRW5kcG9pbnQ6ICdodHRwczovL2ludmVudG9yeS5leGFtcGxlLmNvbS9tY3AnLFxuICAgICAgYXV0aFVzZXJQb29sSWQ6ICd1cy1lYXN0LTFfRFVNTVlQT09MJyxcbiAgICAgIGF1dGhVc2VyUG9vbEFybjogJ2Fybjphd3M6Y29nbml0by1pZHA6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjp1c2VycG9vbC91cy1lYXN0LTFfRFVNTVlQT09MJyxcbiAgICAgIGF1dGhNMm1DbGllbnRJZDogJ2R1bW15LW0ybS1jbGllbnQtaWQnLFxuICAgICAgYXV0aFVzZXJQb29sQ2xpZW50SWQ6IEZST05URU5EX0NMSUVOVF9JRCxcbiAgICB9KTtcbiAgICB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gIH0pO1xuXG4gIC8qKlxuICAgKiBSZWN1cnNpdmVseSBjb2xsZWN0IGV2ZXJ5IHN0cmluZyBsaXRlcmFsIGZyb20gYSB2YWx1ZS4gQ2xvdWRGb3JtYXRpb25cbiAgICogaW50cmluc2ljcyAoRm46OkpvaW4gLyBGbjo6R2V0QXR0KSBhcmUgcGxhaW4gb2JqZWN0cy9hcnJheXMsIHNvIHRoaXNcbiAgICogZmxhdHRlbnMgYW4gRm46OkpvaW4nZCBDZWRhciBzdGF0ZW1lbnQgYmFjayBpbnRvIGl0cyBsaXRlcmFsIGZyYWdtZW50cy5cbiAgICovXG4gIGZ1bmN0aW9uIGNvbGxlY3RTdHJpbmdzKG5vZGU6IHVua25vd24pOiBzdHJpbmdbXSB7XG4gICAgaWYgKHR5cGVvZiBub2RlID09PSAnc3RyaW5nJykge1xuICAgICAgcmV0dXJuIFtub2RlXTtcbiAgICB9XG4gICAgaWYgKEFycmF5LmlzQXJyYXkobm9kZSkpIHtcbiAgICAgIHJldHVybiBub2RlLmZsYXRNYXAoY29sbGVjdFN0cmluZ3MpO1xuICAgIH1cbiAgICBpZiAobm9kZSAmJiB0eXBlb2Ygbm9kZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgIHJldHVybiBPYmplY3QudmFsdWVzKG5vZGUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLmZsYXRNYXAoY29sbGVjdFN0cmluZ3MpO1xuICAgIH1cbiAgICByZXR1cm4gW107XG4gIH1cblxuICB0ZXN0KCdPQXV0aCBoYW5kbGVyIGNvbXBsZXRlcyByZXF1ZXN0cyB3aXRob3V0IGxvZ2dpbmcgc2VjcmV0cycsICgpID0+IHtcbiAgICBjb25zdCBmdW5jdGlvbnMgPSB0ZW1wbGF0ZS5maW5kUmVzb3VyY2VzKCdBV1M6OkxhbWJkYTo6RnVuY3Rpb24nKTtcbiAgICBjb25zdCBwcm92aWRlciA9IE9iamVjdC5lbnRyaWVzKGZ1bmN0aW9ucykuZmluZCgoW2lkXSkgPT4gaWQuc3RhcnRzV2l0aCgnT0F1dGhQcm92aWRlckZ1bmN0aW9uJykpO1xuICAgIGV4cGVjdChwcm92aWRlcikudG9CZURlZmluZWQoKTtcbiAgICBjb25zdCBjb2RlID0gcHJvdmlkZXIhWzFdLlByb3BlcnRpZXMuQ29kZS5aaXBGaWxlO1xuICAgIGV4ZWNGaWxlU3luYygndXYnLCBbJ3J1bicsICctLXdpdGgnLCAnYm90bzMnLCAncHl0aG9uJywgJy1jJywgYFxuaW1wb3J0IGlvLCBqc29uLCBsb2dnaW5nLCBzeXNcbmZyb20gdW5pdHRlc3QubW9jayBpbXBvcnQgcGF0Y2gsIE1hZ2ljTW9ja1xubmFtZXNwYWNlID0ge31cbmV4ZWMoc3lzLnN0ZGluLnJlYWQoKSwgbmFtZXNwYWNlKVxuZXZlbnQgPSB7XG4gICAgJ1JlcXVlc3RUeXBlJzogJ0NyZWF0ZScsICdSZXF1ZXN0SWQnOiAndGVzdCcsICdTdGFja0lkJzogJ3Rlc3QnLFxuICAgICdMb2dpY2FsUmVzb3VyY2VJZCc6ICdPQXV0aFByb3ZpZGVyJyxcbiAgICAnUmVzcG9uc2VVUkwnOiAnaHR0cHM6Ly9leGFtcGxlLmNvbS9TRUNSRVRfUkVTUE9OU0VfVVJMJyxcbiAgICAnUmVzb3VyY2VQcm9wZXJ0aWVzJzogeydQcm92aWRlck5hbWUnOiAndGVzdCcsICdDbGllbnRTZWNyZXQnOiAnU0VDUkVUX1NFTlRJTkVMJ30sXG59XG5jbGllbnQgPSBNYWdpY01vY2soKVxuY2xpZW50LmNyZWF0ZV9vYXV0aDJfY3JlZGVudGlhbF9wcm92aWRlci5yZXR1cm5fdmFsdWUgPSB7XG4gICAgJ2NyZWRlbnRpYWxQcm92aWRlckFybic6ICdwcm92aWRlcicsICdjbGllbnRTZWNyZXRBcm4nOiB7J3NlY3JldEFybic6ICdzZWNyZXQnfSxcbn1cbmZvciByZXF1ZXN0X3R5cGUgaW4gKCdDcmVhdGUnLCAnVXBkYXRlJywgJ0RlbGV0ZScpOlxuICAgIG91dHB1dCA9IGlvLlN0cmluZ0lPKClcbiAgICBoYW5kbGVyID0gbG9nZ2luZy5TdHJlYW1IYW5kbGVyKG91dHB1dClcbiAgICBsb2dnaW5nLmdldExvZ2dlcigpLmFkZEhhbmRsZXIoaGFuZGxlcilcbiAgICBldmVudFsnUmVxdWVzdFR5cGUnXSA9IHJlcXVlc3RfdHlwZVxuICAgIHRyeTpcbiAgICAgICAgd2l0aCBwYXRjaCgnYm90bzMuY2xpZW50JywgcmV0dXJuX3ZhbHVlPWNsaWVudCksIHBhdGNoKCd1cmxsaWIucmVxdWVzdC51cmxvcGVuJykgYXMgc2VuZDpcbiAgICAgICAgICAgIG5hbWVzcGFjZVsnaGFuZGxlciddKGV2ZW50LCBOb25lKVxuICAgICAgICAgICAgcmVzcG9uc2UgPSBqc29uLmxvYWRzKHNlbmQuY2FsbF9hcmdzLmFyZ3NbMF0uZGF0YSlcbiAgICAgICAgICAgIGFzc2VydCByZXNwb25zZVsnU3RhdHVzJ10gPT0gJ1NVQ0NFU1MnLCByZXNwb25zZVxuICAgICAgICBhc3NlcnQgJ1NFQ1JFVF9TRU5USU5FTCcgbm90IGluIG91dHB1dC5nZXR2YWx1ZSgpLCAnQ2xpZW50IHNlY3JldCBsZWFrZWQnXG4gICAgICAgIGFzc2VydCAnU0VDUkVUX1JFU1BPTlNFX1VSTCcgbm90IGluIG91dHB1dC5nZXR2YWx1ZSgpLCAnUmVzcG9uc2UgVVJMIGxlYWtlZCdcbiAgICBmaW5hbGx5OlxuICAgICAgICBsb2dnaW5nLmdldExvZ2dlcigpLnJlbW92ZUhhbmRsZXIoaGFuZGxlcilcbmBdLCB7IGlucHV0OiBjb2RlLCBzdGRpbzogWydwaXBlJywgJ3BpcGUnLCAncGlwZSddIH0pO1xuICB9LCA2MDAwMCk7XG5cbiAgdGVzdCgnR2F0ZXdheSB1c2VzIENVU1RPTV9KV1QgaW5ib3VuZCBhdXRob3JpemF0aW9uIChSZXEgMS41KScsICgpID0+IHtcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheScsIHtcbiAgICAgIEF1dGhvcml6ZXJUeXBlOiAnQ1VTVE9NX0pXVCcsXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ0NVU1RPTV9KV1QgYXV0aG9yaXplciBwb2ludHMgYXQgdGhlIENvZ25pdG8gZGlzY292ZXJ5IFVSTCBhbmQgYWxsb3dzIHRoZSBmcm9udGVuZCBjbGllbnQgKFJlcSAxLjUpJywgKCkgPT4ge1xuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpHYXRld2F5Jywge1xuICAgICAgQXV0aG9yaXplckNvbmZpZ3VyYXRpb246IE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICBDdXN0b21KV1RBdXRob3JpemVyOiBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICBEaXNjb3ZlcnlVcmw6IE1hdGNoLnN0cmluZ0xpa2VSZWdleHAoJy4qXFxcXC53ZWxsLWtub3duL29wZW5pZC1jb25maWd1cmF0aW9uJCcpLFxuICAgICAgICAgIC8vIENvZ25pdG8gYWNjZXNzIHRva2VucyBtYXRjaCBvbiBjbGllbnRfaWQgKEFsbG93ZWRDbGllbnRzKSwgbm90IGF1ZC5cbiAgICAgICAgICBBbGxvd2VkQ2xpZW50czogTWF0Y2guYXJyYXlXaXRoKFtGUk9OVEVORF9DTElFTlRfSURdKSxcbiAgICAgICAgfSksXG4gICAgICB9KSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnR2F0ZXdheSBhc3NvY2lhdGVzIHRoZSBDZWRhciBQb2xpY3kgRW5naW5lIGluIEVORk9SQ0UgbW9kZScsICgpID0+IHtcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheScsIHtcbiAgICAgIFBvbGljeUVuZ2luZUNvbmZpZ3VyYXRpb246IE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICBNb2RlOiAnRU5GT1JDRScsXG4gICAgICB9KSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnR2F0ZXdheSByZWdpc3RlcnMgYSBSRVFVRVNUIGludGVyY2VwdG9yIChkZW55LWF1ZGl0KScsICgpID0+IHtcbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheScsIHtcbiAgICAgIEludGVyY2VwdG9yQ29uZmlndXJhdGlvbnM6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgIE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgIEludGVyY2VwdGlvblBvaW50czogTWF0Y2guYXJyYXlXaXRoKFsnUkVRVUVTVCddKSxcbiAgICAgICAgfSksXG4gICAgICBdKSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ0NlZGFyIHBvbGljeSBzZXQgKFJlcSA2LjIsIDYuMyDigJQgZGVmYXVsdC1kZW55IGJ5IG9taXNzaW9uKScsICgpID0+IHtcbiAgICAvLyBMb2NhdGUgdGhlIGN1c3RvbSByZXNvdXJjZSB0aGF0IGNhcnJpZXMgdGhlIENlZGFyIHBvbGljeSBzdGF0ZW1lbnRzLlxuICAgIGZ1bmN0aW9uIGdldFBvbGljeVN0YXRlbWVudHMoKTogQXJyYXk8eyBOYW1lOiBzdHJpbmc7IFN0YXRlbWVudDogdW5rbm93biB9PiB7XG4gICAgICBjb25zdCBjdXN0b21SZXNvdXJjZXMgPSB0ZW1wbGF0ZS5maW5kUmVzb3VyY2VzKCdBV1M6OkNsb3VkRm9ybWF0aW9uOjpDdXN0b21SZXNvdXJjZScpO1xuICAgICAgY29uc3QgcG9saWN5UmVzb3VyY2VzID0gT2JqZWN0LnZhbHVlcyhjdXN0b21SZXNvdXJjZXMpLmZpbHRlcihcbiAgICAgICAgKHI6IGFueSkgPT4gci5Qcm9wZXJ0aWVzICYmIHIuUHJvcGVydGllcy5PcGVyYXRpb24gPT09ICdQT0xJQ0lFUycsXG4gICAgICApO1xuICAgICAgZXhwZWN0KHBvbGljeVJlc291cmNlcykudG9IYXZlTGVuZ3RoKDEpO1xuICAgICAgY29uc3Qgc3RhdGVtZW50cyA9IChwb2xpY3lSZXNvdXJjZXNbMF0gYXMgYW55KS5Qcm9wZXJ0aWVzLlN0YXRlbWVudHM7XG4gICAgICBleHBlY3QoQXJyYXkuaXNBcnJheShzdGF0ZW1lbnRzKSkudG9CZSh0cnVlKTtcbiAgICAgIHJldHVybiBzdGF0ZW1lbnRzO1xuICAgIH1cblxuICAgIHRlc3QoJ2V4YWN0bHkgdHdvIHBlcm1pdCBzdGF0ZW1lbnRzIGFyZSBwcmVzZW50JywgKCkgPT4ge1xuICAgICAgY29uc3Qgc3RhdGVtZW50cyA9IGdldFBvbGljeVN0YXRlbWVudHMoKTtcbiAgICAgIGV4cGVjdChzdGF0ZW1lbnRzKS50b0hhdmVMZW5ndGgoMik7XG5cbiAgICAgIC8vIEV2ZXJ5IENlZGFyIHN0YXRlbWVudCBpbiB0aGUgc2V0IGlzIGEgYHBlcm1pdGAgKG5vIGBmb3JiaWRgL2RlbnkgcnVsZXMpLFxuICAgICAgLy8gYW5kIHRoZXJlIGFyZSBleGFjdGx5IHR3byBvZiB0aGVtIGFjcm9zcyB0aGUgd2hvbGUgcG9saWN5IHNldC5cbiAgICAgIGNvbnN0IGFsbFRleHQgPSBjb2xsZWN0U3RyaW5ncyhzdGF0ZW1lbnRzKS5qb2luKCdcXG4nKTtcbiAgICAgIGNvbnN0IHBlcm1pdENvdW50ID0gKGFsbFRleHQubWF0Y2goL3Blcm1pdFxcKC9nKSB8fCBbXSkubGVuZ3RoO1xuICAgICAgZXhwZWN0KHBlcm1pdENvdW50KS50b0JlKDIpO1xuICAgICAgZXhwZWN0KGFsbFRleHQpLm5vdC50b0NvbnRhaW4oJ2ZvcmJpZCgnKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2JpbGxpbmcvcHJpY2luZyBwZXJtaXQgYXBwbGllcyB0byBhbGwgdXNlcnMgYW5kIHJlZmVyZW5jZXMgbm8gb3RoZXIgdGFyZ2V0IGdyb3VwJywgKCkgPT4ge1xuICAgICAgY29uc3Qgc3RhdGVtZW50cyA9IGdldFBvbGljeVN0YXRlbWVudHMoKTtcbiAgICAgIGNvbnN0IGFsbFVzZXJzID0gc3RhdGVtZW50cy5maW5kKChzKSA9PiBzLk5hbWUgPT09ICdhbGxvd19iaWxsaW5nX3ByaWNpbmdfYWxsX3VzZXJzJyk7XG4gICAgICBleHBlY3QoYWxsVXNlcnMpLnRvQmVEZWZpbmVkKCk7XG5cbiAgICAgIGNvbnN0IHRleHQgPSBjb2xsZWN0U3RyaW5ncyhhbGxVc2VycyEuU3RhdGVtZW50KS5qb2luKCdcXG4nKTtcbiAgICAgIC8vIFNjb3BlZCB0byB0aGUgYmlsbGluZy9wcmljaW5nIHRhcmdldCBhY3Rpb24gZ3JvdXBzIChubyBwZXItdG9vbCBlbnVtKS5cbiAgICAgIGV4cGVjdCh0ZXh0KS50b0NvbnRhaW4oJ0FnZW50Q29yZTo6QWN0aW9uOjpcImJpbGxpbmdNY3BcIicpO1xuICAgICAgZXhwZWN0KHRleHQpLnRvQ29udGFpbignQWdlbnRDb3JlOjpBY3Rpb246OlwicHJpY2luZ01jcFwiJyk7XG5cbiAgICAgIC8vIE5vdCBnYXRlZCBvbiB0aGUgYWRtaW4gcm9sZSB0YWcsIGFuZCBuZXZlciBncmFudHMgYW4gb3BzIGNhdGVnb3J5LlxuICAgICAgZXhwZWN0KHRleHQpLm5vdC50b0NvbnRhaW4oJ2dldFRhZyhcInJvbGVcIiknKTtcbiAgICAgIGV4cGVjdCh0ZXh0KS5ub3QudG9Db250YWluKCdjbG91ZHdhdGNoTWNwJyk7XG4gICAgICBleHBlY3QodGV4dCkubm90LnRvQ29udGFpbignY2xvdWR0cmFpbE1jcCcpO1xuICAgICAgZXhwZWN0KHRleHQpLm5vdC50b0NvbnRhaW4oJ2ludmVudG9yeU1jcCcpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY2xvdWR3YXRjaC9jbG91ZHRyYWlsL2ludmVudG9yeSBwZXJtaXQgaXMgYWRtaW4tb25seSBhbmQgcmVmZXJlbmNlcyBubyBhbGwtdXNlciB0YXJnZXQgZ3JvdXAnLCAoKSA9PiB7XG4gICAgICBjb25zdCBzdGF0ZW1lbnRzID0gZ2V0UG9saWN5U3RhdGVtZW50cygpO1xuICAgICAgY29uc3QgYWRtaW5Pbmx5ID0gc3RhdGVtZW50cy5maW5kKChzKSA9PiBzLk5hbWUgPT09ICdhbGxvd19vcHNfY2F0ZWdvcmllc19hZG1pbl9vbmx5Jyk7XG4gICAgICBleHBlY3QoYWRtaW5Pbmx5KS50b0JlRGVmaW5lZCgpO1xuXG4gICAgICBjb25zdCB0ZXh0ID0gY29sbGVjdFN0cmluZ3MoYWRtaW5Pbmx5IS5TdGF0ZW1lbnQpLmpvaW4oJ1xcbicpO1xuICAgICAgLy8gR3VhcmRlZCBvbiB0aGUgdmVyaWZpZWQgSldUIHJvbGUgY2xhaW0gKHN0b3JlZCBhcyBhIHByaW5jaXBhbCB0YWcpLlxuICAgICAgZXhwZWN0KHRleHQpLnRvQ29udGFpbignZ2V0VGFnKFwicm9sZVwiKSA9PSBcImFkbWluXCInKTtcbiAgICAgIGV4cGVjdCh0ZXh0KS50b0NvbnRhaW4oJ0FnZW50Q29yZTo6QWN0aW9uOjpcImNsb3Vkd2F0Y2hNY3BcIicpO1xuICAgICAgZXhwZWN0KHRleHQpLnRvQ29udGFpbignQWdlbnRDb3JlOjpBY3Rpb246OlwiY2xvdWR0cmFpbE1jcFwiJyk7XG4gICAgICBleHBlY3QodGV4dCkudG9Db250YWluKCdBZ2VudENvcmU6OkFjdGlvbjo6XCJpbnZlbnRvcnlNY3BcIicpO1xuXG4gICAgICAvLyBUaGUgYWRtaW4gcGVybWl0IG11c3Qgbm90IHNpbGVudGx5IHdpZGVuIGJpbGxpbmcvcHJpY2luZyBhY2Nlc3MuXG4gICAgICBleHBlY3QodGV4dCkubm90LnRvQ29udGFpbignQWdlbnRDb3JlOjpBY3Rpb246OlwiYmlsbGluZ01jcFwiJyk7XG4gICAgICBleHBlY3QodGV4dCkubm90LnRvQ29udGFpbignQWdlbnRDb3JlOjpBY3Rpb246OlwicHJpY2luZ01jcFwiJyk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdubyBwZXJtaXQgZXhpc3RzIGZvciBhbnkgdGFyZ2V0IGdyb3VwIG91dHNpZGUgdGhlIGRvY3VtZW50ZWQgZml2ZSAoZGVmYXVsdC1kZW55KScsICgpID0+IHtcbiAgICAgIGNvbnN0IHN0YXRlbWVudHMgPSBnZXRQb2xpY3lTdGF0ZW1lbnRzKCk7XG4gICAgICBjb25zdCBhbGxUZXh0ID0gY29sbGVjdFN0cmluZ3Moc3RhdGVtZW50cykuam9pbignXFxuJyk7XG5cbiAgICAgIC8vIENvbGxlY3QgZXZlcnkgdGFyZ2V0IGFjdGlvbiBncm91cCByZWZlcmVuY2VkIGFueXdoZXJlIGluIHRoZSBwb2xpY3kgc2V0LlxuICAgICAgY29uc3QgcmVmZXJlbmNlZCA9IG5ldyBTZXQoXG4gICAgICAgIEFycmF5LmZyb20oYWxsVGV4dC5tYXRjaEFsbCgvQWdlbnRDb3JlOjpBY3Rpb246OlwiKFteXCJdKylcIi9nKSkubWFwKChtKSA9PiBtWzFdKSxcbiAgICAgICk7XG4gICAgICBjb25zdCBhbGxvd2VkID0gbmV3IFNldChbXG4gICAgICAgICdiaWxsaW5nTWNwJyxcbiAgICAgICAgJ3ByaWNpbmdNY3AnLFxuICAgICAgICAnY2xvdWR3YXRjaE1jcCcsXG4gICAgICAgICdjbG91ZHRyYWlsTWNwJyxcbiAgICAgICAgJ2ludmVudG9yeU1jcCcsXG4gICAgICBdKTtcbiAgICAgIGZvciAoY29uc3QgdGFyZ2V0IG9mIHJlZmVyZW5jZWQpIHtcbiAgICAgICAgZXhwZWN0KGFsbG93ZWQuaGFzKHRhcmdldCkpLnRvQmUodHJ1ZSk7XG4gICAgICB9XG4gICAgICAvLyBBbGwgZml2ZSBrbm93biB0YXJnZXQgZ3JvdXBzIGFyZSBhY2NvdW50ZWQgZm9yOyBhbnl0aGluZyBlbHNlIChpbmNsLlxuICAgICAgLy8gZnV0dXJlIHRhcmdldHMpIGlzIGRlbmllZCBieSBvbWlzc2lvbiBmb3Igbm9uLWFkbWlucy5cbiAgICAgIGV4cGVjdChyZWZlcmVuY2VkKS50b0VxdWFsKGFsbG93ZWQpO1xuICAgIH0pO1xuICB9KTtcbn0pO1xuIl19