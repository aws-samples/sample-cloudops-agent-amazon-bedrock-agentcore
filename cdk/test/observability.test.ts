import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentRuntimeStack } from '../lib/agent-runtime-stack';
import { AgentCoreGatewayStack } from '../lib/gateway-stack';

const env = { account: '123456789012', region: 'us-east-1' };

test('main runtime exports metadata-only traces and enables native runtime/identity tracing', () => {
  const app = new cdk.App();
  const images = new cdk.Stack(app, 'Images', { env });
  const stack = new AgentRuntimeStack(app, 'TestRuntime', {
    env, repository: new ecr.Repository(images, 'Agent'),
    userPoolArn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/test',
    gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/test',
    foundationModelId: 'test-model', userPoolId: 'test',
    userPoolClientId: 'test', identityPoolId: 'test',
  });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    EnvironmentVariables: Match.objectLike({
      DISABLE_ADOT_OBSERVABILITY: 'true',
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
      UNIFIED_TRACES_DESTINATION_ENABLED: 'false',
    }),
  });
  template.resourceCountIs('AWS::Logs::DeliverySource', 3);
  for (const resource of Object.values(template.findResources('AWS::Logs::DeliverySource'))) {
    expect(resource.Properties.LogType).toBe('TRACES');
  }
  template.resourceCountIs('AWS::Logs::Delivery', 3);
  template.hasResourceProperties('AWS::Logs::DeliveryDestination', { DeliveryDestinationType: 'XRAY' });
});

test('Gateway, Identity and all MCP runtimes get native spans, never payload-bearing application logs', () => {
  const app = new cdk.App();
  const stack = new AgentCoreGatewayStack(app, 'TestGatewayTracing', {
    env,
    ...Object.fromEntries(['billing', 'pricing', 'cloudwatch', 'cloudtrail', 'inventory'].flatMap(name => [
      [`${name}McpRuntimeArn`, `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${name}`],
      [`${name}McpRuntimeEndpoint`, `https://${name}.example.com/mcp`],
    ])) as any,
    authUserPoolId: 'test', authUserPoolArn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/test',
    authM2mClientId: 'm2m', authUserPoolClientId: 'frontend',
  });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::Logs::DeliverySource', 13);
  template.resourceCountIs('AWS::Logs::Delivery', 13);
  const deliveries = Object.entries(template.findResources('AWS::Logs::Delivery'));
  for (let i = 1; i < deliveries.length; i++) {
    expect(deliveries[i][1].DependsOn).toContain(deliveries[i - 1][0]);
  }
  for (const resource of Object.values(template.findResources('AWS::Logs::DeliverySource'))) {
    expect(resource.Properties.LogType).toBe('TRACES');
  }
  template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
    PolicyEngineConfiguration: Match.objectLike({ Mode: 'ENFORCE' }),
  });
});
