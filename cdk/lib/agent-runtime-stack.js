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
const observability_1 = require("./observability");
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
                // The application owns a filtered exporter; a second ADOT pipeline could leak payloads.
                DISABLE_ADOT_OBSERVABILITY: 'true',
                AGENT_OBSERVABILITY_ENABLED: 'true',
                OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
                OTEL_SEMCONV_STABILITY_OPT_IN: 'gen_ai_latest_experimental,gen_ai_unredacted_attributes=',
                // Use the existing regional Transaction Search destination without changing its policy.
                UNIFIED_TRACES_DESTINATION_ENABLED: 'false',
                DEPLOYMENT_TIMESTAMP: new Date().toISOString(),
                FORCE_REBUILD: `${Date.now()}`,
            },
        });
        // Grant ECR pull permissions (fromEcrRepository doesn't auto-grant)
        props.repository.grantPull(runtimeRole);
        this.mainRuntimeArn = runtime.agentRuntimeArn;
        this.mainRuntimeRole = runtimeRole;
        this.mainRuntimeRoleArn = runtimeRole.roleArn;
        (0, observability_1.addTracing)(this, {
            Runtime: runtime.agentRuntimeArn,
            RuntimeIdentity: (0, observability_1.workloadIdentityArn)(this, runtime.agentRuntimeArn),
            Memory: memory.memoryArn,
        });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYWdlbnQtcnVudGltZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFnZW50LXJ1bnRpbWUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLGdGQUFrRTtBQUNsRSx5REFBMkM7QUFHM0MscUNBQTBDO0FBQzFDLG1EQUFrRTtBQWdCbEUsTUFBYSxpQkFBa0IsU0FBUSxHQUFHLENBQUMsS0FBSztJQU05QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTZCO1FBQ3JFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDZFQUE2RTtRQUM3RSxNQUFNLGVBQWUsR0FBRyxLQUFLLENBQUMsaUJBQWlCLENBQUM7UUFFaEQsNkVBQTZFO1FBQzdFLHlFQUF5RTtRQUN6RSx5RUFBeUU7UUFDekUsMkVBQTJFO1FBQzNFLE1BQU0sd0JBQXdCLEdBQUcsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxRQUFRLENBQUMsQ0FBQztRQUNoRSxNQUFNLFlBQVksR0FBRyxlQUFlLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ25ELE1BQU0sbUJBQW1CLEdBQUcsd0JBQXdCLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQztZQUN6RSxDQUFDLENBQUMsZUFBZSxDQUFDLFNBQVMsQ0FBQyxZQUFZLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQztZQUNwRCxDQUFDLENBQUMsZUFBZSxDQUFDO1FBRXBCLDJDQUEyQztRQUMzQyxZQUFZO1FBQ1osMkNBQTJDO1FBRTNDLG9CQUFvQjtRQUNwQixNQUFNLFdBQVcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtZQUNwRCxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdC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RTtTQUNGLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQTNORCw4Q0EyTkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgYWdlbnRjb3JlIGZyb20gJ0Bhd3MtY2RrL2F3cy1iZWRyb2NrLWFnZW50Y29yZS1hbHBoYSc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xuaW1wb3J0IHsgYWRkVHJhY2luZywgd29ya2xvYWRJZGVudGl0eUFybiB9IGZyb20gJy4vb2JzZXJ2YWJpbGl0eSc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQWdlbnRSdW50aW1lU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgcmVwb3NpdG9yeTogZWNyLklSZXBvc2l0b3J5O1xuICB1c2VyUG9vbEFybjogc3RyaW5nO1xuICBnYXRld2F5QXJuOiBzdHJpbmc7IC8vIEdhdGV3YXkgQVJOIGZyb20gQWdlbnRDb3JlR2F0ZXdheVN0YWNrXG4gIC8vIEJlZHJvY2sgbW9kZWwgaWQgdGhlIGFnZW50IHJ1bnMgb24gKEJlZHJvY2sgbW9kZWwgaWQgb3IgY3Jvc3MtcmVnaW9uXG4gIC8vIGluZmVyZW5jZSBwcm9maWxlIGlkKS4gQ29uZmlndXJhYmxlIGF0IGRlcGxveSB0aW1lIHZpYSBCRURST0NLX01PREVMX0lEIC9cbiAgLy8gYC1jIG1vZGVsSWQ9Li4uYDsgc2VlIGJpbi9hcHAudHMuXG4gIGZvdW5kYXRpb25Nb2RlbElkOiBzdHJpbmc7XG4gIC8vIEZvciBmcm9udGVuZCBjb25maWd1cmF0aW9uIG91dHB1dHNcbiAgdXNlclBvb2xJZDogc3RyaW5nO1xuICB1c2VyUG9vbENsaWVudElkOiBzdHJpbmc7XG4gIGlkZW50aXR5UG9vbElkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBBZ2VudFJ1bnRpbWVTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBtYWluUnVudGltZUFybjogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgbWVtb3J5SWQ6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IG1haW5SdW50aW1lUm9sZTogaWFtLklSb2xlO1xuICBwdWJsaWMgcmVhZG9ubHkgbWFpblJ1bnRpbWVSb2xlQXJuOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFnZW50UnVudGltZVN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIE1vZGVsIGlkIGlzIHN1cHBsaWVkIGJ5IHRoZSBhcHAgKGVudiB2YXIgLyBjb250ZXh0KSDigJQgbm8gbG9uZ2VyIGhhcmRjb2RlZC5cbiAgICBjb25zdCBmb3VuZGF0aW9uTW9kZWwgPSBwcm9wcy5mb3VuZGF0aW9uTW9kZWxJZDtcblxuICAgIC8vIEEgY3Jvc3MtcmVnaW9uIGluZmVyZW5jZSBwcm9maWxlIGlkIChlLmcuIFwidXMuYW50aHJvcGljLmNsYXVkZS0uLi5cIikgd3JhcHNcbiAgICAvLyBhbiB1bmRlcmx5aW5nIGZvdW5kYXRpb24gbW9kZWwgKFwiYW50aHJvcGljLmNsYXVkZS0uLi5cIikuIEJvdGggQVJOcyBhcmVcbiAgICAvLyBuZWVkZWQgaW4gdGhlIElBTSBwb2xpY3k6IHRoZSBpbmZlcmVuY2UtcHJvZmlsZSBBUk4gYW5kIHRoZSB1bmRlcmx5aW5nXG4gICAgLy8gZm91bmRhdGlvbi1tb2RlbCBBUk4uIFN0cmlwIGEga25vd24gZ2VvIHByZWZpeCB0byBkZXJpdmUgdGhlIGJhc2UgbW9kZWwuXG4gICAgY29uc3QgaW5mZXJlbmNlUHJvZmlsZVByZWZpeGVzID0gWyd1cycsICdldScsICdhcGFjJywgJ3VzLWdvdiddO1xuICAgIGNvbnN0IGZpcnN0U2VnbWVudCA9IGZvdW5kYXRpb25Nb2RlbC5zcGxpdCgnLicpWzBdO1xuICAgIGNvbnN0IGJhc2VGb3VuZGF0aW9uTW9kZWwgPSBpbmZlcmVuY2VQcm9maWxlUHJlZml4ZXMuaW5jbHVkZXMoZmlyc3RTZWdtZW50KVxuICAgICAgPyBmb3VuZGF0aW9uTW9kZWwuc3Vic3RyaW5nKGZpcnN0U2VnbWVudC5sZW5ndGggKyAxKVxuICAgICAgOiBmb3VuZGF0aW9uTW9kZWw7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gSUFNIFJvbGVzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgLy8gTWFpbiBSdW50aW1lIFJvbGVcbiAgICBjb25zdCBydW50aW1lUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnUnVudGltZVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnYmVkcm9jay1hZ2VudGNvcmUuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuXG4gICAgLy8gRUNSIHRva2VuIGFjY2Vzc1xuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIHNpZDogJ0VDUlRva2VuQWNjZXNzJyxcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbiddLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICAvLyBDbG91ZFdhdGNoIExvZ3NcbiAgICBydW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2xvZ3M6RGVzY3JpYmVMb2dHcm91cHMnXSxcbiAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOmxvZ3M6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmxvZy1ncm91cDoqYF0sXG4gICAgfSkpO1xuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnbG9nczpEZXNjcmliZUxvZ1N0cmVhbXMnLCAnbG9nczpDcmVhdGVMb2dHcm91cCddLFxuICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOi9hd3MvYmVkcm9jay1hZ2VudGNvcmUvcnVudGltZXMvKmBdLFxuICAgIH0pKTtcbiAgICBydW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2xvZ3M6Q3JlYXRlTG9nU3RyZWFtJywgJ2xvZ3M6UHV0TG9nRXZlbnRzJ10sXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpsb2dzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpsb2ctZ3JvdXA6L2F3cy9iZWRyb2NrLWFnZW50Y29yZS9ydW50aW1lcy8qOmxvZy1zdHJlYW06KmBdLFxuICAgIH0pKTtcblxuICAgIC8vIEFkZCBCZWRyb2NrIG1vZGVsIHBlcm1pc3Npb25zIHRvIE1haW4gUnVudGltZVxuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2s6SW52b2tlTW9kZWwnLFxuICAgICAgICAnYmVkcm9jazpJbnZva2VNb2RlbFdpdGhSZXNwb25zZVN0cmVhbScsXG4gICAgICAgICdiZWRyb2NrOkNvbnZlcnNlU3RyZWFtJyxcbiAgICAgICAgJ2JlZHJvY2s6Q29udmVyc2UnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogQXJyYXkuZnJvbShuZXcgU2V0KFtcbiAgICAgICAgYGFybjphd3M6YmVkcm9jazoqOjpmb3VuZGF0aW9uLW1vZGVsLyR7Zm91bmRhdGlvbk1vZGVsfWAsXG4gICAgICAgIGBhcm46YXdzOmJlZHJvY2s6Kjo6Zm91bmRhdGlvbi1tb2RlbC8ke2Jhc2VGb3VuZGF0aW9uTW9kZWx9YCxcbiAgICAgICAgYGFybjphd3M6YmVkcm9jazoqOiR7dGhpcy5hY2NvdW50fTppbmZlcmVuY2UtcHJvZmlsZS8ke2ZvdW5kYXRpb25Nb2RlbH1gLFxuICAgICAgICAvLyBDcm9zcy1yZWdpb24gaW5mZXJlbmNlIHByb2ZpbGVzIGZhbiBvdXQgdG8gcGVyLXJlZ2lvbiBmb3VuZGF0aW9uXG4gICAgICAgIC8vIG1vZGVscywgc28gYWxsb3cgdGhlIHVuZGVybHlpbmcgbW9kZWwgaW4gYW55IHJlZ2lvbiB0b28uXG4gICAgICAgIGBhcm46YXdzOmJlZHJvY2s6Kjoke3RoaXMuYWNjb3VudH06aW5mZXJlbmNlLXByb2ZpbGUvJHtiYXNlRm91bmRhdGlvbk1vZGVsfWAsXG4gICAgICBdKSksXG4gICAgfSkpO1xuXG4gICAgLy8gQWRkIEdhdGV3YXkgaW52b2NhdGlvbiBwZXJtaXNzaW9ucyB0byBNYWluIFJ1bnRpbWVcbiAgICBydW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpJbnZva2VHYXRld2F5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldEdhdGV3YXknLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdEdhdGV3YXlUYXJnZXRzJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgcHJvcHMuZ2F0ZXdheUFybixcbiAgICAgICAgYCR7cHJvcHMuZ2F0ZXdheUFybn0vKmAsIC8vIEZvciBnYXRld2F5IHRhcmdldHNcbiAgICAgIF0sXG4gICAgfSkpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE1lbW9yeVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IG1lbW9yeSA9IG5ldyBhZ2VudGNvcmUuTWVtb3J5KHRoaXMsICdDbG91ZE9wc01lbW9yeScsIHtcbiAgICAgIG1lbW9yeU5hbWU6ICdjbG91ZG9wc19tZW1vcnknLFxuICAgICAgZGVzY3JpcHRpb246ICdNZW1vcnkgZm9yIENsb3VkT3BzIGFnZW50IGNvbnZlcnNhdGlvbnMnLFxuICAgICAgZXhwaXJhdGlvbkR1cmF0aW9uOiBjZGsuRHVyYXRpb24uZGF5cygzMCksXG4gICAgfSk7XG5cbiAgICB0aGlzLm1lbW9yeUlkID0gbWVtb3J5Lm1lbW9yeUlkO1xuXG4gICAgLy8gQWRkIE1lbW9yeSBwZXJtaXNzaW9ucyB0byBNYWluIFJ1bnRpbWUsIHNjb3BlZCB0byB0aGUgc3BlY2lmaWMgTWVtb3J5XG4gICAgLy8gcmVzb3VyY2UgY3JlYXRlZCBieSB0aGlzIHN0YWNrIChhbmQgaXRzIHN1Yi1yZXNvdXJjZXMsIGUuZy4gZXZlbnRzKVxuICAgIC8vIHJhdGhlciB0aGFuIGFsbCBtZW1vcmllcyBpbiB0aGUgYWNjb3VudC4gRGVjbGFyZWQgYWZ0ZXIgdGhlIE1lbW9yeVxuICAgIC8vIGNvbnN0cnVjdCBzbyBtZW1vcnkubWVtb3J5SWQgaXMgYXZhaWxhYmxlIGZvciB0aGUgQVJOLlxuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZUV2ZW50JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldExhc3RLVHVybnMnLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0TWVtb3J5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RFdmVudHMnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czpiZWRyb2NrLWFnZW50Y29yZToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bWVtb3J5LyR7bWVtb3J5Lm1lbW9yeUlkfWAsXG4gICAgICAgIGBhcm46YXdzOmJlZHJvY2stYWdlbnRjb3JlOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTptZW1vcnkvJHttZW1vcnkubWVtb3J5SWR9LypgLFxuICAgICAgXSxcbiAgICB9KSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTWFpbiBBZ2VudCBSdW50aW1lXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgcnVudGltZSA9IG5ldyBhZ2VudGNvcmUuUnVudGltZSh0aGlzLCAnQ2xvdWRPcHNSdW50aW1lJywge1xuICAgICAgcnVudGltZU5hbWU6ICdjbG91ZG9wc19ydW50aW1lJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRPcHMgQWdlbnQgUnVudGltZSB3aXRoIEdhdGV3YXkgaW50ZWdyYXRpb24nLFxuICAgICAgZXhlY3V0aW9uUm9sZTogcnVudGltZVJvbGUsXG4gICAgICBhZ2VudFJ1bnRpbWVBcnRpZmFjdDogYWdlbnRjb3JlLkFnZW50UnVudGltZUFydGlmYWN0LmZyb21FY3JSZXBvc2l0b3J5KFxuICAgICAgICBwcm9wcy5yZXBvc2l0b3J5LFxuICAgICAgICAnbGF0ZXN0J1xuICAgICAgKSxcbiAgICAgIG5ldHdvcmtDb25maWd1cmF0aW9uOiBhZ2VudGNvcmUuUnVudGltZU5ldHdvcmtDb25maWd1cmF0aW9uLnVzaW5nUHVibGljTmV0d29yaygpLFxuICAgICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcbiAgICAgICAgTUVNT1JZX0lEOiBtZW1vcnkubWVtb3J5SWQsXG4gICAgICAgIE1PREVMX0lEOiBmb3VuZGF0aW9uTW9kZWwsXG4gICAgICAgIEFXU19SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgICBHQVRFV0FZX0FSTjogcHJvcHMuZ2F0ZXdheUFybixcbiAgICAgICAgLy8gVGhlIGFwcGxpY2F0aW9uIG93bnMgYSBmaWx0ZXJlZCBleHBvcnRlcjsgYSBzZWNvbmQgQURPVCBwaXBlbGluZSBjb3VsZCBsZWFrIHBheWxvYWRzLlxuICAgICAgICBESVNBQkxFX0FET1RfT0JTRVJWQUJJTElUWTogJ3RydWUnLFxuICAgICAgICBBR0VOVF9PQlNFUlZBQklMSVRZX0VOQUJMRUQ6ICd0cnVlJyxcbiAgICAgICAgT1RFTF9JTlNUUlVNRU5UQVRJT05fR0VOQUlfQ0FQVFVSRV9NRVNTQUdFX0NPTlRFTlQ6ICdmYWxzZScsXG4gICAgICAgIE9URUxfU0VNQ09OVl9TVEFCSUxJVFlfT1BUX0lOOiAnZ2VuX2FpX2xhdGVzdF9leHBlcmltZW50YWwsZ2VuX2FpX3VucmVkYWN0ZWRfYXR0cmlidXRlcz0nLFxuICAgICAgICAvLyBVc2UgdGhlIGV4aXN0aW5nIHJlZ2lvbmFsIFRyYW5zYWN0aW9uIFNlYXJjaCBkZXN0aW5hdGlvbiB3aXRob3V0IGNoYW5naW5nIGl0cyBwb2xpY3kuXG4gICAgICAgIFVOSUZJRURfVFJBQ0VTX0RFU1RJTkFUSU9OX0VOQUJMRUQ6ICdmYWxzZScsXG4gICAgICAgIERFUExPWU1FTlRfVElNRVNUQU1QOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIEZPUkNFX1JFQlVJTEQ6IGAke0RhdGUubm93KCl9YCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBHcmFudCBFQ1IgcHVsbCBwZXJtaXNzaW9ucyAoZnJvbUVjclJlcG9zaXRvcnkgZG9lc24ndCBhdXRvLWdyYW50KVxuICAgIHByb3BzLnJlcG9zaXRvcnkuZ3JhbnRQdWxsKHJ1bnRpbWVSb2xlKTtcblxuICAgIHRoaXMubWFpblJ1bnRpbWVBcm4gPSBydW50aW1lLmFnZW50UnVudGltZUFybjtcbiAgICB0aGlzLm1haW5SdW50aW1lUm9sZSA9IHJ1bnRpbWVSb2xlO1xuICAgIHRoaXMubWFpblJ1bnRpbWVSb2xlQXJuID0gcnVudGltZVJvbGUucm9sZUFybjtcblxuICAgIGFkZFRyYWNpbmcodGhpcywge1xuICAgICAgUnVudGltZTogcnVudGltZS5hZ2VudFJ1bnRpbWVBcm4sXG4gICAgICBSdW50aW1lSWRlbnRpdHk6IHdvcmtsb2FkSWRlbnRpdHlBcm4odGhpcywgcnVudGltZS5hZ2VudFJ1bnRpbWVBcm4pLFxuICAgICAgTWVtb3J5OiBtZW1vcnkubWVtb3J5QXJuLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWdlbnRDb3JlQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMubWFpblJ1bnRpbWVBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FnZW50Q29yZSBSdW50aW1lIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQWdlbnRDb3JlQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdNZW1vcnlJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLm1lbW9yeUlkLFxuICAgICAgZGVzY3JpcHRpb246ICdNZW1vcnkgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LU1lbW9yeUlkYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbElkJywge1xuICAgICAgdmFsdWU6IHByb3BzLnVzZXJQb29sSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIElEJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbENsaWVudElkJywge1xuICAgICAgdmFsdWU6IHByb3BzLnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIENsaWVudCBJRCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSWRlbnRpdHlQb29sSWQnLCB7XG4gICAgICB2YWx1ZTogcHJvcHMuaWRlbnRpdHlQb29sSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gSWRlbnRpdHkgUG9vbCBJRCcsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ0RLLU5hZyBTdXBwcmVzc2lvbnNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMocnVudGltZVJvbGUsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBFQ1IgYXV0aCB0b2tlbiwgQ2xvdWRXYXRjaCBMb2dzLCBCZWRyb2NrIG1vZGVsIGludm9jYXRpb24sIGFuZCBBZ2VudENvcmUgbWVtb3J5IGFjY2VzcycsXG4gICAgICB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtTDEnLFxuICAgICAgICByZWFzb246ICdQeXRob24gMy4xNCBpcyB0aGUgbGF0ZXN0IExhbWJkYSBydW50aW1lIHZlcnNpb24gYXZhaWxhYmxlJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTQnLFxuICAgICAgICByZWFzb246ICdBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgbWFuYWdlZCBwb2xpY3kgaXMgQVdTIGJlc3QgcHJhY3RpY2UgZm9yIExhbWJkYSBmdW5jdGlvbnMnLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBjdXN0b20gcmVzb3VyY2UgTGFtYmRhIGZ1bmN0aW9ucycsXG4gICAgICB9LFxuICAgIF0pO1xuICB9XG59XG4iXX0=