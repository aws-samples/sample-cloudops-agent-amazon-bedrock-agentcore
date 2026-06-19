#!/usr/bin/env node
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
require("source-map-support/register");
const cdk = __importStar(require("aws-cdk-lib"));
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cdk_nag_1 = require("cdk-nag");
const image_stack_1 = require("../lib/image-stack");
const auth_stack_1 = require("../lib/auth-stack");
const mcp_runtime_stack_1 = require("../lib/mcp-runtime-stack");
const gateway_stack_1 = require("../lib/gateway-stack");
const agent_runtime_stack_1 = require("../lib/agent-runtime-stack");
const conversation_history_stack_1 = require("../lib/conversation-history-stack");
const app = new cdk.App();
// Add CDK-Nag AWS Solutions checks
aws_cdk_lib_1.Aspects.of(app).add(new cdk_nag_1.AwsSolutionsChecks({ verbose: true }));
// Get configuration from context or environment.
// Region is resolved from the CDK CLI (CDK_DEFAULT_REGION, derived from the
// active AWS profile/credentials) or AWS_REGION — never hard-coded.
const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION,
};
const adminEmail = process.env.COGNITO_ADMIN_EMAIL || app.node.tryGetContext('adminEmail');
const eolTableName = process.env.EOL_TABLE_NAME || app.node.tryGetContext('eolTableName');
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
const imageStack = new image_stack_1.ImageStack(app, 'CloudOpsImageStack', {
    env,
    description: 'CloudOps Agent - Docker Image Build (ECR + CodeBuild)',
});
// Stack 2: Auth Stack - Cognito + M2M + OAuth Provider (Custom Resource)
const authStack = new auth_stack_1.AuthStack(app, 'CloudOpsAuthStack', {
    env,
    description: 'CloudOps Agent - Cognito Authentication + OAuth Provider',
    adminEmail: adminEmail,
});
// Stack 3: MCP Runtime Stack - Deploy 5 MCP Runtimes with JWT auth
const mcpRuntimeStack = new mcp_runtime_stack_1.MCPRuntimeStack(app, 'CloudOpsMCPRuntimeStack', {
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
const agentCoreGatewayStack = new gateway_stack_1.AgentCoreGatewayStack(app, 'CloudOpsAgentCoreGatewayStack', {
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
});
agentCoreGatewayStack.addDependency(mcpRuntimeStack);
agentCoreGatewayStack.addDependency(authStack);
// Stack 5: Main Runtime Stack - Main agent runtime with Gateway ARN
const agentRuntimeStack = new agent_runtime_stack_1.AgentRuntimeStack(app, 'CloudOpsAgentRuntimeStack', {
    env,
    description: 'CloudOps Agent - Main Agent Runtime with Gateway Integration',
    repository: imageStack.repository,
    userPoolArn: authStack.userPoolArn,
    gatewayArn: agentCoreGatewayStack.gatewayArn,
    userPoolId: authStack.userPoolId,
    userPoolClientId: authStack.userPoolClientId,
    identityPoolId: authStack.identityPoolId,
});
agentRuntimeStack.addDependency(imageStack);
agentRuntimeStack.addDependency(authStack);
agentRuntimeStack.addDependency(agentCoreGatewayStack);
// Stack 6: Conversation History - DynamoDB + API Gateway for conversation persistence
const conversationHistoryStack = new conversation_history_stack_1.ConversationHistoryStack(app, 'CloudOpsConversationHistoryStack', {
    env,
    description: 'CloudOps Agent - Conversation History (DynamoDB + API Gateway)',
    userPoolArn: authStack.userPoolArn,
    userPoolId: authStack.userPoolId,
});
conversationHistoryStack.addDependency(authStack);
// Add tags to all stacks
cdk.Tags.of(app).add('Project', 'CloudOpsAgent');
cdk.Tags.of(app).add('ManagedBy', 'CDK');
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBwLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUNBLHVDQUFxQztBQUNyQyxpREFBbUM7QUFDbkMsNkNBQXNDO0FBQ3RDLHFDQUE2QztBQUM3QyxvREFBZ0Q7QUFDaEQsa0RBQThDO0FBQzlDLGdFQUEyRDtBQUMzRCx3REFBNkQ7QUFDN0Qsb0VBQStEO0FBQy9ELGtGQUE2RTtBQUU3RSxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUUxQixtQ0FBbUM7QUFDbkMscUJBQU8sQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksNEJBQWtCLENBQUMsRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBRS9ELGlEQUFpRDtBQUNqRCw0RUFBNEU7QUFDNUUsb0VBQW9FO0FBQ3BFLE1BQU0sR0FBRyxHQUFHO0lBQ1YsT0FBTyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CO0lBQ3hDLE1BQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFrQixJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVTtDQUNqRSxDQUFDO0FBRUYsTUFBTSxVQUFVLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUIsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUMzRixNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGNBQWMsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxjQUFjLENBQUMsQ0FBQztBQUUxRixJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7SUFDaEIsT0FBTyxDQUFDLEtBQUssQ0FBQyxrRUFBa0UsQ0FBQyxDQUFDO0lBQ2xGLE9BQU8sQ0FBQyxLQUFL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QUFxQixDQUFDLFVBQVU7SUFDNUMsVUFBVSxFQUFFLFNBQVMsQ0FBQyxVQUFVO0lBQ2hDLGdCQUFnQixFQUFFLFNBQVMsQ0FBQyxnQkFBZ0I7SUFDNUMsY0FBYyxFQUFFLFNBQVMsQ0FBQyxjQUFjO0NBQ3pDLENBQUMsQ0FBQztBQUNILGlCQUFpQixDQUFDLGFBQWEsQ0FBQyxVQUFVLENBQUMsQ0FBQztBQUM1QyxpQkFBaUIsQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDM0MsaUJBQWlCLENBQUMsYUFBYSxDQUFDLHFCQUFxQixDQUFDLENBQUM7QUFFdkQsc0ZBQXNGO0FBQ3RGLE1BQU0sd0JBQXdCLEdBQUcsSUFBSSxxREFBd0IsQ0FBQyxHQUFHLEVBQUUsa0NBQWtDLEVBQUU7SUFDckcsR0FBRztJQUNILFdBQVcsRUFBRSxnRUFBZ0U7SUFDN0UsV0FBVyxFQUFFLFNBQVMsQ0FBQyxXQUFXO0lBQ2xDLFVBQVUsRUFBRSxTQUFTLENBQUMsVUFBVTtDQUNqQyxDQUFDLENBQUM7QUFDSCx3QkFBd0IsQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFbEQseUJBQXlCO0FBQ3pCLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxTQUFTLEVBQUUsZUFBZSxDQUFDLENBQUM7QUFDakQsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLFdBQVcsRUFBRSxLQUFLLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIiMhL3Vzci9iaW4vZW52IG5vZGVcbmltcG9ydCAnc291cmNlLW1hcC1zdXBwb3J0L3JlZ2lzdGVyJztcbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBBc3BlY3RzIH0gZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgQXdzU29sdXRpb25zQ2hlY2tzIH0gZnJvbSAnY2RrLW5hZyc7XG5pbXBvcnQgeyBJbWFnZVN0YWNrIH0gZnJvbSAnLi4vbGliL2ltYWdlLXN0YWNrJztcbmltcG9ydCB7IEF1dGhTdGFjayB9IGZyb20gJy4uL2xpYi9hdXRoLXN0YWNrJztcbmltcG9ydCB7IE1DUFJ1bnRpbWVTdGFjayB9IGZyb20gJy4uL2xpYi9tY3AtcnVudGltZS1zdGFjayc7XG5pbXBvcnQgeyBBZ2VudENvcmVHYXRld2F5U3RhY2sgfSBmcm9tICcuLi9saWIvZ2F0ZXdheS1zdGFjayc7XG5pbXBvcnQgeyBBZ2VudFJ1bnRpbWVTdGFjayB9IGZyb20gJy4uL2xpYi9hZ2VudC1ydW50aW1lLXN0YWNrJztcbmltcG9ydCB7IENvbnZlcnNhdGlvbkhpc3RvcnlTdGFjayB9IGZyb20gJy4uL2xpYi9jb252ZXJzYXRpb24taGlzdG9yeS1zdGFjayc7XG5cbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG5cbi8vIEFkZCBDREstTmFnIEFXUyBTb2x1dGlvbnMgY2hlY2tzXG5Bc3BlY3RzLm9mKGFwcCkuYWRkKG5ldyBBd3NTb2x1dGlvbnNDaGVja3MoeyB2ZXJib3NlOiB0cnVlIH0pKTtcblxuLy8gR2V0IGNvbmZpZ3VyYXRpb24gZnJvbSBjb250ZXh0IG9yIGVudmlyb25tZW50LlxuLy8gUmVnaW9uIGlzIHJlc29sdmVkIGZyb20gdGhlIENESyBDTEkgKENES19ERUZBVUxUX1JFR0lPTiwgZGVyaXZlZCBmcm9tIHRoZVxuLy8gYWN0aXZlIEFXUyBwcm9maWxlL2NyZWRlbnRpYWxzKSBvciBBV1NfUkVHSU9OIOKAlCBuZXZlciBoYXJkLWNvZGVkLlxuY29uc3QgZW52ID0ge1xuICBhY2NvdW50OiBwcm9jZXNzLmVudi5DREtfREVGQVVMVF9BQ0NPVU5ULFxuICByZWdpb246IHByb2Nlc3MuZW52LkNES19ERUZBVUxUX1JFR0lPTiB8fCBwcm9jZXNzLmVudi5BV1NfUkVHSU9OLFxufTtcblxuY29uc3QgYWRtaW5FbWFpbCA9IHByb2Nlc3MuZW52LkNPR05JVE9fQURNSU5fRU1BSUwgfHwgYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnYWRtaW5FbWFpbCcpO1xuY29uc3QgZW9sVGFibGVOYW1lID0gcHJvY2Vzcy5lbnYuRU9MX1RBQkxFX05BTUUgfHwgYXBwLm5vZGUudHJ5R2V0Q29udGV4dCgnZW9sVGFibGVOYW1lJyk7XG5cbmlmICghYWRtaW5FbWFpbCkge1xuICBjb25zb2xlLmVycm9yKCdcXG7inYwgRVJST1I6IENPR05JVE9fQURNSU5fRU1BSUwgZW52aXJvbm1lbnQgdmFyaWFibGUgaXMgcmVxdWlyZWQuJyk7XG4gIGNvbnNvbGUuZXJyb3IoJ1BsZWFzZSBzZXQgaXQgYmVmb3JlIGRlcGxveWluZzonKTtcbiAgY29uc29sZS5lcnJvcignICBleHBvcnQgQ09HTklUT19BRE1JTl9FTUFJTD1cInlvdXItZW1haWxAZXhhbXBsZS5jb21cIicpO1xuICBjb25zb2xlLmVycm9yKCcgIGNkayBkZXBsb3lcXG4nKTtcbiAgdGhyb3cgbmV3IEVycm9yKCdDT0dOSVRPX0FETUlOX0VNQUlMIGVudmlyb25tZW50IHZhcmlhYmxlIGlzIHJlcXVpcmVkLiBTZXQgaXQgYmVmb3JlIGRlcGxveWluZy4nKTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gVmFsaWRhdGVkIERlcGxveW1lbnQgU2VxdWVuY2Vcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLy8gU3RhY2sgMTogSW1hZ2UgU3RhY2sgLSBCdWlsZHMgRG9ja2VyIGltYWdlcyBmb3IgQWdlbnQgUnVudGltZXNcbmNvbnN0IGltYWdlU3RhY2sgPSBuZXcgSW1hZ2VTdGFjayhhcHAsICdDbG91ZE9wc0ltYWdlU3RhY2snLCB7XG4gIGVudixcbiAgZGVzY3JpcHRpb246ICdDbG91ZE9wcyBBZ2VudCAtIERvY2tlciBJbWFnZSBCdWlsZCAoRUNSICsgQ29kZUJ1aWxkKScsXG59KTtcblxuLy8gU3RhY2sgMjogQXV0aCBTdGFjayAtIENvZ25pdG8gKyBNMk0gKyBPQXV0aCBQcm92aWRlciAoQ3VzdG9tIFJlc291cmNlKVxuY29uc3QgYXV0aFN0YWNrID0gbmV3IEF1dGhTdGFjayhhcHAsICdDbG91ZE9wc0F1dGhTdGFjaycsIHtcbiAgZW52LFxuICBkZXNjcmlwdGlvbjogJ0Nsb3VkT3BzIEFnZW50IC0gQ29nbml0byBBdXRoZW50aWNhdGlvbiArIE9BdXRoIFByb3ZpZGVyJyxcbiAgYWRtaW5FbWFpbDogYWRtaW5FbWFpbCxcbn0pO1xuXG4vLyBTdGFjayAzOiBNQ1AgUnVudGltZSBTdGFjayAtIERlcGxveSA1IE1DUCBSdW50aW1lcyB3aXRoIEpXVCBhdXRoXG5jb25zdCBtY3BSdW50aW1lU3RhY2sgPSBuZXcgTUNQUnVudGltZVN0YWNrKGFwcCwgJ0Nsb3VkT3BzTUNQUnVudGltZVN0YWNrJywge1xuICBlbnYsXG4gIGRlc2NyaXB0aW9uOiAnQ2xvdWRPcHMgQWdlbnQgLSBNQ1AgU2VydmVyIFJ1bnRpbWVzIChCaWxsaW5nICsgUHJpY2luZyArIENsb3VkV2F0Y2ggKyBDbG91ZFRyYWlsICsgSW52ZW50b3J5KSB3aXRoIEpXVCBBdXRob3JpemF0aW9uJyxcbiAgYmlsbGluZ01jcFJlcG9zaXRvcnk6IGltYWdlU3RhY2suYmlsbGluZ01jcFJlcG9zaXRvcnksXG4gIHByaWNpbmdNY3BSZXBvc2l0b3J5OiBpbWFnZVN0YWNrLnByaWNpbmdNY3BSZXBvc2l0b3J5LFxuICBjbG91ZHdhdGNoTWNwUmVwb3NpdG9yeTogaW1hZ2VTdGFjay5jbG91ZHdhdGNoTWNwUmVwb3NpdG9yeSxcbiAgY2xvdWR0cmFpbE1jcFJlcG9zaXRvcnk6IGltYWdlU3RhY2suY2xvdWR0cmFpbE1jcFJlcG9zaXRvcnksXG4gIGludmVudG9yeU1jcFJlcG9zaXRvcnk6IGltYWdlU3RhY2suaW52ZW50b3J5TWNwUmVwb3NpdG9yeSxcbiAgdXNlclBvb2xJZDogYXV0aFN0YWNrLnVzZXJQb29sSWQsXG4gIG0ybUNsaWVudElkOiBhdXRoU3RhY2sub2F1dGhDbGllbnRJZCxcbiAgLi4uKGVvbFRhYmxlTmFtZSAmJiB7IGVvbFRhYmxlTmFtZSB9KSxcbn0pO1xubWNwUnVudGltZVN0YWNrLmFkZERlcGVuZGVuY3koaW1hZ2VTdGFjayk7XG5tY3BSdW50aW1lU3RhY2suYWRkRGVwZW5kZW5jeShhdXRoU3RhY2spO1xuXG4vLyBTdGFjayA0OiBBZ2VudENvcmUgR2F0ZXdheSBTdGFjayAtIEdhdGV3YXkgKyBpdHMgb3duIENvZ25pdG8gKyBPQXV0aCBwcm92aWRlciArIE1DUCB0YXJnZXRzXG5jb25zdCBhZ2VudENvcmVHYXRld2F5U3RhY2sgPSBuZXcgQWdlbnRDb3JlR2F0ZXdheVN0YWNrKGFwcCwgJ0Nsb3VkT3BzQWdlbnRDb3JlR2F0ZXdheVN0YWNrJywge1xuICBlbnYsXG4gIGRlc2NyaXB0aW9uOiAnQ2xvdWRPcHMgQWdlbnQgLSBHYXRld2F5IHdpdGggTUNQIFNlcnZlciBUYXJnZXRzJyxcbiAgYmlsbGluZ01jcFJ1bnRpbWVBcm46IG1jcFJ1bnRpbWVTdGFjay5iaWxsaW5nTWNwUnVudGltZUFybixcbiAgcHJpY2luZ01jcFJ1bnRpbWVBcm46IG1jcFJ1bnRpbWVTdGFjay5wcmljaW5nTWNwUnVudGltZUFybixcbiAgYmlsbGluZ01jcFJ1bnRpbWVFbmRwb2ludDogbWNwUnVudGltZVN0YWNrLmJpbGxpbmdNY3BSdW50aW1lRW5kcG9pbnQsXG4gIHByaWNpbmdNY3BSdW50aW1lRW5kcG9pbnQ6IG1jcFJ1bnRpbWVTdGFjay5wcmljaW5nTWNwUnVudGltZUVuZHBvaW50LFxuICBjbG91ZHdhdGNoTWNwUnVudGltZUFybjogbWNwUnVudGltZVN0YWNrLmNsb3Vkd2F0Y2hNY3BSdW50aW1lQXJuLFxuICBjbG91ZHdhdGNoTWNwUnVudGltZUVuZHBvaW50OiBtY3BSdW50aW1lU3RhY2suY2xvdWR3YXRjaE1jcFJ1bnRpbWVFbmRwb2ludCxcbiAgY2xvdWR0cmFpbE1jcFJ1bnRpbWVBcm46IG1jcFJ1bnRpbWVTdGFjay5jbG91ZHRyYWlsTWNwUnVudGltZUFybixcbiAgY2xvdWR0cmFpbE1jcFJ1bnRpbWVFbmRwb2ludDogbWNwUnVudGltZVN0YWNrLmNsb3VkdHJhaWxNY3BSdW50aW1lRW5kcG9pbnQsXG4gIGludmVudG9yeU1jcFJ1bnRpbWVBcm46IG1jcFJ1bnRpbWVTdGFjay5pbnZlbnRvcnlNY3BSdW50aW1lQXJuLFxuICBpbnZlbnRvcnlNY3BSdW50aW1lRW5kcG9pbnQ6IG1jcFJ1bnRpbWVTdGFjay5pbnZlbnRvcnlNY3BSdW50aW1lRW5kcG9pbnQsXG4gIC8vIEF1dGhTdGFjayBDb2duaXRvIGZvciBvdXRib3VuZCBPQXV0aCB0byBydW50aW1lc1xuICBhdXRoVXNlclBvb2xJZDogYXV0aFN0YWNrLnVzZXJQb29sSWQsXG4gIGF1dGhVc2VyUG9vbEFybjogYXV0aFN0YWNrLnVzZXJQb29sQXJuLFxuICBhdXRoTTJtQ2xpZW50SWQ6IGF1dGhTdGFjay5vYXV0aENsaWVudElkLFxufSk7XG5hZ2VudENvcmVHYXRld2F5U3RhY2suYWRkRGVwZW5kZW5jeShtY3BSdW50aW1lU3RhY2spO1xuYWdlbnRDb3JlR2F0ZXdheVN0YWNrLmFkZERlcGVuZGVuY3koYXV0aFN0YWNrKTtcblxuLy8gU3RhY2sgNTogTWFpbiBSdW50aW1lIFN0YWNrIC0gTWFpbiBhZ2VudCBydW50aW1lIHdpdGggR2F0ZXdheSBBUk5cbmNvbnN0IGFnZW50UnVudGltZVN0YWNrID0gbmV3IEFnZW50UnVudGltZVN0YWNrKGFwcCwgJ0Nsb3VkT3BzQWdlbnRSdW50aW1lU3RhY2snLCB7XG4gIGVudixcbiAgZGVzY3JpcHRpb246ICdDbG91ZE9wcyBBZ2VudCAtIE1haW4gQWdlbnQgUnVudGltZSB3aXRoIEdhdGV3YXkgSW50ZWdyYXRpb24nLFxuICByZXBvc2l0b3J5OiBpbWFnZVN0YWNrLnJlcG9zaXRvcnksXG4gIHVzZXJQb29sQXJuOiBhdXRoU3RhY2sudXNlclBvb2xBcm4sXG4gIGdhdGV3YXlBcm46IGFnZW50Q29yZUdhdGV3YXlTdGFjay5nYXRld2F5QXJuLFxuICB1c2VyUG9vbElkOiBhdXRoU3RhY2sudXNlclBvb2xJZCxcbiAgdXNlclBvb2xDbGllbnRJZDogYXV0aFN0YWNrLnVzZXJQb29sQ2xpZW50SWQsXG4gIGlkZW50aXR5UG9vbElkOiBhdXRoU3RhY2suaWRlbnRpdHlQb29sSWQsXG59KTtcbmFnZW50UnVudGltZVN0YWNrLmFkZERlcGVuZGVuY3koaW1hZ2VTdGFjayk7XG5hZ2VudFJ1bnRpbWVTdGFjay5hZGREZXBlbmRlbmN5KGF1dGhTdGFjayk7XG5hZ2VudFJ1bnRpbWVTdGFjay5hZGREZXBlbmRlbmN5KGFnZW50Q29yZUdhdGV3YXlTdGFjayk7XG5cbi8vIFN0YWNrIDY6IENvbnZlcnNhdGlvbiBIaXN0b3J5IC0gRHluYW1vREIgKyBBUEkgR2F0ZXdheSBmb3IgY29udmVyc2F0aW9uIHBlcnNpc3RlbmNlXG5jb25zdCBjb252ZXJzYXRpb25IaXN0b3J5U3RhY2sgPSBuZXcgQ29udmVyc2F0aW9uSGlzdG9yeVN0YWNrKGFwcCwgJ0Nsb3VkT3BzQ29udmVyc2F0aW9uSGlzdG9yeVN0YWNrJywge1xuICBlbnYsXG4gIGRlc2NyaXB0aW9uOiAnQ2xvdWRPcHMgQWdlbnQgLSBDb252ZXJzYXRpb24gSGlzdG9yeSAoRHluYW1vREIgKyBBUEkgR2F0ZXdheSknLFxuICB1c2VyUG9vbEFybjogYXV0aFN0YWNrLnVzZXJQb29sQXJuLFxuICB1c2VyUG9vbElkOiBhdXRoU3RhY2sudXNlclBvb2xJZCxcbn0pO1xuY29udmVyc2F0aW9uSGlzdG9yeVN0YWNrLmFkZERlcGVuZGVuY3koYXV0aFN0YWNrKTtcblxuLy8gQWRkIHRhZ3MgdG8gYWxsIHN0YWNrc1xuY2RrLlRhZ3Mub2YoYXBwKS5hZGQoJ1Byb2plY3QnLCAnQ2xvdWRPcHNBZ2VudCcpO1xuY2RrLlRhZ3Mub2YoYXBwKS5hZGQoJ01hbmFnZWRCeScsICdDREsnKTtcbiJdfQ==