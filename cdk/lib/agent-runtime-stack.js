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
exports.AgentRuntimeStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const agentcore = __importStar(require("@aws-cdk/aws-bedrock-agentcore-alpha"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const cdk_nag_1 = require("cdk-nag");
class AgentRuntimeStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Model id is supplied by the app (env var / context) — no longer hardcoded.
        const foundationModel = props.foundationModelId;
        // A cross-region inference profile id (e.g. "us.anthropic.claude-...") wraps
        // an underlying foundation model ("anthropic.claude-..."). Both ARNs are
        // needed in the IAM policy: the inference-profile ARN and the underlying
        // foundation-model ARN. Strip a known geo prefix to derive the base model.
        const inferenceProfilePrefixes = ['us', 'eu', 'apac', 'us-gov'];
        const firstSegment = foundationModel.split('.')[0];
        const baseFoundationModel = inferenceProfilePrefixes.includes(firstSegment)
            ? foundationModel.substring(firstSegment.length + 1)
            : foundationModel;
        // ========================================
        // IAM Roles
        // ========================================
        // Main Runtime Role
        const runtimeRole = new iam.Role(this, 'RuntimeRole', {
            assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        });
        // ECR token access
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ECRTokenAccess',
            effect: iam.Effect.ALLOW,
            actions: ['ecr:GetAuthorizationToken'],
            resources: ['*'],
        }));
        // CloudWatch Logs
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['logs:DescribeLogGroups'],
            resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
        }));
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['logs:DescribeLogStreams', 'logs:CreateLogGroup'],
            resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`],
        }));
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`],
        }));
        // Add Bedrock model permissions to Main Runtime
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
                'bedrock:ConverseStream',
                'bedrock:Converse',
            ],
            resources: Array.from(new Set([
                `arn:aws:bedrock:*::foundation-model/${foundationModel}`,
                `arn:aws:bedrock:*::foundation-model/${baseFoundationModel}`,
                `arn:aws:bedrock:*:${this.account}:inference-profile/${foundationModel}`,
                // Cross-region inference profiles fan out to per-region foundation
                // models, so allow the underlying model in any region too.
                `arn:aws:bedrock:*:${this.account}:inference-profile/${baseFoundationModel}`,
            ])),
        }));
        // Add Gateway invocation permissions to Main Runtime
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock-agentcore:InvokeGateway',
                'bedrock-agentcore:GetGateway',
                'bedrock-agentcore:ListGatewayTargets',
            ],
            resources: [
                props.gatewayArn,
                `${props.gatewayArn}/*`, // For gateway targets
            ],
        }));
        // ========================================
        // Memory
        // ========================================
        const memory = new agentcore.Memory(this, 'CloudOpsMemory', {
            memoryName: 'cloudops_memory',
            description: 'Memory for CloudOps agent conversations',
            expirationDuration: cdk.Duration.days(30),
        });
        this.memoryId = memory.memoryId;
        // Add Memory permissions to Main Runtime, scoped to the specific Memory
        // resource created by this stack (and its sub-resources, e.g. events)
        // rather than all memories in the account. Declared after the Memory
        // construct so memory.memoryId is available for the ARN.
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock-agentcore:CreateEvent',
                'bedrock-agentcore:GetLastKTurns',
                'bedrock-agentcore:GetMemory',
                'bedrock-agentcore:ListEvents',
            ],
            resources: [
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/${memory.memoryId}`,
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/${memory.memoryId}/*`,
            ],
        }));
        // ========================================
        // Main Agent Runtime
        // ========================================
        const runtime = new agentcore.Runtime(this, 'CloudOpsRuntime', {
            runtimeName: 'cloudops_runtime',
            description: 'CloudOps Agent Runtime with Gateway integration',
            executionRole: runtimeRole,
            agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(props.repository, 'latest'),
            networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
            environmentVariables: {
                MEMORY_ID: memory.memoryId,
                MODEL_ID: foundationModel,
                AWS_REGION: this.region,
                GATEWAY_ARN: props.gatewayArn,
                DEPLOYMENT_TIMESTAMP: new Date().toISOString(),
                FORCE_REBUILD: `${Date.now()}`,
            },
        });
        // Grant ECR pull permissions (fromEcrRepository doesn't auto-grant)
        props.repository.grantPull(runtimeRole);
        this.mainRuntimeArn = runtime.agentRuntimeArn;
        this.mainRuntimeRole = runtimeRole;
        this.mainRuntimeRoleArn = runtimeRole.roleArn;
        // ========================================
        // Outputs
        // ========================================
        new cdk.CfnOutput(this, 'AgentCoreArn', {
            value: this.mainRuntimeArn,
            description: 'AgentCore Runtime ARN',
            exportName: `${this.stackName}-AgentCoreArn`,
        });
        new cdk.CfnOutput(this, 'MemoryId', {
            value: this.memoryId,
            description: 'Memory ID',
            exportName: `${this.stackName}-MemoryId`,
        });
        new cdk.CfnOutput(this, 'UserPoolId', {
            value: props.userPoolId,
            description: 'Cognito User Pool ID',
        });
        new cdk.CfnOutput(this, 'UserPoolClientId', {
            value: props.userPoolClientId,
            description: 'Cognito User Pool Client ID',
        });
        new cdk.CfnOutput(this, 'IdentityPoolId', {
            value: props.identityPoolId,
            description: 'Cognito Identity Pool ID',
        });
        // ========================================
        // CDK-Nag Suppressions
        // ========================================
        cdk_nag_1.NagSuppressions.addResourceSuppressions(runtimeRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions required for ECR auth token, CloudWatch Logs, Bedrock model invocation, and AgentCore memory access',
            },
        ], true);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            {
                id: 'AwsSolutions-L1',
                reason: 'Python 3.14 is the latest Lambda runtime version available',
            },
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWSLambdaBasicExecutionRole managed policy is AWS best practice for Lambda functions',
            },
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions required for custom resource Lambda functions',
            },
        ]);
    }
}
exports.AgentRuntimeStack = AgentRuntimeStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYWdlbnQtcnVudGltZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFnZW50LXJ1bnRpbWUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLGdGQUFrRTtBQUNsRSx5REFBMkM7QUFHM0MscUNBQTBDO0FBZ0IxQyxNQUFhLGlCQUFrQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBTTlDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNkI7UUFDckUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsNkVBQTZFO1FBQzdFLE1BQU0sZUFBZSxHQUFHLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQztRQUVoRCw2RUFBNkU7UUFDN0UseUVBQXlFO1FBQ3pFLHlFQUF5RTtRQUN6RSwyRUFBMkU7UUFDM0UsTUFBTSx3QkFBd0IsR0FBRyxDQUFDLElBQUksRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLFFBQVEsQ0FBQyxDQUFDO1FBQ2hFLE1BQU0sWUFBWSxHQUFHLGVBQWUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbkQsTUFBTSxtQkFBbUIsR0FBRyx3QkFBd0IsQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDO1lBQ3pFLENBQUMsQ0FBQyxlQUFlLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO1lBQ3BELENBQUMsQ0FBQyxlQUFlLENBQUM7UUFFcEIsMkNBQTJDO1FBQzNDLFlBQVk7UUFDWiwyQ0FBMkM7UUFFM0Msb0JBQW9CO1FBQ3BCLE1BQU0sV0FBVyxHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ3BELFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxpQ0FBaUMs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WUFDMUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxnQkFBZ0I7WUFDN0IsV0FBVyxFQUFFLDZCQUE2QjtTQUMzQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3hDLEtBQUssRUFBRSxLQUFLLENBQUMsY0FBYztZQUMzQixXQUFXLEVBQUUsMEJBQTBCO1NBQ3hDLENBQUMsQ0FBQztRQUVILDJDQUEyQztRQUMzQyx1QkFBdUI7UUFDdkIsMkNBQTJDO1FBRTNDLHlCQUFlLENBQUMsdUJBQXVCLENBQUMsV0FBVyxFQUFFO1lBQ25EO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSwwSEFBMEg7YUFDbkk7U0FDRixFQUFFLElBQUksQ0FBQyxDQUFDO1FBRVQseUJBQWUsQ0FBQyxvQkFBb0IsQ0FBQyxJQUFJLEVBQUU7WUFDekM7Z0JBQ0UsRUFBRSxFQUFFLGlCQUFpQjtnQkFDckIsTUFBTSxFQUFFLDREQUE0RDthQUNyRTtZQUNEO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxzRkFBc0Y7YUFDL0Y7WUFDRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsb0VBQW9FO2FBQzdFO1NBQ0YsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBOU1ELDhDQThNQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBhZ2VudGNvcmUgZnJvbSAnQGF3cy1jZGsvYXdzLWJlZHJvY2stYWdlbnRjb3JlLWFscGhhJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGVjciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0IHsgTmFnU3VwcHJlc3Npb25zIH0gZnJvbSAnY2RrLW5hZyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQWdlbnRSdW50aW1lU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgcmVwb3NpdG9yeTogZWNyLklSZXBvc2l0b3J5O1xuICB1c2VyUG9vbEFybjogc3RyaW5nO1xuICBnYXRld2F5QXJuOiBzdHJpbmc7IC8vIEdhdGV3YXkgQVJOIGZyb20gQWdlbnRDb3JlR2F0ZXdheVN0YWNrXG4gIC8vIEJlZHJvY2sgbW9kZWwgaWQgdGhlIGFnZW50IHJ1bnMgb24gKEJlZHJvY2sgbW9kZWwgaWQgb3IgY3Jvc3MtcmVnaW9uXG4gIC8vIGluZmVyZW5jZSBwcm9maWxlIGlkKS4gQ29uZmlndXJhYmxlIGF0IGRlcGxveSB0aW1lIHZpYSBCRURST0NLX01PREVMX0lEIC9cbiAgLy8gYC1jIG1vZGVsSWQ9Li4uYDsgc2VlIGJpbi9hcHAudHMuXG4gIGZvdW5kYXRpb25Nb2RlbElkOiBzdHJpbmc7XG4gIC8vIEZvciBmcm9udGVuZCBjb25maWd1cmF0aW9uIG91dHB1dHNcbiAgdXNlclBvb2xJZDogc3RyaW5nO1xuICB1c2VyUG9vbENsaWVudElkOiBzdHJpbmc7XG4gIGlkZW50aXR5UG9vbElkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBBZ2VudFJ1bnRpbWVTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBtYWluUnVudGltZUFybjogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgbWVtb3J5SWQ6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IG1haW5SdW50aW1lUm9sZTogaWFtLklSb2xlO1xuICBwdWJsaWMgcmVhZG9ubHkgbWFpblJ1bnRpbWVSb2xlQXJuOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFnZW50UnVudGltZVN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIE1vZGVsIGlkIGlzIHN1cHBsaWVkIGJ5IHRoZSBhcHAgKGVudiB2YXIgLyBjb250ZXh0KSDigJQgbm8gbG9uZ2VyIGhhcmRjb2RlZC5cbiAgICBjb25zdCBmb3VuZGF0aW9uTW9kZWwgPSBwcm9wcy5mb3VuZGF0aW9uTW9kZWxJZDtcblxuICAgIC8vIEEgY3Jvc3MtcmVnaW9uIGluZmVyZW5jZSBwcm9maWxlIGlkIChlLmcuIFwidXMuYW50aHJvcGljLmNsYXVkZS0uLi5cIikgd3JhcHNcbiAgICAvLyBhbiB1bmRlcmx5aW5nIGZvdW5kYXRpb24gbW9kZWwgKFwiYW50aHJvcGljLmNsYXVkZS0uLi5cIikuIEJvdGggQVJOcyBhcmVcbiAgICAvLyBuZWVkZWQgaW4gdGhlIElBTSBwb2xpY3k6IHRoZSBpbmZlcmVuY2UtcHJvZmlsZSBBUk4gYW5kIHRoZSB1bmRlcmx5aW5nXG4gICAgLy8gZm91bmRhdGlvbi1tb2RlbCBBUk4uIFN0cmlwIGEga25vd24gZ2VvIHByZWZpeCB0byBkZXJpdmUgdGhlIGJhc2UgbW9kZWwuXG4gICAgY29uc3QgaW5mZXJlbmNlUHJvZmlsZVByZWZpeGVzID0gWyd1cycsICdldScsICdhcGFjJywgJ3VzLWdvdiddO1xuICAgIGNvbnN0IGZpcnN0U2VnbWVudCA9IGZvdW5kYXRpb25Nb2RlbC5zcGxpdCgnLicpWzBdO1xuICAgIGNvbnN0IGJhc2VGb3VuZGF0aW9uTW9kZWwgPSBpbmZlcmVuY2VQcm9maWxlUHJlZml4ZXMuaW5jbHVkZXMoZmlyc3RTZWdtZW50KVxuICAgICAgPyBmb3VuZGF0aW9uTW9kZWwuc3Vic3RyaW5nKGZpcnN0U2VnbWVudC5sZW5ndGggKyAxKVxuICAgICAgOiBmb3VuZGF0aW9uTW9kZWw7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gSUFNIFJvbGVzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgLy8gTWFpbiBSdW50aW1lIFJvbGVcbiAgICBjb25zdCBydW50aW1lUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnUnVudGltZVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnYmVkcm9jay1hZ2VudGNvcmUuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuXG4gICAgLy8gRUNSIHRva2VuIGFjY2Vzc1xuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIHNpZDogJ0VDUlRva2VuQWNjZXNzJyxcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbiddLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICAvLyBDbG91ZFdhdGNoIExvZ3NcbiAgICBydW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2xvZ3M6RGVzY3JpYmVMb2dHcm91cHMnXSxcbiAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOmxvZ3M6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmxvZy1ncm91cDoqYF0sXG4gICAgfSkpO1xuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnbG9nczpEZXNjcmliZUxvZ1N0cmVhbXMnLCAnbG9nczpDcmVhdGVMb2dHcm91cCddLFxuICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOi9hd3MvYmVkcm9jay1hZ2VudGNvcmUvcnVudGltZXMvKmBdLFxuICAgIH0pKTtcbiAgICBydW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2xvZ3M6Q3JlYXRlTG9nU3RyZWFtJywgJ2xvZ3M6UHV0TG9nRXZlbnRzJ10sXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpsb2dzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpsb2ctZ3JvdXA6L2F3cy9iZWRyb2NrLWFnZW50Y29yZS9ydW50aW1lcy8qOmxvZy1zdHJlYW06KmBdLFxuICAgIH0pKTtcblxuICAgIC8vIEFkZCBCZWRyb2NrIG1vZGVsIHBlcm1pc3Npb25zIHRvIE1haW4gUnVudGltZVxuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2s6SW52b2tlTW9kZWwnLFxuICAgICAgICAnYmVkcm9jazpJbnZva2VNb2RlbFdpdGhSZXNwb25zZVN0cmVhbScsXG4gICAgICAgICdiZWRyb2NrOkNvbnZlcnNlU3RyZWFtJyxcbiAgICAgICAgJ2JlZHJvY2s6Q29udmVyc2UnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogQXJyYXkuZnJvbShuZXcgU2V0KFtcbiAgICAgICAgYGFybjphd3M6YmVkcm9jazoqOjpmb3VuZGF0aW9uLW1vZGVsLyR7Zm91bmRhdGlvbk1vZGVsfWAsXG4gICAgICAgIGBhcm46YXdzOmJlZHJvY2s6Kjo6Zm91bmRhdGlvbi1tb2RlbC8ke2Jhc2VGb3VuZGF0aW9uTW9kZWx9YCxcbiAgICAgICAgYGFybjphd3M6YmVkcm9jazoqOiR7dGhpcy5hY2NvdW50fTppbmZlcmVuY2UtcHJvZmlsZS8ke2ZvdW5kYXRpb25Nb2RlbH1gLFxuICAgICAgICAvLyBDcm9zcy1yZWdpb24gaW5mZXJlbmNlIHByb2ZpbGVzIGZhbiBvdXQgdG8gcGVyLXJlZ2lvbiBmb3VuZGF0aW9uXG4gICAgICAgIC8vIG1vZGVscywgc28gYWxsb3cgdGhlIHVuZGVybHlpbmcgbW9kZWwgaW4gYW55IHJlZ2lvbiB0b28uXG4gICAgICAgIGBhcm46YXdzOmJlZHJvY2s6Kjoke3RoaXMuYWNjb3VudH06aW5mZXJlbmNlLXByb2ZpbGUvJHtiYXNlRm91bmRhdGlvbk1vZGVsfWAsXG4gICAgICBdKSksXG4gICAgfSkpO1xuXG4gICAgLy8gQWRkIEdhdGV3YXkgaW52b2NhdGlvbiBwZXJtaXNzaW9ucyB0byBNYWluIFJ1bnRpbWVcbiAgICBydW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpJbnZva2VHYXRld2F5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldEdhdGV3YXknLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdEdhdGV3YXlUYXJnZXRzJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgcHJvcHMuZ2F0ZXdheUFybixcbiAgICAgICAgYCR7cHJvcHMuZ2F0ZXdheUFybn0vKmAsIC8vIEZvciBnYXRld2F5IHRhcmdldHNcbiAgICAgIF0sXG4gICAgfSkpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE1lbW9yeVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IG1lbW9yeSA9IG5ldyBhZ2VudGNvcmUuTWVtb3J5KHRoaXMsICdDbG91ZE9wc01lbW9yeScsIHtcbiAgICAgIG1lbW9yeU5hbWU6ICdjbG91ZG9wc19tZW1vcnknLFxuICAgICAgZGVzY3JpcHRpb246ICdNZW1vcnkgZm9yIENsb3VkT3BzIGFnZW50IGNvbnZlcnNhdGlvbnMnLFxuICAgICAgZXhwaXJhdGlvbkR1cmF0aW9uOiBjZGsuRHVyYXRpb24uZGF5cygzMCksXG4gICAgfSk7XG5cbiAgICB0aGlzLm1lbW9yeUlkID0gbWVtb3J5Lm1lbW9yeUlkO1xuXG4gICAgLy8gQWRkIE1lbW9yeSBwZXJtaXNzaW9ucyB0byBNYWluIFJ1bnRpbWUsIHNjb3BlZCB0byB0aGUgc3BlY2lmaWMgTWVtb3J5XG4gICAgLy8gcmVzb3VyY2UgY3JlYXRlZCBieSB0aGlzIHN0YWNrIChhbmQgaXRzIHN1Yi1yZXNvdXJjZXMsIGUuZy4gZXZlbnRzKVxuICAgIC8vIHJhdGhlciB0aGFuIGFsbCBtZW1vcmllcyBpbiB0aGUgYWNjb3VudC4gRGVjbGFyZWQgYWZ0ZXIgdGhlIE1lbW9yeVxuICAgIC8vIGNvbnN0cnVjdCBzbyBtZW1vcnkubWVtb3J5SWQgaXMgYXZhaWxhYmxlIGZvciB0aGUgQVJOLlxuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZUV2ZW50JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldExhc3RLVHVybnMnLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0TWVtb3J5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RFdmVudHMnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czpiZWRyb2NrLWFnZW50Y29yZToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bWVtb3J5LyR7bWVtb3J5Lm1lbW9yeUlkfWAsXG4gICAgICAgIGBhcm46YXdzOmJlZHJvY2stYWdlbnRjb3JlOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTptZW1vcnkvJHttZW1vcnkubWVtb3J5SWR9LypgLFxuICAgICAgXSxcbiAgICB9KSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTWFpbiBBZ2VudCBSdW50aW1lXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgcnVudGltZSA9IG5ldyBhZ2VudGNvcmUuUnVudGltZSh0aGlzLCAnQ2xvdWRPcHNSdW50aW1lJywge1xuICAgICAgcnVudGltZU5hbWU6ICdjbG91ZG9wc19ydW50aW1lJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRPcHMgQWdlbnQgUnVudGltZSB3aXRoIEdhdGV3YXkgaW50ZWdyYXRpb24nLFxuICAgICAgZXhlY3V0aW9uUm9sZTogcnVudGltZVJvbGUsXG4gICAgICBhZ2VudFJ1bnRpbWVBcnRpZmFjdDogYWdlbnRjb3JlLkFnZW50UnVudGltZUFydGlmYWN0LmZyb21FY3JSZXBvc2l0b3J5KFxuICAgICAgICBwcm9wcy5yZXBvc2l0b3J5LFxuICAgICAgICAnbGF0ZXN0J1xuICAgICAgKSxcbiAgICAgIG5ldHdvcmtDb25maWd1cmF0aW9uOiBhZ2VudGNvcmUuUnVudGltZU5ldHdvcmtDb25maWd1cmF0aW9uLnVzaW5nUHVibGljTmV0d29yaygpLFxuICAgICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcbiAgICAgICAgTUVNT1JZX0lEOiBtZW1vcnkubWVtb3J5SWQsXG4gICAgICAgIE1PREVMX0lEOiBmb3VuZGF0aW9uTW9kZWwsXG4gICAgICAgIEFXU19SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgICBHQVRFV0FZX0FSTjogcHJvcHMuZ2F0ZXdheUFybixcbiAgICAgICAgREVQTE9ZTUVOVF9USU1FU1RBTVA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgRk9SQ0VfUkVCVUlMRDogYCR7RGF0ZS5ub3coKX1gLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IEVDUiBwdWxsIHBlcm1pc3Npb25zIChmcm9tRWNyUmVwb3NpdG9yeSBkb2Vzbid0IGF1dG8tZ3JhbnQpXG4gICAgcHJvcHMucmVwb3NpdG9yeS5ncmFudFB1bGwocnVudGltZVJvbGUpO1xuXG4gICAgdGhpcy5tYWluUnVudGltZUFybiA9IHJ1bnRpbWUuYWdlbnRSdW50aW1lQXJuO1xuICAgIHRoaXMubWFpblJ1bnRpbWVSb2xlID0gcnVudGltZVJvbGU7XG4gICAgdGhpcy5tYWluUnVudGltZVJvbGVBcm4gPSBydW50aW1lUm9sZS5yb2xlQXJuO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWdlbnRDb3JlQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMubWFpblJ1bnRpbWVBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FnZW50Q29yZSBSdW50aW1lIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQWdlbnRDb3JlQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdNZW1vcnlJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLm1lbW9yeUlkLFxuICAgICAgZGVzY3JpcHRpb246ICdNZW1vcnkgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LU1lbW9yeUlkYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbElkJywge1xuICAgICAgdmFsdWU6IHByb3BzLnVzZXJQb29sSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIElEJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbENsaWVudElkJywge1xuICAgICAgdmFsdWU6IHByb3BzLnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIENsaWVudCBJRCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSWRlbnRpdHlQb29sSWQnLCB7XG4gICAgICB2YWx1ZTogcHJvcHMuaWRlbnRpdHlQb29sSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gSWRlbnRpdHkgUG9vbCBJRCcsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ0RLLU5hZyBTdXBwcmVzc2lvbnNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMocnVudGltZVJvbGUsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBFQ1IgYXV0aCB0b2tlbiwgQ2xvdWRXYXRjaCBMb2dzLCBCZWRyb2NrIG1vZGVsIGludm9jYXRpb24sIGFuZCBBZ2VudENvcmUgbWVtb3J5IGFjY2VzcycsXG4gICAgICB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtTDEnLFxuICAgICAgICByZWFzb246ICdQeXRob24gMy4xNCBpcyB0aGUgbGF0ZXN0IExhbWJkYSBydW50aW1lIHZlcnNpb24gYXZhaWxhYmxlJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTQnLFxuICAgICAgICByZWFzb246ICdBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgbWFuYWdlZCBwb2xpY3kgaXMgQVdTIGJlc3QgcHJhY3RpY2UgZm9yIExhbWJkYSBmdW5jdGlvbnMnLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBjdXN0b20gcmVzb3VyY2UgTGFtYmRhIGZ1bmN0aW9ucycsXG4gICAgICB9LFxuICAgIF0pO1xuICB9XG59XG4iXX0=