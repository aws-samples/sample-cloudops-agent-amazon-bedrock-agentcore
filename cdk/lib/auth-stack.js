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
exports.AuthStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const path = __importStar(require("path"));
const cdk_nag_1 = require("cdk-nag");
/**
 * Name of the Cognito group whose members are designated the Admin role.
 * The Pre Token Generation Lambda maps membership of this group to the scalar
 * `role` claim ("admin"); all other users resolve to "nonadmin".
 * Feature: gateway-tool-access-control (Requirement 1.1).
 */
const ADMIN_GROUP_NAME = 'Administrators';
class AuthStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        /** Name of the Cognito group whose members resolve to the Admin role. */
        this.adminGroupName = ADMIN_GROUP_NAME;
        /** Name of the scalar role claim injected into the issued tokens. */
        this.roleClaimName = 'role';
        // ========================================
        // Cognito User Pool
        // ========================================
        const userPool = new cognito.UserPool(this, 'CloudOpsUserPool', {
            userPoolName: `${this.stackName}-users`,
            selfSignUpEnabled: false,
            signInAliases: {
                email: true,
                username: true,
            },
            autoVerify: {
                email: true,
            },
            userInvitation: {
                emailSubject: 'Your CloudOps Agent Login Credentials',
                emailBody: [
                    '<h2>Welcome to CloudOps Agent</h2>',
                    '<p>Your admin account has been created. You will be prompted to change your password on first login.</p>',
                    '<br/>',
                    '<p><strong>Username</strong></p>',
                    '<p style="font-family: monospace; font-size: 16px; background: #f0f0f0; padding: 8px; display: inline-block;">{username}</p>',
                    '<br/>',
                    '<p><strong>Temporary Password</strong></p>',
                    '<p style="font-family: monospace; font-size: 16px; background: #f0f0f0; padding: 8px; display: inline-block;">{####}</p>',
                ].join('\n'),
            },
            passwordPolicy: {
                minLength: 8,
                requireLowercase: true,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: true, // Add symbol requirement for stronger security
            },
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            // The Essentials feature plan is required for the V2_0 Pre Token
            // Generation trigger, which is what enables access-token (not just
            // ID-token) claim customization. The `role` claim must reach the
            // access token because the Agent Runtime forwards it to the Gateway.
            // Feature: gateway-tool-access-control (Requirement 1.1).
            featurePlan: cognito.FeaturePlan.ESSENTIALS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        this.userPoolId = userPool.userPoolId;
        this.userPoolArn = userPool.userPoolArn;
        this.userPoolProviderName = userPool.userPoolProviderName;
        // ========================================
        // Pre Token Generation Lambda + role claim
        // ========================================
        // Injects a scalar `role` claim ("admin" | "nonadmin") into the user's
        // tokens based on `Administrators` group membership, so the AgentCore
        // Gateway's Cedar policy can authorize tool access by role. The role is
        // derived solely from verified group membership, never a client-supplied
        // value. Feature: gateway-tool-access-control (Requirement 1.1).
        const preTokenGenerationFn = new lambda.Function(this, 'PreTokenGenerationFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'handler.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/pre-token-generation')),
            memorySize: 128,
            timeout: cdk.Duration.seconds(5),
            description: 'Cognito Pre Token Generation trigger: maps Administrators group membership to a scalar role claim',
        });
        // Attach as the Pre Token Generation trigger using the V2_0 event, which is
        // what enables access-token claim customization (requires the Essentials
        // feature plan set on the User Pool above). addTrigger also grants Cognito
        // permission to invoke the function.
        userPool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, preTokenGenerationFn, cognito.LambdaVersion.V2_0);
        // ========================================
        // Cognito Group — Administrators (Admin role)
        // ========================================
        const administratorsGroup = new cognito.CfnUserPoolGroup(this, 'AdministratorsGroup', {
            userPoolId: userPool.userPoolId,
            groupName: this.adminGroupName,
            description: 'Members of this group resolve to the Admin role (full tool access) at the AgentCore Gateway.',
        });
        // Add Cognito Domain for OAuth
        const userPoolDomain = userPool.addDomain('CloudOpsDomain', {
            cognitoDomain: {
                domainPrefix: `cloudops-mcp-${this.account}-${cdk.Names.uniqueId(this).toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 8)}`,
            },
        });
        // OAuth endpoints for Gateway and AgentCore Identity
        const domainUrl = `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`;
        this.oauthTokenEndpoint = `${domainUrl}/oauth2/token`;
        this.oauthAuthorizationEndpoint = `${domainUrl}/oauth2/authorize`;
        this.oauthIssuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;
        // ========================================
        // User Pool Clients
        // ========================================
        // Create Resource Server for M2M authentication (required for client_credentials flow)
        const mcpInvokeScope = {
            scopeName: 'invoke',
            scopeDescription: 'Invoke MCP runtime tools',
        };
        const resourceServer = userPool.addResourceServer('CloudOpsResourceServer', {
            identifier: 'mcp-runtime-server',
            userPoolResourceServerName: `${this.stackName}-resource-server`,
            scopes: [mcpInvokeScope],
        });
        // Client for frontend users (no secret)
        const userPoolClient = userPool.addClient('CloudOpsUserPoolClient', {
            userPoolClientName: `${this.stackName}-client`,
            generateSecret: false,
            authFlows: {
                userPassword: true,
                userSrp: true,
                custom: true,
            },
            oAuth: {
                flows: {
                    authorizationCodeGrant: true,
                    implicitCodeGrant: true,
                },
                scopes: [
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.PROFILE,
                ],
            },
        });
        this.userPoolClientId = userPoolClient.userPoolClientId;
        // M2M Client for Gateway → MCP Server Runtimes (with secret for client credentials flow)
        const m2mClient = userPool.addClient('CloudOpsM2MClient', {
            userPoolClientName: `${this.stackName}-m2m-client`,
            generateSecret: true,
            authFlows: {
                userPassword: false,
                userSrp: false,
                custom: false,
            },
            oAuth: {
                flows: {
                    clientCredentials: true, // M2M flow
                },
                scopes: [
                    cognito.OAuthScope.resourceServer(resourceServer, mcpInvokeScope),
                ],
            },
        });
        this.oauthClientId = m2mClient.userPoolClientId;
        // ========================================
        // Identity Pool
        // ========================================
        const identityPool = new cognito.CfnIdentityPool(this, 'CloudOpsIdentityPool', {
            identityPoolName: `${this.stackName.replace(/[^a-zA-Z0-9]/g, '_')}_identity_pool`,
            allowUnauthenticatedIdentities: false,
            cognitoIdentityProviders: [
                {
                    clientId: userPoolClient.userPoolClientId,
                    providerName: userPool.userPoolProviderName,
                },
                {
                    clientId: m2mClient.userPoolClientId,
                    providerName: userPool.userPoolProviderName,
                },
            ],
        });
        this.identityPoolId = identityPool.ref;
        // ========================================
        // IAM Roles for Identity Pool
        // ========================================
        // Authenticated Role - Can invoke Main Agent Runtime
        const authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
            // No explicit roleName: IAM role names are account-GLOBAL, so a fixed
            // name collides when this stack is deployed to more than one region in
            // the same account. Letting CDK generate the physical name keeps it
            // unique per deployment. The role is consumed by ARN (identity pool
            // attachment + the AuthenticatedRoleArn output), never by name.
            assumedBy: new iam.FederatedPrincipal('cognito-identity.amazonaws.com', {
                StringEquals: {
                    'cognito-identity.amazonaws.com:aud': identityPool.ref,
                },
                'ForAnyValue:StringLike': {
                    'cognito-identity.amazonaws.com:amr': 'authenticated',
                },
            }, 'sts:AssumeRoleWithWebIdentity'),
        });
        // Least-privilege grant: frontend users only ever invoke the main agent
        // runtime (`cloudops_runtime*`). The downstream MCP runtimes are reached
        // Gateway -> target via OAuth, never directly by the frontend principal,
        // so they are intentionally excluded from this grant. The trailing `/*`
        // (within the `cloudops_runtime*` wildcard) covers all session IDs and
        // conversation turns. Feature: gateway-security-hardening (Requirements
        // 6.1, 6.2, 6.3, 6.4, 6.5).
        authenticatedRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock-agentcore:InvokeAgentRuntime',
                'bedrock-agentcore:GetRuntime',
                'bedrock-agentcore:ListRuntimes',
            ],
            resources: [
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/cloudops_runtime*`,
            ],
        }));
        // Unauthenticated Role - Deny all
        const unauthenticatedRole = new iam.Role(this, 'UnauthenticatedRole', {
            // No explicit roleName, for the same account-global IAM uniqueness
            // reason as the authenticated role above.
            assumedBy: new iam.FederatedPrincipal('cognito-identity.amazonaws.com', {
                StringEquals: {
                    'cognito-identity.amazonaws.com:aud': identityPool.ref,
                },
                'ForAnyValue:StringLike': {
                    'cognito-identity.amazonaws.com:amr': 'unauthenticated',
                },
            }, 'sts:AssumeRoleWithWebIdentity'),
        });
        unauthenticatedRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            actions: ['*'],
            resources: ['*'],
        }));
        // Attach roles to Identity Pool
        new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
            identityPoolId: identityPool.ref,
            roles: {
                authenticated: authenticatedRole.roleArn,
                unauthenticated: unauthenticatedRole.roleArn,
            },
        });
        // ========================================
        // Admin User
        // ========================================
        const adminUser = new cognito.CfnUserPoolUser(this, 'AdminUser', {
            userPoolId: userPool.userPoolId,
            username: 'admin',
            userAttributes: [
                {
                    name: 'email',
                    value: props.adminEmail,
                },
                {
                    name: 'email_verified',
                    value: 'true',
                },
            ],
            desiredDeliveryMediums: ['EMAIL'],
        });
        // Add the bootstrap admin user to the Administrators group so it resolves
        // to the Admin role. The attachment must be created after both the user and
        // the group exist. Feature: gateway-tool-access-control (Requirement 1.1).
        const adminGroupMembership = new cognito.CfnUserPoolUserToGroupAttachment(this, 'AdminUserGroupAttachment', {
            userPoolId: userPool.userPoolId,
            groupName: this.adminGroupName,
            username: adminUser.username,
        });
        adminGroupMembership.addDependency(adminUser);
        adminGroupMembership.addDependency(administratorsGroup);
        // ========================================
        // Outputs
        // ========================================
        new cdk.CfnOutput(this, 'UserPoolId', {
            value: this.userPoolId,
            description: 'Cognito User Pool ID',
            exportName: `${this.stackName}-UserPoolId`,
        });
        new cdk.CfnOutput(this, 'UserPoolClientId', {
            value: this.userPoolClientId,
            description: 'Cognito User Pool Client ID',
            exportName: `${this.stackName}-UserPoolClientId`,
        });
        new cdk.CfnOutput(this, 'IdentityPoolId', {
            value: this.identityPoolId,
            description: 'Cognito Identity Pool ID',
            exportName: `${this.stackName}-IdentityPoolId`,
        });
        new cdk.CfnOutput(this, 'UserPoolArn', {
            value: this.userPoolArn,
            description: 'Cognito User Pool ARN',
            exportName: `${this.stackName}-UserPoolArn`,
        });
        new cdk.CfnOutput(this, 'OAuthClientId', {
            value: this.oauthClientId,
            description: 'OAuth Client ID for Gateway',
            exportName: `${this.stackName}-OAuthClientId`,
        });
        new cdk.CfnOutput(this, 'OAuthTokenEndpoint', {
            value: this.oauthTokenEndpoint,
            description: 'OAuth Token Endpoint for Gateway',
            exportName: `${this.stackName}-OAuthTokenEndpoint`,
        });
        new cdk.CfnOutput(this, 'OAuthAuthorizationEndpoint', {
            value: this.oauthAuthorizationEndpoint,
            description: 'OAuth Authorization Endpoint',
            exportName: `${this.stackName}-OAuthAuthorizationEndpoint`,
        });
        new cdk.CfnOutput(this, 'OAuthIssuer', {
            value: this.oauthIssuer,
            description: 'OAuth Issuer URL',
            exportName: `${this.stackName}-OAuthIssuer`,
        });
        new cdk.CfnOutput(this, 'OAuthDiscoveryUrl', {
            value: `${this.oauthIssuer}/.well-known/openid-configuration`,
            description: 'OAuth Discovery URL for M2M authentication',
            exportName: `${this.stackName}-OAuthDiscoveryUrl`,
        });
        new cdk.CfnOutput(this, 'AuthenticatedRoleArn', {
            value: authenticatedRole.roleArn,
            description: 'Authenticated Role ARN',
        });
        new cdk.CfnOutput(this, 'AdminEmail', {
            value: props.adminEmail,
            description: 'Admin user email (temporary password sent via email)',
        });
        new cdk.CfnOutput(this, 'AdminUsername', {
            value: 'admin',
            description: 'Admin username',
        });
        new cdk.CfnOutput(this, 'AdminGroupName', {
            value: this.adminGroupName,
            description: 'Cognito group whose members resolve to the Admin role',
            exportName: `${this.stackName}-AdminGroupName`,
        });
        new cdk.CfnOutput(this, 'RoleClaimName', {
            value: this.roleClaimName,
            description: 'Scalar role claim injected into issued tokens by the Pre Token Generation Lambda',
            exportName: `${this.stackName}-RoleClaimName`,
        });
        // ========================================
        // OAuth Provider - Created by external Python script after stack deploy
        // ========================================
        this.oauthProviderName = 'cloudops-mcp-oauth-provider';
        this.oauthProviderArn = 'CREATED_BY_SCRIPT'; // Will be read from oauth-provider-arn.txt
        new cdk.CfnOutput(this, 'OAuthProviderName', {
            value: this.oauthProviderName,
            description: 'OAuth Provider Name (created by scripts/create-oauth-provider.py)',
        });
        // ========================================
        // CDK-Nag Suppressions
        // ========================================
        // Cognito User Pool suppressions
        cdk_nag_1.NagSuppressions.addResourceSuppressions(userPool, [
            {
                id: 'AwsSolutions-COG2',
                reason: 'MFA not enforced for demo/development environment. Production deployments should enable MFA for enhanced security.',
            },
            {
                id: 'AwsSolutions-COG3',
                reason: 'Advanced security features (compromised credentials check) not required for demo/development environment. Production deployments should enable AdvancedSecurityMode.',
            },
        ], true);
        // Pre Token Generation Lambda suppressions
        cdk_nag_1.NagSuppressions.addResourceSuppressions(preTokenGenerationFn, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWSLambdaBasicExecutionRole managed policy is AWS best practice for the Pre Token Generation Lambda execution role (CloudWatch Logs access only)',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
            },
            {
                id: 'AwsSolutions-L1',
                reason: 'Pre Token Generation Lambda pinned to Python 3.12, consistent with the other Python Lambdas in this project',
            },
        ], true);
        // Authenticated Role suppressions
        cdk_nag_1.NagSuppressions.addResourceSuppressions(authenticatedRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Grant scoped to the main runtime only (cloudops_runtime*); the trailing session-id wildcard is required for AgentCore runtime invocation to support all session IDs and conversation turns (runtime ARN with /* suffix). Feature: gateway-security-hardening (Requirement 6.1).',
            },
        ], true);
        // Stack-level suppressions for CDK-created Lambda functions (Cognito domain custom resource)
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWSLambdaBasicExecutionRole managed policy is AWS best practice for Lambda functions created by CDK for Cognito domain custom resource',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
            },
            {
                id: 'AwsSolutions-L1',
                reason: 'Lambda function is created and managed by CDK for Cognito domain custom resource - runtime is automatically updated by CDK',
            },
        ]);
    }
}
exports.AuthStack = AuthStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXV0aC1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImF1dGgtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLGlFQUFtRDtBQUNuRCx5REFBMkM7QUFDM0MsK0RBQWlEO0FBRWpELDJDQUE2QjtBQUM3QixxQ0FBMEM7QUFFMUM7Ozs7O0dBS0c7QUFDSCxNQUFNLGdCQUFnQixHQUFHLGdCQUFnQixDQUFDO0FBTTFDLE1BQWEsU0FBVSxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBaUJ0QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXFCO1FBQzdELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBTjFCLHlFQUF5RTtRQUN6RCxtQkFBYyxHQUFXLGdCQUFnQixDQUFDO1FBQzFELHFFQUFxRTtRQUNyRCxrQkFBYSxHQUFXLE1BQU0sQ0FBQztRQUs3QywyQ0FBMkM7UUFDM0Msb0JBQW9CO1FBQ3BCLDJDQUEyQztRQUUzQyxNQUFNLFFBQVEsR0FBRyxJQUFJLE9BQU8sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQzlELFlBQVksRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLFFBQVE7WUFDdkMsaUJBQWlCLEVBQUUsS0FBSztZQUN4QixhQUFhLEVBQUU7Z0JBQ2IsS0FBSyxFQUFFLElBQUk7Z0JBQ1gsUUFBUSxFQUFFLElBQUk7YUFDZjtZQUNELFVBQVUsRUFBRTtnQkFDVixLQUFLLEVBQUUsSUFBSTthQUNaO1lBQ0QsY0FBYyxFQUFFO2dCQUNkLFlBQVksRUFBRSx1Q0FBdUM7Z0JBQ3JELFNBQVMsRUFBRTtvQkFDVCxvQ0FBb0M7b0JBQ3BDLDBHQUEwRztvQkFDMUcsT0FBTztvQkFDUCxrQ0FBa0M7b0JBQ2xDLDhIQUE4SDtvQkFDOUgsT0FBTztvQkFDUCw0Q0FBNEM7b0JBQzVD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KiBhcyBjb2duaXRvIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jb2duaXRvJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xuXG4vKipcbiAqIE5hbWUgb2YgdGhlIENvZ25pdG8gZ3JvdXAgd2hvc2UgbWVtYmVycyBhcmUgZGVzaWduYXRlZCB0aGUgQWRtaW4gcm9sZS5cbiAqIFRoZSBQcmUgVG9rZW4gR2VuZXJhdGlvbiBMYW1iZGEgbWFwcyBtZW1iZXJzaGlwIG9mIHRoaXMgZ3JvdXAgdG8gdGhlIHNjYWxhclxuICogYHJvbGVgIGNsYWltIChcImFkbWluXCIpOyBhbGwgb3RoZXIgdXNlcnMgcmVzb2x2ZSB0byBcIm5vbmFkbWluXCIuXG4gKiBGZWF0dXJlOiBnYXRld2F5LXRvb2wtYWNjZXNzLWNvbnRyb2wgKFJlcXVpcmVtZW50IDEuMSkuXG4gKi9cbmNvbnN0IEFETUlOX0dST1VQX05BTUUgPSAnQWRtaW5pc3RyYXRvcnMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEF1dGhTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBhZG1pbkVtYWlsOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBBdXRoU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgdXNlclBvb2xJZDogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgdXNlclBvb2xDbGllbnRJZDogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgaWRlbnRpdHlQb29sSWQ6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IHVzZXJQb29sQXJuOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSB1c2VyUG9vbFByb3ZpZGVyTmFtZTogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgb2F1dGhDbGllbnRJZDogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgb2F1dGhUb2tlbkVuZHBvaW50OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBvYXV0aEF1dGhvcml6YXRpb25FbmRwb2ludDogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgb2F1dGhJc3N1ZXI6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IG9hdXRoUHJvdmlkZXJOYW1lOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBvYXV0aFByb3ZpZGVyQXJuOiBzdHJpbmc7XG4gIC8qKiBOYW1lIG9mIHRoZSBDb2duaXRvIGdyb3VwIHdob3NlIG1lbWJlcnMgcmVzb2x2ZSB0byB0aGUgQWRtaW4gcm9sZS4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGFkbWluR3JvdXBOYW1lOiBzdHJpbmcgPSBBRE1JTl9HUk9VUF9OQU1FO1xuICAvKiogTmFtZSBvZiB0aGUgc2NhbGFyIHJvbGUgY2xhaW0gaW5qZWN0ZWQgaW50byB0aGUgaXNzdWVkIHRva2Vucy4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHJvbGVDbGFpbU5hbWU6IHN0cmluZyA9ICdyb2xlJztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXV0aFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDb2duaXRvIFVzZXIgUG9vbFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IHVzZXJQb29sID0gbmV3IGNvZ25pdG8uVXNlclBvb2wodGhpcywgJ0Nsb3VkT3BzVXNlclBvb2wnLCB7XG4gICAgICB1c2VyUG9vbE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS11c2Vyc2AsXG4gICAgICBzZWxmU2lnblVwRW5hYmxlZDogZmFsc2UsXG4gICAgICBzaWduSW5BbGlhc2VzOiB7XG4gICAgICAgIGVtYWlsOiB0cnVlLFxuICAgICAgICB1c2VybmFtZTogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICBhdXRvVmVyaWZ5OiB7XG4gICAgICAgIGVtYWlsOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIHVzZXJJbnZpdGF0aW9uOiB7XG4gICAgICAgIGVtYWlsU3ViamVjdDogJ1lvdXIgQ2xvdWRPcHMgQWdlbnQgTG9naW4gQ3JlZGVudGlhbHMnLFxuICAgICAgICBlbWFpbEJvZHk6IFtcbiAgICAgICAgICAnPGgyPldlbGNvbWUgdG8gQ2xvdWRPcHMgQWdlbnQ8L2gyPicsXG4gICAgICAgICAgJzxwPllvdXIgYWRtaW4gYWNjb3VudCBoYXMgYmVlbiBjcmVhdGVkLiBZb3Ugd2lsbCBiZSBwcm9tcHRlZCB0byBjaGFuZ2UgeW91ciBwYXNzd29yZCBvbiBmaXJzdCBsb2dpbi48L3A+JyxcbiAgICAgICAgICAnPGJyLz4nLFxuICAgICAgICAgICc8cD48c3Ryb25nPlVzZXJuYW1lPC9zdHJvbmc+PC9wPicsXG4gICAgICAgICAgJzxwIHN0eWxlPVwiZm9udC1mYW1pbHk6IG1vbm9zcGFjZTsgZm9udC1zaXplOiAxNnB4OyBiYWNrZ3JvdW5kOiAjZjBmMGYwOyBwYWRkaW5nOiA4cHg7IGRpc3BsYXk6IGlubGluZS1ibG9jaztcIj57dXNlcm5hbWV9PC9wPicsXG4gICAgICAgICAgJzxici8+JyxcbiAgICAgICAgICAnPHA+PHN0cm9uZz5UZW1wb3JhcnkgUGFzc3dvcmQ8L3N0cm9uZz48L3A+JyxcbiAgICAgICAgICAnPHAgc3R5bGU9XCJmb250LWZhbWlseTogbW9ub3NwYWNlOyBmb250LXNpemU6IDE2cHg7IGJhY2tncm91bmQ6ICNmMGYwZjA7IHBhZGRpbmc6IDhweDsgZGlzcGxheTogaW5saW5lLWJsb2NrO1wiPnsjIyMjfTwvcD4nLFxuICAgICAgICBdLmpvaW4oJ1xcbicpLFxuICAgICAgfSxcbiAgICAgIHBhc3N3b3JkUG9saWN5OiB7XG4gICAgICAgIG1pbkxlbmd0aDogOCxcbiAgICAgICAgcmVxdWlyZUxvd2VyY2FzZTogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZVVwcGVyY2FzZTogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZURpZ2l0czogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZVN5bWJvbHM6IHRydWUsIC8vIEFkZCBzeW1ib2wgcmVxdWlyZW1lbnQgZm9yIHN0cm9uZ2VyIHNlY3VyaXR5XG4gICAgICB9LFxuICAgICAgYWNjb3VudFJlY292ZXJ5OiBjb2duaXRvLkFjY291bnRSZWNvdmVyeS5FTUFJTF9PTkxZLFxuICAgICAgLy8gVGhlIEVzc2VudGlhbHMgZmVhdHVyZSBwbGFuIGlzIHJlcXVpcmVkIGZvciB0aGUgVjJfMCBQcmUgVG9rZW5cbiAgICAgIC8vIEdlbmVyYXRpb24gdHJpZ2dlciwgd2hpY2ggaXMgd2hhdCBlbmFibGVzIGFjY2Vzcy10b2tlbiAobm90IGp1c3RcbiAgICAgIC8vIElELXRva2VuKSBjbGFpbSBjdXN0b21pemF0aW9uLiBUaGUgYHJvbGVgIGNsYWltIG11c3QgcmVhY2ggdGhlXG4gICAgICAvLyBhY2Nlc3MgdG9rZW4gYmVjYXVzZSB0aGUgQWdlbnQgUnVudGltZSBmb3J3YXJkcyBpdCB0byB0aGUgR2F0ZXdheS5cbiAgICAgIC8vIEZlYXR1cmU6IGdhdGV3YXktdG9vbC1hY2Nlc3MtY29udHJvbCAoUmVxdWlyZW1lbnQgMS4xKS5cbiAgICAgIGZlYXR1cmVQbGFuOiBjb2duaXRvLkZlYXR1cmVQbGFuLkVTU0VOVElBTFMsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgdGhpcy51c2VyUG9vbElkID0gdXNlclBvb2wudXNlclBvb2xJZDtcbiAgICB0aGlzLnVzZXJQb29sQXJuID0gdXNlclBvb2wudXNlclBvb2xBcm47XG4gICAgdGhpcy51c2VyUG9vbFByb3ZpZGVyTmFtZSA9IHVzZXJQb29sLnVzZXJQb29sUHJvdmlkZXJOYW1lO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFByZSBUb2tlbiBHZW5lcmF0aW9uIExhbWJkYSArIHJvbGUgY2xhaW1cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gSW5qZWN0cyBhIHNjYWxhciBgcm9sZWAgY2xhaW0gKFwiYWRtaW5cIiB8IFwibm9uYWRtaW5cIikgaW50byB0aGUgdXNlcidzXG4gICAgLy8gdG9rZW5zIGJhc2VkIG9uIGBBZG1pbmlzdHJhdG9yc2AgZ3JvdXAgbWVtYmVyc2hpcCwgc28gdGhlIEFnZW50Q29yZVxuICAgIC8vIEdhdGV3YXkncyBDZWRhciBwb2xpY3kgY2FuIGF1dGhvcml6ZSB0b29sIGFjY2VzcyBieSByb2xlLiBUaGUgcm9sZSBpc1xuICAgIC8vIGRlcml2ZWQgc29sZWx5IGZyb20gdmVyaWZpZWQgZ3JvdXAgbWVtYmVyc2hpcCwgbmV2ZXIgYSBjbGllbnQtc3VwcGxpZWRcbiAgICAvLyB2YWx1ZS4gRmVhdHVyZTogZ2F0ZXdheS10b29sLWFjY2Vzcy1jb250cm9sIChSZXF1aXJlbWVudCAxLjEpLlxuICAgIGNvbnN0IHByZVRva2VuR2VuZXJhdGlvbkZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnUHJlVG9rZW5HZW5lcmF0aW9uRnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyLmhhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvcHJlLXRva2VuLWdlbmVyYXRpb24nKSksXG4gICAgICBtZW1vcnlTaXplOiAxMjgsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg1KSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBQcmUgVG9rZW4gR2VuZXJhdGlvbiB0cmlnZ2VyOiBtYXBzIEFkbWluaXN0cmF0b3JzIGdyb3VwIG1lbWJlcnNoaXAgdG8gYSBzY2FsYXIgcm9sZSBjbGFpbScsXG4gICAgfSk7XG5cbiAgICAvLyBBdHRhY2ggYXMgdGhlIFByZSBUb2tlbiBHZW5lcmF0aW9uIHRyaWdnZXIgdXNpbmcgdGhlIFYyXzAgZXZlbnQsIHdoaWNoIGlzXG4gICAgLy8gd2hhdCBlbmFibGVzIGFjY2Vzcy10b2tlbiBjbGFpbSBjdXN0b21pemF0aW9uIChyZXF1aXJlcyB0aGUgRXNzZW50aWFsc1xuICAgIC8vIGZlYXR1cmUgcGxhbiBzZXQgb24gdGhlIFVzZXIgUG9vbCBhYm92ZSkuIGFkZFRyaWdnZXIgYWxzbyBncmFudHMgQ29nbml0b1xuICAgIC8vIHBlcm1pc3Npb24gdG8gaW52b2tlIHRoZSBmdW5jdGlvbi5cbiAgICB1c2VyUG9vbC5hZGRUcmlnZ2VyKFxuICAgICAgY29nbml0by5Vc2VyUG9vbE9wZXJhdGlvbi5QUkVfVE9LRU5fR0VORVJBVElPTl9DT05GSUcsXG4gICAgICBwcmVUb2tlbkdlbmVyYXRpb25GbixcbiAgICAgIGNvZ25pdG8uTGFtYmRhVmVyc2lvbi5WMl8wLFxuICAgICk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ29nbml0byBHcm91cCDigJQgQWRtaW5pc3RyYXRvcnMgKEFkbWluIHJvbGUpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGFkbWluaXN0cmF0b3JzR3JvdXAgPSBuZXcgY29nbml0by5DZm5Vc2VyUG9vbEdyb3VwKHRoaXMsICdBZG1pbmlzdHJhdG9yc0dyb3VwJywge1xuICAgICAgdXNlclBvb2xJZDogdXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgIGdyb3VwTmFtZTogdGhpcy5hZG1pbkdyb3VwTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnTWVtYmVycyBvZiB0aGlzIGdyb3VwIHJlc29sdmUgdG8gdGhlIEFkbWluIHJvbGUgKGZ1bGwgdG9vbCBhY2Nlc3MpIGF0IHRoZSBBZ2VudENvcmUgR2F0ZXdheS4nLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIENvZ25pdG8gRG9tYWluIGZvciBPQXV0aFxuICAgIGNvbnN0IHVzZXJQb29sRG9tYWluID0gdXNlclBvb2wuYWRkRG9tYWluKCdDbG91ZE9wc0RvbWFpbicsIHtcbiAgICAgIGNvZ25pdG9Eb21haW46IHtcbiAgICAgICAgZG9tYWluUHJlZml4OiBgY2xvdWRvcHMtbWNwLSR7dGhpcy5hY2NvdW50fS0ke2Nkay5OYW1lcy51bmlxdWVJZCh0aGlzKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1teYS16MC05XS9nLCAnJykuc3Vic3RyaW5nKDAsIDgpfWAsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gT0F1dGggZW5kcG9pbnRzIGZvciBHYXRld2F5IGFuZCBBZ2VudENvcmUgSWRlbnRpdHlcbiAgICBjb25zdCBkb21haW5VcmwgPSBgaHR0cHM6Ly8ke3VzZXJQb29sRG9tYWluLmRvbWFpbk5hbWV9LmF1dGguJHt0aGlzLnJlZ2lvbn0uYW1hem9uY29nbml0by5jb21gO1xuICAgIHRoaXMub2F1dGhUb2tlbkVuZHBvaW50ID0gYCR7ZG9tYWluVXJsfS9vYXV0aDIvdG9rZW5gO1xuICAgIHRoaXMub2F1dGhBdXRob3JpemF0aW9uRW5kcG9pbnQgPSBgJHtkb21haW5Vcmx9L29hdXRoMi9hdXRob3JpemVgO1xuICAgIHRoaXMub2F1dGhJc3N1ZXIgPSBgaHR0cHM6Ly9jb2duaXRvLWlkcC4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tLyR7dXNlclBvb2wudXNlclBvb2xJZH1gO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFVzZXIgUG9vbCBDbGllbnRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgLy8gQ3JlYXRlIFJlc291cmNlIFNlcnZlciBmb3IgTTJNIGF1dGhlbnRpY2F0aW9uIChyZXF1aXJlZCBmb3IgY2xpZW50X2NyZWRlbnRpYWxzIGZsb3cpXG4gICAgY29uc3QgbWNwSW52b2tlU2NvcGU6IGNvZ25pdG8uUmVzb3VyY2VTZXJ2ZXJTY29wZSA9IHtcbiAgICAgIHNjb3BlTmFtZTogJ2ludm9rZScsXG4gICAgICBzY29wZURlc2NyaXB0aW9uOiAnSW52b2tlIE1DUCBydW50aW1lIHRvb2xzJyxcbiAgICB9O1xuXG4gICAgY29uc3QgcmVzb3VyY2VTZXJ2ZXIgPSB1c2VyUG9vbC5hZGRSZXNvdXJjZVNlcnZlcignQ2xvdWRPcHNSZXNvdXJjZVNlcnZlcicsIHtcbiAgICAgIGlkZW50aWZpZXI6ICdtY3AtcnVudGltZS1zZXJ2ZXInLFxuICAgICAgdXNlclBvb2xSZXNvdXJjZVNlcnZlck5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1yZXNvdXJjZS1zZXJ2ZXJgLFxuICAgICAgc2NvcGVzOiBbbWNwSW52b2tlU2NvcGVdLFxuICAgIH0pO1xuXG4gICAgLy8gQ2xpZW50IGZvciBmcm9udGVuZCB1c2VycyAobm8gc2VjcmV0KVxuICAgIGNvbnN0IHVzZXJQb29sQ2xpZW50ID0gdXNlclBvb2wuYWRkQ2xpZW50KCdDbG91ZE9wc1VzZXJQb29sQ2xpZW50Jywge1xuICAgICAgdXNlclBvb2xDbGllbnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tY2xpZW50YCxcbiAgICAgIGdlbmVyYXRlU2VjcmV0OiBmYWxzZSxcbiAgICAgIGF1dGhGbG93czoge1xuICAgICAgICB1c2VyUGFzc3dvcmQ6IHRydWUsXG4gICAgICAgIHVzZXJTcnA6IHRydWUsXG4gICAgICAgIGN1c3RvbTogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICBvQXV0aDoge1xuICAgICAgICBmbG93czoge1xuICAgICAgICAgIGF1dGhvcml6YXRpb25Db2RlR3JhbnQ6IHRydWUsXG4gICAgICAgICAgaW1wbGljaXRDb2RlR3JhbnQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIHNjb3BlczogW1xuICAgICAgICAgIGNvZ25pdG8uT0F1dGhTY29wZS5FTUFJTCxcbiAgICAgICAgICBjb2duaXRvLk9BdXRoU2NvcGUuT1BFTklELFxuICAgICAgICAgIGNvZ25pdG8uT0F1dGhTY29wZS5QUk9GSUxFLFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHRoaXMudXNlclBvb2xDbGllbnRJZCA9IHVzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQ7XG5cbiAgICAvLyBNMk0gQ2xpZW50IGZvciBHYXRld2F5IOKGkiBNQ1AgU2VydmVyIFJ1bnRpbWVzICh3aXRoIHNlY3JldCBmb3IgY2xpZW50IGNyZWRlbnRpYWxzIGZsb3cpXG4gICAgY29uc3QgbTJtQ2xpZW50ID0gdXNlclBvb2wuYWRkQ2xpZW50KCdDbG91ZE9wc00yTUNsaWVudCcsIHtcbiAgICAgIHVzZXJQb29sQ2xpZW50TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LW0ybS1jbGllbnRgLFxuICAgICAgZ2VuZXJhdGVTZWNyZXQ6IHRydWUsXG4gICAgICBhdXRoRmxvd3M6IHtcbiAgICAgICAgdXNlclBhc3N3b3JkOiBmYWxzZSxcbiAgICAgICAgdXNlclNycDogZmFsc2UsXG4gICAgICAgIGN1c3RvbTogZmFsc2UsXG4gICAgICB9LFxuICAgICAgb0F1dGg6IHtcbiAgICAgICAgZmxvd3M6IHtcbiAgICAgICAgICBjbGllbnRDcmVkZW50aWFsczogdHJ1ZSwgLy8gTTJNIGZsb3dcbiAgICAgICAgfSxcbiAgICAgICAgc2NvcGVzOiBbXG4gICAgICAgICAgY29nbml0by5PQXV0aFNjb3BlLnJlc291cmNlU2VydmVyKHJlc291cmNlU2VydmVyLCBtY3BJbnZva2VTY29wZSksXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy5vYXV0aENsaWVudElkID0gbTJtQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQ7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gSWRlbnRpdHkgUG9vbFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IGlkZW50aXR5UG9vbCA9IG5ldyBjb2duaXRvLkNmbklkZW50aXR5UG9vbCh0aGlzLCAnQ2xvdWRPcHNJZGVudGl0eVBvb2wnLCB7XG4gICAgICBpZGVudGl0eVBvb2xOYW1lOiBgJHt0aGlzLnN0YWNrTmFtZS5yZXBsYWNlKC9bXmEtekEtWjAtOV0vZywgJ18nKX1faWRlbnRpdHlfcG9vbGAsXG4gICAgICBhbGxvd1VuYXV0aGVudGljYXRlZElkZW50aXRpZXM6IGZhbHNlLFxuICAgICAgY29nbml0b0lkZW50aXR5UHJvdmlkZXJzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBjbGllbnRJZDogdXNlclBvb2xDbGllbnQudXNlclBvb2xDbGllbnRJZCxcbiAgICAgICAgICBwcm92aWRlck5hbWU6IHVzZXJQb29sLnVzZXJQb29sUHJvdmlkZXJOYW1lLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgY2xpZW50SWQ6IG0ybUNsaWVudC51c2VyUG9vbENsaWVudElkLFxuICAgICAgICAgIHByb3ZpZGVyTmFtZTogdXNlclBvb2wudXNlclBvb2xQcm92aWRlck5hbWUsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgdGhpcy5pZGVudGl0eVBvb2xJZCA9IGlkZW50aXR5UG9vbC5yZWY7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gSUFNIFJvbGVzIGZvciBJZGVudGl0eSBQb29sXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgLy8gQXV0aGVudGljYXRlZCBSb2xlIC0gQ2FuIGludm9rZSBNYWluIEFnZW50IFJ1bnRpbWVcbiAgICBjb25zdCBhdXRoZW50aWNhdGVkUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnQXV0aGVudGljYXRlZFJvbGUnLCB7XG4gICAgICAvLyBObyBleHBsaWNpdCByb2xlTmFtZTogSUFNIHJvbGUgbmFtZXMgYXJlIGFjY291bnQtR0xPQkFMLCBzbyBhIGZpeGVkXG4gICAgICAvLyBuYW1lIGNvbGxpZGVzIHdoZW4gdGhpcyBzdGFjayBpcyBkZXBsb3llZCB0byBtb3JlIHRoYW4gb25lIHJlZ2lvbiBpblxuICAgICAgLy8gdGhlIHNhbWUgYWNjb3VudC4gTGV0dGluZyBDREsgZ2VuZXJhdGUgdGhlIHBoeXNpY2FsIG5hbWUga2VlcHMgaXRcbiAgICAgIC8vIHVuaXF1ZSBwZXIgZGVwbG95bWVudC4gVGhlIHJvbGUgaXMgY29uc3VtZWQgYnkgQVJOIChpZGVudGl0eSBwb29sXG4gICAgICAvLyBhdHRhY2htZW50ICsgdGhlIEF1dGhlbnRpY2F0ZWRSb2xlQXJuIG91dHB1dCksIG5ldmVyIGJ5IG5hbWUuXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uRmVkZXJhdGVkUHJpbmNpcGFsKFxuICAgICAgICAnY29nbml0by1pZGVudGl0eS5hbWF6b25hd3MuY29tJyxcbiAgICAgICAge1xuICAgICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICAgJ2NvZ25pdG8taWRlbnRpdHkuYW1hem9uYXdzLmNvbTphdWQnOiBpZGVudGl0eVBvb2wucmVmLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgJ0ZvckFueVZhbHVlOlN0cmluZ0xpa2UnOiB7XG4gICAgICAgICAgICAnY29nbml0by1pZGVudGl0eS5hbWF6b25hd3MuY29tOmFtcic6ICdhdXRoZW50aWNhdGVkJyxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICAnc3RzOkFzc3VtZVJvbGVXaXRoV2ViSWRlbnRpdHknXG4gICAgICApLFxuICAgIH0pO1xuXG4gICAgLy8gTGVhc3QtcHJpdmlsZWdlIGdyYW50OiBmcm9udGVuZCB1c2VycyBvbmx5IGV2ZXIgaW52b2tlIHRoZSBtYWluIGFnZW50XG4gICAgLy8gcnVudGltZSAoYGNsb3Vkb3BzX3J1bnRpbWUqYCkuIFRoZSBkb3duc3RyZWFtIE1DUCBydW50aW1lcyBhcmUgcmVhY2hlZFxuICAgIC8vIEdhdGV3YXkgLT4gdGFyZ2V0IHZpYSBPQXV0aCwgbmV2ZXIgZGlyZWN0bHkgYnkgdGhlIGZyb250ZW5kIHByaW5jaXBhbCxcbiAgICAvLyBzbyB0aGV5IGFyZSBpbnRlbnRpb25hbGx5IGV4Y2x1ZGVkIGZyb20gdGhpcyBncmFudC4gVGhlIHRyYWlsaW5nIGAvKmBcbiAgICAvLyAod2l0aGluIHRoZSBgY2xvdWRvcHNfcnVudGltZSpgIHdpbGRjYXJkKSBjb3ZlcnMgYWxsIHNlc3Npb24gSURzIGFuZFxuICAgIC8vIGNvbnZlcnNhdGlvbiB0dXJucy4gRmVhdHVyZTogZ2F0ZXdheS1zZWN1cml0eS1oYXJkZW5pbmcgKFJlcXVpcmVtZW50c1xuICAgIC8vIDYuMSwgNi4yLCA2LjMsIDYuNCwgNi41KS5cbiAgICBhdXRoZW50aWNhdGVkUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpJbnZva2VBZ2VudFJ1bnRpbWUnLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0UnVudGltZScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpMaXN0UnVudGltZXMnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czpiZWRyb2NrLWFnZW50Y29yZToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06cnVudGltZS9jbG91ZG9wc19ydW50aW1lKmAsXG4gICAgICBdLFxuICAgIH0pKTtcblxuICAgIC8vIFVuYXV0aGVudGljYXRlZCBSb2xlIC0gRGVueSBhbGxcbiAgICBjb25zdCB1bmF1dGhlbnRpY2F0ZWRSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdVbmF1dGhlbnRpY2F0ZWRSb2xlJywge1xuICAgICAgLy8gTm8gZXhwbGljaXQgcm9sZU5hbWUsIGZvciB0aGUgc2FtZSBhY2NvdW50LWdsb2JhbCBJQU0gdW5pcXVlbmVzc1xuICAgICAgLy8gcmVhc29uIGFzIHRoZSBhdXRoZW50aWNhdGVkIHJvbGUgYWJvdmUuXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uRmVkZXJhdGVkUHJpbmNpcGFsKFxuICAgICAgICAnY29nbml0by1pZGVudGl0eS5hbWF6b25hd3MuY29tJyxcbiAgICAgICAge1xuICAgICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICAgJ2NvZ25pdG8taWRlbnRpdHkuYW1hem9uYXdzLmNvbTphdWQnOiBpZGVudGl0eVBvb2wucmVmLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgJ0ZvckFueVZhbHVlOlN0cmluZ0xpa2UnOiB7XG4gICAgICAgICAgICAnY29nbml0by1pZGVudGl0eS5hbWF6b25hd3MuY29tOmFtcic6ICd1bmF1dGhlbnRpY2F0ZWQnLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgICdzdHM6QXNzdW1lUm9sZVdpdGhXZWJJZGVudGl0eSdcbiAgICAgICksXG4gICAgfSk7XG5cbiAgICB1bmF1dGhlbnRpY2F0ZWRSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5ERU5ZLFxuICAgICAgYWN0aW9uczogWycqJ10sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIC8vIEF0dGFjaCByb2xlcyB0byBJZGVudGl0eSBQb29sXG4gICAgbmV3IGNvZ25pdG8uQ2ZuSWRlbnRpdHlQb29sUm9sZUF0dGFjaG1lbnQodGhpcywgJ0lkZW50aXR5UG9vbFJvbGVBdHRhY2htZW50Jywge1xuICAgICAgaWRlbnRpdHlQb29sSWQ6IGlkZW50aXR5UG9vbC5yZWYsXG4gICAgICByb2xlczoge1xuICAgICAgICBhdXRoZW50aWNhdGVkOiBhdXRoZW50aWNhdGVkUm9sZS5yb2xlQXJuLFxuICAgICAgICB1bmF1dGhlbnRpY2F0ZWQ6IHVuYXV0aGVudGljYXRlZFJvbGUucm9sZUFybixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQWRtaW4gVXNlclxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IGFkbWluVXNlciA9IG5ldyBjb2duaXRvLkNmblVzZXJQb29sVXNlcih0aGlzLCAnQWRtaW5Vc2VyJywge1xuICAgICAgdXNlclBvb2xJZDogdXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgIHVzZXJuYW1lOiAnYWRtaW4nLFxuICAgICAgdXNlckF0dHJpYnV0ZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdlbWFpbCcsXG4gICAgICAgICAgdmFsdWU6IHByb3BzLmFkbWluRW1haWwsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnZW1haWxfdmVyaWZpZWQnLFxuICAgICAgICAgIHZhbHVlOiAndHJ1ZScsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgZGVzaXJlZERlbGl2ZXJ5TWVkaXVtczogWydFTUFJTCddLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRoZSBib290c3RyYXAgYWRtaW4gdXNlciB0byB0aGUgQWRtaW5pc3RyYXRvcnMgZ3JvdXAgc28gaXQgcmVzb2x2ZXNcbiAgICAvLyB0byB0aGUgQWRtaW4gcm9sZS4gVGhlIGF0dGFjaG1lbnQgbXVzdCBiZSBjcmVhdGVkIGFmdGVyIGJvdGggdGhlIHVzZXIgYW5kXG4gICAgLy8gdGhlIGdyb3VwIGV4aXN0LiBGZWF0dXJlOiBnYXRld2F5LXRvb2wtYWNjZXNzLWNvbnRyb2wgKFJlcXVpcmVtZW50IDEuMSkuXG4gICAgY29uc3QgYWRtaW5Hcm91cE1lbWJlcnNoaXAgPSBuZXcgY29nbml0by5DZm5Vc2VyUG9vbFVzZXJUb0dyb3VwQXR0YWNobWVudCh0aGlzLCAnQWRtaW5Vc2VyR3JvdXBBdHRhY2htZW50Jywge1xuICAgICAgdXNlclBvb2xJZDogdXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgIGdyb3VwTmFtZTogdGhpcy5hZG1pbkdyb3VwTmFtZSxcbiAgICAgIHVzZXJuYW1lOiBhZG1pblVzZXIudXNlcm5hbWUgYXMgc3RyaW5nLFxuICAgIH0pO1xuICAgIGFkbWluR3JvdXBNZW1iZXJzaGlwLmFkZERlcGVuZGVuY3koYWRtaW5Vc2VyKTtcbiAgICBhZG1pbkdyb3VwTWVtYmVyc2hpcC5hZGREZXBlbmRlbmN5KGFkbWluaXN0cmF0b3JzR3JvdXApO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVXNlclBvb2xJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnVzZXJQb29sSWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIElEJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Vc2VyUG9vbElkYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbENsaWVudElkJywge1xuICAgICAgdmFsdWU6IHRoaXMudXNlclBvb2xDbGllbnRJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgQ2xpZW50IElEJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Vc2VyUG9vbENsaWVudElkYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdJZGVudGl0eVBvb2xJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmlkZW50aXR5UG9vbElkLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIElkZW50aXR5IFBvb2wgSUQnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUlkZW50aXR5UG9vbElkYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdVc2VyUG9vbEFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnVzZXJQb29sQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIFVzZXIgUG9vbCBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVVzZXJQb29sQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdPQXV0aENsaWVudElkJywge1xuICAgICAgdmFsdWU6IHRoaXMub2F1dGhDbGllbnRJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnT0F1dGggQ2xpZW50IElEIGZvciBHYXRld2F5JyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1PQXV0aENsaWVudElkYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdPQXV0aFRva2VuRW5kcG9pbnQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5vYXV0aFRva2VuRW5kcG9pbnQsXG4gICAgICBkZXNjcmlwdGlvbjogJ09BdXRoIFRva2VuIEVuZHBvaW50IGZvciBHYXRld2F5JyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1PQXV0aFRva2VuRW5kcG9pbnRgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ09BdXRoQXV0aG9yaXphdGlvbkVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IHRoaXMub2F1dGhBdXRob3JpemF0aW9uRW5kcG9pbnQsXG4gICAgICBkZXNjcmlwdGlvbjogJ09BdXRoIEF1dGhvcml6YXRpb24gRW5kcG9pbnQnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LU9BdXRoQXV0aG9yaXphdGlvbkVuZHBvaW50YCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdPQXV0aElzc3VlcicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLm9hdXRoSXNzdWVyLFxuICAgICAgZGVzY3JpcHRpb246ICdPQXV0aCBJc3N1ZXIgVVJMJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1PQXV0aElzc3VlcmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnT0F1dGhEaXNjb3ZlcnlVcmwnLCB7XG4gICAgICB2YWx1ZTogYCR7dGhpcy5vYXV0aElzc3Vlcn0vLndlbGwta25vd24vb3BlbmlkLWNvbmZpZ3VyYXRpb25gLFxuICAgICAgZGVzY3JpcHRpb246ICdPQXV0aCBEaXNjb3ZlcnkgVVJMIGZvciBNMk0gYXV0aGVudGljYXRpb24nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LU9BdXRoRGlzY292ZXJ5VXJsYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBdXRoZW50aWNhdGVkUm9sZUFybicsIHtcbiAgICAgIHZhbHVlOiBhdXRoZW50aWNhdGVkUm9sZS5yb2xlQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBdXRoZW50aWNhdGVkIFJvbGUgQVJOJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBZG1pbkVtYWlsJywge1xuICAgICAgdmFsdWU6IHByb3BzLmFkbWluRW1haWwsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FkbWluIHVzZXIgZW1haWwgKHRlbXBvcmFyeSBwYXNzd29yZCBzZW50IHZpYSBlbWFpbCknLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FkbWluVXNlcm5hbWUnLCB7XG4gICAgICB2YWx1ZTogJ2FkbWluJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQWRtaW4gdXNlcm5hbWUnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FkbWluR3JvdXBOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuYWRtaW5Hcm91cE5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gZ3JvdXAgd2hvc2UgbWVtYmVycyByZXNvbHZlIHRvIHRoZSBBZG1pbiByb2xlJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1BZG1pbkdyb3VwTmFtZWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUm9sZUNsYWltTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnJvbGVDbGFpbU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NjYWxhciByb2xlIGNsYWltIGluamVjdGVkIGludG8gaXNzdWVkIHRva2VucyBieSB0aGUgUHJlIFRva2VuIEdlbmVyYXRpb24gTGFtYmRhJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Sb2xlQ2xhaW1OYW1lYCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPQXV0aCBQcm92aWRlciAtIENyZWF0ZWQgYnkgZXh0ZXJuYWwgUHl0aG9uIHNjcmlwdCBhZnRlciBzdGFjayBkZXBsb3lcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICB0aGlzLm9hdXRoUHJvdmlkZXJOYW1lID0gJ2Nsb3Vkb3BzLW1jcC1vYXV0aC1wcm92aWRlcic7XG4gICAgdGhpcy5vYXV0aFByb3ZpZGVyQXJuID0gJ0NSRUFURURfQllfU0NSSVBUJzsgLy8gV2lsbCBiZSByZWFkIGZyb20gb2F1dGgtcHJvdmlkZXItYXJuLnR4dFxuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ09BdXRoUHJvdmlkZXJOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMub2F1dGhQcm92aWRlck5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ09BdXRoIFByb3ZpZGVyIE5hbWUgKGNyZWF0ZWQgYnkgc2NyaXB0cy9jcmVhdGUtb2F1dGgtcHJvdmlkZXIucHkpJyxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDREstTmFnIFN1cHByZXNzaW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIENvZ25pdG8gVXNlciBQb29sIHN1cHByZXNzaW9uc1xuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyh1c2VyUG9vbCwgW1xuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1DT0cyJyxcbiAgICAgICAgcmVhc29uOiAnTUZBIG5vdCBlbmZvcmNlZCBmb3IgZGVtby9kZXZlbG9wbWVudCBlbnZpcm9ubWVudC4gUHJvZHVjdGlvbiBkZXBsb3ltZW50cyBzaG91bGQgZW5hYmxlIE1GQSBmb3IgZW5oYW5jZWQgc2VjdXJpdHkuJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUNPRzMnLFxuICAgICAgICByZWFzb246ICdBZHZhbmNlZCBzZWN1cml0eSBmZWF0dXJlcyAoY29tcHJvbWlzZWQgY3JlZGVudGlhbHMgY2hlY2spIG5vdCByZXF1aXJlZCBmb3IgZGVtby9kZXZlbG9wbWVudCBlbnZpcm9ubWVudC4gUHJvZHVjdGlvbiBkZXBsb3ltZW50cyBzaG91bGQgZW5hYmxlIEFkdmFuY2VkU2VjdXJpdHlNb2RlLicsXG4gICAgICB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgLy8gUHJlIFRva2VuIEdlbmVyYXRpb24gTGFtYmRhIHN1cHByZXNzaW9uc1xuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhwcmVUb2tlbkdlbmVyYXRpb25GbiwgW1xuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JyxcbiAgICAgICAgcmVhc29uOiAnQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIG1hbmFnZWQgcG9saWN5IGlzIEFXUyBiZXN0IHByYWN0aWNlIGZvciB0aGUgUHJlIFRva2VuIEdlbmVyYXRpb24gTGFtYmRhIGV4ZWN1dGlvbiByb2xlIChDbG91ZFdhdGNoIExvZ3MgYWNjZXNzIG9ubHkpJyxcbiAgICAgICAgYXBwbGllc1RvOiBbJ1BvbGljeTo6YXJuOjxBV1M6OlBhcnRpdGlvbj46aWFtOjphd3M6cG9saWN5L3NlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUnXSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUwxJyxcbiAgICAgICAgcmVhc29uOiAnUHJlIFRva2VuIEdlbmVyYXRpb24gTGFtYmRhIHBpbm5lZCB0byBQeXRob24gMy4xMiwgY29uc2lzdGVudCB3aXRoIHRoZSBvdGhlciBQeXRob24gTGFtYmRhcyBpbiB0aGlzIHByb2plY3QnLFxuICAgICAgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIC8vIEF1dGhlbnRpY2F0ZWQgUm9sZSBzdXBwcmVzc2lvbnNcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoYXV0aGVudGljYXRlZFJvbGUsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ0dyYW50IHNjb3BlZCB0byB0aGUgbWFpbiBydW50aW1lIG9ubHkgKGNsb3Vkb3BzX3J1bnRpbWUqKTsgdGhlIHRyYWlsaW5nIHNlc3Npb24taWQgd2lsZGNhcmQgaXMgcmVxdWlyZWQgZm9yIEFnZW50Q29yZSBydW50aW1lIGludm9jYXRpb24gdG8gc3VwcG9ydCBhbGwgc2Vzc2lvbiBJRHMgYW5kIGNvbnZlcnNhdGlvbiB0dXJucyAocnVudGltZSBBUk4gd2l0aCAvKiBzdWZmaXgpLiBGZWF0dXJlOiBnYXRld2F5LXNlY3VyaXR5LWhhcmRlbmluZyAoUmVxdWlyZW1lbnQgNi4xKS4nLFxuICAgICAgfSxcbiAgICBdLCB0cnVlKTtcblxuXG5cbiAgICAvLyBTdGFjay1sZXZlbCBzdXBwcmVzc2lvbnMgZm9yIENESy1jcmVhdGVkIExhbWJkYSBmdW5jdGlvbnMgKENvZ25pdG8gZG9tYWluIGN1c3RvbSByZXNvdXJjZSlcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkU3RhY2tTdXBwcmVzc2lvbnModGhpcywgW1xuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JyxcbiAgICAgICAgcmVhc29uOiAnQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIG1hbmFnZWQgcG9saWN5IGlzIEFXUyBiZXN0IHByYWN0aWNlIGZvciBMYW1iZGEgZnVuY3Rpb25zIGNyZWF0ZWQgYnkgQ0RLIGZvciBDb2duaXRvIGRvbWFpbiBjdXN0b20gcmVzb3VyY2UnLFxuICAgICAgICBhcHBsaWVzVG86IFsnUG9saWN5Ojphcm46PEFXUzo6UGFydGl0aW9uPjppYW06OmF3czpwb2xpY3kvc2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZSddLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtTDEnLFxuICAgICAgICByZWFzb246ICdMYW1iZGEgZnVuY3Rpb24gaXMgY3JlYXRlZCBhbmQgbWFuYWdlZCBieSBDREsgZm9yIENvZ25pdG8gZG9tYWluIGN1c3RvbSByZXNvdXJjZSAtIHJ1bnRpbWUgaXMgYXV0b21hdGljYWxseSB1cGRhdGVkIGJ5IENESycsXG4gICAgICB9LFxuICAgIF0pO1xuICB9XG59XG4iXX0=