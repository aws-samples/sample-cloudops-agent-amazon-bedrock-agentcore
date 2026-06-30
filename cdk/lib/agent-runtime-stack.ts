import * as cdk from 'aws-cdk-lib';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export interface AgentRuntimeStackProps extends cdk.StackProps {
  repository: ecr.IRepository;
  userPoolArn: string;
  gatewayArn: string; // Gateway ARN from AgentCoreGatewayStack
  // Bedrock model id the agent runs on (Bedrock model id or cross-region
  // inference profile id). Configurable at deploy time via BEDROCK_MODEL_ID /
  // `-c modelId=...`; see bin/app.ts.
  foundationModelId: string;
  // For frontend configuration outputs
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
}

export class AgentRuntimeStack extends cdk.Stack {
  public readonly mainRuntimeArn: string;
  public readonly memoryId: string;
  public readonly mainRuntimeRole: iam.IRole;
  public readonly mainRuntimeRoleArn: string;

  constructor(scope: Construct, id: string, props: AgentRuntimeStackProps) {
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
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(
        props.repository,
        'latest'
      ),
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

    NagSuppressions.addResourceSuppressions(runtimeRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions required for ECR auth token, CloudWatch Logs, Bedrock model invocation, and AgentCore memory access',
      },
    ], true);

    NagSuppressions.addStackSuppressions(this, [
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
