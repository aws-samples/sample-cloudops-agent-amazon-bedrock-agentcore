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
exports.AgentCoreGatewayStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
const path = __importStar(require("path"));
const cdk_nag_1 = require("cdk-nag");
class AgentCoreGatewayStack extends cdk.Stack {
    constructor(scope, id, props) {
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
    logger.info('Request type: %s', event['RequestType'])
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
        // expression is provisional. Validation runs in FAIL_ON_ANY_FINDINGS so a
        // malformed policy fails the deployment loudly instead of being silently
        // accepted.
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
        cdk_nag_1.NagSuppressions.addResourceSuppressions(gatewayRole, [
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard for AgentCore Identity token exchange and OAuth provider management.' },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(oauthProviderFn, [
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard required for AgentCore Identity token vault creation and bedrock-agentcore-identity secrets namespace.' },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(policyEngineFn, [
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard required for AgentCore Policy engine/policy management (CreatePolicyEngine/CreatePolicy operate on resources created at deploy time).' },
        ], true);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is AWS best practice.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard for AgentCore Identity token exchange, OAuth credential provider management.', appliesTo: ['Resource::*'] },
            { id: 'AwsSolutions-L1', reason: 'Lambda runtime version managed by CDK.' },
        ]);
    }
}
exports.AgentCoreGatewayStack = AgentCoreGatewayStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2F0ZXdheS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImdhdGV3YXktc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHlEQUEyQztBQUMzQywrREFBaUQ7QUFDakQsMkRBQTZDO0FBQzdDLGlFQUFtRDtBQUVuRCwyQ0FBNkI7QUFDN0IscUNBQTBDO0FBc0IxQyxNQUFhLHFCQUFzQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBSWxELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBaUM7UUFDekUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsMkNBQTJDO1FBQzNDLHVDQUF1QztRQUN2QywyQ0FBMkM7UUFFM0MsTUFBTSxpQkFBaUIsR0FBRyxJQUFJLEVBQUUsQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDNUUsUUFBUSxFQUFFO2dCQUNSLE9BQU8sRUFBRSxnQ0FBZ0M7Z0JBQ3pDLE1BQU0sRUFBRSx3QkFBd0I7Z0JBQ2hDLFVBQVUsRUFBRTtvQkFDVixVQUFVLEVBQUUsS0FBSyxDQUFDLGNBQWM7b0JBQ2hDLFFBQVEsRUFBRSxLQUFLLENBQUMsZUFBZTtpQkFDaEM7Z0JBQ0Qsa0JBQWtCLEVBQUUsRUFBRSxDQUFDLGtCQUFrQixDQUFDLEVBQUUsQ0FBQyxtQkFBbUIsQ0FBQzthQUNsRTtZQUNELE1BQU0sRUFBRSxFQUFFLENBQUMsdUJBQXVCLENBQUMsY0FBYyxDQUFDO2dCQUNoRCxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7b0JBQ3RCLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7b0JBQ3hCLE9BQU8sRUFBRSxDQUFDLG9DQUFvQyxDQUFDO29CQUMvQyxTQUFTLEVBQUUsQ0FBQyxLQUFLLENBQUMsZUFBZSxDQUFDO2lCQUNuQyxDQUFD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QUFDLFdBQVcsRUFBRTtZQUNuRCxFQUFFLEVBQUUsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLEVBQUUsK0VBQStFLEVBQUU7U0FDckgsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUVULHlCQUFlLENBQUMsdUJBQXVCLENBQUMsZUFBZSxFQUFFO1lBQ3ZELEVBQUUsRUFBRSxFQUFFLG1CQUFtQixFQUFFLE1BQU0sRUFBRSxpSEFBaUgsRUFBRTtTQUN2SixFQUFFLElBQUksQ0FBQyxDQUFDO1FBRVQseUJBQWUsQ0FBQyx1QkFBdUIsQ0FBQyxjQUFjLEVBQUU7WUFDdEQsRUFBRSxFQUFFLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxFQUFFLGdKQUFnSixFQUFFO1NBQ3RMLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFFVCx5QkFBZSxDQUFDLG9CQUFvQixDQUFDLElBQUksRUFBRTtZQUN6QyxFQUFFLEVBQUUsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLEVBQUUsbURBQW1ELEVBQUUsU0FBUyxFQUFFLENBQUMsdUZBQXVGLENBQUMsRUFBRTtZQUM5TCxFQUFFLEVBQUUsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLEVBQUUsdUZBQXVGLEVBQUUsU0FBUyxFQUFFLENBQUMsYUFBYSxDQUFDLEVBQUU7WUFDeEosRUFBRSxFQUFFLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxFQUFFLHdDQUF3QyxFQUFFO1NBQzVFLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQTkvQkQsc0RBOC9CQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGNyIGZyb20gJ2F3cy1jZGstbGliL2N1c3RvbS1yZXNvdXJjZXMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgTmFnU3VwcHJlc3Npb25zIH0gZnJvbSAnY2RrLW5hZyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQWdlbnRDb3JlR2F0ZXdheVN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIC8vIE1DUCBSdW50aW1lIGVuZHBvaW50cyBmcm9tIE1DUFJ1bnRpbWVTdGFja1xuICBiaWxsaW5nTWNwUnVudGltZUFybjogc3RyaW5nO1xuICBiaWxsaW5nTWNwUnVudGltZUVuZHBvaW50OiBzdHJpbmc7XG4gIHByaWNpbmdNY3BSdW50aW1lQXJuOiBzdHJpbmc7XG4gIHByaWNpbmdNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcbiAgY2xvdWR3YXRjaE1jcFJ1bnRpbWVBcm46IHN0cmluZztcbiAgY2xvdWR3YXRjaE1jcFJ1bnRpbWVFbmRwb2ludDogc3RyaW5nO1xuICBjbG91ZHRyYWlsTWNwUnVudGltZUFybjogc3RyaW5nO1xuICBjbG91ZHRyYWlsTWNwUnVudGltZUVuZHBvaW50OiBzdHJpbmc7XG4gIGludmVudG9yeU1jcFJ1bnRpbWVBcm46IHN0cmluZztcbiAgaW52ZW50b3J5TWNwUnVudGltZUVuZHBvaW50OiBzdHJpbmc7XG4gIC8vIEF1dGhTdGFjayBDb2duaXRvIC0gdXNlZCBmb3IgT0F1dGggcHJvdmlkZXIgKG91dGJvdW5kIGF1dGggdG8gcnVudGltZXMpXG4gIGF1dGhVc2VyUG9vbElkOiBzdHJpbmc7XG4gIGF1dGhVc2VyUG9vbEFybjogc3RyaW5nO1xuICBhdXRoTTJtQ2xpZW50SWQ6IHN0cmluZztcbiAgLy8gRnJvbnRFbmQgVXNlciBQb29sIGNsaWVudCBJRCAtIGFsbG93ZWQgYXVkaWVuY2UgZm9yIGluYm91bmQgQ1VTVE9NX0pXVCBhdXRob3JpemF0aW9uXG4gIGF1dGhVc2VyUG9vbENsaWVudElkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBBZ2VudENvcmVHYXRld2F5U3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgZ2F0ZXdheUFybjogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgZ2F0ZXdheVVybDogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBZ2VudENvcmVHYXRld2F5U3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFJldHJpZXZlIEF1dGhTdGFjayBNMk0gY2xpZW50IHNlY3JldFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IGRlc2NyaWJlTTJNQ2xpZW50ID0gbmV3IGNyLkF3c0N1c3RvbVJlc291cmNlKHRoaXMsICdEZXNjcmliZU0yTUNsaWVudCcsIHtcbiAgICAgIG9uQ3JlYXRlOiB7XG4gICAgICAgIHNlcnZpY2U6ICdDb2duaXRvSWRlbnRpdHlTZXJ2aWNlUHJvdmlkZXInLFxuICAgICAgICBhY3Rpb246ICdkZXNjcmliZVVzZXJQb29sQ2xpZW50JyxcbiAgICAgICAgcGFyYW1ldGVyczoge1xuICAgICAgICAgIFVzZXJQb29sSWQ6IHByb3BzLmF1dGhVc2VyUG9vbElkLFxuICAgICAgICAgIENsaWVudElkOiBwcm9wcy5hdXRoTTJtQ2xpZW50SWQsXG4gICAgICAgIH0sXG4gICAgICAgIHBoeXNpY2FsUmVzb3VyY2VJZDogY3IuUGh5c2ljYWxSZXNvdXJjZUlkLm9mKCdtMm0tY2xpZW50LXNlY3JldCcpLFxuICAgICAgfSxcbiAgICAgIHBvbGljeTogY3IuQXdzQ3VzdG9tUmVzb3VyY2VQb2xpY3kuZnJvbVN0YXRlbWVudHMoW1xuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgIGFjdGlvbnM6IFsnY29nbml0by1pZHA6RGVzY3JpYmVVc2VyUG9vbENsaWVudCddLFxuICAgICAgICAgIHJlc291cmNlczogW3Byb3BzLmF1dGhVc2VyUG9vbEFybl0sXG4gICAgICAgIH0pLFxuICAgICAgXSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBtMm1DbGllbnRTZWNyZXQgPSBkZXNjcmliZU0yTUNsaWVudC5nZXRSZXNwb25zZUZpZWxkKCdVc2VyUG9vbENsaWVudC5DbGllbnRTZWNyZXQnKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBHYXRld2F5IFRva2VuIEV4Y2hhbmdlIFBvbGljeSAobWFuYWdlZCBwb2xpY3ksIHdpbGRjYXJkKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IHRva2VuRXhjaGFuZ2VQb2xpY3kgPSBuZXcgaWFtLk1hbmFnZWRQb2xpY3kodGhpcywgJ0dhdGV3YXlUb2tlbkV4Y2hhbmdlUG9saWN5Jywge1xuICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgc2lkOiAnQWdlbnRDb3JlSWRlbnRpdHlUb2tlbkV4Y2hhbmdlJyxcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldFdvcmtsb2FkQWNjZXNzVG9rZW4nLFxuICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldFJlc291cmNlT2F1dGgyVG9rZW4nLFxuICAgICAgICAgIF0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgfSksXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEdhdGV3YXkgU2VydmljZSBSb2xlXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgZ2F0ZXdheVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0dhdGV3YXlTZXJ2aWNlUm9sZScsIHtcbiAgICAgIGRlc2NyaXB0aW9uOiAnU2VydmljZSByb2xlIGZvciBDbG91ZE9wcyBBZ2VudENvcmUgR2F0ZXdheScsXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnYmVkcm9jay1hZ2VudGNvcmUuYW1hem9uYXdzLmNvbScpLFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbdG9rZW5FeGNoYW5nZVBvbGljeV0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT0F1dGggUHJvdmlkZXIgKExhbWJkYSBjdXN0b20gcmVzb3VyY2UpXG4gICAgLy8gVXNlcyBBdXRoU3RhY2sncyBDb2duaXRvIGZvciBvdXRib3VuZCBhdXRoIHRvIE1DUCBydW50aW1lc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IG9hdXRoUHJvdmlkZXJGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ09BdXRoUHJvdmlkZXJGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzE0LFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMiksXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbmltcG9ydCBqc29uXG5pbXBvcnQgbG9nZ2luZ1xuaW1wb3J0IG9zXG5pbXBvcnQgdXJsbGliLnJlcXVlc3RcbmltcG9ydCBib3RvM1xuXG5sb2dnZXIgPSBsb2dnaW5nLmdldExvZ2dlcigpXG5sb2dnZXIuc2V0TGV2ZWwobG9nZ2luZy5JTkZPKVxuXG5kZWYgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsIHN0YXR1cywgZGF0YT1Ob25lLCByZWFzb249Tm9uZSwgcGh5c2ljYWxfaWQ9Tm9uZSk6XG4gICAgcmVzcG9uc2VfYm9keSA9IGpzb24uZHVtcHMoe1xuICAgICAgICAnU3RhdHVzJzogc3RhdHVzLFxuICAgICAgICAnUmVhc29uJzogcmVhc29uIG9yICdTZWUgQ2xvdWRXYXRjaCBMb2dzJyxcbiAgICAgICAgJ1BoeXNpY2FsUmVzb3VyY2VJZCc6IHBoeXNpY2FsX2lkIG9yIGV2ZW50LmdldCgnUGh5c2ljYWxSZXNvdXJjZUlkJywgZXZlbnRbJ1JlcXVlc3RJZCddKSxcbiAgICAgICAgJ1N0YWNrSWQnOiBldmVudFsnU3RhY2tJZCddLFxuICAgICAgICAnUmVxdWVzdElkJzogZXZlbnRbJ1JlcXVlc3RJZCddLFxuICAgICAgICAnTG9naWNhbFJlc291cmNlSWQnOiBldmVudFsnTG9naWNhbFJlc291cmNlSWQnXSxcbiAgICAgICAgJ0RhdGEnOiBkYXRhIG9yIHt9LFxuICAgIH0pXG4gICAgcmVzcG9uc2VfdXJsID0gZXZlbnRbJ1Jlc3BvbnNlVVJMJ11cbiAgICBpZiBub3QgcmVzcG9uc2VfdXJsLnN0YXJ0c3dpdGgoJ2h0dHBzOi8vJyk6XG4gICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoZidJbnZhbGlkIHJlc3BvbnNlIFVSTCBzY2hlbWUnKVxuICAgIHJlcSA9IHVybGxpYi5yZXF1ZXN0LlJlcXVlc3QoXG4gICAgICAgIHJlc3BvbnNlX3VybCxcbiAgICAgICAgZGF0YT1yZXNwb25zZV9ib2R5LmVuY29kZSgndXRmLTgnKSxcbiAgICAgICAgaGVhZGVycz17J0NvbnRlbnQtVHlwZSc6ICcnfSxcbiAgICAgICAgbWV0aG9kPSdQVVQnLFxuICAgIClcbiAgICB1cmxsaWIucmVxdWVzdC51cmxvcGVuKHJlcSlcblxuZGVmIGhhbmRsZXIoZXZlbnQsIGNvbnRleHQpOlxuICAgIGxvZ2dlci5pbmZvKCdSZXF1ZXN0IHR5cGU6ICVzJywgZXZlbnRbJ1JlcXVlc3RUeXBlJ10pXG4gICAgcmVxdWVzdF90eXBlID0gZXZlbnRbJ1JlcXVlc3RUeXBlJ11cbiAgICBwcm9wcyA9IGV2ZW50WydSZXNvdXJjZVByb3BlcnRpZXMnXVxuICAgIHByb3ZpZGVyX25hbWUgPSBwcm9wcy5nZXQoJ1Byb3ZpZGVyTmFtZScsICcnKVxuICAgIHJlZ2lvbiA9IHByb3BzLmdldCgnUmVnaW9uJykgb3Igb3MuZW52aXJvbi5nZXQoJ0FXU19SRUdJT04nKVxuICAgIGNsaWVudCA9IGJvdG8zLmNsaWVudCgnYmVkcm9jay1hZ2VudGNvcmUtY29udHJvbCcsIHJlZ2lvbl9uYW1lPXJlZ2lvbilcblxuICAgIGlmIHJlcXVlc3RfdHlwZSA9PSAnRGVsZXRlJzpcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgY2xpZW50LmRlbGV0ZV9vYXV0aDJfY3JlZGVudGlhbF9wcm92aWRlcihuYW1lPXByb3ZpZGVyX25hbWUpXG4gICAgICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnKVxuICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdTVUNDRVNTJylcbiAgICAgICAgcmV0dXJuXG5cbiAgICB0cnk6XG4gICAgICAgIHJlc3BvbnNlID0gY2xpZW50LmNyZWF0ZV9vYXV0aDJfY3JlZGVudGlhbF9wcm92aWRlcihcbiAgICAgICAgICAgIG5hbWU9cHJvdmlkZXJfbmFtZSxcbiAgICAgICAgICAgIGNyZWRlbnRpYWxQcm92aWRlclZlbmRvcj0nQ3VzdG9tT2F1dGgyJyxcbiAgICAgICAgICAgIG9hdXRoMlByb3ZpZGVyQ29uZmlnSW5wdXQ9e1xuICAgICAgICAgICAgICAgICdjdXN0b21PYXV0aDJQcm92aWRlckNvbmZpZyc6IHtcbiAgICAgICAgICAgICAgICAgICAgJ29hdXRoRGlzY292ZXJ5Jzoge1xuICAgICAgICAgICAgICAgICAgICAgICAgJ2Rpc2NvdmVyeVVybCc6IHByb3BzLmdldCgnRGlzY292ZXJ5VXJsJywgJycpLFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAnY2xpZW50SWQnOiBwcm9wcy5nZXQoJ0NsaWVudElkJywgJycpLFxuICAgICAgICAgICAgICAgICAgICAnY2xpZW50U2VjcmV0JzogcHJvcHMuZ2V0KCdDbGllbnRTZWNyZXQnLCAnJyksXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIClcbiAgICAgICAgcHJvdmlkZXJfYXJuID0gcmVzcG9uc2UuZ2V0KCdjcmVkZW50aWFsUHJvdmlkZXJBcm4nLCAnJylcbiAgICAgICAgc2VjcmV0X2FybiA9IHJlc3BvbnNlLmdldCgnY2xpZW50U2VjcmV0QXJuJywge30pLmdldCgnc2VjcmV0QXJuJywgJycpXG4gICAgICAgIGxvZ2dlci5pbmZvKGYnQ3JlYXRlZCBwcm92aWRlcjoge3Byb3ZpZGVyX2Fybn0nKVxuICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnLCBkYXRhPXtcbiAgICAgICAgICAgICdQcm92aWRlckFybic6IHByb3ZpZGVyX2FybixcbiAgICAgICAgICAgICdTZWNyZXRBcm4nOiBzZWNyZXRfYXJuLFxuICAgICAgICB9LCBwaHlzaWNhbF9pZD1wcm92aWRlcl9uYW1lKVxuICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZTpcbiAgICAgICAgbG9nZ2VyLmVycm9yKGYnQ3JlYXRlIGZhaWxlZDoge2V9JylcbiAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdGQUlMRUQnLCByZWFzb249c3RyKGUpKVxuYCksXG4gICAgfSk7XG5cbiAgICAvLyBXaWxkY2FyZCByZXNvdXJjZSBpcyBSRVFVSVJFRCBoZXJlIGFuZCBjYW5ub3QgYmUgc2NvcGVkIGZ1cnRoZXI6IHRoZXNlIGFyZVxuICAgIC8vIGFjY291bnQtbGV2ZWwgY29udHJvbC1wbGFuZSBhY3Rpb25zIG9uIHRoZSBBZ2VudENvcmUgaWRlbnRpdHkgc3RvcmUuIFRoZVxuICAgIC8vIE9BdXRoMiBjcmVkZW50aWFsIHByb3ZpZGVyIGFuZCB0b2tlbiB2YXVsdCBkbyBub3QgZXhpc3QgeWV0ICh0aGlzIGN1c3RvbVxuICAgIC8vIHJlc291cmNlIENSRUFURVMgdGhlbSksIHNvIHRoZWlyIEFSTnMgYXJlIHVua25vd24gYXQgcG9saWN5LWRlZmluaXRpb25cbiAgICAvLyB0aW1lLCBhbmQgQWdlbnRDb3JlIGRvZXMgbm90IHN1cHBvcnQgcmVzb3VyY2UtbGV2ZWwgc2NvcGluZyBmb3IgdGhlXG4gICAgLy8gQ3JlYXRlKi9HZXQqIHRva2VuLXZhdWx0IC8gY3JlZGVudGlhbC1wcm92aWRlciBhY3Rpb25zLiBUaGUgYmxhc3QgcmFkaXVzXG4gICAgLy8gaXMgY29udGFpbmVkIHRvIHRoZSBiZWRyb2NrLWFnZW50Y29yZSBpZGVudGl0eSBBUElzIChubyBkYXRhLXBsYW5lIG9yIElBTVxuICAgIC8vIGFjdGlvbnMpLCB0aGUgZnVuY3Rpb24gcnVucyBvbmx5IGFzIGEgQ2xvdWRGb3JtYXRpb24gY3VzdG9tIHJlc291cmNlLCBhbmRcbiAgICAvLyB0aGUgcmVsYXRlZCBTZWNyZXRzIE1hbmFnZXIgZ3JhbnQgYmVsb3cgSVMgc2NvcGVkIHRvIHRoZVxuICAgIC8vIGJlZHJvY2stYWdlbnRjb3JlLWlkZW50aXR5KiBzZWNyZXQgcHJlZml4LlxuICAgIG9hdXRoUHJvdmlkZXJGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgc2lkOiAnQWdlbnRDb3JlSWRlbnRpdHlQcm92aWRlck1hbmFnZW1lbnQnLFxuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6Q3JlYXRlT2F1dGgyQ3JlZGVudGlhbFByb3ZpZGVyJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkRlbGV0ZU9hdXRoMkNyZWRlbnRpYWxQcm92aWRlcicsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRPYXV0aDJDcmVkZW50aWFsUHJvdmlkZXInLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6Q3JlYXRlVG9rZW5WYXVsdCcsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRUb2tlblZhdWx0JyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIG9hdXRoUHJvdmlkZXJGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnc2VjcmV0c21hbmFnZXI6Q3JlYXRlU2VjcmV0JyxcbiAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlbGV0ZVNlY3JldCcsXG4gICAgICAgICdzZWNyZXRzbWFuYWdlcjpQdXRTZWNyZXRWYWx1ZScsXG4gICAgICAgICdzZWNyZXRzbWFuYWdlcjpUYWdSZXNvdXJjZScsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgIGBhcm46YXdzOnNlY3JldHNtYW5hZ2VyOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpzZWNyZXQ6YmVkcm9jay1hZ2VudGNvcmUtaWRlbnRpdHkqYCxcbiAgICAgIF0sXG4gICAgfSkpO1xuXG4gICAgY29uc3Qgb2F1dGhQcm92aWRlciA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ09BdXRoUHJvdmlkZXInLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IG9hdXRoUHJvdmlkZXJGbi5mdW5jdGlvbkFybixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgUHJvdmlkZXJOYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tb2F1dGgtcHJvdmlkZXJgLFxuICAgICAgICBEaXNjb3ZlcnlVcmw6IGBodHRwczovL2NvZ25pdG8taWRwLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vJHtwcm9wcy5hdXRoVXNlclBvb2xJZH0vLndlbGwta25vd24vb3BlbmlkLWNvbmZpZ3VyYXRpb25gLFxuICAgICAgICBDbGllbnRJZDogcHJvcHMuYXV0aE0ybUNsaWVudElkLFxuICAgICAgICBDbGllbnRTZWNyZXQ6IG0ybUNsaWVudFNlY3JldCxcbiAgICAgICAgUmVnaW9uOiB0aGlzLnJlZ2lvbixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBvYXV0aFByb3ZpZGVyQXJuID0gb2F1dGhQcm92aWRlci5nZXRBdHRTdHJpbmcoJ1Byb3ZpZGVyQXJuJyk7XG4gICAgY29uc3Qgb2F1dGhTZWNyZXRBcm4gPSBvYXV0aFByb3ZpZGVyLmdldEF0dFN0cmluZygnU2VjcmV0QXJuJyk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRGVmYXVsdCBQb2xpY3kgb24gR2F0ZXdheSBSb2xlIChzY29wZWQgdG8gT0F1dGggcHJvdmlkZXIgcmVzb3VyY2VzKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGdhdGV3YXlSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldFJlc291cmNlT2F1dGgyVG9rZW4nLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0V29ya2xvYWRBY2Nlc3NUb2tlbicsXG4gICAgICAgICdzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZScsXG4gICAgICAgICdzZWNyZXRzbWFuYWdlcjpEZXNjcmliZVNlY3JldCcsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbb2F1dGhQcm92aWRlckFybiwgb2F1dGhTZWNyZXRBcm5dLFxuICAgIH0pKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBBZ2VudENvcmUgUG9saWN5IEVuZ2luZSAoTGFtYmRhIGN1c3RvbSByZXNvdXJjZSlcbiAgICAvL1xuICAgIC8vIFRoZSBpbnN0YWxsZWQgQ0RLIGFscGhhIG1vZHVsZSAoQGF3cy1jZGsvYXdzLWJlZHJvY2stYWdlbnRjb3JlLWFscGhhXG4gICAgLy8gMi4yMzUueCkgZG9lcyBOT1QgeWV0IHNoaXAgdGhlIFBvbGljeSBzdWJtb2R1bGUgKFBvbGljeUVuZ2luZSAvIFBvbGljeSAvXG4gICAgLy8gUG9saWN5U3RhdGVtZW50KSDigJQgdGhvc2UgY29uc3RydWN0cyB3ZXJlIGFkZGVkIGluIGEgbGF0ZXIgYWxwaGEgcmVsZWFzZS5cbiAgICAvLyBUaGVyZSBpcyBhbHNvIG5vIGZpcnN0LWNsYXNzIEwxIGZvciB0aGUgZW5naW5lL3BvbGljaWVzIChvbmx5IHRoZVxuICAgIC8vIGdhdGV3YXktc2lkZSBgUG9saWN5RW5naW5lQ29uZmlndXJhdGlvbmAgZXhpc3RzKS4gV2UgdGhlcmVmb3JlIGNyZWF0ZSB0aGVcbiAgICAvLyBlbmdpbmUgYW5kIGl0cyBDZWRhciBwb2xpY2llcyB2aWEgdGhlIGBiZWRyb2NrLWFnZW50Y29yZS1jb250cm9sYCBjb250cm9sXG4gICAgLy8gcGxhbmUgYmVoaW5kIGEgQ0RLIGN1c3RvbSByZXNvdXJjZSwgbWlycm9yaW5nIHRoZSBPQXV0aFByb3ZpZGVyIHBhdHRlcm5cbiAgICAvLyBhYm92ZS5cbiAgICAvL1xuICAgIC8vIEZsb3c6XG4gICAgLy8gICAxLiBQb2xpY3lFbmdpbmUgY3VzdG9tIHJlc291cmNlICAtPiBjcmVhdGVfcG9saWN5X2VuZ2luZSwgd2FpdCBBQ1RJVkUsXG4gICAgLy8gICAgICByZXR1cm5zIHRoZSBlbmdpbmUgQVJOL0lELlxuICAgIC8vICAgMi4gR2F0ZXdheSBjYXJyaWVzIFBvbGljeUVuZ2luZUNvbmZpZ3VyYXRpb24uQXJuID0gZW5naW5lIEFSTiBzbyB0aGVcbiAgICAvLyAgICAgIGVuZ2luZSBpcyBhc3NvY2lhdGVkIHdpdGggdGhlIGdhdGV3YXkgKE1vZGUgPSBFTkZPUkNFKS5cbiAgICAvLyAgIDMuIFBvbGljeUVuZ2luZVBvbGljaWVzIGN1c3RvbSByZXNvdXJjZSAtPiBjcmVhdGVfcG9saWN5IGZvciBlYWNoIENlZGFyXG4gICAgLy8gICAgICBzdGF0ZW1lbnQuIEl0IGRlcGVuZHMgb24gdGhlIGdhdGV3YXkgKyBhbGwgdGFyZ2V0cyBzbyB0aGUgQ2VkYXJcbiAgICAvLyAgICAgIHNjaGVtYSAoZ2VuZXJhdGVkIGZyb20gdGhlIHRhcmdldHMnIHRvb2wgaW5wdXQgc2NoZW1hcykgZXhpc3RzIHdoZW5cbiAgICAvLyAgICAgIHRoZSBwb2xpY2llcyBhcmUgdmFsaWRhdGVkLlxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IHBvbGljeUVuZ2luZUZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnUG9saWN5RW5naW5lRnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xNCxcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDEwKSxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoYFxuaW1wb3J0IGpzb25cbmltcG9ydCBsb2dnaW5nXG5pbXBvcnQgb3NcbmltcG9ydCByZVxuaW1wb3J0IHRpbWVcbmltcG9ydCB1cmxsaWIucmVxdWVzdFxuaW1wb3J0IGJvdG8zXG5mcm9tIGJvdG9jb3JlLmV4Y2VwdGlvbnMgaW1wb3J0IENsaWVudEVycm9yXG5cbmxvZ2dlciA9IGxvZ2dpbmcuZ2V0TG9nZ2VyKClcbmxvZ2dlci5zZXRMZXZlbChsb2dnaW5nLklORk8pXG5cblxuZGVmIF9jbGllbnRfdG9rZW4odmFsdWUpOlxuICAgICMgY2xpZW50VG9rZW4gbXVzdCBtYXRjaCBeW2EtekEtWjAtOV0oLSpbYS16QS1aMC05XSl7MCwyNTZ9JCDigJQgbm9cbiAgICAjIHVuZGVyc2NvcmVzLiBSZWR1Y2UgdG8gYWxwaGFudW1lcmljcyBvbmx5IChhbHdheXMgdmFsaWQpIGFuZCBjYXAgbGVuZ3RoLlxuICAgIHRva2VuID0gcmUuc3ViKHInW15hLXpBLVowLTldJywgJycsIHZhbHVlKVxuICAgIHJldHVybiB0b2tlbls6MjU2XSBvciAndG9rZW4nXG5cblxuZGVmIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCBzdGF0dXMsIGRhdGE9Tm9uZSwgcmVhc29uPU5vbmUsIHBoeXNpY2FsX2lkPU5vbmUpOlxuICAgIHJlc3BvbnNlX2JvZHkgPSBqc29uLmR1bXBzKHtcbiAgICAgICAgJ1N0YXR1cyc6IHN0YXR1cyxcbiAgICAgICAgJ1JlYXNvbic6IHJlYXNvbiBvciAnU2VlIENsb3VkV2F0Y2ggTG9ncycsXG4gICAgICAgICdQaHlzaWNhbFJlc291cmNlSWQnOiBwaHlzaWNhbF9pZCBvciBldmVudC5nZXQoJ1BoeXNpY2FsUmVzb3VyY2VJZCcsIGV2ZW50WydSZXF1ZXN0SWQnXSksXG4gICAgICAgICdTdGFja0lkJzogZXZlbnRbJ1N0YWNrSWQnXSxcbiAgICAgICAgJ1JlcXVlc3RJZCc6IGV2ZW50WydSZXF1ZXN0SWQnXSxcbiAgICAgICAgJ0xvZ2ljYWxSZXNvdXJjZUlkJzogZXZlbnRbJ0xvZ2ljYWxSZXNvdXJjZUlkJ10sXG4gICAgICAgICdEYXRhJzogZGF0YSBvciB7fSxcbiAgICB9KVxuICAgIHJlc3BvbnNlX3VybCA9IGV2ZW50WydSZXNwb25zZVVSTCddXG4gICAgaWYgbm90IHJlc3BvbnNlX3VybC5zdGFydHN3aXRoKCdodHRwczovLycpOlxuICAgICAgICByYWlzZSBWYWx1ZUVycm9yKCdJbnZhbGlkIHJlc3BvbnNlIFVSTCBzY2hlbWUnKVxuICAgIHJlcSA9IHVybGxpYi5yZXF1ZXN0LlJlcXVlc3QoXG4gICAgICAgIHJlc3BvbnNlX3VybCxcbiAgICAgICAgZGF0YT1yZXNwb25zZV9ib2R5LmVuY29kZSgndXRmLTgnKSxcbiAgICAgICAgaGVhZGVycz17J0NvbnRlbnQtVHlwZSc6ICcnfSxcbiAgICAgICAgbWV0aG9kPSdQVVQnLFxuICAgIClcbiAgICB1cmxsaWIucmVxdWVzdC51cmxvcGVuKHJlcSlcblxuXG5kZWYgX2lzX2NvbmZsaWN0KGVycik6XG4gICAgY29kZSA9IGVyci5yZXNwb25zZS5nZXQoJ0Vycm9yJywge30pLmdldCgnQ29kZScsICcnKSBpZiBpc2luc3RhbmNlKGVyciwgQ2xpZW50RXJyb3IpIGVsc2UgJydcbiAgICByZXR1cm4gJ0NvbmZsaWN0JyBpbiBjb2RlIG9yICdBbHJlYWR5RXhpc3RzJyBpbiBjb2RlXG5cblxuZGVmIF9maW5kX2VuZ2luZV9ieV9uYW1lKGNsaWVudCwgbmFtZSk6XG4gICAgdHJ5OlxuICAgICAgICB0b2tlbiA9IE5vbmVcbiAgICAgICAgd2hpbGUgVHJ1ZTpcbiAgICAgICAgICAgIGt3YXJncyA9IHsnbmV4dFRva2VuJzogdG9rZW59IGlmIHRva2VuIGVsc2Uge31cbiAgICAgICAgICAgIHJlc3AgPSBjbGllbnQubGlzdF9wb2xpY3lfZW5naW5lcygqKmt3YXJncylcbiAgICAgICAgICAgIGZvciBpdGVtIGluIHJlc3AuZ2V0KCdwb2xpY3lFbmdpbmVzJywgW10pIG9yIHJlc3AuZ2V0KCdpdGVtcycsIFtdKTpcbiAgICAgICAgICAgICAgICBpZiBpdGVtLmdldCgnbmFtZScpID09IG5hbWU6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBpdGVtXG4gICAgICAgICAgICB0b2tlbiA9IHJlc3AuZ2V0KCduZXh0VG9rZW4nKVxuICAgICAgICAgICAgaWYgbm90IHRva2VuOlxuICAgICAgICAgICAgICAgIGJyZWFrXG4gICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleDpcbiAgICAgICAgbG9nZ2VyLndhcm5pbmcoZidsaXN0X3BvbGljeV9lbmdpbmVzIGZhaWxlZDoge2V4fScpXG4gICAgcmV0dXJuIE5vbmVcblxuXG5kZWYgX2VuZ2luZV9pZChpdGVtKTpcbiAgICByZXR1cm4gaXRlbS5nZXQoJ3BvbGljeUVuZ2luZUlkJykgb3IgaXRlbS5nZXQoJ2lkJylcblxuXG5kZWYgX3dhaXRfZW5naW5lX2FjdGl2ZShjbGllbnQsIGVuZ2luZV9pZCwgdGltZW91dF9zPTQ4MCk6XG4gICAgZGVhZGxpbmUgPSB0aW1lLnRpbWUoKSArIHRpbWVvdXRfc1xuICAgIHdoaWxlIHRpbWUudGltZSgpIDwgZGVhZGxpbmU6XG4gICAgICAgIHJlc3AgPSBjbGllbnQuZ2V0X3BvbGljeV9lbmdpbmUocG9saWN5RW5naW5lSWQ9ZW5naW5lX2lkKVxuICAgICAgICBzdGF0dXMgPSByZXNwLmdldCgnc3RhdHVzJylcbiAgICAgICAgbG9nZ2VyLmluZm8oZidlbmdpbmUge2VuZ2luZV9pZH0gc3RhdHVzPXtzdGF0dXN9JylcbiAgICAgICAgaWYgc3RhdHVzID09ICdBQ1RJVkUnOlxuICAgICAgICAgICAgcmV0dXJuIHJlc3BcbiAgICAgICAgaWYgc3RhdHVzIGFuZCBzdGF0dXMuZW5kc3dpdGgoJ0ZBSUxFRCcpOlxuICAgICAgICAgICAgcmFpc2UgUnVudGltZUVycm9yKGYnZW5naW5lIHtlbmdpbmVfaWR9IHtzdGF0dXN9OiB7cmVzcC5nZXQoXCJzdGF0dXNSZWFzb25zXCIpfScpXG4gICAgICAgIHRpbWUuc2xlZXAoNSlcbiAgICByYWlzZSBUaW1lb3V0RXJyb3IoZidlbmdpbmUge2VuZ2luZV9pZH0gbm90IEFDVElWRSB3aXRoaW4ge3RpbWVvdXRfc31zJylcblxuXG5kZWYgX2xpc3RfcG9saWN5X2lkcyhjbGllbnQsIGVuZ2luZV9pZCk6XG4gICAgaWRzID0gW11cbiAgICB0b2tlbiA9IE5vbmVcbiAgICB3aGlsZSBUcnVlOlxuICAgICAgICBrd2FyZ3MgPSB7J3BvbGljeUVuZ2luZUlkJzogZW5naW5lX2lkfVxuICAgICAgICBpZiB0b2tlbjpcbiAgICAgICAgICAgIGt3YXJnc1snbmV4dFRva2VuJ10gPSB0b2tlblxuICAgICAgICByZXNwID0gY2xpZW50Lmxpc3RfcG9saWNpZXMoKiprd2FyZ3MpXG4gICAgICAgIGZvciBpdGVtIGluIHJlc3AuZ2V0KCdwb2xpY2llcycsIFtdKSBvciByZXNwLmdldCgnaXRlbXMnLCBbXSk6XG4gICAgICAgICAgICBwaWQgPSBpdGVtLmdldCgncG9saWN5SWQnKSBvciBpdGVtLmdldCgnaWQnKVxuICAgICAgICAgICAgaWYgcGlkOlxuICAgICAgICAgICAgICAgIGlkcy5hcHBlbmQocGlkKVxuICAgICAgICB0b2tlbiA9IHJlc3AuZ2V0KCduZXh0VG9rZW4nKVxuICAgICAgICBpZiBub3QgdG9rZW46XG4gICAgICAgICAgICBicmVha1xuICAgIHJldHVybiBpZHNcblxuXG5kZWYgX2RlbGV0ZV9wb2xpY2llcyhjbGllbnQsIGVuZ2luZV9pZCwgdGltZW91dF9zPTEyMCk6XG4gICAgIyBkZWxldGVfcG9saWN5IGlzIGFzeW5jaHJvbm91cywgc28gaXNzdWUgZGVsZXRlcyBmb3IgZXZlcnkgZXhpc3RpbmcgcG9saWN5XG4gICAgIyBhbmQgdGhlbiBXQUlUIHVudGlsIHRoZXkgYXJlIGFsbCBhY3R1YWxseSBnb25lLiBSZWNyZWF0aW5nIGEgcG9saWN5IHdpdGhcbiAgICAjIHRoZSBzYW1lIG5hbWUgd2hpbGUgYSBwcmlvciBvbmUgaXMgc3RpbGwgREVMRVRJTkcgcmFpc2VzIGEgY29uZmxpY3QuXG4gICAgdHJ5OlxuICAgICAgICBmb3IgcGlkIGluIF9saXN0X3BvbGljeV9pZHMoY2xpZW50LCBlbmdpbmVfaWQpOlxuICAgICAgICAgICAgdHJ5OlxuICAgICAgICAgICAgICAgIGNsaWVudC5kZWxldGVfcG9saWN5KHBvbGljeUVuZ2luZUlkPWVuZ2luZV9pZCwgcG9saWN5SWQ9cGlkKVxuICAgICAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleDpcbiAgICAgICAgICAgICAgICBsb2dnZXIud2FybmluZyhmJ2RlbGV0ZV9wb2xpY3kge3BpZH0gZmFpbGVkOiB7ZXh9JylcbiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4OlxuICAgICAgICBsb2dnZXIud2FybmluZyhmJ2xpc3RfcG9saWNpZXMgZmFpbGVkIGR1cmluZyBkZWxldGU6IHtleH0nKVxuICAgICAgICByZXR1cm5cblxuICAgIGRlYWRsaW5lID0gdGltZS50aW1lKCkgKyB0aW1lb3V0X3NcbiAgICB3aGlsZSB0aW1lLnRpbWUoKSA8IGRlYWRsaW5lOlxuICAgICAgICB0cnk6XG4gICAgICAgICAgICByZW1haW5pbmcgPSBfbGlzdF9wb2xpY3lfaWRzKGNsaWVudCwgZW5naW5lX2lkKVxuICAgICAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4OlxuICAgICAgICAgICAgbG9nZ2VyLndhcm5pbmcoZidsaXN0X3BvbGljaWVzIGZhaWxlZCB3aGlsZSB3YWl0aW5nIGZvciBkZWxldGU6IHtleH0nKVxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgIGlmIG5vdCByZW1haW5pbmc6XG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgbG9nZ2VyLmluZm8oZid3YWl0aW5nIGZvciB7bGVuKHJlbWFpbmluZyl9IHBvbGljaWVzIHRvIGZpbmlzaCBkZWxldGluZycpXG4gICAgICAgIHRpbWUuc2xlZXAoNClcbiAgICBsb2dnZXIud2FybmluZygndGltZWQgb3V0IHdhaXRpbmcgZm9yIHBvbGljeSBkZWxldGlvbnMgdG8gY29tcGxldGUnKVxuXG5cbmRlZiBoYW5kbGVfZW5naW5lKGV2ZW50LCBjbGllbnQpOlxuICAgIHByb3BzID0gZXZlbnRbJ1Jlc291cmNlUHJvcGVydGllcyddXG4gICAgbmFtZSA9IHByb3BzWydFbmdpbmVOYW1lJ11cbiAgICByZXF1ZXN0X3R5cGUgPSBldmVudFsnUmVxdWVzdFR5cGUnXVxuXG4gICAgaWYgcmVxdWVzdF90eXBlID09ICdEZWxldGUnOlxuICAgICAgICBleGlzdGluZyA9IF9maW5kX2VuZ2luZV9ieV9uYW1lKGNsaWVudCwgbmFtZSlcbiAgICAgICAgaWYgZXhpc3Rpbmc6XG4gICAgICAgICAgICBlaWQgPSBfZW5naW5lX2lkKGV4aXN0aW5nKVxuICAgICAgICAgICAgX2RlbGV0ZV9wb2xpY2llcyhjbGllbnQsIGVpZClcbiAgICAgICAgICAgIHRyeTpcbiAgICAgICAgICAgICAgICBjbGllbnQuZGVsZXRlX3BvbGljeV9lbmdpbmUocG9saWN5RW5naW5lSWQ9ZWlkKVxuICAgICAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleDpcbiAgICAgICAgICAgICAgICBsb2dnZXIud2FybmluZyhmJ2RlbGV0ZV9wb2xpY3lfZW5naW5lIGZhaWxlZDoge2V4fScpXG4gICAgICAgIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCAnU1VDQ0VTUycpXG4gICAgICAgIHJldHVyblxuXG4gICAgIyBDcmVhdGUgLyBVcGRhdGUgKGVuZ2luZSBuYW1lIGlzIGltbXV0YWJsZSAtPiByZXVzZSBpZiBpdCBhbHJlYWR5IGV4aXN0cylcbiAgICAjIFRoZSBjbGllbnRUb2tlbiBpcyBtYWRlIHVuaXF1ZSBwZXIgQ2xvdWRGb3JtYXRpb24gcmVxdWVzdCAoUmVxdWVzdElkKSBzbyBhXG4gICAgIyBsYXRlciBzdGFjayByZWNyZWF0aW9uIGRvZXMgbm90IGNvbGxpZGUgd2l0aCB0aGUgaWRlbXBvdGVuY3kgcmVjb3JkIG9mIGFcbiAgICAjIHByaW9yIChub3ctZGVsZXRlZCkgZW5naW5lLCB3aGlsZSBzdGlsbCBiZWluZyBzdGFibGUgYWNyb3NzIHRoZSBTREsncyBvd25cbiAgICAjIHJldHJpZXMgd2l0aGluIGEgc2luZ2xlIGNyZWF0ZSBjYWxsLlxuICAgIGVuZ2luZV9pZCA9IE5vbmVcbiAgICB0cnk6XG4gICAgICAgIHJlc3AgPSBjbGllbnQuY3JlYXRlX3BvbGljeV9lbmdpbmUoXG4gICAgICAgICAgICBuYW1lPW5hbWUsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbj1wcm9wcy5nZXQoJ0Rlc2NyaXB0aW9uJywgJ0Nsb3VkT3BzIHJvbGUtYmFzZWQgdG9vbCBhdXRob3JpemF0aW9uIGVuZ2luZScpLFxuICAgICAgICAgICAgY2xpZW50VG9rZW49X2NsaWVudF90b2tlbihuYW1lICsgZXZlbnQuZ2V0KCdSZXF1ZXN0SWQnLCAnJykpLFxuICAgICAgICApXG4gICAgICAgIGVuZ2luZV9pZCA9IHJlc3BbJ3BvbGljeUVuZ2luZUlkJ11cbiAgICBleGNlcHQgQ2xpZW50RXJyb3IgYXMgZXJyOlxuICAgICAgICBpZiBfaXNfY29uZmxpY3QoZXJyKTpcbiAgICAgICAgICAgIGV4aXN0aW5nID0gX2ZpbmRfZW5naW5lX2J5X25hbWUoY2xpZW50LCBuYW1lKVxuICAgICAgICAgICAgaWYgbm90IGV4aXN0aW5nOlxuICAgICAgICAgICAgICAgIHJhaXNlXG4gICAgICAgICAgICBlbmdpbmVfaWQgPSBfZW5naW5lX2lkKGV4aXN0aW5nKVxuICAgICAgICBlbHNlOlxuICAgICAgICAgICAgcmFpc2VcblxuICAgIF93YWl0X2VuZ2luZV9hY3RpdmUoY2xpZW50LCBlbmdpbmVfaWQpXG4gICAgZW5naW5lID0gY2xpZW50LmdldF9wb2xpY3lfZW5naW5lKHBvbGljeUVuZ2luZUlkPWVuZ2luZV9pZClcbiAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnLCBkYXRhPXtcbiAgICAgICAgJ1BvbGljeUVuZ2luZUlkJzogZW5naW5lX2lkLFxuICAgICAgICAnUG9saWN5RW5naW5lQXJuJzogZW5naW5lLmdldCgncG9saWN5RW5naW5lQXJuJywgJycpLFxuICAgIH0sIHBoeXNpY2FsX2lkPWVuZ2luZV9pZClcblxuXG5kZWYgX3dhaXRfcG9saWN5X2FjdGl2ZShjbGllbnQsIGVuZ2luZV9pZCwgcG9saWN5X2lkLCB0aW1lb3V0X3M9MTgwKTpcbiAgICAjIFBvbGljeSBjcmVhdGlvbiBpcyBhc3luY2hyb25vdXM6IGNyZWF0ZV9wb2xpY3kgcmV0dXJucyBDUkVBVElORyBhbmQgdGhlXG4gICAgIyBDZWRhciBhbmFseXplciB2YWxpZGF0ZXMgdGhlIHN0YXRlbWVudCBhZ2FpbnN0IHRoZSBnYXRld2F5J3MgZ2VuZXJhdGVkXG4gICAgIyBzY2hlbWEgYWZ0ZXJ3YXJkcy4gUG9sbCB1bnRpbCBBQ1RJVkUsIGFuZCByYWlzZSAoZmFpbGluZyB0aGUgY3VzdG9tXG4gICAgIyByZXNvdXJjZSkgb24gQ1JFQVRFX0ZBSUxFRCBzbyBhIGJhZCBwb2xpY3kgY2FuIG5ldmVyIGJlIHNpbGVudGx5IGFjY2VwdGVkLlxuICAgIGRlYWRsaW5lID0gdGltZS50aW1lKCkgKyB0aW1lb3V0X3NcbiAgICB3aGlsZSB0aW1lLnRpbWUoKSA8IGRlYWRsaW5lOlxuICAgICAgICByZXNwID0gY2xpZW50LmdldF9wb2xpY3kocG9saWN5RW5naW5lSWQ9ZW5naW5lX2lkLCBwb2xpY3lJZD1wb2xpY3lfaWQpXG4gICAgICAgIHN0YXR1cyA9IHJlc3AuZ2V0KCdzdGF0dXMnKVxuICAgICAgICBsb2dnZXIuaW5mbyhmJ3BvbGljeSB7cG9saWN5X2lkfSBzdGF0dXM9e3N0YXR1c30nKVxuICAgICAgICBpZiBzdGF0dXMgPT0gJ0FDVElWRSc6XG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgaWYgc3RhdHVzIGFuZCAnRkFJTEVEJyBpbiBzdGF0dXM6XG4gICAgICAgICAgICByYWlzZSBSdW50aW1lRXJyb3IoXG4gICAgICAgICAgICAgICAgZidwb2xpY3kge3BvbGljeV9pZH0ge3N0YXR1c306IHtyZXNwLmdldChcInN0YXR1c1JlYXNvbnNcIil9J1xuICAgICAgICAgICAgKVxuICAgICAgICB0aW1lLnNsZWVwKDQpXG4gICAgcmFpc2UgVGltZW91dEVycm9yKGYncG9saWN5IHtwb2xpY3lfaWR9IG5vdCBBQ1RJVkUgd2l0aGluIHt0aW1lb3V0X3N9cycpXG5cblxuZGVmIGhhbmRsZV9wb2xpY2llcyhldmVudCwgY2xpZW50KTpcbiAgICBwcm9wcyA9IGV2ZW50WydSZXNvdXJjZVByb3BlcnRpZXMnXVxuICAgIGVuZ2luZV9pZCA9IHByb3BzWydQb2xpY3lFbmdpbmVJZCddXG4gICAgc3RhdGVtZW50cyA9IHByb3BzLmdldCgnU3RhdGVtZW50cycsIFtdKVxuICAgIHZhbGlkYXRpb25fbW9kZSA9IHByb3BzLmdldCgnVmFsaWRhdGlvbk1vZGUnLCAnRkFJTF9PTl9BTllfRklORElOR1MnKVxuICAgIHJlcXVlc3RfdHlwZSA9IGV2ZW50WydSZXF1ZXN0VHlwZSddXG5cbiAgICBpZiByZXF1ZXN0X3R5cGUgPT0gJ0RlbGV0ZSc6XG4gICAgICAgIF9kZWxldGVfcG9saWNpZXMoY2xpZW50LCBlbmdpbmVfaWQpXG4gICAgICAgIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCAnU1VDQ0VTUycpXG4gICAgICAgIHJldHVyblxuXG4gICAgIyBSZWNvbmNpbGU6IHJlbW92ZSBhbnkgZXhpc3RpbmcgcG9saWNpZXMgZmlyc3Qgc28gQ3JlYXRlIEFORCBVcGRhdGUgYm90aFxuICAgICMgY29udmVyZ2UgdG8gZXhhY3RseSB0aGUgZGVzaXJlZCBzdGF0ZW1lbnQgc2V0IChhbmQgY2xlYW4gdXAgYW55IHByaW9yXG4gICAgIyBmYWlsZWQvcHJvYmUgcG9saWNpZXMpIHdpdGhvdXQgbmFtZS1jb25mbGljdCBlcnJvcnMuXG4gICAgX2RlbGV0ZV9wb2xpY2llcyhjbGllbnQsIGVuZ2luZV9pZClcblxuICAgIGNyZWF0ZWQgPSBbXVxuICAgIGZvciBzdG10IGluIHN0YXRlbWVudHM6XG4gICAgICAgIHBuYW1lID0gc3RtdFsnTmFtZSddXG4gICAgICAgIHJlc3AgPSBjbGllbnQuY3JlYXRlX3BvbGljeShcbiAgICAgICAgICAgIHBvbGljeUVuZ2luZUlkPWVuZ2luZV9pZCxcbiAgICAgICAgICAgIG5hbWU9cG5hbWUsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbj1zdG10LmdldCgnRGVzY3JpcHRpb24nLCAnJyksXG4gICAgICAgICAgICB2YWxpZGF0aW9uTW9kZT12YWxpZGF0aW9uX21vZGUsXG4gICAgICAgICAgICAjIGVuZm9yY2VtZW50TW9kZSBpcyBvbWl0dGVkOiBpdCBpcyBub3QgcHJlc2VudCBpbiB0aGUgTGFtYmRhXG4gICAgICAgICAgICAjIHJ1bnRpbWUncyBidW5kbGVkIGJvdG8zIG1vZGVsIGZvciBjcmVhdGVfcG9saWN5IGFuZCBkZWZhdWx0c1xuICAgICAgICAgICAgIyB0byBBQ1RJVkUgc2VydmljZS1zaWRlICh3aGljaCBpcyB0aGUgZW5mb3JjaW5nIGJlaGF2aW9yIHdlXG4gICAgICAgICAgICAjIHdhbnQ7IHRoZSBnYXRld2F5IFBvbGljeUVuZ2luZUNvbmZpZ3VyYXRpb24gaXMgYWxzbyBFTkZPUkNFKS5cbiAgICAgICAgICAgIGRlZmluaXRpb249eydjZWRhcic6IHsnc3RhdGVtZW50Jzogc3RtdFsnU3RhdGVtZW50J119fSxcbiAgICAgICAgICAgIGNsaWVudFRva2VuPV9jbGllbnRfdG9rZW4oZlwie2VuZ2luZV9pZH17cG5hbWV9e2V2ZW50LmdldCgnUmVxdWVzdElkJywgJycpfVwiKSxcbiAgICAgICAgKVxuICAgICAgICBwb2xpY3lfaWQgPSByZXNwLmdldCgncG9saWN5SWQnLCBwbmFtZSlcbiAgICAgICAgIyBCbG9jayB1bnRpbCB0aGUgcG9saWN5IHZhbGlkYXRlcyBBQ1RJVkU7IHJhaXNlcyBvbiBDUkVBVEVfRkFJTEVELlxuICAgICAgICBfd2FpdF9wb2xpY3lfYWN0aXZlKGNsaWVudCwgZW5naW5lX2lkLCBwb2xpY3lfaWQpXG4gICAgICAgIGNyZWF0ZWQuYXBwZW5kKHBvbGljeV9pZClcblxuICAgIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCAnU1VDQ0VTUycsIGRhdGE9e1xuICAgICAgICAnUG9saWN5SWRzJzogJywnLmpvaW4oY3JlYXRlZCksXG4gICAgfSwgcGh5c2ljYWxfaWQ9Zid7ZW5naW5lX2lkfS1wb2xpY2llcycpXG5cblxuZGVmIGhhbmRsZXIoZXZlbnQsIGNvbnRleHQpOlxuICAgIGxvZ2dlci5pbmZvKGYnRXZlbnQ6IHtqc29uLmR1bXBzKGV2ZW50KX0nKVxuICAgIHByb3BzID0gZXZlbnRbJ1Jlc291cmNlUHJvcGVydGllcyddXG4gICAgb3BlcmF0aW9uID0gcHJvcHMuZ2V0KCdPcGVyYXRpb24nLCAnRU5HSU5FJylcbiAgICByZWdpb24gPSBwcm9wcy5nZXQoJ1JlZ2lvbicpIG9yIG9zLmVudmlyb24uZ2V0KCdBV1NfUkVHSU9OJylcbiAgICBjbGllbnQgPSBib3RvMy5jbGllbnQoJ2JlZHJvY2stYWdlbnRjb3JlLWNvbnRyb2wnLCByZWdpb25fbmFtZT1yZWdpb24pXG4gICAgdHJ5OlxuICAgICAgICBpZiBvcGVyYXRpb24gPT0gJ0VOR0lORSc6XG4gICAgICAgICAgICBoYW5kbGVfZW5naW5lKGV2ZW50LCBjbGllbnQpXG4gICAgICAgIGVsaWYgb3BlcmF0aW9uID09ICdQT0xJQ0lFUyc6XG4gICAgICAgICAgICBoYW5kbGVfcG9saWNpZXMoZXZlbnQsIGNsaWVudClcbiAgICAgICAgZWxzZTpcbiAgICAgICAgICAgIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCAnRkFJTEVEJywgcmVhc29uPWYnVW5rbm93biBvcGVyYXRpb24ge29wZXJhdGlvbn0nKVxuICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZTpcbiAgICAgICAgbG9nZ2VyLmVycm9yKGYne29wZXJhdGlvbn0gZmFpbGVkOiB7ZX0nKVxuICAgICAgICAjIE9uIERlbGV0ZSB3ZSBuZXZlciB3YW50IHRvIGJsb2NrIHN0YWNrIHRlYXJkb3duLlxuICAgICAgICBpZiBldmVudFsnUmVxdWVzdFR5cGUnXSA9PSAnRGVsZXRlJzpcbiAgICAgICAgICAgIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCAnU1VDQ0VTUycpXG4gICAgICAgIGVsc2U6XG4gICAgICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ0ZBSUxFRCcsIHJlYXNvbj1zdHIoZSkpXG5gKSxcbiAgICB9KTtcblxuICAgIC8vIFdpbGRjYXJkIHJlc291cmNlIGlzIFJFUVVJUkVEIGFuZCBjYW5ub3QgYmUgc2NvcGVkIGF0IHBvbGljeS1kZWZpbml0aW9uXG4gICAgLy8gdGltZTogdGhpcyBjdXN0b20gcmVzb3VyY2UgQ1JFQVRFUyB0aGUgcG9saWN5IGVuZ2luZSBhbmQgaXRzIHBvbGljaWVzLCBzb1xuICAgIC8vIHRoZWlyIEFSTnMgZG8gbm90IGV4aXN0IHlldCwgYW5kIHRoZSBMaXN0KiBhY3Rpb25zIGFyZSBhY2NvdW50LWxldmVsIGJ5XG4gICAgLy8gZGVmaW5pdGlvbiAodGhleSBlbnVtZXJhdGUgYWxsIGVuZ2luZXMvcG9saWNpZXMgYW5kIGFjY2VwdCBubyByZXNvdXJjZVxuICAgIC8vIGNvbnN0cmFpbnQpLiBUaGUgZ2F0ZXdheS10YXJnZXRpbmcgYWN0aW9ucyAoSW52b2tlR2F0ZXdheS9HZXRHYXRld2F5L1xuICAgIC8vIExpc3QvR2V0R2F0ZXdheVRhcmdldCkgYXJlIHVzZWQgYXQgY3JlYXRlIHRpbWUgdG8gdmFsaWRhdGUgZWFjaCBDZWRhclxuICAgIC8vIHBvbGljeSBhZ2FpbnN0IHRoZSBsaXZlIGdhdGV3YXkgdG9vbCBzY2hlbWEuIFRoZSBibGFzdCByYWRpdXMgaXMgbGltaXRlZFxuICAgIC8vIHRvIHRoZSBiZWRyb2NrLWFnZW50Y29yZSBQb2xpY3kvR2F0ZXdheSBjb250cm9sIHBsYW5lLCBhbmQgdGhlIGZ1bmN0aW9uXG4gICAgLy8gcnVucyBvbmx5IGFzIGEgQ2xvdWRGb3JtYXRpb24gY3VzdG9tIHJlc291cmNlIGR1cmluZyBzdGFjayBkZXBsb3kvZGVsZXRlLlxuICAgIC8vIChUaGUgZ2F0ZXdheSAqc2VydmljZSogcm9sZSdzIEF1dGhvcml6ZUFjdGlvbiBncmFudCBJUyBzY29wZWQgdG8gdGhlXG4gICAgLy8gc3BlY2lmaWMgcG9saWN5LWVuZ2luZSBhbmQgZ2F0ZXdheSBBUk5zIOKAlCBzZWUgUG9saWN5RW5naW5lQXV0aG9yaXphdGlvbi4pXG4gICAgcG9saWN5RW5naW5lRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIHNpZDogJ0FnZW50Q29yZVBvbGljeUVuZ2luZU1hbmFnZW1lbnQnLFxuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6Q3JlYXRlUG9saWN5RW5naW5lJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkRlbGV0ZVBvbGljeUVuZ2luZScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRQb2xpY3lFbmdpbmUnLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdFBvbGljeUVuZ2luZXMnLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6Q3JlYXRlUG9saWN5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkRlbGV0ZVBvbGljeScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRQb2xpY3knLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdFBvbGljaWVzJyxcbiAgICAgICAgLy8gQ3JlYXRlUG9saWN5IGJpbmRzL3ZhbGlkYXRlcyBlYWNoIENlZGFyIHBvbGljeSBhZ2FpbnN0IHRoZSB0YXJnZXRcbiAgICAgICAgLy8gR2F0ZXdheSdzIHRvb2xzLCB3aGljaCByZXF1aXJlcyByZWFkaW5nIHRoZSBnYXRld2F5IGFuZCBpdHMgdGFyZ2V0cyxcbiAgICAgICAgLy8gbWFuYWdpbmcgdGhlIGdhdGV3YXkncyByZXNvdXJjZS1zY29wZWQgcG9saWN5LCBhbmQgaW52b2tpbmcgdGhlXG4gICAgICAgIC8vIGdhdGV3YXkgdG8gdmFsaWRhdGUgdGhlIGFjdGlvbnMgcmVmZXJlbmNlZCBieSB0aGUgcG9saWN5LlxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TWFuYWdlUmVzb3VyY2VTY29wZWRQb2xpY3knLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6SW52b2tlR2F0ZXdheScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRHYXRld2F5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RHYXRld2F5VGFyZ2V0cycsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRHYXRld2F5VGFyZ2V0JyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIC8vIEFnZW50Q29yZSBQb2xpY3kgcmVzb3VyY2UgbmFtZXMgKGVuZ2luZSArIHBvbGljaWVzKSBtdXN0IG1hdGNoXG4gICAgLy8gXltBLVphLXpdW0EtWmEtejAtOV9dKiQg4oCUIGxldHRlcnMvZGlnaXRzL3VuZGVyc2NvcmVzIG9ubHksIHN0YXJ0aW5nIHdpdGhcbiAgICAvLyBhIGxldHRlci4gU2FuaXRpemUgdGhlIHN0YWNrIG5hbWUgKHdoaWNoIG1heSBjb250YWluIGh5cGhlbnMpIHRvIGEgdmFsaWRcbiAgICAvLyBwcmVmaXggc28gdGhlIENyZWF0ZVBvbGljeUVuZ2luZS9DcmVhdGVQb2xpY3kgY2FsbHMgdmFsaWRhdGUuXG4gICAgY29uc3QgcG9saWN5TmFtZVByZWZpeCA9IGAke3RoaXMuc3RhY2tOYW1lfWAucmVwbGFjZSgvW15BLVphLXowLTlfXS9nLCAnXycpO1xuXG4gICAgY29uc3QgcG9saWN5RW5naW5lID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnUG9saWN5RW5naW5lJywge1xuICAgICAgc2VydmljZVRva2VuOiBwb2xpY3lFbmdpbmVGbi5mdW5jdGlvbkFybixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgT3BlcmF0aW9uOiAnRU5HSU5FJyxcbiAgICAgICAgRW5naW5lTmFtZTogYCR7cG9saWN5TmFtZVByZWZpeH1fcG9saWN5X2VuZ2luZWAsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnQ2xvdWRPcHMgcm9sZS1iYXNlZCB0b29sIGF1dGhvcml6YXRpb24gKENlZGFyKSBmb3IgdGhlIGdhdGV3YXknLFxuICAgICAgICBSZWdpb246IHRoaXMucmVnaW9uLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHBvbGljeUVuZ2luZUFybiA9IHBvbGljeUVuZ2luZS5nZXRBdHRTdHJpbmcoJ1BvbGljeUVuZ2luZUFybicpO1xuICAgIGNvbnN0IHBvbGljeUVuZ2luZUlkID0gcG9saWN5RW5naW5lLmdldEF0dFN0cmluZygnUG9saWN5RW5naW5lSWQnKTtcblxuICAgIC8vIEdhdGV3YXkgRXhlY3V0aW9uIFJvbGUgcGVybWlzc2lvbnMgZm9yIFBvbGljeSBpbiBBZ2VudENvcmUuIFBlciB0aGVcbiAgICAvLyBBZ2VudENvcmUgXCJHYXRld2F5IGFuZCBQb2xpY3kgSUFNIFBlcm1pc3Npb25zXCIgZ3VpZGUsIHRoZSBleGVjdXRpb24gcm9sZVxuICAgIC8vIHJlcXVpcmVzIGV4YWN0bHk6XG4gICAgLy8gICAqIEdldFBvbGljeUVuZ2luZSBvbiB0aGUgcG9saWN5LWVuZ2luZSwgYW5kXG4gICAgLy8gICAqIEF1dGhvcml6ZUFjdGlvbiArIFBhcnRpYWxseUF1dGhvcml6ZUFjdGlvbnMgb24gQk9USCB0aGUgcG9saWN5LWVuZ2luZVxuICAgIC8vICAgICBhbmQgdGhlIGdhdGV3YXkuXG4gICAgLy8gV2l0aG91dCB0aGVzZSB0aGUgR2F0ZXdheSBjYW5ub3QgZXZhbHVhdGUgQ2VkYXIgcG9saWNpZXMgKGF0dGFjaGluZyBhXG4gICAgLy8gUG9saWN5IEVuZ2luZSBmYWlscywgYW5kIGFsbCB0b29sIGludm9jYXRpb25zIGRlZmF1bHQtZGVueSkuXG4gICAgLy8gVGhlIGdhdGV3YXkgQVJOIGlzIGdlbmVyYXRlZCBhdCBjcmVhdGUgdGltZSAocmVmZXJlbmNpbmcgdGhpcy5nYXRld2F5QXJuXG4gICAgLy8gaGVyZSB3b3VsZCBiZSBjaXJjdWxhciksIHNvIHRoZSBnYXRld2F5IHJlc291cmNlIGlzIHNjb3BlZCB0byB0aGlzXG4gICAgLy8gYWNjb3VudC9yZWdpb24ncyBnYXRld2F5IG5hbWVzcGFjZS5cbiAgICBjb25zdCBnYXRld2F5UmVzb3VyY2VXaWxkY2FyZCA9IGBhcm46YXdzOmJlZHJvY2stYWdlbnRjb3JlOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpnYXRld2F5LypgO1xuXG4gICAgZ2F0ZXdheVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgc2lkOiAnUG9saWN5RW5naW5lQ29uZmlndXJhdGlvbicsXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2JlZHJvY2stYWdlbnRjb3JlOkdldFBvbGljeUVuZ2luZSddLFxuICAgICAgcmVzb3VyY2VzOiBbcG9saWN5RW5naW5lQXJuXSxcbiAgICB9KSk7XG5cbiAgICBnYXRld2F5Um9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBzaWQ6ICdQb2xpY3lFbmdpbmVBdXRob3JpemF0aW9uJyxcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkF1dGhvcml6ZUFjdGlvbicsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpQYXJ0aWFsbHlBdXRob3JpemVBY3Rpb25zJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtwb2xpY3lFbmdpbmVBcm4sIGdhdGV3YXlSZXNvdXJjZVdpbGRjYXJkXSxcbiAgICB9KSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRGVueS1hdWRpdCBSRVFVRVNUIGludGVyY2VwdG9yIChMYW1iZGEpXG4gICAgLy9cbiAgICAvLyBFbWl0cyBleGFjdGx5IG9uZSBzdHJ1Y3R1cmVkIENsb3VkV2F0Y2ggcmVjb3JkIG9uIGEgZGVueSBUb29sX0ludm9jYXRpb25cbiAgICAvLyAoSldUIGBzdWJgLCByZXF1ZXN0ZWQgVG9vbF9DYXRlZ29yeSwgYGRlbnlgLCB0aW1lc3RhbXApIOKAlCBuZXZlciB0aGUgdG9rZW5cbiAgICAvLyBvciB0b29sIGFyZ3MvcmVzdWx0cyAoUmVxIDguMykuIEl0IGlzIEFVRElULU9OTFk6IGl0IHJlLWRlcml2ZXMgdGhlXG4gICAgLy8gZGVjaXNpb24gd2l0aCB0aGUgc2FtZSBhdXRob3JpdGF0aXZlIHJvbGUtPmNhdGVnb3J5IG1vZGVsIGFuZCBBTFdBWVNcbiAgICAvLyBmb3J3YXJkcyB0aGUgcmVxdWVzdCB1bmNoYW5nZWQsIHNvIHRoZSBDZWRhciBQb2xpY3kgZW5naW5lIGFib3ZlIHJlbWFpbnNcbiAgICAvLyB0aGUgYXV0aG9yaXRhdGl2ZSBhdXRob3JpemVyLiBBbnkgYXVkaXQgZmFpbHVyZSBpcyBzd2FsbG93ZWQgaW5zaWRlIHRoZVxuICAgIC8vIGhhbmRsZXIgYW5kIHRoZSByZXF1ZXN0IGlzIHN0aWxsIGZvcndhcmRlZCB1bmNoYW5nZWQsIHNvIGFuIGF1ZGl0IGZhaWx1cmVcbiAgICAvLyBjYW4gbmV2ZXIgc3VwcHJlc3MgdGhlIGF1dGhvcml6YXRpb24gZXJyb3IgcmV0dXJuZWQgdG8gdGhlIGNhbGxlclxuICAgIC8vIChSZXEgOC40KS5cbiAgICAvL1xuICAgIC8vIFZlcmlmaWVkIGFnYWluc3QgdGhlIEFnZW50Q29yZSBkb2NzOlxuICAgIC8vICAgKiBgQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpHYXRld2F5YCBleHBvc2VzIGBJbnRlcmNlcHRvckNvbmZpZ3VyYXRpb25zYFxuICAgIC8vICAgICAoYXJyYXksIDHigJMyKS4gRWFjaCBlbnRyeSBoYXMgYEludGVyY2VwdGlvblBvaW50c2AgKFJFUVVFU1QvUkVTUE9OU0UpLFxuICAgIC8vICAgICBgSW50ZXJjZXB0b3IuTGFtYmRhLkFybmAsIGFuZCBgSW5wdXRDb25maWd1cmF0aW9uLlBhc3NSZXF1ZXN0SGVhZGVyc2AuXG4gICAgLy8gICAqIFRoZSBKV1QgYHN1YmAvYHJvbGVgIGFyZSBvbmx5IGF2YWlsYWJsZSB0byB0aGUgaW50ZXJjZXB0b3IgdmlhIHRoZVxuICAgIC8vICAgICBgQXV0aG9yaXphdGlvbmAgaGVhZGVyLCBkZWxpdmVyZWQgb25seSB3aGVuIGBQYXNzUmVxdWVzdEhlYWRlcnNgIGlzXG4gICAgLy8gICAgIHRydWUuIFRoZSBHYXRld2F5IHZlcmlmaWVzIHRoZSBKV1QgYmVmb3JlIGludm9raW5nIHRoZSBpbnRlcmNlcHRvcjtcbiAgICAvLyAgICAgdGhlIGhhbmRsZXIgZGVjb2RlcyAoZG9lcyBub3QgdmVyaWZ5KSBpdCBzb2xlbHkgdG8gcmVhZCBgc3ViYC9gcm9sZWBcbiAgICAvLyAgICAgYW5kIG5ldmVyIGxvZ3MgdGhlIHRva2VuLlxuICAgIC8vICAgKiBBZ2VudENvcmUgUG9saWN5IGFsc28gaGFzIG5hdGl2ZSBkZW55IG9ic2VydmFiaWxpdHkgKG1ldHJpY3MgKyB0cmFjZVxuICAgIC8vICAgICBzcGFucykuIFBlciBkZXNpZ24gTm90ZSA0IHdlIHVzZSB0aGUgaW50ZXJjZXB0b3IgYXMgdGhlIHNpbmdsZVxuICAgIC8vICAgICBjYW5vbmljYWwgZm91ci1maWVsZCBhdWRpdCBlbnRyeSBhbmQgZG8gTk9UIGFsc28gZW5hYmxlIGEgY29tcGV0aW5nXG4gICAgLy8gICAgIG5hdGl2ZS1vYnNlcnZhYmlsaXR5IGF1ZGl0IHNpbmssIGtlZXBpbmcgXCJleGFjdGx5IG9uZSBhdWRpdCBlbnRyeVwiXG4gICAgLy8gICAgIHBlciBkZW55IChSZXEgOC4zKS5cbiAgICAvLyBTZWUgY2RrL2xhbWJkYS9kZW55LWF1ZGl0LWludGVyY2VwdG9yL1JFQURNRS5tZCBmb3IgdGhlIGZ1bGwgcmVzZWFyY2ggbG9nLlxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIERlZGljYXRlZCBsb2cgZ3JvdXAgc28gdGhlIHN0cnVjdHVyZWQgZGVueS1hdWRpdCByZWNvcmRzIGhhdmUgYW4gZXhwbGljaXQsXG4gICAgLy8gcmV0YWluZWQgQ2xvdWRXYXRjaCBkZXN0aW5hdGlvbiAocmF0aGVyIHRoYW4gcmVseWluZyBvbiB0aGUgaW1wbGljaXRcbiAgICAvLyBMYW1iZGEgbG9nIGdyb3VwKS5cbiAgICBjb25zdCBkZW55QXVkaXRMb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdEZW55QXVkaXRJbnRlcmNlcHRvckxvZ0dyb3VwJywge1xuICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX1lFQVIsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZGVueUF1ZGl0SW50ZXJjZXB0b3JGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0RlbnlBdWRpdEludGVyY2VwdG9yRnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyLmhhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvZGVueS1hdWRpdC1pbnRlcmNlcHRvcicpKSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRGVueS1hdWRpdCBSRVFVRVNUIGludGVyY2VwdG9yIGZvciB0aGUgQ2xvdWRPcHMgR2F0ZXdheSAoc3RydWN0dXJlZCBkZW55IHJlY29yZHMpLicsXG4gICAgICBtZW1vcnlTaXplOiAxMjgsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgICBsb2dHcm91cDogZGVueUF1ZGl0TG9nR3JvdXAsXG4gICAgfSk7XG5cbiAgICAvLyBUaGUgR2F0ZXdheSBzZXJ2aWNlIHJvbGUgaW52b2tlcyB0aGUgaW50ZXJjZXB0b3IuIFNjb3BlIHRoZSBncmFudCB0byB0aGlzXG4gICAgLy8gZnVuY3Rpb24gb25seSAoaW50ZXJjZXB0b3Igc2VjdXJpdHkgYmVzdCBwcmFjdGljZSDigJQgbmV2ZXIgYSB3aWxkY2FyZCkuXG4gICAgZGVueUF1ZGl0SW50ZXJjZXB0b3JGbi5ncmFudEludm9rZShnYXRld2F5Um9sZSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRGlzY292ZXJ5LWZpbHRlciBSRVNQT05TRSBpbnRlcmNlcHRvciAoTGFtYmRhKVxuICAgIC8vXG4gICAgLy8gRmlsdGVycyB0aGUgYHRvb2xzL2xpc3RgIERpc2NvdmVyeV9SZXNwb25zZSBkb3duIHRvIHRoZSBjYWxsZXIncyBhbGxvd2VkXG4gICAgLy8gY2F0ZWdvcmllcyBiZWZvcmUgdGhlIEdhdGV3YXkgcmV0dXJucyBpdCwgc28gYSBOb25BZG1pbiB1c2VyIGNhbm5vdFxuICAgIC8vIGVudW1lcmF0ZSB0aGUgbmFtZXMvZGVzY3JpcHRpb25zL2lucHV0IHNjaGVtYXMgb2YgdG9vbHMgdGhleSBjYW5ub3RcbiAgICAvLyBpbnZva2UuIEl0IGlzIGEgRElTVElOQ1QsIGluZGVwZW5kZW50bHkgcmVhc29uZWQgaW50ZXJjZXB0b3IgZnJvbSB0aGVcbiAgICAvLyBkZW55LWF1ZGl0IFJFUVVFU1QgaW50ZXJjZXB0b3IgYWJvdmU6IGl0IHRyYW5zZm9ybXMgb25seSBgdG9vbHMvbGlzdGBcbiAgICAvLyByZXNwb25zZXMsIG5ldmVyIGF1ZGl0cyBvciBlbmZvcmNlcyBpbnZvY2F0aW9uLCByZXVzZXMgdGhlIGF1dGhvcml0YXRpdmVcbiAgICAvLyByb2xlLT5jYXRlZ29yeSBtb2RlbCAodmVuZG9yZWQgYnl0ZS1mb3ItYnl0ZSksIGFuZCBmYWlscyBjbG9zZWQgKHJldHVybnNcbiAgICAvLyBhbiBlbXB0eSB0b29sIGxpc3QpIG9uIGFueSBlcnJvciDigJQgbmV2ZXIgdGhlIHVuZmlsdGVyZWQgY2F0YWxvZy4gSXRcbiAgICAvLyBkZWNvZGVzIChkb2VzIG5vdCB2ZXJpZnkpIHRoZSBhbHJlYWR5LXZlcmlmaWVkIEF1dGhvcml6YXRpb24gSldUIHNvbGVseVxuICAgIC8vIHRvIHJlYWQgYHN1YmAvYHJvbGVgIGFuZCBuZXZlciBsb2dzIHRoZSB0b2tlbi5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBEZWRpY2F0ZWQsIHJldGFpbmVkIGxvZyBncm91cCDigJQgbWlycm9ycyBEZW55QXVkaXRJbnRlcmNlcHRvckxvZ0dyb3VwLlxuICAgIGNvbnN0IGRpc2NvdmVyeUZpbHRlckxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgJ0Rpc2NvdmVyeUZpbHRlckludGVyY2VwdG9yTG9nR3JvdXAnLCB7XG4gICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfWUVBUixcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICBjb25zdCBkaXNjb3ZlcnlGaWx0ZXJJbnRlcmNlcHRvckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnRGlzY292ZXJ5RmlsdGVySW50ZXJjZXB0b3JGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEyLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXIuaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9kaXNjb3ZlcnktZmlsdGVyLWludGVyY2VwdG9yJykpLFxuICAgICAgZGVzY3JpcHRpb246ICdSb2xlLWZpbHRlcmVkIHRvb2wgZGlzY292ZXJ5IFJFU1BPTlNFIGludGVyY2VwdG9yIGZvciB0aGUgQ2xvdWRPcHMgR2F0ZXdheS4nLFxuICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgbG9nR3JvdXA6IGRpc2NvdmVyeUZpbHRlckxvZ0dyb3VwLFxuICAgIH0pO1xuXG4gICAgLy8gVGhlIEdhdGV3YXkgc2VydmljZSByb2xlIGludm9rZXMgdGhlIGludGVyY2VwdG9yLiBTY29wZSB0aGUgZ3JhbnQgdG8gdGhpc1xuICAgIC8vIGZ1bmN0aW9uIG9ubHkgKGludGVyY2VwdG9yIHNlY3VyaXR5IGJlc3QgcHJhY3RpY2Ug4oCUIG5ldmVyIGEgd2lsZGNhcmQpLlxuICAgIGRpc2NvdmVyeUZpbHRlckludGVyY2VwdG9yRm4uZ3JhbnRJbnZva2UoZ2F0ZXdheVJvbGUpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEdhdGV3YXkgKENVU1RPTV9KV1QgYXV0aCDigJQgdmVyaWZpZXMgcGVyLXVzZXIgQ29nbml0byB0b2tlbnMgc28gdGhlXG4gICAgLy8gcm9sZSBjbGFpbSByZWFjaGVzIEFnZW50Q29yZSBQb2xpY3kgZm9yIGZpbmUtZ3JhaW5lZCBhdXRob3JpemF0aW9uKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IGdhdGV3YXkgPSBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdNY3BHYXRld2F5Jywge1xuICAgICAgdHlwZTogJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheScsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIE5hbWU6ICdjbG91ZG9wcy1nYXRld2F5JyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdDbG91ZE9wcyBHYXRld2F5IGZvciBiaWxsaW5nIGFuZCBwcmljaW5nIE1DUCB0b29scyAoSldUIGF1dGgpJyxcbiAgICAgICAgUHJvdG9jb2xUeXBlOiAnTUNQJyxcbiAgICAgICAgQXV0aG9yaXplclR5cGU6ICdDVVNUT01fSldUJyxcbiAgICAgICAgQXV0aG9yaXplckNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBDdXN0b21KV1RBdXRob3JpemVyOiB7XG4gICAgICAgICAgICBEaXNjb3ZlcnlVcmw6IGBodHRwczovL2NvZ25pdG8taWRwLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vJHtwcm9wcy5hdXRoVXNlclBvb2xJZH0vLndlbGwta25vd24vb3BlbmlkLWNvbmZpZ3VyYXRpb25gLFxuICAgICAgICAgICAgLy8gVGhlIEZyb250RW5kIGZvcndhcmRzIHRoZSBDb2duaXRvIEFDQ0VTUyB0b2tlbiwgd2hpY2ggY2Fycmllc1xuICAgICAgICAgICAgLy8gYGNsaWVudF9pZGAgKG5vdCBhbiBgYXVkYCBjbGFpbSDigJQgb25seSBJRCB0b2tlbnMgaGF2ZSBgYXVkYCkuXG4gICAgICAgICAgICAvLyBUaGUgSldUIGF1dGhvcml6ZXIgbXVzdCB0aGVyZWZvcmUgbWF0Y2ggb24gQWxsb3dlZENsaWVudHNcbiAgICAgICAgICAgIC8vIChjbGllbnRfaWQpIHJhdGhlciB0aGFuIEFsbG93ZWRBdWRpZW5jZSwgb3IgdmFsaWRhdGlvbiA0MDNzLlxuICAgICAgICAgICAgQWxsb3dlZENsaWVudHM6IFtwcm9wcy5hdXRoVXNlclBvb2xDbGllbnRJZF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgUHJvdG9jb2xDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTWNwOiB7XG4gICAgICAgICAgICBJbnN0cnVjdGlvbnM6ICdDbG91ZE9wcyBnYXRld2F5IGZvciBiaWxsaW5nLCBwcmljaW5nLCBDbG91ZFdhdGNoLCBDbG91ZFRyYWlsLCBhbmQgaW52ZW50b3J5IE1DUCB0b29scycsXG4gICAgICAgICAgICBTZWFyY2hUeXBlOiAnU0VNQU5USUMnLFxuICAgICAgICAgICAgU3VwcG9ydGVkVmVyc2lvbnM6IFsnMjAyNS0wMy0yNiddLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIC8vIEFzc29jaWF0ZSB0aGUgQ2VkYXIgcG9saWN5IGVuZ2luZS4gRU5GT1JDRSBtYWtlcyB0aGUgZW5naW5lIGRlbnlcbiAgICAgICAgLy8gZGlzYWxsb3dlZCB0b29sIGRpc2NvdmVyeS9pbnZvY2F0aW9uOyBMT0dfT05MWSB3b3VsZCBvbmx5IHRyYWNlLlxuICAgICAgICBQb2xpY3lFbmdpbmVDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgQXJuOiBwb2xpY3lFbmdpbmVBcm4sXG4gICAgICAgICAgTW9kZTogJ0VORk9SQ0UnLFxuICAgICAgICB9LFxuICAgICAgICAvLyBSZWdpc3RlciB0aGUgZGVueS1hdWRpdCBSRVFVRVNUIGludGVyY2VwdG9yLiBQYXNzUmVxdWVzdEhlYWRlcnM9dHJ1ZVxuICAgICAgICAvLyBpcyByZXF1aXJlZCBzbyB0aGUgaW50ZXJjZXB0b3IgY2FuIHJlYWQgdGhlIChhbHJlYWR5LXZlcmlmaWVkKVxuICAgICAgICAvLyBBdXRob3JpemF0aW9uIGhlYWRlciB0byByZWNvdmVyIHRoZSBKV1QgYHN1YmAvYHJvbGVgIGZvciB0aGUgYXVkaXRcbiAgICAgICAgLy8gcmVjb3JkOyB0aGUgaGFuZGxlciBuZXZlciBsb2dzIHRoZSB0b2tlbi4gVGhlIGludGVyY2VwdG9yIGlzXG4gICAgICAgIC8vIGF1ZGl0LW9ubHkgYW5kIGZvcndhcmRzIGV2ZXJ5IHJlcXVlc3QgdW5jaGFuZ2VkLlxuICAgICAgICBJbnRlcmNlcHRvckNvbmZpZ3VyYXRpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgSW50ZXJjZXB0aW9uUG9pbnRzOiBbJ1JFUVVFU1QnXSxcbiAgICAgICAgICAgIEludGVyY2VwdG9yOiB7XG4gICAgICAgICAgICAgIExhbWJkYToge1xuICAgICAgICAgICAgICAgIEFybjogZGVueUF1ZGl0SW50ZXJjZXB0b3JGbi5mdW5jdGlvbkFybixcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBJbnB1dENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICAgICAgUGFzc1JlcXVlc3RIZWFkZXJzOiB0cnVlLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIC8vIFJlZ2lzdGVyIHRoZSBkaXNjb3ZlcnktZmlsdGVyIFJFU1BPTlNFIGludGVyY2VwdG9yLlxuICAgICAgICAgIC8vIFBhc3NSZXF1ZXN0SGVhZGVycz10cnVlIHNvIGl0IGNhbiByZWFkIHRoZSAoYWxyZWFkeS12ZXJpZmllZClcbiAgICAgICAgICAvLyBBdXRob3JpemF0aW9uIGhlYWRlciB0byByZWNvdmVyIHRoZSBKV1QgYHJvbGVgIGZvciBmaWx0ZXJpbmc7XG4gICAgICAgICAgLy8gdGhlIGhhbmRsZXIgbmV2ZXIgbG9ncyB0aGUgdG9rZW4uIEl0IHRyYW5zZm9ybXMgb25seSBgdG9vbHMvbGlzdGBcbiAgICAgICAgICAvLyBkaXNjb3ZlcnkgcmVzcG9uc2VzIGFuZCBmYWlscyBjbG9zZWQgdG8gYW4gZW1wdHkgdG9vbCBsaXN0LlxuICAgICAgICAgIHtcbiAgICAgICAgICAgIEludGVyY2VwdGlvblBvaW50czogWydSRVNQT05TRSddLFxuICAgICAgICAgICAgSW50ZXJjZXB0b3I6IHtcbiAgICAgICAgICAgICAgTGFtYmRhOiB7XG4gICAgICAgICAgICAgICAgQXJuOiBkaXNjb3ZlcnlGaWx0ZXJJbnRlcmNlcHRvckZuLmZ1bmN0aW9uQXJuLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIElucHV0Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgICAgICBQYXNzUmVxdWVzdEhlYWRlcnM6IHRydWUsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICAgIFJvbGVBcm46IGdhdGV3YXlSb2xlLnJvbGVBcm4sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGdhdGV3YXkubm9kZS5hZGREZXBlbmRlbmN5KGRlbnlBdWRpdEludGVyY2VwdG9yRm4pO1xuICAgIGdhdGV3YXkubm9kZS5hZGREZXBlbmRlbmN5KGRpc2NvdmVyeUZpbHRlckludGVyY2VwdG9yRm4pO1xuICAgIGdhdGV3YXkubm9kZS5hZGREZXBlbmRlbmN5KG9hdXRoUHJvdmlkZXIpO1xuICAgIGdhdGV3YXkubm9kZS5hZGREZXBlbmRlbmN5KHBvbGljeUVuZ2luZSk7XG4gICAgLy8gVGhlIEdhdGV3YXkgY2FsbHMgR2V0UG9saWN5RW5naW5lIHVzaW5nIGl0cyBzZXJ2aWNlIHJvbGUgYXQgY3JlYXRlIHRpbWUsXG4gICAgLy8gc28gdGhlIHJvbGUncyBpbmxpbmUgcG9saWN5ICh3aGljaCBncmFudHMgYmVkcm9jay1hZ2VudGNvcmU6R2V0UG9saWN5RW5naW5lXG4gICAgLy8gYW5kIHRoZSBPQXV0aC90b2tlbi1leGNoYW5nZSBwZXJtaXNzaW9ucykgTVVTVCBiZSBhdHRhY2hlZCBiZWZvcmUgdGhlXG4gICAgLy8gR2F0ZXdheSBpcyBjcmVhdGVkLiBXaXRob3V0IHRoaXMgZGVwZW5kZW5jeSBDbG91ZEZvcm1hdGlvbiBtYXkgY3JlYXRlIHRoZVxuICAgIC8vIEdhdGV3YXkgY29uY3VycmVudGx5IHdpdGggdGhlIHJvbGUgcG9saWN5LCBjYXVzaW5nIGFuIGFjY2Vzcy1kZW5pZWQgZXJyb3IuXG4gICAgZ2F0ZXdheS5ub2RlLmFkZERlcGVuZGVuY3koZ2F0ZXdheVJvbGUpO1xuXG4gICAgdGhpcy5nYXRld2F5QXJuID0gZ2F0ZXdheS5nZXRBdHQoJ0dhdGV3YXlBcm4nKS50b1N0cmluZygpO1xuICAgIGNvbnN0IGdhdGV3YXlJZCA9IGdhdGV3YXkuZ2V0QXR0KCdHYXRld2F5SWRlbnRpZmllcicpLnRvU3RyaW5nKCk7XG4gICAgdGhpcy5nYXRld2F5VXJsID0gZ2F0ZXdheS5nZXRBdHQoJ0dhdGV3YXlVcmwnKS50b1N0cmluZygpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEdhdGV3YXkgVGFyZ2V0cyAoTUNQIFNlcnZlciBlbmRwb2ludHMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgYmlsbGluZ1RhcmdldCA9IG5ldyBjZGsuQ2ZuUmVzb3VyY2UodGhpcywgJ0JpbGxpbmdNY3BUYXJnZXQnLCB7XG4gICAgICB0eXBlOiAnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpHYXRld2F5VGFyZ2V0JyxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgR2F0ZXdheUlkZW50aWZpZXI6IGdhdGV3YXlJZCxcbiAgICAgICAgTmFtZTogJ2JpbGxpbmdNY3AnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0FXUyBMYWJzIEJpbGxpbmcgTUNQIFNlcnZlciBvbiBBZ2VudENvcmUgUnVudGltZScsXG4gICAgICAgIFRhcmdldENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBNY3A6IHsgTWNwU2VydmVyOiB7IEVuZHBvaW50OiBwcm9wcy5iaWxsaW5nTWNwUnVudGltZUVuZHBvaW50IH0gfSxcbiAgICAgICAgfSxcbiAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyQ29uZmlndXJhdGlvbnM6IFt7XG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyVHlwZTogJ09BVVRIJyxcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXI6IHtcbiAgICAgICAgICAgIE9hdXRoQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICAgIFByb3ZpZGVyQXJuOiBvYXV0aFByb3ZpZGVyQXJuLFxuICAgICAgICAgICAgICBTY29wZXM6IFsnbWNwLXJ1bnRpbWUtc2VydmVyL2ludm9rZSddLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgYmlsbGluZ1RhcmdldC5ub2RlLmFkZERlcGVuZGVuY3koZ2F0ZXdheSk7XG5cbiAgICBjb25zdCBwcmljaW5nVGFyZ2V0ID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnUHJpY2luZ01jcFRhcmdldCcsIHtcbiAgICAgIHR5cGU6ICdBV1M6OkJlZHJvY2tBZ2VudENvcmU6OkdhdGV3YXlUYXJnZXQnLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBHYXRld2F5SWRlbnRpZmllcjogZ2F0ZXdheUlkLFxuICAgICAgICBOYW1lOiAncHJpY2luZ01jcCcsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnQVdTIExhYnMgUHJpY2luZyBNQ1AgU2VydmVyIG9uIEFnZW50Q29yZSBSdW50aW1lJyxcbiAgICAgICAgVGFyZ2V0Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE1jcDogeyBNY3BTZXJ2ZXI6IHsgRW5kcG9pbnQ6IHByb3BzLnByaWNpbmdNY3BSdW50aW1lRW5kcG9pbnQgfSB9LFxuICAgICAgICB9LFxuICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXJDb25maWd1cmF0aW9uczogW3tcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXJUeXBlOiAnT0FVVEgnLFxuICAgICAgICAgIENyZWRlbnRpYWxQcm92aWRlcjoge1xuICAgICAgICAgICAgT2F1dGhDcmVkZW50aWFsUHJvdmlkZXI6IHtcbiAgICAgICAgICAgICAgUHJvdmlkZXJBcm46IG9hdXRoUHJvdmlkZXJBcm4sXG4gICAgICAgICAgICAgIFNjb3BlczogWydtY3AtcnVudGltZS1zZXJ2ZXIvaW52b2tlJ10sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH1dLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBwcmljaW5nVGFyZ2V0Lm5vZGUuYWRkRGVwZW5kZW5jeShnYXRld2F5KTtcblxuICAgIGNvbnN0IGNsb3Vkd2F0Y2hNY3BUYXJnZXQgPSBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdDbG91ZFdhdGNoTWNwVGFyZ2V0Jywge1xuICAgICAgdHlwZTogJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheVRhcmdldCcsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEdhdGV3YXlJZGVudGlmaWVyOiBnYXRld2F5SWQsXG4gICAgICAgIE5hbWU6ICdjbG91ZHdhdGNoTWNwJyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdBV1MgTGFicyBDbG91ZFdhdGNoIE1DUCBTZXJ2ZXIgb24gQWdlbnRDb3JlIFJ1bnRpbWUnLFxuICAgICAgICBUYXJnZXRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTWNwOiB7IE1jcFNlcnZlcjogeyBFbmRwb2ludDogcHJvcHMuY2xvdWR3YXRjaE1jcFJ1bnRpbWVFbmRwb2ludCB9IH0sXG4gICAgICAgIH0sXG4gICAgICAgIENyZWRlbnRpYWxQcm92aWRlckNvbmZpZ3VyYXRpb25zOiBbe1xuICAgICAgICAgIENyZWRlbnRpYWxQcm92aWRlclR5cGU6ICdPQVVUSCcsXG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICBPYXV0aENyZWRlbnRpYWxQcm92aWRlcjoge1xuICAgICAgICAgICAgICBQcm92aWRlckFybjogb2F1dGhQcm92aWRlckFybixcbiAgICAgICAgICAgICAgU2NvcGVzOiBbJ21jcC1ydW50aW1lLXNlcnZlci9pbnZva2UnXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfV0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNsb3Vkd2F0Y2hNY3BUYXJnZXQubm9kZS5hZGREZXBlbmRlbmN5KGdhdGV3YXkpO1xuXG4gICAgY29uc3QgY2xvdWR0cmFpbE1jcFRhcmdldCA9IG5ldyBjZGsuQ2ZuUmVzb3VyY2UodGhpcywgJ0Nsb3VkVHJhaWxNY3BUYXJnZXQnLCB7XG4gICAgICB0eXBlOiAnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpHYXRld2F5VGFyZ2V0JyxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgR2F0ZXdheUlkZW50aWZpZXI6IGdhdGV3YXlJZCxcbiAgICAgICAgTmFtZTogJ2Nsb3VkdHJhaWxNY3AnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0FXUyBMYWJzIENsb3VkVHJhaWwgTUNQIFNlcnZlciBvbiBBZ2VudENvcmUgUnVudGltZScsXG4gICAgICAgIFRhcmdldENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBNY3A6IHsgTWNwU2VydmVyOiB7IEVuZHBvaW50OiBwcm9wcy5jbG91ZHRyYWlsTWNwUnVudGltZUVuZHBvaW50IH0gfSxcbiAgICAgICAgfSxcbiAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyQ29uZmlndXJhdGlvbnM6IFt7XG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyVHlwZTogJ09BVVRIJyxcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXI6IHtcbiAgICAgICAgICAgIE9hdXRoQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICAgIFByb3ZpZGVyQXJuOiBvYXV0aFByb3ZpZGVyQXJuLFxuICAgICAgICAgICAgICBTY29wZXM6IFsnbWNwLXJ1bnRpbWUtc2VydmVyL2ludm9rZSddLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY2xvdWR0cmFpbE1jcFRhcmdldC5ub2RlLmFkZERlcGVuZGVuY3koZ2F0ZXdheSk7XG5cbiAgICBjb25zdCBpbnZlbnRvcnlNY3BUYXJnZXQgPSBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdJbnZlbnRvcnlNY3BUYXJnZXQnLCB7XG4gICAgICB0eXBlOiAnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpHYXRld2F5VGFyZ2V0JyxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgR2F0ZXdheUlkZW50aWZpZXI6IGdhdGV3YXlJZCxcbiAgICAgICAgTmFtZTogJ2ludmVudG9yeU1jcCcsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnSW52ZW50b3J5IE1DUCBTZXJ2ZXIgb24gQWdlbnRDb3JlIFJ1bnRpbWUnLFxuICAgICAgICBUYXJnZXRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTWNwOiB7IE1jcFNlcnZlcjogeyBFbmRwb2ludDogcHJvcHMuaW52ZW50b3J5TWNwUnVudGltZUVuZHBvaW50IH0gfSxcbiAgICAgICAgfSxcbiAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyQ29uZmlndXJhdGlvbnM6IFt7XG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyVHlwZTogJ09BVVRIJyxcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXI6IHtcbiAgICAgICAgICAgIE9hdXRoQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICAgIFByb3ZpZGVyQXJuOiBvYXV0aFByb3ZpZGVyQXJuLFxuICAgICAgICAgICAgICBTY29wZXM6IFsnbWNwLXJ1bnRpbWUtc2VydmVyL2ludm9rZSddLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgaW52ZW50b3J5TWNwVGFyZ2V0Lm5vZGUuYWRkRGVwZW5kZW5jeShnYXRld2F5KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDZWRhciBwb2xpY2llcyAocm9sZSAtPiB0b29sLWNhdGVnb3J5IG1hcHBpbmcpXG4gICAgLy9cbiAgICAvLyBBdXRob3JpdGF0aXZlIHJvbGUtPmNhdGVnb3J5IG1vZGVsIGltcGxlbWVudGVkIGFzIHR3byBgcGVybWl0YCBzdGF0ZW1lbnRzXG4gICAgLy8gKENlZGFyIGlzIGRlbnktYnktZGVmYXVsdDsgZm9yYmlkIG92ZXJyaWRlcyBwZXJtaXQpOlxuICAgIC8vICAgKiBiaWxsaW5nICsgcHJpY2luZyAgLT4gcGVybWl0dGVkIGZvciBldmVyeSBhdXRoZW50aWNhdGVkIHVzZXIuXG4gICAgLy8gICAqIGNsb3Vkd2F0Y2ggKyBjbG91ZHRyYWlsICsgaW52ZW50b3J5IC0+IHBlcm1pdHRlZCBvbmx5IHdoZW4gdGhlXG4gICAgLy8gICAgIHZlcmlmaWVkIEpXVCBgcm9sZWAgY2xhaW0gKHN0b3JlZCBhcyBhIHByaW5jaXBhbCB0YWcpID09IFwiYWRtaW5cIi5cbiAgICAvLyAgICogZXZlcnl0aGluZyBlbHNlIChpbmNsLiBuZXdseSBhZGRlZCBjYXRlZ29yaWVzKSAtPiBkZW5pZWQgYnkgZGVmYXVsdC5cbiAgICAvL1xuICAgIC8vIENhdGVnb3J5IC0+IHRvb2wgZ3JvdXBpbmcuIEF0IHRoZSBnYXRld2F5IGVhY2ggdG9vbCBhY3Rpb24gaXNcbiAgICAvLyBgQWdlbnRDb3JlOjpBY3Rpb246OlwiPHRhcmdldE5hbWU+X19fPHRvb2xOYW1lPlwiYCAoc2VlIHRoZSBBZ2VudENvcmVcbiAgICAvLyBhdXRob3JpemF0aW9uLWZsb3cgZG9jcykuIEEgY2F0ZWdvcnkgdGhlcmVmb3JlIGNvcnJlc3BvbmRzIHRvIGEgdGFyZ2V0XG4gICAgLy8gdG9vbC1uYW1lIHByZWZpeDpcbiAgICAvLyAgIGJpbGxpbmcgLT4gYmlsbGluZ01jcF9fXywgcHJpY2luZyAtPiBwcmljaW5nTWNwX19fLFxuICAgIC8vICAgY2xvdWR3YXRjaCAtPiBjbG91ZHdhdGNoTWNwX19fLCBjbG91ZHRyYWlsIC0+IGNsb3VkdHJhaWxNY3BfX18sXG4gICAgLy8gICBpbnZlbnRvcnkgLT4gaW52ZW50b3J5TWNwX19fLlxuICAgIC8vXG4gICAgLy8gQVNTVU1QVElPTiAobXVzdCBiZSB2YWxpZGF0ZWQgYWdhaW5zdCB0aGUgbGl2ZSBBZ2VudENvcmUgQ2VkYXIgc2NoZW1hLFxuICAgIC8vIGNvdmVyZWQgYnkgdGhlIGludGVncmF0aW9uIHRlc3RzIGluIHRhc2sgOSk6IHRoZSBncm91cGluZyBpcyBleHByZXNzZWRcbiAgICAvLyBoZXJlIHZpYSBgYWN0aW9uLnRvb2xfY2F0ZWdvcnkgPT0gXCI8Y2F0ZWdvcnk+XCJgLCBtYXRjaGluZyB0aGUgZGVzaWduXG4gICAgLy8gZG9jdW1lbnQncyBwb2xpY3kgc2V0LiBUaGUgY29uY3JldGUgQ2VkYXIgc2NoZW1hIGdlbmVyYXRlZCBmcm9tIHRoZVxuICAgIC8vIGdhdGV3YXkncyB0b29scyBtYXkgaW5zdGVhZCByZXF1aXJlIGVudW1lcmF0aW5nIHRoZSBwZXItdG9vbCBhY3Rpb25cbiAgICAvLyBpZGVudGlmaWVycyBvciBtYXRjaGluZyB0aGUgYDx0YXJnZXROYW1lPl9fX2AgcHJlZml4IGRpcmVjdGx5LiBJZiB0aGVcbiAgICAvLyBsaXZlIHNjaGVtYSBkb2VzIG5vdCBleHBvc2UgYSBgdG9vbF9jYXRlZ29yeWAgYWN0aW9uIGF0dHJpYnV0ZSwgc3dpdGNoXG4gICAgLy8gdGhlc2Ugc3RhdGVtZW50cyB0byBgYWN0aW9uIGluIFtBZ2VudENvcmU6OkFjdGlvbjo6XCJiaWxsaW5nTWNwX19fLi4uXCIsIOKApl1gXG4gICAgLy8gKGVudW1lcmF0ZWQpIG9yIHRoZSBzY2hlbWEncyBkb2N1bWVudGVkIGNhdGVnb3J5IGF0dHJpYnV0ZS4gVGhlXG4gICAgLy8gcm9sZS0+Y2F0ZWdvcnkgU0VNQU5USUNTIGFib3ZlIGFyZSB0aGUgaW52YXJpYW50OyBvbmx5IHRoZSBhY3Rpb24tbWF0Y2hcbiAgICAvLyBleHByZXNzaW9uIGlzIHByb3Zpc2lvbmFsLiBWYWxpZGF0aW9uIHJ1bnMgaW4gRkFJTF9PTl9BTllfRklORElOR1Mgc28gYVxuICAgIC8vIG1hbGZvcm1lZCBwb2xpY3kgZmFpbHMgdGhlIGRlcGxveW1lbnQgbG91ZGx5IGluc3RlYWQgb2YgYmVpbmcgc2lsZW50bHlcbiAgICAvLyBhY2NlcHRlZC5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBjb25zdCBnYXRld2F5QXJuUmVmID0gdGhpcy5nYXRld2F5QXJuO1xuXG4gICAgLy8gQWdlbnRDb3JlIGdlbmVyYXRlcyBhIENlZGFyIGFjdGlvbiBHUk9VUCBwZXIgZ2F0ZXdheSB0YXJnZXQsIG5hbWVkIGJ5IHRoZVxuICAgIC8vIHRhcmdldCBuYW1lIChlLmcuIEFnZW50Q29yZTo6QWN0aW9uOjpcImJpbGxpbmdNY3BcIikuIEVhY2ggdG9vbCBhY3Rpb25cbiAgICAvLyAoPHRhcmdldD5fX188dG9vbD4pIGlzIGEgbWVtYmVyIG9mIGl0cyB0YXJnZXQncyBncm91cCwgc28gd2UgY2FuIHNjb3BlIGFcbiAgICAvLyBwb2xpY3kgdG8gYW4gZW50aXJlIGNhdGVnb3J5IGJ5IHJlZmVyZW5jaW5nIHRoZSB0YXJnZXQgbmFtZSB3ZSBhbHJlYWR5XG4gICAgLy8ga25vdyBmcm9tIENESyDigJQgbm8gcGVyLXRvb2wgZW51bWVyYXRpb24gb3IgcnVudGltZSBkaXNjb3ZlcnkgcmVxdWlyZWQuXG4gICAgLy8gVGhlcmUgaXMgbm8gYHRvb2xfY2F0ZWdvcnlgIGF0dHJpYnV0ZTsgdGhlIHByaW9yIGRlc2lnbiBhc3N1bXB0aW9uIHdhc1xuICAgIC8vIHdyb25nIGFuZCBpcyBjb3JyZWN0ZWQgaGVyZS5cbiAgICAvL1xuICAgIC8vIFB1cmUtcGVybWl0IG1vZGVsIG92ZXIgdGhlIGZpdmUgdGFyZ2V0IGdyb3VwcyAoQ2VkYXIgaXMgZGVueS1ieS1kZWZhdWx0LFxuICAgIC8vIGZvcmJpZC1vdmVycmlkZXMtcGVybWl0KTpcbiAgICAvLyAgICogYmlsbGluZyArIHByaWNpbmcgIC0+IHBlcm1pdHRlZCBmb3IgZXZlcnkgYXV0aGVudGljYXRlZCB1c2VyO1xuICAgIC8vICAgKiBjbG91ZHdhdGNoICsgY2xvdWR0cmFpbCArIGludmVudG9yeSAtPiBwZXJtaXR0ZWQgb25seSB3aGVuIHRoZVxuICAgIC8vICAgICB2ZXJpZmllZCBKV1QgYHJvbGVgIGNsYWltIChhIHByaW5jaXBhbCB0YWcpID09IFwiYWRtaW5cIjtcbiAgICAvLyAgICogZXZlcnl0aGluZyBlbHNlIChpbmNsLiBhbnkgZnV0dXJlIHRhcmdldCBhZGRlZCBsYXRlcikgLT4gZGVuaWVkIGJ5XG4gICAgLy8gICAgIGRlZmF1bHQgZm9yIG5vbi1hZG1pbnMsIHNhdGlzZnlpbmcgdGhlIGRlZmF1bHQtZGVueSByZXF1aXJlbWVudC5cbiAgICAvLyBUaGUgc2VtYW50aWMtc2VhcmNoIC8gdG9vbHMtbGlzdCBtZXRhLW9wZXJhdGlvbnMgYXJlIE5PVCBQb2xpY3ktZ292ZXJuZWRcbiAgICAvLyB0YXJnZXRzLCBzbyB0aGlzIG1vZGVsIGRvZXMgbm90IGFmZmVjdCB0b29sIGRpc2NvdmVyeS5cblxuICAgIGNvbnN0IGFsbFVzZXJzQ2VkYXIgPSBbXG4gICAgICAncGVybWl0KCcsXG4gICAgICAnICBwcmluY2lwYWwgaXMgQWdlbnRDb3JlOjpPQXV0aFVzZXIsJyxcbiAgICAgICcgIGFjdGlvbiBpbiBbQWdlbnRDb3JlOjpBY3Rpb246OlwiYmlsbGluZ01jcFwiLCBBZ2VudENvcmU6OkFjdGlvbjo6XCJwcmljaW5nTWNwXCJdLCcsXG4gICAgICBgICByZXNvdXJjZSA9PSBBZ2VudENvcmU6OkdhdGV3YXk6OlwiJHtnYXRld2F5QXJuUmVmfVwiYCxcbiAgICAgICcpOycsXG4gICAgXS5qb2luKCdcXG4nKTtcblxuICAgIGNvbnN0IGFkbWluT25seUNlZGFyID0gW1xuICAgICAgJ3Blcm1pdCgnLFxuICAgICAgJyAgcHJpbmNpcGFsIGlzIEFnZW50Q29yZTo6T0F1dGhVc2VyLCcsXG4gICAgICAnICBhY3Rpb24gaW4gW0FnZW50Q29yZTo6QWN0aW9uOjpcImNsb3Vkd2F0Y2hNY3BcIiwgQWdlbnRDb3JlOjpBY3Rpb246OlwiY2xvdWR0cmFpbE1jcFwiLCBBZ2VudENvcmU6OkFjdGlvbjo6XCJpbnZlbnRvcnlNY3BcIl0sJyxcbiAgICAgIGAgIHJlc291cmNlID09IEFnZW50Q29yZTo6R2F0ZXdheTo6XCIke2dhdGV3YXlBcm5SZWZ9XCJgLFxuICAgICAgJykgd2hlbiB7JyxcbiAgICAgICcgIHByaW5jaXBhbC5oYXNUYWcoXCJyb2xlXCIpICYmJyxcbiAgICAgICcgIHByaW5jaXBhbC5nZXRUYWcoXCJyb2xlXCIpID09IFwiYWRtaW5cIicsXG4gICAgICAnfTsnLFxuICAgIF0uam9pbignXFxuJyk7XG5cbiAgICBjb25zdCBwb2xpY3lFbmdpbmVQb2xpY2llcyA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ1BvbGljeUVuZ2luZVBvbGljaWVzJywge1xuICAgICAgc2VydmljZVRva2VuOiBwb2xpY3lFbmdpbmVGbi5mdW5jdGlvbkFybixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgT3BlcmF0aW9uOiAnUE9MSUNJRVMnLFxuICAgICAgICBQb2xpY3lFbmdpbmVJZDogcG9saWN5RW5naW5lSWQsXG4gICAgICAgIC8vIFZhbGlkYXRlIHN0cmljdGx5IGFnYWluc3QgdGhlIGdhdGV3YXkncyBnZW5lcmF0ZWQgQ2VkYXIgc2NoZW1hIHNvIGFcbiAgICAgICAgLy8gbWFsZm9ybWVkIHBvbGljeSBmYWlscyB0aGUgZGVwbG95bWVudCBsb3VkbHkgaW5zdGVhZCBvZiBsYW5kaW5nIGluIGFcbiAgICAgICAgLy8gc2lsZW50IGFzeW5jIENSRUFURV9GQUlMRUQgc3RhdGUuIFRoZSBjdXN0b20tcmVzb3VyY2UgTGFtYmRhIHBvbGxzXG4gICAgICAgIC8vIGVhY2ggcG9saWN5IHRvIEFDVElWRSBhbmQgZmFpbHMgaWYgdmFsaWRhdGlvbiBkb2VzIG5vdCBwYXNzLlxuICAgICAgICBWYWxpZGF0aW9uTW9kZTogJ0ZBSUxfT05fQU5ZX0ZJTkRJTkdTJyxcbiAgICAgICAgUmVnaW9uOiB0aGlzLnJlZ2lvbixcbiAgICAgICAgU3RhdGVtZW50czogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIC8vIFBvbGljeSBuYW1lcyBtdXN0IG1hdGNoIF5bQS1aYS16XVtBLVphLXowLTlfXSokIChubyBoeXBoZW5zKS5cbiAgICAgICAgICAgIE5hbWU6ICdhbGxvd19iaWxsaW5nX3ByaWNpbmdfYWxsX3VzZXJzJyxcbiAgICAgICAgICAgIERlc2NyaXB0aW9uOiAnUGVybWl0IGJpbGxpbmcgYW5kIHByaWNpbmcgdG9vbHMgZm9yIGV2ZXJ5IGF1dGhlbnRpY2F0ZWQgdXNlci4nLFxuICAgICAgICAgICAgU3RhdGVtZW50OiBhbGxVc2Vyc0NlZGFyLFxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgTmFtZTogJ2FsbG93X29wc19jYXRlZ29yaWVzX2FkbWluX29ubHknLFxuICAgICAgICAgICAgRGVzY3JpcHRpb246ICdQZXJtaXQgY2xvdWR3YXRjaCwgY2xvdWR0cmFpbCwgYW5kIGludmVudG9yeSB0b29scyBvbmx5IGZvciByb2xlID09IGFkbWluLicsXG4gICAgICAgICAgICBTdGF0ZW1lbnQ6IGFkbWluT25seUNlZGFyLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gUG9saWNpZXMgYXJlIHZhbGlkYXRlZCBhZ2FpbnN0IHRoZSBDZWRhciBzY2hlbWEgZ2VuZXJhdGVkIGZyb20gdGhlXG4gICAgLy8gZ2F0ZXdheSdzIHRvb2xzLCBzbyB0aGV5IG11c3QgYmUgY3JlYXRlZCBhZnRlciB0aGUgZ2F0ZXdheSBhbmQgZXZlcnlcbiAgICAvLyB0YXJnZXQgZXhpc3QuXG4gICAgcG9saWN5RW5naW5lUG9saWNpZXMubm9kZS5hZGREZXBlbmRlbmN5KGdhdGV3YXkpO1xuICAgIHBvbGljeUVuZ2luZVBvbGljaWVzLm5vZGUuYWRkRGVwZW5kZW5jeShiaWxsaW5nVGFyZ2V0KTtcbiAgICBwb2xpY3lFbmdpbmVQb2xpY2llcy5ub2RlLmFkZERlcGVuZGVuY3kocHJpY2luZ1RhcmdldCk7XG4gICAgcG9saWN5RW5naW5lUG9saWNpZXMubm9kZS5hZGREZXBlbmRlbmN5KGNsb3Vkd2F0Y2hNY3BUYXJnZXQpO1xuICAgIHBvbGljeUVuZ2luZVBvbGljaWVzLm5vZGUuYWRkRGVwZW5kZW5jeShjbG91ZHRyYWlsTWNwVGFyZ2V0KTtcbiAgICBwb2xpY3lFbmdpbmVQb2xpY2llcy5ub2RlLmFkZERlcGVuZGVuY3koaW52ZW50b3J5TWNwVGFyZ2V0KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPdXRwdXRzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0dhdGV3YXlBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5nYXRld2F5QXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBZ2VudENvcmUgR2F0ZXdheSBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUdhdGV3YXlBcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0dhdGV3YXlVcmwnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5nYXRld2F5VXJsLFxuICAgICAgZGVzY3JpcHRpb246ICdBZ2VudENvcmUgR2F0ZXdheSBVUkwnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUdhdGV3YXlVcmxgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1BvbGljeUVuZ2luZUFybicsIHtcbiAgICAgIHZhbHVlOiBwb2xpY3lFbmdpbmVBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FnZW50Q29yZSBQb2xpY3kgRW5naW5lIEFSTiAoQ2VkYXIgcm9sZS1iYXNlZCB0b29sIGF1dGhvcml6YXRpb24pJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Qb2xpY3lFbmdpbmVBcm5gLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENESy1OYWcgU3VwcHJlc3Npb25zXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKGdhdGV3YXlSb2xlLCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLCByZWFzb246ICdXaWxkY2FyZCBmb3IgQWdlbnRDb3JlIElkZW50aXR5IHRva2VuIGV4Y2hhbmdlIGFuZCBPQXV0aCBwcm92aWRlciBtYW5hZ2VtZW50LicgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhvYXV0aFByb3ZpZGVyRm4sIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ1dpbGRjYXJkIHJlcXVpcmVkIGZvciBBZ2VudENvcmUgSWRlbnRpdHkgdG9rZW4gdmF1bHQgY3JlYXRpb24gYW5kIGJlZHJvY2stYWdlbnRjb3JlLWlkZW50aXR5IHNlY3JldHMgbmFtZXNwYWNlLicgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhwb2xpY3lFbmdpbmVGbiwgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JywgcmVhc29uOiAnV2lsZGNhcmQgcmVxdWlyZWQgZm9yIEFnZW50Q29yZSBQb2xpY3kgZW5naW5lL3BvbGljeSBtYW5hZ2VtZW50IChDcmVhdGVQb2xpY3lFbmdpbmUvQ3JlYXRlUG9saWN5IG9wZXJhdGUgb24gcmVzb3VyY2VzIGNyZWF0ZWQgYXQgZGVwbG95IHRpbWUpLicgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRTdGFja1N1cHByZXNzaW9ucyh0aGlzLCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTQnLCByZWFzb246ICdBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgaXMgQVdTIGJlc3QgcHJhY3RpY2UuJywgYXBwbGllc1RvOiBbJ1BvbGljeTo6YXJuOjxBV1M6OlBhcnRpdGlvbj46aWFtOjphd3M6cG9saWN5L3NlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUnXSB9LFxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JywgcmVhc29uOiAnV2lsZGNhcmQgZm9yIEFnZW50Q29yZSBJZGVudGl0eSB0b2tlbiBleGNoYW5nZSwgT0F1dGggY3JlZGVudGlhbCBwcm92aWRlciBtYW5hZ2VtZW50LicsIGFwcGxpZXNUbzogWydSZXNvdXJjZTo6KiddIH0sXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUwxJywgcmVhc29uOiAnTGFtYmRhIHJ1bnRpbWUgdmVyc2lvbiBtYW5hZ2VkIGJ5IENESy4nIH0sXG4gICAgXSk7XG4gIH1cbn1cbiJdfQ==