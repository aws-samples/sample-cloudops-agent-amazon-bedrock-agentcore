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
const observability_1 = require("./observability");
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
        //   * Native service spans complement, but do not duplicate, the canonical
        //     four-field deny-audit record. Do not enable payload-bearing application logs.
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
        const tracedResources = {
            Gateway: this.gatewayArn,
            GatewayIdentity: (0, observability_1.workloadIdentityArn)(this, this.gatewayArn),
            OAuthProvider: oauthProviderArn,
        };
        for (const [name, arn] of Object.entries({
            Billing: props.billingMcpRuntimeArn,
            Pricing: props.pricingMcpRuntimeArn,
            CloudWatch: props.cloudwatchMcpRuntimeArn,
            CloudTrail: props.cloudtrailMcpRuntimeArn,
            Inventory: props.inventoryMcpRuntimeArn,
        })) {
            tracedResources[name] = arn;
            tracedResources[`${name}Identity`] = (0, observability_1.workloadIdentityArn)(this, arn);
        }
        (0, observability_1.addTracing)(this, tracedResources);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2F0ZXdheS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImdhdGV3YXktc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHlEQUEyQztBQUMzQywrREFBaUQ7QUFDakQsMkRBQTZDO0FBQzdDLGlFQUFtRDtBQUVuRCwyQ0FBNkI7QUFDN0IscUNBQTBDO0FBQzFDLG1EQUFrRTtBQXNCbEUsTUFBYSxxQkFBc0IsU0FBUSxHQUFHLENBQUMsS0FBSztJQUlsRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQWlDO1FBQ3pFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDJDQUEyQztRQUMzQyx1Q0FBdUM7UUFDdkMsMkNBQTJDO1FBRTNDLE1BQU0saUJBQWlCLEdBQUcsSUFBSSxFQUFFLENBQUMsaUJBQWlCLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQzVFLFFBQVEsRUFBRTtnQkFDUixPQUFPLEVBQUUsZ0NBQWdDO2dCQUN6QyxNQUFNLEVBQUUsd0JBQXdCO2dCQUNoQyxVQUFVLEVBQUU7b0JBQ1YsVUFBVSxFQUFFLEtBQUssQ0FBQyxjQUFjO29CQUNoQyxRQUFRLEVBQUUsS0FBSyxDQUFDLGVBQWU7aUJBQ2hDO2dCQUNELGtCQUFrQixFQUFFLEVBQUUsQ0FBQyxrQkFBa0IsQ0FBQyxFQUFFLENBQUMsbUJBQW1CLENBQUM7YUFDbEU7WUFDRCxNQUFNLEVBQUUsRUFBRSxDQUFDLHVCQUF1QixDQUFDLGNBQWMsQ0FBQztnQkFDaEQsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO29CQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO29CQUN4QixPQUFPLEVBQUUsQ0FBQyxvQ0FBb0MsQ0FBQztvQkFDL0MsU0FBUyxFQUFFLENBQUMsS0FBSyxDQUFDLGVBQWUsQ0FB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QUFDLG9CQUFvQixDQUFDLElBQUksRUFBRTtZQUN6QyxFQUFFLEVBQUUsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLEVBQUUsbURBQW1ELEVBQUUsU0FBUyxFQUFFLENBQUMsdUZBQXVGLENBQUMsRUFBRTtZQUM5TCxFQUFFLEVBQUUsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLEVBQUUsdUZBQXVGLEVBQUUsU0FBUyxFQUFFLENBQUMsYUFBYSxDQUFDLEVBQUU7WUFDeEosRUFBRSxFQUFFLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxFQUFFLHdDQUF3QyxFQUFFO1NBQzVFLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQTVnQ0Qsc0RBNGdDQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCAqIGFzIGNyIGZyb20gJ2F3cy1jZGstbGliL2N1c3RvbS1yZXNvdXJjZXMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgTmFnU3VwcHJlc3Npb25zIH0gZnJvbSAnY2RrLW5hZyc7XG5pbXBvcnQgeyBhZGRUcmFjaW5nLCB3b3JrbG9hZElkZW50aXR5QXJuIH0gZnJvbSAnLi9vYnNlcnZhYmlsaXR5JztcblxuZXhwb3J0IGludGVyZmFjZSBBZ2VudENvcmVHYXRld2F5U3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgLy8gTUNQIFJ1bnRpbWUgZW5kcG9pbnRzIGZyb20gTUNQUnVudGltZVN0YWNrXG4gIGJpbGxpbmdNY3BSdW50aW1lQXJuOiBzdHJpbmc7XG4gIGJpbGxpbmdNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcbiAgcHJpY2luZ01jcFJ1bnRpbWVBcm46IHN0cmluZztcbiAgcHJpY2luZ01jcFJ1bnRpbWVFbmRwb2ludDogc3RyaW5nO1xuICBjbG91ZHdhdGNoTWNwUnVudGltZUFybjogc3RyaW5nO1xuICBjbG91ZHdhdGNoTWNwUnVudGltZUVuZHBvaW50OiBzdHJpbmc7XG4gIGNsb3VkdHJhaWxNY3BSdW50aW1lQXJuOiBzdHJpbmc7XG4gIGNsb3VkdHJhaWxNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcbiAgaW52ZW50b3J5TWNwUnVudGltZUFybjogc3RyaW5nO1xuICBpbnZlbnRvcnlNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcbiAgLy8gQXV0aFN0YWNrIENvZ25pdG8gLSB1c2VkIGZvciBPQXV0aCBwcm92aWRlciAob3V0Ym91bmQgYXV0aCB0byBydW50aW1lcylcbiAgYXV0aFVzZXJQb29sSWQ6IHN0cmluZztcbiAgYXV0aFVzZXJQb29sQXJuOiBzdHJpbmc7XG4gIGF1dGhNMm1DbGllbnRJZDogc3RyaW5nO1xuICAvLyBGcm9udEVuZCBVc2VyIFBvb2wgY2xpZW50IElEIC0gYWxsb3dlZCBhdWRpZW5jZSBmb3IgaW5ib3VuZCBDVVNUT01fSldUIGF1dGhvcml6YXRpb25cbiAgYXV0aFVzZXJQb29sQ2xpZW50SWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEFnZW50Q29yZUdhdGV3YXlTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBnYXRld2F5QXJuOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBnYXRld2F5VXJsOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFnZW50Q29yZUdhdGV3YXlTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gUmV0cmlldmUgQXV0aFN0YWNrIE0yTSBjbGllbnQgc2VjcmV0XG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgZGVzY3JpYmVNMk1DbGllbnQgPSBuZXcgY3IuQXdzQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0Rlc2NyaWJlTTJNQ2xpZW50Jywge1xuICAgICAgb25DcmVhdGU6IHtcbiAgICAgICAgc2VydmljZTogJ0NvZ25pdG9JZGVudGl0eVNlcnZpY2VQcm92aWRlcicsXG4gICAgICAgIGFjdGlvbjogJ2Rlc2NyaWJlVXNlclBvb2xDbGllbnQnLFxuICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgVXNlclBvb2xJZDogcHJvcHMuYXV0aFVzZXJQb29sSWQsXG4gICAgICAgICAgQ2xpZW50SWQ6IHByb3BzLmF1dGhNMm1DbGllbnRJZCxcbiAgICAgICAgfSxcbiAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoJ20ybS1jbGllbnQtc2VjcmV0JyksXG4gICAgICB9LFxuICAgICAgcG9saWN5OiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5mcm9tU3RhdGVtZW50cyhbXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgYWN0aW9uczogWydjb2duaXRvLWlkcDpEZXNjcmliZVVzZXJQb29sQ2xpZW50J10sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbcHJvcHMuYXV0aFVzZXJQb29sQXJuXSxcbiAgICAgICAgfSksXG4gICAgICBdKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IG0ybUNsaWVudFNlY3JldCA9IGRlc2NyaWJlTTJNQ2xpZW50LmdldFJlc3BvbnNlRmllbGQoJ1VzZXJQb29sQ2xpZW50LkNsaWVudFNlY3JldCcpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEdhdGV3YXkgVG9rZW4gRXhjaGFuZ2UgUG9saWN5IChtYW5hZ2VkIHBvbGljeSwgd2lsZGNhcmQpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgdG9rZW5FeGNoYW5nZVBvbGljeSA9IG5ldyBpYW0uTWFuYWdlZFBvbGljeSh0aGlzLCAnR2F0ZXdheVRva2VuRXhjaGFuZ2VQb2xpY3knLCB7XG4gICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBzaWQ6ICdBZ2VudENvcmVJZGVudGl0eVRva2VuRXhjaGFuZ2UnLFxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0V29ya2xvYWRBY2Nlc3NUb2tlbicsXG4gICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0UmVzb3VyY2VPYXV0aDJUb2tlbicsXG4gICAgICAgICAgXSxcbiAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgICB9KSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gR2F0ZXdheSBTZXJ2aWNlIFJvbGVcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBjb25zdCBnYXRld2F5Um9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnR2F0ZXdheVNlcnZpY2VSb2xlJywge1xuICAgICAgZGVzY3JpcHRpb246ICdTZXJ2aWNlIHJvbGUgZm9yIENsb3VkT3BzIEFnZW50Q29yZSBHYXRld2F5JyxcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiZWRyb2NrLWFnZW50Y29yZS5hbWF6b25hd3MuY29tJyksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFt0b2tlbkV4Y2hhbmdlUG9saWN5XSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPQXV0aCBQcm92aWRlciAoTGFtYmRhIGN1c3RvbSByZXNvdXJjZSlcbiAgICAvLyBVc2VzIEF1dGhTdGFjaydzIENvZ25pdG8gZm9yIG91dGJvdW5kIGF1dGggdG8gTUNQIHJ1bnRpbWVzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3Qgb2F1dGhQcm92aWRlckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnT0F1dGhQcm92aWRlckZ1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTQsXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygyKSxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoYFxuaW1wb3J0IGpzb25cbmltcG9ydCBsb2dnaW5nXG5pbXBvcnQgb3NcbmltcG9ydCB1cmxsaWIucmVxdWVzdFxuaW1wb3J0IGJvdG8zXG5cbmxvZ2dlciA9IGxvZ2dpbmcuZ2V0TG9nZ2VyKClcbmxvZ2dlci5zZXRMZXZlbChsb2dnaW5nLklORk8pXG5cbmRlZiBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgc3RhdHVzLCBkYXRhPU5vbmUsIHJlYXNvbj1Ob25lLCBwaHlzaWNhbF9pZD1Ob25lKTpcbiAgICByZXNwb25zZV9ib2R5ID0ganNvbi5kdW1wcyh7XG4gICAgICAgICdTdGF0dXMnOiBzdGF0dXMsXG4gICAgICAgICdSZWFzb24nOiByZWFzb24gb3IgJ1NlZSBDbG91ZFdhdGNoIExvZ3MnLFxuICAgICAgICAnUGh5c2ljYWxSZXNvdXJjZUlkJzogcGh5c2ljYWxfaWQgb3IgZXZlbnQuZ2V0KCdQaHlzaWNhbFJlc291cmNlSWQnLCBldmVudFsnUmVxdWVzdElkJ10pLFxuICAgICAgICAnU3RhY2tJZCc6IGV2ZW50WydTdGFja0lkJ10sXG4gICAgICAgICdSZXF1ZXN0SWQnOiBldmVudFsnUmVxdWVzdElkJ10sXG4gICAgICAgICdMb2dpY2FsUmVzb3VyY2VJZCc6IGV2ZW50WydMb2dpY2FsUmVzb3VyY2VJZCddLFxuICAgICAgICAnRGF0YSc6IGRhdGEgb3Ige30sXG4gICAgfSlcbiAgICByZXNwb25zZV91cmwgPSBldmVudFsnUmVzcG9uc2VVUkwnXVxuICAgIGlmIG5vdCByZXNwb25zZV91cmwuc3RhcnRzd2l0aCgnaHR0cHM6Ly8nKTpcbiAgICAgICAgcmFpc2UgVmFsdWVFcnJvcihmJ0ludmFsaWQgcmVzcG9uc2UgVVJMIHNjaGVtZScpXG4gICAgcmVxID0gdXJsbGliLnJlcXVlc3QuUmVxdWVzdChcbiAgICAgICAgcmVzcG9uc2VfdXJsLFxuICAgICAgICBkYXRhPXJlc3BvbnNlX2JvZHkuZW5jb2RlKCd1dGYtOCcpLFxuICAgICAgICBoZWFkZXJzPXsnQ29udGVudC1UeXBlJzogJyd9LFxuICAgICAgICBtZXRob2Q9J1BVVCcsXG4gICAgKVxuICAgIHVybGxpYi5yZXF1ZXN0LnVybG9wZW4ocmVxKVxuXG5kZWYgaGFuZGxlcihldmVudCwgY29udGV4dCk6XG4gICAgbG9nZ2VyLmluZm8oJ1JlcXVlc3QgdHlwZTogJXMnLCBldmVudFsnUmVxdWVzdFR5cGUnXSlcbiAgICByZXF1ZXN0X3R5cGUgPSBldmVudFsnUmVxdWVzdFR5cGUnXVxuICAgIHByb3BzID0gZXZlbnRbJ1Jlc291cmNlUHJvcGVydGllcyddXG4gICAgcHJvdmlkZXJfbmFtZSA9IHByb3BzLmdldCgnUHJvdmlkZXJOYW1lJywgJycpXG4gICAgcmVnaW9uID0gcHJvcHMuZ2V0KCdSZWdpb24nKSBvciBvcy5lbnZpcm9uLmdldCgnQVdTX1JFR0lPTicpXG4gICAgY2xpZW50ID0gYm90bzMuY2xpZW50KCdiZWRyb2NrLWFnZW50Y29yZS1jb250cm9sJywgcmVnaW9uX25hbWU9cmVnaW9uKVxuXG4gICAgaWYgcmVxdWVzdF90eXBlID09ICdEZWxldGUnOlxuICAgICAgICB0cnk6XG4gICAgICAgICAgICBjbGllbnQuZGVsZXRlX29hdXRoMl9jcmVkZW50aWFsX3Byb3ZpZGVyKG5hbWU9cHJvdmlkZXJfbmFtZSlcbiAgICAgICAgICAgIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCAnU1VDQ0VTUycpXG4gICAgICAgIGV4Y2VwdCBFeGNlcHRpb246XG4gICAgICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ1NVQ0NFU1MnKVxuICAgICAgICByZXR1cm5cblxuICAgIHRyeTpcbiAgICAgICAgcmVzcG9uc2UgPSBjbGllbnQuY3JlYXRlX29hdXRoMl9jcmVkZW50aWFsX3Byb3ZpZGVyKFxuICAgICAgICAgICAgbmFtZT1wcm92aWRlcl9uYW1lLFxuICAgICAgICAgICAgY3JlZGVudGlhbFByb3ZpZGVyVmVuZG9yPSdDdXN0b21PYXV0aDInLFxuICAgICAgICAgICAgb2F1dGgyUHJvdmlkZXJDb25maWdJbnB1dD17XG4gICAgICAgICAgICAgICAgJ2N1c3RvbU9hdXRoMlByb3ZpZGVyQ29uZmlnJzoge1xuICAgICAgICAgICAgICAgICAgICAnb2F1dGhEaXNjb3ZlcnknOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAnZGlzY292ZXJ5VXJsJzogcHJvcHMuZ2V0KCdEaXNjb3ZlcnlVcmwnLCAnJyksXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICdjbGllbnRJZCc6IHByb3BzLmdldCgnQ2xpZW50SWQnLCAnJyksXG4gICAgICAgICAgICAgICAgICAgICdjbGllbnRTZWNyZXQnOiBwcm9wcy5nZXQoJ0NsaWVudFNlY3JldCcsICcnKSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgKVxuICAgICAgICBwcm92aWRlcl9hcm4gPSByZXNwb25zZS5nZXQoJ2NyZWRlbnRpYWxQcm92aWRlckFybicsICcnKVxuICAgICAgICBzZWNyZXRfYXJuID0gcmVzcG9uc2UuZ2V0KCdjbGllbnRTZWNyZXRBcm4nLCB7fSkuZ2V0KCdzZWNyZXRBcm4nLCAnJylcbiAgICAgICAgbG9nZ2VyLmluZm8oZidDcmVhdGVkIHByb3ZpZGVyOiB7cHJvdmlkZXJfYXJufScpXG4gICAgICAgIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCAnU1VDQ0VTUycsIGRhdGE9e1xuICAgICAgICAgICAgJ1Byb3ZpZGVyQXJuJzogcHJvdmlkZXJfYXJuLFxuICAgICAgICAgICAgJ1NlY3JldEFybic6IHNlY3JldF9hcm4sXG4gICAgICAgIH0sIHBoeXNpY2FsX2lkPXByb3ZpZGVyX25hbWUpXG4gICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxuICAgICAgICBsb2dnZXIuZXJyb3IoZidDcmVhdGUgZmFpbGVkOiB7ZX0nKVxuICAgICAgICBzZW5kX2Nmbl9yZXNwb25zZShldmVudCwgJ0ZBSUxFRCcsIHJlYXNvbj1zdHIoZSkpXG5gKSxcbiAgICB9KTtcblxuICAgIC8vIFdpbGRjYXJkIHJlc291cmNlIGlzIFJFUVVJUkVEIGhlcmUgYW5kIGNhbm5vdCBiZSBzY29wZWQgZnVydGhlcjogdGhlc2UgYXJlXG4gICAgLy8gYWNjb3VudC1sZXZlbCBjb250cm9sLXBsYW5lIGFjdGlvbnMgb24gdGhlIEFnZW50Q29yZSBpZGVudGl0eSBzdG9yZS4gVGhlXG4gICAgLy8gT0F1dGgyIGNyZWRlbnRpYWwgcHJvdmlkZXIgYW5kIHRva2VuIHZhdWx0IGRvIG5vdCBleGlzdCB5ZXQgKHRoaXMgY3VzdG9tXG4gICAgLy8gcmVzb3VyY2UgQ1JFQVRFUyB0aGVtKSwgc28gdGhlaXIgQVJOcyBhcmUgdW5rbm93biBhdCBwb2xpY3ktZGVmaW5pdGlvblxuICAgIC8vIHRpbWUsIGFuZCBBZ2VudENvcmUgZG9lcyBub3Qgc3VwcG9ydCByZXNvdXJjZS1sZXZlbCBzY29waW5nIGZvciB0aGVcbiAgICAvLyBDcmVhdGUqL0dldCogdG9rZW4tdmF1bHQgLyBjcmVkZW50aWFsLXByb3ZpZGVyIGFjdGlvbnMuIFRoZSBibGFzdCByYWRpdXNcbiAgICAvLyBpcyBjb250YWluZWQgdG8gdGhlIGJlZHJvY2stYWdlbnRjb3JlIGlkZW50aXR5IEFQSXMgKG5vIGRhdGEtcGxhbmUgb3IgSUFNXG4gICAgLy8gYWN0aW9ucyksIHRoZSBmdW5jdGlvbiBydW5zIG9ubHkgYXMgYSBDbG91ZEZvcm1hdGlvbiBjdXN0b20gcmVzb3VyY2UsIGFuZFxuICAgIC8vIHRoZSByZWxhdGVkIFNlY3JldHMgTWFuYWdlciBncmFudCBiZWxvdyBJUyBzY29wZWQgdG8gdGhlXG4gICAgLy8gYmVkcm9jay1hZ2VudGNvcmUtaWRlbnRpdHkqIHNlY3JldCBwcmVmaXguXG4gICAgb2F1dGhQcm92aWRlckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBzaWQ6ICdBZ2VudENvcmVJZGVudGl0eVByb3ZpZGVyTWFuYWdlbWVudCcsXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpDcmVhdGVPYXV0aDJDcmVkZW50aWFsUHJvdmlkZXInLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6RGVsZXRlT2F1dGgyQ3JlZGVudGlhbFByb3ZpZGVyJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldE9hdXRoMkNyZWRlbnRpYWxQcm92aWRlcicsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpDcmVhdGVUb2tlblZhdWx0JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldFRva2VuVmF1bHQnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgb2F1dGhQcm92aWRlckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdzZWNyZXRzbWFuYWdlcjpDcmVhdGVTZWNyZXQnLFxuICAgICAgICAnc2VjcmV0c21hbmFnZXI6RGVsZXRlU2VjcmV0JyxcbiAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOlB1dFNlY3JldFZhbHVlJyxcbiAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOlRhZ1Jlc291cmNlJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgYGFybjphd3M6c2VjcmV0c21hbmFnZXI6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnNlY3JldDpiZWRyb2NrLWFnZW50Y29yZS1pZGVudGl0eSpgLFxuICAgICAgXSxcbiAgICB9KSk7XG5cbiAgICBjb25zdCBvYXV0aFByb3ZpZGVyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnT0F1dGhQcm92aWRlcicsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogb2F1dGhQcm92aWRlckZuLmZ1bmN0aW9uQXJuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBQcm92aWRlck5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1vYXV0aC1wcm92aWRlcmAsXG4gICAgICAgIERpc2NvdmVyeVVybDogYGh0dHBzOi8vY29nbml0by1pZHAuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS8ke3Byb3BzLmF1dGhVc2VyUG9vbElkfS8ud2VsbC1rbm93bi9vcGVuaWQtY29uZmlndXJhdGlvbmAsXG4gICAgICAgIENsaWVudElkOiBwcm9wcy5hdXRoTTJtQ2xpZW50SWQsXG4gICAgICAgIENsaWVudFNlY3JldDogbTJtQ2xpZW50U2VjcmV0LFxuICAgICAgICBSZWdpb246IHRoaXMucmVnaW9uLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IG9hdXRoUHJvdmlkZXJBcm4gPSBvYXV0aFByb3ZpZGVyLmdldEF0dFN0cmluZygnUHJvdmlkZXJBcm4nKTtcbiAgICBjb25zdCBvYXV0aFNlY3JldEFybiA9IG9hdXRoUHJvdmlkZXIuZ2V0QXR0U3RyaW5nKCdTZWNyZXRBcm4nKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEZWZhdWx0IFBvbGljeSBvbiBHYXRld2F5IFJvbGUgKHNjb3BlZCB0byBPQXV0aCBwcm92aWRlciByZXNvdXJjZXMpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgZ2F0ZXdheVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0UmVzb3VyY2VPYXV0aDJUb2tlbicsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRXb3JrbG9hZEFjY2Vzc1Rva2VuJyxcbiAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkdldFNlY3JldFZhbHVlJyxcbiAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlc2NyaWJlU2VjcmV0JyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtvYXV0aFByb3ZpZGVyQXJuLCBvYXV0aFNlY3JldEFybl0sXG4gICAgfSkpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEFnZW50Q29yZSBQb2xpY3kgRW5naW5lIChMYW1iZGEgY3VzdG9tIHJlc291cmNlKVxuICAgIC8vXG4gICAgLy8gVGhlIGluc3RhbGxlZCBDREsgYWxwaGEgbW9kdWxlIChAYXdzLWNkay9hd3MtYmVkcm9jay1hZ2VudGNvcmUtYWxwaGFcbiAgICAvLyAyLjIzNS54KSBkb2VzIE5PVCB5ZXQgc2hpcCB0aGUgUG9saWN5IHN1Ym1vZHVsZSAoUG9saWN5RW5naW5lIC8gUG9saWN5IC9cbiAgICAvLyBQb2xpY3lTdGF0ZW1lbnQpIOKAlCB0aG9zZSBjb25zdHJ1Y3RzIHdlcmUgYWRkZWQgaW4gYSBsYXRlciBhbHBoYSByZWxlYXNlLlxuICAgIC8vIFRoZXJlIGlzIGFsc28gbm8gZmlyc3QtY2xhc3MgTDEgZm9yIHRoZSBlbmdpbmUvcG9saWNpZXMgKG9ubHkgdGhlXG4gICAgLy8gZ2F0ZXdheS1zaWRlIGBQb2xpY3lFbmdpbmVDb25maWd1cmF0aW9uYCBleGlzdHMpLiBXZSB0aGVyZWZvcmUgY3JlYXRlIHRoZVxuICAgIC8vIGVuZ2luZSBhbmQgaXRzIENlZGFyIHBvbGljaWVzIHZpYSB0aGUgYGJlZHJvY2stYWdlbnRjb3JlLWNvbnRyb2xgIGNvbnRyb2xcbiAgICAvLyBwbGFuZSBiZWhpbmQgYSBDREsgY3VzdG9tIHJlc291cmNlLCBtaXJyb3JpbmcgdGhlIE9BdXRoUHJvdmlkZXIgcGF0dGVyblxuICAgIC8vIGFib3ZlLlxuICAgIC8vXG4gICAgLy8gRmxvdzpcbiAgICAvLyAgIDEuIFBvbGljeUVuZ2luZSBjdXN0b20gcmVzb3VyY2UgIC0+IGNyZWF0ZV9wb2xpY3lfZW5naW5lLCB3YWl0IEFDVElWRSxcbiAgICAvLyAgICAgIHJldHVybnMgdGhlIGVuZ2luZSBBUk4vSUQuXG4gICAgLy8gICAyLiBHYXRld2F5IGNhcnJpZXMgUG9saWN5RW5naW5lQ29uZmlndXJhdGlvbi5Bcm4gPSBlbmdpbmUgQVJOIHNvIHRoZVxuICAgIC8vICAgICAgZW5naW5lIGlzIGFzc29jaWF0ZWQgd2l0aCB0aGUgZ2F0ZXdheSAoTW9kZSA9IEVORk9SQ0UpLlxuICAgIC8vICAgMy4gUG9saWN5RW5naW5lUG9saWNpZXMgY3VzdG9tIHJlc291cmNlIC0+IGNyZWF0ZV9wb2xpY3kgZm9yIGVhY2ggQ2VkYXJcbiAgICAvLyAgICAgIHN0YXRlbWVudC4gSXQgZGVwZW5kcyBvbiB0aGUgZ2F0ZXdheSArIGFsbCB0YXJnZXRzIHNvIHRoZSBDZWRhclxuICAgIC8vICAgICAgc2NoZW1hIChnZW5lcmF0ZWQgZnJvbSB0aGUgdGFyZ2V0cycgdG9vbCBpbnB1dCBzY2hlbWFzKSBleGlzdHMgd2hlblxuICAgIC8vICAgICAgdGhlIHBvbGljaWVzIGFyZSB2YWxpZGF0ZWQuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgcG9saWN5RW5naW5lRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdQb2xpY3lFbmdpbmVGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzE0LFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMTApLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUlubGluZShgXG5pbXBvcnQganNvblxuaW1wb3J0IGxvZ2dpbmdcbmltcG9ydCBvc1xuaW1wb3J0IHJlXG5pbXBvcnQgdGltZVxuaW1wb3J0IHVybGxpYi5yZXF1ZXN0XG5pbXBvcnQgYm90bzNcbmZyb20gYm90b2NvcmUuZXhjZXB0aW9ucyBpbXBvcnQgQ2xpZW50RXJyb3JcblxubG9nZ2VyID0gbG9nZ2luZy5nZXRMb2dnZXIoKVxubG9nZ2VyLnNldExldmVsKGxvZ2dpbmcuSU5GTylcblxuXG5kZWYgX2NsaWVudF90b2tlbih2YWx1ZSk6XG4gICAgIyBjbGllbnRUb2tlbiBtdXN0IG1hdGNoIF5bYS16QS1aMC05XSgtKlthLXpBLVowLTldKXswLDI1Nn0kIOKAlCBub1xuICAgICMgdW5kZXJzY29yZXMuIFJlZHVjZSB0byBhbHBoYW51bWVyaWNzIG9ubHkgKGFsd2F5cyB2YWxpZCkgYW5kIGNhcCBsZW5ndGguXG4gICAgdG9rZW4gPSByZS5zdWIocidbXmEtekEtWjAtOV0nLCAnJywgdmFsdWUpXG4gICAgcmV0dXJuIHRva2VuWzoyNTZdIG9yICd0b2tlbidcblxuXG5kZWYgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsIHN0YXR1cywgZGF0YT1Ob25lLCByZWFzb249Tm9uZSwgcGh5c2ljYWxfaWQ9Tm9uZSk6XG4gICAgcmVzcG9uc2VfYm9keSA9IGpzb24uZHVtcHMoe1xuICAgICAgICAnU3RhdHVzJzogc3RhdHVzLFxuICAgICAgICAnUmVhc29uJzogcmVhc29uIG9yICdTZWUgQ2xvdWRXYXRjaCBMb2dzJyxcbiAgICAgICAgJ1BoeXNpY2FsUmVzb3VyY2VJZCc6IHBoeXNpY2FsX2lkIG9yIGV2ZW50LmdldCgnUGh5c2ljYWxSZXNvdXJjZUlkJywgZXZlbnRbJ1JlcXVlc3RJZCddKSxcbiAgICAgICAgJ1N0YWNrSWQnOiBldmVudFsnU3RhY2tJZCddLFxuICAgICAgICAnUmVxdWVzdElkJzogZXZlbnRbJ1JlcXVlc3RJZCddLFxuICAgICAgICAnTG9naWNhbFJlc291cmNlSWQnOiBldmVudFsnTG9naWNhbFJlc291cmNlSWQnXSxcbiAgICAgICAgJ0RhdGEnOiBkYXRhIG9yIHt9LFxuICAgIH0pXG4gICAgcmVzcG9uc2VfdXJsID0gZXZlbnRbJ1Jlc3BvbnNlVVJMJ11cbiAgICBpZiBub3QgcmVzcG9uc2VfdXJsLnN0YXJ0c3dpdGgoJ2h0dHBzOi8vJyk6XG4gICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoJ0ludmFsaWQgcmVzcG9uc2UgVVJMIHNjaGVtZScpXG4gICAgcmVxID0gdXJsbGliLnJlcXVlc3QuUmVxdWVzdChcbiAgICAgICAgcmVzcG9uc2VfdXJsLFxuICAgICAgICBkYXRhPXJlc3BvbnNlX2JvZHkuZW5jb2RlKCd1dGYtOCcpLFxuICAgICAgICBoZWFkZXJzPXsnQ29udGVudC1UeXBlJzogJyd9LFxuICAgICAgICBtZXRob2Q9J1BVVCcsXG4gICAgKVxuICAgIHVybGxpYi5yZXF1ZXN0LnVybG9wZW4ocmVxKVxuXG5cbmRlZiBfaXNfY29uZmxpY3QoZXJyKTpcbiAgICBjb2RlID0gZXJyLnJlc3BvbnNlLmdldCgnRXJyb3InLCB7fSkuZ2V0KCdDb2RlJywgJycpIGlmIGlzaW5zdGFuY2UoZXJyLCBDbGllbnRFcnJvcikgZWxzZSAnJ1xuICAgIHJldHVybiAnQ29uZmxpY3QnIGluIGNvZGUgb3IgJ0FscmVhZHlFeGlzdHMnIGluIGNvZGVcblxuXG5kZWYgX2ZpbmRfZW5naW5lX2J5X25hbWUoY2xpZW50LCBuYW1lKTpcbiAgICB0cnk6XG4gICAgICAgIHRva2VuID0gTm9uZVxuICAgICAgICB3aGlsZSBUcnVlOlxuICAgICAgICAgICAga3dhcmdzID0geyduZXh0VG9rZW4nOiB0b2tlbn0gaWYgdG9rZW4gZWxzZSB7fVxuICAgICAgICAgICAgcmVzcCA9IGNsaWVudC5saXN0X3BvbGljeV9lbmdpbmVzKCoqa3dhcmdzKVxuICAgICAgICAgICAgZm9yIGl0ZW0gaW4gcmVzcC5nZXQoJ3BvbGljeUVuZ2luZXMnLCBbXSkgb3IgcmVzcC5nZXQoJ2l0ZW1zJywgW10pOlxuICAgICAgICAgICAgICAgIGlmIGl0ZW0uZ2V0KCduYW1lJykgPT0gbmFtZTpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGl0ZW1cbiAgICAgICAgICAgIHRva2VuID0gcmVzcC5nZXQoJ25leHRUb2tlbicpXG4gICAgICAgICAgICBpZiBub3QgdG9rZW46XG4gICAgICAgICAgICAgICAgYnJlYWtcbiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4OlxuICAgICAgICBsb2dnZXIud2FybmluZyhmJ2xpc3RfcG9saWN5X2VuZ2luZXMgZmFpbGVkOiB7ZXh9JylcbiAgICByZXR1cm4gTm9uZVxuXG5cbmRlZiBfZW5naW5lX2lkKGl0ZW0pOlxuICAgIHJldHVybiBpdGVtLmdldCgncG9saWN5RW5naW5lSWQnKSBvciBpdGVtLmdldCgnaWQnKVxuXG5cbmRlZiBfd2FpdF9lbmdpbmVfYWN0aXZlKGNsaWVudCwgZW5naW5lX2lkLCB0aW1lb3V0X3M9NDgwKTpcbiAgICBkZWFkbGluZSA9IHRpbWUudGltZSgpICsgdGltZW91dF9zXG4gICAgd2hpbGUgdGltZS50aW1lKCkgPCBkZWFkbGluZTpcbiAgICAgICAgcmVzcCA9IGNsaWVudC5nZXRfcG9saWN5X2VuZ2luZShwb2xpY3lFbmdpbmVJZD1lbmdpbmVfaWQpXG4gICAgICAgIHN0YXR1cyA9IHJlc3AuZ2V0KCdzdGF0dXMnKVxuICAgICAgICBsb2dnZXIuaW5mbyhmJ2VuZ2luZSB7ZW5naW5lX2lkfSBzdGF0dXM9e3N0YXR1c30nKVxuICAgICAgICBpZiBzdGF0dXMgPT0gJ0FDVElWRSc6XG4gICAgICAgICAgICByZXR1cm4gcmVzcFxuICAgICAgICBpZiBzdGF0dXMgYW5kIHN0YXR1cy5lbmRzd2l0aCgnRkFJTEVEJyk6XG4gICAgICAgICAgICByYWlzZSBSdW50aW1lRXJyb3IoZidlbmdpbmUge2VuZ2luZV9pZH0ge3N0YXR1c306IHtyZXNwLmdldChcInN0YXR1c1JlYXNvbnNcIil9JylcbiAgICAgICAgdGltZS5zbGVlcCg1KVxuICAgIHJhaXNlIFRpbWVvdXRFcnJvcihmJ2VuZ2luZSB7ZW5naW5lX2lkfSBub3QgQUNUSVZFIHdpdGhpbiB7dGltZW91dF9zfXMnKVxuXG5cbmRlZiBfbGlzdF9wb2xpY3lfaWRzKGNsaWVudCwgZW5naW5lX2lkKTpcbiAgICBpZHMgPSBbXVxuICAgIHRva2VuID0gTm9uZVxuICAgIHdoaWxlIFRydWU6XG4gICAgICAgIGt3YXJncyA9IHsncG9saWN5RW5naW5lSWQnOiBlbmdpbmVfaWR9XG4gICAgICAgIGlmIHRva2VuOlxuICAgICAgICAgICAga3dhcmdzWyduZXh0VG9rZW4nXSA9IHRva2VuXG4gICAgICAgIHJlc3AgPSBjbGllbnQubGlzdF9wb2xpY2llcygqKmt3YXJncylcbiAgICAgICAgZm9yIGl0ZW0gaW4gcmVzcC5nZXQoJ3BvbGljaWVzJywgW10pIG9yIHJlc3AuZ2V0KCdpdGVtcycsIFtdKTpcbiAgICAgICAgICAgIHBpZCA9IGl0ZW0uZ2V0KCdwb2xpY3lJZCcpIG9yIGl0ZW0uZ2V0KCdpZCcpXG4gICAgICAgICAgICBpZiBwaWQ6XG4gICAgICAgICAgICAgICAgaWRzLmFwcGVuZChwaWQpXG4gICAgICAgIHRva2VuID0gcmVzcC5nZXQoJ25leHRUb2tlbicpXG4gICAgICAgIGlmIG5vdCB0b2tlbjpcbiAgICAgICAgICAgIGJyZWFrXG4gICAgcmV0dXJuIGlkc1xuXG5cbmRlZiBfZGVsZXRlX3BvbGljaWVzKGNsaWVudCwgZW5naW5lX2lkLCB0aW1lb3V0X3M9MTIwKTpcbiAgICAjIGRlbGV0ZV9wb2xpY3kgaXMgYXN5bmNocm9ub3VzLCBzbyBpc3N1ZSBkZWxldGVzIGZvciBldmVyeSBleGlzdGluZyBwb2xpY3lcbiAgICAjIGFuZCB0aGVuIFdBSVQgdW50aWwgdGhleSBhcmUgYWxsIGFjdHVhbGx5IGdvbmUuIFJlY3JlYXRpbmcgYSBwb2xpY3kgd2l0aFxuICAgICMgdGhlIHNhbWUgbmFtZSB3aGlsZSBhIHByaW9yIG9uZSBpcyBzdGlsbCBERUxFVElORyByYWlzZXMgYSBjb25mbGljdC5cbiAgICB0cnk6XG4gICAgICAgIGZvciBwaWQgaW4gX2xpc3RfcG9saWN5X2lkcyhjbGllbnQsIGVuZ2luZV9pZCk6XG4gICAgICAgICAgICB0cnk6XG4gICAgICAgICAgICAgICAgY2xpZW50LmRlbGV0ZV9wb2xpY3kocG9saWN5RW5naW5lSWQ9ZW5naW5lX2lkLCBwb2xpY3lJZD1waWQpXG4gICAgICAgICAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4OlxuICAgICAgICAgICAgICAgIGxvZ2dlci53YXJuaW5nKGYnZGVsZXRlX3BvbGljeSB7cGlkfSBmYWlsZWQ6IHtleH0nKVxuICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXg6XG4gICAgICAgIGxvZ2dlci53YXJuaW5nKGYnbGlzdF9wb2xpY2llcyBmYWlsZWQgZHVyaW5nIGRlbGV0ZToge2V4fScpXG4gICAgICAgIHJldHVyblxuXG4gICAgZGVhZGxpbmUgPSB0aW1lLnRpbWUoKSArIHRpbWVvdXRfc1xuICAgIHdoaWxlIHRpbWUudGltZSgpIDwgZGVhZGxpbmU6XG4gICAgICAgIHRyeTpcbiAgICAgICAgICAgIHJlbWFpbmluZyA9IF9saXN0X3BvbGljeV9pZHMoY2xpZW50LCBlbmdpbmVfaWQpXG4gICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZXg6XG4gICAgICAgICAgICBsb2dnZXIud2FybmluZyhmJ2xpc3RfcG9saWNpZXMgZmFpbGVkIHdoaWxlIHdhaXRpbmcgZm9yIGRlbGV0ZToge2V4fScpXG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgaWYgbm90IHJlbWFpbmluZzpcbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICBsb2dnZXIuaW5mbyhmJ3dhaXRpbmcgZm9yIHtsZW4ocmVtYWluaW5nKX0gcG9saWNpZXMgdG8gZmluaXNoIGRlbGV0aW5nJylcbiAgICAgICAgdGltZS5zbGVlcCg0KVxuICAgIGxvZ2dlci53YXJuaW5nKCd0aW1lZCBvdXQgd2FpdGluZyBmb3IgcG9saWN5IGRlbGV0aW9ucyB0byBjb21wbGV0ZScpXG5cblxuZGVmIGhhbmRsZV9lbmdpbmUoZXZlbnQsIGNsaWVudCk6XG4gICAgcHJvcHMgPSBldmVudFsnUmVzb3VyY2VQcm9wZXJ0aWVzJ11cbiAgICBuYW1lID0gcHJvcHNbJ0VuZ2luZU5hbWUnXVxuICAgIHJlcXVlc3RfdHlwZSA9IGV2ZW50WydSZXF1ZXN0VHlwZSddXG5cbiAgICBpZiByZXF1ZXN0X3R5cGUgPT0gJ0RlbGV0ZSc6XG4gICAgICAgIGV4aXN0aW5nID0gX2ZpbmRfZW5naW5lX2J5X25hbWUoY2xpZW50LCBuYW1lKVxuICAgICAgICBpZiBleGlzdGluZzpcbiAgICAgICAgICAgIGVpZCA9IF9lbmdpbmVfaWQoZXhpc3RpbmcpXG4gICAgICAgICAgICBfZGVsZXRlX3BvbGljaWVzKGNsaWVudCwgZWlkKVxuICAgICAgICAgICAgdHJ5OlxuICAgICAgICAgICAgICAgIGNsaWVudC5kZWxldGVfcG9saWN5X2VuZ2luZShwb2xpY3lFbmdpbmVJZD1laWQpXG4gICAgICAgICAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGV4OlxuICAgICAgICAgICAgICAgIGxvZ2dlci53YXJuaW5nKGYnZGVsZXRlX3BvbGljeV9lbmdpbmUgZmFpbGVkOiB7ZXh9JylcbiAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdTVUNDRVNTJylcbiAgICAgICAgcmV0dXJuXG5cbiAgICAjIENyZWF0ZSAvIFVwZGF0ZSAoZW5naW5lIG5hbWUgaXMgaW1tdXRhYmxlIC0+IHJldXNlIGlmIGl0IGFscmVhZHkgZXhpc3RzKVxuICAgICMgVGhlIGNsaWVudFRva2VuIGlzIG1hZGUgdW5pcXVlIHBlciBDbG91ZEZvcm1hdGlvbiByZXF1ZXN0IChSZXF1ZXN0SWQpIHNvIGFcbiAgICAjIGxhdGVyIHN0YWNrIHJlY3JlYXRpb24gZG9lcyBub3QgY29sbGlkZSB3aXRoIHRoZSBpZGVtcG90ZW5jeSByZWNvcmQgb2YgYVxuICAgICMgcHJpb3IgKG5vdy1kZWxldGVkKSBlbmdpbmUsIHdoaWxlIHN0aWxsIGJlaW5nIHN0YWJsZSBhY3Jvc3MgdGhlIFNESydzIG93blxuICAgICMgcmV0cmllcyB3aXRoaW4gYSBzaW5nbGUgY3JlYXRlIGNhbGwuXG4gICAgZW5naW5lX2lkID0gTm9uZVxuICAgIHRyeTpcbiAgICAgICAgcmVzcCA9IGNsaWVudC5jcmVhdGVfcG9saWN5X2VuZ2luZShcbiAgICAgICAgICAgIG5hbWU9bmFtZSxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uPXByb3BzLmdldCgnRGVzY3JpcHRpb24nLCAnQ2xvdWRPcHMgcm9sZS1iYXNlZCB0b29sIGF1dGhvcml6YXRpb24gZW5naW5lJyksXG4gICAgICAgICAgICBjbGllbnRUb2tlbj1fY2xpZW50X3Rva2VuKG5hbWUgKyBldmVudC5nZXQoJ1JlcXVlc3RJZCcsICcnKSksXG4gICAgICAgIClcbiAgICAgICAgZW5naW5lX2lkID0gcmVzcFsncG9saWN5RW5naW5lSWQnXVxuICAgIGV4Y2VwdCBDbGllbnRFcnJvciBhcyBlcnI6XG4gICAgICAgIGlmIF9pc19jb25mbGljdChlcnIpOlxuICAgICAgICAgICAgZXhpc3RpbmcgPSBfZmluZF9lbmdpbmVfYnlfbmFtZShjbGllbnQsIG5hbWUpXG4gICAgICAgICAgICBpZiBub3QgZXhpc3Rpbmc6XG4gICAgICAgICAgICAgICAgcmFpc2VcbiAgICAgICAgICAgIGVuZ2luZV9pZCA9IF9lbmdpbmVfaWQoZXhpc3RpbmcpXG4gICAgICAgIGVsc2U6XG4gICAgICAgICAgICByYWlzZVxuXG4gICAgX3dhaXRfZW5naW5lX2FjdGl2ZShjbGllbnQsIGVuZ2luZV9pZClcbiAgICBlbmdpbmUgPSBjbGllbnQuZ2V0X3BvbGljeV9lbmdpbmUocG9saWN5RW5naW5lSWQ9ZW5naW5lX2lkKVxuICAgIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCAnU1VDQ0VTUycsIGRhdGE9e1xuICAgICAgICAnUG9saWN5RW5naW5lSWQnOiBlbmdpbmVfaWQsXG4gICAgICAgICdQb2xpY3lFbmdpbmVBcm4nOiBlbmdpbmUuZ2V0KCdwb2xpY3lFbmdpbmVBcm4nLCAnJyksXG4gICAgfSwgcGh5c2ljYWxfaWQ9ZW5naW5lX2lkKVxuXG5cbmRlZiBfd2FpdF9wb2xpY3lfYWN0aXZlKGNsaWVudCwgZW5naW5lX2lkLCBwb2xpY3lfaWQsIHRpbWVvdXRfcz0xODApOlxuICAgICMgUG9saWN5IGNyZWF0aW9uIGlzIGFzeW5jaHJvbm91czogY3JlYXRlX3BvbGljeSByZXR1cm5zIENSRUFUSU5HIGFuZCB0aGVcbiAgICAjIENlZGFyIGFuYWx5emVyIHZhbGlkYXRlcyB0aGUgc3RhdGVtZW50IGFnYWluc3QgdGhlIGdhdGV3YXkncyBnZW5lcmF0ZWRcbiAgICAjIHNjaGVtYSBhZnRlcndhcmRzLiBQb2xsIHVudGlsIEFDVElWRSwgYW5kIHJhaXNlIChmYWlsaW5nIHRoZSBjdXN0b21cbiAgICAjIHJlc291cmNlKSBvbiBDUkVBVEVfRkFJTEVEIHNvIGEgYmFkIHBvbGljeSBjYW4gbmV2ZXIgYmUgc2lsZW50bHkgYWNjZXB0ZWQuXG4gICAgZGVhZGxpbmUgPSB0aW1lLnRpbWUoKSArIHRpbWVvdXRfc1xuICAgIHdoaWxlIHRpbWUudGltZSgpIDwgZGVhZGxpbmU6XG4gICAgICAgIHJlc3AgPSBjbGllbnQuZ2V0X3BvbGljeShwb2xpY3lFbmdpbmVJZD1lbmdpbmVfaWQsIHBvbGljeUlkPXBvbGljeV9pZClcbiAgICAgICAgc3RhdHVzID0gcmVzcC5nZXQoJ3N0YXR1cycpXG4gICAgICAgIGxvZ2dlci5pbmZvKGYncG9saWN5IHtwb2xpY3lfaWR9IHN0YXR1cz17c3RhdHVzfScpXG4gICAgICAgIGlmIHN0YXR1cyA9PSAnQUNUSVZFJzpcbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICBpZiBzdGF0dXMgYW5kICdGQUlMRUQnIGluIHN0YXR1czpcbiAgICAgICAgICAgIHJhaXNlIFJ1bnRpbWVFcnJvcihcbiAgICAgICAgICAgICAgICBmJ3BvbGljeSB7cG9saWN5X2lkfSB7c3RhdHVzfToge3Jlc3AuZ2V0KFwic3RhdHVzUmVhc29uc1wiKX0nXG4gICAgICAgICAgICApXG4gICAgICAgIHRpbWUuc2xlZXAoNClcbiAgICByYWlzZSBUaW1lb3V0RXJyb3IoZidwb2xpY3kge3BvbGljeV9pZH0gbm90IEFDVElWRSB3aXRoaW4ge3RpbWVvdXRfc31zJylcblxuXG5kZWYgaGFuZGxlX3BvbGljaWVzKGV2ZW50LCBjbGllbnQpOlxuICAgIHByb3BzID0gZXZlbnRbJ1Jlc291cmNlUHJvcGVydGllcyddXG4gICAgZW5naW5lX2lkID0gcHJvcHNbJ1BvbGljeUVuZ2luZUlkJ11cbiAgICBzdGF0ZW1lbnRzID0gcHJvcHMuZ2V0KCdTdGF0ZW1lbnRzJywgW10pXG4gICAgdmFsaWRhdGlvbl9tb2RlID0gcHJvcHMuZ2V0KCdWYWxpZGF0aW9uTW9kZScsICdGQUlMX09OX0FOWV9GSU5ESU5HUycpXG4gICAgcmVxdWVzdF90eXBlID0gZXZlbnRbJ1JlcXVlc3RUeXBlJ11cblxuICAgIGlmIHJlcXVlc3RfdHlwZSA9PSAnRGVsZXRlJzpcbiAgICAgICAgX2RlbGV0ZV9wb2xpY2llcyhjbGllbnQsIGVuZ2luZV9pZClcbiAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdTVUNDRVNTJylcbiAgICAgICAgcmV0dXJuXG5cbiAgICAjIFJlY29uY2lsZTogcmVtb3ZlIGFueSBleGlzdGluZyBwb2xpY2llcyBmaXJzdCBzbyBDcmVhdGUgQU5EIFVwZGF0ZSBib3RoXG4gICAgIyBjb252ZXJnZSB0byBleGFjdGx5IHRoZSBkZXNpcmVkIHN0YXRlbWVudCBzZXQgKGFuZCBjbGVhbiB1cCBhbnkgcHJpb3JcbiAgICAjIGZhaWxlZC9wcm9iZSBwb2xpY2llcykgd2l0aG91dCBuYW1lLWNvbmZsaWN0IGVycm9ycy5cbiAgICBfZGVsZXRlX3BvbGljaWVzKGNsaWVudCwgZW5naW5lX2lkKVxuXG4gICAgY3JlYXRlZCA9IFtdXG4gICAgZm9yIHN0bXQgaW4gc3RhdGVtZW50czpcbiAgICAgICAgcG5hbWUgPSBzdG10WydOYW1lJ11cbiAgICAgICAgcmVzcCA9IGNsaWVudC5jcmVhdGVfcG9saWN5KFxuICAgICAgICAgICAgcG9saWN5RW5naW5lSWQ9ZW5naW5lX2lkLFxuICAgICAgICAgICAgbmFtZT1wbmFtZSxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uPXN0bXQuZ2V0KCdEZXNjcmlwdGlvbicsICcnKSxcbiAgICAgICAgICAgIHZhbGlkYXRpb25Nb2RlPXZhbGlkYXRpb25fbW9kZSxcbiAgICAgICAgICAgICMgZW5mb3JjZW1lbnRNb2RlIGlzIG9taXR0ZWQ6IGl0IGlzIG5vdCBwcmVzZW50IGluIHRoZSBMYW1iZGFcbiAgICAgICAgICAgICMgcnVudGltZSdzIGJ1bmRsZWQgYm90bzMgbW9kZWwgZm9yIGNyZWF0ZV9wb2xpY3kgYW5kIGRlZmF1bHRzXG4gICAgICAgICAgICAjIHRvIEFDVElWRSBzZXJ2aWNlLXNpZGUgKHdoaWNoIGlzIHRoZSBlbmZvcmNpbmcgYmVoYXZpb3Igd2VcbiAgICAgICAgICAgICMgd2FudDsgdGhlIGdhdGV3YXkgUG9saWN5RW5naW5lQ29uZmlndXJhdGlvbiBpcyBhbHNvIEVORk9SQ0UpLlxuICAgICAgICAgICAgZGVmaW5pdGlvbj17J2NlZGFyJzogeydzdGF0ZW1lbnQnOiBzdG10WydTdGF0ZW1lbnQnXX19LFxuICAgICAgICAgICAgY2xpZW50VG9rZW49X2NsaWVudF90b2tlbihmXCJ7ZW5naW5lX2lkfXtwbmFtZX17ZXZlbnQuZ2V0KCdSZXF1ZXN0SWQnLCAnJyl9XCIpLFxuICAgICAgICApXG4gICAgICAgIHBvbGljeV9pZCA9IHJlc3AuZ2V0KCdwb2xpY3lJZCcsIHBuYW1lKVxuICAgICAgICAjIEJsb2NrIHVudGlsIHRoZSBwb2xpY3kgdmFsaWRhdGVzIEFDVElWRTsgcmFpc2VzIG9uIENSRUFURV9GQUlMRUQuXG4gICAgICAgIF93YWl0X3BvbGljeV9hY3RpdmUoY2xpZW50LCBlbmdpbmVfaWQsIHBvbGljeV9pZClcbiAgICAgICAgY3JlYXRlZC5hcHBlbmQocG9saWN5X2lkKVxuXG4gICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdTVUNDRVNTJywgZGF0YT17XG4gICAgICAgICdQb2xpY3lJZHMnOiAnLCcuam9pbihjcmVhdGVkKSxcbiAgICB9LCBwaHlzaWNhbF9pZD1mJ3tlbmdpbmVfaWR9LXBvbGljaWVzJylcblxuXG5kZWYgaGFuZGxlcihldmVudCwgY29udGV4dCk6XG4gICAgbG9nZ2VyLmluZm8oZidFdmVudDoge2pzb24uZHVtcHMoZXZlbnQpfScpXG4gICAgcHJvcHMgPSBldmVudFsnUmVzb3VyY2VQcm9wZXJ0aWVzJ11cbiAgICBvcGVyYXRpb24gPSBwcm9wcy5nZXQoJ09wZXJhdGlvbicsICdFTkdJTkUnKVxuICAgIHJlZ2lvbiA9IHByb3BzLmdldCgnUmVnaW9uJykgb3Igb3MuZW52aXJvbi5nZXQoJ0FXU19SRUdJT04nKVxuICAgIGNsaWVudCA9IGJvdG8zLmNsaWVudCgnYmVkcm9jay1hZ2VudGNvcmUtY29udHJvbCcsIHJlZ2lvbl9uYW1lPXJlZ2lvbilcbiAgICB0cnk6XG4gICAgICAgIGlmIG9wZXJhdGlvbiA9PSAnRU5HSU5FJzpcbiAgICAgICAgICAgIGhhbmRsZV9lbmdpbmUoZXZlbnQsIGNsaWVudClcbiAgICAgICAgZWxpZiBvcGVyYXRpb24gPT0gJ1BPTElDSUVTJzpcbiAgICAgICAgICAgIGhhbmRsZV9wb2xpY2llcyhldmVudCwgY2xpZW50KVxuICAgICAgICBlbHNlOlxuICAgICAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdGQUlMRUQnLCByZWFzb249ZidVbmtub3duIG9wZXJhdGlvbiB7b3BlcmF0aW9ufScpXG4gICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxuICAgICAgICBsb2dnZXIuZXJyb3IoZid7b3BlcmF0aW9ufSBmYWlsZWQ6IHtlfScpXG4gICAgICAgICMgT24gRGVsZXRlIHdlIG5ldmVyIHdhbnQgdG8gYmxvY2sgc3RhY2sgdGVhcmRvd24uXG4gICAgICAgIGlmIGV2ZW50WydSZXF1ZXN0VHlwZSddID09ICdEZWxldGUnOlxuICAgICAgICAgICAgc2VuZF9jZm5fcmVzcG9uc2UoZXZlbnQsICdTVUNDRVNTJylcbiAgICAgICAgZWxzZTpcbiAgICAgICAgICAgIHNlbmRfY2ZuX3Jlc3BvbnNlKGV2ZW50LCAnRkFJTEVEJywgcmVhc29uPXN0cihlKSlcbmApLFxuICAgIH0pO1xuXG4gICAgLy8gV2lsZGNhcmQgcmVzb3VyY2UgaXMgUkVRVUlSRUQgYW5kIGNhbm5vdCBiZSBzY29wZWQgYXQgcG9saWN5LWRlZmluaXRpb25cbiAgICAvLyB0aW1lOiB0aGlzIGN1c3RvbSByZXNvdXJjZSBDUkVBVEVTIHRoZSBwb2xpY3kgZW5naW5lIGFuZCBpdHMgcG9saWNpZXMsIHNvXG4gICAgLy8gdGhlaXIgQVJOcyBkbyBub3QgZXhpc3QgeWV0LCBhbmQgdGhlIExpc3QqIGFjdGlvbnMgYXJlIGFjY291bnQtbGV2ZWwgYnlcbiAgICAvLyBkZWZpbml0aW9uICh0aGV5IGVudW1lcmF0ZSBhbGwgZW5naW5lcy9wb2xpY2llcyBhbmQgYWNjZXB0IG5vIHJlc291cmNlXG4gICAgLy8gY29uc3RyYWludCkuIFRoZSBnYXRld2F5LXRhcmdldGluZyBhY3Rpb25zIChJbnZva2VHYXRld2F5L0dldEdhdGV3YXkvXG4gICAgLy8gTGlzdC9HZXRHYXRld2F5VGFyZ2V0KSBhcmUgdXNlZCBhdCBjcmVhdGUgdGltZSB0byB2YWxpZGF0ZSBlYWNoIENlZGFyXG4gICAgLy8gcG9saWN5IGFnYWluc3QgdGhlIGxpdmUgZ2F0ZXdheSB0b29sIHNjaGVtYS4gVGhlIGJsYXN0IHJhZGl1cyBpcyBsaW1pdGVkXG4gICAgLy8gdG8gdGhlIGJlZHJvY2stYWdlbnRjb3JlIFBvbGljeS9HYXRld2F5IGNvbnRyb2wgcGxhbmUsIGFuZCB0aGUgZnVuY3Rpb25cbiAgICAvLyBydW5zIG9ubHkgYXMgYSBDbG91ZEZvcm1hdGlvbiBjdXN0b20gcmVzb3VyY2UgZHVyaW5nIHN0YWNrIGRlcGxveS9kZWxldGUuXG4gICAgLy8gKFRoZSBnYXRld2F5ICpzZXJ2aWNlKiByb2xlJ3MgQXV0aG9yaXplQWN0aW9uIGdyYW50IElTIHNjb3BlZCB0byB0aGVcbiAgICAvLyBzcGVjaWZpYyBwb2xpY3ktZW5naW5lIGFuZCBnYXRld2F5IEFSTnMg4oCUIHNlZSBQb2xpY3lFbmdpbmVBdXRob3JpemF0aW9uLilcbiAgICBwb2xpY3lFbmdpbmVGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgc2lkOiAnQWdlbnRDb3JlUG9saWN5RW5naW5lTWFuYWdlbWVudCcsXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpDcmVhdGVQb2xpY3lFbmdpbmUnLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6RGVsZXRlUG9saWN5RW5naW5lJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldFBvbGljeUVuZ2luZScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpMaXN0UG9saWN5RW5naW5lcycsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpDcmVhdGVQb2xpY3knLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6RGVsZXRlUG9saWN5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldFBvbGljeScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpMaXN0UG9saWNpZXMnLFxuICAgICAgICAvLyBDcmVhdGVQb2xpY3kgYmluZHMvdmFsaWRhdGVzIGVhY2ggQ2VkYXIgcG9saWN5IGFnYWluc3QgdGhlIHRhcmdldFxuICAgICAgICAvLyBHYXRld2F5J3MgdG9vbHMsIHdoaWNoIHJlcXVpcmVzIHJlYWRpbmcgdGhlIGdhdGV3YXkgYW5kIGl0cyB0YXJnZXRzLFxuICAgICAgICAvLyBtYW5hZ2luZyB0aGUgZ2F0ZXdheSdzIHJlc291cmNlLXNjb3BlZCBwb2xpY3ksIGFuZCBpbnZva2luZyB0aGVcbiAgICAgICAgLy8gZ2F0ZXdheSB0byB2YWxpZGF0ZSB0aGUgYWN0aW9ucyByZWZlcmVuY2VkIGJ5IHRoZSBwb2xpY3kuXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpNYW5hZ2VSZXNvdXJjZVNjb3BlZFBvbGljeScsXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpJbnZva2VHYXRld2F5JyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldEdhdGV3YXknLFxuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdEdhdGV3YXlUYXJnZXRzJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldEdhdGV3YXlUYXJnZXQnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgLy8gQWdlbnRDb3JlIFBvbGljeSByZXNvdXJjZSBuYW1lcyAoZW5naW5lICsgcG9saWNpZXMpIG11c3QgbWF0Y2hcbiAgICAvLyBeW0EtWmEtel1bQS1aYS16MC05X10qJCDigJQgbGV0dGVycy9kaWdpdHMvdW5kZXJzY29yZXMgb25seSwgc3RhcnRpbmcgd2l0aFxuICAgIC8vIGEgbGV0dGVyLiBTYW5pdGl6ZSB0aGUgc3RhY2sgbmFtZSAod2hpY2ggbWF5IGNvbnRhaW4gaHlwaGVucykgdG8gYSB2YWxpZFxuICAgIC8vIHByZWZpeCBzbyB0aGUgQ3JlYXRlUG9saWN5RW5naW5lL0NyZWF0ZVBvbGljeSBjYWxscyB2YWxpZGF0ZS5cbiAgICBjb25zdCBwb2xpY3lOYW1lUHJlZml4ID0gYCR7dGhpcy5zdGFja05hbWV9YC5yZXBsYWNlKC9bXkEtWmEtejAtOV9dL2csICdfJyk7XG5cbiAgICBjb25zdCBwb2xpY3lFbmdpbmUgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdQb2xpY3lFbmdpbmUnLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IHBvbGljeUVuZ2luZUZuLmZ1bmN0aW9uQXJuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBPcGVyYXRpb246ICdFTkdJTkUnLFxuICAgICAgICBFbmdpbmVOYW1lOiBgJHtwb2xpY3lOYW1lUHJlZml4fV9wb2xpY3lfZW5naW5lYCxcbiAgICAgICAgRGVzY3JpcHRpb246ICdDbG91ZE9wcyByb2xlLWJhc2VkIHRvb2wgYXV0aG9yaXphdGlvbiAoQ2VkYXIpIGZvciB0aGUgZ2F0ZXdheScsXG4gICAgICAgIFJlZ2lvbjogdGhpcy5yZWdpb24sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgcG9saWN5RW5naW5lQXJuID0gcG9saWN5RW5naW5lLmdldEF0dFN0cmluZygnUG9saWN5RW5naW5lQXJuJyk7XG4gICAgY29uc3QgcG9saWN5RW5naW5lSWQgPSBwb2xpY3lFbmdpbmUuZ2V0QXR0U3RyaW5nKCdQb2xpY3lFbmdpbmVJZCcpO1xuXG4gICAgLy8gR2F0ZXdheSBFeGVjdXRpb24gUm9sZSBwZXJtaXNzaW9ucyBmb3IgUG9saWN5IGluIEFnZW50Q29yZS4gUGVyIHRoZVxuICAgIC8vIEFnZW50Q29yZSBcIkdhdGV3YXkgYW5kIFBvbGljeSBJQU0gUGVybWlzc2lvbnNcIiBndWlkZSwgdGhlIGV4ZWN1dGlvbiByb2xlXG4gICAgLy8gcmVxdWlyZXMgZXhhY3RseTpcbiAgICAvLyAgICogR2V0UG9saWN5RW5naW5lIG9uIHRoZSBwb2xpY3ktZW5naW5lLCBhbmRcbiAgICAvLyAgICogQXV0aG9yaXplQWN0aW9uICsgUGFydGlhbGx5QXV0aG9yaXplQWN0aW9ucyBvbiBCT1RIIHRoZSBwb2xpY3ktZW5naW5lXG4gICAgLy8gICAgIGFuZCB0aGUgZ2F0ZXdheS5cbiAgICAvLyBXaXRob3V0IHRoZXNlIHRoZSBHYXRld2F5IGNhbm5vdCBldmFsdWF0ZSBDZWRhciBwb2xpY2llcyAoYXR0YWNoaW5nIGFcbiAgICAvLyBQb2xpY3kgRW5naW5lIGZhaWxzLCBhbmQgYWxsIHRvb2wgaW52b2NhdGlvbnMgZGVmYXVsdC1kZW55KS5cbiAgICAvLyBUaGUgZ2F0ZXdheSBBUk4gaXMgZ2VuZXJhdGVkIGF0IGNyZWF0ZSB0aW1lIChyZWZlcmVuY2luZyB0aGlzLmdhdGV3YXlBcm5cbiAgICAvLyBoZXJlIHdvdWxkIGJlIGNpcmN1bGFyKSwgc28gdGhlIGdhdGV3YXkgcmVzb3VyY2UgaXMgc2NvcGVkIHRvIHRoaXNcbiAgICAvLyBhY2NvdW50L3JlZ2lvbidzIGdhdGV3YXkgbmFtZXNwYWNlLlxuICAgIGNvbnN0IGdhdGV3YXlSZXNvdXJjZVdpbGRjYXJkID0gYGFybjphd3M6YmVkcm9jay1hZ2VudGNvcmU6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmdhdGV3YXkvKmA7XG5cbiAgICBnYXRld2F5Um9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBzaWQ6ICdQb2xpY3lFbmdpbmVDb25maWd1cmF0aW9uJyxcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnYmVkcm9jay1hZ2VudGNvcmU6R2V0UG9saWN5RW5naW5lJ10sXG4gICAgICByZXNvdXJjZXM6IFtwb2xpY3lFbmdpbmVBcm5dLFxuICAgIH0pKTtcblxuICAgIGdhdGV3YXlSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIHNpZDogJ1BvbGljeUVuZ2luZUF1dGhvcml6YXRpb24nLFxuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6QXV0aG9yaXplQWN0aW9uJyxcbiAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOlBhcnRpYWxseUF1dGhvcml6ZUFjdGlvbnMnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW3BvbGljeUVuZ2luZUFybiwgZ2F0ZXdheVJlc291cmNlV2lsZGNhcmRdLFxuICAgIH0pKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBEZW55LWF1ZGl0IFJFUVVFU1QgaW50ZXJjZXB0b3IgKExhbWJkYSlcbiAgICAvL1xuICAgIC8vIEVtaXRzIGV4YWN0bHkgb25lIHN0cnVjdHVyZWQgQ2xvdWRXYXRjaCByZWNvcmQgb24gYSBkZW55IFRvb2xfSW52b2NhdGlvblxuICAgIC8vIChKV1QgYHN1YmAsIHJlcXVlc3RlZCBUb29sX0NhdGVnb3J5LCBgZGVueWAsIHRpbWVzdGFtcCkg4oCUIG5ldmVyIHRoZSB0b2tlblxuICAgIC8vIG9yIHRvb2wgYXJncy9yZXN1bHRzIChSZXEgOC4zKS4gSXQgaXMgQVVESVQtT05MWTogaXQgcmUtZGVyaXZlcyB0aGVcbiAgICAvLyBkZWNpc2lvbiB3aXRoIHRoZSBzYW1lIGF1dGhvcml0YXRpdmUgcm9sZS0+Y2F0ZWdvcnkgbW9kZWwgYW5kIEFMV0FZU1xuICAgIC8vIGZvcndhcmRzIHRoZSByZXF1ZXN0IHVuY2hhbmdlZCwgc28gdGhlIENlZGFyIFBvbGljeSBlbmdpbmUgYWJvdmUgcmVtYWluc1xuICAgIC8vIHRoZSBhdXRob3JpdGF0aXZlIGF1dGhvcml6ZXIuIEFueSBhdWRpdCBmYWlsdXJlIGlzIHN3YWxsb3dlZCBpbnNpZGUgdGhlXG4gICAgLy8gaGFuZGxlciBhbmQgdGhlIHJlcXVlc3QgaXMgc3RpbGwgZm9yd2FyZGVkIHVuY2hhbmdlZCwgc28gYW4gYXVkaXQgZmFpbHVyZVxuICAgIC8vIGNhbiBuZXZlciBzdXBwcmVzcyB0aGUgYXV0aG9yaXphdGlvbiBlcnJvciByZXR1cm5lZCB0byB0aGUgY2FsbGVyXG4gICAgLy8gKFJlcSA4LjQpLlxuICAgIC8vXG4gICAgLy8gVmVyaWZpZWQgYWdhaW5zdCB0aGUgQWdlbnRDb3JlIGRvY3M6XG4gICAgLy8gICAqIGBBV1M6OkJlZHJvY2tBZ2VudENvcmU6OkdhdGV3YXlgIGV4cG9zZXMgYEludGVyY2VwdG9yQ29uZmlndXJhdGlvbnNgXG4gICAgLy8gICAgIChhcnJheSwgMeKAkzIpLiBFYWNoIGVudHJ5IGhhcyBgSW50ZXJjZXB0aW9uUG9pbnRzYCAoUkVRVUVTVC9SRVNQT05TRSksXG4gICAgLy8gICAgIGBJbnRlcmNlcHRvci5MYW1iZGEuQXJuYCwgYW5kIGBJbnB1dENvbmZpZ3VyYXRpb24uUGFzc1JlcXVlc3RIZWFkZXJzYC5cbiAgICAvLyAgICogVGhlIEpXVCBgc3ViYC9gcm9sZWAgYXJlIG9ubHkgYXZhaWxhYmxlIHRvIHRoZSBpbnRlcmNlcHRvciB2aWEgdGhlXG4gICAgLy8gICAgIGBBdXRob3JpemF0aW9uYCBoZWFkZXIsIGRlbGl2ZXJlZCBvbmx5IHdoZW4gYFBhc3NSZXF1ZXN0SGVhZGVyc2AgaXNcbiAgICAvLyAgICAgdHJ1ZS4gVGhlIEdhdGV3YXkgdmVyaWZpZXMgdGhlIEpXVCBiZWZvcmUgaW52b2tpbmcgdGhlIGludGVyY2VwdG9yO1xuICAgIC8vICAgICB0aGUgaGFuZGxlciBkZWNvZGVzIChkb2VzIG5vdCB2ZXJpZnkpIGl0IHNvbGVseSB0byByZWFkIGBzdWJgL2Byb2xlYFxuICAgIC8vICAgICBhbmQgbmV2ZXIgbG9ncyB0aGUgdG9rZW4uXG4gICAgLy8gICAqIE5hdGl2ZSBzZXJ2aWNlIHNwYW5zIGNvbXBsZW1lbnQsIGJ1dCBkbyBub3QgZHVwbGljYXRlLCB0aGUgY2Fub25pY2FsXG4gICAgLy8gICAgIGZvdXItZmllbGQgZGVueS1hdWRpdCByZWNvcmQuIERvIG5vdCBlbmFibGUgcGF5bG9hZC1iZWFyaW5nIGFwcGxpY2F0aW9uIGxvZ3MuXG4gICAgLy8gU2VlIGNkay9sYW1iZGEvZGVueS1hdWRpdC1pbnRlcmNlcHRvci9SRUFETUUubWQgZm9yIHRoZSBmdWxsIHJlc2VhcmNoIGxvZy5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBEZWRpY2F0ZWQgbG9nIGdyb3VwIHNvIHRoZSBzdHJ1Y3R1cmVkIGRlbnktYXVkaXQgcmVjb3JkcyBoYXZlIGFuIGV4cGxpY2l0LFxuICAgIC8vIHJldGFpbmVkIENsb3VkV2F0Y2ggZGVzdGluYXRpb24gKHJhdGhlciB0aGFuIHJlbHlpbmcgb24gdGhlIGltcGxpY2l0XG4gICAgLy8gTGFtYmRhIGxvZyBncm91cCkuXG4gICAgY29uc3QgZGVueUF1ZGl0TG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCAnRGVueUF1ZGl0SW50ZXJjZXB0b3JMb2dHcm91cCcsIHtcbiAgICAgIHJldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9ZRUFSLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGRlbnlBdWRpdEludGVyY2VwdG9yRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdEZW55QXVkaXRJbnRlcmNlcHRvckZ1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTIsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlci5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vbGFtYmRhL2RlbnktYXVkaXQtaW50ZXJjZXB0b3InKSksXG4gICAgICBkZXNjcmlwdGlvbjogJ0RlbnktYXVkaXQgUkVRVUVTVCBpbnRlcmNlcHRvciBmb3IgdGhlIENsb3VkT3BzIEdhdGV3YXkgKHN0cnVjdHVyZWQgZGVueSByZWNvcmRzKS4nLFxuICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgbG9nR3JvdXA6IGRlbnlBdWRpdExvZ0dyb3VwLFxuICAgIH0pO1xuXG4gICAgLy8gVGhlIEdhdGV3YXkgc2VydmljZSByb2xlIGludm9rZXMgdGhlIGludGVyY2VwdG9yLiBTY29wZSB0aGUgZ3JhbnQgdG8gdGhpc1xuICAgIC8vIGZ1bmN0aW9uIG9ubHkgKGludGVyY2VwdG9yIHNlY3VyaXR5IGJlc3QgcHJhY3RpY2Ug4oCUIG5ldmVyIGEgd2lsZGNhcmQpLlxuICAgIGRlbnlBdWRpdEludGVyY2VwdG9yRm4uZ3JhbnRJbnZva2UoZ2F0ZXdheVJvbGUpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIERpc2NvdmVyeS1maWx0ZXIgUkVTUE9OU0UgaW50ZXJjZXB0b3IgKExhbWJkYSlcbiAgICAvL1xuICAgIC8vIEZpbHRlcnMgdGhlIGB0b29scy9saXN0YCBEaXNjb3ZlcnlfUmVzcG9uc2UgZG93biB0byB0aGUgY2FsbGVyJ3MgYWxsb3dlZFxuICAgIC8vIGNhdGVnb3JpZXMgYmVmb3JlIHRoZSBHYXRld2F5IHJldHVybnMgaXQsIHNvIGEgTm9uQWRtaW4gdXNlciBjYW5ub3RcbiAgICAvLyBlbnVtZXJhdGUgdGhlIG5hbWVzL2Rlc2NyaXB0aW9ucy9pbnB1dCBzY2hlbWFzIG9mIHRvb2xzIHRoZXkgY2Fubm90XG4gICAgLy8gaW52b2tlLiBJdCBpcyBhIERJU1RJTkNULCBpbmRlcGVuZGVudGx5IHJlYXNvbmVkIGludGVyY2VwdG9yIGZyb20gdGhlXG4gICAgLy8gZGVueS1hdWRpdCBSRVFVRVNUIGludGVyY2VwdG9yIGFib3ZlOiBpdCB0cmFuc2Zvcm1zIG9ubHkgYHRvb2xzL2xpc3RgXG4gICAgLy8gcmVzcG9uc2VzLCBuZXZlciBhdWRpdHMgb3IgZW5mb3JjZXMgaW52b2NhdGlvbiwgcmV1c2VzIHRoZSBhdXRob3JpdGF0aXZlXG4gICAgLy8gcm9sZS0+Y2F0ZWdvcnkgbW9kZWwgKHZlbmRvcmVkIGJ5dGUtZm9yLWJ5dGUpLCBhbmQgZmFpbHMgY2xvc2VkIChyZXR1cm5zXG4gICAgLy8gYW4gZW1wdHkgdG9vbCBsaXN0KSBvbiBhbnkgZXJyb3Ig4oCUIG5ldmVyIHRoZSB1bmZpbHRlcmVkIGNhdGFsb2cuIEl0XG4gICAgLy8gZGVjb2RlcyAoZG9lcyBub3QgdmVyaWZ5KSB0aGUgYWxyZWFkeS12ZXJpZmllZCBBdXRob3JpemF0aW9uIEpXVCBzb2xlbHlcbiAgICAvLyB0byByZWFkIGBzdWJgL2Byb2xlYCBhbmQgbmV2ZXIgbG9ncyB0aGUgdG9rZW4uXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgLy8gRGVkaWNhdGVkLCByZXRhaW5lZCBsb2cgZ3JvdXAg4oCUIG1pcnJvcnMgRGVueUF1ZGl0SW50ZXJjZXB0b3JMb2dHcm91cC5cbiAgICBjb25zdCBkaXNjb3ZlcnlGaWx0ZXJMb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdEaXNjb3ZlcnlGaWx0ZXJJbnRlcmNlcHRvckxvZ0dyb3VwJywge1xuICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX1lFQVIsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZGlzY292ZXJ5RmlsdGVySW50ZXJjZXB0b3JGbiA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0Rpc2NvdmVyeUZpbHRlckludGVyY2VwdG9yRnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyLmhhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9sYW1iZGEvZGlzY292ZXJ5LWZpbHRlci1pbnRlcmNlcHRvcicpKSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUm9sZS1maWx0ZXJlZCB0b29sIGRpc2NvdmVyeSBSRVNQT05TRSBpbnRlcmNlcHRvciBmb3IgdGhlIENsb3VkT3BzIEdhdGV3YXkuJyxcbiAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEwKSxcbiAgICAgIGxvZ0dyb3VwOiBkaXNjb3ZlcnlGaWx0ZXJMb2dHcm91cCxcbiAgICB9KTtcblxuICAgIC8vIFRoZSBHYXRld2F5IHNlcnZpY2Ugcm9sZSBpbnZva2VzIHRoZSBpbnRlcmNlcHRvci4gU2NvcGUgdGhlIGdyYW50IHRvIHRoaXNcbiAgICAvLyBmdW5jdGlvbiBvbmx5IChpbnRlcmNlcHRvciBzZWN1cml0eSBiZXN0IHByYWN0aWNlIOKAlCBuZXZlciBhIHdpbGRjYXJkKS5cbiAgICBkaXNjb3ZlcnlGaWx0ZXJJbnRlcmNlcHRvckZuLmdyYW50SW52b2tlKGdhdGV3YXlSb2xlKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBHYXRld2F5IChDVVNUT01fSldUIGF1dGgg4oCUIHZlcmlmaWVzIHBlci11c2VyIENvZ25pdG8gdG9rZW5zIHNvIHRoZVxuICAgIC8vIHJvbGUgY2xhaW0gcmVhY2hlcyBBZ2VudENvcmUgUG9saWN5IGZvciBmaW5lLWdyYWluZWQgYXV0aG9yaXphdGlvbilcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBjb25zdCBnYXRld2F5ID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnTWNwR2F0ZXdheScsIHtcbiAgICAgIHR5cGU6ICdBV1M6OkJlZHJvY2tBZ2VudENvcmU6OkdhdGV3YXknLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBOYW1lOiAnY2xvdWRvcHMtZ2F0ZXdheScsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnQ2xvdWRPcHMgR2F0ZXdheSBmb3IgYmlsbGluZyBhbmQgcHJpY2luZyBNQ1AgdG9vbHMgKEpXVCBhdXRoKScsXG4gICAgICAgIFByb3RvY29sVHlwZTogJ01DUCcsXG4gICAgICAgIEF1dGhvcml6ZXJUeXBlOiAnQ1VTVE9NX0pXVCcsXG4gICAgICAgIEF1dGhvcml6ZXJDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgQ3VzdG9tSldUQXV0aG9yaXplcjoge1xuICAgICAgICAgICAgRGlzY292ZXJ5VXJsOiBgaHR0cHM6Ly9jb2duaXRvLWlkcC4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tLyR7cHJvcHMuYXV0aFVzZXJQb29sSWR9Ly53ZWxsLWtub3duL29wZW5pZC1jb25maWd1cmF0aW9uYCxcbiAgICAgICAgICAgIC8vIFRoZSBGcm9udEVuZCBmb3J3YXJkcyB0aGUgQ29nbml0byBBQ0NFU1MgdG9rZW4sIHdoaWNoIGNhcnJpZXNcbiAgICAgICAgICAgIC8vIGBjbGllbnRfaWRgIChub3QgYW4gYGF1ZGAgY2xhaW0g4oCUIG9ubHkgSUQgdG9rZW5zIGhhdmUgYGF1ZGApLlxuICAgICAgICAgICAgLy8gVGhlIEpXVCBhdXRob3JpemVyIG11c3QgdGhlcmVmb3JlIG1hdGNoIG9uIEFsbG93ZWRDbGllbnRzXG4gICAgICAgICAgICAvLyAoY2xpZW50X2lkKSByYXRoZXIgdGhhbiBBbGxvd2VkQXVkaWVuY2UsIG9yIHZhbGlkYXRpb24gNDAzcy5cbiAgICAgICAgICAgIEFsbG93ZWRDbGllbnRzOiBbcHJvcHMuYXV0aFVzZXJQb29sQ2xpZW50SWRdLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIFByb3RvY29sQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE1jcDoge1xuICAgICAgICAgICAgSW5zdHJ1Y3Rpb25zOiAnQ2xvdWRPcHMgZ2F0ZXdheSBmb3IgYmlsbGluZywgcHJpY2luZywgQ2xvdWRXYXRjaCwgQ2xvdWRUcmFpbCwgYW5kIGludmVudG9yeSBNQ1AgdG9vbHMnLFxuICAgICAgICAgICAgU2VhcmNoVHlwZTogJ1NFTUFOVElDJyxcbiAgICAgICAgICAgIFN1cHBvcnRlZFZlcnNpb25zOiBbJzIwMjUtMDMtMjYnXSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICAvLyBBc3NvY2lhdGUgdGhlIENlZGFyIHBvbGljeSBlbmdpbmUuIEVORk9SQ0UgbWFrZXMgdGhlIGVuZ2luZSBkZW55XG4gICAgICAgIC8vIGRpc2FsbG93ZWQgdG9vbCBkaXNjb3ZlcnkvaW52b2NhdGlvbjsgTE9HX09OTFkgd291bGQgb25seSB0cmFjZS5cbiAgICAgICAgUG9saWN5RW5naW5lQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIEFybjogcG9saWN5RW5naW5lQXJuLFxuICAgICAgICAgIE1vZGU6ICdFTkZPUkNFJyxcbiAgICAgICAgfSxcbiAgICAgICAgLy8gUmVnaXN0ZXIgdGhlIGRlbnktYXVkaXQgUkVRVUVTVCBpbnRlcmNlcHRvci4gUGFzc1JlcXVlc3RIZWFkZXJzPXRydWVcbiAgICAgICAgLy8gaXMgcmVxdWlyZWQgc28gdGhlIGludGVyY2VwdG9yIGNhbiByZWFkIHRoZSAoYWxyZWFkeS12ZXJpZmllZClcbiAgICAgICAgLy8gQXV0aG9yaXphdGlvbiBoZWFkZXIgdG8gcmVjb3ZlciB0aGUgSldUIGBzdWJgL2Byb2xlYCBmb3IgdGhlIGF1ZGl0XG4gICAgICAgIC8vIHJlY29yZDsgdGhlIGhhbmRsZXIgbmV2ZXIgbG9ncyB0aGUgdG9rZW4uIFRoZSBpbnRlcmNlcHRvciBpc1xuICAgICAgICAvLyBhdWRpdC1vbmx5IGFuZCBmb3J3YXJkcyBldmVyeSByZXF1ZXN0IHVuY2hhbmdlZC5cbiAgICAgICAgSW50ZXJjZXB0b3JDb25maWd1cmF0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIEludGVyY2VwdGlvblBvaW50czogWydSRVFVRVNUJ10sXG4gICAgICAgICAgICBJbnRlcmNlcHRvcjoge1xuICAgICAgICAgICAgICBMYW1iZGE6IHtcbiAgICAgICAgICAgICAgICBBcm46IGRlbnlBdWRpdEludGVyY2VwdG9yRm4uZnVuY3Rpb25Bcm4sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgSW5wdXRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgICAgIFBhc3NSZXF1ZXN0SGVhZGVyczogdHJ1ZSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICAvLyBSZWdpc3RlciB0aGUgZGlzY292ZXJ5LWZpbHRlciBSRVNQT05TRSBpbnRlcmNlcHRvci5cbiAgICAgICAgICAvLyBQYXNzUmVxdWVzdEhlYWRlcnM9dHJ1ZSBzbyBpdCBjYW4gcmVhZCB0aGUgKGFscmVhZHktdmVyaWZpZWQpXG4gICAgICAgICAgLy8gQXV0aG9yaXphdGlvbiBoZWFkZXIgdG8gcmVjb3ZlciB0aGUgSldUIGByb2xlYCBmb3IgZmlsdGVyaW5nO1xuICAgICAgICAgIC8vIHRoZSBoYW5kbGVyIG5ldmVyIGxvZ3MgdGhlIHRva2VuLiBJdCB0cmFuc2Zvcm1zIG9ubHkgYHRvb2xzL2xpc3RgXG4gICAgICAgICAgLy8gZGlzY292ZXJ5IHJlc3BvbnNlcyBhbmQgZmFpbHMgY2xvc2VkIHRvIGFuIGVtcHR5IHRvb2wgbGlzdC5cbiAgICAgICAgICB7XG4gICAgICAgICAgICBJbnRlcmNlcHRpb25Qb2ludHM6IFsnUkVTUE9OU0UnXSxcbiAgICAgICAgICAgIEludGVyY2VwdG9yOiB7XG4gICAgICAgICAgICAgIExhbWJkYToge1xuICAgICAgICAgICAgICAgIEFybjogZGlzY292ZXJ5RmlsdGVySW50ZXJjZXB0b3JGbi5mdW5jdGlvbkFybixcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBJbnB1dENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICAgICAgUGFzc1JlcXVlc3RIZWFkZXJzOiB0cnVlLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgICBSb2xlQXJuOiBnYXRld2F5Um9sZS5yb2xlQXJuLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBnYXRld2F5Lm5vZGUuYWRkRGVwZW5kZW5jeShkZW55QXVkaXRJbnRlcmNlcHRvckZuKTtcbiAgICBnYXRld2F5Lm5vZGUuYWRkRGVwZW5kZW5jeShkaXNjb3ZlcnlGaWx0ZXJJbnRlcmNlcHRvckZuKTtcbiAgICBnYXRld2F5Lm5vZGUuYWRkRGVwZW5kZW5jeShvYXV0aFByb3ZpZGVyKTtcbiAgICBnYXRld2F5Lm5vZGUuYWRkRGVwZW5kZW5jeShwb2xpY3lFbmdpbmUpO1xuICAgIC8vIFRoZSBHYXRld2F5IGNhbGxzIEdldFBvbGljeUVuZ2luZSB1c2luZyBpdHMgc2VydmljZSByb2xlIGF0IGNyZWF0ZSB0aW1lLFxuICAgIC8vIHNvIHRoZSByb2xlJ3MgaW5saW5lIHBvbGljeSAod2hpY2ggZ3JhbnRzIGJlZHJvY2stYWdlbnRjb3JlOkdldFBvbGljeUVuZ2luZVxuICAgIC8vIGFuZCB0aGUgT0F1dGgvdG9rZW4tZXhjaGFuZ2UgcGVybWlzc2lvbnMpIE1VU1QgYmUgYXR0YWNoZWQgYmVmb3JlIHRoZVxuICAgIC8vIEdhdGV3YXkgaXMgY3JlYXRlZC4gV2l0aG91dCB0aGlzIGRlcGVuZGVuY3kgQ2xvdWRGb3JtYXRpb24gbWF5IGNyZWF0ZSB0aGVcbiAgICAvLyBHYXRld2F5IGNvbmN1cnJlbnRseSB3aXRoIHRoZSByb2xlIHBvbGljeSwgY2F1c2luZyBhbiBhY2Nlc3MtZGVuaWVkIGVycm9yLlxuICAgIGdhdGV3YXkubm9kZS5hZGREZXBlbmRlbmN5KGdhdGV3YXlSb2xlKTtcblxuICAgIHRoaXMuZ2F0ZXdheUFybiA9IGdhdGV3YXkuZ2V0QXR0KCdHYXRld2F5QXJuJykudG9TdHJpbmcoKTtcbiAgICBjb25zdCBnYXRld2F5SWQgPSBnYXRld2F5LmdldEF0dCgnR2F0ZXdheUlkZW50aWZpZXInKS50b1N0cmluZygpO1xuICAgIHRoaXMuZ2F0ZXdheVVybCA9IGdhdGV3YXkuZ2V0QXR0KCdHYXRld2F5VXJsJykudG9TdHJpbmcoKTtcblxuICAgIGNvbnN0IHRyYWNlZFJlc291cmNlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAgIEdhdGV3YXk6IHRoaXMuZ2F0ZXdheUFybixcbiAgICAgIEdhdGV3YXlJZGVudGl0eTogd29ya2xvYWRJZGVudGl0eUFybih0aGlzLCB0aGlzLmdhdGV3YXlBcm4pLFxuICAgICAgT0F1dGhQcm92aWRlcjogb2F1dGhQcm92aWRlckFybixcbiAgICB9O1xuICAgIGZvciAoY29uc3QgW25hbWUsIGFybl0gb2YgT2JqZWN0LmVudHJpZXMoe1xuICAgICAgQmlsbGluZzogcHJvcHMuYmlsbGluZ01jcFJ1bnRpbWVBcm4sXG4gICAgICBQcmljaW5nOiBwcm9wcy5wcmljaW5nTWNwUnVudGltZUFybixcbiAgICAgIENsb3VkV2F0Y2g6IHByb3BzLmNsb3Vkd2F0Y2hNY3BSdW50aW1lQXJuLFxuICAgICAgQ2xvdWRUcmFpbDogcHJvcHMuY2xvdWR0cmFpbE1jcFJ1bnRpbWVBcm4sXG4gICAgICBJbnZlbnRvcnk6IHByb3BzLmludmVudG9yeU1jcFJ1bnRpbWVBcm4sXG4gICAgfSkpIHtcbiAgICAgIHRyYWNlZFJlc291cmNlc1tuYW1lXSA9IGFybjtcbiAgICAgIHRyYWNlZFJlc291cmNlc1tgJHtuYW1lfUlkZW50aXR5YF0gPSB3b3JrbG9hZElkZW50aXR5QXJuKHRoaXMsIGFybik7XG4gICAgfVxuICAgIGFkZFRyYWNpbmcodGhpcywgdHJhY2VkUmVzb3VyY2VzKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBHYXRld2F5IFRhcmdldHMgKE1DUCBTZXJ2ZXIgZW5kcG9pbnRzKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIGNvbnN0IGJpbGxpbmdUYXJnZXQgPSBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdCaWxsaW5nTWNwVGFyZ2V0Jywge1xuICAgICAgdHlwZTogJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheVRhcmdldCcsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEdhdGV3YXlJZGVudGlmaWVyOiBnYXRld2F5SWQsXG4gICAgICAgIE5hbWU6ICdiaWxsaW5nTWNwJyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdBV1MgTGFicyBCaWxsaW5nIE1DUCBTZXJ2ZXIgb24gQWdlbnRDb3JlIFJ1bnRpbWUnLFxuICAgICAgICBUYXJnZXRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTWNwOiB7IE1jcFNlcnZlcjogeyBFbmRwb2ludDogcHJvcHMuYmlsbGluZ01jcFJ1bnRpbWVFbmRwb2ludCB9IH0sXG4gICAgICAgIH0sXG4gICAgICAgIENyZWRlbnRpYWxQcm92aWRlckNvbmZpZ3VyYXRpb25zOiBbe1xuICAgICAgICAgIENyZWRlbnRpYWxQcm92aWRlclR5cGU6ICdPQVVUSCcsXG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICBPYXV0aENyZWRlbnRpYWxQcm92aWRlcjoge1xuICAgICAgICAgICAgICBQcm92aWRlckFybjogb2F1dGhQcm92aWRlckFybixcbiAgICAgICAgICAgICAgU2NvcGVzOiBbJ21jcC1ydW50aW1lLXNlcnZlci9pbnZva2UnXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfV0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGJpbGxpbmdUYXJnZXQubm9kZS5hZGREZXBlbmRlbmN5KGdhdGV3YXkpO1xuXG4gICAgY29uc3QgcHJpY2luZ1RhcmdldCA9IG5ldyBjZGsuQ2ZuUmVzb3VyY2UodGhpcywgJ1ByaWNpbmdNY3BUYXJnZXQnLCB7XG4gICAgICB0eXBlOiAnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpHYXRld2F5VGFyZ2V0JyxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgR2F0ZXdheUlkZW50aWZpZXI6IGdhdGV3YXlJZCxcbiAgICAgICAgTmFtZTogJ3ByaWNpbmdNY3AnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0FXUyBMYWJzIFByaWNpbmcgTUNQIFNlcnZlciBvbiBBZ2VudENvcmUgUnVudGltZScsXG4gICAgICAgIFRhcmdldENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBNY3A6IHsgTWNwU2VydmVyOiB7IEVuZHBvaW50OiBwcm9wcy5wcmljaW5nTWNwUnVudGltZUVuZHBvaW50IH0gfSxcbiAgICAgICAgfSxcbiAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyQ29uZmlndXJhdGlvbnM6IFt7XG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyVHlwZTogJ09BVVRIJyxcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXI6IHtcbiAgICAgICAgICAgIE9hdXRoQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICAgIFByb3ZpZGVyQXJuOiBvYXV0aFByb3ZpZGVyQXJuLFxuICAgICAgICAgICAgICBTY29wZXM6IFsnbWNwLXJ1bnRpbWUtc2VydmVyL2ludm9rZSddLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgcHJpY2luZ1RhcmdldC5ub2RlLmFkZERlcGVuZGVuY3koZ2F0ZXdheSk7XG5cbiAgICBjb25zdCBjbG91ZHdhdGNoTWNwVGFyZ2V0ID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnQ2xvdWRXYXRjaE1jcFRhcmdldCcsIHtcbiAgICAgIHR5cGU6ICdBV1M6OkJlZHJvY2tBZ2VudENvcmU6OkdhdGV3YXlUYXJnZXQnLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBHYXRld2F5SWRlbnRpZmllcjogZ2F0ZXdheUlkLFxuICAgICAgICBOYW1lOiAnY2xvdWR3YXRjaE1jcCcsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnQVdTIExhYnMgQ2xvdWRXYXRjaCBNQ1AgU2VydmVyIG9uIEFnZW50Q29yZSBSdW50aW1lJyxcbiAgICAgICAgVGFyZ2V0Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE1jcDogeyBNY3BTZXJ2ZXI6IHsgRW5kcG9pbnQ6IHByb3BzLmNsb3Vkd2F0Y2hNY3BSdW50aW1lRW5kcG9pbnQgfSB9LFxuICAgICAgICB9LFxuICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXJDb25maWd1cmF0aW9uczogW3tcbiAgICAgICAgICBDcmVkZW50aWFsUHJvdmlkZXJUeXBlOiAnT0FVVEgnLFxuICAgICAgICAgIENyZWRlbnRpYWxQcm92aWRlcjoge1xuICAgICAgICAgICAgT2F1dGhDcmVkZW50aWFsUHJvdmlkZXI6IHtcbiAgICAgICAgICAgICAgUHJvdmlkZXJBcm46IG9hdXRoUHJvdmlkZXJBcm4sXG4gICAgICAgICAgICAgIFNjb3BlczogWydtY3AtcnVudGltZS1zZXJ2ZXIvaW52b2tlJ10sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH1dLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBjbG91ZHdhdGNoTWNwVGFyZ2V0Lm5vZGUuYWRkRGVwZW5kZW5jeShnYXRld2F5KTtcblxuICAgIGNvbnN0IGNsb3VkdHJhaWxNY3BUYXJnZXQgPSBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdDbG91ZFRyYWlsTWNwVGFyZ2V0Jywge1xuICAgICAgdHlwZTogJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheVRhcmdldCcsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEdhdGV3YXlJZGVudGlmaWVyOiBnYXRld2F5SWQsXG4gICAgICAgIE5hbWU6ICdjbG91ZHRyYWlsTWNwJyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdBV1MgTGFicyBDbG91ZFRyYWlsIE1DUCBTZXJ2ZXIgb24gQWdlbnRDb3JlIFJ1bnRpbWUnLFxuICAgICAgICBUYXJnZXRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTWNwOiB7IE1jcFNlcnZlcjogeyBFbmRwb2ludDogcHJvcHMuY2xvdWR0cmFpbE1jcFJ1bnRpbWVFbmRwb2ludCB9IH0sXG4gICAgICAgIH0sXG4gICAgICAgIENyZWRlbnRpYWxQcm92aWRlckNvbmZpZ3VyYXRpb25zOiBbe1xuICAgICAgICAgIENyZWRlbnRpYWxQcm92aWRlclR5cGU6ICdPQVVUSCcsXG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICBPYXV0aENyZWRlbnRpYWxQcm92aWRlcjoge1xuICAgICAgICAgICAgICBQcm92aWRlckFybjogb2F1dGhQcm92aWRlckFybixcbiAgICAgICAgICAgICAgU2NvcGVzOiBbJ21jcC1ydW50aW1lLXNlcnZlci9pbnZva2UnXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfV0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNsb3VkdHJhaWxNY3BUYXJnZXQubm9kZS5hZGREZXBlbmRlbmN5KGdhdGV3YXkpO1xuXG4gICAgY29uc3QgaW52ZW50b3J5TWNwVGFyZ2V0ID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnSW52ZW50b3J5TWNwVGFyZ2V0Jywge1xuICAgICAgdHlwZTogJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheVRhcmdldCcsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEdhdGV3YXlJZGVudGlmaWVyOiBnYXRld2F5SWQsXG4gICAgICAgIE5hbWU6ICdpbnZlbnRvcnlNY3AnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0ludmVudG9yeSBNQ1AgU2VydmVyIG9uIEFnZW50Q29yZSBSdW50aW1lJyxcbiAgICAgICAgVGFyZ2V0Q29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE1jcDogeyBNY3BTZXJ2ZXI6IHsgRW5kcG9pbnQ6IHByb3BzLmludmVudG9yeU1jcFJ1bnRpbWVFbmRwb2ludCB9IH0sXG4gICAgICAgIH0sXG4gICAgICAgIENyZWRlbnRpYWxQcm92aWRlckNvbmZpZ3VyYXRpb25zOiBbe1xuICAgICAgICAgIENyZWRlbnRpYWxQcm92aWRlclR5cGU6ICdPQVVUSCcsXG4gICAgICAgICAgQ3JlZGVudGlhbFByb3ZpZGVyOiB7XG4gICAgICAgICAgICBPYXV0aENyZWRlbnRpYWxQcm92aWRlcjoge1xuICAgICAgICAgICAgICBQcm92aWRlckFybjogb2F1dGhQcm92aWRlckFybixcbiAgICAgICAgICAgICAgU2NvcGVzOiBbJ21jcC1ydW50aW1lLXNlcnZlci9pbnZva2UnXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfV0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGludmVudG9yeU1jcFRhcmdldC5ub2RlLmFkZERlcGVuZGVuY3koZ2F0ZXdheSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ2VkYXIgcG9saWNpZXMgKHJvbGUgLT4gdG9vbC1jYXRlZ29yeSBtYXBwaW5nKVxuICAgIC8vXG4gICAgLy8gQXV0aG9yaXRhdGl2ZSByb2xlLT5jYXRlZ29yeSBtb2RlbCBpbXBsZW1lbnRlZCBhcyB0d28gYHBlcm1pdGAgc3RhdGVtZW50c1xuICAgIC8vIChDZWRhciBpcyBkZW55LWJ5LWRlZmF1bHQ7IGZvcmJpZCBvdmVycmlkZXMgcGVybWl0KTpcbiAgICAvLyAgICogYmlsbGluZyArIHByaWNpbmcgIC0+IHBlcm1pdHRlZCBmb3IgZXZlcnkgYXV0aGVudGljYXRlZCB1c2VyLlxuICAgIC8vICAgKiBjbG91ZHdhdGNoICsgY2xvdWR0cmFpbCArIGludmVudG9yeSAtPiBwZXJtaXR0ZWQgb25seSB3aGVuIHRoZVxuICAgIC8vICAgICB2ZXJpZmllZCBKV1QgYHJvbGVgIGNsYWltIChzdG9yZWQgYXMgYSBwcmluY2lwYWwgdGFnKSA9PSBcImFkbWluXCIuXG4gICAgLy8gICAqIGV2ZXJ5dGhpbmcgZWxzZSAoaW5jbC4gbmV3bHkgYWRkZWQgY2F0ZWdvcmllcykgLT4gZGVuaWVkIGJ5IGRlZmF1bHQuXG4gICAgLy9cbiAgICAvLyBDYXRlZ29yeSAtPiB0b29sIGdyb3VwaW5nLiBBdCB0aGUgZ2F0ZXdheSBlYWNoIHRvb2wgYWN0aW9uIGlzXG4gICAgLy8gYEFnZW50Q29yZTo6QWN0aW9uOjpcIjx0YXJnZXROYW1lPl9fXzx0b29sTmFtZT5cImAgKHNlZSB0aGUgQWdlbnRDb3JlXG4gICAgLy8gYXV0aG9yaXphdGlvbi1mbG93IGRvY3MpLiBBIGNhdGVnb3J5IHRoZXJlZm9yZSBjb3JyZXNwb25kcyB0byBhIHRhcmdldFxuICAgIC8vIHRvb2wtbmFtZSBwcmVmaXg6XG4gICAgLy8gICBiaWxsaW5nIC0+IGJpbGxpbmdNY3BfX18sIHByaWNpbmcgLT4gcHJpY2luZ01jcF9fXyxcbiAgICAvLyAgIGNsb3Vkd2F0Y2ggLT4gY2xvdWR3YXRjaE1jcF9fXywgY2xvdWR0cmFpbCAtPiBjbG91ZHRyYWlsTWNwX19fLFxuICAgIC8vICAgaW52ZW50b3J5IC0+IGludmVudG9yeU1jcF9fXy5cbiAgICAvL1xuICAgIC8vIEFTU1VNUFRJT04gKG11c3QgYmUgdmFsaWRhdGVkIGFnYWluc3QgdGhlIGxpdmUgQWdlbnRDb3JlIENlZGFyIHNjaGVtYSxcbiAgICAvLyBjb3ZlcmVkIGJ5IHRoZSBpbnRlZ3JhdGlvbiB0ZXN0cyBpbiB0YXNrIDkpOiB0aGUgZ3JvdXBpbmcgaXMgZXhwcmVzc2VkXG4gICAgLy8gaGVyZSB2aWEgYGFjdGlvbi50b29sX2NhdGVnb3J5ID09IFwiPGNhdGVnb3J5PlwiYCwgbWF0Y2hpbmcgdGhlIGRlc2lnblxuICAgIC8vIGRvY3VtZW50J3MgcG9saWN5IHNldC4gVGhlIGNvbmNyZXRlIENlZGFyIHNjaGVtYSBnZW5lcmF0ZWQgZnJvbSB0aGVcbiAgICAvLyBnYXRld2F5J3MgdG9vbHMgbWF5IGluc3RlYWQgcmVxdWlyZSBlbnVtZXJhdGluZyB0aGUgcGVyLXRvb2wgYWN0aW9uXG4gICAgLy8gaWRlbnRpZmllcnMgb3IgbWF0Y2hpbmcgdGhlIGA8dGFyZ2V0TmFtZT5fX19gIHByZWZpeCBkaXJlY3RseS4gSWYgdGhlXG4gICAgLy8gbGl2ZSBzY2hlbWEgZG9lcyBub3QgZXhwb3NlIGEgYHRvb2xfY2F0ZWdvcnlgIGFjdGlvbiBhdHRyaWJ1dGUsIHN3aXRjaFxuICAgIC8vIHRoZXNlIHN0YXRlbWVudHMgdG8gYGFjdGlvbiBpbiBbQWdlbnRDb3JlOjpBY3Rpb246OlwiYmlsbGluZ01jcF9fXy4uLlwiLCDigKZdYFxuICAgIC8vIChlbnVtZXJhdGVkKSBvciB0aGUgc2NoZW1hJ3MgZG9jdW1lbnRlZCBjYXRlZ29yeSBhdHRyaWJ1dGUuIFRoZVxuICAgIC8vIHJvbGUtPmNhdGVnb3J5IFNFTUFOVElDUyBhYm92ZSBhcmUgdGhlIGludmFyaWFudDsgb25seSB0aGUgYWN0aW9uLW1hdGNoXG4gICAgLy8gZXhwcmVzc2lvbiBpcyBwcm92aXNpb25hbC4gVmFsaWRhdGlvbiBydW5zIGluIEZBSUxfT05fQU5ZX0ZJTkRJTkdTIHNvIGFcbiAgICAvLyBtYWxmb3JtZWQgcG9saWN5IGZhaWxzIHRoZSBkZXBsb3ltZW50IGxvdWRseSBpbnN0ZWFkIG9mIGJlaW5nIHNpbGVudGx5XG4gICAgLy8gYWNjZXB0ZWQuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgY29uc3QgZ2F0ZXdheUFyblJlZiA9IHRoaXMuZ2F0ZXdheUFybjtcblxuICAgIC8vIEFnZW50Q29yZSBnZW5lcmF0ZXMgYSBDZWRhciBhY3Rpb24gR1JPVVAgcGVyIGdhdGV3YXkgdGFyZ2V0LCBuYW1lZCBieSB0aGVcbiAgICAvLyB0YXJnZXQgbmFtZSAoZS5nLiBBZ2VudENvcmU6OkFjdGlvbjo6XCJiaWxsaW5nTWNwXCIpLiBFYWNoIHRvb2wgYWN0aW9uXG4gICAgLy8gKDx0YXJnZXQ+X19fPHRvb2w+KSBpcyBhIG1lbWJlciBvZiBpdHMgdGFyZ2V0J3MgZ3JvdXAsIHNvIHdlIGNhbiBzY29wZSBhXG4gICAgLy8gcG9saWN5IHRvIGFuIGVudGlyZSBjYXRlZ29yeSBieSByZWZlcmVuY2luZyB0aGUgdGFyZ2V0IG5hbWUgd2UgYWxyZWFkeVxuICAgIC8vIGtub3cgZnJvbSBDREsg4oCUIG5vIHBlci10b29sIGVudW1lcmF0aW9uIG9yIHJ1bnRpbWUgZGlzY292ZXJ5IHJlcXVpcmVkLlxuICAgIC8vIFRoZXJlIGlzIG5vIGB0b29sX2NhdGVnb3J5YCBhdHRyaWJ1dGU7IHRoZSBwcmlvciBkZXNpZ24gYXNzdW1wdGlvbiB3YXNcbiAgICAvLyB3cm9uZyBhbmQgaXMgY29ycmVjdGVkIGhlcmUuXG4gICAgLy9cbiAgICAvLyBQdXJlLXBlcm1pdCBtb2RlbCBvdmVyIHRoZSBmaXZlIHRhcmdldCBncm91cHMgKENlZGFyIGlzIGRlbnktYnktZGVmYXVsdCxcbiAgICAvLyBmb3JiaWQtb3ZlcnJpZGVzLXBlcm1pdCk6XG4gICAgLy8gICAqIGJpbGxpbmcgKyBwcmljaW5nICAtPiBwZXJtaXR0ZWQgZm9yIGV2ZXJ5IGF1dGhlbnRpY2F0ZWQgdXNlcjtcbiAgICAvLyAgICogY2xvdWR3YXRjaCArIGNsb3VkdHJhaWwgKyBpbnZlbnRvcnkgLT4gcGVybWl0dGVkIG9ubHkgd2hlbiB0aGVcbiAgICAvLyAgICAgdmVyaWZpZWQgSldUIGByb2xlYCBjbGFpbSAoYSBwcmluY2lwYWwgdGFnKSA9PSBcImFkbWluXCI7XG4gICAgLy8gICAqIGV2ZXJ5dGhpbmcgZWxzZSAoaW5jbC4gYW55IGZ1dHVyZSB0YXJnZXQgYWRkZWQgbGF0ZXIpIC0+IGRlbmllZCBieVxuICAgIC8vICAgICBkZWZhdWx0IGZvciBub24tYWRtaW5zLCBzYXRpc2Z5aW5nIHRoZSBkZWZhdWx0LWRlbnkgcmVxdWlyZW1lbnQuXG4gICAgLy8gVGhlIHNlbWFudGljLXNlYXJjaCAvIHRvb2xzLWxpc3QgbWV0YS1vcGVyYXRpb25zIGFyZSBOT1QgUG9saWN5LWdvdmVybmVkXG4gICAgLy8gdGFyZ2V0cywgc28gdGhpcyBtb2RlbCBkb2VzIG5vdCBhZmZlY3QgdG9vbCBkaXNjb3ZlcnkuXG5cbiAgICBjb25zdCBhbGxVc2Vyc0NlZGFyID0gW1xuICAgICAgJ3Blcm1pdCgnLFxuICAgICAgJyAgcHJpbmNpcGFsIGlzIEFnZW50Q29yZTo6T0F1dGhVc2VyLCcsXG4gICAgICAnICBhY3Rpb24gaW4gW0FnZW50Q29yZTo6QWN0aW9uOjpcImJpbGxpbmdNY3BcIiwgQWdlbnRDb3JlOjpBY3Rpb246OlwicHJpY2luZ01jcFwiXSwnLFxuICAgICAgYCAgcmVzb3VyY2UgPT0gQWdlbnRDb3JlOjpHYXRld2F5OjpcIiR7Z2F0ZXdheUFyblJlZn1cImAsXG4gICAgICAnKTsnLFxuICAgIF0uam9pbignXFxuJyk7XG5cbiAgICBjb25zdCBhZG1pbk9ubHlDZWRhciA9IFtcbiAgICAgICdwZXJtaXQoJyxcbiAgICAgICcgIHByaW5jaXBhbCBpcyBBZ2VudENvcmU6Ok9BdXRoVXNlciwnLFxuICAgICAgJyAgYWN0aW9uIGluIFtBZ2VudENvcmU6OkFjdGlvbjo6XCJjbG91ZHdhdGNoTWNwXCIsIEFnZW50Q29yZTo6QWN0aW9uOjpcImNsb3VkdHJhaWxNY3BcIiwgQWdlbnRDb3JlOjpBY3Rpb246OlwiaW52ZW50b3J5TWNwXCJdLCcsXG4gICAgICBgICByZXNvdXJjZSA9PSBBZ2VudENvcmU6OkdhdGV3YXk6OlwiJHtnYXRld2F5QXJuUmVmfVwiYCxcbiAgICAgICcpIHdoZW4geycsXG4gICAgICAnICBwcmluY2lwYWwuaGFzVGFnKFwicm9sZVwiKSAmJicsXG4gICAgICAnICBwcmluY2lwYWwuZ2V0VGFnKFwicm9sZVwiKSA9PSBcImFkbWluXCInLFxuICAgICAgJ307JyxcbiAgICBdLmpvaW4oJ1xcbicpO1xuXG4gICAgY29uc3QgcG9saWN5RW5naW5lUG9saWNpZXMgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdQb2xpY3lFbmdpbmVQb2xpY2llcycsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogcG9saWN5RW5naW5lRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIE9wZXJhdGlvbjogJ1BPTElDSUVTJyxcbiAgICAgICAgUG9saWN5RW5naW5lSWQ6IHBvbGljeUVuZ2luZUlkLFxuICAgICAgICAvLyBWYWxpZGF0ZSBzdHJpY3RseSBhZ2FpbnN0IHRoZSBnYXRld2F5J3MgZ2VuZXJhdGVkIENlZGFyIHNjaGVtYSBzbyBhXG4gICAgICAgIC8vIG1hbGZvcm1lZCBwb2xpY3kgZmFpbHMgdGhlIGRlcGxveW1lbnQgbG91ZGx5IGluc3RlYWQgb2YgbGFuZGluZyBpbiBhXG4gICAgICAgIC8vIHNpbGVudCBhc3luYyBDUkVBVEVfRkFJTEVEIHN0YXRlLiBUaGUgY3VzdG9tLXJlc291cmNlIExhbWJkYSBwb2xsc1xuICAgICAgICAvLyBlYWNoIHBvbGljeSB0byBBQ1RJVkUgYW5kIGZhaWxzIGlmIHZhbGlkYXRpb24gZG9lcyBub3QgcGFzcy5cbiAgICAgICAgVmFsaWRhdGlvbk1vZGU6ICdGQUlMX09OX0FOWV9GSU5ESU5HUycsXG4gICAgICAgIFJlZ2lvbjogdGhpcy5yZWdpb24sXG4gICAgICAgIFN0YXRlbWVudHM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICAvLyBQb2xpY3kgbmFtZXMgbXVzdCBtYXRjaCBeW0EtWmEtel1bQS1aYS16MC05X10qJCAobm8gaHlwaGVucykuXG4gICAgICAgICAgICBOYW1lOiAnYWxsb3dfYmlsbGluZ19wcmljaW5nX2FsbF91c2VycycsXG4gICAgICAgICAgICBEZXNjcmlwdGlvbjogJ1Blcm1pdCBiaWxsaW5nIGFuZCBwcmljaW5nIHRvb2xzIGZvciBldmVyeSBhdXRoZW50aWNhdGVkIHVzZXIuJyxcbiAgICAgICAgICAgIFN0YXRlbWVudDogYWxsVXNlcnNDZWRhcixcbiAgICAgICAgICB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIE5hbWU6ICdhbGxvd19vcHNfY2F0ZWdvcmllc19hZG1pbl9vbmx5JyxcbiAgICAgICAgICAgIERlc2NyaXB0aW9uOiAnUGVybWl0IGNsb3Vkd2F0Y2gsIGNsb3VkdHJhaWwsIGFuZCBpbnZlbnRvcnkgdG9vbHMgb25seSBmb3Igcm9sZSA9PSBhZG1pbi4nLFxuICAgICAgICAgICAgU3RhdGVtZW50OiBhZG1pbk9ubHlDZWRhcixcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIFBvbGljaWVzIGFyZSB2YWxpZGF0ZWQgYWdhaW5zdCB0aGUgQ2VkYXIgc2NoZW1hIGdlbmVyYXRlZCBmcm9tIHRoZVxuICAgIC8vIGdhdGV3YXkncyB0b29scywgc28gdGhleSBtdXN0IGJlIGNyZWF0ZWQgYWZ0ZXIgdGhlIGdhdGV3YXkgYW5kIGV2ZXJ5XG4gICAgLy8gdGFyZ2V0IGV4aXN0LlxuICAgIHBvbGljeUVuZ2luZVBvbGljaWVzLm5vZGUuYWRkRGVwZW5kZW5jeShnYXRld2F5KTtcbiAgICBwb2xpY3lFbmdpbmVQb2xpY2llcy5ub2RlLmFkZERlcGVuZGVuY3koYmlsbGluZ1RhcmdldCk7XG4gICAgcG9saWN5RW5naW5lUG9saWNpZXMubm9kZS5hZGREZXBlbmRlbmN5KHByaWNpbmdUYXJnZXQpO1xuICAgIHBvbGljeUVuZ2luZVBvbGljaWVzLm5vZGUuYWRkRGVwZW5kZW5jeShjbG91ZHdhdGNoTWNwVGFyZ2V0KTtcbiAgICBwb2xpY3lFbmdpbmVQb2xpY2llcy5ub2RlLmFkZERlcGVuZGVuY3koY2xvdWR0cmFpbE1jcFRhcmdldCk7XG4gICAgcG9saWN5RW5naW5lUG9saWNpZXMubm9kZS5hZGREZXBlbmRlbmN5KGludmVudG9yeU1jcFRhcmdldCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdHYXRld2F5QXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuZ2F0ZXdheUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQWdlbnRDb3JlIEdhdGV3YXkgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1HYXRld2F5QXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdHYXRld2F5VXJsJywge1xuICAgICAgdmFsdWU6IHRoaXMuZ2F0ZXdheVVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQWdlbnRDb3JlIEdhdGV3YXkgVVJMJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1HYXRld2F5VXJsYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdQb2xpY3lFbmdpbmVBcm4nLCB7XG4gICAgICB2YWx1ZTogcG9saWN5RW5naW5lQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBZ2VudENvcmUgUG9saWN5IEVuZ2luZSBBUk4gKENlZGFyIHJvbGUtYmFzZWQgdG9vbCBhdXRob3JpemF0aW9uKScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tUG9saWN5RW5naW5lQXJuYCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDREstTmFnIFN1cHByZXNzaW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhnYXRld2F5Um9sZSwgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JywgcmVhc29uOiAnV2lsZGNhcmQgZm9yIEFnZW50Q29yZSBJZGVudGl0eSB0b2tlbiBleGNoYW5nZSBhbmQgT0F1dGggcHJvdmlkZXIgbWFuYWdlbWVudC4nIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMob2F1dGhQcm92aWRlckZuLCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLCByZWFzb246ICdXaWxkY2FyZCByZXF1aXJlZCBmb3IgQWdlbnRDb3JlIElkZW50aXR5IHRva2VuIHZhdWx0IGNyZWF0aW9uIGFuZCBiZWRyb2NrLWFnZW50Y29yZS1pZGVudGl0eSBzZWNyZXRzIG5hbWVzcGFjZS4nIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMocG9saWN5RW5naW5lRm4sIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ1dpbGRjYXJkIHJlcXVpcmVkIGZvciBBZ2VudENvcmUgUG9saWN5IGVuZ2luZS9wb2xpY3kgbWFuYWdlbWVudCAoQ3JlYXRlUG9saWN5RW5naW5lL0NyZWF0ZVBvbGljeSBvcGVyYXRlIG9uIHJlc291cmNlcyBjcmVhdGVkIGF0IGRlcGxveSB0aW1lKS4nIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkU3RhY2tTdXBwcmVzc2lvbnModGhpcywgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JywgcmVhc29uOiAnQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIGlzIEFXUyBiZXN0IHByYWN0aWNlLicsIGFwcGxpZXNUbzogWydQb2xpY3k6OmFybjo8QVdTOjpQYXJ0aXRpb24+OmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlJ10gfSxcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ1dpbGRjYXJkIGZvciBBZ2VudENvcmUgSWRlbnRpdHkgdG9rZW4gZXhjaGFuZ2UsIE9BdXRoIGNyZWRlbnRpYWwgcHJvdmlkZXIgbWFuYWdlbWVudC4nLCBhcHBsaWVzVG86IFsnUmVzb3VyY2U6OionXSB9LFxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1MMScsIHJlYXNvbjogJ0xhbWJkYSBydW50aW1lIHZlcnNpb24gbWFuYWdlZCBieSBDREsuJyB9LFxuICAgIF0pO1xuICB9XG59XG4iXX0=