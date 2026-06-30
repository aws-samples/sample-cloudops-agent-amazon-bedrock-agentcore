import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';

export interface AgentCoreGatewayStackProps extends cdk.StackProps {
  // MCP Runtime endpoints from MCPRuntimeStack
  billingMcpRuntimeArn: string;
  billingMcpRuntimeEndpoint: string;
  pricingMcpRuntimeArn: string;
  pricingMcpRuntimeEndpoint: string;
  cloudwatchMcpRuntimeArn: string;
  cloudwatchMcpRuntimeEndpoint: string;
  cloudtrailMcpRuntimeArn: string;
  cloudtrailMcpRuntimeEndpoint: string;
  inventoryMcpRuntimeArn: string;
  inventoryMcpRuntimeEndpoint: string;
  // AuthStack Cognito - used for OAuth provider (outbound auth to runtimes)
  authUserPoolId: string;
  authUserPoolArn: string;
  authM2mClientId: string;
  // FrontEnd User Pool client ID - allowed audience for inbound CUSTOM_JWT authorization
  authUserPoolClientId: string;
}

export class AgentCoreGatewayStack extends cdk.Stack {
  public readonly gatewayArn: string;
  public readonly gatewayUrl: string;

  constructor(scope: Construct, id: string, props: AgentCoreGatewayStackProps) {
    super(scope, id, props);

    // ========================================
    // Retrieve AuthStack M2M client secret
    // ========================================

    const describeM2MClient = new cr.AwsCustomResource(this, 'DescribeM2MClient', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'describeUserPoolClient',
        parameters: {
          UserPoolId: props.authUserPoolId,
          ClientId: props.authM2mClientId,
        },
        physicalResourceId: cr.PhysicalResourceId.of('m2m-client-secret'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['cognito-idp:DescribeUserPoolClient'],
          resources: [props.authUserPoolArn],
        }),
      ]),
    });

    const m2mClientSecret = describeM2MClient.getResponseField('UserPoolClient.ClientSecret');

    // ========================================
    // Gateway Token Exchange Policy (managed policy, wildcard)
    // ========================================

    const tokenExchangePolicy = new iam.ManagedPolicy(this, 'GatewayTokenExchangePolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'AgentCoreIdentityTokenExchange',
          effect: iam.Effect.ALLOW,
          actions: [
            'bedrock-agentcore:GetWorkloadAccessToken',
            'bedrock-agentcore:GetResourceOauth2Token',
          ],
          resources: ['*'],
        }),
      ],
    });

    // ========================================
    // Gateway Service Role
    // ========================================

    const gatewayRole = new iam.Role(this, 'GatewayServiceRole', {
      description: 'Service role for CloudOps AgentCore Gateway',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      managedPolicies: [tokenExchangePolicy],
    });

    // ========================================
    // OAuth Provider (Lambda custom resource)
    // Uses AuthStack's Cognito for outbound auth to MCP runtimes
    // ========================================

    const oauthProviderFn = new lambda.Function(this, 'OAuthProviderFunction', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      code: lambda.Code.fromInline(`
import json
import logging
import os
import urllib.request
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def send_cfn_response(event, status, data=None, reason=None, physical_id=None):
    response_body = json.dumps({
        'Status': status,
        'Reason': reason or 'See CloudWatch Logs',
        'PhysicalResourceId': physical_id or event.get('PhysicalResourceId', event['RequestId']),
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data or {},
    })
    response_url = event['ResponseURL']
    if not response_url.startswith('https://'):
        raise ValueError(f'Invalid response URL scheme')
    req = urllib.request.Request(
        response_url,
        data=response_body.encode('utf-8'),
        headers={'Content-Type': ''},
        method='PUT',
    )
    urllib.request.urlopen(req)

def handler(event, context):
    logger.info(f'Event: {json.dumps(event)}')
    request_type = event['RequestType']
    props = event['ResourceProperties']
    provider_name = props.get('ProviderName', '')
    region = props.get('Region') or os.environ.get('AWS_REGION')
    client = boto3.client('bedrock-agentcore-control', region_name=region)

    if request_type == 'Delete':
        try:
            client.delete_oauth2_credential_provider(name=provider_name)
            send_cfn_response(event, 'SUCCESS')
        except Exception:
            send_cfn_response(event, 'SUCCESS')
        return

    try:
        response = client.create_oauth2_credential_provider(
            name=provider_name,
            credentialProviderVendor='CustomOauth2',
            oauth2ProviderConfigInput={
                'customOauth2ProviderConfig': {
                    'oauthDiscovery': {
                        'discoveryUrl': props.get('DiscoveryUrl', ''),
                    },
                    'clientId': props.get('ClientId', ''),
                    'clientSecret': props.get('ClientSecret', ''),
                },
            },
        )
        provider_arn = response.get('credentialProviderArn', '')
        secret_arn = response.get('clientSecretArn', {}).get('secretArn', '')
        logger.info(f'Created provider: {provider_arn}')
        send_cfn_response(event, 'SUCCESS', data={
            'ProviderArn': provider_arn,
            'SecretArn': secret_arn,
        }, physical_id=provider_name)
    except Exception as e:
        logger.error(f'Create failed: {e}')
        send_cfn_response(event, 'FAILED', reason=str(e))
`),
    });

    // Wildcard resource is REQUIRED here and cannot be scoped further: these are
    // account-level control-plane actions on the AgentCore identity store. The
    // OAuth2 credential provider and token vault do not exist yet (this custom
    // resource CREATES them), so their ARNs are unknown at policy-definition
    // time, and AgentCore does not support resource-level scoping for the
    // Create*/Get* token-vault / credential-provider actions. The blast radius
    // is contained to the bedrock-agentcore identity APIs (no data-plane or IAM
    // actions), the function runs only as a CloudFormation custom resource, and
    // the related Secrets Manager grant below IS scoped to the
    // bedrock-agentcore-identity* secret prefix.
    oauthProviderFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AgentCoreIdentityProviderManagement',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:CreateOauth2CredentialProvider',
        'bedrock-agentcore:DeleteOauth2CredentialProvider',
        'bedrock-agentcore:GetOauth2CredentialProvider',
        'bedrock-agentcore:CreateTokenVault',
        'bedrock-agentcore:GetTokenVault',
      ],
      resources: ['*'],
    }));

    oauthProviderFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:CreateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:TagResource',
      ],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:bedrock-agentcore-identity*`,
      ],
    }));

    const oauthProvider = new cdk.CustomResource(this, 'OAuthProvider', {
      serviceToken: oauthProviderFn.functionArn,
      properties: {
        ProviderName: `${this.stackName}-oauth-provider`,
        DiscoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${props.authUserPoolId}/.well-known/openid-configuration`,
        ClientId: props.authM2mClientId,
        ClientSecret: m2mClientSecret,
        Region: this.region,
      },
    });

    const oauthProviderArn = oauthProvider.getAttString('ProviderArn');
    const oauthSecretArn = oauthProvider.getAttString('SecretArn');

    // ========================================
    // Default Policy on Gateway Role (scoped to OAuth provider resources)
    // ========================================

    gatewayRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:GetResourceOauth2Token',
        'bedrock-agentcore:GetWorkloadAccessToken',
        'secretsmanager:GetSecretValue',
        'secretsmanager:DescribeSecret',
      ],
      resources: [oauthProviderArn, oauthSecretArn],
    }));

    // ========================================
    // AgentCore Policy Engine (Lambda custom resource)
    //
    // The installed CDK alpha module (@aws-cdk/aws-bedrock-agentcore-alpha
    // 2.235.x) does NOT yet ship the Policy submodule (PolicyEngine / Policy /
    // PolicyStatement) — those constructs were added in a later alpha release.
    // There is also no first-class L1 for the engine/policies (only the
    // gateway-side `PolicyEngineConfiguration` exists). We therefore create the
    // engine and its Cedar policies via the `bedrock-agentcore-control` control
    // plane behind a CDK custom resource, mirroring the OAuthProvider pattern
    // above.
    //
    // Flow:
    //   1. PolicyEngine custom resource  -> create_policy_engine, wait ACTIVE,
    //      returns the engine ARN/ID.
    //   2. Gateway carries PolicyEngineConfiguration.Arn = engine ARN so the
    //      engine is associated with the gateway (Mode = ENFORCE).
    //   3. PolicyEnginePolicies custom resource -> create_policy for each Cedar
    //      statement. It depends on the gateway + all targets so the Cedar
    //      schema (generated from the targets' tool input schemas) exists when
    //      the policies are validated.
    // ========================================

    const policyEngineFn = new lambda.Function(this, 'PolicyEngineFunction', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(10),
      code: lambda.Code.fromInline(`
import json
import logging
import os
import re
import time
import urllib.request
import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _client_token(value):
    # clientToken must match ^[a-zA-Z0-9](-*[a-zA-Z0-9]){0,256}$ — no
    # underscores. Reduce to alphanumerics only (always valid) and cap length.
    token = re.sub(r'[^a-zA-Z0-9]', '', value)
    return token[:256] or 'token'


def send_cfn_response(event, status, data=None, reason=None, physical_id=None):
    response_body = json.dumps({
        'Status': status,
        'Reason': reason or 'See CloudWatch Logs',
        'PhysicalResourceId': physical_id or event.get('PhysicalResourceId', event['RequestId']),
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data or {},
    })
    response_url = event['ResponseURL']
    if not response_url.startswith('https://'):
        raise ValueError('Invalid response URL scheme')
    req = urllib.request.Request(
        response_url,
        data=response_body.encode('utf-8'),
        headers={'Content-Type': ''},
        method='PUT',
    )
    urllib.request.urlopen(req)


def _is_conflict(err):
    code = err.response.get('Error', {}).get('Code', '') if isinstance(err, ClientError) else ''
    return 'Conflict' in code or 'AlreadyExists' in code


def _find_engine_by_name(client, name):
    try:
        token = None
        while True:
            kwargs = {'nextToken': token} if token else {}
            resp = client.list_policy_engines(**kwargs)
            for item in resp.get('policyEngines', []) or resp.get('items', []):
                if item.get('name') == name:
                    return item
            token = resp.get('nextToken')
            if not token:
                break
    except Exception as ex:
        logger.warning(f'list_policy_engines failed: {ex}')
    return None


def _engine_id(item):
    return item.get('policyEngineId') or item.get('id')


def _wait_engine_active(client, engine_id, timeout_s=480):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        resp = client.get_policy_engine(policyEngineId=engine_id)
        status = resp.get('status')
        logger.info(f'engine {engine_id} status={status}')
        if status == 'ACTIVE':
            return resp
        if status and status.endswith('FAILED'):
            raise RuntimeError(f'engine {engine_id} {status}: {resp.get("statusReasons")}')
        time.sleep(5)
    raise TimeoutError(f'engine {engine_id} not ACTIVE within {timeout_s}s')


def _list_policy_ids(client, engine_id):
    ids = []
    token = None
    while True:
        kwargs = {'policyEngineId': engine_id}
        if token:
            kwargs['nextToken'] = token
        resp = client.list_policies(**kwargs)
        for item in resp.get('policies', []) or resp.get('items', []):
            pid = item.get('policyId') or item.get('id')
            if pid:
                ids.append(pid)
        token = resp.get('nextToken')
        if not token:
            break
    return ids


def _delete_policies(client, engine_id, timeout_s=120):
    # delete_policy is asynchronous, so issue deletes for every existing policy
    # and then WAIT until they are all actually gone. Recreating a policy with
    # the same name while a prior one is still DELETING raises a conflict.
    try:
        for pid in _list_policy_ids(client, engine_id):
            try:
                client.delete_policy(policyEngineId=engine_id, policyId=pid)
            except Exception as ex:
                logger.warning(f'delete_policy {pid} failed: {ex}')
    except Exception as ex:
        logger.warning(f'list_policies failed during delete: {ex}')
        return

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            remaining = _list_policy_ids(client, engine_id)
        except Exception as ex:
            logger.warning(f'list_policies failed while waiting for delete: {ex}')
            return
        if not remaining:
            return
        logger.info(f'waiting for {len(remaining)} policies to finish deleting')
        time.sleep(4)
    logger.warning('timed out waiting for policy deletions to complete')


def handle_engine(event, client):
    props = event['ResourceProperties']
    name = props['EngineName']
    request_type = event['RequestType']

    if request_type == 'Delete':
        existing = _find_engine_by_name(client, name)
        if existing:
            eid = _engine_id(existing)
            _delete_policies(client, eid)
            try:
                client.delete_policy_engine(policyEngineId=eid)
            except Exception as ex:
                logger.warning(f'delete_policy_engine failed: {ex}')
        send_cfn_response(event, 'SUCCESS')
        return

    # Create / Update (engine name is immutable -> reuse if it already exists)
    # The clientToken is made unique per CloudFormation request (RequestId) so a
    # later stack recreation does not collide with the idempotency record of a
    # prior (now-deleted) engine, while still being stable across the SDK's own
    # retries within a single create call.
    engine_id = None
    try:
        resp = client.create_policy_engine(
            name=name,
            description=props.get('Description', 'CloudOps role-based tool authorization engine'),
            clientToken=_client_token(name + event.get('RequestId', '')),
        )
        engine_id = resp['policyEngineId']
    except ClientError as err:
        if _is_conflict(err):
            existing = _find_engine_by_name(client, name)
            if not existing:
                raise
            engine_id = _engine_id(existing)
        else:
            raise

    _wait_engine_active(client, engine_id)
    engine = client.get_policy_engine(policyEngineId=engine_id)
    send_cfn_response(event, 'SUCCESS', data={
        'PolicyEngineId': engine_id,
        'PolicyEngineArn': engine.get('policyEngineArn', ''),
    }, physical_id=engine_id)


def _wait_policy_active(client, engine_id, policy_id, timeout_s=180):
    # Policy creation is asynchronous: create_policy returns CREATING and the
    # Cedar analyzer validates the statement against the gateway's generated
    # schema afterwards. Poll until ACTIVE, and raise (failing the custom
    # resource) on CREATE_FAILED so a bad policy can never be silently accepted.
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        resp = client.get_policy(policyEngineId=engine_id, policyId=policy_id)
        status = resp.get('status')
        logger.info(f'policy {policy_id} status={status}')
        if status == 'ACTIVE':
            return
        if status and 'FAILED' in status:
            raise RuntimeError(
                f'policy {policy_id} {status}: {resp.get("statusReasons")}'
            )
        time.sleep(4)
    raise TimeoutError(f'policy {policy_id} not ACTIVE within {timeout_s}s')


def handle_policies(event, client):
    props = event['ResourceProperties']
    engine_id = props['PolicyEngineId']
    statements = props.get('Statements', [])
    validation_mode = props.get('ValidationMode', 'FAIL_ON_ANY_FINDINGS')
    request_type = event['RequestType']

    if request_type == 'Delete':
        _delete_policies(client, engine_id)
        send_cfn_response(event, 'SUCCESS')
        return

    # Reconcile: remove any existing policies first so Create AND Update both
    # converge to exactly the desired statement set (and clean up any prior
    # failed/probe policies) without name-conflict errors.
    _delete_policies(client, engine_id)

    created = []
    for stmt in statements:
        pname = stmt['Name']
        resp = client.create_policy(
            policyEngineId=engine_id,
            name=pname,
            description=stmt.get('Description', ''),
            validationMode=validation_mode,
            # enforcementMode is omitted: it is not present in the Lambda
            # runtime's bundled boto3 model for create_policy and defaults
            # to ACTIVE service-side (which is the enforcing behavior we
            # want; the gateway PolicyEngineConfiguration is also ENFORCE).
            definition={'cedar': {'statement': stmt['Statement']}},
            clientToken=_client_token(f"{engine_id}{pname}{event.get('RequestId', '')}"),
        )
        policy_id = resp.get('policyId', pname)
        # Block until the policy validates ACTIVE; raises on CREATE_FAILED.
        _wait_policy_active(client, engine_id, policy_id)
        created.append(policy_id)

    send_cfn_response(event, 'SUCCESS', data={
        'PolicyIds': ','.join(created),
    }, physical_id=f'{engine_id}-policies')


def handler(event, context):
    logger.info(f'Event: {json.dumps(event)}')
    props = event['ResourceProperties']
    operation = props.get('Operation', 'ENGINE')
    region = props.get('Region') or os.environ.get('AWS_REGION')
    client = boto3.client('bedrock-agentcore-control', region_name=region)
    try:
        if operation == 'ENGINE':
            handle_engine(event, client)
        elif operation == 'POLICIES':
            handle_policies(event, client)
        else:
            send_cfn_response(event, 'FAILED', reason=f'Unknown operation {operation}')
    except Exception as e:
        logger.error(f'{operation} failed: {e}')
        # On Delete we never want to block stack teardown.
        if event['RequestType'] == 'Delete':
            send_cfn_response(event, 'SUCCESS')
        else:
            send_cfn_response(event, 'FAILED', reason=str(e))
`),
    });

    // Wildcard resource is REQUIRED and cannot be scoped at policy-definition
    // time: this custom resource CREATES the policy engine and its policies, so
    // their ARNs do not exist yet, and the List* actions are account-level by
    // definition (they enumerate all engines/policies and accept no resource
    // constraint). The gateway-targeting actions (InvokeGateway/GetGateway/
    // List/GetGatewayTarget) are used at create time to validate each Cedar
    // policy against the live gateway tool schema. The blast radius is limited
    // to the bedrock-agentcore Policy/Gateway control plane, and the function
    // runs only as a CloudFormation custom resource during stack deploy/delete.
    // (The gateway *service* role's AuthorizeAction grant IS scoped to the
    // specific policy-engine and gateway ARNs — see PolicyEngineAuthorization.)
    policyEngineFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AgentCorePolicyEngineManagement',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:CreatePolicyEngine',
        'bedrock-agentcore:DeletePolicyEngine',
        'bedrock-agentcore:GetPolicyEngine',
        'bedrock-agentcore:ListPolicyEngines',
        'bedrock-agentcore:CreatePolicy',
        'bedrock-agentcore:DeletePolicy',
        'bedrock-agentcore:GetPolicy',
        'bedrock-agentcore:ListPolicies',
        // CreatePolicy binds/validates each Cedar policy against the target
        // Gateway's tools, which requires reading the gateway and its targets,
        // managing the gateway's resource-scoped policy, and invoking the
        // gateway to validate the actions referenced by the policy.
        'bedrock-agentcore:ManageResourceScopedPolicy',
        'bedrock-agentcore:InvokeGateway',
        'bedrock-agentcore:GetGateway',
        'bedrock-agentcore:ListGatewayTargets',
        'bedrock-agentcore:GetGatewayTarget',
      ],
      resources: ['*'],
    }));

    // AgentCore Policy resource names (engine + policies) must match
    // ^[A-Za-z][A-Za-z0-9_]*$ — letters/digits/underscores only, starting with
    // a letter. Sanitize the stack name (which may contain hyphens) to a valid
    // prefix so the CreatePolicyEngine/CreatePolicy calls validate.
    const policyNamePrefix = `${this.stackName}`.replace(/[^A-Za-z0-9_]/g, '_');

    const policyEngine = new cdk.CustomResource(this, 'PolicyEngine', {
      serviceToken: policyEngineFn.functionArn,
      properties: {
        Operation: 'ENGINE',
        EngineName: `${policyNamePrefix}_policy_engine`,
        Description: 'CloudOps role-based tool authorization (Cedar) for the gateway',
        Region: this.region,
      },
    });

    const policyEngineArn = policyEngine.getAttString('PolicyEngineArn');
    const policyEngineId = policyEngine.getAttString('PolicyEngineId');

    // Gateway Execution Role permissions for Policy in AgentCore. Per the
    // AgentCore "Gateway and Policy IAM Permissions" guide, the execution role
    // requires exactly:
    //   * GetPolicyEngine on the policy-engine, and
    //   * AuthorizeAction + PartiallyAuthorizeActions on BOTH the policy-engine
    //     and the gateway.
    // Without these the Gateway cannot evaluate Cedar policies (attaching a
    // Policy Engine fails, and all tool invocations default-deny).
    // The gateway ARN is generated at create time (referencing this.gatewayArn
    // here would be circular), so the gateway resource is scoped to this
    // account/region's gateway namespace.
    const gatewayResourceWildcard = `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`;

    gatewayRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PolicyEngineConfiguration',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock-agentcore:GetPolicyEngine'],
      resources: [policyEngineArn],
    }));

    gatewayRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PolicyEngineAuthorization',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:AuthorizeAction',
        'bedrock-agentcore:PartiallyAuthorizeActions',
      ],
      resources: [policyEngineArn, gatewayResourceWildcard],
    }));

    // ========================================
    // Deny-audit REQUEST interceptor (Lambda)
    //
    // Emits exactly one structured CloudWatch record on a deny Tool_Invocation
    // (JWT `sub`, requested Tool_Category, `deny`, timestamp) — never the token
    // or tool args/results (Req 8.3). It is AUDIT-ONLY: it re-derives the
    // decision with the same authoritative role->category model and ALWAYS
    // forwards the request unchanged, so the Cedar Policy engine above remains
    // the authoritative authorizer. Any audit failure is swallowed inside the
    // handler and the request is still forwarded unchanged, so an audit failure
    // can never suppress the authorization error returned to the caller
    // (Req 8.4).
    //
    // Verified against the AgentCore docs:
    //   * `AWS::BedrockAgentCore::Gateway` exposes `InterceptorConfigurations`
    //     (array, 1–2). Each entry has `InterceptionPoints` (REQUEST/RESPONSE),
    //     `Interceptor.Lambda.Arn`, and `InputConfiguration.PassRequestHeaders`.
    //   * The JWT `sub`/`role` are only available to the interceptor via the
    //     `Authorization` header, delivered only when `PassRequestHeaders` is
    //     true. The Gateway verifies the JWT before invoking the interceptor;
    //     the handler decodes (does not verify) it solely to read `sub`/`role`
    //     and never logs the token.
    //   * AgentCore Policy also has native deny observability (metrics + trace
    //     spans). Per design Note 4 we use the interceptor as the single
    //     canonical four-field audit entry and do NOT also enable a competing
    //     native-observability audit sink, keeping "exactly one audit entry"
    //     per deny (Req 8.3).
    // See cdk/lambda/deny-audit-interceptor/README.md for the full research log.
    // ========================================

    // Dedicated log group so the structured deny-audit records have an explicit,
    // retained CloudWatch destination (rather than relying on the implicit
    // Lambda log group).
    const denyAuditLogGroup = new logs.LogGroup(this, 'DenyAuditInterceptorLogGroup', {
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const denyAuditInterceptorFn = new lambda.Function(this, 'DenyAuditInterceptorFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/deny-audit-interceptor')),
      description: 'Deny-audit REQUEST interceptor for the CloudOps Gateway (structured deny records).',
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      logGroup: denyAuditLogGroup,
    });

    // The Gateway service role invokes the interceptor. Scope the grant to this
    // function only (interceptor security best practice — never a wildcard).
    denyAuditInterceptorFn.grantInvoke(gatewayRole);

    // ========================================
    // Discovery-filter RESPONSE interceptor (Lambda)
    //
    // Filters the `tools/list` Discovery_Response down to the caller's allowed
    // categories before the Gateway returns it, so a NonAdmin user cannot
    // enumerate the names/descriptions/input schemas of tools they cannot
    // invoke. It is a DISTINCT, independently reasoned interceptor from the
    // deny-audit REQUEST interceptor above: it transforms only `tools/list`
    // responses, never audits or enforces invocation, reuses the authoritative
    // role->category model (vendored byte-for-byte), and fails closed (returns
    // an empty tool list) on any error — never the unfiltered catalog. It
    // decodes (does not verify) the already-verified Authorization JWT solely
    // to read `sub`/`role` and never logs the token.
    // ========================================

    // Dedicated, retained log group — mirrors DenyAuditInterceptorLogGroup.
    const discoveryFilterLogGroup = new logs.LogGroup(this, 'DiscoveryFilterInterceptorLogGroup', {
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const discoveryFilterInterceptorFn = new lambda.Function(this, 'DiscoveryFilterInterceptorFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/discovery-filter-interceptor')),
      description: 'Role-filtered tool discovery RESPONSE interceptor for the CloudOps Gateway.',
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      logGroup: discoveryFilterLogGroup,
    });

    // The Gateway service role invokes the interceptor. Scope the grant to this
    // function only (interceptor security best practice — never a wildcard).
    discoveryFilterInterceptorFn.grantInvoke(gatewayRole);

    // ========================================
    // Gateway (CUSTOM_JWT auth — verifies per-user Cognito tokens so the
    // role claim reaches AgentCore Policy for fine-grained authorization)
    // ========================================

    const gateway = new cdk.CfnResource(this, 'McpGateway', {
      type: 'AWS::BedrockAgentCore::Gateway',
      properties: {
        Name: 'cloudops-gateway',
        Description: 'CloudOps Gateway for billing and pricing MCP tools (JWT auth)',
        ProtocolType: 'MCP',
        AuthorizerType: 'CUSTOM_JWT',
        AuthorizerConfiguration: {
          CustomJWTAuthorizer: {
            DiscoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${props.authUserPoolId}/.well-known/openid-configuration`,
            // The FrontEnd forwards the Cognito ACCESS token, which carries
            // `client_id` (not an `aud` claim — only ID tokens have `aud`).
            // The JWT authorizer must therefore match on AllowedClients
            // (client_id) rather than AllowedAudience, or validation 403s.
            AllowedClients: [props.authUserPoolClientId],
          },
        },
        ProtocolConfiguration: {
          Mcp: {
            Instructions: 'CloudOps gateway for billing, pricing, CloudWatch, CloudTrail, and inventory MCP tools',
            SearchType: 'SEMANTIC',
            SupportedVersions: ['2025-03-26'],
          },
        },
        // Associate the Cedar policy engine. ENFORCE makes the engine deny
        // disallowed tool discovery/invocation; LOG_ONLY would only trace.
        PolicyEngineConfiguration: {
          Arn: policyEngineArn,
          Mode: 'ENFORCE',
        },
        // Register the deny-audit REQUEST interceptor. PassRequestHeaders=true
        // is required so the interceptor can read the (already-verified)
        // Authorization header to recover the JWT `sub`/`role` for the audit
        // record; the handler never logs the token. The interceptor is
        // audit-only and forwards every request unchanged.
        InterceptorConfigurations: [
          {
            InterceptionPoints: ['REQUEST'],
            Interceptor: {
              Lambda: {
                Arn: denyAuditInterceptorFn.functionArn,
              },
            },
            InputConfiguration: {
              PassRequestHeaders: true,
            },
          },
          // Register the discovery-filter RESPONSE interceptor.
          // PassRequestHeaders=true so it can read the (already-verified)
          // Authorization header to recover the JWT `role` for filtering;
          // the handler never logs the token. It transforms only `tools/list`
          // discovery responses and fails closed to an empty tool list.
          {
            InterceptionPoints: ['RESPONSE'],
            Interceptor: {
              Lambda: {
                Arn: discoveryFilterInterceptorFn.functionArn,
              },
            },
            InputConfiguration: {
              PassRequestHeaders: true,
            },
          },
        ],
        RoleArn: gatewayRole.roleArn,
      },
    });
    gateway.node.addDependency(denyAuditInterceptorFn);
    gateway.node.addDependency(discoveryFilterInterceptorFn);
    gateway.node.addDependency(oauthProvider);
    gateway.node.addDependency(policyEngine);
    // The Gateway calls GetPolicyEngine using its service role at create time,
    // so the role's inline policy (which grants bedrock-agentcore:GetPolicyEngine
    // and the OAuth/token-exchange permissions) MUST be attached before the
    // Gateway is created. Without this dependency CloudFormation may create the
    // Gateway concurrently with the role policy, causing an access-denied error.
    gateway.node.addDependency(gatewayRole);

    this.gatewayArn = gateway.getAtt('GatewayArn').toString();
    const gatewayId = gateway.getAtt('GatewayIdentifier').toString();
    this.gatewayUrl = gateway.getAtt('GatewayUrl').toString();

    // ========================================
    // Gateway Targets (MCP Server endpoints)
    // ========================================

    const billingTarget = new cdk.CfnResource(this, 'BillingMcpTarget', {
      type: 'AWS::BedrockAgentCore::GatewayTarget',
      properties: {
        GatewayIdentifier: gatewayId,
        Name: 'billingMcp',
        Description: 'AWS Labs Billing MCP Server on AgentCore Runtime',
        TargetConfiguration: {
          Mcp: { McpServer: { Endpoint: props.billingMcpRuntimeEndpoint } },
        },
        CredentialProviderConfigurations: [{
          CredentialProviderType: 'OAUTH',
          CredentialProvider: {
            OauthCredentialProvider: {
              ProviderArn: oauthProviderArn,
              Scopes: ['mcp-runtime-server/invoke'],
            },
          },
        }],
      },
    });
    billingTarget.node.addDependency(gateway);

    const pricingTarget = new cdk.CfnResource(this, 'PricingMcpTarget', {
      type: 'AWS::BedrockAgentCore::GatewayTarget',
      properties: {
        GatewayIdentifier: gatewayId,
        Name: 'pricingMcp',
        Description: 'AWS Labs Pricing MCP Server on AgentCore Runtime',
        TargetConfiguration: {
          Mcp: { McpServer: { Endpoint: props.pricingMcpRuntimeEndpoint } },
        },
        CredentialProviderConfigurations: [{
          CredentialProviderType: 'OAUTH',
          CredentialProvider: {
            OauthCredentialProvider: {
              ProviderArn: oauthProviderArn,
              Scopes: ['mcp-runtime-server/invoke'],
            },
          },
        }],
      },
    });
    pricingTarget.node.addDependency(gateway);

    const cloudwatchMcpTarget = new cdk.CfnResource(this, 'CloudWatchMcpTarget', {
      type: 'AWS::BedrockAgentCore::GatewayTarget',
      properties: {
        GatewayIdentifier: gatewayId,
        Name: 'cloudwatchMcp',
        Description: 'AWS Labs CloudWatch MCP Server on AgentCore Runtime',
        TargetConfiguration: {
          Mcp: { McpServer: { Endpoint: props.cloudwatchMcpRuntimeEndpoint } },
        },
        CredentialProviderConfigurations: [{
          CredentialProviderType: 'OAUTH',
          CredentialProvider: {
            OauthCredentialProvider: {
              ProviderArn: oauthProviderArn,
              Scopes: ['mcp-runtime-server/invoke'],
            },
          },
        }],
      },
    });
    cloudwatchMcpTarget.node.addDependency(gateway);

    const cloudtrailMcpTarget = new cdk.CfnResource(this, 'CloudTrailMcpTarget', {
      type: 'AWS::BedrockAgentCore::GatewayTarget',
      properties: {
        GatewayIdentifier: gatewayId,
        Name: 'cloudtrailMcp',
        Description: 'AWS Labs CloudTrail MCP Server on AgentCore Runtime',
        TargetConfiguration: {
          Mcp: { McpServer: { Endpoint: props.cloudtrailMcpRuntimeEndpoint } },
        },
        CredentialProviderConfigurations: [{
          CredentialProviderType: 'OAUTH',
          CredentialProvider: {
            OauthCredentialProvider: {
              ProviderArn: oauthProviderArn,
              Scopes: ['mcp-runtime-server/invoke'],
            },
          },
        }],
      },
    });
    cloudtrailMcpTarget.node.addDependency(gateway);

    const inventoryMcpTarget = new cdk.CfnResource(this, 'InventoryMcpTarget', {
      type: 'AWS::BedrockAgentCore::GatewayTarget',
      properties: {
        GatewayIdentifier: gatewayId,
        Name: 'inventoryMcp',
        Description: 'Inventory MCP Server on AgentCore Runtime',
        TargetConfiguration: {
          Mcp: { McpServer: { Endpoint: props.inventoryMcpRuntimeEndpoint } },
        },
        CredentialProviderConfigurations: [{
          CredentialProviderType: 'OAUTH',
          CredentialProvider: {
            OauthCredentialProvider: {
              ProviderArn: oauthProviderArn,
              Scopes: ['mcp-runtime-server/invoke'],
            },
          },
        }],
      },
    });
    inventoryMcpTarget.node.addDependency(gateway);

    // ========================================
    // Cedar policies (role -> tool-category mapping)
    //
    // Authoritative role->category model implemented as two `permit` statements
    // (Cedar is deny-by-default; forbid overrides permit):
    //   * billing + pricing  -> permitted for every authenticated user.
    //   * cloudwatch + cloudtrail + inventory -> permitted only when the
    //     verified JWT `role` claim (stored as a principal tag) == "admin".
    //   * everything else (incl. newly added categories) -> denied by default.
    //
    // Category -> tool grouping. At the gateway each tool action is
    // `AgentCore::Action::"<targetName>___<toolName>"` (see the AgentCore
    // authorization-flow docs). A category therefore corresponds to a target
    // tool-name prefix:
    //   billing -> billingMcp___, pricing -> pricingMcp___,
    //   cloudwatch -> cloudwatchMcp___, cloudtrail -> cloudtrailMcp___,
    //   inventory -> inventoryMcp___.
    //
    // ASSUMPTION (must be validated against the live AgentCore Cedar schema,
    // covered by the integration tests in task 9): the grouping is expressed
    // here via `action.tool_category == "<category>"`, matching the design
    // document's policy set. The concrete Cedar schema generated from the
    // gateway's tools may instead require enumerating the per-tool action
    // identifiers or matching the `<targetName>___` prefix directly. If the
    // live schema does not expose a `tool_category` action attribute, switch
    // these statements to `action in [AgentCore::Action::"billingMcp___...", …]`
    // (enumerated) or the schema's documented category attribute. The
    // role->category SEMANTICS above are the invariant; only the action-match
    // expression is provisional. ValidationMode is IGNORE_ALL_FINDINGS so the
    // engine accepts the policies during this provisional phase; tighten to
    // FAIL_ON_ANY_FINDINGS once the action model is confirmed.
    // ========================================

    const gatewayArnRef = this.gatewayArn;

    // AgentCore generates a Cedar action GROUP per gateway target, named by the
    // target name (e.g. AgentCore::Action::"billingMcp"). Each tool action
    // (<target>___<tool>) is a member of its target's group, so we can scope a
    // policy to an entire category by referencing the target name we already
    // know from CDK — no per-tool enumeration or runtime discovery required.
    // There is no `tool_category` attribute; the prior design assumption was
    // wrong and is corrected here.
    //
    // Pure-permit model over the five target groups (Cedar is deny-by-default,
    // forbid-overrides-permit):
    //   * billing + pricing  -> permitted for every authenticated user;
    //   * cloudwatch + cloudtrail + inventory -> permitted only when the
    //     verified JWT `role` claim (a principal tag) == "admin";
    //   * everything else (incl. any future target added later) -> denied by
    //     default for non-admins, satisfying the default-deny requirement.
    // The semantic-search / tools-list meta-operations are NOT Policy-governed
    // targets, so this model does not affect tool discovery.

    const allUsersCedar = [
      'permit(',
      '  principal is AgentCore::OAuthUser,',
      '  action in [AgentCore::Action::"billingMcp", AgentCore::Action::"pricingMcp"],',
      `  resource == AgentCore::Gateway::"${gatewayArnRef}"`,
      ');',
    ].join('\n');

    const adminOnlyCedar = [
      'permit(',
      '  principal is AgentCore::OAuthUser,',
      '  action in [AgentCore::Action::"cloudwatchMcp", AgentCore::Action::"cloudtrailMcp", AgentCore::Action::"inventoryMcp"],',
      `  resource == AgentCore::Gateway::"${gatewayArnRef}"`,
      ') when {',
      '  principal.hasTag("role") &&',
      '  principal.getTag("role") == "admin"',
      '};',
    ].join('\n');

    const policyEnginePolicies = new cdk.CustomResource(this, 'PolicyEnginePolicies', {
      serviceToken: policyEngineFn.functionArn,
      properties: {
        Operation: 'POLICIES',
        PolicyEngineId: policyEngineId,
        // Validate strictly against the gateway's generated Cedar schema so a
        // malformed policy fails the deployment loudly instead of landing in a
        // silent async CREATE_FAILED state. The custom-resource Lambda polls
        // each policy to ACTIVE and fails if validation does not pass.
        ValidationMode: 'FAIL_ON_ANY_FINDINGS',
        Region: this.region,
        Statements: [
          {
            // Policy names must match ^[A-Za-z][A-Za-z0-9_]*$ (no hyphens).
            Name: 'allow_billing_pricing_all_users',
            Description: 'Permit billing and pricing tools for every authenticated user.',
            Statement: allUsersCedar,
          },
          {
            Name: 'allow_ops_categories_admin_only',
            Description: 'Permit cloudwatch, cloudtrail, and inventory tools only for role == admin.',
            Statement: adminOnlyCedar,
          },
        ],
      },
    });

    // Policies are validated against the Cedar schema generated from the
    // gateway's tools, so they must be created after the gateway and every
    // target exist.
    policyEnginePolicies.node.addDependency(gateway);
    policyEnginePolicies.node.addDependency(billingTarget);
    policyEnginePolicies.node.addDependency(pricingTarget);
    policyEnginePolicies.node.addDependency(cloudwatchMcpTarget);
    policyEnginePolicies.node.addDependency(cloudtrailMcpTarget);
    policyEnginePolicies.node.addDependency(inventoryMcpTarget);

    // ========================================
    // Outputs
    // ========================================

    new cdk.CfnOutput(this, 'GatewayArn', {
      value: this.gatewayArn,
      description: 'AgentCore Gateway ARN',
      exportName: `${this.stackName}-GatewayArn`,
    });

    new cdk.CfnOutput(this, 'GatewayUrl', {
      value: this.gatewayUrl,
      description: 'AgentCore Gateway URL',
      exportName: `${this.stackName}-GatewayUrl`,
    });

    new cdk.CfnOutput(this, 'PolicyEngineArn', {
      value: policyEngineArn,
      description: 'AgentCore Policy Engine ARN (Cedar role-based tool authorization)',
      exportName: `${this.stackName}-PolicyEngineArn`,
    });

    // ========================================
    // CDK-Nag Suppressions
    // ========================================

    NagSuppressions.addResourceSuppressions(gatewayRole, [
      { id: 'AwsSolutions-IAM5', reason: 'Wildcard for AgentCore Identity token exchange and OAuth provider management.' },
    ], true);

    NagSuppressions.addResourceSuppressions(oauthProviderFn, [
      { id: 'AwsSolutions-IAM5', reason: 'Wildcard required for AgentCore Identity token vault creation and bedrock-agentcore-identity secrets namespace.' },
    ], true);

    NagSuppressions.addResourceSuppressions(policyEngineFn, [
      { id: 'AwsSolutions-IAM5', reason: 'Wildcard required for AgentCore Policy engine/policy management (CreatePolicyEngine/CreatePolicy operate on resources created at deploy time).' },
    ], true);

    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is AWS best practice.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
      { id: 'AwsSolutions-IAM5', reason: 'Wildcard for AgentCore Identity token exchange, OAuth credential provider management.', appliesTo: ['Resource::*'] },
      { id: 'AwsSolutions-L1', reason: 'Lambda runtime version managed by CDK.' },
    ]);
  }
}
