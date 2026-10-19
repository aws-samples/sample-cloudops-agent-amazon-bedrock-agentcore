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
        const inferenceProfilePrefixes = ["us", "eu", "apac", "us-gov"];
        const firstSegment = foundationModel.split(".")[0];
        const baseFoundationModel = inferenceProfilePrefixes.includes(firstSegment)
            ? foundationModel.substring(firstSegment.length + 1)
            : foundationModel;
        // ========================================
        // IAM Roles
        // ========================================
        // Main Runtime Role
        const runtimeRole = new iam.Role(this, "RuntimeRole", {
            assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
        });
        // ECR token access
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            sid: "ECRTokenAccess",
            effect: iam.Effect.ALLOW,
            actions: ["ecr:GetAuthorizationToken"],
            resources: ["*"],
        }));
        // CloudWatch Logs
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["logs:DescribeLogGroups"],
            resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
        }));
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["logs:DescribeLogStreams", "logs:CreateLogGroup"],
            resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
            ],
        }));
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
            resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
            ],
        }));
        // Add Bedrock model permissions to Main Runtime
        runtimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream",
                "bedrock:ConverseStream",
                "bedrock:Converse",
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
                "bedrock-agentcore:InvokeGateway",
                "bedrock-agentcore:GetGateway",
                "bedrock-agentcore:ListGatewayTargets",
            ],
            resources: [
                props.gatewayArn,
                `${props.gatewayArn}/*`, // For gateway targets
            ],
        }));
        // ========================================
        // Memory
        // ========================================
        const memory = new agentcore.Memory(this, "CloudOpsMemory", {
            memoryName: "cloudops_memory",
            description: "Memory for CloudOps agent conversations",
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
                "bedrock-agentcore:CreateEvent",
                "bedrock-agentcore:GetLastKTurns",
                "bedrock-agentcore:GetMemory",
                "bedrock-agentcore:ListEvents",
            ],
            resources: [
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/${memory.memoryId}`,
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/${memory.memoryId}/*`,
            ],
        }));
        // ========================================
        // Main Agent Runtime
        // ========================================
        const runtime = new agentcore.Runtime(this, "CloudOpsRuntime", {
            runtimeName: "cloudops_runtime",
            description: "CloudOps Agent Runtime with Gateway integration",
            executionRole: runtimeRole,
            agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(props.repository, "latest"),
            networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
            environmentVariables: {
                MEMORY_ID: memory.memoryId,
                MODEL_ID: foundationModel,
                AWS_REGION: this.region,
                GATEWAY_ARN: props.gatewayArn,
                // The application owns a filtered exporter; a second ADOT pipeline could leak payloads.
                DISABLE_ADOT_OBSERVABILITY: "true",
                AGENT_OBSERVABILITY_ENABLED: "true",
                OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
                OTEL_SEMCONV_STABILITY_OPT_IN: "gen_ai_latest_experimental,gen_ai_unredacted_attributes=",
                // Use the existing regional Transaction Search destination without changing its policy.
                UNIFIED_TRACES_DESTINATION_ENABLED: "false",
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
        new cdk.CfnOutput(this, "AgentCoreArn", {
            value: this.mainRuntimeArn,
            description: "AgentCore Runtime ARN",
            exportName: `${this.stackName}-AgentCoreArn`,
        });
        new cdk.CfnOutput(this, "MemoryId", {
            value: this.memoryId,
            description: "Memory ID",
            exportName: `${this.stackName}-MemoryId`,
        });
        new cdk.CfnOutput(this, "UserPoolId", {
            value: props.userPoolId,
            description: "Cognito User Pool ID",
        });
        new cdk.CfnOutput(this, "UserPoolClientId", {
            value: props.userPoolClientId,
            description: "Cognito User Pool Client ID",
        });
        new cdk.CfnOutput(this, "IdentityPoolId", {
            value: props.identityPoolId,
            description: "Cognito Identity Pool ID",
        });
        // ========================================
        // CDK-Nag Suppressions
        // ========================================
        cdk_nag_1.NagSuppressions.addResourceSuppressions(runtimeRole, [
            {
                id: "AwsSolutions-IAM5",
                reason: "Wildcard permissions required for ECR auth token, CloudWatch Logs, Bedrock model invocation, and AgentCore memory access",
            },
        ], true);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            {
                id: "AwsSolutions-L1",
                reason: "Python 3.14 is the latest Lambda runtime version available",
            },
            {
                id: "AwsSolutions-IAM4",
                reason: "AWSLambdaBasicExecutionRole managed policy is AWS best practice for Lambda functions",
            },
            {
                id: "AwsSolutions-IAM5",
                reason: "Wildcard permissions required for custom resource Lambda functions",
            },
        ]);
    }
}
exports.AgentRuntimeStack = AgentRuntimeStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYWdlbnQtcnVudGltZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFnZW50LXJ1bnRpbWUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLGdGQUFrRTtBQUNsRSx5REFBMkM7QUFHM0MscUNBQTBDO0FBQzFDLG1EQUFrRTtBQWdCbEUsTUFBYSxpQkFBa0IsU0FBUSxHQUFHLENBQUMsS0FBSztJQU05QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTZCO1FBQ3JFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDZFQUE2RTtRQUM3RSxNQUFNLGVBQWUsR0FBRyxLQUFLLENBQUMsaUJBQWlCLENBQUM7UUFFaEQsNkVBQTZFO1FBQzdFLHlFQUF5RTtRQUN6RSx5RUFBeUU7UUFDekUsMkVBQTJFO1FBQzNFLE1BQU0sd0JBQXdCLEdBQUcsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxRQUFRLENBQUMsQ0FBQztRQUNoRSxNQUFNLFlBQVksR0FBRyxlQUFlLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ25ELE1BQU0sbUJBQW1CLEdBQUcsd0JBQXdCLENBQUMsUUFBUSxDQUFDLFlBQVksQ0FBQztZQUN6RSxDQUFDLENBQUMsZUFBZSxDQUFDLFNBQVMsQ0FBQyxZQUFZLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQztZQUNwRCxDQUFDLENBQUMsZUFBZSxDQUFDO1FBRXBCLDJDQUEyQztRQUMzQyxZQUFZO1FBQ1osMkNBQTJDO1FBRTNDLG9CQUFvQjtRQUNwQixNQUFNLFdBQVcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtZQUNwRCxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsaUNBQWlDLENBQUM7U0FDdkUsQ0FBQyxDQUFDO1FBRUgsbUJBQW1CO1FBQ25CLFdBQVcsQ0FBQyxXQUFXLENBQ3JCLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN0QixHQUFHLEVBQUUsZ0JBQWdCO1lBQ3JCLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsT0FBTyxFQUFFLENBQUMsMkJBQTJCLENBQUM7WUFDdEMsU0FBUyxFQUFFLENBQUMsR0FBRyxDQUFDO1NBQ2pCLENBQUMsQ0FDSCxDQUFDO1FBRUYsa0JBQWtCO1FBQ2xCLFdBQVcsQ0FBQyxXQUFXLENBQ3JCLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLE9BQU8sRUFBRSxDQUFDLHdCQUF3QixDQUFDO1lBQ25DLFNBQVMsRUFBRSxDQUFDLGdCQUFnQixJQUFJLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQyxPQUFPLGNBQWMsQ0FBQztTQUN2RSxDQUFDLENBQ0gsQ0FBQztRQUNGLFdBQVcsQ0FBQyxXQUFXLENBQ3JCLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLE9BQU8sRUFBRSxDQUFDLHlCQUF5QixFQUFFLHFCQUFxQixDQUFDO1lBQzNELFNBQVMsRUFBRTtnQkFDVCxnQkFBZ0IsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsT0FBTyw4Q0FBOEM7YUFDMUY7U0FDRixDQUFDLENBQ0gsQ0FBQztRQUNGLFdBQVcsQ0FBQyxXQUFXLENBQ3JCLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLE9BQU8sRUFBRSxDQUFDLHNCQUFzQixFQUFFLG1CQUFtQixDQUFDO1lBQ3RELFNBQVMsRUFBRTtnQkFDVCxnQkFBZ0IsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsT0FBTywyREFBMkQ7YUFDdkc7U0FDRixDQUFDLENBQ0gsQ0FBQztRQUVGLGdEQUFnRDtRQUNoRCxXQUFXLENBQUMsV0FBVyxDQUNyQixJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDdEIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUU7Z0JBQ1AscUJBQXFCO2dCQUNyQix1Q0FBdUM7Z0JBQ3ZDLHdCQUF3QjtnQkFDeEIsa0JBQWtCO2FBQ25CO1lBQ0QsU0FBUyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQ25CLElBQUksR0FBRyxDQUFDO2dCQUNOLHVDQUF1QyxlQUFlLEVBQUU7Z0JBQ3hELHVDQUF1QyxtQkFBbUIsRUFBRTtnQkFDNUQscUJBQXFCLElBQUksQ0FBQyxPQUFPLHNCQUFzQixlQUFlLEVBQUU7Z0JBQ3hFLG1FQUFtRTtnQkFDbkUsMkRBQTJEO2dCQUMzRCxxQkFBcUIsSUFBSSxDQUFDLE9BQU8sc0JBQXNCLG1CQUFtQixFQUFFO2FBQzdFLENBQUMsQ0FDSDtTQUNGLENBQUMsQ0FDSCxDQUFDO1FBRUYscURBQXFEO1FBQ3JELFdBQVcsQ0FBQyxXQUFXLENBQ3JCLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLE9BQU8sRUFBRTtnQkFDUCxpQ0FBaUM7Z0JBQ2pDLDhCQUE4QjtnQkFDOUIsc0NBQXNDO2FBQ3ZDO1lBQ0QsU0FBUyxFQUFFO2dCQUNULEtBQUssQ0FBQyxVQUFVO2dCQUNoQixHQUFHLEtBQUssQ0FBQyxVQUFVLElBQUksRUFBRSxzQkFBc0I7YUFDaEQ7U0FDRixDQUFDLENBQ0gsQ0FBQztRQUVGLDJDQUEyQztRQUMzQyxTQUFTO1FBQ1QsMkNBQTJDO1FBRTNDLE1BQU0sTUFBTSxHQUFHLElBQUksU0FBUyxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7WUFDMUQsVUFBVSxFQUFFLGlCQUFpQjtZQUM3QixXQUFXLEVBQUUseUNBQXlDO1lBQ3RELGtCQUFrQixFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztTQUMxQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsUUFBUSxHQUFHLE1BQU0sQ0FBQyxRQUFRLENBQUM7UUFFaEMsd0VBQXdFO1FBQ3hFLHNFQUFzRTtRQUN0RSxxRUFBcUU7UUFDckUseURBQXlEO1FBQ3pELFdBQVcsQ0FBQyxXQUFXLENBQ3JCLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLE9BQU8sRUFBRTtnQkFDUCwrQkFBK0I7Z0JBQy9CLGlDQUFpQztnQkFDakMsNkJBQTZCO2dCQUM3Qiw4QkFBOEI7YUFDL0I7WUFDRCxTQUFTLEVBQUU7Z0JBQ1QsNkJBQTZCLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE9BQU8sV0FBVyxNQUFNLENBQUMsUUFBUSxFQUFFO2dCQUNwRiw2QkFBNkIsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsT0FBTyxXQUFXLE1BQU0sQ0FBQyxRQUFRLElBQUk7YUFDdkY7U0FDRixDQUFDLENBQ0gsQ0FBQztRQUVGLDJDQUEyQztRQUMzQyxxQkFBcUI7UUFDckIsMkNBQTJDO1FBRTNDLE1BQU0sT0FBTyxHQUFHLElBQUksU0FBUyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDN0QsV0FBVyxFQUFFLGtCQUFrQjtZQUMvQixXQUFXLEVBQUUsaURBQWlEO1lBQzlELGFBQWEsRUFBRSxXQUFXO1lBQzFCLG9CQUFvQixFQUFFLFNBQVMsQ0FBQyxvQkFBb0IsQ0FBQyxpQkFBaUIsQ0FDcEUsS0FBSyxDQUFDLFVBQVUsRUFDaEIsUUFBUSxDQUNUO1lBQ0Qsb0JBQW9CLEVBQ2xCLFNBQVMsQ0FBQywyQkFBMkIsQ0FBQyxrQkFBa0IsRUFBRTtZQUM1RCxvQkFBb0IsRUFBRTtnQkFDcEIsU0FBUyxFQUFFLE1BQU0sQ0FBQyxRQUFRO2dCQUMxQixRQUFRLEVBQUUsZUFBZTtnQkFDekIsVUFBVSxFQUFFLElBQUksQ0FBQyxNQUFNO2dCQUN2QixXQUFXLEVBQUUsS0FBSyxDQUFDLFVBQVU7Z0JBQzdCLHdGQUF3RjtnQkFDeEYsMEJBQTBCLEVBQUUsTUFBTTtnQkFDbEMsMkJBQTJCLEVBQUUsTUFBTTtnQkFDbkMsa0RBQWtELEVBQUUsT0FBTztnQkFDM0QsNkJBQTZCLEVBQzNCLDBEQUEwRDtnQkFDNUQsd0ZBQXdGO2dCQUN4RixrQ0FBa0MsRUFBRSxPQUFPO2dCQUMzQyxvQkFBb0IsRUFBRSxJQUFJLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRTtnQkFDOUMsYUFBYSxFQUFFLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxFQUFFO2FBQy9CO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsb0VBQW9FO1FBQ3BFLEtBQUssQ0FBQyxVQUFVLENBQUMsU0FBUyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBRXhDLElBQUksQ0FBQyxjQUFjLEdBQUcsT0FBTyxDQUFDLGVBQWUsQ0FBQztRQUM5QyxJQUFJLENBQUMsZUFBZSxHQUFHLFdBQVcsQ0FBQztRQUNuQyxJQUFJLENBQUMsa0JBQWtCLEdBQUcsV0FBVyxDQUFDLE9BQU8sQ0FBQztRQUU5QyxJQUFBLDBCQUFVLEVBQUMsSUFBSSxFQUFFO1lBQ2YsT0FBTyxFQUFFLE9BQU8sQ0FBQyxlQUFlO1lBQ2hDLGVBQWUsRUFBRSxJQUFBLG1DQUFtQixFQUFDLElBQUksRUFBRSxPQUFPLENBQUMsZUFBZSxDQUFDO1lBQ25FLE1BQU0sRUFBRSxNQUFNLENBQUMsU0FBUztTQUN6QixDQUFDLENBQUM7UUFFSCwyQ0FBMkM7UUFDM0MsVUFBVTtRQUNWLDJDQUEyQztRQUUzQyxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUN0QyxLQUFLLEVBQUUsSUFBSSxDQUFDLGNBQWM7WUFDMUIsV0FBVyxFQUFFLHVCQUF1QjtZQUNwQyxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxlQUFlO1NBQzdDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFO1lBQ2xDLEtBQUssRUFBRSxJQUFJLENBQUMsUUFBUTtZQUNwQixXQUFXLEVBQUUsV0FBVztZQUN4QixVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxXQUFXO1NBQ3pDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ3BDLEtBQUssRUFBRSxLQUFLLENBQUMsVUFBVTtZQUN2QixXQUFXLEVBQUUsc0JBQXNCO1NBQ3BDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDMUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxnQkFBZ0I7WUFDN0IsV0FBVyxFQUFFLDZCQUE2QjtTQUMzQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3hDLEtBQUssRUFBRSxLQUFLLENBQUMsY0FBYztZQUMzQixXQUFXLEVBQUUsMEJBQTBCO1NBQ3hDLENBQUMsQ0FBQztRQUVILDJDQUEyQztRQUMzQyx1QkFBdUI7UUFDdkIsMkNBQTJDO1FBRTNDLHlCQUFlLENBQUMsdUJBQXVCLENBQ3JDLFdBQVcsRUFDWDtZQUNFO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFDSiwwSEFBMEg7YUFDN0g7U0FDRixFQUNELElBQUksQ0FDTCxDQUFDO1FBRUYseUJBQWUsQ0FBQyxvQkFBb0IsQ0FBQyxJQUFJLEVBQUU7WUFDekM7Z0JBQ0UsRUFBRSxFQUFFLGlCQUFpQjtnQkFDckIsTUFBTSxFQUFFLDREQUE0RDthQUNyRTtZQUNEO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFDSixzRkFBc0Y7YUFDekY7WUFDRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQ0osb0VBQW9FO2FBQ3ZFO1NBQ0YsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBeFBELDhDQXdQQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFnZW50Y29yZSBmcm9tIFwiQGF3cy1jZGsvYXdzLWJlZHJvY2stYWdlbnRjb3JlLWFscGhhXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIGVjciBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWVjclwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gXCJjZGstbmFnXCI7XG5pbXBvcnQgeyBhZGRUcmFjaW5nLCB3b3JrbG9hZElkZW50aXR5QXJuIH0gZnJvbSBcIi4vb2JzZXJ2YWJpbGl0eVwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFnZW50UnVudGltZVN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIHJlcG9zaXRvcnk6IGVjci5JUmVwb3NpdG9yeTtcbiAgdXNlclBvb2xBcm46IHN0cmluZztcbiAgZ2F0ZXdheUFybjogc3RyaW5nOyAvLyBHYXRld2F5IEFSTiBmcm9tIEFnZW50Q29yZUdhdGV3YXlTdGFja1xuICAvLyBCZWRyb2NrIG1vZGVsIGlkIHRoZSBhZ2VudCBydW5zIG9uIChCZWRyb2NrIG1vZGVsIGlkIG9yIGNyb3NzLXJlZ2lvblxuICAvLyBpbmZlcmVuY2UgcHJvZmlsZSBpZCkuIENvbmZpZ3VyYWJsZSBhdCBkZXBsb3kgdGltZSB2aWEgQkVEUk9DS19NT0RFTF9JRCAvXG4gIC8vIGAtYyBtb2RlbElkPS4uLmA7IHNlZSBiaW4vYXBwLnRzLlxuICBmb3VuZGF0aW9uTW9kZWxJZDogc3RyaW5nO1xuICAvLyBGb3IgZnJvbnRlbmQgY29uZmlndXJhdGlvbiBvdXRwdXRzXG4gIHVzZXJQb29sSWQ6IHN0cmluZztcbiAgdXNlclBvb2xDbGllbnRJZDogc3RyaW5nO1xuICBpZGVudGl0eVBvb2xJZDogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgQWdlbnRSdW50aW1lU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgbWFpblJ1bnRpbWVBcm46IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IG1lbW9yeUlkOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBtYWluUnVudGltZVJvbGU6IGlhbS5JUm9sZTtcbiAgcHVibGljIHJlYWRvbmx5IG1haW5SdW50aW1lUm9sZUFybjogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBZ2VudFJ1bnRpbWVTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyBNb2RlbCBpZCBpcyBzdXBwbGllZCBieSB0aGUgYXBwIChlbnYgdmFyIC8gY29udGV4dCkg4oCUIG5vIGxvbmdlciBoYXJkY29kZWQuXG4gICAgY29uc3QgZm91bmRhdGlvbk1vZGVsID0gcHJvcHMuZm91bmRhdGlvbk1vZGVsSWQ7XG5cbiAgICAvLyBBIGNyb3NzLXJlZ2lvbiBpbmZlcmVuY2UgcHJvZmlsZSBpZCAoZS5nLiBcInVzLmFudGhyb3BpYy5jbGF1ZGUtLi4uXCIpIHdyYXBzXG4gICAgLy8gYW4gdW5kZXJseWluZyBmb3VuZGF0aW9uIG1vZGVsIChcImFudGhyb3BpYy5jbGF1ZGUtLi4uXCIpLiBCb3RoIEFSTnMgYXJlXG4gICAgLy8gbmVlZGVkIGluIHRoZSBJQU0gcG9saWN5OiB0aGUgaW5mZXJlbmNlLXByb2ZpbGUgQVJOIGFuZCB0aGUgdW5kZXJseWluZ1xuICAgIC8vIGZvdW5kYXRpb24tbW9kZWwgQVJOLiBTdHJpcCBhIGtub3duIGdlbyBwcmVmaXggdG8gZGVyaXZlIHRoZSBiYXNlIG1vZGVsLlxuICAgIGNvbnN0IGluZmVyZW5jZVByb2ZpbGVQcmVmaXhlcyA9IFtcInVzXCIsIFwiZXVcIiwgXCJhcGFjXCIsIFwidXMtZ292XCJdO1xuICAgIGNvbnN0IGZpcnN0U2VnbWVudCA9IGZvdW5kYXRpb25Nb2RlbC5zcGxpdChcIi5cIilbMF07XG4gICAgY29uc3QgYmFzZUZvdW5kYXRpb25Nb2RlbCA9IGluZmVyZW5jZVByb2ZpbGVQcmVmaXhlcy5pbmNsdWRlcyhmaXJzdFNlZ21lbnQpXG4gICAgICA/IGZvdW5kYXRpb25Nb2RlbC5zdWJzdHJpbmcoZmlyc3RTZWdtZW50Lmxlbmd0aCArIDEpXG4gICAgICA6IGZvdW5kYXRpb25Nb2RlbDtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBJQU0gUm9sZXNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBNYWluIFJ1bnRpbWUgUm9sZVxuICAgIGNvbnN0IHJ1bnRpbWVSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiUnVudGltZVJvbGVcIiwge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJiZWRyb2NrLWFnZW50Y29yZS5hbWF6b25hd3MuY29tXCIpLFxuICAgIH0pO1xuXG4gICAgLy8gRUNSIHRva2VuIGFjY2Vzc1xuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBzaWQ6IFwiRUNSVG9rZW5BY2Nlc3NcIixcbiAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbXCJlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gQ2xvdWRXYXRjaCBMb2dzXG4gICAgcnVudGltZVJvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogW1wibG9nczpEZXNjcmliZUxvZ0dyb3Vwc1wiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOipgXSxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgcnVudGltZVJvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogW1wibG9nczpEZXNjcmliZUxvZ1N0cmVhbXNcIiwgXCJsb2dzOkNyZWF0ZUxvZ0dyb3VwXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICBgYXJuOmF3czpsb2dzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpsb2ctZ3JvdXA6L2F3cy9iZWRyb2NrLWFnZW50Y29yZS9ydW50aW1lcy8qYCxcbiAgICAgICAgXSxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgcnVudGltZVJvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogW1wibG9nczpDcmVhdGVMb2dTdHJlYW1cIiwgXCJsb2dzOlB1dExvZ0V2ZW50c1wiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOi9hd3MvYmVkcm9jay1hZ2VudGNvcmUvcnVudGltZXMvKjpsb2ctc3RyZWFtOipgLFxuICAgICAgICBdLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vIEFkZCBCZWRyb2NrIG1vZGVsIHBlcm1pc3Npb25zIHRvIE1haW4gUnVudGltZVxuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcImJlZHJvY2s6SW52b2tlTW9kZWxcIixcbiAgICAgICAgICBcImJlZHJvY2s6SW52b2tlTW9kZWxXaXRoUmVzcG9uc2VTdHJlYW1cIixcbiAgICAgICAgICBcImJlZHJvY2s6Q29udmVyc2VTdHJlYW1cIixcbiAgICAgICAgICBcImJlZHJvY2s6Q29udmVyc2VcIixcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBBcnJheS5mcm9tKFxuICAgICAgICAgIG5ldyBTZXQoW1xuICAgICAgICAgICAgYGFybjphd3M6YmVkcm9jazoqOjpmb3VuZGF0aW9uLW1vZGVsLyR7Zm91bmRhdGlvbk1vZGVsfWAsXG4gICAgICAgICAgICBgYXJuOmF3czpiZWRyb2NrOio6OmZvdW5kYXRpb24tbW9kZWwvJHtiYXNlRm91bmRhdGlvbk1vZGVsfWAsXG4gICAgICAgICAgICBgYXJuOmF3czpiZWRyb2NrOio6JHt0aGlzLmFjY291bnR9OmluZmVyZW5jZS1wcm9maWxlLyR7Zm91bmRhdGlvbk1vZGVsfWAsXG4gICAgICAgICAgICAvLyBDcm9zcy1yZWdpb24gaW5mZXJlbmNlIHByb2ZpbGVzIGZhbiBvdXQgdG8gcGVyLXJlZ2lvbiBmb3VuZGF0aW9uXG4gICAgICAgICAgICAvLyBtb2RlbHMsIHNvIGFsbG93IHRoZSB1bmRlcmx5aW5nIG1vZGVsIGluIGFueSByZWdpb24gdG9vLlxuICAgICAgICAgICAgYGFybjphd3M6YmVkcm9jazoqOiR7dGhpcy5hY2NvdW50fTppbmZlcmVuY2UtcHJvZmlsZS8ke2Jhc2VGb3VuZGF0aW9uTW9kZWx9YCxcbiAgICAgICAgICBdKSxcbiAgICAgICAgKSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICAvLyBBZGQgR2F0ZXdheSBpbnZvY2F0aW9uIHBlcm1pc3Npb25zIHRvIE1haW4gUnVudGltZVxuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcImJlZHJvY2stYWdlbnRjb3JlOkludm9rZUdhdGV3YXlcIixcbiAgICAgICAgICBcImJlZHJvY2stYWdlbnRjb3JlOkdldEdhdGV3YXlcIixcbiAgICAgICAgICBcImJlZHJvY2stYWdlbnRjb3JlOkxpc3RHYXRld2F5VGFyZ2V0c1wiLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICBwcm9wcy5nYXRld2F5QXJuLFxuICAgICAgICAgIGAke3Byb3BzLmdhdGV3YXlBcm59LypgLCAvLyBGb3IgZ2F0ZXdheSB0YXJnZXRzXG4gICAgICAgIF0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE1lbW9yeVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IG1lbW9yeSA9IG5ldyBhZ2VudGNvcmUuTWVtb3J5KHRoaXMsIFwiQ2xvdWRPcHNNZW1vcnlcIiwge1xuICAgICAgbWVtb3J5TmFtZTogXCJjbG91ZG9wc19tZW1vcnlcIixcbiAgICAgIGRlc2NyaXB0aW9uOiBcIk1lbW9yeSBmb3IgQ2xvdWRPcHMgYWdlbnQgY29udmVyc2F0aW9uc1wiLFxuICAgICAgZXhwaXJhdGlvbkR1cmF0aW9uOiBjZGsuRHVyYXRpb24uZGF5cygzMCksXG4gICAgfSk7XG5cbiAgICB0aGlzLm1lbW9yeUlkID0gbWVtb3J5Lm1lbW9yeUlkO1xuXG4gICAgLy8gQWRkIE1lbW9yeSBwZXJtaXNzaW9ucyB0byBNYWluIFJ1bnRpbWUsIHNjb3BlZCB0byB0aGUgc3BlY2lmaWMgTWVtb3J5XG4gICAgLy8gcmVzb3VyY2UgY3JlYXRlZCBieSB0aGlzIHN0YWNrIChhbmQgaXRzIHN1Yi1yZXNvdXJjZXMsIGUuZy4gZXZlbnRzKVxuICAgIC8vIHJhdGhlciB0aGFuIGFsbCBtZW1vcmllcyBpbiB0aGUgYWNjb3VudC4gRGVjbGFyZWQgYWZ0ZXIgdGhlIE1lbW9yeVxuICAgIC8vIGNvbnN0cnVjdCBzbyBtZW1vcnkubWVtb3J5SWQgaXMgYXZhaWxhYmxlIGZvciB0aGUgQVJOLlxuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcImJlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZUV2ZW50XCIsXG4gICAgICAgICAgXCJiZWRyb2NrLWFnZW50Y29yZTpHZXRMYXN0S1R1cm5zXCIsXG4gICAgICAgICAgXCJiZWRyb2NrLWFnZW50Y29yZTpHZXRNZW1vcnlcIixcbiAgICAgICAgICBcImJlZHJvY2stYWdlbnRjb3JlOkxpc3RFdmVudHNcIixcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgYGFybjphd3M6YmVkcm9jay1hZ2VudGNvcmU6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9Om1lbW9yeS8ke21lbW9yeS5tZW1vcnlJZH1gLFxuICAgICAgICAgIGBhcm46YXdzOmJlZHJvY2stYWdlbnRjb3JlOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTptZW1vcnkvJHttZW1vcnkubWVtb3J5SWR9LypgLFxuICAgICAgICBdLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBNYWluIEFnZW50IFJ1bnRpbWVcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBjb25zdCBydW50aW1lID0gbmV3IGFnZW50Y29yZS5SdW50aW1lKHRoaXMsIFwiQ2xvdWRPcHNSdW50aW1lXCIsIHtcbiAgICAgIHJ1bnRpbWVOYW1lOiBcImNsb3Vkb3BzX3J1bnRpbWVcIixcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkNsb3VkT3BzIEFnZW50IFJ1bnRpbWUgd2l0aCBHYXRld2F5IGludGVncmF0aW9uXCIsXG4gICAgICBleGVjdXRpb25Sb2xlOiBydW50aW1lUm9sZSxcbiAgICAgIGFnZW50UnVudGltZUFydGlmYWN0OiBhZ2VudGNvcmUuQWdlbnRSdW50aW1lQXJ0aWZhY3QuZnJvbUVjclJlcG9zaXRvcnkoXG4gICAgICAgIHByb3BzLnJlcG9zaXRvcnksXG4gICAgICAgIFwibGF0ZXN0XCIsXG4gICAgICApLFxuICAgICAgbmV0d29ya0NvbmZpZ3VyYXRpb246XG4gICAgICAgIGFnZW50Y29yZS5SdW50aW1lTmV0d29ya0NvbmZpZ3VyYXRpb24udXNpbmdQdWJsaWNOZXR3b3JrKCksXG4gICAgICBlbnZpcm9ubWVudFZhcmlhYmxlczoge1xuICAgICAgICBNRU1PUllfSUQ6IG1lbW9yeS5tZW1vcnlJZCxcbiAgICAgICAgTU9ERUxfSUQ6IGZvdW5kYXRpb25Nb2RlbCxcbiAgICAgICAgQVdTX1JFR0lPTjogdGhpcy5yZWdpb24sXG4gICAgICAgIEdBVEVXQVlfQVJOOiBwcm9wcy5nYXRld2F5QXJuLFxuICAgICAgICAvLyBUaGUgYXBwbGljYXRpb24gb3ducyBhIGZpbHRlcmVkIGV4cG9ydGVyOyBhIHNlY29uZCBBRE9UIHBpcGVsaW5lIGNvdWxkIGxlYWsgcGF5bG9hZHMuXG4gICAgICAgIERJU0FCTEVfQURPVF9PQlNFUlZBQklMSVRZOiBcInRydWVcIixcbiAgICAgICAgQUdFTlRfT0JTRVJWQUJJTElUWV9FTkFCTEVEOiBcInRydWVcIixcbiAgICAgICAgT1RFTF9JTlNUUlVNRU5UQVRJT05fR0VOQUlfQ0FQVFVSRV9NRVNTQUdFX0NPTlRFTlQ6IFwiZmFsc2VcIixcbiAgICAgICAgT1RFTF9TRU1DT05WX1NUQUJJTElUWV9PUFRfSU46XG4gICAgICAgICAgXCJnZW5fYWlfbGF0ZXN0X2V4cGVyaW1lbnRhbCxnZW5fYWlfdW5yZWRhY3RlZF9hdHRyaWJ1dGVzPVwiLFxuICAgICAgICAvLyBVc2UgdGhlIGV4aXN0aW5nIHJlZ2lvbmFsIFRyYW5zYWN0aW9uIFNlYXJjaCBkZXN0aW5hdGlvbiB3aXRob3V0IGNoYW5naW5nIGl0cyBwb2xpY3kuXG4gICAgICAgIFVOSUZJRURfVFJBQ0VTX0RFU1RJTkFUSU9OX0VOQUJMRUQ6IFwiZmFsc2VcIixcbiAgICAgICAgREVQTE9ZTUVOVF9USU1FU1RBTVA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgRk9SQ0VfUkVCVUlMRDogYCR7RGF0ZS5ub3coKX1gLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IEVDUiBwdWxsIHBlcm1pc3Npb25zIChmcm9tRWNyUmVwb3NpdG9yeSBkb2Vzbid0IGF1dG8tZ3JhbnQpXG4gICAgcHJvcHMucmVwb3NpdG9yeS5ncmFudFB1bGwocnVudGltZVJvbGUpO1xuXG4gICAgdGhpcy5tYWluUnVudGltZUFybiA9IHJ1bnRpbWUuYWdlbnRSdW50aW1lQXJuO1xuICAgIHRoaXMubWFpblJ1bnRpbWVSb2xlID0gcnVudGltZVJvbGU7XG4gICAgdGhpcy5tYWluUnVudGltZVJvbGVBcm4gPSBydW50aW1lUm9sZS5yb2xlQXJuO1xuXG4gICAgYWRkVHJhY2luZyh0aGlzLCB7XG4gICAgICBSdW50aW1lOiBydW50aW1lLmFnZW50UnVudGltZUFybixcbiAgICAgIFJ1bnRpbWVJZGVudGl0eTogd29ya2xvYWRJZGVudGl0eUFybih0aGlzLCBydW50aW1lLmFnZW50UnVudGltZUFybiksXG4gICAgICBNZW1vcnk6IG1lbW9yeS5tZW1vcnlBcm4sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiQWdlbnRDb3JlQXJuXCIsIHtcbiAgICAgIHZhbHVlOiB0aGlzLm1haW5SdW50aW1lQXJuLFxuICAgICAgZGVzY3JpcHRpb246IFwiQWdlbnRDb3JlIFJ1bnRpbWUgQVJOXCIsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQWdlbnRDb3JlQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiTWVtb3J5SWRcIiwge1xuICAgICAgdmFsdWU6IHRoaXMubWVtb3J5SWQsXG4gICAgICBkZXNjcmlwdGlvbjogXCJNZW1vcnkgSURcIixcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1NZW1vcnlJZGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIlVzZXJQb29sSWRcIiwge1xuICAgICAgdmFsdWU6IHByb3BzLnVzZXJQb29sSWQsXG4gICAgICBkZXNjcmlwdGlvbjogXCJDb2duaXRvIFVzZXIgUG9vbCBJRFwiLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJVc2VyUG9vbENsaWVudElkXCIsIHtcbiAgICAgIHZhbHVlOiBwcm9wcy51c2VyUG9vbENsaWVudElkLFxuICAgICAgZGVzY3JpcHRpb246IFwiQ29nbml0byBVc2VyIFBvb2wgQ2xpZW50IElEXCIsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIklkZW50aXR5UG9vbElkXCIsIHtcbiAgICAgIHZhbHVlOiBwcm9wcy5pZGVudGl0eVBvb2xJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkNvZ25pdG8gSWRlbnRpdHkgUG9vbCBJRFwiLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENESy1OYWcgU3VwcHJlc3Npb25zXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKFxuICAgICAgcnVudGltZVJvbGUsXG4gICAgICBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJBd3NTb2x1dGlvbnMtSUFNNVwiLFxuICAgICAgICAgIHJlYXNvbjpcbiAgICAgICAgICAgIFwiV2lsZGNhcmQgcGVybWlzc2lvbnMgcmVxdWlyZWQgZm9yIEVDUiBhdXRoIHRva2VuLCBDbG91ZFdhdGNoIExvZ3MsIEJlZHJvY2sgbW9kZWwgaW52b2NhdGlvbiwgYW5kIEFnZW50Q29yZSBtZW1vcnkgYWNjZXNzXCIsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwiQXdzU29sdXRpb25zLUwxXCIsXG4gICAgICAgIHJlYXNvbjogXCJQeXRob24gMy4xNCBpcyB0aGUgbGF0ZXN0IExhbWJkYSBydW50aW1lIHZlcnNpb24gYXZhaWxhYmxlXCIsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogXCJBd3NTb2x1dGlvbnMtSUFNNFwiLFxuICAgICAgICByZWFzb246XG4gICAgICAgICAgXCJBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgbWFuYWdlZCBwb2xpY3kgaXMgQVdTIGJlc3QgcHJhY3RpY2UgZm9yIExhbWJkYSBmdW5jdGlvbnNcIixcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiBcIkF3c1NvbHV0aW9ucy1JQU01XCIsXG4gICAgICAgIHJlYXNvbjpcbiAgICAgICAgICBcIldpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBjdXN0b20gcmVzb3VyY2UgTGFtYmRhIGZ1bmN0aW9uc1wiLFxuICAgICAgfSxcbiAgICBdKTtcbiAgfVxufVxuIl19