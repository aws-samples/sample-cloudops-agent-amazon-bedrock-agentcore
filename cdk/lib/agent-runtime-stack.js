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
        // Add Memory permissions to Main Runtime
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock-agentcore:CreateEvent',
                'bedrock-agentcore:GetLastKTurns',
                'bedrock-agentcore:GetMemory',
                'bedrock-agentcore:ListEvents',
            ],
            resources: [
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/*`,
            ],
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYWdlbnQtcnVudGltZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFnZW50LXJ1bnRpbWUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLGdGQUFrRTtBQUNsRSx5REFBMkM7QUFHM0MscUNBQTBDO0FBZ0IxQyxNQUFhLGlCQUFrQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBTTlDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNkI7UUFDckUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsNkVBQTZFO1FBQzdFLE1BQU0sZUFBZSxHQUFHLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQztRQUVoRCw2RUFBNkU7UUFDN0UseUVBQXlFO1FBQ3pFLHlFQUF5RTtRQUN6RSwyRUFBMkU7UUFDM0UsTUFBTSx3QkFBd0IsR0FBRyxDQUFDLElBQUksRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLFFBQVEsQ0FBQyxDQUFDO1FBQ2hFLE1BQU0sWUFBWSxHQUFHLGVBQWUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbkQsTUFBTSxtQkFBbUIsR0FBRyx3QkFBd0IsQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDO1lBQ3pFLENBQUMsQ0FBQyxlQUFlLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO1lBQ3BELENBQUMsQ0FBQyxlQUFlLENBQUM7UUFFcEIsMkNBQTJDO1FBQzNDLFlBQVk7UUFDWiwyQ0FBMkM7UUFFM0Msb0JBQW9CO1FBQ3BCLE1BQU0sV0FBVyxHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ3BELFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxpQ0FBaUMs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SyxFQUFFLEtBQUssQ0FBQyxjQUFjO1lBQzNCLFdBQVcsRUFBRSwwQkFBMEI7U0FDeEMsQ0FBQyxDQUFDO1FBRUgsMkNBQTJDO1FBQzNDLHVCQUF1QjtRQUN2QiwyQ0FBMkM7UUFFM0MseUJBQWUsQ0FBQyx1QkFBdUIsQ0FBQyxXQUFXLEVBQUU7WUFDbkQ7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLDBIQUEwSDthQUNuSTtTQUNGLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFFVCx5QkFBZSxDQUFDLG9CQUFvQixDQUFDLElBQUksRUFBRTtZQUN6QztnQkFDRSxFQUFFLEVBQUUsaUJBQWlCO2dCQUNyQixNQUFNLEVBQUUsNERBQTREO2FBQ3JFO1lBQ0Q7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLHNGQUFzRjthQUMvRjtZQUNEO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxvRUFBb0U7YUFDN0U7U0FDRixDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUExTUQsOENBME1DIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGFnZW50Y29yZSBmcm9tICdAYXdzLWNkay9hd3MtYmVkcm9jay1hZ2VudGNvcmUtYWxwaGEnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgZWNyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lY3InO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBOYWdTdXBwcmVzc2lvbnMgfSBmcm9tICdjZGstbmFnJztcblxuZXhwb3J0IGludGVyZmFjZSBBZ2VudFJ1bnRpbWVTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICByZXBvc2l0b3J5OiBlY3IuSVJlcG9zaXRvcnk7XG4gIHVzZXJQb29sQXJuOiBzdHJpbmc7XG4gIGdhdGV3YXlBcm46IHN0cmluZzsgLy8gR2F0ZXdheSBBUk4gZnJvbSBBZ2VudENvcmVHYXRld2F5U3RhY2tcbiAgLy8gQmVkcm9jayBtb2RlbCBpZCB0aGUgYWdlbnQgcnVucyBvbiAoQmVkcm9jayBtb2RlbCBpZCBvciBjcm9zcy1yZWdpb25cbiAgLy8gaW5mZXJlbmNlIHByb2ZpbGUgaWQpLiBDb25maWd1cmFibGUgYXQgZGVwbG95IHRpbWUgdmlhIEJFRFJPQ0tfTU9ERUxfSUQgL1xuICAvLyBgLWMgbW9kZWxJZD0uLi5gOyBzZWUgYmluL2FwcC50cy5cbiAgZm91bmRhdGlvbk1vZGVsSWQ6IHN0cmluZztcbiAgLy8gRm9yIGZyb250ZW5kIGNvbmZpZ3VyYXRpb24gb3V0cHV0c1xuICB1c2VyUG9vbElkOiBzdHJpbmc7XG4gIHVzZXJQb29sQ2xpZW50SWQ6IHN0cmluZztcbiAgaWRlbnRpdHlQb29sSWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEFnZW50UnVudGltZVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IG1haW5SdW50aW1lQXJuOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBtZW1vcnlJZDogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgbWFpblJ1bnRpbWVSb2xlOiBpYW0uSVJvbGU7XG4gIHB1YmxpYyByZWFkb25seSBtYWluUnVudGltZVJvbGVBcm46IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQWdlbnRSdW50aW1lU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gTW9kZWwgaWQgaXMgc3VwcGxpZWQgYnkgdGhlIGFwcCAoZW52IHZhciAvIGNvbnRleHQpIOKAlCBubyBsb25nZXIgaGFyZGNvZGVkLlxuICAgIGNvbnN0IGZvdW5kYXRpb25Nb2RlbCA9IHByb3BzLmZvdW5kYXRpb25Nb2RlbElkO1xuXG4gICAgLy8gQSBjcm9zcy1yZWdpb24gaW5mZXJlbmNlIHByb2ZpbGUgaWQgKGUuZy4gXCJ1cy5hbnRocm9waWMuY2xhdWRlLS4uLlwiKSB3cmFwc1xuICAgIC8vIGFuIHVuZGVybHlpbmcgZm91bmRhdGlvbiBtb2RlbCAoXCJhbnRocm9waWMuY2xhdWRlLS4uLlwiKS4gQm90aCBBUk5zIGFyZVxuICAgIC8vIG5lZWRlZCBpbiB0aGUgSUFNIHBvbGljeTogdGhlIGluZmVyZW5jZS1wcm9maWxlIEFSTiBhbmQgdGhlIHVuZGVybHlpbmdcbiAgICAvLyBmb3VuZGF0aW9uLW1vZGVsIEFSTi4gU3RyaXAgYSBrbm93biBnZW8gcHJlZml4IHRvIGRlcml2ZSB0aGUgYmFzZSBtb2RlbC5cbiAgICBjb25zdCBpbmZlcmVuY2VQcm9maWxlUHJlZml4ZXMgPSBbJ3VzJywgJ2V1JywgJ2FwYWMnLCAndXMtZ292J107XG4gICAgY29uc3QgZmlyc3RTZWdtZW50ID0gZm91bmRhdGlvbk1vZGVsLnNwbGl0KCcuJylbMF07XG4gICAgY29uc3QgYmFzZUZvdW5kYXRpb25Nb2RlbCA9IGluZmVyZW5jZVByb2ZpbGVQcmVmaXhlcy5pbmNsdWRlcyhmaXJzdFNlZ21lbnQpXG4gICAgICA/IGZvdW5kYXRpb25Nb2RlbC5zdWJzdHJpbmcoZmlyc3RTZWdtZW50Lmxlbmd0aCArIDEpXG4gICAgICA6IGZvdW5kYXRpb25Nb2RlbDtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBJQU0gUm9sZXNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBNYWluIFJ1bnRpbWUgUm9sZVxuICAgIGNvbnN0IHJ1bnRpbWVSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdSdW50aW1lUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiZWRyb2NrLWFnZW50Y29yZS5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG5cbiAgICAvLyBFQ1IgdG9rZW4gYWNjZXNzXG4gICAgcnVudGltZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgc2lkOiAnRUNSVG9rZW5BY2Nlc3MnLFxuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuJ10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIC8vIENsb3VkV2F0Y2ggTG9nc1xuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnbG9nczpEZXNjcmliZUxvZ0dyb3VwcyddLFxuICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOipgXSxcbiAgICB9KSk7XG4gICAgcnVudGltZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydsb2dzOkRlc2NyaWJlTG9nU3RyZWFtcycsICdsb2dzOkNyZWF0ZUxvZ0dyb3VwJ10sXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpsb2dzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpsb2ctZ3JvdXA6L2F3cy9iZWRyb2NrLWFnZW50Y29yZS9ydW50aW1lcy8qYF0sXG4gICAgfSkpO1xuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnbG9nczpDcmVhdGVMb2dTdHJlYW0nLCAnbG9nczpQdXRMb2dFdmVudHMnXSxcbiAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOmxvZ3M6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmxvZy1ncm91cDovYXdzL2JlZHJvY2stYWdlbnRjb3JlL3J1bnRpbWVzLyo6bG9nLXN0cmVhbToqYF0sXG4gICAgfSkpO1xuXG4gICAgLy8gQWRkIEJlZHJvY2sgbW9kZWwgcGVybWlzc2lvbnMgdG8gTWFpbiBSdW50aW1lXG4gICAgcnVudGltZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnYmVkcm9jazpJbnZva2VNb2RlbCcsXG4gICAgICAgICdiZWRyb2NrOkludm9rZU1vZGVsV2l0aFJlc3BvbnNlU3RyZWFtJyxcbiAgICAgICAgJ2JlZHJvY2s6Q29udmVyc2VTdHJlYW0nLFxuICAgICAgICAnYmVkcm9jazpDb252ZXJzZScsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBBcnJheS5mcm9tKG5ldyBTZXQoW1xuICAgICAgICBgYXJuOmF3czpiZWRyb2NrOio6OmZvdW5kYXRpb24tbW9kZWwvJHtmb3VuZGF0aW9uTW9kZWx9YCxcbiAgICAgICAgYGFybjphd3M6YmVkcm9jazoqOjpmb3VuZGF0aW9uLW1vZGVsLyR7YmFzZUZvdW5kYXRpb25Nb2RlbH1gLFxuICAgICAgICBgYXJuOmF3czpiZWRyb2NrOio6JHt0aGlzLmFjY291bnR9OmluZmVyZW5jZS1wcm9maWxlLyR7Zm91bmRhdGlvbk1vZGVsfWAsXG4gICAgICAgIC8vIENyb3NzLXJlZ2lvbiBpbmZlcmVuY2UgcHJvZmlsZXMgZmFuIG91dCB0byBwZXItcmVnaW9uIGZvdW5kYXRpb25cbiAgICAgICAgLy8gbW9kZWxzLCBzbyBhbGxvdyB0aGUgdW5kZXJseWluZyBtb2RlbCBpbiBhbnkgcmVnaW9uIHRvby5cbiAgICAgICAgYGFybjphd3M6YmVkcm9jazoqOiR7dGhpcy5hY2NvdW50fTppbmZlcmVuY2UtcHJvZmlsZS8ke2Jhc2VGb3VuZGF0aW9uTW9kZWx9YCxcbiAgICAgIF0pKSxcbiAgICB9KSk7XG5cbiAgICAvLyBBZGQgTWVtb3J5IHBlcm1pc3Npb25zIHRvIE1haW4gUnVudGltZVxuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZUV2ZW50JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldExhc3RLVHVybnMnLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0TWVtb3J5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RFdmVudHMnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czpiZWRyb2NrLWFnZW50Y29yZToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bWVtb3J5LypgLFxuICAgICAgXSxcbiAgICB9KSk7XG5cbiAgICAvLyBBZGQgR2F0ZXdheSBpbnZvY2F0aW9uIHBlcm1pc3Npb25zIHRvIE1haW4gUnVudGltZVxuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkludm9rZUdhdGV3YXknLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0R2F0ZXdheScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpMaXN0R2F0ZXdheVRhcmdldHMnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBwcm9wcy5nYXRld2F5QXJuLFxuICAgICAgICBgJHtwcm9wcy5nYXRld2F5QXJufS8qYCwgLy8gRm9yIGdhdGV3YXkgdGFyZ2V0c1xuICAgICAgXSxcbiAgICB9KSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTWVtb3J5XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgbWVtb3J5ID0gbmV3IGFnZW50Y29yZS5NZW1vcnkodGhpcywgJ0Nsb3VkT3BzTWVtb3J5Jywge1xuICAgICAgbWVtb3J5TmFtZTogJ2Nsb3Vkb3BzX21lbW9yeScsXG4gICAgICBkZXNjcmlwdGlvbjogJ01lbW9yeSBmb3IgQ2xvdWRPcHMgYWdlbnQgY29udmVyc2F0aW9ucycsXG4gICAgICBleHBpcmF0aW9uRHVyYXRpb246IGNkay5EdXJhdGlvbi5kYXlzKDMwKSxcbiAgICB9KTtcblxuICAgIHRoaXMubWVtb3J5SWQgPSBtZW1vcnkubWVtb3J5SWQ7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTWFpbiBBZ2VudCBSdW50aW1lXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgcnVudGltZSA9IG5ldyBhZ2VudGNvcmUuUnVudGltZSh0aGlzLCAnQ2xvdWRPcHNSdW50aW1lJywge1xuICAgICAgcnVudGltZU5hbWU6ICdjbG91ZG9wc19ydW50aW1lJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRPcHMgQWdlbnQgUnVudGltZSB3aXRoIEdhdGV3YXkgaW50ZWdyYXRpb24nLFxuICAgICAgZXhlY3V0aW9uUm9sZTogcnVudGltZVJvbGUsXG4gICAgICBhZ2VudFJ1bnRpbWVBcnRpZmFjdDogYWdlbnRjb3JlLkFnZW50UnVudGltZUFydGlmYWN0LmZyb21FY3JSZXBvc2l0b3J5KFxuICAgICAgICBwcm9wcy5yZXBvc2l0b3J5LFxuICAgICAgICAnbGF0ZXN0J1xuICAgICAgKSxcbiAgICAgIG5ldHdvcmtDb25maWd1cmF0aW9uOiBhZ2VudGNvcmUuUnVudGltZU5ldHdvcmtDb25maWd1cmF0aW9uLnVzaW5nUHVibGljTmV0d29yaygpLFxuICAgICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcbiAgICAgICAgTUVNT1JZX0lEOiBtZW1vcnkubWVtb3J5SWQsXG4gICAgICAgIE1PREVMX0lEOiBmb3VuZGF0aW9uTW9kZWwsXG4gICAgICAgIEFXU19SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgICBHQVRFV0FZX0FSTjogcHJvcHMuZ2F0ZXdheUFybixcbiAgICAgICAgREVQTE9ZTUVOVF9USU1FU1RBTVA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgRk9SQ0VfUkVCVUlMRDogYCR7RGF0ZS5ub3coKX1gLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IEVDUiBwdWxsIHBlcm1pc3Npb25zIChmcm9tRWNyUmVwb3NpdG9yeSBkb2Vzbid0IGF1dG8tZ3JhbnQpXG4gICAgcHJvcHMucmVwb3NpdG9yeS5ncmFudFB1bGwocnVudGltZVJvbGUpO1xuXG4gICAgdGhpcy5tYWluUnVudGltZUFybiA9IHJ1bnRpbWUuYWdlbnRSdW50aW1lQXJuO1xuICAgIHRoaXMubWFpblJ1bnRpbWVSb2xlID0gcnVudGltZVJvbGU7XG4gICAgdGhpcy5tYWluUnVudGltZVJvbGVBcm4gPSBydW50aW1lUm9sZS5yb2xlQXJuO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWdlbnRDb3JlQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMubWFpblJ1bnRpbWVBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FnZW50Q29yZSBSdW50aW1lIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQWdlbnRDb3JlQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdNZW1vcnlJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLm1lbW9yeUlkLFxuICAgICAgZGVzY3JpcHRpb246ICdNZW1vcnkgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LU1lbW9yeUlkYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbElkJywge1xuICAgICAgdmFsdWU6IHByb3BzLnVzZXJQb29sSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIElEJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbENsaWVudElkJywge1xuICAgICAgdmFsdWU6IHByb3BzLnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIENsaWVudCBJRCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSWRlbnRpdHlQb29sSWQnLCB7XG4gICAgICB2YWx1ZTogcHJvcHMuaWRlbnRpdHlQb29sSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gSWRlbnRpdHkgUG9vbCBJRCcsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ0RLLU5hZyBTdXBwcmVzc2lvbnNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMocnVudGltZVJvbGUsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBFQ1IgYXV0aCB0b2tlbiwgQ2xvdWRXYXRjaCBMb2dzLCBCZWRyb2NrIG1vZGVsIGludm9jYXRpb24sIGFuZCBBZ2VudENvcmUgbWVtb3J5IGFjY2VzcycsXG4gICAgICB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtTDEnLFxuICAgICAgICByZWFzb246ICdQeXRob24gMy4xNCBpcyB0aGUgbGF0ZXN0IExhbWJkYSBydW50aW1lIHZlcnNpb24gYXZhaWxhYmxlJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTQnLFxuICAgICAgICByZWFzb246ICdBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgbWFuYWdlZCBwb2xpY3kgaXMgQVdTIGJlc3QgcHJhY3RpY2UgZm9yIExhbWJkYSBmdW5jdGlvbnMnLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBjdXN0b20gcmVzb3VyY2UgTGFtYmRhIGZ1bmN0aW9ucycsXG4gICAgICB9LFxuICAgIF0pO1xuICB9XG59XG4iXX0=