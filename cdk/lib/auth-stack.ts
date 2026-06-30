import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';

/**
 * Name of the Cognito group whose members are designated the Admin role.
 * The Pre Token Generation Lambda maps membership of this group to the scalar
 * `role` claim ("admin"); all other users resolve to "nonadmin".
 * Feature: gateway-tool-access-control (Requirement 1.1).
 */
const ADMIN_GROUP_NAME = 'Administrators';

export interface AuthStackProps extends cdk.StackProps {
  adminEmail: string;
}

export class AuthStack extends cdk.Stack {
  public readonly userPoolId: string;
  public readonly userPoolClientId: string;
  public readonly identityPoolId: string;
  public readonly userPoolArn: string;
  public readonly userPoolProviderName: string;
  public readonly oauthClientId: string;
  public readonly oauthTokenEndpoint: string;
  public readonly oauthAuthorizationEndpoint: string;
  public readonly oauthIssuer: string;
  public readonly oauthProviderName: string;
  public readonly oauthProviderArn: string;
  /** Name of the Cognito group whose members resolve to the Admin role. */
  public readonly adminGroupName: string = ADMIN_GROUP_NAME;
  /** Name of the scalar role claim injected into the issued tokens. */
  public readonly roleClaimName: string = 'role';

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

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
    userPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
      preTokenGenerationFn,
      cognito.LambdaVersion.V2_0,
    );

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
    const mcpInvokeScope: cognito.ResourceServerScope = {
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
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'authenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
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
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'unauthenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
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
      username: adminUser.username as string,
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
    NagSuppressions.addResourceSuppressions(userPool, [
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
    NagSuppressions.addResourceSuppressions(preTokenGenerationFn, [
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
    NagSuppressions.addResourceSuppressions(authenticatedRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Grant scoped to the main runtime only (cloudops_runtime*); the trailing session-id wildcard is required for AgentCore runtime invocation to support all session IDs and conversation turns (runtime ARN with /* suffix). Feature: gateway-security-hardening (Requirement 6.1).',
      },
    ], true);



    // Stack-level suppressions for CDK-created Lambda functions (Cognito domain custom resource)
    NagSuppressions.addStackSuppressions(this, [
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
