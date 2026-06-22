import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';

export interface ConversationHistoryStackProps extends cdk.StackProps {
  userPoolArn: string;
  userPoolId: string;
  // The remaining values the FrontEnd `appConfig` needs, passed in so this
  // (last-deployed) stack can emit a single consolidated FrontEnd config output
  // alongside the Conversation API URL it owns.
  userPoolClientId: string;
  identityPoolId: string;
  agentRuntimeArn: string;
}

export class ConversationHistoryStack extends cdk.Stack {
  public readonly conversationHandler: lambda.Function;
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ConversationHistoryStackProps) {
    super(scope, id, props);

    // ========================================
    // DynamoDB Table — Conversations
    // ========================================
    const conversationsTable = new dynamodb.Table(this, 'CloudOpsConversationsTable', {
      tableName: `${this.stackName}-conversations`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // Continuous backups (clears AwsSolutions-DDB3 and protects conversation
      // data against accidental loss; restorable to any second in the last 35 days).
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // ========================================
    // Lambda Function — Conversation Handler
    // ========================================
    this.conversationHandler = new lambda.Function(this, 'ConversationHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/conversations')),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      description: 'Handles CRUD operations for conversation history',
      environment: {
        TABLE_NAME: conversationsTable.tableName,
      },
    });

    // Grant Lambda read/write access to the DynamoDB table
    conversationsTable.grantReadWriteData(this.conversationHandler);

    // ========================================
    // Cognito User Pool (existing) — Lookup
    // ========================================
    const userPool = cognito.UserPool.fromUserPoolArn(this, 'UserPool', props.userPoolArn);

    // ========================================
    // API Gateway REST API — Conversation API
    // ========================================
    this.api = new apigateway.RestApi(this, 'ConversationApi', {
      restApiName: 'ConversationApi',
      description: 'REST API for conversation history CRUD operations',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        stageName: 'prod',
      },
    });

    // ========================================
    // Cognito Authorizer
    // ========================================
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'ConversationAuthorizer', {
      cognitoUserPools: [userPool],
    });

    // Lambda integration for API methods
    const lambdaIntegration = new apigateway.LambdaIntegration(this.conversationHandler);

    // ========================================
    // API Resources and Methods
    // ========================================

    // /conversations resource
    const conversationsResource = this.api.root.addResource('conversations');
    conversationsResource.addMethod('GET', lambdaIntegration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    conversationsResource.addMethod('POST', lambdaIntegration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // /conversations/{conversationId} resource
    const conversationByIdResource = conversationsResource.addResource('{conversationId}');
    conversationByIdResource.addMethod('GET', lambdaIntegration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    conversationByIdResource.addMethod('PUT', lambdaIntegration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    conversationByIdResource.addMethod('DELETE', lambdaIntegration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, 'ConversationApiUrl', {
      value: this.api.url,
      description: 'Conversation API endpoint URL',
      exportName: `${this.stackName}-ConversationApiUrl`,
    });

    // Echo the other FrontEnd-relevant values here too, so an admin can read
    // EVERYTHING the FrontEnd needs from this one (last-deployed) stack's
    // outputs instead of hunting across AuthStack + AgentRuntimeStack.
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: props.userPoolId,
      description: 'Cognito User Pool ID (FrontEnd appConfig: cognito.userPoolId)',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: props.userPoolClientId,
      description: 'Cognito User Pool Client ID (FrontEnd appConfig: cognito.userPoolClientId)',
    });
    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: props.identityPoolId,
      description: 'Cognito Identity Pool ID (FrontEnd appConfig: cognito.identityPoolId)',
    });
    new cdk.CfnOutput(this, 'AgentCoreArn', {
      value: props.agentRuntimeArn,
      description: 'AgentCore Runtime ARN (FrontEnd appConfig: agentcore.agentArn)',
    });

    // Single copy-paste-ready FrontEnd configuration. This is the exact JSON
    // shape the SPA reads from localStorage("appConfig"), assembled from every
    // stack so the admin can configure the FrontEnd in one step. Tokens
    // (User Pool ID, client ID, identity pool, agent ARN, API URL) are resolved
    // by CloudFormation at deploy time.
    const frontEndConfig = {
      cognito: {
        userPoolId: props.userPoolId,
        userPoolClientId: props.userPoolClientId,
        identityPoolId: props.identityPoolId,
        region: this.region,
      },
      agentcore: {
        enabled: true,
        region: this.region,
        agentArn: props.agentRuntimeArn,
      },
      conversationApi: {
        endpoint: this.api.url,
      },
    };
    new cdk.CfnOutput(this, 'FrontEndConfig', {
      value: JSON.stringify(frontEndConfig),
      description: 'Copy-paste this JSON into the FrontEnd localStorage key "appConfig"',
    });

    // ========================================
    // CDK-Nag Suppressions
    // ========================================
    NagSuppressions.addResourceSuppressions(this.conversationHandler, [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is AWS best practice.' },
      { id: 'AwsSolutions-IAM5', reason: 'DynamoDB read/write permissions use wildcards for index operations.' },
    ], true);

    NagSuppressions.addResourceSuppressions(this.api, [
      { id: 'AwsSolutions-APIG2', reason: 'Request validation handled by Lambda handler logic.' },
      { id: 'AwsSolutions-APIG4', reason: 'All methods use Cognito authorizer except OPTIONS (CORS preflight).' },
      { id: 'AwsSolutions-COG4', reason: 'OPTIONS methods do not require Cognito auth for CORS preflight.' },
      { id: 'AwsSolutions-APIG1', reason: 'Access logging not enabled for dev/demo deployment.' },
      { id: 'AwsSolutions-APIG3', reason: 'WAF not associated for dev/demo deployment.' },
      { id: 'AwsSolutions-APIG6', reason: 'CloudWatch logging not enabled for dev/demo deployment.' },
      { id: 'AwsSolutions-IAM4', reason: 'API Gateway CloudWatch role uses AWS managed policy.' },
    ], true);

    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-L1', reason: 'Python 3.12 runtime is intentionally pinned for stability.' },
    ]);
  }
}
