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
            roleName: `${this.stackName}-RuntimeRole`,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYWdlbnQtcnVudGltZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImFnZW50LXJ1bnRpbWUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLGdGQUFrRTtBQUNsRSx5REFBMkM7QUFHM0MscUNBQTBDO0FBZ0IxQyxNQUFhLGlCQUFrQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBTTlDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNkI7UUFDckUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsNkVBQTZFO1FBQzdFLE1BQU0sZUFBZSxHQUFHLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQztRQUVoRCw2RUFBNkU7UUFDN0UseUVBQXlFO1FBQ3pFLHlFQUF5RTtRQUN6RSwyRUFBMkU7UUFDM0UsTUFBTSx3QkFBd0IsR0FBRyxDQUFDLElBQUksRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLFFBQVEsQ0FBQyxDQUFDO1FBQ2hFLE1BQU0sWUFBWSxHQUFHLGVBQWUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbkQsTUFBTSxtQkFBbUIsR0FBRyx3QkFBd0IsQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDO1lBQ3pFLENBQUMsQ0FBQyxlQUFlLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO1lBQ3BELENBQUMsQ0FBQyxlQUFlLENBQUM7UUFFcEIsMkNBQTJDO1FBQzNDLFlBQVk7UUFDWiwyQ0FBMkM7UUFFM0Msb0JBQW9CO1FBQ3BCLE1BQU0sV0FBVyxHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ3BELFFBQVEsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGNBQWM7WUFDekMsU0FB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U0FBUyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUN4QyxLQUFLLEVBQUUsS0FBSyxDQUFDLGNBQWM7WUFDM0IsV0FBVyxFQUFFLDBCQUEwQjtTQUN4QyxDQUFDLENBQUM7UUFFSCwyQ0FBMkM7UUFDM0MsdUJBQXVCO1FBQ3ZCLDJDQUEyQztRQUUzQyx5QkFBZSxDQUFDLHVCQUF1QixDQUFDLFdBQVcsRUFBRTtZQUNuRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsMEhBQTBIO2FBQ25JO1NBQ0YsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUVULHlCQUFlLENBQUMsb0JBQW9CLENBQUMsSUFBSSxFQUFFO1lBQ3pDO2dCQUNFLEVBQUUsRUFBRSxpQkFBaUI7Z0JBQ3JCLE1BQU0sRUFBRSw0REFBNEQ7YUFDckU7WUFDRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsc0ZBQXNGO2FBQy9GO1lBQ0Q7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLG9FQUFvRTthQUM3RTtTQUNGLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQTNNRCw4Q0EyTUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgYWdlbnRjb3JlIGZyb20gJ0Bhd3MtY2RrL2F3cy1iZWRyb2NrLWFnZW50Y29yZS1hbHBoYSc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFnZW50UnVudGltZVN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIHJlcG9zaXRvcnk6IGVjci5JUmVwb3NpdG9yeTtcbiAgdXNlclBvb2xBcm46IHN0cmluZztcbiAgZ2F0ZXdheUFybjogc3RyaW5nOyAvLyBHYXRld2F5IEFSTiBmcm9tIEFnZW50Q29yZUdhdGV3YXlTdGFja1xuICAvLyBCZWRyb2NrIG1vZGVsIGlkIHRoZSBhZ2VudCBydW5zIG9uIChCZWRyb2NrIG1vZGVsIGlkIG9yIGNyb3NzLXJlZ2lvblxuICAvLyBpbmZlcmVuY2UgcHJvZmlsZSBpZCkuIENvbmZpZ3VyYWJsZSBhdCBkZXBsb3kgdGltZSB2aWEgQkVEUk9DS19NT0RFTF9JRCAvXG4gIC8vIGAtYyBtb2RlbElkPS4uLmA7IHNlZSBiaW4vYXBwLnRzLlxuICBmb3VuZGF0aW9uTW9kZWxJZDogc3RyaW5nO1xuICAvLyBGb3IgZnJvbnRlbmQgY29uZmlndXJhdGlvbiBvdXRwdXRzXG4gIHVzZXJQb29sSWQ6IHN0cmluZztcbiAgdXNlclBvb2xDbGllbnRJZDogc3RyaW5nO1xuICBpZGVudGl0eVBvb2xJZDogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgQWdlbnRSdW50aW1lU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgbWFpblJ1bnRpbWVBcm46IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IG1lbW9yeUlkOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBtYWluUnVudGltZVJvbGU6IGlhbS5JUm9sZTtcbiAgcHVibGljIHJlYWRvbmx5IG1haW5SdW50aW1lUm9sZUFybjogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBZ2VudFJ1bnRpbWVTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyBNb2RlbCBpZCBpcyBzdXBwbGllZCBieSB0aGUgYXBwIChlbnYgdmFyIC8gY29udGV4dCkg4oCUIG5vIGxvbmdlciBoYXJkY29kZWQuXG4gICAgY29uc3QgZm91bmRhdGlvbk1vZGVsID0gcHJvcHMuZm91bmRhdGlvbk1vZGVsSWQ7XG5cbiAgICAvLyBBIGNyb3NzLXJlZ2lvbiBpbmZlcmVuY2UgcHJvZmlsZSBpZCAoZS5nLiBcInVzLmFudGhyb3BpYy5jbGF1ZGUtLi4uXCIpIHdyYXBzXG4gICAgLy8gYW4gdW5kZXJseWluZyBmb3VuZGF0aW9uIG1vZGVsIChcImFudGhyb3BpYy5jbGF1ZGUtLi4uXCIpLiBCb3RoIEFSTnMgYXJlXG4gICAgLy8gbmVlZGVkIGluIHRoZSBJQU0gcG9saWN5OiB0aGUgaW5mZXJlbmNlLXByb2ZpbGUgQVJOIGFuZCB0aGUgdW5kZXJseWluZ1xuICAgIC8vIGZvdW5kYXRpb24tbW9kZWwgQVJOLiBTdHJpcCBhIGtub3duIGdlbyBwcmVmaXggdG8gZGVyaXZlIHRoZSBiYXNlIG1vZGVsLlxuICAgIGNvbnN0IGluZmVyZW5jZVByb2ZpbGVQcmVmaXhlcyA9IFsndXMnLCAnZXUnLCAnYXBhYycsICd1cy1nb3YnXTtcbiAgICBjb25zdCBmaXJzdFNlZ21lbnQgPSBmb3VuZGF0aW9uTW9kZWwuc3BsaXQoJy4nKVswXTtcbiAgICBjb25zdCBiYXNlRm91bmRhdGlvbk1vZGVsID0gaW5mZXJlbmNlUHJvZmlsZVByZWZpeGVzLmluY2x1ZGVzKGZpcnN0U2VnbWVudClcbiAgICAgID8gZm91bmRhdGlvbk1vZGVsLnN1YnN0cmluZyhmaXJzdFNlZ21lbnQubGVuZ3RoICsgMSlcbiAgICAgIDogZm91bmRhdGlvbk1vZGVsO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIElBTSBSb2xlc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIE1haW4gUnVudGltZSBSb2xlXG4gICAgY29uc3QgcnVudGltZVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1J1bnRpbWVSb2xlJywge1xuICAgICAgcm9sZU5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1SdW50aW1lUm9sZWAsXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnYmVkcm9jay1hZ2VudGNvcmUuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuXG4gICAgLy8gRUNSIHRva2VuIGFjY2Vzc1xuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIHNpZDogJ0VDUlRva2VuQWNjZXNzJyxcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbiddLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICAvLyBDbG91ZFdhdGNoIExvZ3NcbiAgICBydW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2xvZ3M6RGVzY3JpYmVMb2dHcm91cHMnXSxcbiAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOmxvZ3M6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmxvZy1ncm91cDoqYF0sXG4gICAgfSkpO1xuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnbG9nczpEZXNjcmliZUxvZ1N0cmVhbXMnLCAnbG9nczpDcmVhdGVMb2dHcm91cCddLFxuICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOi9hd3MvYmVkcm9jay1hZ2VudGNvcmUvcnVudGltZXMvKmBdLFxuICAgIH0pKTtcbiAgICBydW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2xvZ3M6Q3JlYXRlTG9nU3RyZWFtJywgJ2xvZ3M6UHV0TG9nRXZlbnRzJ10sXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpsb2dzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpsb2ctZ3JvdXA6L2F3cy9iZWRyb2NrLWFnZW50Y29yZS9ydW50aW1lcy8qOmxvZy1zdHJlYW06KmBdLFxuICAgIH0pKTtcblxuICAgIC8vIEFkZCBCZWRyb2NrIG1vZGVsIHBlcm1pc3Npb25zIHRvIE1haW4gUnVudGltZVxuICAgIHJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2s6SW52b2tlTW9kZWwnLFxuICAgICAgICAnYmVkcm9jazpJbnZva2VNb2RlbFdpdGhSZXNwb25zZVN0cmVhbScsXG4gICAgICAgICdiZWRyb2NrOkNvbnZlcnNlU3RyZWFtJyxcbiAgICAgICAgJ2JlZHJvY2s6Q29udmVyc2UnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogQXJyYXkuZnJvbShuZXcgU2V0KFtcbiAgICAgICAgYGFybjphd3M6YmVkcm9jazoqOjpmb3VuZGF0aW9uLW1vZGVsLyR7Zm91bmRhdGlvbk1vZGVsfWAsXG4gICAgICAgIGBhcm46YXdzOmJlZHJvY2s6Kjo6Zm91bmRhdGlvbi1tb2RlbC8ke2Jhc2VGb3VuZGF0aW9uTW9kZWx9YCxcbiAgICAgICAgYGFybjphd3M6YmVkcm9jazoqOiR7dGhpcy5hY2NvdW50fTppbmZlcmVuY2UtcHJvZmlsZS8ke2ZvdW5kYXRpb25Nb2RlbH1gLFxuICAgICAgICAvLyBDcm9zcy1yZWdpb24gaW5mZXJlbmNlIHByb2ZpbGVzIGZhbiBvdXQgdG8gcGVyLXJlZ2lvbiBmb3VuZGF0aW9uXG4gICAgICAgIC8vIG1vZGVscywgc28gYWxsb3cgdGhlIHVuZGVybHlpbmcgbW9kZWwgaW4gYW55IHJlZ2lvbiB0b28uXG4gICAgICAgIGBhcm46YXdzOmJlZHJvY2s6Kjoke3RoaXMuYWNjb3VudH06aW5mZXJlbmNlLXByb2ZpbGUvJHtiYXNlRm91bmRhdGlvbk1vZGVsfWAsXG4gICAgICBdKSksXG4gICAgfSkpO1xuXG4gICAgLy8gQWRkIE1lbW9yeSBwZXJtaXNzaW9ucyB0byBNYWluIFJ1bnRpbWVcbiAgICBydW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpDcmVhdGVFdmVudCcsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRMYXN0S1R1cm5zJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldE1lbW9yeScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpMaXN0RXZlbnRzJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgYGFybjphd3M6YmVkcm9jay1hZ2VudGNvcmU6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9Om1lbW9yeS8qYCxcbiAgICAgIF0sXG4gICAgfSkpO1xuXG4gICAgLy8gQWRkIEdhdGV3YXkgaW52b2NhdGlvbiBwZXJtaXNzaW9ucyB0byBNYWluIFJ1bnRpbWVcbiAgICBydW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpJbnZva2VHYXRld2F5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldEdhdGV3YXknLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdEdhdGV3YXlUYXJnZXRzJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgcHJvcHMuZ2F0ZXdheUFybixcbiAgICAgICAgYCR7cHJvcHMuZ2F0ZXdheUFybn0vKmAsIC8vIEZvciBnYXRld2F5IHRhcmdldHNcbiAgICAgIF0sXG4gICAgfSkpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE1lbW9yeVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IG1lbW9yeSA9IG5ldyBhZ2VudGNvcmUuTWVtb3J5KHRoaXMsICdDbG91ZE9wc01lbW9yeScsIHtcbiAgICAgIG1lbW9yeU5hbWU6ICdjbG91ZG9wc19tZW1vcnknLFxuICAgICAgZGVzY3JpcHRpb246ICdNZW1vcnkgZm9yIENsb3VkT3BzIGFnZW50IGNvbnZlcnNhdGlvbnMnLFxuICAgICAgZXhwaXJhdGlvbkR1cmF0aW9uOiBjZGsuRHVyYXRpb24uZGF5cygzMCksXG4gICAgfSk7XG5cbiAgICB0aGlzLm1lbW9yeUlkID0gbWVtb3J5Lm1lbW9yeUlkO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE1haW4gQWdlbnQgUnVudGltZVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IHJ1bnRpbWUgPSBuZXcgYWdlbnRjb3JlLlJ1bnRpbWUodGhpcywgJ0Nsb3VkT3BzUnVudGltZScsIHtcbiAgICAgIHJ1bnRpbWVOYW1lOiAnY2xvdWRvcHNfcnVudGltZScsXG4gICAgICBkZXNjcmlwdGlvbjogJ0Nsb3VkT3BzIEFnZW50IFJ1bnRpbWUgd2l0aCBHYXRld2F5IGludGVncmF0aW9uJyxcbiAgICAgIGV4ZWN1dGlvblJvbGU6IHJ1bnRpbWVSb2xlLFxuICAgICAgYWdlbnRSdW50aW1lQXJ0aWZhY3Q6IGFnZW50Y29yZS5BZ2VudFJ1bnRpbWVBcnRpZmFjdC5mcm9tRWNyUmVwb3NpdG9yeShcbiAgICAgICAgcHJvcHMucmVwb3NpdG9yeSxcbiAgICAgICAgJ2xhdGVzdCdcbiAgICAgICksXG4gICAgICBuZXR3b3JrQ29uZmlndXJhdGlvbjogYWdlbnRjb3JlLlJ1bnRpbWVOZXR3b3JrQ29uZmlndXJhdGlvbi51c2luZ1B1YmxpY05ldHdvcmsoKSxcbiAgICAgIGVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICAgIE1FTU9SWV9JRDogbWVtb3J5Lm1lbW9yeUlkLFxuICAgICAgICBNT0RFTF9JRDogZm91bmRhdGlvbk1vZGVsLFxuICAgICAgICBBV1NfUkVHSU9OOiB0aGlzLnJlZ2lvbixcbiAgICAgICAgR0FURVdBWV9BUk46IHByb3BzLmdhdGV3YXlBcm4sXG4gICAgICAgIERFUExPWU1FTlRfVElNRVNUQU1QOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIEZPUkNFX1JFQlVJTEQ6IGAke0RhdGUubm93KCl9YCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBHcmFudCBFQ1IgcHVsbCBwZXJtaXNzaW9ucyAoZnJvbUVjclJlcG9zaXRvcnkgZG9lc24ndCBhdXRvLWdyYW50KVxuICAgIHByb3BzLnJlcG9zaXRvcnkuZ3JhbnRQdWxsKHJ1bnRpbWVSb2xlKTtcblxuICAgIHRoaXMubWFpblJ1bnRpbWVBcm4gPSBydW50aW1lLmFnZW50UnVudGltZUFybjtcbiAgICB0aGlzLm1haW5SdW50aW1lUm9sZSA9IHJ1bnRpbWVSb2xlO1xuICAgIHRoaXMubWFpblJ1bnRpbWVSb2xlQXJuID0gcnVudGltZVJvbGUucm9sZUFybjtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPdXRwdXRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FnZW50Q29yZUFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLm1haW5SdW50aW1lQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBZ2VudENvcmUgUnVudGltZSBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUFnZW50Q29yZUFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTWVtb3J5SWQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5tZW1vcnlJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnTWVtb3J5IElEJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1NZW1vcnlJZGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVXNlclBvb2xJZCcsIHtcbiAgICAgIHZhbHVlOiBwcm9wcy51c2VyUG9vbElkLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIFVzZXIgUG9vbCBJRCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVXNlclBvb2xDbGllbnRJZCcsIHtcbiAgICAgIHZhbHVlOiBwcm9wcy51c2VyUG9vbENsaWVudElkLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIFVzZXIgUG9vbCBDbGllbnQgSUQnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0lkZW50aXR5UG9vbElkJywge1xuICAgICAgdmFsdWU6IHByb3BzLmlkZW50aXR5UG9vbElkLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIElkZW50aXR5IFBvb2wgSUQnLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENESy1OYWcgU3VwcHJlc3Npb25zXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKHJ1bnRpbWVSb2xlLCBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICByZWFzb246ICdXaWxkY2FyZCBwZXJtaXNzaW9ucyByZXF1aXJlZCBmb3IgRUNSIGF1dGggdG9rZW4sIENsb3VkV2F0Y2ggTG9ncywgQmVkcm9jayBtb2RlbCBpbnZvY2F0aW9uLCBhbmQgQWdlbnRDb3JlIG1lbW9yeSBhY2Nlc3MnLFxuICAgICAgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRTdGFja1N1cHByZXNzaW9ucyh0aGlzLCBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUwxJyxcbiAgICAgICAgcmVhc29uOiAnUHl0aG9uIDMuMTQgaXMgdGhlIGxhdGVzdCBMYW1iZGEgcnVudGltZSB2ZXJzaW9uIGF2YWlsYWJsZScsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JyxcbiAgICAgICAgcmVhc29uOiAnQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIG1hbmFnZWQgcG9saWN5IGlzIEFXUyBiZXN0IHByYWN0aWNlIGZvciBMYW1iZGEgZnVuY3Rpb25zJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICByZWFzb246ICdXaWxkY2FyZCBwZXJtaXNzaW9ucyByZXF1aXJlZCBmb3IgY3VzdG9tIHJlc291cmNlIExhbWJkYSBmdW5jdGlvbnMnLFxuICAgICAgfSxcbiAgICBdKTtcbiAgfVxufVxuIl19