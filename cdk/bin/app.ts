#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ImageStack } from '../lib/image-stack';
import { AuthStack } from '../lib/auth-stack';
import { MCPRuntimeStack } from '../lib/mcp-runtime-stack';
import { AgentCoreGatewayStack } from '../lib/gateway-stack';
import { AgentRuntimeStack } from '../lib/agent-runtime-stack';
import { ConversationHistoryStack } from '../lib/conversation-history-stack';

const app = new cdk.App();

// Add CDK-Nag AWS Solutions checks
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Get configuration from context or environment.
// Region is resolved from the CDK CLI (CDK_DEFAULT_REGION, derived from the
// active AWS profile/credentials) or AWS_REGION — never hard-coded.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION,
};

const adminEmail = process.env.COGNITO_ADMIN_EMAIL || app.node.tryGetContext('adminEmail');
const eolTableName = process.env.EOL_TABLE_NAME || app.node.tryGetContext('eolTableName');

// Bedrock model the agent runs on. Configurable at deploy time without editing
// the stack: set BEDROCK_MODEL_ID or pass `-c modelId=...`. Defaults to the
// Claude Sonnet 4.5 cross-region inference profile. The value flows to the
// runtime container (MODEL_ID env var) and scopes the runtime's Bedrock IAM
// permissions in AgentRuntimeStack.
const foundationModelId =
  process.env.BEDROCK_MODEL_ID ||
  app.node.tryGetContext('modelId') ||
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

if (!adminEmail) {
  console.error('\n❌ ERROR: COGNITO_ADMIN_EMAIL environment variable is required.');
  console.error('Please set it before deploying:');
  console.error('  export COGNITO_ADMIN_EMAIL="your-email@example.com"');
  console.error('  cdk deploy\n');
  throw new Error('COGNITO_ADMIN_EMAIL environment variable is required. Set it before deploying.');
}

// ========================================
// Validated Deployment Sequence
// ========================================

// Stack 1: Image Stack - Builds Docker images for Agent Runtimes
const imageStack = new ImageStack(app, 'CloudOpsImageStack', {
  env,
  description: 'CloudOps Agent - Docker Image Build (ECR + CodeBuild)',
});

// Stack 2: Auth Stack - Cognito + M2M + OAuth Provider (Custom Resource)
const authStack = new AuthStack(app, 'CloudOpsAuthStack', {
  env,
  description: 'CloudOps Agent - Cognito Authentication + OAuth Provider',
  adminEmail: adminEmail,
});

// Stack 3: MCP Runtime Stack - Deploy 5 MCP Runtimes with JWT auth
const mcpRuntimeStack = new MCPRuntimeStack(app, 'CloudOpsMCPRuntimeStack', {
  env,
  description: 'CloudOps Agent - MCP Server Runtimes (Billing + Pricing + CloudWatch + CloudTrail + Inventory) with JWT Authorization',
  billingMcpRepository: imageStack.billingMcpRepository,
  pricingMcpRepository: imageStack.pricingMcpRepository,
  cloudwatchMcpRepository: imageStack.cloudwatchMcpRepository,
  cloudtrailMcpRepository: imageStack.cloudtrailMcpRepository,
  inventoryMcpRepository: imageStack.inventoryMcpRepository,
  userPoolId: authStack.userPoolId,
  m2mClientId: authStack.oauthClientId,
  ...(eolTableName && { eolTableName }),
});
mcpRuntimeStack.addDependency(imageStack);
mcpRuntimeStack.addDependency(authStack);

// Stack 4: AgentCore Gateway Stack - Gateway + its own Cognito + OAuth provider + MCP targets
const agentCoreGatewayStack = new AgentCoreGatewayStack(app, 'CloudOpsAgentCoreGatewayStack', {
  env,
  description: 'CloudOps Agent - Gateway with MCP Server Targets',
  billingMcpRuntimeArn: mcpRuntimeStack.billingMcpRuntimeArn,
  pricingMcpRuntimeArn: mcpRuntimeStack.pricingMcpRuntimeArn,
  billingMcpRuntimeEndpoint: mcpRuntimeStack.billingMcpRuntimeEndpoint,
  pricingMcpRuntimeEndpoint: mcpRuntimeStack.pricingMcpRuntimeEndpoint,
  cloudwatchMcpRuntimeArn: mcpRuntimeStack.cloudwatchMcpRuntimeArn,
  cloudwatchMcpRuntimeEndpoint: mcpRuntimeStack.cloudwatchMcpRuntimeEndpoint,
  cloudtrailMcpRuntimeArn: mcpRuntimeStack.cloudtrailMcpRuntimeArn,
  cloudtrailMcpRuntimeEndpoint: mcpRuntimeStack.cloudtrailMcpRuntimeEndpoint,
  inventoryMcpRuntimeArn: mcpRuntimeStack.inventoryMcpRuntimeArn,
  inventoryMcpRuntimeEndpoint: mcpRuntimeStack.inventoryMcpRuntimeEndpoint,
  // AuthStack Cognito for outbound OAuth to runtimes
  authUserPoolId: authStack.userPoolId,
  authUserPoolArn: authStack.userPoolArn,
  authM2mClientId: authStack.oauthClientId,
  // FrontEnd User Pool client ID - allowed audience for inbound CUSTOM_JWT auth
  authUserPoolClientId: authStack.userPoolClientId,
});
agentCoreGatewayStack.addDependency(mcpRuntimeStack);
agentCoreGatewayStack.addDependency(authStack);

// Stack 5: Main Runtime Stack - Main agent runtime with Gateway ARN
const agentRuntimeStack = new AgentRuntimeStack(app, 'CloudOpsAgentRuntimeStack', {
  env,
  description: 'CloudOps Agent - Main Agent Runtime with Gateway Integration',
  repository: imageStack.repository,
  userPoolArn: authStack.userPoolArn,
  gatewayArn: agentCoreGatewayStack.gatewayArn,
  foundationModelId: foundationModelId,
  userPoolId: authStack.userPoolId,
  userPoolClientId: authStack.userPoolClientId,
  identityPoolId: authStack.identityPoolId,
});
agentRuntimeStack.addDependency(imageStack);
agentRuntimeStack.addDependency(authStack);
agentRuntimeStack.addDependency(agentCoreGatewayStack);

// Stack 6: Conversation History - DynamoDB + API Gateway for conversation persistence
const conversationHistoryStack = new ConversationHistoryStack(app, 'CloudOpsConversationHistoryStack', {
  env,
  description: 'CloudOps Agent - Conversation History (DynamoDB + API Gateway)',
  userPoolArn: authStack.userPoolArn,
  userPoolId: authStack.userPoolId,
  // Passed through so this last-deployed stack can emit a single consolidated
  // FrontEnd config output (cognito + agentcore + conversationApi).
  userPoolClientId: authStack.userPoolClientId,
  identityPoolId: authStack.identityPoolId,
  agentRuntimeArn: agentRuntimeStack.mainRuntimeArn,
});
conversationHistoryStack.addDependency(authStack);
// Depends on the AgentRuntime stack so the consolidated FrontEnd config output
// can include the AgentCore Runtime ARN (deploys after it as a result).
conversationHistoryStack.addDependency(agentRuntimeStack);

// Add tags to all stacks
cdk.Tags.of(app).add('Project', 'CloudOpsAgent');
cdk.Tags.of(app).add('ManagedBy', 'CDK');
