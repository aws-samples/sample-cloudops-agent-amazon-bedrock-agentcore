import * as cdk from 'aws-cdk-lib';
import { execFileSync } from 'child_process';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentCoreGatewayStack } from '../lib/gateway-stack';

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
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new AgentCoreGatewayStack(app, 'TestGatewayStack', {
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
    template = Template.fromStack(stack);
  });

  /**
   * Recursively collect every string literal from a value. CloudFormation
   * intrinsics (Fn::Join / Fn::GetAtt) are plain objects/arrays, so this
   * flattens an Fn::Join'd Cedar statement back into its literal fragments.
   */
  function collectStrings(node: unknown): string[] {
    if (typeof node === 'string') {
      return [node];
    }
    if (Array.isArray(node)) {
      return node.flatMap(collectStrings);
    }
    if (node && typeof node === 'object') {
      return Object.values(node as Record<string, unknown>).flatMap(collectStrings);
    }
    return [];
  }

  test('OAuth handler completes requests without logging secrets', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const provider = Object.entries(functions).find(([id]) => id.startsWith('OAuthProviderFunction'));
    expect(provider).toBeDefined();
    const code = provider![1].Properties.Code.ZipFile;
    execFileSync('uv', ['run', '--with', 'boto3', 'python', '-c', `
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
      AuthorizerConfiguration: Match.objectLike({
        CustomJWTAuthorizer: Match.objectLike({
          DiscoveryUrl: Match.stringLikeRegexp('.*\\.well-known/openid-configuration$'),
          // Cognito access tokens match on client_id (AllowedClients), not aud.
          AllowedClients: Match.arrayWith([FRONTEND_CLIENT_ID]),
        }),
      }),
    });
  });

  test('Gateway associates the Cedar Policy Engine in ENFORCE mode', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      PolicyEngineConfiguration: Match.objectLike({
        Mode: 'ENFORCE',
      }),
    });
  });

  test('Gateway registers a REQUEST interceptor (deny-audit)', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      InterceptorConfigurations: Match.arrayWith([
        Match.objectLike({
          InterceptionPoints: Match.arrayWith(['REQUEST']),
        }),
      ]),
    });
  });

  describe('Cedar policy set (Req 6.2, 6.3 — default-deny by omission)', () => {
    // Locate the custom resource that carries the Cedar policy statements.
    function getPolicyStatements(): Array<{ Name: string; Statement: unknown }> {
      const customResources = template.findResources('AWS::CloudFormation::CustomResource');
      const policyResources = Object.values(customResources).filter(
        (r: any) => r.Properties && r.Properties.Operation === 'POLICIES',
      );
      expect(policyResources).toHaveLength(1);
      const statements = (policyResources[0] as any).Properties.Statements;
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

      const text = collectStrings(allUsers!.Statement).join('\n');
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

      const text = collectStrings(adminOnly!.Statement).join('\n');
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
      const referenced = new Set(
        Array.from(allText.matchAll(/AgentCore::Action::"([^"]+)"/g)).map((m) => m[1]),
      );
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
