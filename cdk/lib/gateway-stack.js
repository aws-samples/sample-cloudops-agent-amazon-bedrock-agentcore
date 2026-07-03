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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2F0ZXdheS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImdhdGV3YXktc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHlEQUEyQztBQUMzQywrREFBaUQ7QUFDakQsMkRBQTZDO0FBQzdDLGlFQUFtRDtBQUVuRCwyQ0FBNkI7QUFDN0IscUNBQTBDO0FBc0IxQyxNQUFhLHFCQUFzQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBSWxELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBaUM7UUFDekUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsMkNBQTJDO1FBQzNDLHVDQUF1QztRQUN2QywyQ0FBMkM7UUFFM0MsTUFBTSxpQkFBaUIsR0FBRyxJQUFJLEVBQUUsQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDNUUsUUFBUSxFQUFFO2dCQUNSLE9BQU8sRUFBRSxnQ0FBZ0M7Z0JBQ3pDLE1BQU0sRUFBRSx3QkFBd0I7Z0JBQ2hDLFVBQVUsRUFBRTtvQkFDVixVQUFVLEVBQUUsS0FBSyxDQUFDLGNBQWM7b0JBQ2hDLFFBQVEsRUFBRSxLQUFLLENBQUMsZUFBZTtpQkFDaEM7Z0JBQ0Qsa0JBQWtCLEVBQUUsRUFBRSxDQUFDLGtCQUFrQixDQUFDLEVBQUUsQ0FBQyxtQkFBbUIsQ0FBQzthQUNsRTtZQUNELE1BQU0sRUFBRSxFQUFFLENBQUMsdUJBQXVCLENBQUMsY0FBYyxDQUFDO2dCQUNoRCxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7b0JBQ3RCLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7b0JBQ3hCLE9BQU8sRUFBRSxDQUFDLG9DQUFvQyxDQUFDO29CQUMvQyxTQUFTLEVBQUUsQ0FBQyxLQUFLLENBQUMsZUFBZSxDQUFDO2lCQUNuQyxDQUFDO2FBQ0gsQ0FBQztTQUNILENBQUMsQ0FBQztRQUVILE1BQU0sZUFBZSxHQUFHLGlCQUFpQixDQUFDLGdCQUFnQixDQUFDLDZCQUE2QixDQUFDLENBQUM7UUFFMUYsMkNBQTJDO1FBQzNDLDJEQUEyRDtRQUMzRCwyQ0FBMkM7UUFFM0MsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLDRCQUE0QixFQUFFO1lBQ3BGLFVBQVUsRUFBRTtnQkFDVixJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7b0JBQ3RCLEdBQUcsRUFBRSxnQ0FBZ0M7b0JBQ3JDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7b0JBQ3hCLE9BQU8sRUFBRTt3QkFDUCwwQ0FBMEM7d0JBQzFDLDBDQUEwQztxQkFDM0M7b0JBQ0QsU0FBUyxFQUFFLENBQUMsR0FBRyxDQUFDO2lCQUNqQixDQUFDO2FBQ0g7U0FDRixDQUFDLENBQUM7UUFFSCwyQ0FBMkM7UUFDM0MsdUJBQXVCO1FBQ3ZCLDJDQUEyQztRQUUzQyxNQUFNLFdBQVcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFO1lBQzNELFdBQVcsRUFBRSw2Q0FBNkM7WUFDMUQsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLGlDQUFpQyxDQUFDO1lBQ3RFLGVBQWUsRUFBRSxDQUFDLG1CQUFtQixDQUFDO1NBQ3ZDLENBQUMsQ0FBQztRQUVILDJDQUEyQztRQUMzQywwQ0FBMEM7UUFDMUMsNkRBQTZEO1FBQzdELDJDQUEyQztRQUUzQyxNQUFNLGVBQWUsR0FBRyxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLHVCQUF1QixFQUFFO1lBQ3pFLE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDbkMsT0FBTyxFQUFFLGVBQWU7WUFDeEIsT0FBTyxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztZQUNoQyxJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUM7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBdUVsQyxDQUFDO1NBQ0csQ0FBQyxDQUFDO1FBRUgsNkVBQTZFO1FBQzdFLDJFQUEyRTtRQUMzRSwyRUFBMkU7UUFDM0UseUVBQXlFO1FBQ3pFLHNFQUFzRTtRQUN0RSwyRUFBMkU7UUFDM0UsNEVBQTRFO1FBQzVFLDRFQUE0RTtRQUM1RSwyREFBMkQ7UUFDM0QsNkNBQTZDO1FBQzdDLGVBQWUsQ0FBQyxlQUFlLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3RELEdBQUcsRUFBRSxxQ0FBcUM7WUFDMUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUU7Z0JBQ1Asa0RBQWtEO2dCQUNsRCxrREFBa0Q7Z0JBQ2xELCtDQUErQztnQkFDL0Msb0NBQW9DO2dCQUNwQyxpQ0FBaUM7YUFDbEM7WUFDRCxTQUFTLEVBQUUsQ0FBQyxHQUFHLENBQUM7U0FDakIsQ0FBQyxDQUFDLENBQUM7UUFFSixlQUFlLENBQUMsZUFBZSxDQUFDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN0RCxNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLE9BQU8sRUFBRTtnQkFDUCw2QkFBNkI7Z0JBQzdCLDZCQUE2QjtnQkFDN0IsK0JBQStCO2dCQUMvQiw0QkFBNEI7YUFDN0I7WUFDRCxTQUFTLEVBQUU7Z0JBQ1QsMEJBQTBCLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE9BQU8scUNBQXFDO2FBQzNGO1NBQ0YsQ0FBQyxDQUFDLENBQUM7UUFFSixNQUFNLGFBQWEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxjQUFjLENBQUMsSUFBSSxFQUFFLGVBQWUsRUFBRTtZQUNsRSxZQUFZLEVBQUUsZUFBZSxDQUFDLFdBQVc7WUFDekMsVUFBVSxFQUFFO2dCQUNWLFlBQVksRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGlCQUFpQjtnQkFDaEQsWUFBWSxFQUFFLHVCQUF1QixJQUFJLENBQUMsTUFBTSxrQkFBa0IsS0FBSyxDQUFDLGNBQWMsbUNBQW1DO2dCQUN6SCxRQUFRLEVBQUUsS0FBSyxDQUFDLGVBQWU7Z0JBQy9CLFlBQVksRUFBRSxlQUFlO2dCQUM3QixNQUFNLEVBQUUsSUFBSSxDQUFDLE1BQU07YUFDcEI7U0FDRixDQUFDLENBQUM7UUFFSCxNQUFNLGdCQUFnQixHQUFHLGFBQWEsQ0FBQyxZQUFZLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDbkUsTUFBTSxjQUFjLEdBQUcsYUFBYSxDQUFDLFlBQVksQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUUvRCwyQ0FBMkM7UUFDM0Msc0VBQXNFO1FBQ3RFLDJDQUEyQztRQUUzQyxXQUFXLENBQUMsV0FBVyxDQUFDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUM5QyxNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLE9BQU8sRUFBRTtnQkFDUCwwQ0FBMEM7Z0JBQzFDLDBDQUEwQztnQkFDMUMsK0JBQStCO2dCQUMvQiwrQkFBK0I7YUFDaEM7WUFDRCxTQUFTLEVBQUUsQ0FBQyxnQkFBZ0IsRUFBRSxjQUFjLENBQUM7U0FDOUMsQ0FBQyxDQUFDLENBQUM7UUFFSiwyQ0FBMkM7UUFDM0MsbURBQW1EO1FBQ25ELEVBQUU7UUFDRix1RUFBdUU7UUFDdkUsMkVBQTJFO1FBQzNFLDJFQUEyRTtRQUMzRSxvRUFBb0U7UUFDcEUsNEVBQTRFO1FBQzVFLDRFQUE0RTtRQUM1RSwwRUFBMEU7UUFDMUUsU0FBUztRQUNULEVBQUU7UUFDRixRQUFRO1FBQ1IsMkVBQTJFO1FBQzNFLGtDQUFrQztRQUNsQyx5RUFBeUU7UUFDekUsK0RBQStEO1FBQy9ELDRFQUE0RTtRQUM1RSx1RUFBdUU7UUFDdkUsMkVBQTJFO1FBQzNFLG1DQUFtQztRQUNuQywyQ0FBMkM7UUFFM0MsTUFBTSxjQUFjLEdBQUcsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxzQkFBc0IsRUFBRTtZQUN2RSxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLE9BQU8sRUFBRSxlQUFlO1lBQ3hCLE9BQU8sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDakMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrUWxDLENBQUM7U0FDRyxDQUFDLENBQUM7UUFFSCwwRUFBMEU7UUFDMUUsNEVBQTRFO1FBQzVFLDBFQUEwRTtRQUMxRSx5RUFBeUU7UUFDekUsd0VBQXdFO1FBQ3hFLHdFQUF3RTtRQUN4RSwyRUFBMkU7UUFDM0UsMEVBQTBFO1FBQzFFLDRFQUE0RTtRQUM1RSx1RUFBdUU7UUFDdkUsNEVBQTRFO1FBQzVFLGNBQWMsQ0FBQyxlQUFlLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3JELEdBQUcsRUFBRSxpQ0FBaUM7WUFDdEMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUU7Z0JBQ1Asc0NBQXNDO2dCQUN0QyxzQ0FBc0M7Z0JBQ3RDLG1DQUFtQztnQkFDbkMscUNBQXFDO2dCQUNyQyxnQ0FBZ0M7Z0JBQ2hDLGdDQUFnQztnQkFDaEMsNkJBQTZCO2dCQUM3QixnQ0FBZ0M7Z0JBQ2hDLG9FQUFvRTtnQkFDcEUsdUVBQXVFO2dCQUN2RSxrRUFBa0U7Z0JBQ2xFLDREQUE0RDtnQkFDNUQsOENBQThDO2dCQUM5QyxpQ0FBaUM7Z0JBQ2pDLDhCQUE4QjtnQkFDOUIsc0NBQXNDO2dCQUN0QyxvQ0FBb0M7YUFDckM7WUFDRCxTQUFTLEVBQUUsQ0FBQyxHQUFHLENBQUM7U0FDakIsQ0FBQyxDQUFDLENBQUM7UUFFSixpRUFBaUU7UUFDakUsMkVBQTJFO1FBQzNFLDJFQUEyRTtRQUMzRSxnRUFBZ0U7UUFDaEUsTUFBTSxnQkFBZ0IsR0FBRyxHQUFHLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQyxPQUFPLENBQUMsZ0JBQWdCLEVBQUUsR0FBRyxDQUFDLENBQUM7UUFFNUUsTUFBTSxZQUFZLEdBQUcsSUFBSSxHQUFHLENBQUMsY0FBYyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDaEUsWUFBWSxFQUFFLGNBQWMsQ0FBQyxXQUFXO1lBQ3hDLFVBQVUsRUFBRTtnQkFDVixTQUFTLEVBQUUsUUFBUTtnQkFDbkIsVUFBVSxFQUFFLEdBQUcsZ0JBQWdCLGdCQUFnQjtnQkFDL0MsV0FBVyxFQUFFLGdFQUFnRTtnQkFDN0UsTUFBTSxFQUFFLElBQUksQ0FBQyxNQUFNO2FBQ3BCO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsTUFBTSxlQUFlLEdBQUcsWUFBWSxDQUFDLFlBQVksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1FBQ3JFLE1BQU0sY0FBYyxHQUFHLFlBQVksQ0FBQyxZQUFZLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztRQUVuRSxzRUFBc0U7UUFDdEUsMkVBQTJFO1FBQzNFLG9CQUFvQjtRQUNwQixnREFBZ0Q7UUFDaEQsNEVBQTRFO1FBQzVFLHVCQUF1QjtRQUN2Qix3RUFBd0U7UUFDeEUsK0RBQStEO1FBQy9ELDJFQUEyRTtRQUMzRSxxRUFBcUU7UUFDckUsc0NBQXNDO1FBQ3RDLE1BQU0sdUJBQXVCLEdBQUcsNkJBQTZCLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE9BQU8sWUFBWSxDQUFDO1FBRXJHLFdBQVcsQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQzlDLEdBQUcsRUFBRSwyQkFBMkI7WUFDaEMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUUsQ0FBQyxtQ0FBbUMsQ0FBQztZQUM5QyxTQUFTLEVBQUUsQ0FBQyxlQUFlLENBQUM7U0FDN0IsQ0FBQyxDQUFDLENBQUM7UUFFSixXQUFXLENBQUMsV0FBVyxDQUFDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUM5QyxHQUFHLEVBQUUsMkJBQTJCO1lBQ2hDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsT0FBTyxFQUFFO2dCQUNQLG1DQUFtQztnQkFDbkMsNkNBQTZDO2FBQzlDO1lBQ0QsU0FBUyxFQUFFLENBQUMsZUFBZSxFQUFFLHVCQUF1QixDQUFDO1NBQ3RELENBQUMsQ0FBQyxDQUFDO1FBRUosMkNBQTJDO1FBQzNDLDBDQUEwQztRQUMxQyxFQUFFO1FBQ0YsMkVBQTJFO1FBQzNFLDRFQUE0RTtRQUM1RSxzRUFBc0U7UUFDdEUsdUVBQXVFO1FBQ3ZFLDJFQUEyRTtRQUMzRSwwRUFBMEU7UUFDMUUsNEVBQTRFO1FBQzVFLG9FQUFvRTtRQUNwRSxhQUFhO1FBQ2IsRUFBRTtRQUNGLHVDQUF1QztRQUN2QywyRUFBMkU7UUFDM0UsNEVBQTRFO1FBQzVFLDZFQUE2RTtRQUM3RSx5RUFBeUU7UUFDekUsMEVBQTBFO1FBQzFFLDBFQUEwRTtRQUMxRSwyRUFBMkU7UUFDM0UsZ0NBQWdDO1FBQ2hDLDJFQUEyRTtRQUMzRSxxRUFBcUU7UUFDckUsMEVBQTBFO1FBQzFFLHlFQUF5RTtRQUN6RSwwQkFBMEI7UUFDMUIsNkVBQTZFO1FBQzdFLDJDQUEyQztRQUUzQyw2RUFBNkU7UUFDN0UsdUVBQXVFO1FBQ3ZFLHFCQUFxQjtRQUNyQixNQUFNLGlCQUFpQixHQUFHLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsOEJBQThCLEVBQUU7WUFDaEYsU0FBUyxFQUFFLElBQUksQ0FBQyxhQUFhLENBQUMsUUFBUTtZQUN0QyxhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1NBQ3pDLENBQUMsQ0FBQztRQUVILE1BQU0sc0JBQXNCLEdBQUcsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSw4QkFBOEIsRUFBRTtZQUN2RixPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLE9BQU8sRUFBRSxpQkFBaUI7WUFDMUIsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLGtDQUFrQyxDQUFDLENBQUM7WUFDckYsV0FBVyxFQUFFLG9GQUFvRjtZQUNqRyxVQUFVLEVBQUUsR0FBRztZQUNmLE9BQU8sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDakMsUUFBUSxFQUFFLGlCQUFpQjtTQUM1QixDQUFDLENBQUM7UUFFSCw0RUFBNEU7UUFDNUUseUVBQXlFO1FBQ3pFLHNCQUFzQixDQUFDLFdBQVcsQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUVoRCwyQ0FBMkM7UUFDM0MsaURBQWlEO1FBQ2pELEVBQUU7UUFDRiwyRUFBMkU7UUFDM0Usc0VBQXNFO1FBQ3RFLHNFQUFzRTtRQUN0RSx3RUFBd0U7UUFDeEUsd0VBQXdFO1FBQ3hFLDJFQUEyRTtRQUMzRSwyRUFBMkU7UUFDM0Usc0VBQXNFO1FBQ3RFLDBFQUEwRTtRQUMxRSxpREFBaUQ7UUFDakQsMkNBQTJDO1FBRTNDLHdFQUF3RTtRQUN4RSxNQUFNLHVCQUF1QixHQUFHLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsb0NBQW9DLEVBQUU7WUFDNUYsU0FBUyxFQUFFLElBQUksQ0FBQyxhQUFhLENBQUMsUUFBUTtZQUN0QyxhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1NBQ3pDLENBQUMsQ0FBQztRQUVILE1BQU0sNEJBQTRCLEdBQUcsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxvQ0FBb0MsRUFBRTtZQUNuRyxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLE9BQU8sRUFBRSxpQkFBaUI7WUFDMUIsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLHdDQUF3QyxDQUFDLENBQUM7WUFDM0YsV0FBVyxFQUFFLDZFQUE2RTtZQUMxRixVQUFVLEVBQUUsR0FBRztZQUNmLE9BQU8sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDakMsUUFBUSxFQUFFLHVCQUF1QjtTQUNsQyxDQUFDLENBQUM7UUFFSCw0RUFBNEU7UUFDNUUseUVBQXlFO1FBQ3pFLDRCQUE0QixDQUFDLFdBQVcsQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUV0RCwyQ0FBMkM7UUFDM0MscUVBQXFFO1FBQ3JFLHNFQUFzRTtRQUN0RSwyQ0FBMkM7UUFFM0MsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDdEQsSUFBSSxFQUFFLGdDQUFnQztZQUN0QyxVQUFVLEVBQUU7Z0JBQ1YsSUFBSSxFQUFFLGtCQUFrQjtnQkFDeEIsV0FBVyxFQUFFLCtEQUErRDtnQkFDNUUsWUFBWSxFQUFFLEtBQUs7Z0JBQ25CLGNBQWMsRUFBRSxZQUFZO2dCQUM1Qix1QkFBdUIsRUFBRTtvQkFDdkIsbUJBQW1CLEVBQUU7d0JBQ25CLFlBQVksRUFBRSx1QkFBdUIsSUFBSSxDQUFDLE1BQU0sa0JBQWtCLEtBQUssQ0FBQyxjQUFjLG1DQUFtQzt3QkFDekgsZ0VBQWdFO3dCQUNoRSxnRUFBZ0U7d0JBQ2hFLDREQUE0RDt3QkFDNUQsK0RBQStEO3dCQUMvRCxjQUFjLEVBQUUsQ0FBQyxLQUFLLENBQUMsb0JBQW9CLENBQUM7cUJBQzdDO2lCQUNGO2dCQUNELHFCQUFxQixFQUFFO29CQUNyQixHQUFHLEVBQUU7d0JBQ0gsWUFBWSxFQUFFLHdGQUF3Rjt3QkFDdEcsVUFBVSxFQUFFLFVBQVU7d0JBQ3RCLGlCQUFpQixFQUFFLENBQUMsWUFBWSxDQUFDO3FCQUNsQztpQkFDRjtnQkFDRCxtRUFBbUU7Z0JBQ25FLG1FQUFtRTtnQkFDbkUseUJBQXlCLEVBQUU7b0JBQ3pCLEdBQUcsRUFBRSxlQUFlO29CQUNwQixJQUFJLEVBQUUsU0FBUztpQkFDaEI7Z0JBQ0QsdUVBQXVFO2dCQUN2RSxpRUFBaUU7Z0JBQ2pFLHFFQUFxRTtnQkFDckUsK0RBQStEO2dCQUMvRCxtREFBbUQ7Z0JBQ25ELHlCQUF5QixFQUFFO29CQUN6Qjt3QkFDRSxrQkFBa0IsRUFBRSxDQUFDLFNBQVMsQ0FBQzt3QkFDL0IsV0FBVyxFQUFFOzRCQUNYLE1BQU0sRUFBRTtnQ0FDTixHQUFHLEVBQUUsc0JBQXNCLENBQUMsV0FBVzs2QkFDeEM7eUJBQ0Y7d0JBQ0Qsa0JBQWtCLEVBQUU7NEJBQ2xCLGtCQUFrQixFQUFFLElBQUk7eUJBQ3pCO3FCQUNGO29CQUNELHNEQUFzRDtvQkFDdEQsZ0VBQWdFO29CQUNoRSxnRUFBZ0U7b0JBQ2hFLG9FQUFvRTtvQkFDcEUsOERBQThEO29CQUM5RDt3QkFDRSxrQkFBa0IsRUFBRSxDQUFDLFVBQVUsQ0FBQzt3QkFDaEMsV0FBVyxFQUFFOzRCQUNYLE1BQU0sRUFBRTtnQ0FDTixHQUFHLEVBQUUsNEJBQTRCLENBQUMsV0FBVzs2QkFDOUM7eUJBQ0Y7d0JBQ0Qsa0JBQWtCLEVBQUU7NEJBQ2xCLGtCQUFrQixFQUFFLElBQUk7eUJBQ3pCO3FCQUNGO2lCQUNGO2dCQUNELE9BQU8sRUFBRSxXQUFXLENBQUMsT0FBTzthQUM3QjtTQUNGLENBQUMsQ0FBQztRQUNILE9BQU8sQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLHNCQUFzQixDQUFDLENBQUM7UUFDbkQsT0FBTyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsNEJBQTRCLENBQUMsQ0FBQztRQUN6RCxPQUFPLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUMxQyxPQUFPLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUN6QywyRUFBMkU7UUFDM0UsOEVBQThFO1FBQzlFLHdFQUF3RTtRQUN4RSw0RUFBNEU7UUFDNUUsNkVBQTZFO1FBQzdFLE9BQU8sQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBRXhDLElBQUksQ0FBQyxVQUFVLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUMxRCxNQUFNLFNBQVMsR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLG1CQUFtQixDQUFDLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDakUsSUFBSSxDQUFDLFVBQVUsR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBRTFELDJDQUEyQztRQUMzQyx5Q0FBeUM7UUFDekMsMkNBQTJDO1FBRTNDLE1BQU0sYUFBYSxHQUFHLElBQUksR0FBRyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDbEUsSUFBSSxFQUFFLHNDQUFzQztZQUM1QyxVQUFVLEVBQUU7Z0JBQ1YsaUJBQWlCLEVBQUUsU0FBUztnQkFDNUIsSUFBSSxFQUFFLFlBQVk7Z0JBQ2xCLFdBQVcsRUFBRSxrREFBa0Q7Z0JBQy9ELG1CQUFtQixFQUFFO29CQUNuQixHQUFHLEVBQUUsRUFBRSxTQUFTLEVBQUUsRUFBRSxRQUFRLEVBQUUsS0FBSyxDQUFDLHlCQUF5QixFQUFFLEVBQUU7aUJBQ2xFO2dCQUNELGdDQUFnQyxFQUFFLENBQUM7d0JBQ2pDLHNCQUFzQixFQUFFLE9BQU87d0JBQy9CLGtCQUFrQixFQUFFOzRCQUNsQix1QkFBdUIsRUFBRTtnQ0FDdkIsV0FBVyxFQUFFLGdCQUFnQjtnQ0FDN0IsTUFBTSxFQUFFLENBQUMsMkJBQTJCLENBQUM7NkJBQ3RDO3lCQUNGO3FCQUNGLENBQUM7YUFDSDtTQUNGLENBQUMsQ0FBQztRQUNILGFBQWEsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBRTFDLE1BQU0sYUFBYSxHQUFHLElBQUksR0FBRyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDbEUsSUFBSSxFQUFFLHNDQUFzQztZQUM1QyxVQUFVLEVBQUU7Z0JBQ1YsaUJBQWlCLEVBQUUsU0FBUztnQkFDNUIsSUFBSSxFQUFFLFlBQVk7Z0JBQ2xCLFdBQVcsRUFBRSxrREFBa0Q7Z0JBQy9ELG1CQUFtQixFQUFFO29CQUNuQixHQUFHLEVBQUUsRUFBRSxTQUFTLEVBQUUsRUFBRSxRQUFRLEVBQUUsS0FBSyxDQUFDLHlCQUF5QixFQUFFLEVBQUU7aUJBQ2xFO2dCQUNELGdDQUFnQyxFQUFFLENBQUM7d0JBQ2pDLHNCQUFzQixFQUFFLE9BQU87d0JBQy9CLGtCQUFrQixFQUFFOzRCQUNsQix1QkFBdUIsRUFBRTtnQ0FDdkIsV0FBVyxFQUFFLGdCQUFnQjtnQ0FDN0IsTUFBTSxFQUFFLENBQUMsMkJBQTJCLENBQUM7NkJBQ3RDO3lCQUNGO3FCQUNGLENBQUM7YUFDSDtTQUNGLENBQUMsQ0FBQztRQUNILGFBQWEsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBRTFDLE1BQU0sbUJBQW1CLEdBQUcsSUFBSSxHQUFHLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxxQkFBcUIsRUFBRTtZQUMzRSxJQUFJLEVBQUUsc0NBQXNDO1lBQzVDLFVBQVUsRUFBRTtnQkFDVixpQkFBaUIsRUFBRSxTQUFTO2dCQUM1QixJQUFJLEVBQUUsZUFBZTtnQkFDckIsV0FBVyxFQUFFLHFEQUFxRDtnQkFDbEUsbUJBQW1CLEVBQUU7b0JBQ25CLEdBQUcsRUFBRSxFQUFFLFNBQVMsRUFBRSxFQUFFLFFBQVEsRUFBRSxLQUFLLENBQUMsNEJBQTRCLEVBQUUsRUFBRTtpQkFDckU7Z0JBQ0QsZ0NBQWdDLEVBQUUsQ0FBQzt3QkFDakMsc0JBQXNCLEVBQUUsT0FBTzt3QkFDL0Isa0JBQWtCLEVBQUU7NEJBQ2xCLHVCQUF1QixFQUFFO2dDQUN2QixXQUFXLEVBQUUsZ0JBQWdCO2dDQUM3QixNQUFNLEVBQUUsQ0FBQywyQkFBMkIsQ0FBQzs2QkFDdEM7eUJBQ0Y7cUJBQ0YsQ0FBQzthQUNIO1NBQ0YsQ0FBQyxDQUFDO1FBQ0gsbUJBQW1CLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUVoRCxNQUFNLG1CQUFtQixHQUFHLElBQUksR0FBRyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUU7WUFDM0UsSUFBSSxFQUFFLHNDQUFzQztZQUM1QyxVQUFVLEVBQUU7Z0JBQ1YsaUJBQWlCLEVBQUUsU0FBUztnQkFDNUIsSUFBSSxFQUFFLGVBQWU7Z0JBQ3JCLFdBQVcsRUFBRSxxREFBcUQ7Z0JBQ2xFLG1CQUFtQixFQUFFO29CQUNuQixHQUFHLEVBQUUsRUFBRSxTQUFTLEVBQUUsRUFBRSxRQUFRLEVBQUUsS0FBSyxDQUFDLDRCQUE0QixFQUFFLEVBQUU7aUJBQ3JFO2dCQUNELGdDQUFnQyxFQUFFLENBQUM7d0JBQ2pDLHNCQUFzQixFQUFFLE9BQU87d0JBQy9CLGtCQUFrQixFQUFFOzRCQUNsQix1QkFBdUIsRUFBRTtnQ0FDdkIsV0FBVyxFQUFFLGdCQUFnQjtnQ0FDN0IsTUFBTSxFQUFFLENBQUMsMkJBQTJCLENBQUM7NkJBQ3RDO3lCQUNGO3FCQUNGLENBQUM7YUFDSDtTQUNGLENBQUMsQ0FBQztRQUNILG1CQUFtQixDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsT0FBTyxDQUFDLENBQUM7UUFFaEQsTUFBTSxrQkFBa0IsR0FBRyxJQUFJLEdBQUcsQ0FBQyxXQUFXLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFO1lBQ3pFLElBQUksRUFBRSxzQ0FBc0M7WUFDNUMsVUFBVSxFQUFFO2dCQUNWLGlCQUFpQixFQUFFLFNBQVM7Z0JBQzVCLElBQUksRUFBRSxjQUFjO2dCQUNwQixXQUFXLEVBQUUsMkNBQTJDO2dCQUN4RCxtQkFBbUIsRUFBRTtvQkFDbkIsR0FBRyxFQUFFLEVBQUUsU0FBUyxFQUFFLEVBQUUsUUFBUSxFQUFFLEtBQUssQ0FBQywyQkFBMkIsRUFBRSxFQUFFO2lCQUNwRTtnQkFDRCxnQ0FBZ0MsRUFBRSxDQUFDO3dCQUNqQyxzQkFBc0IsRUFBRSxPQUFPO3dCQUMvQixrQkFBa0IsRUFBRTs0QkFDbEIsdUJBQXVCLEVBQUU7Z0NBQ3ZCLFdBQVcsRUFBRSxnQkFBZ0I7Z0NBQzdCLE1BQU0sRUFBRSxDQUFDLDJCQUEyQixDQUFDOzZCQUN0Qzt5QkFDRjtxQkFDRixDQUFDO2FBQ0g7U0FDRixDQUFDLENBQUM7UUFDSCxrQkFBa0IsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBRS9DLDJDQUEyQztRQUMzQyxpREFBaUQ7UUFDakQsRUFBRTtRQUNGLDRFQUE0RTtRQUM1RSx1REFBdUQ7UUFDdkQsb0VBQW9FO1FBQ3BFLHFFQUFxRTtRQUNyRSx3RUFBd0U7UUFDeEUsMkVBQTJFO1FBQzNFLEVBQUU7UUFDRixnRUFBZ0U7UUFDaEUsc0VBQXNFO1FBQ3RFLHlFQUF5RTtRQUN6RSxvQkFBb0I7UUFDcEIsd0RBQXdEO1FBQ3hELG9FQUFvRTtRQUNwRSxrQ0FBa0M7UUFDbEMsRUFBRTtRQUNGLHlFQUF5RTtRQUN6RSx5RUFBeUU7UUFDekUsdUVBQXVFO1FBQ3ZFLHNFQUFzRTtRQUN0RSxzRUFBc0U7UUFDdEUsd0VBQXdFO1FBQ3hFLHlFQUF5RTtRQUN6RSw2RUFBNkU7UUFDN0Usa0VBQWtFO1FBQ2xFLDBFQUEwRTtRQUMxRSwwRUFBMEU7UUFDMUUsd0VBQXdFO1FBQ3hFLDJEQUEyRDtRQUMzRCwyQ0FBMkM7UUFFM0MsTUFBTSxhQUFhLEdBQUcsSUFBSSxDQUFDLFVBQVUsQ0FBQztRQUV0Qyw0RUFBNEU7UUFDNUUsdUVBQXVFO1FBQ3ZFLDJFQUEyRTtRQUMzRSx5RUFBeUU7UUFDekUseUVBQXlFO1FBQ3pFLHlFQUF5RTtRQUN6RSwrQkFBK0I7UUFDL0IsRUFBRTtRQUNGLDJFQUEyRTtRQUMzRSw0QkFBNEI7UUFDNUIsb0VBQW9FO1FBQ3BFLHFFQUFxRTtRQUNyRSw4REFBOEQ7UUFDOUQseUVBQXlFO1FBQ3pFLHVFQUF1RTtRQUN2RSwyRUFBMkU7UUFDM0UseURBQXlEO1FBRXpELE1BQU0sYUFBYSxHQUFHO1lBQ3BCLFNBQVM7WUFDVCxzQ0FBc0M7WUFDdEMsaUZBQWlGO1lBQ2pGLHNDQUFzQyxhQUFhLEdBQUc7WUFDdEQsSUFBSTtTQUNMLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBRWIsTUFBTSxjQUFjLEdBQUc7WUFDckIsU0FBUztZQUNULHNDQUFzQztZQUN0QywwSEFBMEg7WUFDMUgsc0NBQXNDLGFBQWEsR0FBRztZQUN0RCxVQUFVO1lBQ1YsK0JBQStCO1lBQy9CLHVDQUF1QztZQUN2QyxJQUFJO1NBQ0wsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFFYixNQUFNLG9CQUFvQixHQUFHLElBQUksR0FBRyxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUUsc0JBQXNCLEVBQUU7WUFDaEYsWUFBWSxFQUFFLGNBQWMsQ0FBQyxXQUFXO1lBQ3hDLFVBQVUsRUFBRTtnQkFDVixTQUFTLEVBQUUsVUFBVTtnQkFDckIsY0FBYyxFQUFFLGNBQWM7Z0JBQzlCLHNFQUFzRTtnQkFDdEUsdUVBQXVFO2dCQUN2RSxxRUFBcUU7Z0JBQ3JFLCtEQUErRDtnQkFDL0QsY0FBYyxFQUFFLHNCQUFzQjtnQkFDdEMsTUFBTSxFQUFFLElBQUksQ0FBQyxNQUFNO2dCQUNuQixVQUFVLEVBQUU7b0JBQ1Y7d0JBQ0UsZ0VBQWdFO3dCQUNoRSxJQUFJLEVBQUUsaUNBQWlDO3dCQUN2QyxXQUFXLEVBQUUsZ0VBQWdFO3dCQUM3RSxTQUFTLEVBQUUsYUFBYTtxQkFDekI7b0JBQ0Q7d0JBQ0UsSUFBSSxFQUFFLGlDQUFpQzt3QkFDdkMsV0FBVyxFQUFFLDRFQUE0RTt3QkFDekYsU0FBUyxFQUFFLGNBQWM7cUJBQzFCO2lCQUNGO2FBQ0Y7U0FDRixDQUFDLENBQUM7UUFFSCxxRUFBcUU7UUFDckUsdUVBQXVFO1FBQ3ZFLGdCQUFnQjtRQUNoQixvQkFBb0IsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ2pELG9CQUFvQixDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDdkQsb0JBQW9CLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUN2RCxvQkFBb0IsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLG1CQUFtQixDQUFDLENBQUM7UUFDN0Qsb0JBQW9CLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDO1FBQzdELG9CQUFvQixDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsa0JBQWtCLENBQUMsQ0FBQztRQUU1RCwyQ0FBMkM7UUFDM0MsVUFBVTtRQUNWLDJDQUEyQztRQUUzQyxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNwQyxLQUFLLEVBQUUsSUFBSSxDQUFDLFVBQVU7WUFDdEIsV0FBVyxFQUFFLHVCQUF1QjtZQUNwQyxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxhQUFhO1NBQzNDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ3BDLEtBQUssRUFBRSxJQUFJLENBQUMsVUFBVTtZQUN0QixXQUFXLEVBQUUsdUJBQXVCO1lBQ3BDLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGFBQWE7U0FDM0MsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUN6QyxLQUFLLEVBQUUsZUFBZTtZQUN0QixXQUFXLEVBQUUsbUVBQW1FO1lBQ2hGLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLGtCQUFrQjtTQUNoRCxDQUFDLENBQUM7UUFFSCwyQ0FBMkM7UUFDM0MsdUJBQXVCO1FBQ3ZCLDJDQUEyQztRQUUzQyx5QkFBZSxDQUFDLHVCQUF1QixDQUFDLFdBQVcsRUFBRTtZQUNuRCxFQUFFLEVBQUUsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLEVBQUUsK0VBQStFLEVBQUU7U0FDckgsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUVULHlCQUFlLENBQUMsdUJBQXVCLENBQUMsZUFBZSxFQUFFO1lBQ3ZELEVBQUUsRUFBRSxFQUFFLG1CQUFtQixFQUFFLE1BQU0sRUFBRSxpSEFBaUgsRUFBRTtTQUN2SixFQUFFLElBQUksQ0FBQyxDQUFDO1FBRVQseUJBQWUsQ0FBQyx1QkFBdUIsQ0FBQyxjQUFjLEVBQUU7WUFDdEQsRUFBRSxFQUFFLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxFQUFFLGdKQUFnSixFQUFFO1NBQ3RMLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFFVCx5QkFBZSxDQUFDLG9CQUFvQixDQUFDLElBQUksRUFBRTtZQUN6QyxFQUFFLEVBQUUsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLEVBQUUsbURBQW1ELEVBQUUsU0FBUyxFQUFFLENBQUMsdUZBQXVGLENBQUMsRUFBRTtZQUM5TCxFQUFFLEVBQUUsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLEVBQUUsdUZBQXVGLEVBQUUsU0FBUyxFQUFFLENBQUMsYUFBYSxDQUFDLEVBQUU7WUFDeEosRUFBRSxFQUFFLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxFQUFFLHdDQUF3QyxFQUFFO1NBQzVFLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQTkvQkQsc0RBOC9CQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGNyIGZyb20gJ2F3cy1jZGstbGliL2N1c3RvbS1yZXNvdXJjZXMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgTmFnU3VwcHJlc3Npb25zIH0gZnJvbSAnY2RrLW5hZyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQWdlbnRDb3JlR2F0ZXdheVN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIC8vIE1DUCBSdW50aW1lIGVuZHBvaW50cyBmcm9tIE1DUFJ1bnRpbWVTdGFja1xuICBiaWxsaW5nTWNwUnVudGltZUFybjogc3RyaW5nO1xuICBiaWxsaW5nTWNwUnVudGltZUVuZHBvaW50OiBzdHJpbmc7XG4gIHByaWNpbmdNY3BSdW50aW1lQXJuOiBzdHJpbmc7XG4gIHByaWNpbmdNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcbiAgY2xvdWR3YXRjaE1jcFJ1bnRpbWVBcm46IHN0cmluZztcbiAgY2xvdWR3YXRjaE1jcFJ1bnRpbWVFbmRwb2ludDogc3RyaW5nO1xuICBjbG91ZHRyYWlsTWNwUnVudGltZUFybjogc3RyaW5nO1xuICBjbG91ZHRyYWlsTWNwUnVudGltZUVuZHBvaW50OiBzdHJpbmc7XG4gIGludmVudG9yeU1jcFJ1bnRpbWVBcm46IHN0cmluZztcbiAgaW52ZW50b3J5TWNwUnVudGltZUVuZHBvaW50OiBzdHJpbmc7XG4gIC8vIEF1dGhTdGFjayBDb2duaXRvIC0gdXNlZCBmb3IgT0F1dGggcHJvdmlkZXIgKG91dGJvdW5kIGF1dGggdG8gcnVudGltZXMpXG4gIGF1dGhVc2VyUG9vbElkOiBzdHJpbmc7XG4gIGF1dGhVc2VyUG9vbEFybjogc3RyaW5nO1xuICBhdXRoTTJtQ2xpZW50SWQ6IHN0cmluZztcbiAgLy8gRnJvbnRFbmQgVXNlciBQb29sIGNsaWVudCBJRCAtIGFsbG93ZWQgYXVkaWVuY2UgZm9yIGluYm91bmQgQ1VTVE9NX0pXVCBhdXRob3JpemF0aW9uXG4gIGF1dGhVc2VyUG9vbENsaWVudElkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBBZ2VudENvcmVHYXRld2F5U3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgZ2F0ZXdheUFybjogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgZ2F0ZXdheVVybDogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBZ2VudENvcmVHYXRld2F5U3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFJldHJpZXZlIEF1dGhTdGFjayBNMk0gY2xpZW50IHNlY3JldFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IGRlc2NyaWJlTTJNQ2xpZW50ID0gbmV3IGNyLkF3c0N1c3RvbVJlc291cmNlKHRoaXMsICdEZXNjcmliZU0yTUNsaWVudCcsIHtcbiAgICAgIG9uQ3JlYXRlOiB7XG4gICAgICAgIHNlcnZpY2U6ICdDb2duaXRvSWRlbnRpdHlTZXJ2aWNlUHJvdmlkZXInLFxuICAgICAgICBhY3Rpb246ICdkZXNjcmliZVVzZXJQb29sQ2xpZW50JyxcbiAgICAgICAgcGFyYW1ldGVyczoge1xuICAgICAgICAgIFVzZXJQb29sSWQ6IHByb3BzLmF1dGhVc2VyUG9vbElkLFxuICAgICAgICAgIENsaWVudElkOiBwcm9wcy5hdXRoTTJtQ2xpZW50SWQsXG4gICAgICAgIH0sXG4gICAgICAgIHBoeXNpY2FsUmVzb3VyY2VJZDogY3IuUGh5c2ljYWxSZXNvdXJjZUlkLm9mKCdtMm0tY2xpZW50LXNlY3JldCcpLFxuICAgICAgfSxcbiAgICAgIHBvbGljeTogY3IuQXdzQ3VzdG9tUmVzb3VyY2VQb2xpY3kuZnJvbVN0YXRlbWVudHMoW1xuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgIGFjdGlvbnM6IFsnY29nbml0by1pZHA6RGVzY3JpYmVVc2VyUG9vbENsaWVudCddLFxuICAgICAgICAgIHJlc291cmNlczogW3Byb3BzLmF1dGhVc2VyUG9vbEFybl0sXG4gICAgICAgIH0pLFxuICAgICAgXSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBtMm1DbGllbnRTZWNyZXQgPSBkZXNjcmliZU0yTUNsaWVudC5nZXRSZXNwb25zZUZpZWxkKCdVc2VyUG9vbENsaWVudC5DbGllbnRTZWNyZXQnKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBHYXRld2F5IFRva2VuIEV4Y2hhbmdlIFBvbGljeSAobWFuYWdlZCBwb2xpY3ksIHdpbGRjYXJkKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IHRva2VuRXhjaGFuZ2VQb2xpY3kgPSBuZXcgaWFtLk1hbmFnZWRQb2xpY3kodGhpcywgJ0dhdGV3YXlUb2tlbkV4Y2hhbmdlUG9saWN5Jywge1xuICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgc2lkOiAnQWdlbnRDb3JlSWRlbnRpdHlUb2tlbkV4Y2hhbmdlJyxcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldFdvcmtsb2FkQWNjZXNzVG9rZW4nLFxuICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldFJlc291cmNlT2F1dGgyVG9rZW4nLFxuICAgICAgICAgIF0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgfSksXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEdhdGV3YXkgU2VydmljZSBSb2xlXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgZ2F0ZXdheVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0dhdGV3YXlTZXJ2aWNlUm9sZScsIHtcbiAgICAgIGRlc2NyaXB0aW9uOiAnU2VydmljZSByb2xlIGZvciBDbG91ZE9wcyBBZ2VudENvcmUgR2F0ZXdheScsXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnYmVkcm9jay1hZ2VudGNvcmUuYW1hem9uYXdzLmNvbScpLFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbdG9rZW5FeGNoYW5nZVBvbGljeV0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT0F1dGggUHJvdmlkZXIgKExhbWJkYSBjdXN0b20gcmVzb3VyY2UpXG4gICAgLy8gVXNlcyBBdXRoU3RhY2sncyBDb2duaXRvIGZvciBvdXRib3VuZCBhdXRoIHRvIE1DUCBydW50aW1lc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IG9hdXRoUHJvdmlkZXJGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ09BdXRoUHJvdmlkZXJGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzE0LFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMiksXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbmltcG9ydCBqc29uXG5pbXBvcnQgbG9nZ2luZ1xuaW1wb3J0IG9zXG5pbXBvcnQgdXJsbGliLnJlcXVlc3RcbmltcG9ydCBib3RvM1xuXG5sb2dnZXIgPSBsb2dnaW5nLmdldExvZ2dlcigpXG5sb2dnZXIuc2V0TGV2ZWwobG9nZ2luZy5JTkZPKVxuXG5kZWYgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsIHN0YXR1cywgZGF0YT1Ob25lLCByZWFzb249Tm9uZSwgcGh5c2ljYWxfaWQ9Tm9uZSk6XG4gICAgcmVzcG9uc2VfYm9keSA9IGpzb24uZHVtcHMoe1xuICAgICAgICAnU3RhdHVzJzogc3RhdHVzLFxuICAgICAgICAnUmVhc29uJzogcmVhc29uIG9yICdTZWUgQ2xvdWRXYXRjaCBMb2dzJyxcbiAgICAgICAgJ1BoeXNpY2FsUmVzb3VyY2VJZCc6IHBoeXNpY2FsX2lkIG9yIGV2ZW50LmdldCgnUGh5c2ljYWxSZXNvdXJjZUlkJywgZXZlbnRbJ1JlcXVlc3RJZCddKSxcbiAgICAgICAgJ1N0YWNrSWQnOiBldmVudFsnU3RhY2tJZCddLFxuICAgICAgICAnUmVxdWVzdElkJzogZXZlbnRbJ1JlcXVlc3RJZCddLFxuICAgICAgICAnTG9naWNhbFJlc291cmNlSWQnOiBldmVudFsnTG9naWNhbFJlc291cmNlSWQnXSxcbiAgICAgICAgJ0RhdGEnOiBkYXRhIG9yIHt9LFxuICAgIH0pXG4gICAgcmVzcG9uc2VfdXJsID0gZXZlbnRbJ1Jlc3BvbnNlVVJMJ11cbiAgICBpZiBub3QgcmVzcG9uc2VfdXJsLnN0YXJ0c3dpdGgoJ2h0dHBzOi8vJyk6XG4gICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoZidJbnZhbGlkIHJlc3BvbnNlIFVSTCBzY2hlbWUnKVxuICAgIHJlcSA9IHVybGxpYi5yZXF1ZXN0LlJlcXVlc3QoXG4gICAgICAgIHJlc3BvbnNlX3VybCxcbiAgICAgICAgZGF0YT1yZXNwb25zZV9ib2R5LmVuY29kZSgndXRmLTgnKSxcbiAgICAgICAgaGVhZGVycz17J0NvbnRlbnQtVHlwZSc6ICcnfSxcbiAgICAgICAgbWV0aG9kPSdQVVQnLFxuICAgIClcbiAgICB1cmxsaWIucmVxdWVzdC51cmxvcGVuKHJlcSlcblxuZGVmIGhhbmRsZXIoZXZlbnQsIGNvbnRleHQpOlxuICAgIGxvZ2dlci5pbmZvKGYnRXZlbnQ6IHtqc29uLmR1bXBzKGV2ZW50KX0nKVxuICAgIHJlcXVlc3RfdHlwZSA9IGV2ZW50WydSZXF1ZXN0VHlwZSddXG4gICAgcHJvcHMgPSBldmVudFsnUmVzb3VyY2VQcm9wZXJ0aWVzJ11cbiAgICBwcm92aWRlcl9uYW1lID0gcHJvcHMuZ2V0KCdQcm92aWRlck5hbWUnLCAnJylcbiAgICByZWdpb24gPSBwcm9wcy5nZXQoJ1JlZ2lvbicpIG9yIG9zLmVudmlyb24uZ2V0KCdBV1NfUkVHSU9OJylcbiAgICBjbGllbnQgPSBib3RvMy5jbGllbnQoJ2JlZHJvY2stYWdlbnRjb3JlLWNvbnRyb2wnLCByZWdpb25fbmFtZT1yZWdpb24pXG5cbiAgICBpZiByZXF1ZXN0X3R5cGUgPT0gJ0RlbGV0ZSc6XG4gICAgICAgIHRyeTpcbiAgICAgICAgICAgIGNsaWVudC5kZWxldGVfb2F1dGgyX2NyZWRlbnRpYWxfcHJvdmlkZXIobmFtZT1wcm92aWRlcl9uYW1lKVxuICAgICAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdTVUNDRVNTJylcbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbjpcbiAgICAgICAgICAgIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCAnU1VDQ0VTUycpXG4gICAgICAgIHJldHVyblxuXG4gICAgdHJ5OlxuICAgICAgICByZXNwb25zZSA9IGNsaWVudC5jcmVhdGVfb2F1dGgyX2NyZWRlbnRpYWxfcHJvdmlkZXIoXG4gICAgICAgICAgICBuYW1lPXByb3ZpZGVyX25hbWUsXG4gICAgICAgICAgICBjcmVkZW50aWFsUHJvdmlkZXJWZW5kb3I9J0N1c3RvbU9hdXRoMicsXG4gICAgICAgICAgICBvYXV0aDJQcm92aWRlckNvbmZpZ0lucHV0PXtcbiAgICAgICAgICAgICAgICAnY3VzdG9tT2F1dGgyUHJvdmlkZXJDb25maWcnOiB7XG4gICAgICAgICAgICAgICAgICAgICdvYXV0aERpc2NvdmVyeSc6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICdkaXNjb3ZlcnlVcmwnOiBwcm9wcy5nZXQoJ0Rpc2NvdmVyeVVybCcsICcnKSxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgJ2NsaWVudElkJzogcHJvcHMuZ2V0KCdDbGllbnRJZCcsICcnKSxcbiAgICAgICAgICAgICAgICAgICAgJ2NsaWVudFNlY3JldCc6IHByb3BzLmdldCgnQ2xpZW50U2VjcmV0JywgJycpLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICApXG4gICAgICAgIHByb3ZpZGVyX2FybiA9IHJlc3BvbnNlLmdldCgnY3JlZGVudGlhbFByb3ZpZGVyQXJuJywgJycpXG4gICAgICAgIHNlY3JldF9hcm4gPSByZXNwb25zZS5nZXQoJ2NsaWVudFNlY3JldEFybicsIHt9KS5nZXQoJ3NlY3JldEFybicsICcnKVxuICAgICAgICBsb2dnZXIuaW5mbyhmJ0NyZWF0ZWQgcHJvdmlkZXI6IHtwcm92aWRlcl9hcm59JylcbiAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdTVUNDRVNTJywgZGF0YT17XG4gICAgICAgICAgICAnUHJvdmlkZXJBcm4nOiBwcm92aWRlcl9hcm4sXG4gICAgICAgICAgICAnU2VjcmV0QXJuJzogc2VjcmV0X2FybixcbiAgICAgICAgfSwgcGh5c2ljYWxfaWQ9cHJvdmlkZXJfbmFtZSlcbiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGU6XG4gICAgICAgIGxvZ2dlci5lcnJvcihmJ0NyZWF0ZSBmYWlsZWQ6IHtlfScpXG4gICAgICAgIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCAnRkFJTEVEJywgcmVhc29uPXN0cihlKSlcbmApLFxuICAgIH0pO1xuXG4gICAgLy8gV2lsZGNhcmQgcmVzb3VyY2UgaXMgUkVRVUlSRUQgaGVyZSBhbmQgY2Fubm90IGJlIHNjb3BlZCBmdXJ0aGVyOiB0aGVzZSBhcmVcbiAgICAvLyBhY2NvdW50LWxldmVsIGNvbnRyb2wtcGxhbmUgYWN0aW9ucyBvbiB0aGUgQWdlbnRDb3JlIGlkZW50aXR5IHN0b3JlLiBUaGVcbiAgICAvLyBPQXV0aDIgY3JlZGVudGlhbCBwcm92aWRlciBhbmQgdG9rZW4gdmF1bHQgZG8gbm90IGV4aXN0IHlldCAodGhpcyBjdXN0b21cbiAgICAvLyByZXNvdXJjZSBDUkVBVEVTIHRoZW0pLCBzbyB0aGVpciBBUk5zIGFyZSB1bmtub3duIGF0IHBvbGljeS1kZWZpbml0aW9uXG4gICAgLy8gdGltZSwgYW5kIEFnZW50Q29yZSBkb2VzIG5vdCBzdXBwb3J0IHJlc291cmNlLWxldmVsIHNjb3BpbmcgZm9yIHRoZVxuICAgIC8vIENyZWF0ZSovR2V0KiB0b2tlbi12YXVsdCAvIGNyZWRlbnRpYWwtcHJvdmlkZXIgYWN0aW9ucy4gVGhlIGJsYXN0IHJhZGl1c1xuICAgIC8vIGlzIGNvbnRhaW5lZCB0byB0aGUgYmVkcm9jay1hZ2VudGNvcmUgaWRlbnRpdHkgQVBJcyAobm8gZGF0YS1wbGFuZSBvciBJQU1cbiAgICAvLyBhY3Rpb25zKSwgdGhlIGZ1bmN0aW9uIHJ1bnMgb25seSBhcyBhIENsb3VkRm9ybWF0aW9uIGN1c3RvbSByZXNvdXJjZSwgYW5kXG4gICAgLy8gdGhlIHJlbGF0ZWQgU2VjcmV0cyBNYW5hZ2VyIGdyYW50IGJlbG93IElTIHNjb3BlZCB0byB0aGVcbiAgICAvLyBiZWRyb2NrLWFnZW50Y29yZS1pZGVudGl0eSogc2VjcmV0IHByZWZpeC5cbiAgICBvYXV0aFByb3ZpZGVyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIHNpZDogJ0FnZW50Q29yZUlkZW50aXR5UHJvdmlkZXJNYW5hZ2VtZW50JyxcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZU9hdXRoMkNyZWRlbnRpYWxQcm92aWRlcicsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpEZWxldGVPYXV0aDJDcmVkZW50aWFsUHJvdmlkZXInLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0T2F1dGgyQ3JlZGVudGlhbFByb3ZpZGVyJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZVRva2VuVmF1bHQnLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0VG9rZW5WYXVsdCcsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICBvYXV0aFByb3ZpZGVyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkNyZWF0ZVNlY3JldCcsXG4gICAgICAgICdzZWNyZXRzbWFuYWdlcjpEZWxldGVTZWNyZXQnLFxuICAgICAgICAnc2VjcmV0c21hbmFnZXI6UHV0U2VjcmV0VmFsdWUnLFxuICAgICAgICAnc2VjcmV0c21hbmFnZXI6VGFnUmVzb3VyY2UnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czpzZWNyZXRzbWFuYWdlcjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06c2VjcmV0OmJlZHJvY2stYWdlbnRjb3JlLWlkZW50aXR5KmAsXG4gICAgICBdLFxuICAgIH0pKTtcblxuICAgIGNvbnN0IG9hdXRoUHJvdmlkZXIgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdPQXV0aFByb3ZpZGVyJywge1xuICAgICAgc2VydmljZVRva2VuOiBvYXV0aFByb3ZpZGVyRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIFByb3ZpZGVyTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LW9hdXRoLXByb3ZpZGVyYCxcbiAgICAgICAgRGlzY292ZXJ5VXJsOiBgaHR0cHM6Ly9jb2duaXRvLWlkcC4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tLyR7cHJvcHMuYXV0aFVzZXJQb29sSWR9Ly53ZWxsLWtub3duL29wZW5pZC1jb25maWd1cmF0aW9uYCxcbiAgICAgICAgQ2xpZW50SWQ6IHByb3BzLmF1dGhNMm1DbGllbnRJZCxcbiAgICAgICAgQ2xpZW50U2VjcmV0OiBtMm1DbGllbnRTZWNyZXQsXG4gICAgICAgIFJlZ2lvbjogdGhpcy5yZWdpb24sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3Qgb2F1dGhQcm92aWRlckFybiA9IG9hdXRoUHJvdmlkZXIuZ2V0QXR0U3RyaW5nKCdQcm92aWRlckFybicpO1xuICAgIGNvbnN0IG9hdXRoU2VjcmV0QXJuID0gb2F1dGhQcm92aWRlci5nZXRBdHRTdHJpbmcoJ1NlY3JldEFybicpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIERlZmF1bHQgUG9saWN5IG9uIEdhdGV3YXkgUm9sZSAoc2NvcGVkIHRvIE9BdXRoIHByb3ZpZGVyIHJlc291cmNlcylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBnYXRld2F5Um9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRSZXNvdXJjZU9hdXRoMlRva2VuJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldFdvcmtsb2FkQWNjZXNzVG9rZW4nLFxuICAgICAgICAnc2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWUnLFxuICAgICAgICAnc2VjcmV0c21hbmFnZXI6RGVzY3JpYmVTZWNyZXQnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW29hdXRoUHJvdmlkZXJBcm4sIG9hdXRoU2VjcmV0QXJuXSxcbiAgICB9KSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQWdlbnRDb3JlIFBvbGljeSBFbmdpbmUgKExhbWJkYSBjdXN0b20gcmVzb3VyY2UpXG4gICAgLy9cbiAgICAvLyBUaGUgaW5zdGFsbGVkIENESyBhbHBoYSBtb2R1bGUgKEBhd3MtY2RrL2F3cy1iZWRyb2NrLWFnZW50Y29yZS1hbHBoYVxuICAgIC8vIDIuMjM1LngpIGRvZXMgTk9UIHlldCBzaGlwIHRoZSBQb2xpY3kgc3VibW9kdWxlIChQb2xpY3lFbmdpbmUgLyBQb2xpY3kgL1xuICAgIC8vIFBvbGljeVN0YXRlbWVudCkg4oCUIHRob3NlIGNvbnN0cnVjdHMgd2VyZSBhZGRlZCBpbiBhIGxhdGVyIGFscGhhIHJlbGVhc2UuXG4gICAgLy8gVGhlcmUgaXMgYWxzbyBubyBmaXJzdC1jbGFzcyBMMSBmb3IgdGhlIGVuZ2luZS9wb2xpY2llcyAob25seSB0aGVcbiAgICAvLyBnYXRld2F5LXNpZGUgYFBvbGljeUVuZ2luZUNvbmZpZ3VyYXRpb25gIGV4aXN0cykuIFdlIHRoZXJlZm9yZSBjcmVhdGUgdGhlXG4gICAgLy8gZW5naW5lIGFuZCBpdHMgQ2VkYXIgcG9saWNpZXMgdmlhIHRoZSBgYmVkcm9jay1hZ2VudGNvcmUtY29udHJvbGAgY29udHJvbFxuICAgIC8vIHBsYW5lIGJlaGluZCBhIENESyBjdXN0b20gcmVzb3VyY2UsIG1pcnJvcmluZyB0aGUgT0F1dGhQcm92aWRlciBwYXR0ZXJuXG4gICAgLy8gYWJvdmUuXG4gICAgLy9cbiAgICAvLyBGbG93OlxuICAgIC8vICAgMS4gUG9saWN5RW5naW5lIGN1c3RvbSByZXNvdXJjZSAgLT4gY3JlYXRlX3BvbGljeV9lbmdpbmUsIHdhaXQgQUNUSVZFLFxuICAgIC8vICAgICAgcmV0dXJucyB0aGUgZW5naW5lIEFSTi9JRC5cbiAgICAvLyAgIDIuIEdhdGV3YXkgY2FycmllcyBQb2xpY3lFbmdpbmVDb25maWd1cmF0aW9uLkFybiA9IGVuZ2luZSBBUk4gc28gdGhlXG4gICAgLy8gICAgICBlbmdpbmUgaXMgYXNzb2NpYXRlZCB3aXRoIHRoZSBnYXRld2F5IChNb2RlID0gRU5GT1JDRSkuXG4gICAgLy8gICAzLiBQb2xpY3lFbmdpbmVQb2xpY2llcyBjdXN0b20gcmVzb3VyY2UgLT4gY3JlYXRlX3BvbGljeSBmb3IgZWFjaCBDZWRhclxuICAgIC8vICAgICAgc3RhdGVtZW50LiBJdCBkZXBlbmRzIG9uIHRoZSBnYXRld2F5ICsgYWxsIHRhcmdldHMgc28gdGhlIENlZGFyXG4gICAgLy8gICAgICBzY2hlbWEgKGdlbmVyYXRlZCBmcm9tIHRoZSB0YXJnZXRzJyB0b29sIGlucHV0IHNjaGVtYXMpIGV4aXN0cyB3aGVuXG4gICAgLy8gICAgICB0aGUgcG9saWNpZXMgYXJlIHZhbGlkYXRlZC5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBjb25zdCBwb2xpY3lFbmdpbmVGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1BvbGljeUVuZ2luZUZ1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTQsXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygxMCksXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbmltcG9ydCBqc29uXG5pbXBvcnQgbG9nZ2luZ1xuaW1wb3J0IG9zXG5pbXBvcnQgcmVcbmltcG9ydCB0aW1lXG5pbXBvcnQgdXJsbGliLnJlcXVlc3RcbmltcG9ydCBib3RvM1xuZnJvbSBib3RvY29yZS5leGNlcHRpb25zIGltcG9ydCBDbGllbnRFcnJvclxuXG5sb2dnZXIgPSBsb2dnaW5nLmdldExvZ2dlcigpXG5sb2dnZXIuc2V0TGV2ZWwobG9nZ2luZy5JTkZPKVxuXG5cbmRlZiBfY2xpZW50X3Rva2VuKHZhbHVlKTpcbiAgICAjIGNsaWVudFRva2VuIG11c3QgbWF0Y2ggXlthLXpBLVowLTldKC0qW2EtekEtWjAtOV0pezAsMjU2fSQg4oCUIG5vXG4gICAgIyB1bmRlcnNjb3Jlcy4gUmVkdWNlIHRvIGFscGhhbnVtZXJpY3Mgb25seSAoYWx3YXlzIHZhbGlkKSBhbmQgY2FwIGxlbmd0aC5cbiAgICB0b2tlbiA9IHJlLnN1YihyJ1teYS16QS1aMC05XScsICcnLCB2YWx1ZSlcbiAgICByZXR1cm4gdG9rZW5bOjI1Nl0gb3IgJ3Rva2VuJ1xuXG5cbmRlZiBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgc3RhdHVzLCBkYXRhPU5vbmUsIHJlYXNvbj1Ob25lLCBwaHlzaWNhbF9pZD1Ob25lKTpcbiAgICByZXNwb25zZV9ib2R5ID0ganNvbi5kdW1wcyh7XG4gICAgICAgICdTdGF0dXMnOiBzdGF0dXMsXG4gICAgICAgICdSZWFzb24nOiByZWFzb24gb3IgJ1NlZSBDbG91ZFdhdGNoIExvZ3MnLFxuICAgICAgICAnUGh5c2ljYWxSZXNvdXJjZUlkJzogcGh5c2ljYWxfaWQgb3IgZXZlbnQuZ2V0KCdQaHlzaWNhbFJlc291cmNlSWQnLCBldmVudFsnUmVxdWVzdElkJ10pLFxuICAgICAgICAnU3RhY2tJZCc6IGV2ZW50WydTdGFja0lkJ10sXG4gICAgICAgICdSZXF1ZXN0SWQnOiBldmVudFsnUmVxdWVzdElkJ10sXG4gICAgICAgICdMb2dpY2FsUmVzb3VyY2VJZCc6IGV2ZW50WydMb2dpY2FsUmVzb3VyY2VJZCddLFxuICAgICAgICAnRGF0YSc6IGRhdGEgb3Ige30sXG4gICAgfSlcbiAgICByZXNwb25zZV91cmwgPSBldmVudFsnUmVzcG9uc2VVUkwnXVxuICAgIGlmIG5vdCByZXNwb25zZV91cmwuc3RhcnRzd2l0aCgnaHR0cHM6Ly8nKTpcbiAgICAgICAgcmFpc2UgVmFsdWVFcnJvcignSW52YWxpZCByZXNwb25zZSBVUkwgc2NoZW1lJylcbiAgICByZXEgPSB1cmxsaWIucmVxdWVzdC5SZXF1ZXN0KFxuICAgICAgICByZXNwb25zZV91cmwsXG4gICAgICAgIGRhdGE9cmVzcG9uc2VfYm9keS5lbmNvZGUoJ3V0Zi04JyksXG4gICAgICAgIGhlYWRlcnM9eydDb250ZW50LVR5cGUnOiAnJ30sXG4gICAgICAgIG1ldGhvZD0nUFVUJyxcbiAgICApXG4gICAgdXJsbGliLnJlcXVlc3QudXJsb3BlbihyZXEpXG5cblxuZGVmIF9pc19jb25mbGljdChlcnIpOlxuICAgIGNvZGUgPSBlcnIucmVzcG9uc2UuZ2V0KCdFcnJvcicsIHt9KS5nZXQoJ0NvZGUnLCAnJykgaWYgaXNpbnN0YW5jZShlcnIsIENsaWVudEVycm9yKSBlbHNlICcnXG4gICAgcmV0dXJuICdDb25mbGljdCcgaW4gY29kZSBvciAnQWxyZWFkeUV4aXN0cycgaW4gY29kZVxuXG5cbmRlZiBfZmluZF9lbmdpbmVfYnlfbmFtZShjbGllbnQsIG5hbWUpOlxuICAgIHRyeTpcbiAgICAgICAgdG9rZW4gPSBOb25lXG4gICAgICAgIHdoaWxlIFRydWU6XG4gICAgICAgICAgICBrd2FyZ3MgPSB7J25leHRUb2tlbic6IHRva2VufSBpZiB0b2tlbiBlbHNlIHt9XG4gICAgICAgICAgICByZXNwID0gY2xpZW50Lmxpc3RfcG9saWN5X2VuZ2luZXMoKiprd2FyZ3MpXG4gICAgICAgICAgICBmb3IgaXRlbSBpbiByZXNwLmdldCgncG9saWN5RW5naW5lcycsIFtdKSBvciByZXNwLmdldCgnaXRlbXMnLCBbXSk6XG4gICAgICAgICAgICAgICAgaWYgaXRlbS5nZXQoJ25hbWUnKSA9PSBuYW1lOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gaXRlbVxuICAgICAgICAgICAgdG9rZW4gPSByZXNwLmdldCgnbmV4dFRva2VuJylcbiAgICAgICAgICAgIGlmIG5vdCB0b2tlbjpcbiAgICAgICAgICAgICAgICBicmVha1xuICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXg6XG4gICAgICAgIGxvZ2dlci53YXJuaW5nKGYnbGlzdF9wb2xpY3lfZW5naW5lcyBmYWlsZWQ6IHtleH0nKVxuICAgIHJldHVybiBOb25lXG5cblxuZGVmIF9lbmdpbmVfaWQoaXRlbSk6XG4gICAgcmV0dXJuIGl0ZW0uZ2V0KCdwb2xpY3lFbmdpbmVJZCcpIG9yIGl0ZW0uZ2V0KCdpZCcpXG5cblxuZGVmIF93YWl0X2VuZ2luZV9hY3RpdmUoY2xpZW50LCBlbmdpbmVfaWQsIHRpbWVvdXRfcz00ODApOlxuICAgIGRlYWRsaW5lID0gdGltZS50aW1lKCkgKyB0aW1lb3V0X3NcbiAgICB3aGlsZSB0aW1lLnRpbWUoKSA8IGRlYWRsaW5lOlxuICAgICAgICByZXNwID0gY2xpZW50LmdldF9wb2xpY3lfZW5naW5lKHBvbGljeUVuZ2luZUlkPWVuZ2luZV9pZClcbiAgICAgICAgc3RhdHVzID0gcmVzcC5nZXQoJ3N0YXR1cycpXG4gICAgICAgIGxvZ2dlci5pbmZvKGYnZW5naW5lIHtlbmdpbmVfaWR9IHN0YXR1cz17c3RhdHVzfScpXG4gICAgICAgIGlmIHN0YXR1cyA9PSAnQUNUSVZFJzpcbiAgICAgICAgICAgIHJldHVybiByZXNwXG4gICAgICAgIGlmIHN0YXR1cyBhbmQgc3RhdHVzLmVuZHN3aXRoKCdGQUlMRUQnKTpcbiAgICAgICAgICAgIHJhaXNlIFJ1bnRpbWVFcnJvcihmJ2VuZ2luZSB7ZW5naW5lX2lkfSB7c3RhdHVzfToge3Jlc3AuZ2V0KFwic3RhdHVzUmVhc29uc1wiKX0nKVxuICAgICAgICB0aW1lLnNsZWVwKDUpXG4gICAgcmFpc2UgVGltZW91dEVycm9yKGYnZW5naW5lIHtlbmdpbmVfaWR9IG5vdCBBQ1RJVkUgd2l0aGluIHt0aW1lb3V0X3N9cycpXG5cblxuZGVmIF9saXN0X3BvbGljeV9pZHMoY2xpZW50LCBlbmdpbmVfaWQpOlxuICAgIGlkcyA9IFtdXG4gICAgdG9rZW4gPSBOb25lXG4gICAgd2hpbGUgVHJ1ZTpcbiAgICAgICAga3dhcmdzID0geydwb2xpY3lFbmdpbmVJZCc6IGVuZ2luZV9pZH1cbiAgICAgICAgaWYgdG9rZW46XG4gICAgICAgICAgICBrd2FyZ3NbJ25leHRUb2tlbiddID0gdG9rZW5cbiAgICAgICAgcmVzcCA9IGNsaWVudC5saXN0X3BvbGljaWVzKCoqa3dhcmdzKVxuICAgICAgICBmb3IgaXRlbSBpbiByZXNwLmdldCgncG9saWNpZXMnLCBbXSkgb3IgcmVzcC5nZXQoJ2l0ZW1zJywgW10pOlxuICAgICAgICAgICAgcGlkID0gaXRlbS5nZXQoJ3BvbGljeUlkJykgb3IgaXRlbS5nZXQoJ2lkJylcbiAgICAgICAgICAgIGlmIHBpZDpcbiAgICAgICAgICAgICAgICBpZHMuYXBwZW5kKHBpZClcbiAgICAgICAgdG9rZW4gPSByZXNwLmdldCgnbmV4dFRva2VuJylcbiAgICAgICAgaWYgbm90IHRva2VuOlxuICAgICAgICAgICAgYnJlYWtcbiAgICByZXR1cm4gaWRzXG5cblxuZGVmIF9kZWxldGVfcG9saWNpZXMoY2xpZW50LCBlbmdpbmVfaWQsIHRpbWVvdXRfcz0xMjApOlxuICAgICMgZGVsZXRlX3BvbGljeSBpcyBhc3luY2hyb25vdXMsIHNvIGlzc3VlIGRlbGV0ZXMgZm9yIGV2ZXJ5IGV4aXN0aW5nIHBvbGljeVxuICAgICMgYW5kIHRoZW4gV0FJVCB1bnRpbCB0aGV5IGFyZSBhbGwgYWN0dWFsbHkgZ29uZS4gUmVjcmVhdGluZyBhIHBvbGljeSB3aXRoXG4gICAgIyB0aGUgc2FtZSBuYW1lIHdoaWxlIGEgcHJpb3Igb25lIGlzIHN0aWxsIERFTEVUSU5HIHJhaXNlcyBhIGNvbmZsaWN0LlxuICAgIHRyeTpcbiAgICAgICAgZm9yIHBpZCBpbiBfbGlzdF9wb2xpY3lfaWRzKGNsaWVudCwgZW5naW5lX2lkKTpcbiAgICAgICAgICAgIHRyeTpcbiAgICAgICAgICAgICAgICBjbGllbnQuZGVsZXRlX3BvbGljeShwb2xpY3lFbmdpbmVJZD1lbmdpbmVfaWQsIHBvbGljeUlkPXBpZClcbiAgICAgICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXg6XG4gICAgICAgICAgICAgICAgbG9nZ2VyLndhcm5pbmcoZidkZWxldGVfcG9saWN5IHtwaWR9IGZhaWxlZDoge2V4fScpXG4gICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleDpcbiAgICAgICAgbG9nZ2VyLndhcm5pbmcoZidsaXN0X3BvbGljaWVzIGZhaWxlZCBkdXJpbmcgZGVsZXRlOiB7ZXh9JylcbiAgICAgICAgcmV0dXJuXG5cbiAgICBkZWFkbGluZSA9IHRpbWUudGltZSgpICsgdGltZW91dF9zXG4gICAgd2hpbGUgdGltZS50aW1lKCkgPCBkZWFkbGluZTpcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgcmVtYWluaW5nID0gX2xpc3RfcG9saWN5X2lkcyhjbGllbnQsIGVuZ2luZV9pZClcbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleDpcbiAgICAgICAgICAgIGxvZ2dlci53YXJuaW5nKGYnbGlzdF9wb2xpY2llcyBmYWlsZWQgd2hpbGUgd2FpdGluZyBmb3IgZGVsZXRlOiB7ZXh9JylcbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICBpZiBub3QgcmVtYWluaW5nOlxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgIGxvZ2dlci5pbmZvKGYnd2FpdGluZyBmb3Ige2xlbihyZW1haW5pbmcpfSBwb2xpY2llcyB0byBmaW5pc2ggZGVsZXRpbmcnKVxuICAgICAgICB0aW1lLnNsZWVwKDQpXG4gICAgbG9nZ2VyLndhcm5pbmcoJ3RpbWVkIG91dCB3YWl0aW5nIGZvciBwb2xpY3kgZGVsZXRpb25zIHRvIGNvbXBsZXRlJylcblxuXG5kZWYgaGFuZGxlX2VuZ2luZShldmVudCwgY2xpZW50KTpcbiAgICBwcm9wcyA9IGV2ZW50WydSZXNvdXJjZVByb3BlcnRpZXMnXVxuICAgIG5hbWUgPSBwcm9wc1snRW5naW5lTmFtZSddXG4gICAgcmVxdWVzdF90eXBlID0gZXZlbnRbJ1JlcXVlc3RUeXBlJ11cblxuICAgIGlmIHJlcXVlc3RfdHlwZSA9PSAnRGVsZXRlJzpcbiAgICAgICAgZXhpc3RpbmcgPSBfZmluZF9lbmdpbmVfYnlfbmFtZShjbGllbnQsIG5hbWUpXG4gICAgICAgIGlmIGV4aXN0aW5nOlxuICAgICAgICAgICAgZWlkID0gX2VuZ2luZV9pZChleGlzdGluZylcbiAgICAgICAgICAgIF9kZWxldGVfcG9saWNpZXMoY2xpZW50LCBlaWQpXG4gICAgICAgICAgICB0cnk6XG4gICAgICAgICAgICAgICAgY2xpZW50LmRlbGV0ZV9wb2xpY3lfZW5naW5lKHBvbGljeUVuZ2luZUlkPWVpZClcbiAgICAgICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXg6XG4gICAgICAgICAgICAgICAgbG9nZ2VyLndhcm5pbmcoZidkZWxldGVfcG9saWN5X2VuZ2luZSBmYWlsZWQ6IHtleH0nKVxuICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnKVxuICAgICAgICByZXR1cm5cblxuICAgICMgQ3JlYXRlIC8gVXBkYXRlIChlbmdpbmUgbmFtZSBpcyBpbW11dGFibGUgLT4gcmV1c2UgaWYgaXQgYWxyZWFkeSBleGlzdHMpXG4gICAgIyBUaGUgY2xpZW50VG9rZW4gaXMgbWFkZSB1bmlxdWUgcGVyIENsb3VkRm9ybWF0aW9uIHJlcXVlc3QgKFJlcXVlc3RJZCkgc28gYVxuICAgICMgbGF0ZXIgc3RhY2sgcmVjcmVhdGlvbiBkb2VzIG5vdCBjb2xsaWRlIHdpdGggdGhlIGlkZW1wb3RlbmN5IHJlY29yZCBvZiBhXG4gICAgIyBwcmlvciAobm93LWRlbGV0ZWQpIGVuZ2luZSwgd2hpbGUgc3RpbGwgYmVpbmcgc3RhYmxlIGFjcm9zcyB0aGUgU0RLJ3Mgb3duXG4gICAgIyByZXRyaWVzIHdpdGhpbiBhIHNpbmdsZSBjcmVhdGUgY2FsbC5cbiAgICBlbmdpbmVfaWQgPSBOb25lXG4gICAgdHJ5OlxuICAgICAgICByZXNwID0gY2xpZW50LmNyZWF0ZV9wb2xpY3lfZW5naW5lKFxuICAgICAgICAgICAgbmFtZT1uYW1lLFxuICAgICAgICAgICAgZGVzY3JpcHRpb249cHJvcHMuZ2V0KCdEZXNjcmlwdGlvbicsICdDbG91ZE9wcyByb2xlLWJhc2VkIHRvb2wgYXV0aG9yaXphdGlvbiBlbmdpbmUnKSxcbiAgICAgICAgICAgIGNsaWVudFRva2VuPV9jbGllbnRfdG9rZW4obmFtZSArIGV2ZW50LmdldCgnUmVxdWVzdElkJywgJycpKSxcbiAgICAgICAgKVxuICAgICAgICBlbmdpbmVfaWQgPSByZXNwWydwb2xpY3lFbmdpbmVJZCddXG4gICAgZXhjZXB0IENsaWVudEVycm9yIGFzIGVycjpcbiAgICAgICAgaWYgX2lzX2NvbmZsaWN0KGVycik6XG4gICAgICAgICAgICBleGlzdGluZyA9IF9maW5kX2VuZ2luZV9ieV9uYW1lKGNsaWVudCwgbmFtZSlcbiAgICAgICAgICAgIGlmIG5vdCBleGlzdGluZzpcbiAgICAgICAgICAgICAgICByYWlzZVxuICAgICAgICAgICAgZW5naW5lX2lkID0gX2VuZ2luZV9pZChleGlzdGluZylcbiAgICAgICAgZWxzZTpcbiAgICAgICAgICAgIHJhaXNlXG5cbiAgICBfd2FpdF9lbmdpbmVfYWN0aXZlKGNsaWVudCwgZW5naW5lX2lkKVxuICAgIGVuZ2luZSA9IGNsaWVudC5nZXRfcG9saWN5X2VuZ2luZShwb2xpY3lFbmdpbmVJZD1lbmdpbmVfaWQpXG4gICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdTVUNDRVNTJywgZGF0YT17XG4gICAgICAgICdQb2xpY3lFbmdpbmVJZCc6IGVuZ2luZV9pZCxcbiAgICAgICAgJ1BvbGljeUVuZ2luZUFybic6IGVuZ2luZS5nZXQoJ3BvbGljeUVuZ2luZUFybicsICcnKSxcbiAgICB9LCBwaHlzaWNhbF9pZD1lbmdpbmVfaWQpXG5cblxuZGVmIF93YWl0X3BvbGljeV9hY3RpdmUoY2xpZW50LCBlbmdpbmVfaWQsIHBvbGljeV9pZCwgdGltZW91dF9zPTE4MCk6XG4gICAgIyBQb2xpY3kgY3JlYXRpb24gaXMgYXN5bmNocm9ub3VzOiBjcmVhdGVfcG9saWN5IHJldHVybnMgQ1JFQVRJTkcgYW5kIHRoZVxuICAgICMgQ2VkYXIgYW5hbHl6ZXIgdmFsaWRhdGVzIHRoZSBzdGF0ZW1lbnQgYWdhaW5zdCB0aGUgZ2F0ZXdheSdzIGdlbmVyYXRlZFxuICAgICMgc2NoZW1hIGFmdGVyd2FyZHMuIFBvbGwgdW50aWwgQUNUSVZFLCBhbmQgcmFpc2UgKGZhaWxpbmcgdGhlIGN1c3RvbVxuICAgICMgcmVzb3VyY2UpIG9uIENSRUFURV9GQUlMRUQgc28gYSBiYWQgcG9saWN5IGNhbiBuZXZlciBiZSBzaWxlbnRseSBhY2NlcHRlZC5cbiAgICBkZWFkbGluZSA9IHRpbWUudGltZSgpICsgdGltZW91dF9zXG4gICAgd2hpbGUgdGltZS50aW1lKCkgPCBkZWFkbGluZTpcbiAgICAgICAgcmVzcCA9IGNsaWVudC5nZXRfcG9saWN5KHBvbGljeUVuZ2luZUlkPWVuZ2luZV9pZCwgcG9saWN5SWQ9cG9saWN5X2lkKVxuICAgICAgICBzdGF0dXMgPSByZXNwLmdldCgnc3RhdHVzJylcbiAgICAgICAgbG9nZ2VyLmluZm8oZidwb2xpY3kge3BvbGljeV9pZH0gc3RhdHVzPXtzdGF0dXN9JylcbiAgICAgICAgaWYgc3RhdHVzID09ICdBQ1RJVkUnOlxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgIGlmIHN0YXR1cyBhbmQgJ0ZBSUxFRCcgaW4gc3RhdHVzOlxuICAgICAgICAgICAgcmFpc2UgUnVudGltZUVycm9yKFxuICAgICAgICAgICAgICAgIGYncG9saWN5IHtwb2xpY3lfaWR9IHtzdGF0dXN9OiB7cmVzcC5nZXQoXCJzdGF0dXNSZWFzb25zXCIpfSdcbiAgICAgICAgICAgIClcbiAgICAgICAgdGltZS5zbGVlcCg0KVxuICAgIHJhaXNlIFRpbWVvdXRFcnJvcihmJ3BvbGljeSB7cG9saWN5X2lkfSBub3QgQUNUSVZFIHdpdGhpbiB7dGltZW91dF9zfXMnKVxuXG5cbmRlZiBoYW5kbGVfcG9saWNpZXMoZXZlbnQsIGNsaWVudCk6XG4gICAgcHJvcHMgPSBldmVudFsnUmVzb3VyY2VQcm9wZXJ0aWVzJ11cbiAgICBlbmdpbmVfaWQgPSBwcm9wc1snUG9saWN5RW5naW5lSWQnXVxuICAgIHN0YXRlbWVudHMgPSBwcm9wcy5nZXQoJ1N0YXRlbWVudHMnLCBbXSlcbiAgICB2YWxpZGF0aW9uX21vZGUgPSBwcm9wcy5nZXQoJ1ZhbGlkYXRpb25Nb2RlJywgJ0ZBSUxfT05fQU5ZX0ZJTkRJTkdTJylcbiAgICByZXF1ZXN0X3R5cGUgPSBldmVudFsnUmVxdWVzdFR5cGUnXVxuXG4gICAgaWYgcmVxdWVzdF90eXBlID09ICdEZWxldGUnOlxuICAgICAgICBfZGVsZXRlX3BvbGljaWVzKGNsaWVudCwgZW5naW5lX2lkKVxuICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnKVxuICAgICAgICByZXR1cm5cblxuICAgICMgUmVjb25jaWxlOiByZW1vdmUgYW55IGV4aXN0aW5nIHBvbGljaWVzIGZpcnN0IHNvIENyZWF0ZSBBTkQgVXBkYXRlIGJvdGhcbiAgICAjIGNvbnZlcmdlIHRvIGV4YWN0bHkgdGhlIGRlc2lyZWQgc3RhdGVtZW50IHNldCAoYW5kIGNsZWFuIHVwIGFueSBwcmlvclxuICAgICMgZmFpbGVkL3Byb2JlIHBvbGljaWVzKSB3aXRob3V0IG5hbWUtY29uZmxpY3QgZXJyb3JzLlxuICAgIF9kZWxldGVfcG9saWNpZXMoY2xpZW50LCBlbmdpbmVfaWQpXG5cbiAgICBjcmVhdGVkID0gW11cbiAgICBmb3Igc3RtdCBpbiBzdGF0ZW1lbnRzOlxuICAgICAgICBwbmFtZSA9IHN0bXRbJ05hbWUnXVxuICAgICAgICByZXNwID0gY2xpZW50LmNyZWF0ZV9wb2xpY3koXG4gICAgICAgICAgICBwb2xpY3lFbmdpbmVJZD1lbmdpbmVfaWQsXG4gICAgICAgICAgICBuYW1lPXBuYW1lLFxuICAgICAgICAgICAgZGVzY3JpcHRpb249c3RtdC5nZXQoJ0Rlc2NyaXB0aW9uJywgJycpLFxuICAgICAgICAgICAgdmFsaWRhdGlvbk1vZGU9dmFsaWRhdGlvbl9tb2RlLFxuICAgICAgICAgICAgIyBlbmZvcmNlbWVudE1vZGUgaXMgb21pdHRlZDogaXQgaXMgbm90IHByZXNlbnQgaW4gdGhlIExhbWJkYVxuICAgICAgICAgICAgIyBydW50aW1lJ3MgYnVuZGxlZCBib3RvMyBtb2RlbCBmb3IgY3JlYXRlX3BvbGljeSBhbmQgZGVmYXVsdHNcbiAgICAgICAgICAgICMgdG8gQUNUSVZFIHNlcnZpY2Utc2lkZSAod2hpY2ggaXMgdGhlIGVuZm9yY2luZyBiZWhhdmlvciB3ZVxuICAgICAgICAgICAgIyB3YW50OyB0aGUgZ2F0ZXdheSBQb2xpY3lFbmdpbmVDb25maWd1cmF0aW9uIGlzIGFsc28gRU5GT1JDRSkuXG4gICAgICAgICAgICBkZWZpbml0aW9uPXsnY2VkYXInOiB7J3N0YXRlbWVudCc6IHN0bXRbJ1N0YXRlbWVudCddfX0sXG4gICAgICAgICAgICBjbGllbnRUb2tlbj1fY2xpZW50X3Rva2VuKGZcIntlbmdpbmVfaWR9e3BuYW1lfXtldmVudC5nZXQoJ1JlcXVlc3RJZCcsICcnKX1cIiksXG4gICAgICAgIClcbiAgICAgICAgcG9saWN5X2lkID0gcmVzcC5nZXQoJ3BvbGljeUlkJywgcG5hbWUpXG4gICAgICAgICMgQmxvY2sgdW50aWwgdGhlIHBvbGljeSB2YWxpZGF0ZXMgQUNUSVZFOyByYWlzZXMgb24gQ1JFQVRFX0ZBSUxFRC5cbiAgICAgICAgX3dhaXRfcG9saWN5X2FjdGl2ZShjbGllbnQsIGVuZ2luZV9pZCwgcG9saWN5X2lkKVxuICAgICAgICBjcmVhdGVkLmFwcGVuZChwb2xpY3lfaWQpXG5cbiAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnLCBkYXRhPXtcbiAgICAgICAgJ1BvbGljeUlkcyc6ICcsJy5qb2luKGNyZWF0ZWQpLFxuICAgIH0sIHBoeXNpY2FsX2lkPWYne2VuZ2luZV9pZH0tcG9saWNpZXMnKVxuXG5cbmRlZiBoYW5kbGVyKGV2ZW50LCBjb250ZXh0KTpcbiAgICBsb2dnZXIuaW5mbyhmJ0V2ZW50OiB7anNvbi5kdW1wcyhldmVudCl9JylcbiAgICBwcm9wcyA9IGV2ZW50WydSZXNvdXJjZVByb3BlcnRpZXMnXVxuICAgIG9wZXJhdGlvbiA9IHByb3BzLmdldCgnT3BlcmF0aW9uJywgJ0VOR0lORScpXG4gICAgcmVnaW9uID0gcHJvcHMuZ2V0KCdSZWdpb24nKSBvciBvcy5lbnZpcm9uLmdldCgnQVdTX1JFR0lPTicpXG4gICAgY2xpZW50ID0gYm90bzMuY2xpZW50KCdiZWRyb2NrLWFnZW50Y29yZS1jb250cm9sJywgcmVnaW9uX25hbWU9cmVnaW9uKVxuICAgIHRyeTpcbiAgICAgICAgaWYgb3BlcmF0aW9uID09ICdFTkdJTkUnOlxuICAgICAgICAgICAgaGFuZGxlX2VuZ2luZShldmVudCwgY2xpZW50KVxuICAgICAgICBlbGlmIG9wZXJhdGlvbiA9PSAnUE9MSUNJRVMnOlxuICAgICAgICAgICAgaGFuZGxlX3BvbGljaWVzKGV2ZW50LCBjbGllbnQpXG4gICAgICAgIGVsc2U6XG4gICAgICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ0ZBSUxFRCcsIHJlYXNvbj1mJ1Vua25vd24gb3BlcmF0aW9uIHtvcGVyYXRpb259JylcbiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGU6XG4gICAgICAgIGxvZ2dlci5lcnJvcihmJ3tvcGVyYXRpb259IGZhaWxlZDoge2V9JylcbiAgICAgICAgIyBPbiBEZWxldGUgd2UgbmV2ZXIgd2FudCB0byBibG9jayBzdGFjayB0ZWFyZG93bi5cbiAgICAgICAgaWYgZXZlbnRbJ1JlcXVlc3RUeXBlJ10gPT0gJ0RlbGV0ZSc6XG4gICAgICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnKVxuICAgICAgICBlbHNlOlxuICAgICAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdGQUlMRUQnLCByZWFzb249c3RyKGUpKVxuYCksXG4gICAgfSk7XG5cbiAgICAvLyBXaWxkY2FyZCByZXNvdXJjZSBpcyBSRVFVSVJFRCBhbmQgY2Fubm90IGJlIHNjb3BlZCBhdCBwb2xpY3ktZGVmaW5pdGlvblxuICAgIC8vIHRpbWU6IHRoaXMgY3VzdG9tIHJlc291cmNlIENSRUFURVMgdGhlIHBvbGljeSBlbmdpbmUgYW5kIGl0cyBwb2xpY2llcywgc29cbiAgICAvLyB0aGVpciBBUk5zIGRvIG5vdCBleGlzdCB5ZXQsIGFuZCB0aGUgTGlzdCogYWN0aW9ucyBhcmUgYWNjb3VudC1sZXZlbCBieVxuICAgIC8vIGRlZmluaXRpb24gKHRoZXkgZW51bWVyYXRlIGFsbCBlbmdpbmVzL3BvbGljaWVzIGFuZCBhY2NlcHQgbm8gcmVzb3VyY2VcbiAgICAvLyBjb25zdHJhaW50KS4gVGhlIGdhdGV3YXktdGFyZ2V0aW5nIGFjdGlvbnMgKEludm9rZUdhdGV3YXkvR2V0R2F0ZXdheS9cbiAgICAvLyBMaXN0L0dldEdhdGV3YXlUYXJnZXQpIGFyZSB1c2VkIGF0IGNyZWF0ZSB0aW1lIHRvIHZhbGlkYXRlIGVhY2ggQ2VkYXJcbiAgICAvLyBwb2xpY3kgYWdhaW5zdCB0aGUgbGl2ZSBnYXRld2F5IHRvb2wgc2NoZW1hLiBUaGUgYmxhc3QgcmFkaXVzIGlzIGxpbWl0ZWRcbiAgICAvLyB0byB0aGUgYmVkcm9jay1hZ2VudGNvcmUgUG9saWN5L0dhdGV3YXkgY29udHJvbCBwbGFuZSwgYW5kIHRoZSBmdW5jdGlvblxuICAgIC8vIHJ1bnMgb25seSBhcyBhIENsb3VkRm9ybWF0aW9uIGN1c3RvbSByZXNvdXJjZSBkdXJpbmcgc3RhY2sgZGVwbG95L2RlbGV0ZS5cbiAgICAvLyAoVGhlIGdhdGV3YXkgKnNlcnZpY2UqIHJvbGUncyBBdXRob3JpemVBY3Rpb24gZ3JhbnQgSVMgc2NvcGVkIHRvIHRoZVxuICAgIC8vIHNwZWNpZmljIHBvbGljeS1lbmdpbmUgYW5kIGdhdGV3YXkgQVJOcyDigJQgc2VlIFBvbGljeUVuZ2luZUF1dGhvcml6YXRpb24uKVxuICAgIHBvbGljeUVuZ2luZUZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBzaWQ6ICdBZ2VudENvcmVQb2xpY3lFbmdpbmVNYW5hZ2VtZW50JyxcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZVBvbGljeUVuZ2luZScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpEZWxldGVQb2xpY3lFbmdpbmUnLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0UG9saWN5RW5naW5lJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RQb2xpY3lFbmdpbmVzJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZVBvbGljeScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpEZWxldGVQb2xpY3knLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0UG9saWN5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RQb2xpY2llcycsXG4gICAgICAgIC8vIENyZWF0ZVBvbGljeSBiaW5kcy92YWxpZGF0ZXMgZWFjaCBDZWRhciBwb2xpY3kgYWdhaW5zdCB0aGUgdGFyZ2V0XG4gICAgICAgIC8vIEdhdGV3YXkncyB0b29scywgd2hpY2ggcmVxdWlyZXMgcmVhZGluZyB0aGUgZ2F0ZXdheSBhbmQgaXRzIHRhcmdldHMsXG4gICAgICAgIC8vIG1hbmFnaW5nIHRoZSBnYXRld2F5J3MgcmVzb3VyY2Utc2NvcGVkIHBvbGljeSwgYW5kIGludm9raW5nIHRoZVxuICAgICAgICAvLyBnYXRld2F5IHRvIHZhbGlkYXRlIHRoZSBhY3Rpb25zIHJlZmVyZW5jZWQgYnkgdGhlIHBvbGljeS5cbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOk1hbmFnZVJlc291cmNlU2NvcGVkUG9saWN5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkludm9rZUdhdGV3YXknLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0R2F0ZXdheScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpMaXN0R2F0ZXdheVRhcmdldHMnLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0R2F0ZXdheVRhcmdldCcsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICAvLyBBZ2VudENvcmUgUG9saWN5IHJlc291cmNlIG5hbWVzIChlbmdpbmUgKyBwb2xpY2llcykgbXVzdCBtYXRjaFxuICAgIC8vIF5bQS1aYS16XVtBLVphLXowLTlfXSokIOKAlCBsZXR0ZXJzL2RpZ2l0cy91bmRlcnNjb3JlcyBvbmx5LCBzdGFydGluZyB3aXRoXG4gICAgLy8gYSBsZXR0ZXIuIFNhbml0aXplIHRoZSBzdGFjayBuYW1lICh3aGljaCBtYXkgY29udGFpbiBoeXBoZW5zKSB0byBhIHZhbGlkXG4gICAgLy8gcHJlZml4IHNvIHRoZSBDcmVhdGVQb2xpY3lFbmdpbmUvQ3JlYXRlUG9saWN5IGNhbGxzIHZhbGlkYXRlLlxuICAgIGNvbnN0IHBvbGljeU5hbWVQcmVmaXggPSBgJHt0aGlzLnN0YWNrTmFtZX1gLnJlcGxhY2UoL1teQS1aYS16MC05X10vZywgJ18nKTtcblxuICAgIGNvbnN0IHBvbGljeUVuZ2luZSA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ1BvbGljeUVuZ2luZScsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogcG9saWN5RW5naW5lRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIE9wZXJhdGlvbjogJ0VOR0lORScsXG4gICAgICAgIEVuZ2luZU5hbWU6IGAke3BvbGljeU5hbWVQcmVmaXh9X3BvbGljeV9lbmdpbmVgLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0Nsb3VkT3BzIHJvbGUtYmFzZWQgdG9vbCBhdXRob3JpemF0aW9uIChDZWRhcikgZm9yIHRoZSBnYXRld2F5JyxcbiAgICAgICAgUmVnaW9uOiB0aGlzLnJlZ2lvbixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBwb2xpY3lFbmdpbmVBcm4gPSBwb2xpY3lFbmdpbmUuZ2V0QXR0U3RyaW5nKCdQb2xpY3lFbmdpbmVBcm4nKTtcbiAgICBjb25zdCBwb2xpY3lFbmdpbmVJZCA9IHBvbGljeUVuZ2luZS5nZXRBdHRTdHJpbmcoJ1BvbGljeUVuZ2luZUlkJyk7XG5cbiAgICAvLyBHYXRld2F5IEV4ZWN1dGlvbiBSb2xlIHBlcm1pc3Npb25zIGZvciBQb2xpY3kgaW4gQWdlbnRDb3JlLiBQZXIgdGhlXG4gICAgLy8gQWdlbnRDb3JlIFwiR2F0ZXdheSBhbmQgUG9saWN5IElBTSBQZXJtaXNzaW9uc1wiIGd1aWRlLCB0aGUgZXhlY3V0aW9uIHJvbGVcbiAgICAvLyByZXF1aXJlcyBleGFjdGx5OlxuICAgIC8vICAgKiBHZXRQb2xpY3lFbmdpbmUgb24gdGhlIHBvbGljeS1lbmdpbmUsIGFuZFxuICAgIC8vICAgKiBBdXRob3JpemVBY3Rpb24gKyBQYXJ0aWFsbHlBdXRob3JpemVBY3Rpb25zIG9uIEJPVEggdGhlIHBvbGljeS1lbmdpbmVcbiAgICAvLyAgICAgYW5kIHRoZSBnYXRld2F5LlxuICAgIC8vIFdpdGhvdXQgdGhlc2UgdGhlIEdhdGV3YXkgY2Fubm90IGV2YWx1YXRlIENlZGFyIHBvbGljaWVzIChhdHRhY2hpbmcgYVxuICAgIC8vIFBvbGljeSBFbmdpbmUgZmFpbHMsIGFuZCBhbGwgdG9vbCBpbnZvY2F0aW9ucyBkZWZhdWx0LWRlbnkpLlxuICAgIC8vIFRoZSBnYXRld2F5IEFSTiBpcyBnZW5lcmF0ZWQgYXQgY3JlYXRlIHRpbWUgKHJlZmVyZW5jaW5nIHRoaXMuZ2F0ZXdheUFyblxuICAgIC8vIGhlcmUgd291bGQgYmUgY2lyY3VsYXIpLCBzbyB0aGUgZ2F0ZXdheSByZXNvdXJjZSBpcyBzY29wZWQgdG8gdGhpc1xuICAgIC8vIGFjY291bnQvcmVnaW9uJ3MgZ2F0ZXdheSBuYW1lc3BhY2UuXG4gICAgY29uc3QgZ2F0ZXdheVJlc291cmNlV2lsZGNhcmQgPSBgYXJuOmF3czpiZWRyb2NrLWFnZW50Y29yZToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06Z2F0ZXdheS8qYDtcblxuICAgIGdhdGV3YXlSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIHNpZDogJ1BvbGljeUVuZ2luZUNvbmZpZ3VyYXRpb24nLFxuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydiZWRyb2NrLWFnZW50Y29yZTpHZXRQb2xpY3lFbmdpbmUnXSxcbiAgICAgIHJlc291cmNlczogW3BvbGljeUVuZ2luZUFybl0sXG4gICAgfSkpO1xuXG4gICAgZ2F0ZXdheVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgc2lkOiAnUG9saWN5RW5naW5lQXV0aG9yaXphdGlvbicsXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpBdXRob3JpemVBY3Rpb24nLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6UGFydGlhbGx5QXV0aG9yaXplQWN0aW9ucycsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbcG9saWN5RW5naW5lQXJuLCBnYXRld2F5UmVzb3VyY2VXaWxkY2FyZF0sXG4gICAgfSkpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIERlbnktYXVkaXQgUkVRVUVTVCBpbnRlcmNlcHRvciAoTGFtYmRhKVxuICAgIC8vXG4gICAgLy8gRW1pdHMgZXhhY3RseSBvbmUgc3RydWN0dXJlZCBDbG91ZFdhdGNoIHJlY29yZCBvbiBhIGRlbnkgVG9vbF9JbnZvY2F0aW9uXG4gICAgLy8gKEpXVCBgc3ViYCwgcmVxdWVzdGVkIFRvb2xfQ2F0ZWdvcnksIGBkZW55YCwgdGltZXN0YW1wKSDigJQgbmV2ZXIgdGhlIHRva2VuXG4gICAgLy8gb3IgdG9vbCBhcmdzL3Jlc3VsdHMgKFJlcSA4LjMpLiBJdCBpcyBBVURJVC1PTkxZOiBpdCByZS1kZXJpdmVzIHRoZVxuICAgIC8vIGRlY2lzaW9uIHdpdGggdGhlIHNhbWUgYXV0aG9yaXRhdGl2ZSByb2xlLT5jYXRlZ29yeSBtb2RlbCBhbmQgQUxXQVlTXG4gICAgLy8gZm9yd2FyZHMgdGhlIHJlcXVlc3QgdW5jaGFuZ2VkLCBzbyB0aGUgQ2VkYXIgUG9saWN5IGVuZ2luZSBhYm92ZSByZW1haW5zXG4gICAgLy8gdGhlIGF1dGhvcml0YXRpdmUgYXV0aG9yaXplci4gQW55IGF1ZGl0IGZhaWx1cmUgaXMgc3dhbGxvd2VkIGluc2lkZSB0aGVcbiAgICAvLyBoYW5kbGVyIGFuZCB0aGUgcmVxdWVzdCBpcyBzdGlsbCBmb3J3YXJkZWQgdW5jaGFuZ2VkLCBzbyBhbiBhdWRpdCBmYWlsdXJlXG4gICAgLy8gY2FuIG5ldmVyIHN1cHByZXNzIHRoZSBhdXRob3JpemF0aW9uIGVycm9yIHJldHVybmVkIHRvIHRoZSBjYWxsZXJcbiAgICAvLyAoUmVxIDguNCkuXG4gICAgLy9cbiAgICAvLyBWZXJpZmllZCBhZ2FpbnN0IHRoZSBBZ2VudENvcmUgZG9jczpcbiAgICAvLyAgICogYEFXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheWAgZXhwb3NlcyBgSW50ZXJjZXB0b3JDb25maWd1cmF0aW9uc2BcbiAgICAvLyAgICAgKGFycmF5LCAx4oCTMikuIEVhY2ggZW50cnkgaGFzIGBJbnRlcmNlcHRpb25Qb2ludHNgIChSRVFVRVNUL1JFU1BPTlNFKSxcbiAgICAvLyAgICAgYEludGVyY2VwdG9yLkxhbWJkYS5Bcm5gLCBhbmQgYElucHV0Q29uZmlndXJhdGlvbi5QYXNzUmVxdWVzdEhlYWRlcnNgLlxuICAgIC8vICAgKiBUaGUgSldUIGBzdWJgL2Byb2xlYCBhcmUgb25seSBhdmFpbGFibGUgdG8gdGhlIGludGVyY2VwdG9yIHZpYSB0aGVcbiAgICAvLyAgICAgYEF1dGhvcml6YXRpb25gIGhlYWRlciwgZGVsaXZlcmVkIG9ubHkgd2hlbiBgUGFzc1JlcXVlc3RIZWFkZXJzYCBpc1xuICAgIC8vICAgICB0cnVlLiBUaGUgR2F0ZXdheSB2ZXJpZmllcyB0aGUgSldUIGJlZm9yZSBpbnZva2luZyB0aGUgaW50ZXJjZXB0b3I7XG4gICAgLy8gICAgIHRoZSBoYW5kbGVyIGRlY29kZXMgKGRvZXMgbm90IHZlcmlmeSkgaXQgc29sZWx5IHRvIHJlYWQgYHN1YmAvYHJvbGVgXG4gICAgLy8gICAgIGFuZCBuZXZlciBsb2dzIHRoZSB0b2tlbi5cbiAgICAvLyAgICogQWdlbnRDb3JlIFBvbGljeSBhbHNvIGhhcyBuYXRpdmUgZGVueSBvYnNlcnZhYmlsaXR5IChtZXRyaWNzICsgdHJhY2VcbiAgICAvLyAgICAgc3BhbnMpLiBQZXIgZGVzaWduIE5vdGUgNCB3ZSB1c2UgdGhlIGludGVyY2VwdG9yIGFzIHRoZSBzaW5nbGVcbiAgICAvLyAgICAgY2Fub25pY2FsIGZvdXItZmllbGQgYXVkaXQgZW50cnkgYW5kIGRvIE5PVCBhbHNvIGVuYWJsZSBhIGNvbXBldGluZ1xuICAgIC8vICAgICBuYXRpdmUtb2JzZXJ2YWJpbGl0eSBhdWRpdCBzaW5rLCBrZWVwaW5nIFwiZXhhY3RseSBvbmUgYXVkaXQgZW50cnlcIlxuICAgIC8vICAgICBwZXIgZGVueSAoUmVxIDguMykuXG4gICAgLy8gU2VlIGNkay9sYW1iZGEvZGVueS1hdWRpdC1pbnRlcmNlcHRvci9SRUFETUUubWQgZm9yIHRoZSBmdWxsIHJlc2VhcmNoIGxvZy5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBEZWRpY2F0ZWQgbG9nIGdyb3VwIHNvIHRoZSBzdHJ1Y3R1cmVkIGRlbnktYXVkaXQgcmVjb3JkcyBoYXZlIGFuIGV4cGxpY2l0LFxuICAgIC8vIHJldGFpbmVkIENsb3VkV2F0Y2ggZGVzdGluYXRpb24gKHJhdGhlciB0aGFuIHJlbHlpbmcgb24gdGhlIGltcGxpY2l0XG4gICAgLy8gTGFtYmRhIGxvZyBncm91cCkuXG4gICAgY29uc3QgZGVueUF1ZGl0TG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCAnRGVueUF1ZGl0SW50ZXJjZXB0b3JMb2dHcm91cCcsIHtcbiAgICAgIHJldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9ZRUFSLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGRlbnlBdWRpdEludGVyY2VwdG9yRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdEZW55QXVkaXRJbnRlcmNlcHRvckZ1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTIsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlci5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2RlbnktYXVkaXQtaW50ZXJjZXB0b3InKSksXG4gICAgICBkZXNjcmlwdGlvbjogJ0RlbnktYXVkaXQgUkVRVUVTVCBpbnRlcmNlcHRvciBmb3IgdGhlIENsb3VkT3BzIEdhdGV3YXkgKHN0cnVjdHVyZWQgZGVueSByZWNvcmRzKS4nLFxuICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgbG9nR3JvdXA6IGRlbnlBdWRpdExvZ0dyb3VwLFxuICAgIH0pO1xuXG4gICAgLy8gVGhlIEdhdGV3YXkgc2VydmljZSByb2xlIGludm9rZXMgdGhlIGludGVyY2VwdG9yLiBTY29wZSB0aGUgZ3JhbnQgdG8gdGhpc1xuICAgIC8vIGZ1bmN0aW9uIG9ubHkgKGludGVyY2VwdG9yIHNlY3VyaXR5IGJlc3QgcHJhY3RpY2Ug4oCUIG5ldmVyIGEgd2lsZGNhcmQpLlxuICAgIGRlbnlBdWRpdEludGVyY2VwdG9yRm4uZ3JhbnRJbnZva2UoZ2F0ZXdheVJvbGUpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIERpc2NvdmVyeS1maWx0ZXIgUkVTUE9OU0UgaW50ZXJjZXB0b3IgKExhbWJkYSlcbiAgICAvL1xuICAgIC8vIEZpbHRlcnMgdGhlIGB0b29scy9saXN0YCBEaXNjb3ZlcnlfUmVzcG9uc2UgZG93biB0byB0aGUgY2FsbGVyJ3MgYWxsb3dlZFxuICAgIC8vIGNhdGVnb3JpZXMgYmVmb3JlIHRoZSBHYXRld2F5IHJldHVybnMgaXQsIHNvIGEgTm9uQWRtaW4gdXNlciBjYW5ub3RcbiAgICAvLyBlbnVtZXJhdGUgdGhlIG5hbWVzL2Rlc2NyaXB0aW9ucy9pbnB1dCBzY2hlbWFzIG9mIHRvb2xzIHRoZXkgY2Fubm90XG4gICAgLy8gaW52b2tlLiBJdCBpcyBhIERJU1RJTkNULCBpbmRlcGVuZGVudGx5IHJlYXNvbmVkIGludGVyY2VwdG9yIGZyb20gdGhlXG4gICAgLy8gZGVueS1hdWRpdCBSRVFVRVNUIGludGVyY2VwdG9yIGFib3ZlOiBpdCB0cmFuc2Zvcm1zIG9ubHkgYHRvb2xzL2xpc3RgXG4gICAgLy8gcmVzcG9uc2VzLCBuZXZlciBhdWRpdHMgb3IgZW5mb3JjZXMgaW52b2NhdGlvbiwgcmV1c2VzIHRoZSBhdXRob3JpdGF0aXZlXG4gICAgLy8gcm9sZS0+Y2F0ZWdvcnkgbW9kZWwgKHZlbmRvcmVkIGJ5dGUtZm9yLWJ5dGUpLCBhbmQgZmFpbHMgY2xvc2VkIChyZXR1cm5zXG4gICAgLy8gYW4gZW1wdHkgdG9vbCBsaXN0KSBvbiBhbnkgZXJyb3Ig4oCUIG5ldmVyIHRoZSB1bmZpbHRlcmVkIGNhdGFsb2cuIEl0XG4gICAgLy8gZGVjb2RlcyAoZG9lcyBub3QgdmVyaWZ5KSB0aGUgYWxyZWFkeS12ZXJpZmllZCBBdXRob3JpemF0aW9uIEpXVCBzb2xlbHlcbiAgICAvLyB0byByZWFkIGBzdWJgL2Byb2xlYCBhbmQgbmV2ZXIgbG9ncyB0aGUgdG9rZW4uXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgLy8gRGVkaWNhdGVkLCByZXRhaW5lZCBsb2cgZ3JvdXAg4oCUIG1pcnJvcnMgRGVueUF1ZGl0SW50ZXJjZXB0b3JMb2dHcm91cC5cbiAgICBjb25zdCBkaXNjb3ZlcnlGaWx0ZXJMb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdEaXNjb3ZlcnlGaWx0ZXJJbnRlcmNlcHRvckxvZ0dyb3VwJywge1xuICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX1lFQVIsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZGlzY292ZXJ5RmlsdGVySW50ZXJjZXB0b3JGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0Rpc2NvdmVyeUZpbHRlckludGVyY2VwdG9yRnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyLmhhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvZGlzY292ZXJ5LWZpbHRlci1pbnRlcmNlcHRvcicpKSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUm9sZS1maWx0ZXJlZCB0b29sIGRpc2NvdmVyeSBSRVNQT05TRSBpbnRlcmNlcHRvciBmb3IgdGhlIENsb3VkT3BzIEdhdGV3YXkuJyxcbiAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEwKSxcbiAgICAgIGxvZ0dyb3VwOiBkaXNjb3ZlcnlGaWx0ZXJMb2dHcm91cCxcbiAgICB9KTtcblxuICAgIC8vIFRoZSBHYXRld2F5IHNlcnZpY2Ugcm9sZSBpbnZva2VzIHRoZSBpbnRlcmNlcHRvci4gU2NvcGUgdGhlIGdyYW50IHRvIHRoaXNcbiAgICAvLyBmdW5jdGlvbiBvbmx5IChpbnRlcmNlcHRvciBzZWN1cml0eSBiZXN0IHByYWN0aWNlIOKAlCBuZXZlciBhIHdpbGRjYXJkKS5cbiAgICBkaXNjb3ZlcnlGaWx0ZXJJbnRlcmNlcHRvckZuLmdyYW50SW52b2tlKGdhdGV3YXlSb2xlKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBHYXRld2F5IChDVVNUT01fSldUIGF1dGgg4oCUIHZlcmlmaWVzIHBlci11c2VyIENvZ25pdG8gdG9rZW5zIHNvIHRoZVxuICAgIC8vIHJvbGUgY2xhaW0gcmVhY2hlcyBBZ2VudENvcmUgUG9saWN5IGZvciBmaW5lLWdyYWluZWQgYXV0aG9yaXphdGlvbilcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBjb25zdCBnYXRld2F5ID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnTWNwR2F0ZXdheScsIHtcbiAgICAgIHR5cGU6ICdBV1M6OkJlZHJvY2tBZ2VudENvcmU6OkdhdGV3YXknLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBOYW1lOiAnY2xvdWRvcHMtZ2F0ZXdheScsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnQ2xvdWRPcHMgR2F0ZXdheSBmb3IgYmlsbGluZyBhbmQgcHJpY2luZyBNQ1AgdG9vbHMgKEpXVCBhdXRoKScsXG4gICAgICAgIFByb3RvY29sVHlwZTogJ01DUCcsXG4gICAgICAgIEF1dGhvcml6ZXJUeXBlOiAnQ1VTVE9NX0pXVCcsXG4gICAgICAgIEF1dGhvcml6ZXJDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgQ3VzdG9tSldUQXV0aG9yaXplcjoge1xuICAgICAgICAgICAgRGlzY292ZXJ5VXJsOiBgaHR0cHM6Ly9jb2duaXRvLWlkcC4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tLyR7cHJvcHMuYXV0aFVzZXJQb29sSWR9Ly53ZWxsLWtub3duL29wZW5pZC1jb25maWd1cmF0aW9uYCxcbiAgICAgICAgICAgIC8vIFRoZSBGcm9udEVuZCBmb3J3YXJkcyB0aGUgQ29nbml0byBBQ0NFU1MgdG9rZW4sIHdoaWNoIGNhcnJpZXNcbiAgICAgICAgICAgIC8vIGBjbGllbnRfaWRgIChub3QgYW4gYGF1ZGAgY2xhaW0g4oCUIG9ubHkgSUQgdG9rZW5zIGhhdmUgYGF1ZGApLlxuICAgICAgICAgICAgLy8gVGhlIEpXVCBhdXRob3JpemVyIG11c3QgdGhlcmVmb3JlIG1hdGNoIG9uIEFsbG93ZWRDbGllbnRzXG4gICAgICAgICAgICAvLyAoY2xpZW50X2lkKSByYXRoZXIgdGhhbiBBbGxvd2VkQXVkaWVuY2UsIG9yIHZhbGlkYXRpb24gNDAzcy5cbiAgICAgICAgICAgIEFsbG93ZWRDbGllbnRzOiBbcHJvcHMuYXV0aFVzZXJQb29sQ2xpZW50SWRdLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIFByb3RvY29sQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE1jcDoge1xuICAgICAgICAgICAgSW5zdHJ1Y3Rpb25zOiAnQ2xvdWRPcHMgZ2F0ZXdheSBmb3IgYmlsbGluZywgcHJpY2luZywgQ2xvdWRXYXRjaCwgQ2xvdWRUcmFpbCwgYW5kIGludmVudG9yeSBNQ1AgdG9vbHMnLFxuICAgICAgICAgICAgU2VhcmNoVHlwZTogJ1NFTUFOVElDJyxcbiAgICAgICAgICAgIFN1cHBvcnRlZFZlcnNpb25zOiBbJzIwMjUtMDMtMjYnXSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICAvLyBBc3NvY2lhdGUgdGhlIENlZGFyIHBvbGljeSBlbmdpbmUuIEVORk9SQ0UgbWFrZXMgdGhlIGVuZ2luZSBkZW55XG4gICAgICAgIC8vIGRpc2FsbG93ZWQgdG9vbCBkaXNjb3ZlcnkvaW52b2NhdGlvbjsgTE9HX09OTFkgd291bGQgb25seSB0cmFjZS5cbiAgICAgICAgUG9saWN5RW5naW5lQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIEFybjogcG9saWN5RW5naW5lQXJuLFxuICAgICAgICAgIE1vZGU6ICdFTkZPUkNFJyxcbiAgICAgICAgfSxcbiAgICAgICAgLy8gUmVnaXN0ZXIgdGhlIGRlbnktYXVkaXQgUkVRVUVTVCBpbnRlcmNlcHRvci4gUGFzc1JlcXVlc3RIZWFkZXJzPXRydWVcbiAgICAgICAgLy8gaXMgcmVxdWlyZWQgc28gdGhlIGludGVyY2VwdG9yIGNhbiByZWFkIHRoZSAoYWxyZWFkeS12ZXJpZmllZClcbiAgICAgICAgLy8gQXV0aG9yaXphdGlvbiBoZWFkZXIgdG8gcmVjb3ZlciB0aGUgSldUIGBzdWJgL2Byb2xlYCBmb3IgdGhlIGF1ZGl0XG4gICAgICAgIC8vIHJlY29yZDsgdGhlIGhhbmRsZXIgbmV2ZXIgbG9ncyB0aGUgdG9rZW4uIFRoZSBpbnRlcmNlcHRvciBpc1xuICAgICAgICAvLyBhdWRpdC1vbmx5IGFuZCBmb3J3YXJkcyBldmVyeSByZXF1ZXN0IHVuY2hhbmdlZC5cbiAgICAgICAgSW50ZXJjZXB0b3JDb25maWd1cmF0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIEludGVyY2VwdGlvblBvaW50czogWydSRVFVRVNUJ10sXG4gICAgICAgICAgICBJbnRlcmNlcHRvcjoge1xuICAgICAgICAgICAgICBMYW1iZGE6IHtcbiAgICAgICAgICAgICAgICBBcm46IGRlbnlBdWRpdEludGVyY2VwdG9yRm4uZnVuY3Rpb25Bcm4sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgSW5wdXRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgICAgIFBhc3NSZXF1ZXN0SGVhZGVyczogdHJ1ZSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICAvLyBSZWdpc3RlciB0aGUgZGlzY292ZXJ5LWZpbHRlciBSRVNQT05TRSBpbnRlcmNlcHRvci5cbiAgICAgICAgICAvLyBQYXNzUmVxdWVzdEhlYWRlcnM9dHJ1ZSBzbyBpdCBjYW4gcmVhZCB0aGUgKGFscmVhZHktdmVyaWZpZWQpXG4gICAgICAgICAgLy8gQXV0aG9yaXphdGlvbiBoZWFkZXIgdG8gcmVjb3ZlciB0aGUgSldUIGByb2xlYCBmb3IgZmlsdGVyaW5nO1xuICAgICAgICAgIC8vIHRoZSBoYW5kbGVyIG5ldmVyIGxvZ3MgdGhlIHRva2VuLiBJdCB0cmFuc2Zvcm1zIG9ubHkgYHRvb2xzL2xpc3RgXG4gICAgICAgICAgLy8gZGlzY292ZXJ5IHJlc3BvbnNlcyBhbmQgZmFpbHMgY2xvc2VkIHRvIGFuIGVtcHR5IHRvb2wgbGlzdC5cbiAgICAgICAgICB7XG4gICAgICAgICAgICBJbnRlcmNlcHRpb25Qb2ludHM6IFsnUkVTUE9OU0UnXSxcbiAgICAgICAgICAgIEludGVyY2VwdG9yOiB7XG4gICAgICAgICAgICAgIExhbWJkYToge1xuICAgICAgICAgICAgICAgIEFybjogZGlzY292ZXJ5RmlsdGVySW50ZXJjZXB0b3JGbi5mdW5jdGlvbkFybixcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBJbnB1dENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICAgICAgUGFzc1JlcXVlc3RIZWFkZXJzOiB0cnVlLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgICBSb2xlQXJuOiBnYXRld2F5Um9sZS5yb2xlQXJuLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBnYXRld2F5Lm5vZGUuYWRkRGVwZW5kZW5jeShkZW55QXVkaXRJbnRlcmNlcHRvckZuKTtcbiAgICBnYXRld2F5Lm5vZGUuYWRkRGVwZW5kZW5jeShkaXNjb3ZlcnlGaWx0ZXJJbnRlcmNlcHRvckZuKTtcbiAgICBnYXRld2F5Lm5vZGUuYWRkRGVwZW5kZW5jeShvYXV0aFByb3ZpZGVyKTtcbiAgICBnYXRld2F5Lm5vZGUuYWRkRGVwZW5kZW5jeShwb2xpY3lFbmdpbmUpO1xuICAgIC8vIFRoZSBHYXRld2F5IGNhbGxzIEdldFBvbGljeUVuZ2luZSB1c2luZyBpdHMgc2VydmljZSByb2xlIGF0IGNyZWF0ZSB0aW1lLFxuICAgIC8vIHNvIHRoZSByb2xlJ3MgaW5saW5lIHBvbGljeSAod2hpY2ggZ3JhbnRzIGJlZHJvY2stYWdlbnRjb3JlOkdldFBvbGljeUVuZ2luZVxuICAgIC8vIGFuZCB0aGUgT0F1dGgvdG9rZW4tZXhjaGFuZ2UgcGVybWlzc2lvbnMpIE1VU1QgYmUgYXR0YWNoZWQgYmVmb3JlIHRoZVxuICAgIC8vIEdhdGV3YXkgaXMgY3JlYXRlZC4gV2l0aG91dCB0aGlzIGRlcGVuZGVuY3kgQ2xvdWRGb3JtYXRpb24gbWF5IGNyZWF0ZSB0aGVcbiAgICAvLyBHYXRld2F5IGNvbmN1cnJlbnRseSB3aXRoIHRoZSByb2xlIHBvbGljeSwgY2F1c2luZyBhbiBhY2Nlc3MtZGVuaWVkIGVycm9yLlxuICAgIGdhdGV3YXkubm9kZS5hZGREZXBlbmRlbmN5KGdhdGV3YXlSb2xlKTtcblxuICAgIHRoaXMuZ2F0ZXdheUFybiA9IGdhdGV3YXkuZ2V0QXR0KCdHYXRld2F5QXJuJykudG9TdHJpbmcoKTtcbiAgICBjb25zdCBnYXRld2F5SWQgPSBnYXRld2F5LmdldEF0dCgnR2F0ZXdheUlkZW50aWZpZXInKS50b1N0cmluZygpO1xuICAgIHRoaXMuZ2F0ZXdheVVybCA9IGdhdGV3YXkuZ2V0QXR0KCdHYXRld2F5VXJsJykudG9TdHJpbmcoKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBHYXRld2F5IFRhcmdldHMgKE1DUCBTZXJ2ZXIgZW5kcG9pbnRzKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IGJpbGxpbmdUYXJnZXQgPSBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdCaWxsaW5nTWNwVGFyZ2V0Jywge1xuICAgICAgdHlwZTogJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheVRhcmdldCcsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEdhdGV3YXlJZGVudGlmaWVyOiBnYXRld2F5SWQsXG4gICAgICAgIE5hbWU6ICdiaWxsaW5nTWNwJyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdBV1MgTGFicyBCaWxsaW5nIE1DUCBTZXJ2ZXIgb24gQWdlbnRDb3JlIFJ1bnRpbWUnLFxuICAgICAgICBUYXJnZXRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTWNwOiB7IE1jcFNlcnZlcjogeyBFbmRwb2ludDogcHJvcHMuYmlsbGluZ01jcFJ1bnRpbWVFbmRwb2ludCB9IH0sXG4gICAgICAgIH0sXG4gICAgICAgIENyZWRlbnRpYWxQcm92aWRlckNvbmZpZ3VyYXRpb25zOiBbe1xuICAgICAgICAgIENyZWRlbnRpYWxQcm92aWRlclR5cGU6ICdPQVVUSCcsXG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICBPYXV0aENyZWRlbnRpYWxQcm92aWRlcjoge1xuICAgICAgICAgICAgICBQcm92aWRlckFybjogb2F1dGhQcm92aWRlckFybixcbiAgICAgICAgICAgICAgU2NvcGVzOiBbJ21jcC1ydW50aW1lLXNlcnZlci9pbnZva2UnXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfV0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGJpbGxpbmdUYXJnZXQubm9kZS5hZGREZXBlbmRlbmN5KGdhdGV3YXkpO1xuXG4gICAgY29uc3QgcHJpY2luZ1RhcmdldCA9IG5ldyBjZGsuQ2ZuUmVzb3VyY2UodGhpcywgJ1ByaWNpbmdNY3BUYXJnZXQnLCB7XG4gICAgICB0eXBlOiAnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpHYXRld2F5VGFyZ2V0JyxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgR2F0ZXdheUlkZW50aWZpZXI6IGdhdGV3YXlJZCxcbiAgICAgICAgTmFtZTogJ3ByaWNpbmdNY3AnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0FXUyBMYWJzIFByaWNpbmcgTUNQIFNlcnZlciBvbiBBZ2VudENvcmUgUnVudGltZScsXG4gICAgICAgIFRhcmdldENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBNY3A6IHsgTWNwU2VydmVyOiB7IEVuZHBvaW50OiBwcm9wcy5wcmljaW5nTWNwUnVudGltZUVuZHBvaW50IH0gfSxcbiAgICAgICAgfSxcbiAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyQ29uZmlndXJhdGlvbnM6IFt7XG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyVHlwZTogJ09BVVRIJyxcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXI6IHtcbiAgICAgICAgICAgIE9hdXRoQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICAgIFByb3ZpZGVyQXJuOiBvYXV0aFByb3ZpZGVyQXJuLFxuICAgICAgICAgICAgICBTY29wZXM6IFsnbWNwLXJ1bnRpbWUtc2VydmVyL2ludm9rZSddLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgcHJpY2luZ1RhcmdldC5ub2RlLmFkZERlcGVuZGVuY3koZ2F0ZXdheSk7XG5cbiAgICBjb25zdCBjbG91ZHdhdGNoTWNwVGFyZ2V0ID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnQ2xvdWRXYXRjaE1jcFRhcmdldCcsIHtcbiAgICAgIHR5cGU6ICdBV1M6OkJlZHJvY2tBZ2VudENvcmU6OkdhdGV3YXlUYXJnZXQnLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBHYXRld2F5SWRlbnRpZmllcjogZ2F0ZXdheUlkLFxuICAgICAgICBOYW1lOiAnY2xvdWR3YXRjaE1jcCcsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnQVdTIExhYnMgQ2xvdWRXYXRjaCBNQ1AgU2VydmVyIG9uIEFnZW50Q29yZSBSdW50aW1lJyxcbiAgICAgICAgVGFyZ2V0Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE1jcDogeyBNY3BTZXJ2ZXI6IHsgRW5kcG9pbnQ6IHByb3BzLmNsb3Vkd2F0Y2hNY3BSdW50aW1lRW5kcG9pbnQgfSB9LFxuICAgICAgICB9LFxuICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXJDb25maWd1cmF0aW9uczogW3tcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXJUeXBlOiAnT0FVVEgnLFxuICAgICAgICAgIENyZWRlbnRpYWxQcm92aWRlcjoge1xuICAgICAgICAgICAgT2F1dGhDcmVkZW50aWFsUHJvdmlkZXI6IHtcbiAgICAgICAgICAgICAgUHJvdmlkZXJBcm46IG9hdXRoUHJvdmlkZXJBcm4sXG4gICAgICAgICAgICAgIFNjb3BlczogWydtY3AtcnVudGltZS1zZXJ2ZXIvaW52b2tlJ10sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH1dLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBjbG91ZHdhdGNoTWNwVGFyZ2V0Lm5vZGUuYWRkRGVwZW5kZW5jeShnYXRld2F5KTtcblxuICAgIGNvbnN0IGNsb3VkdHJhaWxNY3BUYXJnZXQgPSBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdDbG91ZFRyYWlsTWNwVGFyZ2V0Jywge1xuICAgICAgdHlwZTogJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheVRhcmdldCcsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEdhdGV3YXlJZGVudGlmaWVyOiBnYXRld2F5SWQsXG4gICAgICAgIE5hbWU6ICdjbG91ZHRyYWlsTWNwJyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdBV1MgTGFicyBDbG91ZFRyYWlsIE1DUCBTZXJ2ZXIgb24gQWdlbnRDb3JlIFJ1bnRpbWUnLFxuICAgICAgICBUYXJnZXRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTWNwOiB7IE1jcFNlcnZlcjogeyBFbmRwb2ludDogcHJvcHMuY2xvdWR0cmFpbE1jcFJ1bnRpbWVFbmRwb2ludCB9IH0sXG4gICAgICAgIH0sXG4gICAgICAgIENyZWRlbnRpYWxQcm92aWRlckNvbmZpZ3VyYXRpb25zOiBbe1xuICAgICAgICAgIENyZWRlbnRpYWxQcm92aWRlclR5cGU6ICdPQVVUSCcsXG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICBPYXV0aENyZWRlbnRpYWxQcm92aWRlcjoge1xuICAgICAgICAgICAgICBQcm92aWRlckFybjogb2F1dGhQcm92aWRlckFybixcbiAgICAgICAgICAgICAgU2NvcGVzOiBbJ21jcC1ydW50aW1lLXNlcnZlci9pbnZva2UnXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfV0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNsb3VkdHJhaWxNY3BUYXJnZXQubm9kZS5hZGREZXBlbmRlbmN5KGdhdGV3YXkpO1xuXG4gICAgY29uc3QgaW52ZW50b3J5TWNwVGFyZ2V0ID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnSW52ZW50b3J5TWNwVGFyZ2V0Jywge1xuICAgICAgdHlwZTogJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheVRhcmdldCcsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEdhdGV3YXlJZGVudGlmaWVyOiBnYXRld2F5SWQsXG4gICAgICAgIE5hbWU6ICdpbnZlbnRvcnlNY3AnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0ludmVudG9yeSBNQ1AgU2VydmVyIG9uIEFnZW50Q29yZSBSdW50aW1lJyxcbiAgICAgICAgVGFyZ2V0Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE1jcDogeyBNY3BTZXJ2ZXI6IHsgRW5kcG9pbnQ6IHByb3BzLmludmVudG9yeU1jcFJ1bnRpbWVFbmRwb2ludCB9IH0sXG4gICAgICAgIH0sXG4gICAgICAgIENyZWRlbnRpYWxQcm92aWRlckNvbmZpZ3VyYXRpb25zOiBbe1xuICAgICAgICAgIENyZWRlbnRpYWxQcm92aWRlclR5cGU6ICdPQVVUSCcsXG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICBPYXV0aENyZWRlbnRpYWxQcm92aWRlcjoge1xuICAgICAgICAgICAgICBQcm92aWRlckFybjogb2F1dGhQcm92aWRlckFybixcbiAgICAgICAgICAgICAgU2NvcGVzOiBbJ21jcC1ydW50aW1lLXNlcnZlci9pbnZva2UnXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfV0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGludmVudG9yeU1jcFRhcmdldC5ub2RlLmFkZERlcGVuZGVuY3koZ2F0ZXdheSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ2VkYXIgcG9saWNpZXMgKHJvbGUgLT4gdG9vbC1jYXRlZ29yeSBtYXBwaW5nKVxuICAgIC8vXG4gICAgLy8gQXV0aG9yaXRhdGl2ZSByb2xlLT5jYXRlZ29yeSBtb2RlbCBpbXBsZW1lbnRlZCBhcyB0d28gYHBlcm1pdGAgc3RhdGVtZW50c1xuICAgIC8vIChDZWRhciBpcyBkZW55LWJ5LWRlZmF1bHQ7IGZvcmJpZCBvdmVycmlkZXMgcGVybWl0KTpcbiAgICAvLyAgICogYmlsbGluZyArIHByaWNpbmcgIC0+IHBlcm1pdHRlZCBmb3IgZXZlcnkgYXV0aGVudGljYXRlZCB1c2VyLlxuICAgIC8vICAgKiBjbG91ZHdhdGNoICsgY2xvdWR0cmFpbCArIGludmVudG9yeSAtPiBwZXJtaXR0ZWQgb25seSB3aGVuIHRoZVxuICAgIC8vICAgICB2ZXJpZmllZCBKV1QgYHJvbGVgIGNsYWltIChzdG9yZWQgYXMgYSBwcmluY2lwYWwgdGFnKSA9PSBcImFkbWluXCIuXG4gICAgLy8gICAqIGV2ZXJ5dGhpbmcgZWxzZSAoaW5jbC4gbmV3bHkgYWRkZWQgY2F0ZWdvcmllcykgLT4gZGVuaWVkIGJ5IGRlZmF1bHQuXG4gICAgLy9cbiAgICAvLyBDYXRlZ29yeSAtPiB0b29sIGdyb3VwaW5nLiBBdCB0aGUgZ2F0ZXdheSBlYWNoIHRvb2wgYWN0aW9uIGlzXG4gICAgLy8gYEFnZW50Q29yZTo6QWN0aW9uOjpcIjx0YXJnZXROYW1lPl9fXzx0b29sTmFtZT5cImAgKHNlZSB0aGUgQWdlbnRDb3JlXG4gICAgLy8gYXV0aG9yaXphdGlvbi1mbG93IGRvY3MpLiBBIGNhdGVnb3J5IHRoZXJlZm9yZSBjb3JyZXNwb25kcyB0byBhIHRhcmdldFxuICAgIC8vIHRvb2wtbmFtZSBwcmVmaXg6XG4gICAgLy8gICBiaWxsaW5nIC0+IGJpbGxpbmdNY3BfX18sIHByaWNpbmcgLT4gcHJpY2luZ01jcF9fXyxcbiAgICAvLyAgIGNsb3Vkd2F0Y2ggLT4gY2xvdWR3YXRjaE1jcF9fXywgY2xvdWR0cmFpbCAtPiBjbG91ZHRyYWlsTWNwX19fLFxuICAgIC8vICAgaW52ZW50b3J5IC0+IGludmVudG9yeU1jcF9fXy5cbiAgICAvL1xuICAgIC8vIEFTU1VNUFRJT04gKG11c3QgYmUgdmFsaWRhdGVkIGFnYWluc3QgdGhlIGxpdmUgQWdlbnRDb3JlIENlZGFyIHNjaGVtYSxcbiAgICAvLyBjb3ZlcmVkIGJ5IHRoZSBpbnRlZ3JhdGlvbiB0ZXN0cyBpbiB0YXNrIDkpOiB0aGUgZ3JvdXBpbmcgaXMgZXhwcmVzc2VkXG4gICAgLy8gaGVyZSB2aWEgYGFjdGlvbi50b29sX2NhdGVnb3J5ID09IFwiPGNhdGVnb3J5PlwiYCwgbWF0Y2hpbmcgdGhlIGRlc2lnblxuICAgIC8vIGRvY3VtZW50J3MgcG9saWN5IHNldC4gVGhlIGNvbmNyZXRlIENlZGFyIHNjaGVtYSBnZW5lcmF0ZWQgZnJvbSB0aGVcbiAgICAvLyBnYXRld2F5J3MgdG9vbHMgbWF5IGluc3RlYWQgcmVxdWlyZSBlbnVtZXJhdGluZyB0aGUgcGVyLXRvb2wgYWN0aW9uXG4gICAgLy8gaWRlbnRpZmllcnMgb3IgbWF0Y2hpbmcgdGhlIGA8dGFyZ2V0TmFtZT5fX19gIHByZWZpeCBkaXJlY3RseS4gSWYgdGhlXG4gICAgLy8gbGl2ZSBzY2hlbWEgZG9lcyBub3QgZXhwb3NlIGEgYHRvb2xfY2F0ZWdvcnlgIGFjdGlvbiBhdHRyaWJ1dGUsIHN3aXRjaFxuICAgIC8vIHRoZXNlIHN0YXRlbWVudHMgdG8gYGFjdGlvbiBpbiBbQWdlbnRDb3JlOjpBY3Rpb246OlwiYmlsbGluZ01jcF9fXy4uLlwiLCDigKZdYFxuICAgIC8vIChlbnVtZXJhdGVkKSBvciB0aGUgc2NoZW1hJ3MgZG9jdW1lbnRlZCBjYXRlZ29yeSBhdHRyaWJ1dGUuIFRoZVxuICAgIC8vIHJvbGUtPmNhdGVnb3J5IFNFTUFOVElDUyBhYm92ZSBhcmUgdGhlIGludmFyaWFudDsgb25seSB0aGUgYWN0aW9uLW1hdGNoXG4gICAgLy8gZXhwcmVzc2lvbiBpcyBwcm92aXNpb25hbC4gVmFsaWRhdGlvbk1vZGUgaXMgSUdOT1JFX0FMTF9GSU5ESU5HUyBzbyB0aGVcbiAgICAvLyBlbmdpbmUgYWNjZXB0cyB0aGUgcG9saWNpZXMgZHVyaW5nIHRoaXMgcHJvdmlzaW9uYWwgcGhhc2U7IHRpZ2h0ZW4gdG9cbiAgICAvLyBGQUlMX09OX0FOWV9GSU5ESU5HUyBvbmNlIHRoZSBhY3Rpb24gbW9kZWwgaXMgY29uZmlybWVkLlxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IGdhdGV3YXlBcm5SZWYgPSB0aGlzLmdhdGV3YXlBcm47XG5cbiAgICAvLyBBZ2VudENvcmUgZ2VuZXJhdGVzIGEgQ2VkYXIgYWN0aW9uIEdST1VQIHBlciBnYXRld2F5IHRhcmdldCwgbmFtZWQgYnkgdGhlXG4gICAgLy8gdGFyZ2V0IG5hbWUgKGUuZy4gQWdlbnRDb3JlOjpBY3Rpb246OlwiYmlsbGluZ01jcFwiKS4gRWFjaCB0b29sIGFjdGlvblxuICAgIC8vICg8dGFyZ2V0Pl9fXzx0b29sPikgaXMgYSBtZW1iZXIgb2YgaXRzIHRhcmdldCdzIGdyb3VwLCBzbyB3ZSBjYW4gc2NvcGUgYVxuICAgIC8vIHBvbGljeSB0byBhbiBlbnRpcmUgY2F0ZWdvcnkgYnkgcmVmZXJlbmNpbmcgdGhlIHRhcmdldCBuYW1lIHdlIGFscmVhZHlcbiAgICAvLyBrbm93IGZyb20gQ0RLIOKAlCBubyBwZXItdG9vbCBlbnVtZXJhdGlvbiBvciBydW50aW1lIGRpc2NvdmVyeSByZXF1aXJlZC5cbiAgICAvLyBUaGVyZSBpcyBubyBgdG9vbF9jYXRlZ29yeWAgYXR0cmlidXRlOyB0aGUgcHJpb3IgZGVzaWduIGFzc3VtcHRpb24gd2FzXG4gICAgLy8gd3JvbmcgYW5kIGlzIGNvcnJlY3RlZCBoZXJlLlxuICAgIC8vXG4gICAgLy8gUHVyZS1wZXJtaXQgbW9kZWwgb3ZlciB0aGUgZml2ZSB0YXJnZXQgZ3JvdXBzIChDZWRhciBpcyBkZW55LWJ5LWRlZmF1bHQsXG4gICAgLy8gZm9yYmlkLW92ZXJyaWRlcy1wZXJtaXQpOlxuICAgIC8vICAgKiBiaWxsaW5nICsgcHJpY2luZyAgLT4gcGVybWl0dGVkIGZvciBldmVyeSBhdXRoZW50aWNhdGVkIHVzZXI7XG4gICAgLy8gICAqIGNsb3Vkd2F0Y2ggKyBjbG91ZHRyYWlsICsgaW52ZW50b3J5IC0+IHBlcm1pdHRlZCBvbmx5IHdoZW4gdGhlXG4gICAgLy8gICAgIHZlcmlmaWVkIEpXVCBgcm9sZWAgY2xhaW0gKGEgcHJpbmNpcGFsIHRhZykgPT0gXCJhZG1pblwiO1xuICAgIC8vICAgKiBldmVyeXRoaW5nIGVsc2UgKGluY2wuIGFueSBmdXR1cmUgdGFyZ2V0IGFkZGVkIGxhdGVyKSAtPiBkZW5pZWQgYnlcbiAgICAvLyAgICAgZGVmYXVsdCBmb3Igbm9uLWFkbWlucywgc2F0aXNmeWluZyB0aGUgZGVmYXVsdC1kZW55IHJlcXVpcmVtZW50LlxuICAgIC8vIFRoZSBzZW1hbnRpYy1zZWFyY2ggLyB0b29scy1saXN0IG1ldGEtb3BlcmF0aW9ucyBhcmUgTk9UIFBvbGljeS1nb3Zlcm5lZFxuICAgIC8vIHRhcmdldHMsIHNvIHRoaXMgbW9kZWwgZG9lcyBub3QgYWZmZWN0IHRvb2wgZGlzY292ZXJ5LlxuXG4gICAgY29uc3QgYWxsVXNlcnNDZWRhciA9IFtcbiAgICAgICdwZXJtaXQoJyxcbiAgICAgICcgIHByaW5jaXBhbCBpcyBBZ2VudENvcmU6Ok9BdXRoVXNlciwnLFxuICAgICAgJyAgYWN0aW9uIGluIFtBZ2VudENvcmU6OkFjdGlvbjo6XCJiaWxsaW5nTWNwXCIsIEFnZW50Q29yZTo6QWN0aW9uOjpcInByaWNpbmdNY3BcIl0sJyxcbiAgICAgIGAgIHJlc291cmNlID09IEFnZW50Q29yZTo6R2F0ZXdheTo6XCIke2dhdGV3YXlBcm5SZWZ9XCJgLFxuICAgICAgJyk7JyxcbiAgICBdLmpvaW4oJ1xcbicpO1xuXG4gICAgY29uc3QgYWRtaW5Pbmx5Q2VkYXIgPSBbXG4gICAgICAncGVybWl0KCcsXG4gICAgICAnICBwcmluY2lwYWwgaXMgQWdlbnRDb3JlOjpPQXV0aFVzZXIsJyxcbiAgICAgICcgIGFjdGlvbiBpbiBbQWdlbnRDb3JlOjpBY3Rpb246OlwiY2xvdWR3YXRjaE1jcFwiLCBBZ2VudENvcmU6OkFjdGlvbjo6XCJjbG91ZHRyYWlsTWNwXCIsIEFnZW50Q29yZTo6QWN0aW9uOjpcImludmVudG9yeU1jcFwiXSwnLFxuICAgICAgYCAgcmVzb3VyY2UgPT0gQWdlbnRDb3JlOjpHYXRld2F5OjpcIiR7Z2F0ZXdheUFyblJlZn1cImAsXG4gICAgICAnKSB3aGVuIHsnLFxuICAgICAgJyAgcHJpbmNpcGFsLmhhc1RhZyhcInJvbGVcIikgJiYnLFxuICAgICAgJyAgcHJpbmNpcGFsLmdldFRhZyhcInJvbGVcIikgPT0gXCJhZG1pblwiJyxcbiAgICAgICd9OycsXG4gICAgXS5qb2luKCdcXG4nKTtcblxuICAgIGNvbnN0IHBvbGljeUVuZ2luZVBvbGljaWVzID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnUG9saWN5RW5naW5lUG9saWNpZXMnLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IHBvbGljeUVuZ2luZUZuLmZ1bmN0aW9uQXJuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBPcGVyYXRpb246ICdQT0xJQ0lFUycsXG4gICAgICAgIFBvbGljeUVuZ2luZUlkOiBwb2xpY3lFbmdpbmVJZCxcbiAgICAgICAgLy8gVmFsaWRhdGUgc3RyaWN0bHkgYWdhaW5zdCB0aGUgZ2F0ZXdheSdzIGdlbmVyYXRlZCBDZWRhciBzY2hlbWEgc28gYVxuICAgICAgICAvLyBtYWxmb3JtZWQgcG9saWN5IGZhaWxzIHRoZSBkZXBsb3ltZW50IGxvdWRseSBpbnN0ZWFkIG9mIGxhbmRpbmcgaW4gYVxuICAgICAgICAvLyBzaWxlbnQgYXN5bmMgQ1JFQVRFX0ZBSUxFRCBzdGF0ZS4gVGhlIGN1c3RvbS1yZXNvdXJjZSBMYW1iZGEgcG9sbHNcbiAgICAgICAgLy8gZWFjaCBwb2xpY3kgdG8gQUNUSVZFIGFuZCBmYWlscyBpZiB2YWxpZGF0aW9uIGRvZXMgbm90IHBhc3MuXG4gICAgICAgIFZhbGlkYXRpb25Nb2RlOiAnRkFJTF9PTl9BTllfRklORElOR1MnLFxuICAgICAgICBSZWdpb246IHRoaXMucmVnaW9uLFxuICAgICAgICBTdGF0ZW1lbnRzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgLy8gUG9saWN5IG5hbWVzIG11c3QgbWF0Y2ggXltBLVphLXpdW0EtWmEtejAtOV9dKiQgKG5vIGh5cGhlbnMpLlxuICAgICAgICAgICAgTmFtZTogJ2FsbG93X2JpbGxpbmdfcHJpY2luZ19hbGxfdXNlcnMnLFxuICAgICAgICAgICAgRGVzY3JpcHRpb246ICdQZXJtaXQgYmlsbGluZyBhbmQgcHJpY2luZyB0b29scyBmb3IgZXZlcnkgYXV0aGVudGljYXRlZCB1c2VyLicsXG4gICAgICAgICAgICBTdGF0ZW1lbnQ6IGFsbFVzZXJzQ2VkYXIsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBOYW1lOiAnYWxsb3dfb3BzX2NhdGVnb3JpZXNfYWRtaW5fb25seScsXG4gICAgICAgICAgICBEZXNjcmlwdGlvbjogJ1Blcm1pdCBjbG91ZHdhdGNoLCBjbG91ZHRyYWlsLCBhbmQgaW52ZW50b3J5IHRvb2xzIG9ubHkgZm9yIHJvbGUgPT0gYWRtaW4uJyxcbiAgICAgICAgICAgIFN0YXRlbWVudDogYWRtaW5Pbmx5Q2VkYXIsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBQb2xpY2llcyBhcmUgdmFsaWRhdGVkIGFnYWluc3QgdGhlIENlZGFyIHNjaGVtYSBnZW5lcmF0ZWQgZnJvbSB0aGVcbiAgICAvLyBnYXRld2F5J3MgdG9vbHMsIHNvIHRoZXkgbXVzdCBiZSBjcmVhdGVkIGFmdGVyIHRoZSBnYXRld2F5IGFuZCBldmVyeVxuICAgIC8vIHRhcmdldCBleGlzdC5cbiAgICBwb2xpY3lFbmdpbmVQb2xpY2llcy5ub2RlLmFkZERlcGVuZGVuY3koZ2F0ZXdheSk7XG4gICAgcG9saWN5RW5naW5lUG9saWNpZXMubm9kZS5hZGREZXBlbmRlbmN5KGJpbGxpbmdUYXJnZXQpO1xuICAgIHBvbGljeUVuZ2luZVBvbGljaWVzLm5vZGUuYWRkRGVwZW5kZW5jeShwcmljaW5nVGFyZ2V0KTtcbiAgICBwb2xpY3lFbmdpbmVQb2xpY2llcy5ub2RlLmFkZERlcGVuZGVuY3koY2xvdWR3YXRjaE1jcFRhcmdldCk7XG4gICAgcG9saWN5RW5naW5lUG9saWNpZXMubm9kZS5hZGREZXBlbmRlbmN5KGNsb3VkdHJhaWxNY3BUYXJnZXQpO1xuICAgIHBvbGljeUVuZ2luZVBvbGljaWVzLm5vZGUuYWRkRGVwZW5kZW5jeShpbnZlbnRvcnlNY3BUYXJnZXQpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnR2F0ZXdheUFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmdhdGV3YXlBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FnZW50Q29yZSBHYXRld2F5IEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tR2F0ZXdheUFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnR2F0ZXdheVVybCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmdhdGV3YXlVcmwsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FnZW50Q29yZSBHYXRld2F5IFVSTCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tR2F0ZXdheVVybGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUG9saWN5RW5naW5lQXJuJywge1xuICAgICAgdmFsdWU6IHBvbGljeUVuZ2luZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQWdlbnRDb3JlIFBvbGljeSBFbmdpbmUgQVJOIChDZWRhciByb2xlLWJhc2VkIHRvb2wgYXV0aG9yaXphdGlvbiknLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVBvbGljeUVuZ2luZUFybmAsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ0RLLU5hZyBTdXBwcmVzc2lvbnNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoZ2F0ZXdheVJvbGUsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ1dpbGRjYXJkIGZvciBBZ2VudENvcmUgSWRlbnRpdHkgdG9rZW4gZXhjaGFuZ2UgYW5kIE9BdXRoIHByb3ZpZGVyIG1hbmFnZW1lbnQuJyB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKG9hdXRoUHJvdmlkZXJGbiwgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JywgcmVhc29uOiAnV2lsZGNhcmQgcmVxdWlyZWQgZm9yIEFnZW50Q29yZSBJZGVudGl0eSB0b2tlbiB2YXVsdCBjcmVhdGlvbiBhbmQgYmVkcm9jay1hZ2VudGNvcmUtaWRlbnRpdHkgc2VjcmV0cyBuYW1lc3BhY2UuJyB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKHBvbGljeUVuZ2luZUZuLCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLCByZWFzb246ICdXaWxkY2FyZCByZXF1aXJlZCBmb3IgQWdlbnRDb3JlIFBvbGljeSBlbmdpbmUvcG9saWN5IG1hbmFnZW1lbnQgKENyZWF0ZVBvbGljeUVuZ2luZS9DcmVhdGVQb2xpY3kgb3BlcmF0ZSBvbiByZXNvdXJjZXMgY3JlYXRlZCBhdCBkZXBsb3kgdGltZSkuJyB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNCcsIHJlYXNvbjogJ0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZSBpcyBBV1MgYmVzdCBwcmFjdGljZS4nLCBhcHBsaWVzVG86IFsnUG9saWN5Ojphcm46PEFXUzo6UGFydGl0aW9uPjppYW06OmF3czpwb2xpY3kvc2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZSddIH0sXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLCByZWFzb246ICdXaWxkY2FyZCBmb3IgQWdlbnRDb3JlIElkZW50aXR5IHRva2VuIGV4Y2hhbmdlLCBPQXV0aCBjcmVkZW50aWFsIHByb3ZpZGVyIG1hbmFnZW1lbnQuJywgYXBwbGllc1RvOiBbJ1Jlc291cmNlOjoqJ10gfSxcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtTDEnLCByZWFzb246ICdMYW1iZGEgcnVudGltZSB2ZXJzaW9uIG1hbmFnZWQgYnkgQ0RLLicgfSxcbiAgICBdKTtcbiAgfVxufVxuIl19