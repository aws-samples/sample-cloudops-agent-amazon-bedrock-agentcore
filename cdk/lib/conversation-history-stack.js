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
exports.ConversationHistoryStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const apigateway = __importStar(require("aws-cdk-lib/aws-apigateway"));
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
const path = __importStar(require("path"));
const cdk_nag_1 = require("cdk-nag");
class ConversationHistoryStack extends cdk.Stack {
    constructor(scope, id, props) {
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
        cdk_nag_1.NagSuppressions.addResourceSuppressions(this.conversationHandler, [
            { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is AWS best practice.' },
            { id: 'AwsSolutions-IAM5', reason: 'DynamoDB read/write permissions use wildcards for index operations.' },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(this.api, [
            { id: 'AwsSolutions-APIG2', reason: 'Request validation handled by Lambda handler logic.' },
            { id: 'AwsSolutions-APIG4', reason: 'All methods use Cognito authorizer except OPTIONS (CORS preflight).' },
            { id: 'AwsSolutions-COG4', reason: 'OPTIONS methods do not require Cognito auth for CORS preflight.' },
            { id: 'AwsSolutions-APIG1', reason: 'Access logging not enabled for dev/demo deployment.' },
            { id: 'AwsSolutions-APIG3', reason: 'WAF not associated for dev/demo deployment.' },
            { id: 'AwsSolutions-APIG6', reason: 'CloudWatch logging not enabled for dev/demo deployment.' },
            { id: 'AwsSolutions-IAM4', reason: 'API Gateway CloudWatch role uses AWS managed policy.' },
        ], true);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            { id: 'AwsSolutions-L1', reason: 'Python 3.12 runtime is intentionally pinned for stability.' },
        ]);
    }
}
exports.ConversationHistoryStack = ConversationHistoryStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udmVyc2F0aW9uLWhpc3Rvcnktc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjb252ZXJzYXRpb24taGlzdG9yeS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsbUVBQXFEO0FBQ3JELCtEQUFpRDtBQUNqRCx1RUFBeUQ7QUFDekQsaUVBQW1EO0FBRW5ELDJDQUE2QjtBQUM3QixxQ0FBMEM7QUFhMUMsTUFBYSx3QkFBeUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQUlyRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQW9DO1FBQzVFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDJDQUEyQztRQUMzQyxpQ0FBaUM7UUFDakMsMkNBQTJDO1FBQzNDLE1BQU0sa0JBQWtCLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSw0QkFBNEIsRUFBRTtZQUNoRixTQUFTLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxnQkFBZ0I7WUFDNUMsWUFBWSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNLEVBQUU7WUFDckUsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLGdCQUFnQixFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtZQUN4RSxXQUFXLEVBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQyxlQUFlO1lBQ2pELGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87WUFDeEMseUVBQXlFO1lBQ3pFLCtFQUErRTtZQUMvRSxnQ0FBZ0MsRUFBRSxFQUFFLDBCQUEwQixFQUFFLElBQUksRUFBRTtTQUN2RSxDQUFDLENBQUM7UUFFSCwyQ0FBMkM7UUFDM0MseUNBQXlDO1FB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QUFDLElBQUksQ0FBQyxHQUFHLEVBQUU7WUFDaEQsRUFBRSxFQUFFLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSxFQUFFLHFEQUFxRCxFQUFFO1lBQzNGLEVBQUUsRUFBRSxFQUFFLG9CQUFvQixFQUFFLE1BQU0sRUFBRSxxRUFBcUUsRUFBRTtZQUMzRyxFQUFFLEVBQUUsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLEVBQUUsaUVBQWlFLEVBQUU7WUFDdEcsRUFBRSxFQUFFLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSxFQUFFLHFEQUFxRCxFQUFFO1lBQzNGLEVBQUUsRUFBRSxFQUFFLG9CQUFvQixFQUFFLE1BQU0sRUFBRSw2Q0FBNkMsRUFBRTtZQUNuRixFQUFFLEVBQUUsRUFBRSxvQkFBb0IsRUFBRSxNQUFNLEVBQUUseURBQXlELEVBQUU7WUFDL0YsRUFBRSxFQUFFLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxFQUFFLHNEQUFzRCxFQUFFO1NBQzVGLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFFVCx5QkFBZSxDQUFDLG9CQUFvQixDQUFDLElBQUksRUFBRTtZQUN6QyxFQUFFLEVBQUUsRUFBRSxpQkFBaUIsRUFBRSxNQUFNLEVBQUUsNERBQTRELEVBQUU7U0FDaEcsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBakxELDREQWlMQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGInO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgYXBpZ2F0ZXdheSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheSc7XG5pbXBvcnQgKiBhcyBjb2duaXRvIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jb2duaXRvJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xuXG5leHBvcnQgaW50ZXJmYWNlIENvbnZlcnNhdGlvbkhpc3RvcnlTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICB1c2VyUG9vbEFybjogc3RyaW5nO1xuICB1c2VyUG9vbElkOiBzdHJpbmc7XG4gIC8vIFRoZSByZW1haW5pbmcgdmFsdWVzIHRoZSBGcm9udEVuZCBgYXBwQ29uZmlnYCBuZWVkcywgcGFzc2VkIGluIHNvIHRoaXNcbiAgLy8gKGxhc3QtZGVwbG95ZWQpIHN0YWNrIGNhbiBlbWl0IGEgc2luZ2xlIGNvbnNvbGlkYXRlZCBGcm9udEVuZCBjb25maWcgb3V0cHV0XG4gIC8vIGFsb25nc2lkZSB0aGUgQ29udmVyc2F0aW9uIEFQSSBVUkwgaXQgb3ducy5cbiAgdXNlclBvb2xDbGllbnRJZDogc3RyaW5nO1xuICBpZGVudGl0eVBvb2xJZDogc3RyaW5nO1xuICBhZ2VudFJ1bnRpbWVBcm46IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIENvbnZlcnNhdGlvbkhpc3RvcnlTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBjb252ZXJzYXRpb25IYW5kbGVyOiBsYW1iZGEuRnVuY3Rpb247XG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWdhdGV3YXkuUmVzdEFwaTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQ29udmVyc2F0aW9uSGlzdG9yeVN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEeW5hbW9EQiBUYWJsZSDigJQgQ29udmVyc2F0aW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBjb252ZXJzYXRpb25zVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ0Nsb3VkT3BzQ29udmVyc2F0aW9uc1RhYmxlJywge1xuICAgICAgdGFibGVOYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tY29udmVyc2F0aW9uc2AsXG4gICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogJ3VzZXJJZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6ICdjb252ZXJzYXRpb25JZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIC8vIENvbnRpbnVvdXMgYmFja3VwcyAoY2xlYXJzIEF3c1NvbHV0aW9ucy1EREIzIGFuZCBwcm90ZWN0cyBjb252ZXJzYXRpb25cbiAgICAgIC8vIGRhdGEgYWdhaW5zdCBhY2NpZGVudGFsIGxvc3M7IHJlc3RvcmFibGUgdG8gYW55IHNlY29uZCBpbiB0aGUgbGFzdCAzNSBkYXlzKS5cbiAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7IHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlIH0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhIEZ1bmN0aW9uIOKAlCBDb252ZXJzYXRpb24gSGFuZGxlclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLmNvbnZlcnNhdGlvbkhhbmRsZXIgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdDb252ZXJzYXRpb25IYW5kbGVyJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTIsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlci5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2NvbnZlcnNhdGlvbnMnKSksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBkZXNjcmlwdGlvbjogJ0hhbmRsZXMgQ1JVRCBvcGVyYXRpb25zIGZvciBjb252ZXJzYXRpb24gaGlzdG9yeScsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBUQUJMRV9OQU1FOiBjb252ZXJzYXRpb25zVGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IExhbWJkYSByZWFkL3dyaXRlIGFjY2VzcyB0byB0aGUgRHluYW1vREIgdGFibGVcbiAgICBjb252ZXJzYXRpb25zVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHRoaXMuY29udmVyc2F0aW9uSGFuZGxlcik7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ29nbml0byBVc2VyIFBvb2wgKGV4aXN0aW5nKSDigJQgTG9va3VwXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IHVzZXJQb29sID0gY29nbml0by5Vc2VyUG9vbC5mcm9tVXNlclBvb2xBcm4odGhpcywgJ1VzZXJQb29sJywgcHJvcHMudXNlclBvb2xBcm4pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFQSSBHYXRld2F5IFJFU1QgQVBJIOKAlCBDb252ZXJzYXRpb24gQVBJXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWdhdGV3YXkuUmVzdEFwaSh0aGlzLCAnQ29udmVyc2F0aW9uQXBpJywge1xuICAgICAgcmVzdEFwaU5hbWU6ICdDb252ZXJzYXRpb25BcGknLFxuICAgICAgZGVzY3JpcHRpb246ICdSRVNUIEFQSSBmb3IgY29udmVyc2F0aW9uIGhpc3RvcnkgQ1JVRCBvcGVyYXRpb25zJyxcbiAgICAgIGRlZmF1bHRDb3JzUHJlZmxpZ2h0T3B0aW9uczoge1xuICAgICAgICBhbGxvd09yaWdpbnM6IGFwaWdhdGV3YXkuQ29ycy5BTExfT1JJR0lOUyxcbiAgICAgICAgYWxsb3dNZXRob2RzOiBbJ0dFVCcsICdQT1NUJywgJ1BVVCcsICdERUxFVEUnLCAnT1BUSU9OUyddLFxuICAgICAgICBhbGxvd0hlYWRlcnM6IFsnQ29udGVudC1UeXBlJywgJ0F1dGhvcml6YXRpb24nXSxcbiAgICAgIH0sXG4gICAgICBkZXBsb3lPcHRpb25zOiB7XG4gICAgICAgIHN0YWdlTmFtZTogJ3Byb2QnLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDb2duaXRvIEF1dGhvcml6ZXJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYXV0aG9yaXplciA9IG5ldyBhcGlnYXRld2F5LkNvZ25pdG9Vc2VyUG9vbHNBdXRob3JpemVyKHRoaXMsICdDb252ZXJzYXRpb25BdXRob3JpemVyJywge1xuICAgICAgY29nbml0b1VzZXJQb29sczogW3VzZXJQb29sXSxcbiAgICB9KTtcblxuICAgIC8vIExhbWJkYSBpbnRlZ3JhdGlvbiBmb3IgQVBJIG1ldGhvZHNcbiAgICBjb25zdCBsYW1iZGFJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnYXRld2F5LkxhbWJkYUludGVncmF0aW9uKHRoaXMuY29udmVyc2F0aW9uSGFuZGxlcik7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQVBJIFJlc291cmNlcyBhbmQgTWV0aG9kc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIC9jb252ZXJzYXRpb25zIHJlc291cmNlXG4gICAgY29uc3QgY29udmVyc2F0aW9uc1Jlc291cmNlID0gdGhpcy5hcGkucm9vdC5hZGRSZXNvdXJjZSgnY29udmVyc2F0aW9ucycpO1xuICAgIGNvbnZlcnNhdGlvbnNSZXNvdXJjZS5hZGRNZXRob2QoJ0dFVCcsIGxhbWJkYUludGVncmF0aW9uLCB7XG4gICAgICBhdXRob3JpemVyLFxuICAgICAgYXV0aG9yaXphdGlvblR5cGU6IGFwaWdhdGV3YXkuQXV0aG9yaXphdGlvblR5cGUuQ09HTklUTyxcbiAgICB9KTtcbiAgICBjb252ZXJzYXRpb25zUmVzb3VyY2UuYWRkTWV0aG9kKCdQT1NUJywgbGFtYmRhSW50ZWdyYXRpb24sIHtcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgICBhdXRob3JpemF0aW9uVHlwZTogYXBpZ2F0ZXdheS5BdXRob3JpemF0aW9uVHlwZS5DT0dOSVRPLFxuICAgIH0pO1xuXG4gICAgLy8gL2NvbnZlcnNhdGlvbnMve2NvbnZlcnNhdGlvbklkfSByZXNvdXJjZVxuICAgIGNvbnN0IGNvbnZlcnNhdGlvbkJ5SWRSZXNvdXJjZSA9IGNvbnZlcnNhdGlvbnNSZXNvdXJjZS5hZGRSZXNvdXJjZSgne2NvbnZlcnNhdGlvbklkfScpO1xuICAgIGNvbnZlcnNhdGlvbkJ5SWRSZXNvdXJjZS5hZGRNZXRob2QoJ0dFVCcsIGxhbWJkYUludGVncmF0aW9uLCB7XG4gICAgICBhdXRob3JpemVyLFxuICAgICAgYXV0aG9yaXphdGlvblR5cGU6IGFwaWdhdGV3YXkuQXV0aG9yaXphdGlvblR5cGUuQ09HTklUTyxcbiAgICB9KTtcbiAgICBjb252ZXJzYXRpb25CeUlkUmVzb3VyY2UuYWRkTWV0aG9kKCdQVVQnLCBsYW1iZGFJbnRlZ3JhdGlvbiwge1xuICAgICAgYXV0aG9yaXplcixcbiAgICAgIGF1dGhvcml6YXRpb25UeXBlOiBhcGlnYXRld2F5LkF1dGhvcml6YXRpb25UeXBlLkNPR05JVE8sXG4gICAgfSk7XG4gICAgY29udmVyc2F0aW9uQnlJZFJlc291cmNlLmFkZE1ldGhvZCgnREVMRVRFJywgbGFtYmRhSW50ZWdyYXRpb24sIHtcbiAgICAgIGF1dGhvcml6ZXIsXG4gICAgICBhdXRob3JpemF0aW9uVHlwZTogYXBpZ2F0ZXdheS5BdXRob3JpemF0aW9uVHlwZS5DT0dOSVRPLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0NvbnZlcnNhdGlvbkFwaVVybCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmFwaS51cmwsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvbnZlcnNhdGlvbiBBUEkgZW5kcG9pbnQgVVJMJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Db252ZXJzYXRpb25BcGlVcmxgLFxuICAgIH0pO1xuXG4gICAgLy8gRWNobyB0aGUgb3RoZXIgRnJvbnRFbmQtcmVsZXZhbnQgdmFsdWVzIGhlcmUgdG9vLCBzbyBhbiBhZG1pbiBjYW4gcmVhZFxuICAgIC8vIEVWRVJZVEhJTkcgdGhlIEZyb250RW5kIG5lZWRzIGZyb20gdGhpcyBvbmUgKGxhc3QtZGVwbG95ZWQpIHN0YWNrJ3NcbiAgICAvLyBvdXRwdXRzIGluc3RlYWQgb2YgaHVudGluZyBhY3Jvc3MgQXV0aFN0YWNrICsgQWdlbnRSdW50aW1lU3RhY2suXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1VzZXJQb29sSWQnLCB7XG4gICAgICB2YWx1ZTogcHJvcHMudXNlclBvb2xJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgSUQgKEZyb250RW5kIGFwcENvbmZpZzogY29nbml0by51c2VyUG9vbElkKScsXG4gICAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1VzZXJQb29sQ2xpZW50SWQnLCB7XG4gICAgICB2YWx1ZTogcHJvcHMudXNlclBvb2xDbGllbnRJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgQ2xpZW50IElEIChGcm9udEVuZCBhcHBDb25maWc6IGNvZ25pdG8udXNlclBvb2xDbGllbnRJZCknLFxuICAgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdJZGVudGl0eVBvb2xJZCcsIHtcbiAgICAgIHZhbHVlOiBwcm9wcy5pZGVudGl0eVBvb2xJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBJZGVudGl0eSBQb29sIElEIChGcm9udEVuZCBhcHBDb25maWc6IGNvZ25pdG8uaWRlbnRpdHlQb29sSWQpJyxcbiAgICB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWdlbnRDb3JlQXJuJywge1xuICAgICAgdmFsdWU6IHByb3BzLmFnZW50UnVudGltZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQWdlbnRDb3JlIFJ1bnRpbWUgQVJOIChGcm9udEVuZCBhcHBDb25maWc6IGFnZW50Y29yZS5hZ2VudEFybiknLFxuICAgIH0pO1xuXG4gICAgLy8gU2luZ2xlIGNvcHktcGFzdGUtcmVhZHkgRnJvbnRFbmQgY29uZmlndXJhdGlvbi4gVGhpcyBpcyB0aGUgZXhhY3QgSlNPTlxuICAgIC8vIHNoYXBlIHRoZSBTUEEgcmVhZHMgZnJvbSBsb2NhbFN0b3JhZ2UoXCJhcHBDb25maWdcIiksIGFzc2VtYmxlZCBmcm9tIGV2ZXJ5XG4gICAgLy8gc3RhY2sgc28gdGhlIGFkbWluIGNhbiBjb25maWd1cmUgdGhlIEZyb250RW5kIGluIG9uZSBzdGVwLiBUb2tlbnNcbiAgICAvLyAoVXNlciBQb29sIElELCBjbGllbnQgSUQsIGlkZW50aXR5IHBvb2wsIGFnZW50IEFSTiwgQVBJIFVSTCkgYXJlIHJlc29sdmVkXG4gICAgLy8gYnkgQ2xvdWRGb3JtYXRpb24gYXQgZGVwbG95IHRpbWUuXG4gICAgY29uc3QgZnJvbnRFbmRDb25maWcgPSB7XG4gICAgICBjb2duaXRvOiB7XG4gICAgICAgIHVzZXJQb29sSWQ6IHByb3BzLnVzZXJQb29sSWQsXG4gICAgICAgIHVzZXJQb29sQ2xpZW50SWQ6IHByb3BzLnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICAgIGlkZW50aXR5UG9vbElkOiBwcm9wcy5pZGVudGl0eVBvb2xJZCxcbiAgICAgICAgcmVnaW9uOiB0aGlzLnJlZ2lvbixcbiAgICAgIH0sXG4gICAgICBhZ2VudGNvcmU6IHtcbiAgICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgcmVnaW9uOiB0aGlzLnJlZ2lvbixcbiAgICAgICAgYWdlbnRBcm46IHByb3BzLmFnZW50UnVudGltZUFybixcbiAgICAgIH0sXG4gICAgICBjb252ZXJzYXRpb25BcGk6IHtcbiAgICAgICAgZW5kcG9pbnQ6IHRoaXMuYXBpLnVybCxcbiAgICAgIH0sXG4gICAgfTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRnJvbnRFbmRDb25maWcnLCB7XG4gICAgICB2YWx1ZTogSlNPTi5zdHJpbmdpZnkoZnJvbnRFbmRDb25maWcpLFxuICAgICAgZGVzY3JpcHRpb246ICdDb3B5LXBhc3RlIHRoaXMgSlNPTiBpbnRvIHRoZSBGcm9udEVuZCBsb2NhbFN0b3JhZ2Uga2V5IFwiYXBwQ29uZmlnXCInLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENESy1OYWcgU3VwcHJlc3Npb25zXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyh0aGlzLmNvbnZlcnNhdGlvbkhhbmRsZXIsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNCcsIHJlYXNvbjogJ0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZSBpcyBBV1MgYmVzdCBwcmFjdGljZS4nIH0sXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLCByZWFzb246ICdEeW5hbW9EQiByZWFkL3dyaXRlIHBlcm1pc3Npb25zIHVzZSB3aWxkY2FyZHMgZm9yIGluZGV4IG9wZXJhdGlvbnMuJyB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKHRoaXMuYXBpLCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUFQSUcyJywgcmVhc29uOiAnUmVxdWVzdCB2YWxpZGF0aW9uIGhhbmRsZWQgYnkgTGFtYmRhIGhhbmRsZXIgbG9naWMuJyB9LFxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1BUElHNCcsIHJlYXNvbjogJ0FsbCBtZXRob2RzIHVzZSBDb2duaXRvIGF1dGhvcml6ZXIgZXhjZXB0IE9QVElPTlMgKENPUlMgcHJlZmxpZ2h0KS4nIH0sXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUNPRzQnLCByZWFzb246ICdPUFRJT05TIG1ldGhvZHMgZG8gbm90IHJlcXVpcmUgQ29nbml0byBhdXRoIGZvciBDT1JTIHByZWZsaWdodC4nIH0sXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUFQSUcxJywgcmVhc29uOiAnQWNjZXNzIGxvZ2dpbmcgbm90IGVuYWJsZWQgZm9yIGRldi9kZW1vIGRlcGxveW1lbnQuJyB9LFxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1BUElHMycsIHJlYXNvbjogJ1dBRiBub3QgYXNzb2NpYXRlZCBmb3IgZGV2L2RlbW8gZGVwbG95bWVudC4nIH0sXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUFQSUc2JywgcmVhc29uOiAnQ2xvdWRXYXRjaCBsb2dnaW5nIG5vdCBlbmFibGVkIGZvciBkZXYvZGVtbyBkZXBsb3ltZW50LicgfSxcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNCcsIHJlYXNvbjogJ0FQSSBHYXRld2F5IENsb3VkV2F0Y2ggcm9sZSB1c2VzIEFXUyBtYW5hZ2VkIHBvbGljeS4nIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkU3RhY2tTdXBwcmVzc2lvbnModGhpcywgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1MMScsIHJlYXNvbjogJ1B5dGhvbiAzLjEyIHJ1bnRpbWUgaXMgaW50ZW50aW9uYWxseSBwaW5uZWQgZm9yIHN0YWJpbGl0eS4nIH0sXG4gICAgXSk7XG4gIH1cbn1cbiJdfQ==