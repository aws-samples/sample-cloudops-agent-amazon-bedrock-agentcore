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
        // Unauthenticated Role - no permissions.
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
        // Intentionally NO inline policy on the unauthenticated role. IAM is
        // default-deny, so a role with zero Allow statements already grants
        // nothing — this is equivalent to (and safer than) an explicit
        // `Deny */*`, which an overly-broad deny can interfere with future role
        // changes. The identity pool also sets allowUnauthenticatedIdentities:
        // false, so this role is not assumable in practice.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXV0aC1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImF1dGgtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLGlFQUFtRDtBQUNuRCx5REFBMkM7QUFDM0MsK0RBQWlEO0FBRWpELDJDQUE2QjtBQUM3QixxQ0FBMEM7QUFFMUM7Ozs7O0dBS0c7QUFDSCxNQUFNLGdCQUFnQixHQUFHLGdCQUFnQixDQUFDO0FBTTFDLE1BQWEsU0FBVSxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBaUJ0QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXFCO1FBQzdELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBTjFCLHlFQUF5RTtRQUN6RCxtQkFBYyxHQUFXLGdCQUFnQixDQUFDO1FBQzFELHFFQUFxRTtRQUNyRCxrQkFBYSxHQUFXLE1BQU0sQ0FBQztRQUs3QywyQ0FBMkM7UUFDM0Msb0JBQW9CO1FBQ3BCLDJDQUEyQztRQUUzQyxNQUFNLFFBQVEsR0FBRyxJQUFJLE9BQU8sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQzlELFlBQVksRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLFFBQVE7WUFDdkMsaUJBQWlCLEVBQUUsS0FBSztZQUN4QixhQUFhLEVBQUU7Z0JBQ2IsS0FBSyxFQUFFLElBQUk7Z0JBQ1gsUUFBUSxFQUFFLElBQUk7YUFDZjtZQUNELFVBQVUsRUFBRTtnQkFDVixLQUFLLEVBQUUsSUFBSTthQUNaO1lBQ0QsY0FBYyxFQUFFO2dCQUNkLFlBQVksRUFBRSx1Q0FBdUM7Z0JBQ3JELFNBQVMsRUFBRTtvQkFDVCxvQ0FBb0M7b0JBQ3BDLDBHQUEwRztvQkFDMUcsT0FBTztvQkFDUCxrQ0FBa0M7b0JBQ2xDLDhIQUE4SDtvQkFDOUgsT0FBTztvQkFDUCw0Q0FBNEM7b0JBQzVD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QUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxvSEFBb0g7YUFDN0g7WUFDRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsc0tBQXNLO2FBQy9LO1NBQ0YsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUVULDJDQUEyQztRQUMzQyx5QkFBZSxDQUFDLHVCQUF1QixDQUFDLG9CQUFvQixFQUFFO1lBQzVEO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxrSkFBa0o7Z0JBQzFKLFNBQVMsRUFBRSxDQUFDLHVGQUF1RixDQUFDO2FBQ3JHO1lBQ0Q7Z0JBQ0UsRUFBRSxFQUFFLGlCQUFpQjtnQkFDckIsTUFBTSxFQUFFLDZHQUE2RzthQUN0SDtTQUNGLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFFVCxrQ0FBa0M7UUFDbEMseUJBQWUsQ0FBQyx1QkFBdUIsQ0FBQyxpQkFBaUIsRUFBRTtZQUN6RDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsaVJBQWlSO2FBQzFSO1NBQ0YsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUlULDZGQUE2RjtRQUM3Rix5QkFBZSxDQUFDLG9CQUFvQixDQUFDLElBQUksRUFBRTtZQUN6QztnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsd0lBQXdJO2dCQUNoSixTQUFTLEVBQUUsQ0FBQyx1RkFBdUYsQ0FBQzthQUNyRztZQUNEO2dCQUNFLEVBQUUsRUFBRSxpQkFBaUI7Z0JBQ3JCLE1BQU0sRUFBRSw0SEFBNEg7YUFDckk7U0FDRixDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUF6Y0QsOEJBeWNDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGNvZ25pdG8gZnJvbSAnYXdzLWNkay1saWIvYXdzLWNvZ25pdG8nO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgTmFnU3VwcHJlc3Npb25zIH0gZnJvbSAnY2RrLW5hZyc7XG5cbi8qKlxuICogTmFtZSBvZiB0aGUgQ29nbml0byBncm91cCB3aG9zZSBtZW1iZXJzIGFyZSBkZXNpZ25hdGVkIHRoZSBBZG1pbiByb2xlLlxuICogVGhlIFByZSBUb2tlbiBHZW5lcmF0aW9uIExhbWJkYSBtYXBzIG1lbWJlcnNoaXAgb2YgdGhpcyBncm91cCB0byB0aGUgc2NhbGFyXG4gKiBgcm9sZWAgY2xhaW0gKFwiYWRtaW5cIik7IGFsbCBvdGhlciB1c2VycyByZXNvbHZlIHRvIFwibm9uYWRtaW5cIi5cbiAqIEZlYXR1cmU6IGdhdGV3YXktdG9vbC1hY2Nlc3MtY29udHJvbCAoUmVxdWlyZW1lbnQgMS4xKS5cbiAqL1xuY29uc3QgQURNSU5fR1JPVVBfTkFNRSA9ICdBZG1pbmlzdHJhdG9ycyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0aFN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIGFkbWluRW1haWw6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEF1dGhTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSB1c2VyUG9vbElkOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSB1c2VyUG9vbENsaWVudElkOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBpZGVudGl0eVBvb2xJZDogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgdXNlclBvb2xBcm46IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IHVzZXJQb29sUHJvdmlkZXJOYW1lOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBvYXV0aENsaWVudElkOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBvYXV0aFRva2VuRW5kcG9pbnQ6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IG9hdXRoQXV0aG9yaXphdGlvbkVuZHBvaW50OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBvYXV0aElzc3Vlcjogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgb2F1dGhQcm92aWRlck5hbWU6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IG9hdXRoUHJvdmlkZXJBcm46IHN0cmluZztcbiAgLyoqIE5hbWUgb2YgdGhlIENvZ25pdG8gZ3JvdXAgd2hvc2UgbWVtYmVycyByZXNvbHZlIHRvIHRoZSBBZG1pbiByb2xlLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYWRtaW5Hcm91cE5hbWU6IHN0cmluZyA9IEFETUlOX0dST1VQX05BTUU7XG4gIC8qKiBOYW1lIG9mIHRoZSBzY2FsYXIgcm9sZSBjbGFpbSBpbmplY3RlZCBpbnRvIHRoZSBpc3N1ZWQgdG9rZW5zLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcm9sZUNsYWltTmFtZTogc3RyaW5nID0gJ3JvbGUnO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBdXRoU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENvZ25pdG8gVXNlciBQb29sXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgdXNlclBvb2wgPSBuZXcgY29nbml0by5Vc2VyUG9vbCh0aGlzLCAnQ2xvdWRPcHNVc2VyUG9vbCcsIHtcbiAgICAgIHVzZXJQb29sTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LXVzZXJzYCxcbiAgICAgIHNlbGZTaWduVXBFbmFibGVkOiBmYWxzZSxcbiAgICAgIHNpZ25JbkFsaWFzZXM6IHtcbiAgICAgICAgZW1haWw6IHRydWUsXG4gICAgICAgIHVzZXJuYW1lOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIGF1dG9WZXJpZnk6IHtcbiAgICAgICAgZW1haWw6IHRydWUsXG4gICAgICB9LFxuICAgICAgdXNlckludml0YXRpb246IHtcbiAgICAgICAgZW1haWxTdWJqZWN0OiAnWW91ciBDbG91ZE9wcyBBZ2VudCBMb2dpbiBDcmVkZW50aWFscycsXG4gICAgICAgIGVtYWlsQm9keTogW1xuICAgICAgICAgICc8aDI+V2VsY29tZSB0byBDbG91ZE9wcyBBZ2VudDwvaDI+JyxcbiAgICAgICAgICAnPHA+WW91ciBhZG1pbiBhY2NvdW50IGhhcyBiZWVuIGNyZWF0ZWQuIFlvdSB3aWxsIGJlIHByb21wdGVkIHRvIGNoYW5nZSB5b3VyIHBhc3N3b3JkIG9uIGZpcnN0IGxvZ2luLjwvcD4nLFxuICAgICAgICAgICc8YnIvPicsXG4gICAgICAgICAgJzxwPjxzdHJvbmc+VXNlcm5hbWU8L3N0cm9uZz48L3A+JyxcbiAgICAgICAgICAnPHAgc3R5bGU9XCJmb250LWZhbWlseTogbW9ub3NwYWNlOyBmb250LXNpemU6IDE2cHg7IGJhY2tncm91bmQ6ICNmMGYwZjA7IHBhZGRpbmc6IDhweDsgZGlzcGxheTogaW5saW5lLWJsb2NrO1wiPnt1c2VybmFtZX08L3A+JyxcbiAgICAgICAgICAnPGJyLz4nLFxuICAgICAgICAgICc8cD48c3Ryb25nPlRlbXBvcmFyeSBQYXNzd29yZDwvc3Ryb25nPjwvcD4nLFxuICAgICAgICAgICc8cCBzdHlsZT1cImZvbnQtZmFtaWx5OiBtb25vc3BhY2U7IGZvbnQtc2l6ZTogMTZweDsgYmFja2dyb3VuZDogI2YwZjBmMDsgcGFkZGluZzogOHB4OyBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7XCI+eyMjIyN9PC9wPicsXG4gICAgICAgIF0uam9pbignXFxuJyksXG4gICAgICB9LFxuICAgICAgcGFzc3dvcmRQb2xpY3k6IHtcbiAgICAgICAgbWluTGVuZ3RoOiA4LFxuICAgICAgICByZXF1aXJlTG93ZXJjYXNlOiB0cnVlLFxuICAgICAgICByZXF1aXJlVXBwZXJjYXNlOiB0cnVlLFxuICAgICAgICByZXF1aXJlRGlnaXRzOiB0cnVlLFxuICAgICAgICByZXF1aXJlU3ltYm9sczogdHJ1ZSwgLy8gQWRkIHN5bWJvbCByZXF1aXJlbWVudCBmb3Igc3Ryb25nZXIgc2VjdXJpdHlcbiAgICAgIH0sXG4gICAgICBhY2NvdW50UmVjb3Zlcnk6IGNvZ25pdG8uQWNjb3VudFJlY292ZXJ5LkVNQUlMX09OTFksXG4gICAgICAvLyBUaGUgRXNzZW50aWFscyBmZWF0dXJlIHBsYW4gaXMgcmVxdWlyZWQgZm9yIHRoZSBWMl8wIFByZSBUb2tlblxuICAgICAgLy8gR2VuZXJhdGlvbiB0cmlnZ2VyLCB3aGljaCBpcyB3aGF0IGVuYWJsZXMgYWNjZXNzLXRva2VuIChub3QganVzdFxuICAgICAgLy8gSUQtdG9rZW4pIGNsYWltIGN1c3RvbWl6YXRpb24uIFRoZSBgcm9sZWAgY2xhaW0gbXVzdCByZWFjaCB0aGVcbiAgICAgIC8vIGFjY2VzcyB0b2tlbiBiZWNhdXNlIHRoZSBBZ2VudCBSdW50aW1lIGZvcndhcmRzIGl0IHRvIHRoZSBHYXRld2F5LlxuICAgICAgLy8gRmVhdHVyZTogZ2F0ZXdheS10b29sLWFjY2Vzcy1jb250cm9sIChSZXF1aXJlbWVudCAxLjEpLlxuICAgICAgZmVhdHVyZVBsYW46IGNvZ25pdG8uRmVhdHVyZVBsYW4uRVNTRU5USUFMUyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICB0aGlzLnVzZXJQb29sSWQgPSB1c2VyUG9vbC51c2VyUG9vbElkO1xuICAgIHRoaXMudXNlclBvb2xBcm4gPSB1c2VyUG9vbC51c2VyUG9vbEFybjtcbiAgICB0aGlzLnVzZXJQb29sUHJvdmlkZXJOYW1lID0gdXNlclBvb2wudXNlclBvb2xQcm92aWRlck5hbWU7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gUHJlIFRva2VuIEdlbmVyYXRpb24gTGFtYmRhICsgcm9sZSBjbGFpbVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBJbmplY3RzIGEgc2NhbGFyIGByb2xlYCBjbGFpbSAoXCJhZG1pblwiIHwgXCJub25hZG1pblwiKSBpbnRvIHRoZSB1c2VyJ3NcbiAgICAvLyB0b2tlbnMgYmFzZWQgb24gYEFkbWluaXN0cmF0b3JzYCBncm91cCBtZW1iZXJzaGlwLCBzbyB0aGUgQWdlbnRDb3JlXG4gICAgLy8gR2F0ZXdheSdzIENlZGFyIHBvbGljeSBjYW4gYXV0aG9yaXplIHRvb2wgYWNjZXNzIGJ5IHJvbGUuIFRoZSByb2xlIGlzXG4gICAgLy8gZGVyaXZlZCBzb2xlbHkgZnJvbSB2ZXJpZmllZCBncm91cCBtZW1iZXJzaGlwLCBuZXZlciBhIGNsaWVudC1zdXBwbGllZFxuICAgIC8vIHZhbHVlLiBGZWF0dXJlOiBnYXRld2F5LXRvb2wtYWNjZXNzLWNvbnRyb2wgKFJlcXVpcmVtZW50IDEuMSkuXG4gICAgY29uc3QgcHJlVG9rZW5HZW5lcmF0aW9uRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdQcmVUb2tlbkdlbmVyYXRpb25GdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEyLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXIuaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9wcmUtdG9rZW4tZ2VuZXJhdGlvbicpKSxcbiAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIFByZSBUb2tlbiBHZW5lcmF0aW9uIHRyaWdnZXI6IG1hcHMgQWRtaW5pc3RyYXRvcnMgZ3JvdXAgbWVtYmVyc2hpcCB0byBhIHNjYWxhciByb2xlIGNsYWltJyxcbiAgICB9KTtcblxuICAgIC8vIEF0dGFjaCBhcyB0aGUgUHJlIFRva2VuIEdlbmVyYXRpb24gdHJpZ2dlciB1c2luZyB0aGUgVjJfMCBldmVudCwgd2hpY2ggaXNcbiAgICAvLyB3aGF0IGVuYWJsZXMgYWNjZXNzLXRva2VuIGNsYWltIGN1c3RvbWl6YXRpb24gKHJlcXVpcmVzIHRoZSBFc3NlbnRpYWxzXG4gICAgLy8gZmVhdHVyZSBwbGFuIHNldCBvbiB0aGUgVXNlciBQb29sIGFib3ZlKS4gYWRkVHJpZ2dlciBhbHNvIGdyYW50cyBDb2duaXRvXG4gICAgLy8gcGVybWlzc2lvbiB0byBpbnZva2UgdGhlIGZ1bmN0aW9uLlxuICAgIHVzZXJQb29sLmFkZFRyaWdnZXIoXG4gICAgICBjb2duaXRvLlVzZXJQb29sT3BlcmF0aW9uLlBSRV9UT0tFTl9HRU5FUkFUSU9OX0NPTkZJRyxcbiAgICAgIHByZVRva2VuR2VuZXJhdGlvbkZuLFxuICAgICAgY29nbml0by5MYW1iZGFWZXJzaW9uLlYyXzAsXG4gICAgKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDb2duaXRvIEdyb3VwIOKAlCBBZG1pbmlzdHJhdG9ycyAoQWRtaW4gcm9sZSlcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgYWRtaW5pc3RyYXRvcnNHcm91cCA9IG5ldyBjb2duaXRvLkNmblVzZXJQb29sR3JvdXAodGhpcywgJ0FkbWluaXN0cmF0b3JzR3JvdXAnLCB7XG4gICAgICB1c2VyUG9vbElkOiB1c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgZ3JvdXBOYW1lOiB0aGlzLmFkbWluR3JvdXBOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdNZW1iZXJzIG9mIHRoaXMgZ3JvdXAgcmVzb2x2ZSB0byB0aGUgQWRtaW4gcm9sZSAoZnVsbCB0b29sIGFjY2VzcykgYXQgdGhlIEFnZW50Q29yZSBHYXRld2F5LicsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgQ29nbml0byBEb21haW4gZm9yIE9BdXRoXG4gICAgY29uc3QgdXNlclBvb2xEb21haW4gPSB1c2VyUG9vbC5hZGREb21haW4oJ0Nsb3VkT3BzRG9tYWluJywge1xuICAgICAgY29nbml0b0RvbWFpbjoge1xuICAgICAgICBkb21haW5QcmVmaXg6IGBjbG91ZG9wcy1tY3AtJHt0aGlzLmFjY291bnR9LSR7Y2RrLk5hbWVzLnVuaXF1ZUlkKHRoaXMpLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW15hLXowLTldL2csICcnKS5zdWJzdHJpbmcoMCwgOCl9YCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBPQXV0aCBlbmRwb2ludHMgZm9yIEdhdGV3YXkgYW5kIEFnZW50Q29yZSBJZGVudGl0eVxuICAgIGNvbnN0IGRvbWFpblVybCA9IGBodHRwczovLyR7dXNlclBvb2xEb21haW4uZG9tYWluTmFtZX0uYXV0aC4ke3RoaXMucmVnaW9ufS5hbWF6b25jb2duaXRvLmNvbWA7XG4gICAgdGhpcy5vYXV0aFRva2VuRW5kcG9pbnQgPSBgJHtkb21haW5Vcmx9L29hdXRoMi90b2tlbmA7XG4gICAgdGhpcy5vYXV0aEF1dGhvcml6YXRpb25FbmRwb2ludCA9IGAke2RvbWFpblVybH0vb2F1dGgyL2F1dGhvcml6ZWA7XG4gICAgdGhpcy5vYXV0aElzc3VlciA9IGBodHRwczovL2NvZ25pdG8taWRwLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vJHt1c2VyUG9vbC51c2VyUG9vbElkfWA7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gVXNlciBQb29sIENsaWVudHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBDcmVhdGUgUmVzb3VyY2UgU2VydmVyIGZvciBNMk0gYXV0aGVudGljYXRpb24gKHJlcXVpcmVkIGZvciBjbGllbnRfY3JlZGVudGlhbHMgZmxvdylcbiAgICBjb25zdCBtY3BJbnZva2VTY29wZTogY29nbml0by5SZXNvdXJjZVNlcnZlclNjb3BlID0ge1xuICAgICAgc2NvcGVOYW1lOiAnaW52b2tlJyxcbiAgICAgIHNjb3BlRGVzY3JpcHRpb246ICdJbnZva2UgTUNQIHJ1bnRpbWUgdG9vbHMnLFxuICAgIH07XG5cbiAgICBjb25zdCByZXNvdXJjZVNlcnZlciA9IHVzZXJQb29sLmFkZFJlc291cmNlU2VydmVyKCdDbG91ZE9wc1Jlc291cmNlU2VydmVyJywge1xuICAgICAgaWRlbnRpZmllcjogJ21jcC1ydW50aW1lLXNlcnZlcicsXG4gICAgICB1c2VyUG9vbFJlc291cmNlU2VydmVyTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LXJlc291cmNlLXNlcnZlcmAsXG4gICAgICBzY29wZXM6IFttY3BJbnZva2VTY29wZV0sXG4gICAgfSk7XG5cbiAgICAvLyBDbGllbnQgZm9yIGZyb250ZW5kIHVzZXJzIChubyBzZWNyZXQpXG4gICAgY29uc3QgdXNlclBvb2xDbGllbnQgPSB1c2VyUG9vbC5hZGRDbGllbnQoJ0Nsb3VkT3BzVXNlclBvb2xDbGllbnQnLCB7XG4gICAgICB1c2VyUG9vbENsaWVudE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1jbGllbnRgLFxuICAgICAgZ2VuZXJhdGVTZWNyZXQ6IGZhbHNlLFxuICAgICAgYXV0aEZsb3dzOiB7XG4gICAgICAgIHVzZXJQYXNzd29yZDogdHJ1ZSxcbiAgICAgICAgdXNlclNycDogdHJ1ZSxcbiAgICAgICAgY3VzdG9tOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIG9BdXRoOiB7XG4gICAgICAgIGZsb3dzOiB7XG4gICAgICAgICAgYXV0aG9yaXphdGlvbkNvZGVHcmFudDogdHJ1ZSxcbiAgICAgICAgICBpbXBsaWNpdENvZGVHcmFudDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAgc2NvcGVzOiBbXG4gICAgICAgICAgY29nbml0by5PQXV0aFNjb3BlLkVNQUlMLFxuICAgICAgICAgIGNvZ25pdG8uT0F1dGhTY29wZS5PUEVOSUQsXG4gICAgICAgICAgY29nbml0by5PQXV0aFNjb3BlLlBST0ZJTEUsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgdGhpcy51c2VyUG9vbENsaWVudElkID0gdXNlclBvb2xDbGllbnQudXNlclBvb2xDbGllbnRJZDtcblxuICAgIC8vIE0yTSBDbGllbnQgZm9yIEdhdGV3YXkg4oaSIE1DUCBTZXJ2ZXIgUnVudGltZXMgKHdpdGggc2VjcmV0IGZvciBjbGllbnQgY3JlZGVudGlhbHMgZmxvdylcbiAgICBjb25zdCBtMm1DbGllbnQgPSB1c2VyUG9vbC5hZGRDbGllbnQoJ0Nsb3VkT3BzTTJNQ2xpZW50Jywge1xuICAgICAgdXNlclBvb2xDbGllbnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tbTJtLWNsaWVudGAsXG4gICAgICBnZW5lcmF0ZVNlY3JldDogdHJ1ZSxcbiAgICAgIGF1dGhGbG93czoge1xuICAgICAgICB1c2VyUGFzc3dvcmQ6IGZhbHNlLFxuICAgICAgICB1c2VyU3JwOiBmYWxzZSxcbiAgICAgICAgY3VzdG9tOiBmYWxzZSxcbiAgICAgIH0sXG4gICAgICBvQXV0aDoge1xuICAgICAgICBmbG93czoge1xuICAgICAgICAgIGNsaWVudENyZWRlbnRpYWxzOiB0cnVlLCAvLyBNMk0gZmxvd1xuICAgICAgICB9LFxuICAgICAgICBzY29wZXM6IFtcbiAgICAgICAgICBjb2duaXRvLk9BdXRoU2NvcGUucmVzb3VyY2VTZXJ2ZXIocmVzb3VyY2VTZXJ2ZXIsIG1jcEludm9rZVNjb3BlKSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLm9hdXRoQ2xpZW50SWQgPSBtMm1DbGllbnQudXNlclBvb2xDbGllbnRJZDtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBJZGVudGl0eSBQb29sXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgaWRlbnRpdHlQb29sID0gbmV3IGNvZ25pdG8uQ2ZuSWRlbnRpdHlQb29sKHRoaXMsICdDbG91ZE9wc0lkZW50aXR5UG9vbCcsIHtcbiAgICAgIGlkZW50aXR5UG9vbE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lLnJlcGxhY2UoL1teYS16QS1aMC05XS9nLCAnXycpfV9pZGVudGl0eV9wb29sYCxcbiAgICAgIGFsbG93VW5hdXRoZW50aWNhdGVkSWRlbnRpdGllczogZmFsc2UsXG4gICAgICBjb2duaXRvSWRlbnRpdHlQcm92aWRlcnM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGNsaWVudElkOiB1c2VyUG9vbENsaWVudC51c2VyUG9vbENsaWVudElkLFxuICAgICAgICAgIHByb3ZpZGVyTmFtZTogdXNlclBvb2wudXNlclBvb2xQcm92aWRlck5hbWUsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBjbGllbnRJZDogbTJtQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICAgICAgcHJvdmlkZXJOYW1lOiB1c2VyUG9vbC51c2VyUG9vbFByb3ZpZGVyTmFtZSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmlkZW50aXR5UG9vbElkID0gaWRlbnRpdHlQb29sLnJlZjtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBJQU0gUm9sZXMgZm9yIElkZW50aXR5IFBvb2xcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBBdXRoZW50aWNhdGVkIFJvbGUgLSBDYW4gaW52b2tlIE1haW4gQWdlbnQgUnVudGltZVxuICAgIGNvbnN0IGF1dGhlbnRpY2F0ZWRSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdBdXRoZW50aWNhdGVkUm9sZScsIHtcbiAgICAgIC8vIE5vIGV4cGxpY2l0IHJvbGVOYW1lOiBJQU0gcm9sZSBuYW1lcyBhcmUgYWNjb3VudC1HTE9CQUwsIHNvIGEgZml4ZWRcbiAgICAgIC8vIG5hbWUgY29sbGlkZXMgd2hlbiB0aGlzIHN0YWNrIGlzIGRlcGxveWVkIHRvIG1vcmUgdGhhbiBvbmUgcmVnaW9uIGluXG4gICAgICAvLyB0aGUgc2FtZSBhY2NvdW50LiBMZXR0aW5nIENESyBnZW5lcmF0ZSB0aGUgcGh5c2ljYWwgbmFtZSBrZWVwcyBpdFxuICAgICAgLy8gdW5pcXVlIHBlciBkZXBsb3ltZW50LiBUaGUgcm9sZSBpcyBjb25zdW1lZCBieSBBUk4gKGlkZW50aXR5IHBvb2xcbiAgICAgIC8vIGF0dGFjaG1lbnQgKyB0aGUgQXV0aGVudGljYXRlZFJvbGVBcm4gb3V0cHV0KSwgbmV2ZXIgYnkgbmFtZS5cbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5GZWRlcmF0ZWRQcmluY2lwYWwoXG4gICAgICAgICdjb2duaXRvLWlkZW50aXR5LmFtYXpvbmF3cy5jb20nLFxuICAgICAgICB7XG4gICAgICAgICAgU3RyaW5nRXF1YWxzOiB7XG4gICAgICAgICAgICAnY29nbml0by1pZGVudGl0eS5hbWF6b25hd3MuY29tOmF1ZCc6IGlkZW50aXR5UG9vbC5yZWYsXG4gICAgICAgICAgfSxcbiAgICAgICAgICAnRm9yQW55VmFsdWU6U3RyaW5nTGlrZSc6IHtcbiAgICAgICAgICAgICdjb2duaXRvLWlkZW50aXR5LmFtYXpvbmF3cy5jb206YW1yJzogJ2F1dGhlbnRpY2F0ZWQnLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgICdzdHM6QXNzdW1lUm9sZVdpdGhXZWJJZGVudGl0eSdcbiAgICAgICksXG4gICAgfSk7XG5cbiAgICAvLyBMZWFzdC1wcml2aWxlZ2UgZ3JhbnQ6IGZyb250ZW5kIHVzZXJzIG9ubHkgZXZlciBpbnZva2UgdGhlIG1haW4gYWdlbnRcbiAgICAvLyBydW50aW1lIChgY2xvdWRvcHNfcnVudGltZSpgKS4gVGhlIGRvd25zdHJlYW0gTUNQIHJ1bnRpbWVzIGFyZSByZWFjaGVkXG4gICAgLy8gR2F0ZXdheSAtPiB0YXJnZXQgdmlhIE9BdXRoLCBuZXZlciBkaXJlY3RseSBieSB0aGUgZnJvbnRlbmQgcHJpbmNpcGFsLFxuICAgIC8vIHNvIHRoZXkgYXJlIGludGVudGlvbmFsbHkgZXhjbHVkZWQgZnJvbSB0aGlzIGdyYW50LiBUaGUgdHJhaWxpbmcgYC8qYFxuICAgIC8vICh3aXRoaW4gdGhlIGBjbG91ZG9wc19ydW50aW1lKmAgd2lsZGNhcmQpIGNvdmVycyBhbGwgc2Vzc2lvbiBJRHMgYW5kXG4gICAgLy8gY29udmVyc2F0aW9uIHR1cm5zLiBGZWF0dXJlOiBnYXRld2F5LXNlY3VyaXR5LWhhcmRlbmluZyAoUmVxdWlyZW1lbnRzXG4gICAgLy8gNi4xLCA2LjIsIDYuMywgNi40LCA2LjUpLlxuICAgIGF1dGhlbnRpY2F0ZWRSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkludm9rZUFnZW50UnVudGltZScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRSdW50aW1lJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RSdW50aW1lcycsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgIGBhcm46YXdzOmJlZHJvY2stYWdlbnRjb3JlOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpydW50aW1lL2Nsb3Vkb3BzX3J1bnRpbWUqYCxcbiAgICAgIF0sXG4gICAgfSkpO1xuXG4gICAgLy8gVW5hdXRoZW50aWNhdGVkIFJvbGUgLSBubyBwZXJtaXNzaW9ucy5cbiAgICBjb25zdCB1bmF1dGhlbnRpY2F0ZWRSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdVbmF1dGhlbnRpY2F0ZWRSb2xlJywge1xuICAgICAgLy8gTm8gZXhwbGljaXQgcm9sZU5hbWUsIGZvciB0aGUgc2FtZSBhY2NvdW50LWdsb2JhbCBJQU0gdW5pcXVlbmVzc1xuICAgICAgLy8gcmVhc29uIGFzIHRoZSBhdXRoZW50aWNhdGVkIHJvbGUgYWJvdmUuXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uRmVkZXJhdGVkUHJpbmNpcGFsKFxuICAgICAgICAnY29nbml0by1pZGVudGl0eS5hbWF6b25hd3MuY29tJyxcbiAgICAgICAge1xuICAgICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICAgJ2NvZ25pdG8taWRlbnRpdHkuYW1hem9uYXdzLmNvbTphdWQnOiBpZGVudGl0eVBvb2wucmVmLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgJ0ZvckFueVZhbHVlOlN0cmluZ0xpa2UnOiB7XG4gICAgICAgICAgICAnY29nbml0by1pZGVudGl0eS5hbWF6b25hd3MuY29tOmFtcic6ICd1bmF1dGhlbnRpY2F0ZWQnLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgICdzdHM6QXNzdW1lUm9sZVdpdGhXZWJJZGVudGl0eSdcbiAgICAgICksXG4gICAgfSk7XG5cbiAgICAvLyBJbnRlbnRpb25hbGx5IE5PIGlubGluZSBwb2xpY3kgb24gdGhlIHVuYXV0aGVudGljYXRlZCByb2xlLiBJQU0gaXNcbiAgICAvLyBkZWZhdWx0LWRlbnksIHNvIGEgcm9sZSB3aXRoIHplcm8gQWxsb3cgc3RhdGVtZW50cyBhbHJlYWR5IGdyYW50c1xuICAgIC8vIG5vdGhpbmcg4oCUIHRoaXMgaXMgZXF1aXZhbGVudCB0byAoYW5kIHNhZmVyIHRoYW4pIGFuIGV4cGxpY2l0XG4gICAgLy8gYERlbnkgKi8qYCwgd2hpY2ggYW4gb3Zlcmx5LWJyb2FkIGRlbnkgY2FuIGludGVyZmVyZSB3aXRoIGZ1dHVyZSByb2xlXG4gICAgLy8gY2hhbmdlcy4gVGhlIGlkZW50aXR5IHBvb2wgYWxzbyBzZXRzIGFsbG93VW5hdXRoZW50aWNhdGVkSWRlbnRpdGllczpcbiAgICAvLyBmYWxzZSwgc28gdGhpcyByb2xlIGlzIG5vdCBhc3N1bWFibGUgaW4gcHJhY3RpY2UuXG5cbiAgICAvLyBBdHRhY2ggcm9sZXMgdG8gSWRlbnRpdHkgUG9vbFxuICAgIG5ldyBjb2duaXRvLkNmbklkZW50aXR5UG9vbFJvbGVBdHRhY2htZW50KHRoaXMsICdJZGVudGl0eVBvb2xSb2xlQXR0YWNobWVudCcsIHtcbiAgICAgIGlkZW50aXR5UG9vbElkOiBpZGVudGl0eVBvb2wucmVmLFxuICAgICAgcm9sZXM6IHtcbiAgICAgICAgYXV0aGVudGljYXRlZDogYXV0aGVudGljYXRlZFJvbGUucm9sZUFybixcbiAgICAgICAgdW5hdXRoZW50aWNhdGVkOiB1bmF1dGhlbnRpY2F0ZWRSb2xlLnJvbGVBcm4sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFkbWluIFVzZXJcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBjb25zdCBhZG1pblVzZXIgPSBuZXcgY29nbml0by5DZm5Vc2VyUG9vbFVzZXIodGhpcywgJ0FkbWluVXNlcicsIHtcbiAgICAgIHVzZXJQb29sSWQ6IHVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICB1c2VybmFtZTogJ2FkbWluJyxcbiAgICAgIHVzZXJBdHRyaWJ1dGVzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnZW1haWwnLFxuICAgICAgICAgIHZhbHVlOiBwcm9wcy5hZG1pbkVtYWlsLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ2VtYWlsX3ZlcmlmaWVkJyxcbiAgICAgICAgICB2YWx1ZTogJ3RydWUnLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIGRlc2lyZWREZWxpdmVyeU1lZGl1bXM6IFsnRU1BSUwnXSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCB0aGUgYm9vdHN0cmFwIGFkbWluIHVzZXIgdG8gdGhlIEFkbWluaXN0cmF0b3JzIGdyb3VwIHNvIGl0IHJlc29sdmVzXG4gICAgLy8gdG8gdGhlIEFkbWluIHJvbGUuIFRoZSBhdHRhY2htZW50IG11c3QgYmUgY3JlYXRlZCBhZnRlciBib3RoIHRoZSB1c2VyIGFuZFxuICAgIC8vIHRoZSBncm91cCBleGlzdC4gRmVhdHVyZTogZ2F0ZXdheS10b29sLWFjY2Vzcy1jb250cm9sIChSZXF1aXJlbWVudCAxLjEpLlxuICAgIGNvbnN0IGFkbWluR3JvdXBNZW1iZXJzaGlwID0gbmV3IGNvZ25pdG8uQ2ZuVXNlclBvb2xVc2VyVG9Hcm91cEF0dGFjaG1lbnQodGhpcywgJ0FkbWluVXNlckdyb3VwQXR0YWNobWVudCcsIHtcbiAgICAgIHVzZXJQb29sSWQ6IHVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICBncm91cE5hbWU6IHRoaXMuYWRtaW5Hcm91cE5hbWUsXG4gICAgICB1c2VybmFtZTogYWRtaW5Vc2VyLnVzZXJuYW1lIGFzIHN0cmluZyxcbiAgICB9KTtcbiAgICBhZG1pbkdyb3VwTWVtYmVyc2hpcC5hZGREZXBlbmRlbmN5KGFkbWluVXNlcik7XG4gICAgYWRtaW5Hcm91cE1lbWJlcnNoaXAuYWRkRGVwZW5kZW5jeShhZG1pbmlzdHJhdG9yc0dyb3VwKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPdXRwdXRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1VzZXJQb29sSWQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy51c2VyUG9vbElkLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIFVzZXIgUG9vbCBJRCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tVXNlclBvb2xJZGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVXNlclBvb2xDbGllbnRJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gVXNlciBQb29sIENsaWVudCBJRCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tVXNlclBvb2xDbGllbnRJZGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSWRlbnRpdHlQb29sSWQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5pZGVudGl0eVBvb2xJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBJZGVudGl0eSBQb29sIElEJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1JZGVudGl0eVBvb2xJZGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnVXNlclBvb2xBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy51c2VyUG9vbEFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBVc2VyIFBvb2wgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Vc2VyUG9vbEFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnT0F1dGhDbGllbnRJZCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLm9hdXRoQ2xpZW50SWQsXG4gICAgICBkZXNjcmlwdGlvbjogJ09BdXRoIENsaWVudCBJRCBmb3IgR2F0ZXdheScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tT0F1dGhDbGllbnRJZGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnT0F1dGhUb2tlbkVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IHRoaXMub2F1dGhUb2tlbkVuZHBvaW50LFxuICAgICAgZGVzY3JpcHRpb246ICdPQXV0aCBUb2tlbiBFbmRwb2ludCBmb3IgR2F0ZXdheScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tT0F1dGhUb2tlbkVuZHBvaW50YCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdPQXV0aEF1dGhvcml6YXRpb25FbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLm9hdXRoQXV0aG9yaXphdGlvbkVuZHBvaW50LFxuICAgICAgZGVzY3JpcHRpb246ICdPQXV0aCBBdXRob3JpemF0aW9uIEVuZHBvaW50JyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1PQXV0aEF1dGhvcml6YXRpb25FbmRwb2ludGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnT0F1dGhJc3N1ZXInLCB7XG4gICAgICB2YWx1ZTogdGhpcy5vYXV0aElzc3VlcixcbiAgICAgIGRlc2NyaXB0aW9uOiAnT0F1dGggSXNzdWVyIFVSTCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tT0F1dGhJc3N1ZXJgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ09BdXRoRGlzY292ZXJ5VXJsJywge1xuICAgICAgdmFsdWU6IGAke3RoaXMub2F1dGhJc3N1ZXJ9Ly53ZWxsLWtub3duL29wZW5pZC1jb25maWd1cmF0aW9uYCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnT0F1dGggRGlzY292ZXJ5IFVSTCBmb3IgTTJNIGF1dGhlbnRpY2F0aW9uJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1PQXV0aERpc2NvdmVyeVVybGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQXV0aGVudGljYXRlZFJvbGVBcm4nLCB7XG4gICAgICB2YWx1ZTogYXV0aGVudGljYXRlZFJvbGUucm9sZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXV0aGVudGljYXRlZCBSb2xlIEFSTicsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQWRtaW5FbWFpbCcsIHtcbiAgICAgIHZhbHVlOiBwcm9wcy5hZG1pbkVtYWlsLFxuICAgICAgZGVzY3JpcHRpb246ICdBZG1pbiB1c2VyIGVtYWlsICh0ZW1wb3JhcnkgcGFzc3dvcmQgc2VudCB2aWEgZW1haWwpJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBZG1pblVzZXJuYW1lJywge1xuICAgICAgdmFsdWU6ICdhZG1pbicsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FkbWluIHVzZXJuYW1lJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBZG1pbkdyb3VwTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmFkbWluR3JvdXBOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIGdyb3VwIHdob3NlIG1lbWJlcnMgcmVzb2x2ZSB0byB0aGUgQWRtaW4gcm9sZScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQWRtaW5Hcm91cE5hbWVgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1JvbGVDbGFpbU5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5yb2xlQ2xhaW1OYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdTY2FsYXIgcm9sZSBjbGFpbSBpbmplY3RlZCBpbnRvIGlzc3VlZCB0b2tlbnMgYnkgdGhlIFByZSBUb2tlbiBHZW5lcmF0aW9uIExhbWJkYScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tUm9sZUNsYWltTmFtZWAsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT0F1dGggUHJvdmlkZXIgLSBDcmVhdGVkIGJ5IGV4dGVybmFsIFB5dGhvbiBzY3JpcHQgYWZ0ZXIgc3RhY2sgZGVwbG95XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgdGhpcy5vYXV0aFByb3ZpZGVyTmFtZSA9ICdjbG91ZG9wcy1tY3Atb2F1dGgtcHJvdmlkZXInO1xuICAgIHRoaXMub2F1dGhQcm92aWRlckFybiA9ICdDUkVBVEVEX0JZX1NDUklQVCc7IC8vIFdpbGwgYmUgcmVhZCBmcm9tIG9hdXRoLXByb3ZpZGVyLWFybi50eHRcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdPQXV0aFByb3ZpZGVyTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLm9hdXRoUHJvdmlkZXJOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdPQXV0aCBQcm92aWRlciBOYW1lIChjcmVhdGVkIGJ5IHNjcmlwdHMvY3JlYXRlLW9hdXRoLXByb3ZpZGVyLnB5KScsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ0RLLU5hZyBTdXBwcmVzc2lvbnNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBDb2duaXRvIFVzZXIgUG9vbCBzdXBwcmVzc2lvbnNcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnModXNlclBvb2wsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtQ09HMicsXG4gICAgICAgIHJlYXNvbjogJ01GQSBub3QgZW5mb3JjZWQgZm9yIGRlbW8vZGV2ZWxvcG1lbnQgZW52aXJvbm1lbnQuIFByb2R1Y3Rpb24gZGVwbG95bWVudHMgc2hvdWxkIGVuYWJsZSBNRkEgZm9yIGVuaGFuY2VkIHNlY3VyaXR5LicsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1DT0czJyxcbiAgICAgICAgcmVhc29uOiAnQWR2YW5jZWQgc2VjdXJpdHkgZmVhdHVyZXMgKGNvbXByb21pc2VkIGNyZWRlbnRpYWxzIGNoZWNrKSBub3QgcmVxdWlyZWQgZm9yIGRlbW8vZGV2ZWxvcG1lbnQgZW52aXJvbm1lbnQuIFByb2R1Y3Rpb24gZGVwbG95bWVudHMgc2hvdWxkIGVuYWJsZSBBZHZhbmNlZFNlY3VyaXR5TW9kZS4nLFxuICAgICAgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIC8vIFByZSBUb2tlbiBHZW5lcmF0aW9uIExhbWJkYSBzdXBwcmVzc2lvbnNcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMocHJlVG9rZW5HZW5lcmF0aW9uRm4sIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNCcsXG4gICAgICAgIHJlYXNvbjogJ0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZSBtYW5hZ2VkIHBvbGljeSBpcyBBV1MgYmVzdCBwcmFjdGljZSBmb3IgdGhlIFByZSBUb2tlbiBHZW5lcmF0aW9uIExhbWJkYSBleGVjdXRpb24gcm9sZSAoQ2xvdWRXYXRjaCBMb2dzIGFjY2VzcyBvbmx5KScsXG4gICAgICAgIGFwcGxpZXNUbzogWydQb2xpY3k6OmFybjo8QVdTOjpQYXJ0aXRpb24+OmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlJ10sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1MMScsXG4gICAgICAgIHJlYXNvbjogJ1ByZSBUb2tlbiBHZW5lcmF0aW9uIExhbWJkYSBwaW5uZWQgdG8gUHl0aG9uIDMuMTIsIGNvbnNpc3RlbnQgd2l0aCB0aGUgb3RoZXIgUHl0aG9uIExhbWJkYXMgaW4gdGhpcyBwcm9qZWN0JyxcbiAgICAgIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICAvLyBBdXRoZW50aWNhdGVkIFJvbGUgc3VwcHJlc3Npb25zXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKGF1dGhlbnRpY2F0ZWRSb2xlLCBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICByZWFzb246ICdHcmFudCBzY29wZWQgdG8gdGhlIG1haW4gcnVudGltZSBvbmx5IChjbG91ZG9wc19ydW50aW1lKik7IHRoZSB0cmFpbGluZyBzZXNzaW9uLWlkIHdpbGRjYXJkIGlzIHJlcXVpcmVkIGZvciBBZ2VudENvcmUgcnVudGltZSBpbnZvY2F0aW9uIHRvIHN1cHBvcnQgYWxsIHNlc3Npb24gSURzIGFuZCBjb252ZXJzYXRpb24gdHVybnMgKHJ1bnRpbWUgQVJOIHdpdGggLyogc3VmZml4KS4gRmVhdHVyZTogZ2F0ZXdheS1zZWN1cml0eS1oYXJkZW5pbmcgKFJlcXVpcmVtZW50IDYuMSkuJyxcbiAgICAgIH0sXG4gICAgXSwgdHJ1ZSk7XG5cblxuXG4gICAgLy8gU3RhY2stbGV2ZWwgc3VwcHJlc3Npb25zIGZvciBDREstY3JlYXRlZCBMYW1iZGEgZnVuY3Rpb25zIChDb2duaXRvIGRvbWFpbiBjdXN0b20gcmVzb3VyY2UpXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNCcsXG4gICAgICAgIHJlYXNvbjogJ0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZSBtYW5hZ2VkIHBvbGljeSBpcyBBV1MgYmVzdCBwcmFjdGljZSBmb3IgTGFtYmRhIGZ1bmN0aW9ucyBjcmVhdGVkIGJ5IENESyBmb3IgQ29nbml0byBkb21haW4gY3VzdG9tIHJlc291cmNlJyxcbiAgICAgICAgYXBwbGllc1RvOiBbJ1BvbGljeTo6YXJuOjxBV1M6OlBhcnRpdGlvbj46aWFtOjphd3M6cG9saWN5L3NlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUnXSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUwxJyxcbiAgICAgICAgcmVhc29uOiAnTGFtYmRhIGZ1bmN0aW9uIGlzIGNyZWF0ZWQgYW5kIG1hbmFnZWQgYnkgQ0RLIGZvciBDb2duaXRvIGRvbWFpbiBjdXN0b20gcmVzb3VyY2UgLSBydW50aW1lIGlzIGF1dG9tYXRpY2FsbHkgdXBkYXRlZCBieSBDREsnLFxuICAgICAgfSxcbiAgICBdKTtcbiAgfVxufVxuIl19