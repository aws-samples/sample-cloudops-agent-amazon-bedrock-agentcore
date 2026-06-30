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
        oauthProviderFn.addToRolePolicy(new iam.PolicyStatement({
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
        policyEngineFn.addToRolePolicy(new iam.PolicyStatement({
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2F0ZXdheS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImdhdGV3YXktc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHlEQUEyQztBQUMzQywrREFBaUQ7QUFDakQsMkRBQTZDO0FBQzdDLGlFQUFtRDtBQUVuRCwyQ0FBNkI7QUFDN0IscUNBQTBDO0FBc0IxQyxNQUFhLHFCQUFzQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBSWxELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBaUM7UUFDekUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsMkNBQTJDO1FBQzNDLHVDQUF1QztRQUN2QywyQ0FBMkM7UUFFM0MsTUFBTSxpQkFBaUIsR0FBRyxJQUFJLEVBQUUsQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDNUUsUUFBUSxFQUFFO2dCQUNSLE9BQU8sRUFBRSxnQ0FBZ0M7Z0JBQ3pDLE1BQU0sRUFBRSx3QkFBd0I7Z0JBQ2hDLFVBQVUsRUFBRTtvQkFDVixVQUFVLEVBQUUsS0FBSyxDQUFDLGNBQWM7b0JBQ2hDLFFBQVEsRUFBRSxLQUFLLENBQUMsZUFBZTtpQkFDaEM7Z0JBQ0Qsa0JBQWtCLEVBQUUsRUFBRSxDQUFDLGtCQUFrQixDQUFDLEVBQUUsQ0FBQyxtQkFBbUIsQ0FBQzthQUNsRTtZQUNELE1BQU0sRUFBRSxFQUFFLENBQUMsdUJBQXVCLENBQUMsY0FBYyxDQUFDO2dCQUNoRCxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7b0JBQ3RCLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7b0JBQ3hCLE9BQU8sRUFBRSxDQUFDLG9DQUFvQyxDQUFDO29CQUMvQyxTQUFTLEVBQUUsQ0FBQyxLQUFLLENBQUMsZUFBZSxDQUFDO2lCQUNuQyxDQUFD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RSxJQUFJLENBQUMsQ0FBQztRQUVULHlCQUFlLENBQUMsb0JBQW9CLENBQUMsSUFBSSxFQUFFO1lBQ3pDLEVBQUUsRUFBRSxFQUFFLG1CQUFtQixFQUFFLE1BQU0sRUFBRSxtREFBbUQsRUFBRSxTQUFTLEVBQUUsQ0FBQyx1RkFBdUYsQ0FBQyxFQUFFO1lBQzlMLEVBQUUsRUFBRSxFQUFFLG1CQUFtQixFQUFFLE1BQU0sRUFBRSx1RkFBdUYsRUFBRSxTQUFTLEVBQUUsQ0FBQyxhQUFhLENBQUMsRUFBRTtZQUN4SixFQUFFLEVBQUUsRUFBRSxpQkFBaUIsRUFBRSxNQUFNLEVBQUUsd0NBQXdDLEVBQUU7U0FDNUUsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBditCRCxzREF1K0JDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0ICogYXMgY3IgZnJvbSAnYXdzLWNkay1saWIvY3VzdG9tLXJlc291cmNlcyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBOYWdTdXBwcmVzc2lvbnMgfSBmcm9tICdjZGstbmFnJztcblxuZXhwb3J0IGludGVyZmFjZSBBZ2VudENvcmVHYXRld2F5U3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgLy8gTUNQIFJ1bnRpbWUgZW5kcG9pbnRzIGZyb20gTUNQUnVudGltZVN0YWNrXG4gIGJpbGxpbmdNY3BSdW50aW1lQXJuOiBzdHJpbmc7XG4gIGJpbGxpbmdNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcbiAgcHJpY2luZ01jcFJ1bnRpbWVBcm46IHN0cmluZztcbiAgcHJpY2luZ01jcFJ1bnRpbWVFbmRwb2ludDogc3RyaW5nO1xuICBjbG91ZHdhdGNoTWNwUnVudGltZUFybjogc3RyaW5nO1xuICBjbG91ZHdhdGNoTWNwUnVudGltZUVuZHBvaW50OiBzdHJpbmc7XG4gIGNsb3VkdHJhaWxNY3BSdW50aW1lQXJuOiBzdHJpbmc7XG4gIGNsb3VkdHJhaWxNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcbiAgaW52ZW50b3J5TWNwUnVudGltZUFybjogc3RyaW5nO1xuICBpbnZlbnRvcnlNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcbiAgLy8gQXV0aFN0YWNrIENvZ25pdG8gLSB1c2VkIGZvciBPQXV0aCBwcm92aWRlciAob3V0Ym91bmQgYXV0aCB0byBydW50aW1lcylcbiAgYXV0aFVzZXJQb29sSWQ6IHN0cmluZztcbiAgYXV0aFVzZXJQb29sQXJuOiBzdHJpbmc7XG4gIGF1dGhNMm1DbGllbnRJZDogc3RyaW5nO1xuICAvLyBGcm9udEVuZCBVc2VyIFBvb2wgY2xpZW50IElEIC0gYWxsb3dlZCBhdWRpZW5jZSBmb3IgaW5ib3VuZCBDVVNUT01fSldUIGF1dGhvcml6YXRpb25cbiAgYXV0aFVzZXJQb29sQ2xpZW50SWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEFnZW50Q29yZUdhdGV3YXlTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBnYXRld2F5QXJuOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBnYXRld2F5VXJsOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFnZW50Q29yZUdhdGV3YXlTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gUmV0cmlldmUgQXV0aFN0YWNrIE0yTSBjbGllbnQgc2VjcmV0XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgZGVzY3JpYmVNMk1DbGllbnQgPSBuZXcgY3IuQXdzQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0Rlc2NyaWJlTTJNQ2xpZW50Jywge1xuICAgICAgb25DcmVhdGU6IHtcbiAgICAgICAgc2VydmljZTogJ0NvZ25pdG9JZGVudGl0eVNlcnZpY2VQcm92aWRlcicsXG4gICAgICAgIGFjdGlvbjogJ2Rlc2NyaWJlVXNlclBvb2xDbGllbnQnLFxuICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgVXNlclBvb2xJZDogcHJvcHMuYXV0aFVzZXJQb29sSWQsXG4gICAgICAgICAgQ2xpZW50SWQ6IHByb3BzLmF1dGhNMm1DbGllbnRJZCxcbiAgICAgICAgfSxcbiAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoJ20ybS1jbGllbnQtc2VjcmV0JyksXG4gICAgICB9LFxuICAgICAgcG9saWN5OiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5mcm9tU3RhdGVtZW50cyhbXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgYWN0aW9uczogWydjb2duaXRvLWlkcDpEZXNjcmliZVVzZXJQb29sQ2xpZW50J10sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbcHJvcHMuYXV0aFVzZXJQb29sQXJuXSxcbiAgICAgICAgfSksXG4gICAgICBdKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IG0ybUNsaWVudFNlY3JldCA9IGRlc2NyaWJlTTJNQ2xpZW50LmdldFJlc3BvbnNlRmllbGQoJ1VzZXJQb29sQ2xpZW50LkNsaWVudFNlY3JldCcpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEdhdGV3YXkgVG9rZW4gRXhjaGFuZ2UgUG9saWN5IChtYW5hZ2VkIHBvbGljeSwgd2lsZGNhcmQpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgdG9rZW5FeGNoYW5nZVBvbGljeSA9IG5ldyBpYW0uTWFuYWdlZFBvbGljeSh0aGlzLCAnR2F0ZXdheVRva2VuRXhjaGFuZ2VQb2xpY3knLCB7XG4gICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBzaWQ6ICdBZ2VudENvcmVJZGVudGl0eVRva2VuRXhjaGFuZ2UnLFxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0V29ya2xvYWRBY2Nlc3NUb2tlbicsXG4gICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0UmVzb3VyY2VPYXV0aDJUb2tlbicsXG4gICAgICAgICAgXSxcbiAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgICB9KSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gR2F0ZXdheSBTZXJ2aWNlIFJvbGVcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBjb25zdCBnYXRld2F5Um9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnR2F0ZXdheVNlcnZpY2VSb2xlJywge1xuICAgICAgZGVzY3JpcHRpb246ICdTZXJ2aWNlIHJvbGUgZm9yIENsb3VkT3BzIEFnZW50Q29yZSBHYXRld2F5JyxcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiZWRyb2NrLWFnZW50Y29yZS5hbWF6b25hd3MuY29tJyksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFt0b2tlbkV4Y2hhbmdlUG9saWN5XSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPQXV0aCBQcm92aWRlciAoTGFtYmRhIGN1c3RvbSByZXNvdXJjZSlcbiAgICAvLyBVc2VzIEF1dGhTdGFjaydzIENvZ25pdG8gZm9yIG91dGJvdW5kIGF1dGggdG8gTUNQIHJ1bnRpbWVzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3Qgb2F1dGhQcm92aWRlckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnT0F1dGhQcm92aWRlckZ1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTQsXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygyKSxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoYFxuaW1wb3J0IGpzb25cbmltcG9ydCBsb2dnaW5nXG5pbXBvcnQgb3NcbmltcG9ydCB1cmxsaWIucmVxdWVzdFxuaW1wb3J0IGJvdG8zXG5cbmxvZ2dlciA9IGxvZ2dpbmcuZ2V0TG9nZ2VyKClcbmxvZ2dlci5zZXRMZXZlbChsb2dnaW5nLklORk8pXG5cbmRlZiBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgc3RhdHVzLCBkYXRhPU5vbmUsIHJlYXNvbj1Ob25lLCBwaHlzaWNhbF9pZD1Ob25lKTpcbiAgICByZXNwb25zZV9ib2R5ID0ganNvbi5kdW1wcyh7XG4gICAgICAgICdTdGF0dXMnOiBzdGF0dXMsXG4gICAgICAgICdSZWFzb24nOiByZWFzb24gb3IgJ1NlZSBDbG91ZFdhdGNoIExvZ3MnLFxuICAgICAgICAnUGh5c2ljYWxSZXNvdXJjZUlkJzogcGh5c2ljYWxfaWQgb3IgZXZlbnQuZ2V0KCdQaHlzaWNhbFJlc291cmNlSWQnLCBldmVudFsnUmVxdWVzdElkJ10pLFxuICAgICAgICAnU3RhY2tJZCc6IGV2ZW50WydTdGFja0lkJ10sXG4gICAgICAgICdSZXF1ZXN0SWQnOiBldmVudFsnUmVxdWVzdElkJ10sXG4gICAgICAgICdMb2dpY2FsUmVzb3VyY2VJZCc6IGV2ZW50WydMb2dpY2FsUmVzb3VyY2VJZCddLFxuICAgICAgICAnRGF0YSc6IGRhdGEgb3Ige30sXG4gICAgfSlcbiAgICByZXNwb25zZV91cmwgPSBldmVudFsnUmVzcG9uc2VVUkwnXVxuICAgIGlmIG5vdCByZXNwb25zZV91cmwuc3RhcnRzd2l0aCgnaHR0cHM6Ly8nKTpcbiAgICAgICAgcmFpc2UgVmFsdWVFcnJvcihmJ0ludmFsaWQgcmVzcG9uc2UgVVJMIHNjaGVtZScpXG4gICAgcmVxID0gdXJsbGliLnJlcXVlc3QuUmVxdWVzdChcbiAgICAgICAgcmVzcG9uc2VfdXJsLFxuICAgICAgICBkYXRhPXJlc3BvbnNlX2JvZHkuZW5jb2RlKCd1dGYtOCcpLFxuICAgICAgICBoZWFkZXJzPXsnQ29udGVudC1UeXBlJzogJyd9LFxuICAgICAgICBtZXRob2Q9J1BVVCcsXG4gICAgKVxuICAgIHVybGxpYi5yZXF1ZXN0LnVybG9wZW4ocmVxKVxuXG5kZWYgaGFuZGxlcihldmVudCwgY29udGV4dCk6XG4gICAgbG9nZ2VyLmluZm8oZidFdmVudDoge2pzb24uZHVtcHMoZXZlbnQpfScpXG4gICAgcmVxdWVzdF90eXBlID0gZXZlbnRbJ1JlcXVlc3RUeXBlJ11cbiAgICBwcm9wcyA9IGV2ZW50WydSZXNvdXJjZVByb3BlcnRpZXMnXVxuICAgIHByb3ZpZGVyX25hbWUgPSBwcm9wcy5nZXQoJ1Byb3ZpZGVyTmFtZScsICcnKVxuICAgIHJlZ2lvbiA9IHByb3BzLmdldCgnUmVnaW9uJykgb3Igb3MuZW52aXJvbi5nZXQoJ0FXU19SRUdJT04nKVxuICAgIGNsaWVudCA9IGJvdG8zLmNsaWVudCgnYmVkcm9jay1hZ2VudGNvcmUtY29udHJvbCcsIHJlZ2lvbl9uYW1lPXJlZ2lvbilcblxuICAgIGlmIHJlcXVlc3RfdHlwZSA9PSAnRGVsZXRlJzpcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgY2xpZW50LmRlbGV0ZV9vYXV0aDJfY3JlZGVudGlhbF9wcm92aWRlcihuYW1lPXByb3ZpZGVyX25hbWUpXG4gICAgICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnKVxuICAgICAgICBleGNlcHQgRXhjZXB0aW9uOlxuICAgICAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdTVUNDRVNTJylcbiAgICAgICAgcmV0dXJuXG5cbiAgICB0cnk6XG4gICAgICAgIHJlc3BvbnNlID0gY2xpZW50LmNyZWF0ZV9vYXV0aDJfY3JlZGVudGlhbF9wcm92aWRlcihcbiAgICAgICAgICAgIG5hbWU9cHJvdmlkZXJfbmFtZSxcbiAgICAgICAgICAgIGNyZWRlbnRpYWxQcm92aWRlclZlbmRvcj0nQ3VzdG9tT2F1dGgyJyxcbiAgICAgICAgICAgIG9hdXRoMlByb3ZpZGVyQ29uZmlnSW5wdXQ9e1xuICAgICAgICAgICAgICAgICdjdXN0b21PYXV0aDJQcm92aWRlckNvbmZpZyc6IHtcbiAgICAgICAgICAgICAgICAgICAgJ29hdXRoRGlzY292ZXJ5Jzoge1xuICAgICAgICAgICAgICAgICAgICAgICAgJ2Rpc2NvdmVyeVVybCc6IHByb3BzLmdldCgnRGlzY292ZXJ5VXJsJywgJycpLFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAnY2xpZW50SWQnOiBwcm9wcy5nZXQoJ0NsaWVudElkJywgJycpLFxuICAgICAgICAgICAgICAgICAgICAnY2xpZW50U2VjcmV0JzogcHJvcHMuZ2V0KCdDbGllbnRTZWNyZXQnLCAnJyksXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIClcbiAgICAgICAgcHJvdmlkZXJfYXJuID0gcmVzcG9uc2UuZ2V0KCdjcmVkZW50aWFsUHJvdmlkZXJBcm4nLCAnJylcbiAgICAgICAgc2VjcmV0X2FybiA9IHJlc3BvbnNlLmdldCgnY2xpZW50U2VjcmV0QXJuJywge30pLmdldCgnc2VjcmV0QXJuJywgJycpXG4gICAgICAgIGxvZ2dlci5pbmZvKGYnQ3JlYXRlZCBwcm92aWRlcjoge3Byb3ZpZGVyX2Fybn0nKVxuICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnLCBkYXRhPXtcbiAgICAgICAgICAgICdQcm92aWRlckFybic6IHByb3ZpZGVyX2FybixcbiAgICAgICAgICAgICdTZWNyZXRBcm4nOiBzZWNyZXRfYXJuLFxuICAgICAgICB9LCBwaHlzaWNhbF9pZD1wcm92aWRlcl9uYW1lKVxuICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZTpcbiAgICAgICAgbG9nZ2VyLmVycm9yKGYnQ3JlYXRlIGZhaWxlZDoge2V9JylcbiAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdGQUlMRUQnLCByZWFzb249c3RyKGUpKVxuYCksXG4gICAgfSk7XG5cbiAgICBvYXV0aFByb3ZpZGVyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZU9hdXRoMkNyZWRlbnRpYWxQcm92aWRlcicsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpEZWxldGVPYXV0aDJDcmVkZW50aWFsUHJvdmlkZXInLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0T2F1dGgyQ3JlZGVudGlhbFByb3ZpZGVyJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZVRva2VuVmF1bHQnLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0VG9rZW5WYXVsdCcsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICBvYXV0aFByb3ZpZGVyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkNyZWF0ZVNlY3JldCcsXG4gICAgICAgICdzZWNyZXRzbWFuYWdlcjpEZWxldGVTZWNyZXQnLFxuICAgICAgICAnc2VjcmV0c21hbmFnZXI6UHV0U2VjcmV0VmFsdWUnLFxuICAgICAgICAnc2VjcmV0c21hbmFnZXI6VGFnUmVzb3VyY2UnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czpzZWNyZXRzbWFuYWdlcjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06c2VjcmV0OmJlZHJvY2stYWdlbnRjb3JlLWlkZW50aXR5KmAsXG4gICAgICBdLFxuICAgIH0pKTtcblxuICAgIGNvbnN0IG9hdXRoUHJvdmlkZXIgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdPQXV0aFByb3ZpZGVyJywge1xuICAgICAgc2VydmljZVRva2VuOiBvYXV0aFByb3ZpZGVyRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIFByb3ZpZGVyTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LW9hdXRoLXByb3ZpZGVyYCxcbiAgICAgICAgRGlzY292ZXJ5VXJsOiBgaHR0cHM6Ly9jb2duaXRvLWlkcC4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tLyR7cHJvcHMuYXV0aFVzZXJQb29sSWR9Ly53ZWxsLWtub3duL29wZW5pZC1jb25maWd1cmF0aW9uYCxcbiAgICAgICAgQ2xpZW50SWQ6IHByb3BzLmF1dGhNMm1DbGllbnRJZCxcbiAgICAgICAgQ2xpZW50U2VjcmV0OiBtMm1DbGllbnRTZWNyZXQsXG4gICAgICAgIFJlZ2lvbjogdGhpcy5yZWdpb24sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3Qgb2F1dGhQcm92aWRlckFybiA9IG9hdXRoUHJvdmlkZXIuZ2V0QXR0U3RyaW5nKCdQcm92aWRlckFybicpO1xuICAgIGNvbnN0IG9hdXRoU2VjcmV0QXJuID0gb2F1dGhQcm92aWRlci5nZXRBdHRTdHJpbmcoJ1NlY3JldEFybicpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIERlZmF1bHQgUG9saWN5IG9uIEdhdGV3YXkgUm9sZSAoc2NvcGVkIHRvIE9BdXRoIHByb3ZpZGVyIHJlc291cmNlcylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBnYXRld2F5Um9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRSZXNvdXJjZU9hdXRoMlRva2VuJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldFdvcmtsb2FkQWNjZXNzVG9rZW4nLFxuICAgICAgICAnc2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWUnLFxuICAgICAgICAnc2VjcmV0c21hbmFnZXI6RGVzY3JpYmVTZWNyZXQnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW29hdXRoUHJvdmlkZXJBcm4sIG9hdXRoU2VjcmV0QXJuXSxcbiAgICB9KSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQWdlbnRDb3JlIFBvbGljeSBFbmdpbmUgKExhbWJkYSBjdXN0b20gcmVzb3VyY2UpXG4gICAgLy9cbiAgICAvLyBUaGUgaW5zdGFsbGVkIENESyBhbHBoYSBtb2R1bGUgKEBhd3MtY2RrL2F3cy1iZWRyb2NrLWFnZW50Y29yZS1hbHBoYVxuICAgIC8vIDIuMjM1LngpIGRvZXMgTk9UIHlldCBzaGlwIHRoZSBQb2xpY3kgc3VibW9kdWxlIChQb2xpY3lFbmdpbmUgLyBQb2xpY3kgL1xuICAgIC8vIFBvbGljeVN0YXRlbWVudCkg4oCUIHRob3NlIGNvbnN0cnVjdHMgd2VyZSBhZGRlZCBpbiBhIGxhdGVyIGFscGhhIHJlbGVhc2UuXG4gICAgLy8gVGhlcmUgaXMgYWxzbyBubyBmaXJzdC1jbGFzcyBMMSBmb3IgdGhlIGVuZ2luZS9wb2xpY2llcyAob25seSB0aGVcbiAgICAvLyBnYXRld2F5LXNpZGUgYFBvbGljeUVuZ2luZUNvbmZpZ3VyYXRpb25gIGV4aXN0cykuIFdlIHRoZXJlZm9yZSBjcmVhdGUgdGhlXG4gICAgLy8gZW5naW5lIGFuZCBpdHMgQ2VkYXIgcG9saWNpZXMgdmlhIHRoZSBgYmVkcm9jay1hZ2VudGNvcmUtY29udHJvbGAgY29udHJvbFxuICAgIC8vIHBsYW5lIGJlaGluZCBhIENESyBjdXN0b20gcmVzb3VyY2UsIG1pcnJvcmluZyB0aGUgT0F1dGhQcm92aWRlciBwYXR0ZXJuXG4gICAgLy8gYWJvdmUuXG4gICAgLy9cbiAgICAvLyBGbG93OlxuICAgIC8vICAgMS4gUG9saWN5RW5naW5lIGN1c3RvbSByZXNvdXJjZSAgLT4gY3JlYXRlX3BvbGljeV9lbmdpbmUsIHdhaXQgQUNUSVZFLFxuICAgIC8vICAgICAgcmV0dXJucyB0aGUgZW5naW5lIEFSTi9JRC5cbiAgICAvLyAgIDIuIEdhdGV3YXkgY2FycmllcyBQb2xpY3lFbmdpbmVDb25maWd1cmF0aW9uLkFybiA9IGVuZ2luZSBBUk4gc28gdGhlXG4gICAgLy8gICAgICBlbmdpbmUgaXMgYXNzb2NpYXRlZCB3aXRoIHRoZSBnYXRld2F5IChNb2RlID0gRU5GT1JDRSkuXG4gICAgLy8gICAzLiBQb2xpY3lFbmdpbmVQb2xpY2llcyBjdXN0b20gcmVzb3VyY2UgLT4gY3JlYXRlX3BvbGljeSBmb3IgZWFjaCBDZWRhclxuICAgIC8vICAgICAgc3RhdGVtZW50LiBJdCBkZXBlbmRzIG9uIHRoZSBnYXRld2F5ICsgYWxsIHRhcmdldHMgc28gdGhlIENlZGFyXG4gICAgLy8gICAgICBzY2hlbWEgKGdlbmVyYXRlZCBmcm9tIHRoZSB0YXJnZXRzJyB0b29sIGlucHV0IHNjaGVtYXMpIGV4aXN0cyB3aGVuXG4gICAgLy8gICAgICB0aGUgcG9saWNpZXMgYXJlIHZhbGlkYXRlZC5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBjb25zdCBwb2xpY3lFbmdpbmVGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1BvbGljeUVuZ2luZUZ1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTQsXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygxMCksXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbmltcG9ydCBqc29uXG5pbXBvcnQgbG9nZ2luZ1xuaW1wb3J0IG9zXG5pbXBvcnQgcmVcbmltcG9ydCB0aW1lXG5pbXBvcnQgdXJsbGliLnJlcXVlc3RcbmltcG9ydCBib3RvM1xuZnJvbSBib3RvY29yZS5leGNlcHRpb25zIGltcG9ydCBDbGllbnRFcnJvclxuXG5sb2dnZXIgPSBsb2dnaW5nLmdldExvZ2dlcigpXG5sb2dnZXIuc2V0TGV2ZWwobG9nZ2luZy5JTkZPKVxuXG5cbmRlZiBfY2xpZW50X3Rva2VuKHZhbHVlKTpcbiAgICAjIGNsaWVudFRva2VuIG11c3QgbWF0Y2ggXlthLXpBLVowLTldKC0qW2EtekEtWjAtOV0pezAsMjU2fSQg4oCUIG5vXG4gICAgIyB1bmRlcnNjb3Jlcy4gUmVkdWNlIHRvIGFscGhhbnVtZXJpY3Mgb25seSAoYWx3YXlzIHZhbGlkKSBhbmQgY2FwIGxlbmd0aC5cbiAgICB0b2tlbiA9IHJlLnN1YihyJ1teYS16QS1aMC05XScsICcnLCB2YWx1ZSlcbiAgICByZXR1cm4gdG9rZW5bOjI1Nl0gb3IgJ3Rva2VuJ1xuXG5cbmRlZiBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgc3RhdHVzLCBkYXRhPU5vbmUsIHJlYXNvbj1Ob25lLCBwaHlzaWNhbF9pZD1Ob25lKTpcbiAgICByZXNwb25zZV9ib2R5ID0ganNvbi5kdW1wcyh7XG4gICAgICAgICdTdGF0dXMnOiBzdGF0dXMsXG4gICAgICAgICdSZWFzb24nOiByZWFzb24gb3IgJ1NlZSBDbG91ZFdhdGNoIExvZ3MnLFxuICAgICAgICAnUGh5c2ljYWxSZXNvdXJjZUlkJzogcGh5c2ljYWxfaWQgb3IgZXZlbnQuZ2V0KCdQaHlzaWNhbFJlc291cmNlSWQnLCBldmVudFsnUmVxdWVzdElkJ10pLFxuICAgICAgICAnU3RhY2tJZCc6IGV2ZW50WydTdGFja0lkJ10sXG4gICAgICAgICdSZXF1ZXN0SWQnOiBldmVudFsnUmVxdWVzdElkJ10sXG4gICAgICAgICdMb2dpY2FsUmVzb3VyY2VJZCc6IGV2ZW50WydMb2dpY2FsUmVzb3VyY2VJZCddLFxuICAgICAgICAnRGF0YSc6IGRhdGEgb3Ige30sXG4gICAgfSlcbiAgICByZXNwb25zZV91cmwgPSBldmVudFsnUmVzcG9uc2VVUkwnXVxuICAgIGlmIG5vdCByZXNwb25zZV91cmwuc3RhcnRzd2l0aCgnaHR0cHM6Ly8nKTpcbiAgICAgICAgcmFpc2UgVmFsdWVFcnJvcignSW52YWxpZCByZXNwb25zZSBVUkwgc2NoZW1lJylcbiAgICByZXEgPSB1cmxsaWIucmVxdWVzdC5SZXF1ZXN0KFxuICAgICAgICByZXNwb25zZV91cmwsXG4gICAgICAgIGRhdGE9cmVzcG9uc2VfYm9keS5lbmNvZGUoJ3V0Zi04JyksXG4gICAgICAgIGhlYWRlcnM9eydDb250ZW50LVR5cGUnOiAnJ30sXG4gICAgICAgIG1ldGhvZD0nUFVUJyxcbiAgICApXG4gICAgdXJsbGliLnJlcXVlc3QudXJsb3BlbihyZXEpXG5cblxuZGVmIF9pc19jb25mbGljdChlcnIpOlxuICAgIGNvZGUgPSBlcnIucmVzcG9uc2UuZ2V0KCdFcnJvcicsIHt9KS5nZXQoJ0NvZGUnLCAnJykgaWYgaXNpbnN0YW5jZShlcnIsIENsaWVudEVycm9yKSBlbHNlICcnXG4gICAgcmV0dXJuICdDb25mbGljdCcgaW4gY29kZSBvciAnQWxyZWFkeUV4aXN0cycgaW4gY29kZVxuXG5cbmRlZiBfZmluZF9lbmdpbmVfYnlfbmFtZShjbGllbnQsIG5hbWUpOlxuICAgIHRyeTpcbiAgICAgICAgdG9rZW4gPSBOb25lXG4gICAgICAgIHdoaWxlIFRydWU6XG4gICAgICAgICAgICBrd2FyZ3MgPSB7J25leHRUb2tlbic6IHRva2VufSBpZiB0b2tlbiBlbHNlIHt9XG4gICAgICAgICAgICByZXNwID0gY2xpZW50Lmxpc3RfcG9saWN5X2VuZ2luZXMoKiprd2FyZ3MpXG4gICAgICAgICAgICBmb3IgaXRlbSBpbiByZXNwLmdldCgncG9saWN5RW5naW5lcycsIFtdKSBvciByZXNwLmdldCgnaXRlbXMnLCBbXSk6XG4gICAgICAgICAgICAgICAgaWYgaXRlbS5nZXQoJ25hbWUnKSA9PSBuYW1lOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gaXRlbVxuICAgICAgICAgICAgdG9rZW4gPSByZXNwLmdldCgnbmV4dFRva2VuJylcbiAgICAgICAgICAgIGlmIG5vdCB0b2tlbjpcbiAgICAgICAgICAgICAgICBicmVha1xuICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXg6XG4gICAgICAgIGxvZ2dlci53YXJuaW5nKGYnbGlzdF9wb2xpY3lfZW5naW5lcyBmYWlsZWQ6IHtleH0nKVxuICAgIHJldHVybiBOb25lXG5cblxuZGVmIF9lbmdpbmVfaWQoaXRlbSk6XG4gICAgcmV0dXJuIGl0ZW0uZ2V0KCdwb2xpY3lFbmdpbmVJZCcpIG9yIGl0ZW0uZ2V0KCdpZCcpXG5cblxuZGVmIF93YWl0X2VuZ2luZV9hY3RpdmUoY2xpZW50LCBlbmdpbmVfaWQsIHRpbWVvdXRfcz00ODApOlxuICAgIGRlYWRsaW5lID0gdGltZS50aW1lKCkgKyB0aW1lb3V0X3NcbiAgICB3aGlsZSB0aW1lLnRpbWUoKSA8IGRlYWRsaW5lOlxuICAgICAgICByZXNwID0gY2xpZW50LmdldF9wb2xpY3lfZW5naW5lKHBvbGljeUVuZ2luZUlkPWVuZ2luZV9pZClcbiAgICAgICAgc3RhdHVzID0gcmVzcC5nZXQoJ3N0YXR1cycpXG4gICAgICAgIGxvZ2dlci5pbmZvKGYnZW5naW5lIHtlbmdpbmVfaWR9IHN0YXR1cz17c3RhdHVzfScpXG4gICAgICAgIGlmIHN0YXR1cyA9PSAnQUNUSVZFJzpcbiAgICAgICAgICAgIHJldHVybiByZXNwXG4gICAgICAgIGlmIHN0YXR1cyBhbmQgc3RhdHVzLmVuZHN3aXRoKCdGQUlMRUQnKTpcbiAgICAgICAgICAgIHJhaXNlIFJ1bnRpbWVFcnJvcihmJ2VuZ2luZSB7ZW5naW5lX2lkfSB7c3RhdHVzfToge3Jlc3AuZ2V0KFwic3RhdHVzUmVhc29uc1wiKX0nKVxuICAgICAgICB0aW1lLnNsZWVwKDUpXG4gICAgcmFpc2UgVGltZW91dEVycm9yKGYnZW5naW5lIHtlbmdpbmVfaWR9IG5vdCBBQ1RJVkUgd2l0aGluIHt0aW1lb3V0X3N9cycpXG5cblxuZGVmIF9saXN0X3BvbGljeV9pZHMoY2xpZW50LCBlbmdpbmVfaWQpOlxuICAgIGlkcyA9IFtdXG4gICAgdG9rZW4gPSBOb25lXG4gICAgd2hpbGUgVHJ1ZTpcbiAgICAgICAga3dhcmdzID0geydwb2xpY3lFbmdpbmVJZCc6IGVuZ2luZV9pZH1cbiAgICAgICAgaWYgdG9rZW46XG4gICAgICAgICAgICBrd2FyZ3NbJ25leHRUb2tlbiddID0gdG9rZW5cbiAgICAgICAgcmVzcCA9IGNsaWVudC5saXN0X3BvbGljaWVzKCoqa3dhcmdzKVxuICAgICAgICBmb3IgaXRlbSBpbiByZXNwLmdldCgncG9saWNpZXMnLCBbXSkgb3IgcmVzcC5nZXQoJ2l0ZW1zJywgW10pOlxuICAgICAgICAgICAgcGlkID0gaXRlbS5nZXQoJ3BvbGljeUlkJykgb3IgaXRlbS5nZXQoJ2lkJylcbiAgICAgICAgICAgIGlmIHBpZDpcbiAgICAgICAgICAgICAgICBpZHMuYXBwZW5kKHBpZClcbiAgICAgICAgdG9rZW4gPSByZXNwLmdldCgnbmV4dFRva2VuJylcbiAgICAgICAgaWYgbm90IHRva2VuOlxuICAgICAgICAgICAgYnJlYWtcbiAgICByZXR1cm4gaWRzXG5cblxuZGVmIF9kZWxldGVfcG9saWNpZXMoY2xpZW50LCBlbmdpbmVfaWQsIHRpbWVvdXRfcz0xMjApOlxuICAgICMgZGVsZXRlX3BvbGljeSBpcyBhc3luY2hyb25vdXMsIHNvIGlzc3VlIGRlbGV0ZXMgZm9yIGV2ZXJ5IGV4aXN0aW5nIHBvbGljeVxuICAgICMgYW5kIHRoZW4gV0FJVCB1bnRpbCB0aGV5IGFyZSBhbGwgYWN0dWFsbHkgZ29uZS4gUmVjcmVhdGluZyBhIHBvbGljeSB3aXRoXG4gICAgIyB0aGUgc2FtZSBuYW1lIHdoaWxlIGEgcHJpb3Igb25lIGlzIHN0aWxsIERFTEVUSU5HIHJhaXNlcyBhIGNvbmZsaWN0LlxuICAgIHRyeTpcbiAgICAgICAgZm9yIHBpZCBpbiBfbGlzdF9wb2xpY3lfaWRzKGNsaWVudCwgZW5naW5lX2lkKTpcbiAgICAgICAgICAgIHRyeTpcbiAgICAgICAgICAgICAgICBjbGllbnQuZGVsZXRlX3BvbGljeShwb2xpY3lFbmdpbmVJZD1lbmdpbmVfaWQsIHBvbGljeUlkPXBpZClcbiAgICAgICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXg6XG4gICAgICAgICAgICAgICAgbG9nZ2VyLndhcm5pbmcoZidkZWxldGVfcG9saWN5IHtwaWR9IGZhaWxlZDoge2V4fScpXG4gICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleDpcbiAgICAgICAgbG9nZ2VyLndhcm5pbmcoZidsaXN0X3BvbGljaWVzIGZhaWxlZCBkdXJpbmcgZGVsZXRlOiB7ZXh9JylcbiAgICAgICAgcmV0dXJuXG5cbiAgICBkZWFkbGluZSA9IHRpbWUudGltZSgpICsgdGltZW91dF9zXG4gICAgd2hpbGUgdGltZS50aW1lKCkgPCBkZWFkbGluZTpcbiAgICAgICAgdHJ5OlxuICAgICAgICAgICAgcmVtYWluaW5nID0gX2xpc3RfcG9saWN5X2lkcyhjbGllbnQsIGVuZ2luZV9pZClcbiAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBleDpcbiAgICAgICAgICAgIGxvZ2dlci53YXJuaW5nKGYnbGlzdF9wb2xpY2llcyBmYWlsZWQgd2hpbGUgd2FpdGluZyBmb3IgZGVsZXRlOiB7ZXh9JylcbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICBpZiBub3QgcmVtYWluaW5nOlxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgIGxvZ2dlci5pbmZvKGYnd2FpdGluZyBmb3Ige2xlbihyZW1haW5pbmcpfSBwb2xpY2llcyB0byBmaW5pc2ggZGVsZXRpbmcnKVxuICAgICAgICB0aW1lLnNsZWVwKDQpXG4gICAgbG9nZ2VyLndhcm5pbmcoJ3RpbWVkIG91dCB3YWl0aW5nIGZvciBwb2xpY3kgZGVsZXRpb25zIHRvIGNvbXBsZXRlJylcblxuXG5kZWYgaGFuZGxlX2VuZ2luZShldmVudCwgY2xpZW50KTpcbiAgICBwcm9wcyA9IGV2ZW50WydSZXNvdXJjZVByb3BlcnRpZXMnXVxuICAgIG5hbWUgPSBwcm9wc1snRW5naW5lTmFtZSddXG4gICAgcmVxdWVzdF90eXBlID0gZXZlbnRbJ1JlcXVlc3RUeXBlJ11cblxuICAgIGlmIHJlcXVlc3RfdHlwZSA9PSAnRGVsZXRlJzpcbiAgICAgICAgZXhpc3RpbmcgPSBfZmluZF9lbmdpbmVfYnlfbmFtZShjbGllbnQsIG5hbWUpXG4gICAgICAgIGlmIGV4aXN0aW5nOlxuICAgICAgICAgICAgZWlkID0gX2VuZ2luZV9pZChleGlzdGluZylcbiAgICAgICAgICAgIF9kZWxldGVfcG9saWNpZXMoY2xpZW50LCBlaWQpXG4gICAgICAgICAgICB0cnk6XG4gICAgICAgICAgICAgICAgY2xpZW50LmRlbGV0ZV9wb2xpY3lfZW5naW5lKHBvbGljeUVuZ2luZUlkPWVpZClcbiAgICAgICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXg6XG4gICAgICAgICAgICAgICAgbG9nZ2VyLndhcm5pbmcoZidkZWxldGVfcG9saWN5X2VuZ2luZSBmYWlsZWQ6IHtleH0nKVxuICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnKVxuICAgICAgICByZXR1cm5cblxuICAgICMgQ3JlYXRlIC8gVXBkYXRlIChlbmdpbmUgbmFtZSBpcyBpbW11dGFibGUgLT4gcmV1c2UgaWYgaXQgYWxyZWFkeSBleGlzdHMpXG4gICAgIyBUaGUgY2xpZW50VG9rZW4gaXMgbWFkZSB1bmlxdWUgcGVyIENsb3VkRm9ybWF0aW9uIHJlcXVlc3QgKFJlcXVlc3RJZCkgc28gYVxuICAgICMgbGF0ZXIgc3RhY2sgcmVjcmVhdGlvbiBkb2VzIG5vdCBjb2xsaWRlIHdpdGggdGhlIGlkZW1wb3RlbmN5IHJlY29yZCBvZiBhXG4gICAgIyBwcmlvciAobm93LWRlbGV0ZWQpIGVuZ2luZSwgd2hpbGUgc3RpbGwgYmVpbmcgc3RhYmxlIGFjcm9zcyB0aGUgU0RLJ3Mgb3duXG4gICAgIyByZXRyaWVzIHdpdGhpbiBhIHNpbmdsZSBjcmVhdGUgY2FsbC5cbiAgICBlbmdpbmVfaWQgPSBOb25lXG4gICAgdHJ5OlxuICAgICAgICByZXNwID0gY2xpZW50LmNyZWF0ZV9wb2xpY3lfZW5naW5lKFxuICAgICAgICAgICAgbmFtZT1uYW1lLFxuICAgICAgICAgICAgZGVzY3JpcHRpb249cHJvcHMuZ2V0KCdEZXNjcmlwdGlvbicsICdDbG91ZE9wcyByb2xlLWJhc2VkIHRvb2wgYXV0aG9yaXphdGlvbiBlbmdpbmUnKSxcbiAgICAgICAgICAgIGNsaWVudFRva2VuPV9jbGllbnRfdG9rZW4obmFtZSArIGV2ZW50LmdldCgnUmVxdWVzdElkJywgJycpKSxcbiAgICAgICAgKVxuICAgICAgICBlbmdpbmVfaWQgPSByZXNwWydwb2xpY3lFbmdpbmVJZCddXG4gICAgZXhjZXB0IENsaWVudEVycm9yIGFzIGVycjpcbiAgICAgICAgaWYgX2lzX2NvbmZsaWN0KGVycik6XG4gICAgICAgICAgICBleGlzdGluZyA9IF9maW5kX2VuZ2luZV9ieV9uYW1lKGNsaWVudCwgbmFtZSlcbiAgICAgICAgICAgIGlmIG5vdCBleGlzdGluZzpcbiAgICAgICAgICAgICAgICByYWlzZVxuICAgICAgICAgICAgZW5naW5lX2lkID0gX2VuZ2luZV9pZChleGlzdGluZylcbiAgICAgICAgZWxzZTpcbiAgICAgICAgICAgIHJhaXNlXG5cbiAgICBfd2FpdF9lbmdpbmVfYWN0aXZlKGNsaWVudCwgZW5naW5lX2lkKVxuICAgIGVuZ2luZSA9IGNsaWVudC5nZXRfcG9saWN5X2VuZ2luZShwb2xpY3lFbmdpbmVJZD1lbmdpbmVfaWQpXG4gICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdTVUNDRVNTJywgZGF0YT17XG4gICAgICAgICdQb2xpY3lFbmdpbmVJZCc6IGVuZ2luZV9pZCxcbiAgICAgICAgJ1BvbGljeUVuZ2luZUFybic6IGVuZ2luZS5nZXQoJ3BvbGljeUVuZ2luZUFybicsICcnKSxcbiAgICB9LCBwaHlzaWNhbF9pZD1lbmdpbmVfaWQpXG5cblxuZGVmIF93YWl0X3BvbGljeV9hY3RpdmUoY2xpZW50LCBlbmdpbmVfaWQsIHBvbGljeV9pZCwgdGltZW91dF9zPTE4MCk6XG4gICAgIyBQb2xpY3kgY3JlYXRpb24gaXMgYXN5bmNocm9ub3VzOiBjcmVhdGVfcG9saWN5IHJldHVybnMgQ1JFQVRJTkcgYW5kIHRoZVxuICAgICMgQ2VkYXIgYW5hbHl6ZXIgdmFsaWRhdGVzIHRoZSBzdGF0ZW1lbnQgYWdhaW5zdCB0aGUgZ2F0ZXdheSdzIGdlbmVyYXRlZFxuICAgICMgc2NoZW1hIGFmdGVyd2FyZHMuIFBvbGwgdW50aWwgQUNUSVZFLCBhbmQgcmFpc2UgKGZhaWxpbmcgdGhlIGN1c3RvbVxuICAgICMgcmVzb3VyY2UpIG9uIENSRUFURV9GQUlMRUQgc28gYSBiYWQgcG9saWN5IGNhbiBuZXZlciBiZSBzaWxlbnRseSBhY2NlcHRlZC5cbiAgICBkZWFkbGluZSA9IHRpbWUudGltZSgpICsgdGltZW91dF9zXG4gICAgd2hpbGUgdGltZS50aW1lKCkgPCBkZWFkbGluZTpcbiAgICAgICAgcmVzcCA9IGNsaWVudC5nZXRfcG9saWN5KHBvbGljeUVuZ2luZUlkPWVuZ2luZV9pZCwgcG9saWN5SWQ9cG9saWN5X2lkKVxuICAgICAgICBzdGF0dXMgPSByZXNwLmdldCgnc3RhdHVzJylcbiAgICAgICAgbG9nZ2VyLmluZm8oZidwb2xpY3kge3BvbGljeV9pZH0gc3RhdHVzPXtzdGF0dXN9JylcbiAgICAgICAgaWYgc3RhdHVzID09ICdBQ1RJVkUnOlxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgIGlmIHN0YXR1cyBhbmQgJ0ZBSUxFRCcgaW4gc3RhdHVzOlxuICAgICAgICAgICAgcmFpc2UgUnVudGltZUVycm9yKFxuICAgICAgICAgICAgICAgIGYncG9saWN5IHtwb2xpY3lfaWR9IHtzdGF0dXN9OiB7cmVzcC5nZXQoXCJzdGF0dXNSZWFzb25zXCIpfSdcbiAgICAgICAgICAgIClcbiAgICAgICAgdGltZS5zbGVlcCg0KVxuICAgIHJhaXNlIFRpbWVvdXRFcnJvcihmJ3BvbGljeSB7cG9saWN5X2lkfSBub3QgQUNUSVZFIHdpdGhpbiB7dGltZW91dF9zfXMnKVxuXG5cbmRlZiBoYW5kbGVfcG9saWNpZXMoZXZlbnQsIGNsaWVudCk6XG4gICAgcHJvcHMgPSBldmVudFsnUmVzb3VyY2VQcm9wZXJ0aWVzJ11cbiAgICBlbmdpbmVfaWQgPSBwcm9wc1snUG9saWN5RW5naW5lSWQnXVxuICAgIHN0YXRlbWVudHMgPSBwcm9wcy5nZXQoJ1N0YXRlbWVudHMnLCBbXSlcbiAgICB2YWxpZGF0aW9uX21vZGUgPSBwcm9wcy5nZXQoJ1ZhbGlkYXRpb25Nb2RlJywgJ0ZBSUxfT05fQU5ZX0ZJTkRJTkdTJylcbiAgICByZXF1ZXN0X3R5cGUgPSBldmVudFsnUmVxdWVzdFR5cGUnXVxuXG4gICAgaWYgcmVxdWVzdF90eXBlID09ICdEZWxldGUnOlxuICAgICAgICBfZGVsZXRlX3BvbGljaWVzKGNsaWVudCwgZW5naW5lX2lkKVxuICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnKVxuICAgICAgICByZXR1cm5cblxuICAgICMgUmVjb25jaWxlOiByZW1vdmUgYW55IGV4aXN0aW5nIHBvbGljaWVzIGZpcnN0IHNvIENyZWF0ZSBBTkQgVXBkYXRlIGJvdGhcbiAgICAjIGNvbnZlcmdlIHRvIGV4YWN0bHkgdGhlIGRlc2lyZWQgc3RhdGVtZW50IHNldCAoYW5kIGNsZWFuIHVwIGFueSBwcmlvclxuICAgICMgZmFpbGVkL3Byb2JlIHBvbGljaWVzKSB3aXRob3V0IG5hbWUtY29uZmxpY3QgZXJyb3JzLlxuICAgIF9kZWxldGVfcG9saWNpZXMoY2xpZW50LCBlbmdpbmVfaWQpXG5cbiAgICBjcmVhdGVkID0gW11cbiAgICBmb3Igc3RtdCBpbiBzdGF0ZW1lbnRzOlxuICAgICAgICBwbmFtZSA9IHN0bXRbJ05hbWUnXVxuICAgICAgICByZXNwID0gY2xpZW50LmNyZWF0ZV9wb2xpY3koXG4gICAgICAgICAgICBwb2xpY3lFbmdpbmVJZD1lbmdpbmVfaWQsXG4gICAgICAgICAgICBuYW1lPXBuYW1lLFxuICAgICAgICAgICAgZGVzY3JpcHRpb249c3RtdC5nZXQoJ0Rlc2NyaXB0aW9uJywgJycpLFxuICAgICAgICAgICAgdmFsaWRhdGlvbk1vZGU9dmFsaWRhdGlvbl9tb2RlLFxuICAgICAgICAgICAgIyBlbmZvcmNlbWVudE1vZGUgaXMgb21pdHRlZDogaXQgaXMgbm90IHByZXNlbnQgaW4gdGhlIExhbWJkYVxuICAgICAgICAgICAgIyBydW50aW1lJ3MgYnVuZGxlZCBib3RvMyBtb2RlbCBmb3IgY3JlYXRlX3BvbGljeSBhbmQgZGVmYXVsdHNcbiAgICAgICAgICAgICMgdG8gQUNUSVZFIHNlcnZpY2Utc2lkZSAod2hpY2ggaXMgdGhlIGVuZm9yY2luZyBiZWhhdmlvciB3ZVxuICAgICAgICAgICAgIyB3YW50OyB0aGUgZ2F0ZXdheSBQb2xpY3lFbmdpbmVDb25maWd1cmF0aW9uIGlzIGFsc28gRU5GT1JDRSkuXG4gICAgICAgICAgICBkZWZpbml0aW9uPXsnY2VkYXInOiB7J3N0YXRlbWVudCc6IHN0bXRbJ1N0YXRlbWVudCddfX0sXG4gICAgICAgICAgICBjbGllbnRUb2tlbj1fY2xpZW50X3Rva2VuKGZcIntlbmdpbmVfaWR9e3BuYW1lfXtldmVudC5nZXQoJ1JlcXVlc3RJZCcsICcnKX1cIiksXG4gICAgICAgIClcbiAgICAgICAgcG9saWN5X2lkID0gcmVzcC5nZXQoJ3BvbGljeUlkJywgcG5hbWUpXG4gICAgICAgICMgQmxvY2sgdW50aWwgdGhlIHBvbGljeSB2YWxpZGF0ZXMgQUNUSVZFOyByYWlzZXMgb24gQ1JFQVRFX0ZBSUxFRC5cbiAgICAgICAgX3dhaXRfcG9saWN5X2FjdGl2ZShjbGllbnQsIGVuZ2luZV9pZCwgcG9saWN5X2lkKVxuICAgICAgICBjcmVhdGVkLmFwcGVuZChwb2xpY3lfaWQpXG5cbiAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnLCBkYXRhPXtcbiAgICAgICAgJ1BvbGljeUlkcyc6ICcsJy5qb2luKGNyZWF0ZWQpLFxuICAgIH0sIHBoeXNpY2FsX2lkPWYne2VuZ2luZV9pZH0tcG9saWNpZXMnKVxuXG5cbmRlZiBoYW5kbGVyKGV2ZW50LCBjb250ZXh0KTpcbiAgICBsb2dnZXIuaW5mbyhmJ0V2ZW50OiB7anNvbi5kdW1wcyhldmVudCl9JylcbiAgICBwcm9wcyA9IGV2ZW50WydSZXNvdXJjZVByb3BlcnRpZXMnXVxuICAgIG9wZXJhdGlvbiA9IHByb3BzLmdldCgnT3BlcmF0aW9uJywgJ0VOR0lORScpXG4gICAgcmVnaW9uID0gcHJvcHMuZ2V0KCdSZWdpb24nKSBvciBvcy5lbnZpcm9uLmdldCgnQVdTX1JFR0lPTicpXG4gICAgY2xpZW50ID0gYm90bzMuY2xpZW50KCdiZWRyb2NrLWFnZW50Y29yZS1jb250cm9sJywgcmVnaW9uX25hbWU9cmVnaW9uKVxuICAgIHRyeTpcbiAgICAgICAgaWYgb3BlcmF0aW9uID09ICdFTkdJTkUnOlxuICAgICAgICAgICAgaGFuZGxlX2VuZ2luZShldmVudCwgY2xpZW50KVxuICAgICAgICBlbGlmIG9wZXJhdGlvbiA9PSAnUE9MSUNJRVMnOlxuICAgICAgICAgICAgaGFuZGxlX3BvbGljaWVzKGV2ZW50LCBjbGllbnQpXG4gICAgICAgIGVsc2U6XG4gICAgICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ0ZBSUxFRCcsIHJlYXNvbj1mJ1Vua25vd24gb3BlcmF0aW9uIHtvcGVyYXRpb259JylcbiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGU6XG4gICAgICAgIGxvZ2dlci5lcnJvcihmJ3tvcGVyYXRpb259IGZhaWxlZDoge2V9JylcbiAgICAgICAgIyBPbiBEZWxldGUgd2UgbmV2ZXIgd2FudCB0byBibG9jayBzdGFjayB0ZWFyZG93bi5cbiAgICAgICAgaWYgZXZlbnRbJ1JlcXVlc3RUeXBlJ10gPT0gJ0RlbGV0ZSc6XG4gICAgICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnKVxuICAgICAgICBlbHNlOlxuICAgICAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdGQUlMRUQnLCByZWFzb249c3RyKGUpKVxuYCksXG4gICAgfSk7XG5cbiAgICBwb2xpY3lFbmdpbmVGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6Q3JlYXRlUG9saWN5RW5naW5lJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkRlbGV0ZVBvbGljeUVuZ2luZScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRQb2xpY3lFbmdpbmUnLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdFBvbGljeUVuZ2luZXMnLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6Q3JlYXRlUG9saWN5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkRlbGV0ZVBvbGljeScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRQb2xpY3knLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdFBvbGljaWVzJyxcbiAgICAgICAgLy8gQ3JlYXRlUG9saWN5IGJpbmRzL3ZhbGlkYXRlcyBlYWNoIENlZGFyIHBvbGljeSBhZ2FpbnN0IHRoZSB0YXJnZXRcbiAgICAgICAgLy8gR2F0ZXdheSdzIHRvb2xzLCB3aGljaCByZXF1aXJlcyByZWFkaW5nIHRoZSBnYXRld2F5IGFuZCBpdHMgdGFyZ2V0cyxcbiAgICAgICAgLy8gbWFuYWdpbmcgdGhlIGdhdGV3YXkncyByZXNvdXJjZS1zY29wZWQgcG9saWN5LCBhbmQgaW52b2tpbmcgdGhlXG4gICAgICAgIC8vIGdhdGV3YXkgdG8gdmFsaWRhdGUgdGhlIGFjdGlvbnMgcmVmZXJlbmNlZCBieSB0aGUgcG9saWN5LlxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TWFuYWdlUmVzb3VyY2VTY29wZWRQb2xpY3knLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6SW52b2tlR2F0ZXdheScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRHYXRld2F5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RHYXRld2F5VGFyZ2V0cycsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRHYXRld2F5VGFyZ2V0JyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIC8vIEFnZW50Q29yZSBQb2xpY3kgcmVzb3VyY2UgbmFtZXMgKGVuZ2luZSArIHBvbGljaWVzKSBtdXN0IG1hdGNoXG4gICAgLy8gXltBLVphLXpdW0EtWmEtejAtOV9dKiQg4oCUIGxldHRlcnMvZGlnaXRzL3VuZGVyc2NvcmVzIG9ubHksIHN0YXJ0aW5nIHdpdGhcbiAgICAvLyBhIGxldHRlci4gU2FuaXRpemUgdGhlIHN0YWNrIG5hbWUgKHdoaWNoIG1heSBjb250YWluIGh5cGhlbnMpIHRvIGEgdmFsaWRcbiAgICAvLyBwcmVmaXggc28gdGhlIENyZWF0ZVBvbGljeUVuZ2luZS9DcmVhdGVQb2xpY3kgY2FsbHMgdmFsaWRhdGUuXG4gICAgY29uc3QgcG9saWN5TmFtZVByZWZpeCA9IGAke3RoaXMuc3RhY2tOYW1lfWAucmVwbGFjZSgvW15BLVphLXowLTlfXS9nLCAnXycpO1xuXG4gICAgY29uc3QgcG9saWN5RW5naW5lID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnUG9saWN5RW5naW5lJywge1xuICAgICAgc2VydmljZVRva2VuOiBwb2xpY3lFbmdpbmVGbi5mdW5jdGlvbkFybixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgT3BlcmF0aW9uOiAnRU5HSU5FJyxcbiAgICAgICAgRW5naW5lTmFtZTogYCR7cG9saWN5TmFtZVByZWZpeH1fcG9saWN5X2VuZ2luZWAsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnQ2xvdWRPcHMgcm9sZS1iYXNlZCB0b29sIGF1dGhvcml6YXRpb24gKENlZGFyKSBmb3IgdGhlIGdhdGV3YXknLFxuICAgICAgICBSZWdpb246IHRoaXMucmVnaW9uLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHBvbGljeUVuZ2luZUFybiA9IHBvbGljeUVuZ2luZS5nZXRBdHRTdHJpbmcoJ1BvbGljeUVuZ2luZUFybicpO1xuICAgIGNvbnN0IHBvbGljeUVuZ2luZUlkID0gcG9saWN5RW5naW5lLmdldEF0dFN0cmluZygnUG9saWN5RW5naW5lSWQnKTtcblxuICAgIC8vIEdhdGV3YXkgRXhlY3V0aW9uIFJvbGUgcGVybWlzc2lvbnMgZm9yIFBvbGljeSBpbiBBZ2VudENvcmUuIFBlciB0aGVcbiAgICAvLyBBZ2VudENvcmUgXCJHYXRld2F5IGFuZCBQb2xpY3kgSUFNIFBlcm1pc3Npb25zXCIgZ3VpZGUsIHRoZSBleGVjdXRpb24gcm9sZVxuICAgIC8vIHJlcXVpcmVzIGV4YWN0bHk6XG4gICAgLy8gICAqIEdldFBvbGljeUVuZ2luZSBvbiB0aGUgcG9saWN5LWVuZ2luZSwgYW5kXG4gICAgLy8gICAqIEF1dGhvcml6ZUFjdGlvbiArIFBhcnRpYWxseUF1dGhvcml6ZUFjdGlvbnMgb24gQk9USCB0aGUgcG9saWN5LWVuZ2luZVxuICAgIC8vICAgICBhbmQgdGhlIGdhdGV3YXkuXG4gICAgLy8gV2l0aG91dCB0aGVzZSB0aGUgR2F0ZXdheSBjYW5ub3QgZXZhbHVhdGUgQ2VkYXIgcG9saWNpZXMgKGF0dGFjaGluZyBhXG4gICAgLy8gUG9saWN5IEVuZ2luZSBmYWlscywgYW5kIGFsbCB0b29sIGludm9jYXRpb25zIGRlZmF1bHQtZGVueSkuXG4gICAgLy8gVGhlIGdhdGV3YXkgQVJOIGlzIGdlbmVyYXRlZCBhdCBjcmVhdGUgdGltZSAocmVmZXJlbmNpbmcgdGhpcy5nYXRld2F5QXJuXG4gICAgLy8gaGVyZSB3b3VsZCBiZSBjaXJjdWxhciksIHNvIHRoZSBnYXRld2F5IHJlc291cmNlIGlzIHNjb3BlZCB0byB0aGlzXG4gICAgLy8gYWNjb3VudC9yZWdpb24ncyBnYXRld2F5IG5hbWVzcGFjZS5cbiAgICBjb25zdCBnYXRld2F5UmVzb3VyY2VXaWxkY2FyZCA9IGBhcm46YXdzOmJlZHJvY2stYWdlbnRjb3JlOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpnYXRld2F5LypgO1xuXG4gICAgZ2F0ZXdheVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgc2lkOiAnUG9saWN5RW5naW5lQ29uZmlndXJhdGlvbicsXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2JlZHJvY2stYWdlbnRjb3JlOkdldFBvbGljeUVuZ2luZSddLFxuICAgICAgcmVzb3VyY2VzOiBbcG9saWN5RW5naW5lQXJuXSxcbiAgICB9KSk7XG5cbiAgICBnYXRld2F5Um9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBzaWQ6ICdQb2xpY3lFbmdpbmVBdXRob3JpemF0aW9uJyxcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkF1dGhvcml6ZUFjdGlvbicsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpQYXJ0aWFsbHlBdXRob3JpemVBY3Rpb25zJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtwb2xpY3lFbmdpbmVBcm4sIGdhdGV3YXlSZXNvdXJjZVdpbGRjYXJkXSxcbiAgICB9KSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRGVueS1hdWRpdCBSRVFVRVNUIGludGVyY2VwdG9yIChMYW1iZGEpXG4gICAgLy9cbiAgICAvLyBFbWl0cyBleGFjdGx5IG9uZSBzdHJ1Y3R1cmVkIENsb3VkV2F0Y2ggcmVjb3JkIG9uIGEgZGVueSBUb29sX0ludm9jYXRpb25cbiAgICAvLyAoSldUIGBzdWJgLCByZXF1ZXN0ZWQgVG9vbF9DYXRlZ29yeSwgYGRlbnlgLCB0aW1lc3RhbXApIOKAlCBuZXZlciB0aGUgdG9rZW5cbiAgICAvLyBvciB0b29sIGFyZ3MvcmVzdWx0cyAoUmVxIDguMykuIEl0IGlzIEFVRElULU9OTFk6IGl0IHJlLWRlcml2ZXMgdGhlXG4gICAgLy8gZGVjaXNpb24gd2l0aCB0aGUgc2FtZSBhdXRob3JpdGF0aXZlIHJvbGUtPmNhdGVnb3J5IG1vZGVsIGFuZCBBTFdBWVNcbiAgICAvLyBmb3J3YXJkcyB0aGUgcmVxdWVzdCB1bmNoYW5nZWQsIHNvIHRoZSBDZWRhciBQb2xpY3kgZW5naW5lIGFib3ZlIHJlbWFpbnNcbiAgICAvLyB0aGUgYXV0aG9yaXRhdGl2ZSBhdXRob3JpemVyLiBBbnkgYXVkaXQgZmFpbHVyZSBpcyBzd2FsbG93ZWQgaW5zaWRlIHRoZVxuICAgIC8vIGhhbmRsZXIgYW5kIHRoZSByZXF1ZXN0IGlzIHN0aWxsIGZvcndhcmRlZCB1bmNoYW5nZWQsIHNvIGFuIGF1ZGl0IGZhaWx1cmVcbiAgICAvLyBjYW4gbmV2ZXIgc3VwcHJlc3MgdGhlIGF1dGhvcml6YXRpb24gZXJyb3IgcmV0dXJuZWQgdG8gdGhlIGNhbGxlclxuICAgIC8vIChSZXEgOC40KS5cbiAgICAvL1xuICAgIC8vIFZlcmlmaWVkIGFnYWluc3QgdGhlIEFnZW50Q29yZSBkb2NzOlxuICAgIC8vICAgKiBgQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpHYXRld2F5YCBleHBvc2VzIGBJbnRlcmNlcHRvckNvbmZpZ3VyYXRpb25zYFxuICAgIC8vICAgICAoYXJyYXksIDHigJMyKS4gRWFjaCBlbnRyeSBoYXMgYEludGVyY2VwdGlvblBvaW50c2AgKFJFUVVFU1QvUkVTUE9OU0UpLFxuICAgIC8vICAgICBgSW50ZXJjZXB0b3IuTGFtYmRhLkFybmAsIGFuZCBgSW5wdXRDb25maWd1cmF0aW9uLlBhc3NSZXF1ZXN0SGVhZGVyc2AuXG4gICAgLy8gICAqIFRoZSBKV1QgYHN1YmAvYHJvbGVgIGFyZSBvbmx5IGF2YWlsYWJsZSB0byB0aGUgaW50ZXJjZXB0b3IgdmlhIHRoZVxuICAgIC8vICAgICBgQXV0aG9yaXphdGlvbmAgaGVhZGVyLCBkZWxpdmVyZWQgb25seSB3aGVuIGBQYXNzUmVxdWVzdEhlYWRlcnNgIGlzXG4gICAgLy8gICAgIHRydWUuIFRoZSBHYXRld2F5IHZlcmlmaWVzIHRoZSBKV1QgYmVmb3JlIGludm9raW5nIHRoZSBpbnRlcmNlcHRvcjtcbiAgICAvLyAgICAgdGhlIGhhbmRsZXIgZGVjb2RlcyAoZG9lcyBub3QgdmVyaWZ5KSBpdCBzb2xlbHkgdG8gcmVhZCBgc3ViYC9gcm9sZWBcbiAgICAvLyAgICAgYW5kIG5ldmVyIGxvZ3MgdGhlIHRva2VuLlxuICAgIC8vICAgKiBBZ2VudENvcmUgUG9saWN5IGFsc28gaGFzIG5hdGl2ZSBkZW55IG9ic2VydmFiaWxpdHkgKG1ldHJpY3MgKyB0cmFjZVxuICAgIC8vICAgICBzcGFucykuIFBlciBkZXNpZ24gTm90ZSA0IHdlIHVzZSB0aGUgaW50ZXJjZXB0b3IgYXMgdGhlIHNpbmdsZVxuICAgIC8vICAgICBjYW5vbmljYWwgZm91ci1maWVsZCBhdWRpdCBlbnRyeSBhbmQgZG8gTk9UIGFsc28gZW5hYmxlIGEgY29tcGV0aW5nXG4gICAgLy8gICAgIG5hdGl2ZS1vYnNlcnZhYmlsaXR5IGF1ZGl0IHNpbmssIGtlZXBpbmcgXCJleGFjdGx5IG9uZSBhdWRpdCBlbnRyeVwiXG4gICAgLy8gICAgIHBlciBkZW55IChSZXEgOC4zKS5cbiAgICAvLyBTZWUgY2RrL2xhbWJkYS9kZW55LWF1ZGl0LWludGVyY2VwdG9yL1JFQURNRS5tZCBmb3IgdGhlIGZ1bGwgcmVzZWFyY2ggbG9nLlxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIERlZGljYXRlZCBsb2cgZ3JvdXAgc28gdGhlIHN0cnVjdHVyZWQgZGVueS1hdWRpdCByZWNvcmRzIGhhdmUgYW4gZXhwbGljaXQsXG4gICAgLy8gcmV0YWluZWQgQ2xvdWRXYXRjaCBkZXN0aW5hdGlvbiAocmF0aGVyIHRoYW4gcmVseWluZyBvbiB0aGUgaW1wbGljaXRcbiAgICAvLyBMYW1iZGEgbG9nIGdyb3VwKS5cbiAgICBjb25zdCBkZW55QXVkaXRMb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdEZW55QXVkaXRJbnRlcmNlcHRvckxvZ0dyb3VwJywge1xuICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX1lFQVIsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZGVueUF1ZGl0SW50ZXJjZXB0b3JGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0RlbnlBdWRpdEludGVyY2VwdG9yRnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyLmhhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvZGVueS1hdWRpdC1pbnRlcmNlcHRvcicpKSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRGVueS1hdWRpdCBSRVFVRVNUIGludGVyY2VwdG9yIGZvciB0aGUgQ2xvdWRPcHMgR2F0ZXdheSAoc3RydWN0dXJlZCBkZW55IHJlY29yZHMpLicsXG4gICAgICBtZW1vcnlTaXplOiAxMjgsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgICBsb2dHcm91cDogZGVueUF1ZGl0TG9nR3JvdXAsXG4gICAgfSk7XG5cbiAgICAvLyBUaGUgR2F0ZXdheSBzZXJ2aWNlIHJvbGUgaW52b2tlcyB0aGUgaW50ZXJjZXB0b3IuIFNjb3BlIHRoZSBncmFudCB0byB0aGlzXG4gICAgLy8gZnVuY3Rpb24gb25seSAoaW50ZXJjZXB0b3Igc2VjdXJpdHkgYmVzdCBwcmFjdGljZSDigJQgbmV2ZXIgYSB3aWxkY2FyZCkuXG4gICAgZGVueUF1ZGl0SW50ZXJjZXB0b3JGbi5ncmFudEludm9rZShnYXRld2F5Um9sZSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRGlzY292ZXJ5LWZpbHRlciBSRVNQT05TRSBpbnRlcmNlcHRvciAoTGFtYmRhKVxuICAgIC8vXG4gICAgLy8gRmlsdGVycyB0aGUgYHRvb2xzL2xpc3RgIERpc2NvdmVyeV9SZXNwb25zZSBkb3duIHRvIHRoZSBjYWxsZXIncyBhbGxvd2VkXG4gICAgLy8gY2F0ZWdvcmllcyBiZWZvcmUgdGhlIEdhdGV3YXkgcmV0dXJucyBpdCwgc28gYSBOb25BZG1pbiB1c2VyIGNhbm5vdFxuICAgIC8vIGVudW1lcmF0ZSB0aGUgbmFtZXMvZGVzY3JpcHRpb25zL2lucHV0IHNjaGVtYXMgb2YgdG9vbHMgdGhleSBjYW5ub3RcbiAgICAvLyBpbnZva2UuIEl0IGlzIGEgRElTVElOQ1QsIGluZGVwZW5kZW50bHkgcmVhc29uZWQgaW50ZXJjZXB0b3IgZnJvbSB0aGVcbiAgICAvLyBkZW55LWF1ZGl0IFJFUVVFU1QgaW50ZXJjZXB0b3IgYWJvdmU6IGl0IHRyYW5zZm9ybXMgb25seSBgdG9vbHMvbGlzdGBcbiAgICAvLyByZXNwb25zZXMsIG5ldmVyIGF1ZGl0cyBvciBlbmZvcmNlcyBpbnZvY2F0aW9uLCByZXVzZXMgdGhlIGF1dGhvcml0YXRpdmVcbiAgICAvLyByb2xlLT5jYXRlZ29yeSBtb2RlbCAodmVuZG9yZWQgYnl0ZS1mb3ItYnl0ZSksIGFuZCBmYWlscyBjbG9zZWQgKHJldHVybnNcbiAgICAvLyBhbiBlbXB0eSB0b29sIGxpc3QpIG9uIGFueSBlcnJvciDigJQgbmV2ZXIgdGhlIHVuZmlsdGVyZWQgY2F0YWxvZy4gSXRcbiAgICAvLyBkZWNvZGVzIChkb2VzIG5vdCB2ZXJpZnkpIHRoZSBhbHJlYWR5LXZlcmlmaWVkIEF1dGhvcml6YXRpb24gSldUIHNvbGVseVxuICAgIC8vIHRvIHJlYWQgYHN1YmAvYHJvbGVgIGFuZCBuZXZlciBsb2dzIHRoZSB0b2tlbi5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBEZWRpY2F0ZWQsIHJldGFpbmVkIGxvZyBncm91cCDigJQgbWlycm9ycyBEZW55QXVkaXRJbnRlcmNlcHRvckxvZ0dyb3VwLlxuICAgIGNvbnN0IGRpc2NvdmVyeUZpbHRlckxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgJ0Rpc2NvdmVyeUZpbHRlckludGVyY2VwdG9yTG9nR3JvdXAnLCB7XG4gICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfWUVBUixcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICBjb25zdCBkaXNjb3ZlcnlGaWx0ZXJJbnRlcmNlcHRvckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnRGlzY292ZXJ5RmlsdGVySW50ZXJjZXB0b3JGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEyLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXIuaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9kaXNjb3ZlcnktZmlsdGVyLWludGVyY2VwdG9yJykpLFxuICAgICAgZGVzY3JpcHRpb246ICdSb2xlLWZpbHRlcmVkIHRvb2wgZGlzY292ZXJ5IFJFU1BPTlNFIGludGVyY2VwdG9yIGZvciB0aGUgQ2xvdWRPcHMgR2F0ZXdheS4nLFxuICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgbG9nR3JvdXA6IGRpc2NvdmVyeUZpbHRlckxvZ0dyb3VwLFxuICAgIH0pO1xuXG4gICAgLy8gVGhlIEdhdGV3YXkgc2VydmljZSByb2xlIGludm9rZXMgdGhlIGludGVyY2VwdG9yLiBTY29wZSB0aGUgZ3JhbnQgdG8gdGhpc1xuICAgIC8vIGZ1bmN0aW9uIG9ubHkgKGludGVyY2VwdG9yIHNlY3VyaXR5IGJlc3QgcHJhY3RpY2Ug4oCUIG5ldmVyIGEgd2lsZGNhcmQpLlxuICAgIGRpc2NvdmVyeUZpbHRlckludGVyY2VwdG9yRm4uZ3JhbnRJbnZva2UoZ2F0ZXdheVJvbGUpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEdhdGV3YXkgKENVU1RPTV9KV1QgYXV0aCDigJQgdmVyaWZpZXMgcGVyLXVzZXIgQ29nbml0byB0b2tlbnMgc28gdGhlXG4gICAgLy8gcm9sZSBjbGFpbSByZWFjaGVzIEFnZW50Q29yZSBQb2xpY3kgZm9yIGZpbmUtZ3JhaW5lZCBhdXRob3JpemF0aW9uKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IGdhdGV3YXkgPSBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdNY3BHYXRld2F5Jywge1xuICAgICAgdHlwZTogJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheScsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIE5hbWU6ICdjbG91ZG9wcy1nYXRld2F5JyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdDbG91ZE9wcyBHYXRld2F5IGZvciBiaWxsaW5nIGFuZCBwcmljaW5nIE1DUCB0b29scyAoSldUIGF1dGgpJyxcbiAgICAgICAgUHJvdG9jb2xUeXBlOiAnTUNQJyxcbiAgICAgICAgQXV0aG9yaXplclR5cGU6ICdDVVNUT01fSldUJyxcbiAgICAgICAgQXV0aG9yaXplckNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBDdXN0b21KV1RBdXRob3JpemVyOiB7XG4gICAgICAgICAgICBEaXNjb3ZlcnlVcmw6IGBodHRwczovL2NvZ25pdG8taWRwLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vJHtwcm9wcy5hdXRoVXNlclBvb2xJZH0vLndlbGwta25vd24vb3BlbmlkLWNvbmZpZ3VyYXRpb25gLFxuICAgICAgICAgICAgLy8gVGhlIEZyb250RW5kIGZvcndhcmRzIHRoZSBDb2duaXRvIEFDQ0VTUyB0b2tlbiwgd2hpY2ggY2Fycmllc1xuICAgICAgICAgICAgLy8gYGNsaWVudF9pZGAgKG5vdCBhbiBgYXVkYCBjbGFpbSDigJQgb25seSBJRCB0b2tlbnMgaGF2ZSBgYXVkYCkuXG4gICAgICAgICAgICAvLyBUaGUgSldUIGF1dGhvcml6ZXIgbXVzdCB0aGVyZWZvcmUgbWF0Y2ggb24gQWxsb3dlZENsaWVudHNcbiAgICAgICAgICAgIC8vIChjbGllbnRfaWQpIHJhdGhlciB0aGFuIEFsbG93ZWRBdWRpZW5jZSwgb3IgdmFsaWRhdGlvbiA0MDNzLlxuICAgICAgICAgICAgQWxsb3dlZENsaWVudHM6IFtwcm9wcy5hdXRoVXNlclBvb2xDbGllbnRJZF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgUHJvdG9jb2xDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTWNwOiB7XG4gICAgICAgICAgICBJbnN0cnVjdGlvbnM6ICdDbG91ZE9wcyBnYXRld2F5IGZvciBiaWxsaW5nLCBwcmljaW5nLCBDbG91ZFdhdGNoLCBDbG91ZFRyYWlsLCBhbmQgaW52ZW50b3J5IE1DUCB0b29scycsXG4gICAgICAgICAgICBTZWFyY2hUeXBlOiAnU0VNQU5USUMnLFxuICAgICAgICAgICAgU3VwcG9ydGVkVmVyc2lvbnM6IFsnMjAyNS0wMy0yNiddLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIC8vIEFzc29jaWF0ZSB0aGUgQ2VkYXIgcG9saWN5IGVuZ2luZS4gRU5GT1JDRSBtYWtlcyB0aGUgZW5naW5lIGRlbnlcbiAgICAgICAgLy8gZGlzYWxsb3dlZCB0b29sIGRpc2NvdmVyeS9pbnZvY2F0aW9uOyBMT0dfT05MWSB3b3VsZCBvbmx5IHRyYWNlLlxuICAgICAgICBQb2xpY3lFbmdpbmVDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgQXJuOiBwb2xpY3lFbmdpbmVBcm4sXG4gICAgICAgICAgTW9kZTogJ0VORk9SQ0UnLFxuICAgICAgICB9LFxuICAgICAgICAvLyBSZWdpc3RlciB0aGUgZGVueS1hdWRpdCBSRVFVRVNUIGludGVyY2VwdG9yLiBQYXNzUmVxdWVzdEhlYWRlcnM9dHJ1ZVxuICAgICAgICAvLyBpcyByZXF1aXJlZCBzbyB0aGUgaW50ZXJjZXB0b3IgY2FuIHJlYWQgdGhlIChhbHJlYWR5LXZlcmlmaWVkKVxuICAgICAgICAvLyBBdXRob3JpemF0aW9uIGhlYWRlciB0byByZWNvdmVyIHRoZSBKV1QgYHN1YmAvYHJvbGVgIGZvciB0aGUgYXVkaXRcbiAgICAgICAgLy8gcmVjb3JkOyB0aGUgaGFuZGxlciBuZXZlciBsb2dzIHRoZSB0b2tlbi4gVGhlIGludGVyY2VwdG9yIGlzXG4gICAgICAgIC8vIGF1ZGl0LW9ubHkgYW5kIGZvcndhcmRzIGV2ZXJ5IHJlcXVlc3QgdW5jaGFuZ2VkLlxuICAgICAgICBJbnRlcmNlcHRvckNvbmZpZ3VyYXRpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgSW50ZXJjZXB0aW9uUG9pbnRzOiBbJ1JFUVVFU1QnXSxcbiAgICAgICAgICAgIEludGVyY2VwdG9yOiB7XG4gICAgICAgICAgICAgIExhbWJkYToge1xuICAgICAgICAgICAgICAgIEFybjogZGVueUF1ZGl0SW50ZXJjZXB0b3JGbi5mdW5jdGlvbkFybixcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBJbnB1dENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICAgICAgUGFzc1JlcXVlc3RIZWFkZXJzOiB0cnVlLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIC8vIFJlZ2lzdGVyIHRoZSBkaXNjb3ZlcnktZmlsdGVyIFJFU1BPTlNFIGludGVyY2VwdG9yLlxuICAgICAgICAgIC8vIFBhc3NSZXF1ZXN0SGVhZGVycz10cnVlIHNvIGl0IGNhbiByZWFkIHRoZSAoYWxyZWFkeS12ZXJpZmllZClcbiAgICAgICAgICAvLyBBdXRob3JpemF0aW9uIGhlYWRlciB0byByZWNvdmVyIHRoZSBKV1QgYHJvbGVgIGZvciBmaWx0ZXJpbmc7XG4gICAgICAgICAgLy8gdGhlIGhhbmRsZXIgbmV2ZXIgbG9ncyB0aGUgdG9rZW4uIEl0IHRyYW5zZm9ybXMgb25seSBgdG9vbHMvbGlzdGBcbiAgICAgICAgICAvLyBkaXNjb3ZlcnkgcmVzcG9uc2VzIGFuZCBmYWlscyBjbG9zZWQgdG8gYW4gZW1wdHkgdG9vbCBsaXN0LlxuICAgICAgICAgIHtcbiAgICAgICAgICAgIEludGVyY2VwdGlvblBvaW50czogWydSRVNQT05TRSddLFxuICAgICAgICAgICAgSW50ZXJjZXB0b3I6IHtcbiAgICAgICAgICAgICAgTGFtYmRhOiB7XG4gICAgICAgICAgICAgICAgQXJuOiBkaXNjb3ZlcnlGaWx0ZXJJbnRlcmNlcHRvckZuLmZ1bmN0aW9uQXJuLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIElucHV0Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgICAgICBQYXNzUmVxdWVzdEhlYWRlcnM6IHRydWUsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICAgIFJvbGVBcm46IGdhdGV3YXlSb2xlLnJvbGVBcm4sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGdhdGV3YXkubm9kZS5hZGREZXBlbmRlbmN5KGRlbnlBdWRpdEludGVyY2VwdG9yRm4pO1xuICAgIGdhdGV3YXkubm9kZS5hZGREZXBlbmRlbmN5KGRpc2NvdmVyeUZpbHRlckludGVyY2VwdG9yRm4pO1xuICAgIGdhdGV3YXkubm9kZS5hZGREZXBlbmRlbmN5KG9hdXRoUHJvdmlkZXIpO1xuICAgIGdhdGV3YXkubm9kZS5hZGREZXBlbmRlbmN5KHBvbGljeUVuZ2luZSk7XG4gICAgLy8gVGhlIEdhdGV3YXkgY2FsbHMgR2V0UG9saWN5RW5naW5lIHVzaW5nIGl0cyBzZXJ2aWNlIHJvbGUgYXQgY3JlYXRlIHRpbWUsXG4gICAgLy8gc28gdGhlIHJvbGUncyBpbmxpbmUgcG9saWN5ICh3aGljaCBncmFudHMgYmVkcm9jay1hZ2VudGNvcmU6R2V0UG9saWN5RW5naW5lXG4gICAgLy8gYW5kIHRoZSBPQXV0aC90b2tlbi1leGNoYW5nZSBwZXJtaXNzaW9ucykgTVVTVCBiZSBhdHRhY2hlZCBiZWZvcmUgdGhlXG4gICAgLy8gR2F0ZXdheSBpcyBjcmVhdGVkLiBXaXRob3V0IHRoaXMgZGVwZW5kZW5jeSBDbG91ZEZvcm1hdGlvbiBtYXkgY3JlYXRlIHRoZVxuICAgIC8vIEdhdGV3YXkgY29uY3VycmVudGx5IHdpdGggdGhlIHJvbGUgcG9saWN5LCBjYXVzaW5nIGFuIGFjY2Vzcy1kZW5pZWQgZXJyb3IuXG4gICAgZ2F0ZXdheS5ub2RlLmFkZERlcGVuZGVuY3koZ2F0ZXdheVJvbGUpO1xuXG4gICAgdGhpcy5nYXRld2F5QXJuID0gZ2F0ZXdheS5nZXRBdHQoJ0dhdGV3YXlBcm4nKS50b1N0cmluZygpO1xuICAgIGNvbnN0IGdhdGV3YXlJZCA9IGdhdGV3YXkuZ2V0QXR0KCdHYXRld2F5SWRlbnRpZmllcicpLnRvU3RyaW5nKCk7XG4gICAgdGhpcy5nYXRld2F5VXJsID0gZ2F0ZXdheS5nZXRBdHQoJ0dhdGV3YXlVcmwnKS50b1N0cmluZygpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEdhdGV3YXkgVGFyZ2V0cyAoTUNQIFNlcnZlciBlbmRwb2ludHMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgYmlsbGluZ1RhcmdldCA9IG5ldyBjZGsuQ2ZuUmVzb3VyY2UodGhpcywgJ0JpbGxpbmdNY3BUYXJnZXQnLCB7XG4gICAgICB0eXBlOiAnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpHYXRld2F5VGFyZ2V0JyxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgR2F0ZXdheUlkZW50aWZpZXI6IGdhdGV3YXlJZCxcbiAgICAgICAgTmFtZTogJ2JpbGxpbmdNY3AnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0FXUyBMYWJzIEJpbGxpbmcgTUNQIFNlcnZlciBvbiBBZ2VudENvcmUgUnVudGltZScsXG4gICAgICAgIFRhcmdldENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBNY3A6IHsgTWNwU2VydmVyOiB7IEVuZHBvaW50OiBwcm9wcy5iaWxsaW5nTWNwUnVudGltZUVuZHBvaW50IH0gfSxcbiAgICAgICAgfSxcbiAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyQ29uZmlndXJhdGlvbnM6IFt7XG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyVHlwZTogJ09BVVRIJyxcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXI6IHtcbiAgICAgICAgICAgIE9hdXRoQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICAgIFByb3ZpZGVyQXJuOiBvYXV0aFByb3ZpZGVyQXJuLFxuICAgICAgICAgICAgICBTY29wZXM6IFsnbWNwLXJ1bnRpbWUtc2VydmVyL2ludm9rZSddLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgYmlsbGluZ1RhcmdldC5ub2RlLmFkZERlcGVuZGVuY3koZ2F0ZXdheSk7XG5cbiAgICBjb25zdCBwcmljaW5nVGFyZ2V0ID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnUHJpY2luZ01jcFRhcmdldCcsIHtcbiAgICAgIHR5cGU6ICdBV1M6OkJlZHJvY2tBZ2VudENvcmU6OkdhdGV3YXlUYXJnZXQnLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBHYXRld2F5SWRlbnRpZmllcjogZ2F0ZXdheUlkLFxuICAgICAgICBOYW1lOiAncHJpY2luZ01jcCcsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnQVdTIExhYnMgUHJpY2luZyBNQ1AgU2VydmVyIG9uIEFnZW50Q29yZSBSdW50aW1lJyxcbiAgICAgICAgVGFyZ2V0Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE1jcDogeyBNY3BTZXJ2ZXI6IHsgRW5kcG9pbnQ6IHByb3BzLnByaWNpbmdNY3BSdW50aW1lRW5kcG9pbnQgfSB9LFxuICAgICAgICB9LFxuICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXJDb25maWd1cmF0aW9uczogW3tcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXJUeXBlOiAnT0FVVEgnLFxuICAgICAgICAgIENyZWRlbnRpYWxQcm92aWRlcjoge1xuICAgICAgICAgICAgT2F1dGhDcmVkZW50aWFsUHJvdmlkZXI6IHtcbiAgICAgICAgICAgICAgUHJvdmlkZXJBcm46IG9hdXRoUHJvdmlkZXJBcm4sXG4gICAgICAgICAgICAgIFNjb3BlczogWydtY3AtcnVudGltZS1zZXJ2ZXIvaW52b2tlJ10sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH1dLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBwcmljaW5nVGFyZ2V0Lm5vZGUuYWRkRGVwZW5kZW5jeShnYXRld2F5KTtcblxuICAgIGNvbnN0IGNsb3Vkd2F0Y2hNY3BUYXJnZXQgPSBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdDbG91ZFdhdGNoTWNwVGFyZ2V0Jywge1xuICAgICAgdHlwZTogJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheVRhcmdldCcsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEdhdGV3YXlJZGVudGlmaWVyOiBnYXRld2F5SWQsXG4gICAgICAgIE5hbWU6ICdjbG91ZHdhdGNoTWNwJyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdBV1MgTGFicyBDbG91ZFdhdGNoIE1DUCBTZXJ2ZXIgb24gQWdlbnRDb3JlIFJ1bnRpbWUnLFxuICAgICAgICBUYXJnZXRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTWNwOiB7IE1jcFNlcnZlcjogeyBFbmRwb2ludDogcHJvcHMuY2xvdWR3YXRjaE1jcFJ1bnRpbWVFbmRwb2ludCB9IH0sXG4gICAgICAgIH0sXG4gICAgICAgIENyZWRlbnRpYWxQcm92aWRlckNvbmZpZ3VyYXRpb25zOiBbe1xuICAgICAgICAgIENyZWRlbnRpYWxQcm92aWRlclR5cGU6ICdPQVVUSCcsXG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICBPYXV0aENyZWRlbnRpYWxQcm92aWRlcjoge1xuICAgICAgICAgICAgICBQcm92aWRlckFybjogb2F1dGhQcm92aWRlckFybixcbiAgICAgICAgICAgICAgU2NvcGVzOiBbJ21jcC1ydW50aW1lLXNlcnZlci9pbnZva2UnXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfV0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNsb3Vkd2F0Y2hNY3BUYXJnZXQubm9kZS5hZGREZXBlbmRlbmN5KGdhdGV3YXkpO1xuXG4gICAgY29uc3QgY2xvdWR0cmFpbE1jcFRhcmdldCA9IG5ldyBjZGsuQ2ZuUmVzb3VyY2UodGhpcywgJ0Nsb3VkVHJhaWxNY3BUYXJnZXQnLCB7XG4gICAgICB0eXBlOiAnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpHYXRld2F5VGFyZ2V0JyxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgR2F0ZXdheUlkZW50aWZpZXI6IGdhdGV3YXlJZCxcbiAgICAgICAgTmFtZTogJ2Nsb3VkdHJhaWxNY3AnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0FXUyBMYWJzIENsb3VkVHJhaWwgTUNQIFNlcnZlciBvbiBBZ2VudENvcmUgUnVudGltZScsXG4gICAgICAgIFRhcmdldENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBNY3A6IHsgTWNwU2VydmVyOiB7IEVuZHBvaW50OiBwcm9wcy5jbG91ZHRyYWlsTWNwUnVudGltZUVuZHBvaW50IH0gfSxcbiAgICAgICAgfSxcbiAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyQ29uZmlndXJhdGlvbnM6IFt7XG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyVHlwZTogJ09BVVRIJyxcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXI6IHtcbiAgICAgICAgICAgIE9hdXRoQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICAgIFByb3ZpZGVyQXJuOiBvYXV0aFByb3ZpZGVyQXJuLFxuICAgICAgICAgICAgICBTY29wZXM6IFsnbWNwLXJ1bnRpbWUtc2VydmVyL2ludm9rZSddLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY2xvdWR0cmFpbE1jcFRhcmdldC5ub2RlLmFkZERlcGVuZGVuY3koZ2F0ZXdheSk7XG5cbiAgICBjb25zdCBpbnZlbnRvcnlNY3BUYXJnZXQgPSBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdJbnZlbnRvcnlNY3BUYXJnZXQnLCB7XG4gICAgICB0eXBlOiAnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpHYXRld2F5VGFyZ2V0JyxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgR2F0ZXdheUlkZW50aWZpZXI6IGdhdGV3YXlJZCxcbiAgICAgICAgTmFtZTogJ2ludmVudG9yeU1jcCcsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnSW52ZW50b3J5IE1DUCBTZXJ2ZXIgb24gQWdlbnRDb3JlIFJ1bnRpbWUnLFxuICAgICAgICBUYXJnZXRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTWNwOiB7IE1jcFNlcnZlcjogeyBFbmRwb2ludDogcHJvcHMuaW52ZW50b3J5TWNwUnVudGltZUVuZHBvaW50IH0gfSxcbiAgICAgICAgfSxcbiAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyQ29uZmlndXJhdGlvbnM6IFt7XG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyVHlwZTogJ09BVVRIJyxcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXI6IHtcbiAgICAgICAgICAgIE9hdXRoQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICAgIFByb3ZpZGVyQXJuOiBvYXV0aFByb3ZpZGVyQXJuLFxuICAgICAgICAgICAgICBTY29wZXM6IFsnbWNwLXJ1bnRpbWUtc2VydmVyL2ludm9rZSddLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgaW52ZW50b3J5TWNwVGFyZ2V0Lm5vZGUuYWRkRGVwZW5kZW5jeShnYXRld2F5KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDZWRhciBwb2xpY2llcyAocm9sZSAtPiB0b29sLWNhdGVnb3J5IG1hcHBpbmcpXG4gICAgLy9cbiAgICAvLyBBdXRob3JpdGF0aXZlIHJvbGUtPmNhdGVnb3J5IG1vZGVsIGltcGxlbWVudGVkIGFzIHR3byBgcGVybWl0YCBzdGF0ZW1lbnRzXG4gICAgLy8gKENlZGFyIGlzIGRlbnktYnktZGVmYXVsdDsgZm9yYmlkIG92ZXJyaWRlcyBwZXJtaXQpOlxuICAgIC8vICAgKiBiaWxsaW5nICsgcHJpY2luZyAgLT4gcGVybWl0dGVkIGZvciBldmVyeSBhdXRoZW50aWNhdGVkIHVzZXIuXG4gICAgLy8gICAqIGNsb3Vkd2F0Y2ggKyBjbG91ZHRyYWlsICsgaW52ZW50b3J5IC0+IHBlcm1pdHRlZCBvbmx5IHdoZW4gdGhlXG4gICAgLy8gICAgIHZlcmlmaWVkIEpXVCBgcm9sZWAgY2xhaW0gKHN0b3JlZCBhcyBhIHByaW5jaXBhbCB0YWcpID09IFwiYWRtaW5cIi5cbiAgICAvLyAgICogZXZlcnl0aGluZyBlbHNlIChpbmNsLiBuZXdseSBhZGRlZCBjYXRlZ29yaWVzKSAtPiBkZW5pZWQgYnkgZGVmYXVsdC5cbiAgICAvL1xuICAgIC8vIENhdGVnb3J5IC0+IHRvb2wgZ3JvdXBpbmcuIEF0IHRoZSBnYXRld2F5IGVhY2ggdG9vbCBhY3Rpb24gaXNcbiAgICAvLyBgQWdlbnRDb3JlOjpBY3Rpb246OlwiPHRhcmdldE5hbWU+X19fPHRvb2xOYW1lPlwiYCAoc2VlIHRoZSBBZ2VudENvcmVcbiAgICAvLyBhdXRob3JpemF0aW9uLWZsb3cgZG9jcykuIEEgY2F0ZWdvcnkgdGhlcmVmb3JlIGNvcnJlc3BvbmRzIHRvIGEgdGFyZ2V0XG4gICAgLy8gdG9vbC1uYW1lIHByZWZpeDpcbiAgICAvLyAgIGJpbGxpbmcgLT4gYmlsbGluZ01jcF9fXywgcHJpY2luZyAtPiBwcmljaW5nTWNwX19fLFxuICAgIC8vICAgY2xvdWR3YXRjaCAtPiBjbG91ZHdhdGNoTWNwX19fLCBjbG91ZHRyYWlsIC0+IGNsb3VkdHJhaWxNY3BfX18sXG4gICAgLy8gICBpbnZlbnRvcnkgLT4gaW52ZW50b3J5TWNwX19fLlxuICAgIC8vXG4gICAgLy8gQVNTVU1QVElPTiAobXVzdCBiZSB2YWxpZGF0ZWQgYWdhaW5zdCB0aGUgbGl2ZSBBZ2VudENvcmUgQ2VkYXIgc2NoZW1hLFxuICAgIC8vIGNvdmVyZWQgYnkgdGhlIGludGVncmF0aW9uIHRlc3RzIGluIHRhc2sgOSk6IHRoZSBncm91cGluZyBpcyBleHByZXNzZWRcbiAgICAvLyBoZXJlIHZpYSBgYWN0aW9uLnRvb2xfY2F0ZWdvcnkgPT0gXCI8Y2F0ZWdvcnk+XCJgLCBtYXRjaGluZyB0aGUgZGVzaWduXG4gICAgLy8gZG9jdW1lbnQncyBwb2xpY3kgc2V0LiBUaGUgY29uY3JldGUgQ2VkYXIgc2NoZW1hIGdlbmVyYXRlZCBmcm9tIHRoZVxuICAgIC8vIGdhdGV3YXkncyB0b29scyBtYXkgaW5zdGVhZCByZXF1aXJlIGVudW1lcmF0aW5nIHRoZSBwZXItdG9vbCBhY3Rpb25cbiAgICAvLyBpZGVudGlmaWVycyBvciBtYXRjaGluZyB0aGUgYDx0YXJnZXROYW1lPl9fX2AgcHJlZml4IGRpcmVjdGx5LiBJZiB0aGVcbiAgICAvLyBsaXZlIHNjaGVtYSBkb2VzIG5vdCBleHBvc2UgYSBgdG9vbF9jYXRlZ29yeWAgYWN0aW9uIGF0dHJpYnV0ZSwgc3dpdGNoXG4gICAgLy8gdGhlc2Ugc3RhdGVtZW50cyB0byBgYWN0aW9uIGluIFtBZ2VudENvcmU6OkFjdGlvbjo6XCJiaWxsaW5nTWNwX19fLi4uXCIsIOKApl1gXG4gICAgLy8gKGVudW1lcmF0ZWQpIG9yIHRoZSBzY2hlbWEncyBkb2N1bWVudGVkIGNhdGVnb3J5IGF0dHJpYnV0ZS4gVGhlXG4gICAgLy8gcm9sZS0+Y2F0ZWdvcnkgU0VNQU5USUNTIGFib3ZlIGFyZSB0aGUgaW52YXJpYW50OyBvbmx5IHRoZSBhY3Rpb24tbWF0Y2hcbiAgICAvLyBleHByZXNzaW9uIGlzIHByb3Zpc2lvbmFsLiBWYWxpZGF0aW9uTW9kZSBpcyBJR05PUkVfQUxMX0ZJTkRJTkdTIHNvIHRoZVxuICAgIC8vIGVuZ2luZSBhY2NlcHRzIHRoZSBwb2xpY2llcyBkdXJpbmcgdGhpcyBwcm92aXNpb25hbCBwaGFzZTsgdGlnaHRlbiB0b1xuICAgIC8vIEZBSUxfT05fQU5ZX0ZJTkRJTkdTIG9uY2UgdGhlIGFjdGlvbiBtb2RlbCBpcyBjb25maXJtZWQuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgZ2F0ZXdheUFyblJlZiA9IHRoaXMuZ2F0ZXdheUFybjtcblxuICAgIC8vIEFnZW50Q29yZSBnZW5lcmF0ZXMgYSBDZWRhciBhY3Rpb24gR1JPVVAgcGVyIGdhdGV3YXkgdGFyZ2V0LCBuYW1lZCBieSB0aGVcbiAgICAvLyB0YXJnZXQgbmFtZSAoZS5nLiBBZ2VudENvcmU6OkFjdGlvbjo6XCJiaWxsaW5nTWNwXCIpLiBFYWNoIHRvb2wgYWN0aW9uXG4gICAgLy8gKDx0YXJnZXQ+X19fPHRvb2w+KSBpcyBhIG1lbWJlciBvZiBpdHMgdGFyZ2V0J3MgZ3JvdXAsIHNvIHdlIGNhbiBzY29wZSBhXG4gICAgLy8gcG9saWN5IHRvIGFuIGVudGlyZSBjYXRlZ29yeSBieSByZWZlcmVuY2luZyB0aGUgdGFyZ2V0IG5hbWUgd2UgYWxyZWFkeVxuICAgIC8vIGtub3cgZnJvbSBDREsg4oCUIG5vIHBlci10b29sIGVudW1lcmF0aW9uIG9yIHJ1bnRpbWUgZGlzY292ZXJ5IHJlcXVpcmVkLlxuICAgIC8vIFRoZXJlIGlzIG5vIGB0b29sX2NhdGVnb3J5YCBhdHRyaWJ1dGU7IHRoZSBwcmlvciBkZXNpZ24gYXNzdW1wdGlvbiB3YXNcbiAgICAvLyB3cm9uZyBhbmQgaXMgY29ycmVjdGVkIGhlcmUuXG4gICAgLy9cbiAgICAvLyBQdXJlLXBlcm1pdCBtb2RlbCBvdmVyIHRoZSBmaXZlIHRhcmdldCBncm91cHMgKENlZGFyIGlzIGRlbnktYnktZGVmYXVsdCxcbiAgICAvLyBmb3JiaWQtb3ZlcnJpZGVzLXBlcm1pdCk6XG4gICAgLy8gICAqIGJpbGxpbmcgKyBwcmljaW5nICAtPiBwZXJtaXR0ZWQgZm9yIGV2ZXJ5IGF1dGhlbnRpY2F0ZWQgdXNlcjtcbiAgICAvLyAgICogY2xvdWR3YXRjaCArIGNsb3VkdHJhaWwgKyBpbnZlbnRvcnkgLT4gcGVybWl0dGVkIG9ubHkgd2hlbiB0aGVcbiAgICAvLyAgICAgdmVyaWZpZWQgSldUIGByb2xlYCBjbGFpbSAoYSBwcmluY2lwYWwgdGFnKSA9PSBcImFkbWluXCI7XG4gICAgLy8gICAqIGV2ZXJ5dGhpbmcgZWxzZSAoaW5jbC4gYW55IGZ1dHVyZSB0YXJnZXQgYWRkZWQgbGF0ZXIpIC0+IGRlbmllZCBieVxuICAgIC8vICAgICBkZWZhdWx0IGZvciBub24tYWRtaW5zLCBzYXRpc2Z5aW5nIHRoZSBkZWZhdWx0LWRlbnkgcmVxdWlyZW1lbnQuXG4gICAgLy8gVGhlIHNlbWFudGljLXNlYXJjaCAvIHRvb2xzLWxpc3QgbWV0YS1vcGVyYXRpb25zIGFyZSBOT1QgUG9saWN5LWdvdmVybmVkXG4gICAgLy8gdGFyZ2V0cywgc28gdGhpcyBtb2RlbCBkb2VzIG5vdCBhZmZlY3QgdG9vbCBkaXNjb3ZlcnkuXG5cbiAgICBjb25zdCBhbGxVc2Vyc0NlZGFyID0gW1xuICAgICAgJ3Blcm1pdCgnLFxuICAgICAgJyAgcHJpbmNpcGFsIGlzIEFnZW50Q29yZTo6T0F1dGhVc2VyLCcsXG4gICAgICAnICBhY3Rpb24gaW4gW0FnZW50Q29yZTo6QWN0aW9uOjpcImJpbGxpbmdNY3BcIiwgQWdlbnRDb3JlOjpBY3Rpb246OlwicHJpY2luZ01jcFwiXSwnLFxuICAgICAgYCAgcmVzb3VyY2UgPT0gQWdlbnRDb3JlOjpHYXRld2F5OjpcIiR7Z2F0ZXdheUFyblJlZn1cImAsXG4gICAgICAnKTsnLFxuICAgIF0uam9pbignXFxuJyk7XG5cbiAgICBjb25zdCBhZG1pbk9ubHlDZWRhciA9IFtcbiAgICAgICdwZXJtaXQoJyxcbiAgICAgICcgIHByaW5jaXBhbCBpcyBBZ2VudENvcmU6Ok9BdXRoVXNlciwnLFxuICAgICAgJyAgYWN0aW9uIGluIFtBZ2VudENvcmU6OkFjdGlvbjo6XCJjbG91ZHdhdGNoTWNwXCIsIEFnZW50Q29yZTo6QWN0aW9uOjpcImNsb3VkdHJhaWxNY3BcIiwgQWdlbnRDb3JlOjpBY3Rpb246OlwiaW52ZW50b3J5TWNwXCJdLCcsXG4gICAgICBgICByZXNvdXJjZSA9PSBBZ2VudENvcmU6OkdhdGV3YXk6OlwiJHtnYXRld2F5QXJuUmVmfVwiYCxcbiAgICAgICcpIHdoZW4geycsXG4gICAgICAnICBwcmluY2lwYWwuaGFzVGFnKFwicm9sZVwiKSAmJicsXG4gICAgICAnICBwcmluY2lwYWwuZ2V0VGFnKFwicm9sZVwiKSA9PSBcImFkbWluXCInLFxuICAgICAgJ307JyxcbiAgICBdLmpvaW4oJ1xcbicpO1xuXG4gICAgY29uc3QgcG9saWN5RW5naW5lUG9saWNpZXMgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdQb2xpY3lFbmdpbmVQb2xpY2llcycsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogcG9saWN5RW5naW5lRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIE9wZXJhdGlvbjogJ1BPTElDSUVTJyxcbiAgICAgICAgUG9saWN5RW5naW5lSWQ6IHBvbGljeUVuZ2luZUlkLFxuICAgICAgICAvLyBWYWxpZGF0ZSBzdHJpY3RseSBhZ2FpbnN0IHRoZSBnYXRld2F5J3MgZ2VuZXJhdGVkIENlZGFyIHNjaGVtYSBzbyBhXG4gICAgICAgIC8vIG1hbGZvcm1lZCBwb2xpY3kgZmFpbHMgdGhlIGRlcGxveW1lbnQgbG91ZGx5IGluc3RlYWQgb2YgbGFuZGluZyBpbiBhXG4gICAgICAgIC8vIHNpbGVudCBhc3luYyBDUkVBVEVfRkFJTEVEIHN0YXRlLiBUaGUgY3VzdG9tLXJlc291cmNlIExhbWJkYSBwb2xsc1xuICAgICAgICAvLyBlYWNoIHBvbGljeSB0byBBQ1RJVkUgYW5kIGZhaWxzIGlmIHZhbGlkYXRpb24gZG9lcyBub3QgcGFzcy5cbiAgICAgICAgVmFsaWRhdGlvbk1vZGU6ICdGQUlMX09OX0FOWV9GSU5ESU5HUycsXG4gICAgICAgIFJlZ2lvbjogdGhpcy5yZWdpb24sXG4gICAgICAgIFN0YXRlbWVudHM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICAvLyBQb2xpY3kgbmFtZXMgbXVzdCBtYXRjaCBeW0EtWmEtel1bQS1aYS16MC05X10qJCAobm8gaHlwaGVucykuXG4gICAgICAgICAgICBOYW1lOiAnYWxsb3dfYmlsbGluZ19wcmljaW5nX2FsbF91c2VycycsXG4gICAgICAgICAgICBEZXNjcmlwdGlvbjogJ1Blcm1pdCBiaWxsaW5nIGFuZCBwcmljaW5nIHRvb2xzIGZvciBldmVyeSBhdXRoZW50aWNhdGVkIHVzZXIuJyxcbiAgICAgICAgICAgIFN0YXRlbWVudDogYWxsVXNlcnNDZWRhcixcbiAgICAgICAgICB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIE5hbWU6ICdhbGxvd19vcHNfY2F0ZWdvcmllc19hZG1pbl9vbmx5JyxcbiAgICAgICAgICAgIERlc2NyaXB0aW9uOiAnUGVybWl0IGNsb3Vkd2F0Y2gsIGNsb3VkdHJhaWwsIGFuZCBpbnZlbnRvcnkgdG9vbHMgb25seSBmb3Igcm9sZSA9PSBhZG1pbi4nLFxuICAgICAgICAgICAgU3RhdGVtZW50OiBhZG1pbk9ubHlDZWRhcixcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIFBvbGljaWVzIGFyZSB2YWxpZGF0ZWQgYWdhaW5zdCB0aGUgQ2VkYXIgc2NoZW1hIGdlbmVyYXRlZCBmcm9tIHRoZVxuICAgIC8vIGdhdGV3YXkncyB0b29scywgc28gdGhleSBtdXN0IGJlIGNyZWF0ZWQgYWZ0ZXIgdGhlIGdhdGV3YXkgYW5kIGV2ZXJ5XG4gICAgLy8gdGFyZ2V0IGV4aXN0LlxuICAgIHBvbGljeUVuZ2luZVBvbGljaWVzLm5vZGUuYWRkRGVwZW5kZW5jeShnYXRld2F5KTtcbiAgICBwb2xpY3lFbmdpbmVQb2xpY2llcy5ub2RlLmFkZERlcGVuZGVuY3koYmlsbGluZ1RhcmdldCk7XG4gICAgcG9saWN5RW5naW5lUG9saWNpZXMubm9kZS5hZGREZXBlbmRlbmN5KHByaWNpbmdUYXJnZXQpO1xuICAgIHBvbGljeUVuZ2luZVBvbGljaWVzLm5vZGUuYWRkRGVwZW5kZW5jeShjbG91ZHdhdGNoTWNwVGFyZ2V0KTtcbiAgICBwb2xpY3lFbmdpbmVQb2xpY2llcy5ub2RlLmFkZERlcGVuZGVuY3koY2xvdWR0cmFpbE1jcFRhcmdldCk7XG4gICAgcG9saWN5RW5naW5lUG9saWNpZXMubm9kZS5hZGREZXBlbmRlbmN5KGludmVudG9yeU1jcFRhcmdldCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdHYXRld2F5QXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuZ2F0ZXdheUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQWdlbnRDb3JlIEdhdGV3YXkgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1HYXRld2F5QXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdHYXRld2F5VXJsJywge1xuICAgICAgdmFsdWU6IHRoaXMuZ2F0ZXdheVVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQWdlbnRDb3JlIEdhdGV3YXkgVVJMJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1HYXRld2F5VXJsYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdQb2xpY3lFbmdpbmVBcm4nLCB7XG4gICAgICB2YWx1ZTogcG9saWN5RW5naW5lQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBZ2VudENvcmUgUG9saWN5IEVuZ2luZSBBUk4gKENlZGFyIHJvbGUtYmFzZWQgdG9vbCBhdXRob3JpemF0aW9uKScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tUG9saWN5RW5naW5lQXJuYCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDREstTmFnIFN1cHByZXNzaW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhnYXRld2F5Um9sZSwgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JywgcmVhc29uOiAnV2lsZGNhcmQgZm9yIEFnZW50Q29yZSBJZGVudGl0eSB0b2tlbiBleGNoYW5nZSBhbmQgT0F1dGggcHJvdmlkZXIgbWFuYWdlbWVudC4nIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMob2F1dGhQcm92aWRlckZuLCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLCByZWFzb246ICdXaWxkY2FyZCByZXF1aXJlZCBmb3IgQWdlbnRDb3JlIElkZW50aXR5IHRva2VuIHZhdWx0IGNyZWF0aW9uIGFuZCBiZWRyb2NrLWFnZW50Y29yZS1pZGVudGl0eSBzZWNyZXRzIG5hbWVzcGFjZS4nIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMocG9saWN5RW5naW5lRm4sIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ1dpbGRjYXJkIHJlcXVpcmVkIGZvciBBZ2VudENvcmUgUG9saWN5IGVuZ2luZS9wb2xpY3kgbWFuYWdlbWVudCAoQ3JlYXRlUG9saWN5RW5naW5lL0NyZWF0ZVBvbGljeSBvcGVyYXRlIG9uIHJlc291cmNlcyBjcmVhdGVkIGF0IGRlcGxveSB0aW1lKS4nIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkU3RhY2tTdXBwcmVzc2lvbnModGhpcywgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JywgcmVhc29uOiAnQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIGlzIEFXUyBiZXN0IHByYWN0aWNlLicsIGFwcGxpZXNUbzogWydQb2xpY3k6OmFybjo8QVdTOjpQYXJ0aXRpb24+OmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlJ10gfSxcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ1dpbGRjYXJkIGZvciBBZ2VudENvcmUgSWRlbnRpdHkgdG9rZW4gZXhjaGFuZ2UsIE9BdXRoIGNyZWRlbnRpYWwgcHJvdmlkZXIgbWFuYWdlbWVudC4nLCBhcHBsaWVzVG86IFsnUmVzb3VyY2U6OionXSB9LFxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1MMScsIHJlYXNvbjogJ0xhbWJkYSBydW50aW1lIHZlcnNpb24gbWFuYWdlZCBieSBDREsuJyB9LFxuICAgIF0pO1xuICB9XG59XG4iXX0=